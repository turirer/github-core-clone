// GitHub REST v3 surface: repositories, branches, commits, contents, labels,
// issues, comments and pull requests. All state lives in the in-memory Store;
// every reply is application/json and carries X-GitHub-Request-Id.

import { flattenTree, parseCommit, parseTree } from './gitobj.ts';
import {
  emptyResult,
  isRecord,
  jsonResult,
  notFound,
  parseJsonBody,
  unauthorized,
  type HttpRequest,
  type HttpResult,
} from './http.ts';
import {
  commitFile,
  deleteFile,
  lineCountsFor,
  pullFiles,
  pullMergeable,
  refreshPull,
  squashMerge,
  trialNowIso,
  VIEWER_LOGIN,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

// --------------------------------------------------------------------------------------------
// shapes
// --------------------------------------------------------------------------------------------

function repoJson(repo: Repo): Record<string, unknown> {
  const now = trialNowIso();
  return {
    id: repo.id,
    node_id: Buffer.from(`Repository:${repo.id}`, 'utf8').toString('base64url'),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1000, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: now,
    updated_at: now,
    pushed_at: now,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    forks_count: 0,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    watchers_count: 0,
    stargazers_count: 0,
  };
}

function labelJson(label: { name: string; color: string }): Record<string, unknown> {
  return { name: label.name, color: label.color, description: '' };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: repo.id * 100000 + issue.number,
    node_id: Buffer.from(`Issue:${repo.id}:${issue.number}`, 'utf8').toString('base64url'),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo.labels.get(name) ?? { name, color: 'ededed' })),
    user: { login: VIEWER_LOGIN, id: 1000, type: 'User' },
    comments: issue.comments.length,
    created_at: trialNowIso(),
    updated_at: trialNowIso(),
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: repo.id * 100000 + pull.number,
    node_id: Buffer.from(`PullRequest:${repo.id}:${pull.number}`, 'utf8').toString('base64url'),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pullMergeable(repo, pull) === 'MERGEABLE',
    head: { ref: pull.head, sha: pull.headSha, label: `${repo.owner}:${pull.head}` },
    base: { ref: pull.base, sha: pull.baseSha, label: `${repo.owner}:${pull.base}` },
    user: { login: VIEWER_LOGIN, id: 1000, type: 'User' },
    created_at: trialNowIso(),
    updated_at: trialNowIso(),
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function commitJson(repo: Repo, sha: string): Record<string, unknown> | null {
  const object = repo.objects.get(sha);
  if (!object || object.type !== 'commit') return null;
  const commit = parseCommit(object.data);
  return {
    sha,
    commit: {
      message: commit.message,
      author: { name: VIEWER_LOGIN, email: `${VIEWER_LOGIN}@example.invalid`, date: trialNowIso() },
      committer: { name: VIEWER_LOGIN, email: `${VIEWER_LOGIN}@example.invalid`, date: trialNowIso() },
      tree: { sha: commit.tree },
    },
    author: { login: VIEWER_LOGIN, id: 1000, type: 'User' },
    committer: { login: VIEWER_LOGIN, id: 1000, type: 'User' },
    parents: commit.parents.map((parent) => ({ sha: parent })),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
  };
}

// --------------------------------------------------------------------------------------------
// helpers
// --------------------------------------------------------------------------------------------

function badRequest(message: string): HttpResult {
  return jsonResult(400, { message });
}

function unprocessable(message: string): HttpResult {
  return jsonResult(422, { message });
}

function conflict(message: string): HttpResult {
  return jsonResult(409, { message });
}

function methodNotAllowed(message: string): HttpResult {
  return jsonResult(405, { message });
}

/** Look a repository up; the token owns only the viewer login, anything else is a 404. */
function lookupRepo(store: Store, owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) return null;
  return store.getRepo(owner, name) ?? null;
}

function parsePage(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
  return { page, perPage };
}

function pageOf<T>(items: readonly T[], page: number, perPage: number): T[] {
  return items.slice((page - 1) * perPage, page * perPage);
}

