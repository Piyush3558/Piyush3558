import fs from "node:fs/promises";

const username = process.env.GITHUB_USERNAME || "Piyush3558";
const token = process.env.PROFILE_STATS_TOKEN || process.env.GITHUB_TOKEN;

if (!token) {
    throw new Error("GITHUB_TOKEN or PROFILE_STATS_TOKEN is required.");
}

const markerStart = "<!-- LIVE_COMMIT_HISTORY:START -->";
const markerEnd = "<!-- LIVE_COMMIT_HISTORY:END -->";
const readmePath = new URL("../README.md", import.meta.url);

const graphql = async (query, variables = {}) => {
    const response = await fetch("https://api.github.com/graphql", {
        method: "POST",
        headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "User-Agent": `${username}-profile-commit-sync`
        },
        body: JSON.stringify({ query, variables })
    });

    if (!response.ok) {
        throw new Error(`GitHub GraphQL request failed with HTTP ${response.status}.`);
    }

    const payload = await response.json();

    if (payload.errors?.length) {
        throw new Error(payload.errors.map(error => error.message).join("; "));
    }

    return payload.data;
};

const getPublicRepositories = async () => {
    const repositories = new Map();
    let cursor = null;

    do {
        const data = await graphql(
            `
                query ContributedRepositories($login: String!, $cursor: String) {
                    user(login: $login) {
                        repositoriesContributedTo(
                            first: 100
                            after: $cursor
                            includeUserRepositories: true
                            contributionTypes: [COMMIT]
                            orderBy: { field: UPDATED_AT, direction: DESC }
                        ) {
                            nodes {
                                nameWithOwner
                                isPrivate
                                defaultBranchRef {
                                    name
                                }
                            }
                            pageInfo {
                                hasNextPage
                                endCursor
                            }
                        }
                    }
                }
            `,
            { login: username, cursor }
        );

        const connection = data.user?.repositoriesContributedTo;

        if (!connection) {
            throw new Error(`GitHub user ${username} was not found.`);
        }

        for (const repository of connection.nodes) {
            if (!repository.isPrivate && repository.defaultBranchRef) {
                repositories.set(repository.nameWithOwner, repository);
            }
        }

        cursor = connection.pageInfo.hasNextPage
            ? connection.pageInfo.endCursor
            : null;
    } while (cursor);

    return [...repositories.values()];
};

const getDefaultBranchCommits = async repository => {
    const [owner, name] = repository.nameWithOwner.split("/");
    const commits = [];
    let cursor = null;

    do {
        const data = await graphql(
            `
                query RepositoryHistory(
                    $owner: String!
                    $name: String!
                    $cursor: String
                ) {
                    repository(owner: $owner, name: $name) {
                        defaultBranchRef {
                            target {
                                ... on Commit {
                                    history(first: 100, after: $cursor) {
                                        nodes {
                                            oid
                                            abbreviatedOid
                                            messageHeadline
                                            authoredDate
                                            url
                                            author {
                                                user {
                                                    login
                                                }
                                            }
                                            authors(first: 20) {
                                                nodes {
                                                    user {
                                                        login
                                                    }
                                                }
                                            }
                                        }
                                        pageInfo {
                                            hasNextPage
                                            endCursor
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            `,
            { owner, name, cursor }
        );

        const history = data.repository?.defaultBranchRef?.target?.history;

        if (!history) {
            break;
        }

        commits.push(...history.nodes);
        cursor = history.pageInfo.hasNextPage
            ? history.pageInfo.endCursor
            : null;
    } while (cursor);

    return commits;
};

const escapeHtml = value => String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const repositoryUrl = nameWithOwner =>
    `https://github.com/${encodeURI(nameWithOwner)}`;

