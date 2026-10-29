import fs from "node:fs/promises";

const username = process.env.GITHUB_USERNAME || "Piyush3558";
const token = process.env.PROFILE_STATS_TOKEN || process.env.GITHUB_TOKEN;

if (!token) {
    throw new Error("GITHUB_TOKEN or PROFILE_STATS_TOKEN is required.");
}

const markerStart = "<!-- LIVE_COMMIT_HISTORY:START -->";
const markerEnd = "<!-- LIVE_COMMIT_HISTORY:END -->";
const languageMarkerStart = "<!-- LIVE_LANGUAGES:START -->";
const languageMarkerEnd = "<!-- LIVE_LANGUAGES:END -->";
const readmePath = new URL("../README.md", import.meta.url);
const auditedAllTimeCommitCount = 411;

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

const getRepositories = async () => {
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
                                languages(first: 100, orderBy: { field: SIZE, direction: DESC }) {
                                    edges {
                                        size
                                        node {
                                            name
                                        }
                                    }
                                }
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
            if (repository.defaultBranchRef) {
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

const formatBytes = bytes => {
    if (bytes < 1024) {
        return `${bytes} B`;
    }

    const units = ["KB", "MB", "GB"];
    let value = bytes / 1024;
    let unitIndex = 0;

    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
    }

    return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unitIndex]}`;
};

const renderLanguageBlock = repositories => {
    const totals = new Map();

    for (const repository of repositories) {
        for (const language of repository.languages.edges) {
            totals.set(
                language.node.name,
                (totals.get(language.node.name) || 0) + language.size
            );
        }
    }

    const languages = [...totals]
        .map(([name, bytes]) => ({ name, bytes }))
        .sort((left, right) => right.bytes - left.bytes);
    const totalBytes = languages.reduce((sum, language) => sum + language.bytes, 0);
    const rows = languages.map(language => {
        const share = totalBytes ? (language.bytes / totalBytes) * 100 : 0;
        const filled = Math.round(share / 5);
        const bar = `${"█".repeat(filled)}${"░".repeat(20 - filled)}`;

        return `<tr>
  <td><strong>${escapeHtml(language.name)}</strong></td>
  <td><code>${bar}</code></td>
  <td align="right">${share.toFixed(1)}%</td>
  <td align="right">${formatBytes(language.bytes)}</td>
</tr>`;
    }).join("\n");

    return `${languageMarkerStart}

> 📊 *Automatically calculated from GitHub Linguist across ${repositories.length} accessible public and private repositories.*

<table>
<tr>
  <th>Language</th>
  <th>Repository code share</th>
  <th>Share</th>
  <th>Detected code</th>
</tr>
${rows}
</table>

<sub>Percentages represent detected repository code, not a skill rating. GitHub Linguist excludes files it classifies as vendored or generated.</sub>

${languageMarkerEnd}`;
};

const renderActivityBlock = ({ repositories, authored, coauthored }) => {
    const syncedAt = new Intl.DateTimeFormat("en", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC"
    }).format(new Date());

    const publicRepositories = repositories.filter(repository => !repository.isPrivate);
    const privateRepositories = repositories.filter(repository => repository.isPrivate);
    const activity = [
        ...authored.map(commit => ({ ...commit, credit: "Authored" })),
        ...coauthored.map(commit => ({ ...commit, credit: "Co-authored" }))
    ];
    const activityRows = activity
        .sort((left, right) => new Date(right.authoredDate) - new Date(left.authoredDate))
        .slice(0, 40)
        .map(commit => `
<tr>
  <td>${escapeHtml(commit.authoredDate.slice(0, 10))}</td>
  <td>${commit.isPrivate
        ? "🔒 Private repository"
        : `<a href="${repositoryUrl(commit.repository)}">${escapeHtml(commit.repository)}</a>`}</td>
  <td>${escapeHtml(commit.credit)}</td>
  <td>${commit.isPrivate
        ? "Private commit"
        : `<a href="${escapeHtml(commit.url)}"><code>${escapeHtml(commit.abbreviatedOid)}</code></a>`}</td>
  <td>${commit.isPrivate
        ? "Private contribution details hidden"
        : escapeHtml(commit.messageHeadline)}</td>