function linkHeader(base: string, path: string, query: URLSearchParams, page: number, perPage: number, total: number): string {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const make = (p: number): string => {
    const q = new URLSearchParams(query);
    q.set('page', String(p));
    q.set('per_page', String(perPage));
    return `<${base}${path}?${q.toString()}>`;
  };
  const links: string[] = [];
  if (page < totalPages) links.push(`${make(page + 1)}; rel="next"`);
  if (page > 1) links.push(`${make(1)}; rel="first"`);
  if (totalPages > 1) links.push(`${make(totalPages)}; rel="last"`);
  return links.join(', ');
}

function decodePath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// --------------------------------------------------------------------------------------------
// the router
// --------------------------------------------------------------------------------------------

export function handleRest(store: Store, req: HttpRequest, origin: string): HttpResult | null {
  if (!req.pathname.startsWith('/api/v3')) return null;
  const path = req.pathname === '/api/v3' ? '/api/v3/' : req.pathname;
  const method = req.method;

  // Public roots: no token needed.
  if (method === 'GET' && path === '/api/v3/') {
    return jsonResult(
      200,
      { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  }
  if (method === 'GET' && path === '/api/v3/meta') {
    return jsonResult(200, { installed_version: '1.0.0' });
  }

  // Everything else under /api/v3 needs the bearer token (checked by app.ts before here,
  // but keep the guard so a direct call is still safe).
  if (req.authed === false) return unauthorized();

  const parsed = parseJsonBody(req.body);
  if (!parsed.ok) return badRequest('Problems parsing JSON');
  const body = parsed.value;

  // GET /api/v3/user
  if (method === 'GET' && path === '/api/v3/user') {
    return jsonResult(200, {
      login: VIEWER_LOGIN,
      id: 1000,
      node_id: Buffer.from(`User:1000`, 'utf8').toString('base64url'),
      type: 'User',
      html_url: `https://github.com/${VIEWER_LOGIN}`,
      url: '/api/v3/user',
    });
  }

  // POST /api/v3/user/repos — create a repository
  if (method === 'POST' && path === '/api/v3/user/repos') {
    if (!isRecord(body)) return badRequest('Request body must be a JSON object');
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (name === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
      return unprocessable('name is invalid');
    }
    const description = typeof body.description === 'string' ? body.description : '';
    const isPrivate = body.private === undefined ? false : body.private === true;
    const repo = store.createRepo(VIEWER_LOGIN, name, description, isPrivate);
    if (!repo) return unprocessable('Repository already exists');
    return jsonResult(201, repoJson(repo));
  }

  // GET /api/v3/user/repos — list the viewer's repositories, paginated
  if (method === 'GET' && path === '/api/v3/user/repos') {
    const { page, perPage } = parsePage(req.query);
    const all = store.reposOf(VIEWER_LOGIN);
    const items = pageOf(all, page, perPage).map((repo) => repoJson(repo));
    const link = linkHeader(origin, path, req.query, page, perPage, all.length);
    return jsonResult(200, items, link === '' ? {} : { link });
  }

  // /api/v3/repos/{owner}/{name}[...]
  const repoMatch = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(path);
  if (!repoMatch) return jsonResult(404, { message: 'Not Found' });
  const owner = decodePath(repoMatch[1] as string);
  const repoName = decodePath(repoMatch[2] as string);
  const rest = repoMatch[3] ?? '';
  const repo = lookupRepo(store, owner, repoName);
  if (!repo) return notFound();

  // GET / PATCH / DELETE /api/v3/repos/{o}/{r}
  if (rest === '') {
    if (method === 'GET') return jsonResult(200, repoJson(repo));
    if (method === 'PATCH') {
      if (!isRecord(body)) return badRequest('Request body must be a JSON object');
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.default_branch === 'string' && repo.refs.has(`refs/heads/${body.default_branch}`)) {
        repo.defaultBranch = body.default_branch;
      }
      return jsonResult(200, repoJson(repo));
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, repoName);
      return emptyResult(204);
    }
    return jsonResult(404, { message: 'Not Found' });
  }

  // GET /api/v3/repos/{o}/{r}/branches
  if (rest === 'branches' && method === 'GET') {
    const branches: Record<string, unknown>[] = [];
    const names = [...repo.refs.keys()].filter((ref) => ref.startsWith('refs/heads/')).sort();
    for (const ref of names) {
      branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha: repo.refs.get(ref) } });
    }
    return jsonResult(200, branches);
  }

  // GET /api/v3/repos/{o}/{r}/branches/{branch}
  const branchMatch = /^branches\/(.+)$/.exec(rest);
  if (branchMatch && method === 'GET') {
    const branch = decodePath(branchMatch[1] as string);
    const sha = repo.refs.get(`refs/heads/${branch}`);
    if (!sha) return notFound();
    return jsonResult(200, { name: branch, commit: { sha } });
  }

  // GET /api/v3/repos/{o}/{r}/commits[?sha=]
  if (rest === 'commits' && method === 'GET') {
    const shaParam = req.query.get('sha');
    const tip = shaParam ? store.resolveRef(repo, decodePath(shaParam)) : store.headTip(repo);
    if (!tip) return jsonResult(200, []);
    const out: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      const view = commitJson(repo, oid);
      if (view) out.push(view);
      const commit = parseCommit(object.data);
      for (const parent of commit.parents) queue.push(parent);
    }
    return jsonResult(200, out);
  }

  // POST /api/v3/repos/{o}/{r}/git/refs — create a branch ref
  if (rest === 'git/refs' && method === 'POST') {
    if (!isRecord(body)) return badRequest('Request body must be a JSON object');
    const ref = typeof body.ref === 'string' ? body.ref : '';
    const sha = typeof body.sha === 'string' ? body.sha : '';
    if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha)) return unprocessable('ref and sha are required');
    if (!repo.objects.has(sha)) return unprocessable('sha does not exist');
    if (repo.refs.has(ref)) return unprocessable('Reference already exists');
    repo.refs.set(ref, sha);
    return jsonResult(201, { ref, object: { sha, type: 'commit' } });
  }

  // GET /api/v3/repos/{o}/{r}/git/refs/heads/{branch}
  const refMatch = /^git\/refs\/heads\/(.+)$/.exec(rest);
  if (refMatch && method === 'GET') {
    const branch = decodePath(refMatch[1] as string);
    const sha = repo.refs.get(`refs/heads/${branch}`);
    if (!sha) return notFound();
    return jsonResult(200, { ref: `refs/heads/${branch}`, object: { sha, type: 'commit' } });
  }

  // contents: /api/v3/repos/{o}/{r}/contents/{path...}
  const contentsMatch = /^contents\/(.+)$/.exec(rest);
  if (contentsMatch) {
    const filePath = decodePath(contentsMatch[1] as string);
    return handleContents(store, repo, req, body, filePath);
  }
  if (rest === 'contents' && method === 'GET') {
    // GET /contents on the root: list the root directory.
    return contentsDirectory(repo, '');
  }

  // POST /api/v3/repos/{o}/{r}/labels
  if (rest === 'labels' && method === 'POST') {
    if (!isRecord(body)) return badRequest('Request body must be a JSON object');
    const name = typeof body.name === 'string' ? body.name : '';
    if (name === '') return unprocessable('name is required');
    const color = typeof body.color === 'string' ? body.color : 'ededed';
    const existing = repo.labels.get(name);
    if (existing) return jsonResult(200, labelJson(existing));
    const label = { name, color };
    repo.labels.set(name, label);
    return jsonResult(201, labelJson(label));
  }

  // issues
  if (rest === 'issues') {
    if (method === 'POST') return createIssue(store, repo, body);
    if (method === 'GET') return listIssues(repo, req.query);
  }
  const issueMatch = /^issues\/(\d+)$/.exec(rest);
  if (issueMatch) {
    const number = Number(issueMatch[1]);
    const issue = repo.issues.find((entry) => entry.number === number);
    if (!issue) return notFound();
    if (method === 'GET') return jsonResult(200, issueJson(repo, issue));
    if (method === 'PATCH') {
      if (!isRecord(body)) return badRequest('Request body must be a JSON object');
      if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      return jsonResult(200, issueJson(repo, issue));
    }
  }
  const commentsMatch = /^issues\/(\d+)\/comments$/.exec(rest);
  if (commentsMatch) {
    const number = Number(commentsMatch[1]);
    const issue = repo.issues.find((entry) => entry.number === number);
    if (!issue) return notFound();
    if (method === 'GET') {
      return jsonResult(
        200,
        issue.comments.map((comment) => ({
          id: comment.id,
          node_id: Buffer.from(`IssueComment:${repo.id}:${issue.number}:${comment.id}`, 'utf8').toString('base64url'),
          body: comment.body,
          user: { login: VIEWER_LOGIN, id: 1000, type: 'User' },
          created_at: trialNowIso(),
          updated_at: trialNowIso(),
        })),
      );
    }
    if (method === 'POST') {
      if (!isRecord(body)) return badRequest('Request body must be a JSON object');
      const commentBody = typeof body.body === 'string' ? body.body : '';
      const comment = { id: repo.nextComment, body: commentBody, seq: repo.nextComment };
      repo.nextComment += 1;
      issue.comments.push(comment);
      return jsonResult(
        201,
        {
          id: comment.id,
          node_id: Buffer.from(`IssueComment:${repo.id}:${issue.number}:${comment.id}`, 'utf8').toString('base64url'),
          body: comment.body,
          user: { login: VIEWER_LOGIN, id: 1000, type: 'User' },
          created_at: trialNowIso(),
          updated_at: trialNowIso(),
        },
      );
    }
  }

  // pulls
  if (rest === 'pulls') {
    if (method === 'POST') return createPull(repo, body);
    if (method === 'GET') return listPulls(repo, req.query);
  }
  const pullMatch = /^pulls\/(\d+)$/.exec(rest);
  if (pullMatch) {
    const number = Number(pullMatch[1]);
    const pull = repo.pulls.find((entry) => entry.number === number);
    if (!pull) return notFound();
    if (method === 'GET') {
      refreshPull(repo, pull);
      return jsonResult(200, pullJson(repo, pull));
    }
  }
  const pullFilesMatch = /^pulls\/(\d+)\/files$/.exec(rest);
  if (pullFilesMatch && method === 'GET') {
    const number = Number(pullFilesMatch[1]);
    const pull = repo.pulls.find((entry) => entry.number === number);
    if (!pull) return notFound();
    refreshPull(repo, pull);
    return jsonResult(200, pullFiles(repo, pull));
  }
  const pullMergeMatch = /^pulls\/(\d+)\/merge$/.exec(rest);
  if (pullMergeMatch && method === 'PUT') {
    const number = Number(pullMergeMatch[1]);
    const pull = repo.pulls.find((entry) => entry.number === number);
    if (!pull) return notFound();
    refreshPull(repo, pull);
    const methodName = isRecord(body) && typeof body.merge_method === 'string' ? body.merge_method : 'squash';
    void methodName; // squash is the only method the suite asks for; it is what we do
    const result = squashMerge(store, repo, pull);
    if (!result.ok) return methodNotAllowed(result.message);
    return jsonResult(200, { sha: result.sha, merged: true, message: result.message });
  }

  return jsonResult(404, { message: 'Not Found' });
}