const renderActivityBlock = ({ repositories, authored, coauthored }) => {
    const syncedAt = new Intl.DateTimeFormat("en", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC"
    }).format(new Date());

    const recentRows = coauthored
        .sort((left, right) => new Date(right.authoredDate) - new Date(left.authoredDate))
        .slice(0, 8)
        .map(commit => `
<tr>
  <td>${escapeHtml(commit.authoredDate.slice(0, 10))}</td>
  <td><a href="${repositoryUrl(commit.repository)}">${escapeHtml(commit.repository)}</a></td>
  <td><a href="${escapeHtml(commit.url)}"><code>${escapeHtml(commit.abbreviatedOid)}</code></a></td>
  <td>${escapeHtml(commit.messageHeadline)}</td>
</tr>`)
        .join("");

    const recentHistory = recentRows || `
<tr>
  <td colspan="4">No public co-authored commits were found on default branches.</td>
</tr>`;

    return `${markerStart}

<table>
<tr>
  <th>Primary-authored commits</th>
  <th>Co-authored commits</th>
  <th>Total credited commits</th>
  <th>Repositories scanned</th>
</tr>
<tr>
  <td align="center"><strong>${authored.length}</strong></td>
  <td align="center"><strong>${coauthored.length}</strong></td>
  <td align="center"><strong>${authored.length + coauthored.length}</strong></td>
  <td align="center"><strong>${repositories.length}</strong></td>
</tr>
</table>

<sub>Last synced ${escapeHtml(syncedAt)} UTC · Public default branches · Updated automatically every hour</sub>

<details open>
<summary><strong>Recent co-authored history</strong></summary>
<br/>
<table>
<tr>
  <th>Date</th>
  <th>Repository</th>
  <th>Commit</th>
  <th>Message</th>
</tr>${recentHistory}
</table>
</details>

<sub>GitHub identifies co-authors from each commit's <code>Co-authored-by</code> trailers. Private repository details are intentionally excluded.</sub>

${markerEnd}`;
};

const repositories = await getPublicRepositories();
const usernameLower = username.toLowerCase();
const authored = [];
const coauthored = [];
const seenCommits = new Set();

for (const repository of repositories) {
    const commits = await getDefaultBranchCommits(repository);

    for (const commit of commits) {
        const identity = `${repository.nameWithOwner}:${commit.oid}`;

        if (seenCommits.has(identity)) {
            continue;
        }

        seenCommits.add(identity);

        const primaryLogin = commit.author?.user?.login?.toLowerCase();
        const authorLogins = commit.authors.nodes
            .map(author => author.user?.login?.toLowerCase())
            .filter(Boolean);

        const activity = {
            ...commit,
            repository: repository.nameWithOwner
        };

        if (primaryLogin === usernameLower) {
            authored.push(activity);
        } else if (authorLogins.includes(usernameLower)) {
            coauthored.push(activity);
        }
    }
}

const readme = await fs.readFile(readmePath, "utf8");
const startIndex = readme.indexOf(markerStart);
const endIndex = readme.indexOf(markerEnd);

if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    throw new Error("README live commit-history markers are missing or invalid.");
}

const nextBlock = renderActivityBlock({ repositories, authored, coauthored });
const currentBlock = readme.slice(
    startIndex,
    endIndex + markerEnd.length
);
const withoutSyncTime = block => block.replace(
    /<sub>Last synced .*? UTC · Public default branches ·/,
    "<sub>Last synced UTC · Public default branches ·"
);

if (withoutSyncTime(currentBlock) === withoutSyncTime(nextBlock)) {
    console.log(
        `Commit history is current: ${authored.length} authored and ${coauthored.length} co-authored commits across ${repositories.length} public repositories.`
    );
    process.exit(0);
}

const nextReadme = [
    readme.slice(0, startIndex),
    nextBlock,
    readme.slice(endIndex + markerEnd.length)
].join("");

await fs.writeFile(readmePath, nextReadme);

console.log(
    `Synced ${authored.length} authored and ${coauthored.length} co-authored commits across ${repositories.length} public repositories.`
);