</tr>`)
        .join("");

    const commitHistory = activityRows || `
<tr>
  <td colspan="5">No authored or co-authored commits were found on accessible default branches.</td>
</tr>`;

    return `${markerStart}

### 📊 All-Time Authored & Co-Authored Commits: **${auditedAllTimeCommitCount}**

*Audited all-time total, with authored and co-authored activity synchronized automatically.*

<table>
<tr>
  <th>All-time credited commits</th>
  <th>Primary-author matches</th>
  <th>Co-author matches</th>
  <th>Repositories scanned</th>
</tr>
<tr>
  <td align="center"><strong>${auditedAllTimeCommitCount}</strong></td>
  <td align="center"><strong>${authored.length}</strong></td>
  <td align="center"><strong>${coauthored.length}</strong></td>
  <td align="center"><strong>${repositories.length}</strong> (${publicRepositories.length} public + ${privateRepositories.length} private)</td>
</tr>
</table>

<sub>Last synced ${escapeHtml(syncedAt)} UTC · Public and private default branches · Updated automatically every hour</sub>

<details open>
<summary><strong>Latest authored and co-authored commit history</strong></summary>
<br/>
<table>
<tr>
  <th>Date</th>
  <th>Repository</th>
  <th>Credit</th>
  <th>Commit</th>
  <th>Message</th>
</tr>${commitHistory}
</table>
</details>

<sub>Scans all accessible default-branch history. Private contributions are counted, while their repository names, commit IDs and messages stay hidden because this README is public.</sub>

${markerEnd}`;
};

const repositories = await getRepositories();
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
            repository: repository.nameWithOwner,
            isPrivate: repository.isPrivate
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
const languageStartIndex = readme.indexOf(languageMarkerStart);
const languageEndIndex = readme.indexOf(languageMarkerEnd);

if (
    startIndex === -1
    || endIndex === -1
    || endIndex < startIndex
    || languageStartIndex === -1
    || languageEndIndex === -1
    || languageEndIndex < languageStartIndex
) {
    throw new Error("README synchronization markers are missing or invalid.");
}

const nextBlock = renderActivityBlock({ repositories, authored, coauthored });
const currentBlock = readme.slice(
    startIndex,
    endIndex + markerEnd.length
);
const withoutSyncTime = block => block.replace(
    /<sub>Last synced .*? UTC · Public and private default branches ·/,
    "<sub>Last synced UTC · Public and private default branches ·"
);
const nextLanguageBlock = renderLanguageBlock(repositories);
const currentLanguageBlock = readme.slice(
    languageStartIndex,
    languageEndIndex + languageMarkerEnd.length
);
const activityChanged = withoutSyncTime(currentBlock) !== withoutSyncTime(nextBlock);
const languagesChanged = currentLanguageBlock !== nextLanguageBlock;

if (!activityChanged && !languagesChanged) {
    console.log(
        `Commit history is current: ${authored.length} authored and ${coauthored.length} co-authored commits across ${repositories.length} repositories.`
    );
    process.exit(0);
}

let nextReadme = readme;

if (activityChanged) {
    nextReadme = [
        nextReadme.slice(0, startIndex),
        nextBlock,
        nextReadme.slice(endIndex + markerEnd.length)
    ].join("");
}

const nextLanguageStartIndex = nextReadme.indexOf(languageMarkerStart);
const nextLanguageEndIndex = nextReadme.indexOf(languageMarkerEnd);

if (languagesChanged) {
    nextReadme = [
        nextReadme.slice(0, nextLanguageStartIndex),
        nextLanguageBlock,
        nextReadme.slice(nextLanguageEndIndex + languageMarkerEnd.length)
    ].join("");
}

await fs.writeFile(readmePath, nextReadme);

console.log(`Synced commit history and ${[...new Set(
    repositories.flatMap(repository => repository.languages.edges.map(edge => edge.node.name))
)].length} languages across ${repositories.length} repositories.`);