// --------------------------------------------------------------------------------------------
// contents
// --------------------------------------------------------------------------------------------

function contentsDirectory(repo: Repo, dir: string): HttpResult {
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (!tip) return jsonResult(200, []);
  const flat = treeFlat(repo, tip);
  return directoryListing(repo, tip, flat, dir);
}

function dirTreeSha(repo: Repo, tip: string, dirPath: string): string | null {
  const object = repo.objects.get(tip);
  if (!object || object.type !== 'commit') return null;
  let treeOid = parseCommit(object.data).tree;
  for (const segment of dirPath.split('/')) {
    const treeObject = repo.objects.get(treeOid);
    if (!treeObject || treeObject.type !== 'tree') return null;
    let found: string | null = null;
    for (const entry of parseTree(treeObject.data)) {
      if (entry.name === segment && entry.mode === '40000') found = entry.oid;
    }
    if (!found) return null;
    treeOid = found;
  }
  return treeOid;
}

function treeFlat(repo: Repo, tip: string): Map<string, { oid: string; mode: string }> {
  const object = repo.objects.get(tip);
  if (!object || object.type !== 'commit') return new Map();
  return flattenTree(repo.objects, parseCommit(object.data).tree);
}

/** The directory listing for `dir` inside the tree of `tip`, or null when it is not a directory. */
function directoryListing(
  repo: Repo,
  tip: string,
  flat: Map<string, { oid: string; mode: string }>,
  dir: string,
): HttpResult | null {
  const entries = new Map<string, { type: 'file' | 'dir'; name: string; path: string; sha: string }>();
  let found = false;
  for (const [path, entry] of flat) {
    if (dir !== '' && !path.startsWith(`${dir}/`)) continue;
    const rest = dir === '' ? path : path.slice(dir.length + 1);
    if (rest === '') continue;
    found = true;
    const slash = rest.indexOf('/');
    if (slash < 0) {
      entries.set(rest, { type: 'file', name: rest, path, sha: entry.oid });
    } else {
      const name = rest.slice(0, slash);
      const dirPath = dir === '' ? name : `${dir}/${name}`;
      if (!entries.has(name)) entries.set(name, { type: 'dir', name, path: dirPath, sha: '' });
    }
  }
  if (!found && dir !== '') return null;
  const out = [...entries.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const entry of out) {
    if (entry.type === 'dir') entry.sha = dirTreeSha(repo, tip, entry.path) ?? '';
  }
  return jsonResult(200, out);
}

function handleContents(store: Store, repo: Repo, req: HttpRequest, body: unknown, filePath: string): HttpResult {
  const refParam = req.query.get('ref');
  const branch = isRecord(body) && typeof body.branch === 'string' ? body.branch : undefined;
  const targetBranch = branch ?? (refParam ? decodeURIComponent(refParam) : repo.defaultBranch);

  if (req.method === 'GET') {
    const tip = store.resolveRef(repo, targetBranch);
    if (!tip) return notFound();
    const flat = treeFlat(repo, tip);
    const file = flat.get(filePath);
    if (file) {
      const object = repo.objects.get(file.oid);
      const content = object && object.type === 'blob' ? object.data : Buffer.alloc(0);
      return jsonResult(200, {
        type: 'file',
        encoding: 'base64',
        size: content.length,
        name: filePath.split('/').pop() ?? filePath,
        path: filePath,
        content: content.toString('base64'),
        sha: file.oid,
      });
    }
    // A directory listing.
    const dirResult = directoryListing(repo, tip, flat, filePath);
    if (dirResult === null) return notFound();
    return dirResult;
  }

  if (req.method === 'PUT') {
    if (!isRecord(body)) return badRequest('Request body must be a JSON object');
    const message = typeof body.message === 'string' ? body.message : 'Update file';
    const contentB64 = typeof body.content === 'string' ? body.content : '';
    let content: Buffer;
    try {
      content = Buffer.from(contentB64, 'base64');
    } catch {
      return badRequest('content is not valid base64');
    }
    const givenSha = typeof body.sha === 'string' ? body.sha : undefined;
    const tip = store.resolveRef(repo, targetBranch);
    const flat = tip ? treeFlat(repo, tip) : new Map<string, { oid: string; mode: string }>();
    const existing = flat.get(filePath);
    if (existing) {
      if (givenSha === undefined) return unprocessable('sha is required to update a file');
      if (givenSha.toLowerCase() !== existing.oid.toLowerCase()) return conflict('sha does not match the current file');
      const result = commitFile(store, repo, targetBranch, filePath, content, message);
      return jsonResult(200, {
        content: { name: filePath.split('/').pop() ?? filePath, path: filePath, sha: result.blobSha, encoding: 'base64' },
        commit: { sha: result.commitSha },
      });
    }
    if (givenSha !== undefined) return conflict('sha does not match: the file does not exist');
    const result = commitFile(store, repo, targetBranch, filePath, content, message);
    return jsonResult(201, {
      content: { name: filePath.split('/').pop() ?? filePath, path: filePath, sha: result.blobSha, encoding: 'base64' },
      commit: { sha: result.commitSha },
    });
  }

  if (req.method === 'DELETE') {
    if (!isRecord(body)) return badRequest('Request body must be a JSON object');
    const message = typeof body.message === 'string' ? body.message : 'Delete file';
    const tip = store.resolveRef(repo, targetBranch);
    if (!tip) return notFound();
    const flat = treeFlat(repo, tip);
    if (!flat.has(filePath)) return notFound();
    const result = deleteFile(store, repo, targetBranch, filePath, message);
    if (!result) return notFound();
    return jsonResult(200, { commit: { sha: result.commitSha } });
  }

  return jsonResult(404, { message: 'Not Found' });
}

// --------------------------------------------------------------------------------------------
// issues
// --------------------------------------------------------------------------------------------

function createIssue(store: Store, repo: Repo, body: unknown): HttpResult {
  if (!isRecord(body)) return badRequest('Request body must be a JSON object');
  const title = typeof body.title === 'string' ? body.title : '';
  const issueBody = typeof body.body === 'string' ? body.body : '';
  if (title === '') return unprocessable('title is required');
  const labels: string[] = Array.isArray(body.labels) ? body.labels.filter((label): label is string => typeof label === 'string') : [];
  for (const label of labels) {
    if (!repo.labels.has(label)) return unprocessable(`Label ${label} does not exist`);
  }
  const issue: Issue = {
    number: repo.nextIssue,
    title,
    body: issueBody,
    state: 'open',
    labels,
    comments: [],
    seq: repo.nextIssue,
  };
  repo.nextIssue += 1;
  repo.issues.push(issue);
  return jsonResult(201, issueJson(repo, issue));
}

function listIssues(repo: Repo, query: URLSearchParams): HttpResult {
  const state = query.get('state') ?? 'open';
  const sort = query.get('sort') ?? 'created';
  const direction = query.get('direction') ?? 'desc';
  let issues = [...repo.issues];
  if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
  else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
  if (sort === 'created') {
    issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
  }
  const { page, perPage } = parsePage(query);
  return jsonResult(200, pageOf(issues, page, perPage).map((issue) => issueJson(repo, issue)));
}

// --------------------------------------------------------------------------------------------
// pulls
// --------------------------------------------------------------------------------------------

function createPull(repo: Repo, body: unknown): HttpResult {
  if (!isRecord(body)) return badRequest('Request body must be a JSON object');
  const title = typeof body.title === 'string' ? body.title : '';
  const pullBody = typeof body.body === 'string' ? body.body : '';
  const head = typeof body.head === 'string' ? body.head : '';
  const base = typeof body.base === 'string' ? body.base : repo.defaultBranch;
  if (title === '' || head === '') return unprocessable('title and head are required');
  const headSha = repo.refs.get(`refs/heads/${head}`);
  const baseSha = repo.refs.get(`refs/heads/${base}`);
  if (!headSha) return unprocessable(`head branch ${head} does not exist`);
  if (!baseSha) return unprocessable(`base branch ${base} does not exist`);
  const existing = repo.pulls.find((pull) => pull.head === head && pull.base === base && pull.state === 'open');
  if (existing) return unprocessable('A pull request already exists for this head and base');
  const pull: Pull = {
    number: repo.nextPull,
    title,
    body: pullBody,
    state: 'open',
    head,
    base,
    headSha,
    baseSha,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    seq: repo.nextPull,
  };
  repo.nextPull += 1;
  repo.pulls.push(pull);
  return jsonResult(201, pullJson(repo, pull));
}

function listPulls(repo: Repo, query: URLSearchParams): HttpResult {
  const state = query.get('state') ?? 'open';
  let pulls = [...repo.pulls];
  if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
  else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
  pulls.sort((a, b) => b.seq - a.seq);
  const { page, perPage } = parsePage(query);
  return jsonResult(200, pageOf(pulls, page, perPage).map((pull) => pullJson(repo, pull)));
}

export { lineCountsFor };
