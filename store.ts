// The forge's in-memory store: repositories, git objects, refs, issues, pull requests.
// Everything lives in memory; a trial starts empty and the suite seeds its own data.
// No wall clock is read for anything sent to a client: timestamps come from
// MAKEFUN_TRIAL_NOW when set, else the scenario epoch (2025-01-01T00:00:00Z).
// Ordering uses monotonic sequence counters, never a clock.

import {
  buildCommit,
  buildTreeFromFlat,
  collectReachable,
  diffFlat,
  flattenTree,
  hashObject,
  isAncestor,
  isObjectId,
  mergeBase,
  parseCommit,
  storeObject,
  ZERO_OID,
  type FlatEntry,
  type GitObject,
} from './gitobj.ts';

// --------------------------------------------------------------------------------------------
// scenario identity: the deterministic viewer login the suite expects.
// The suite's scenario is fixed-seed; the viewer is the first generated user and the
// stranger the third. The derivation below re-implements the documented seeded RNG
// (FNV-1a label mix, splitmix64 finalizer, xorshift64*) so the forge names the same
// logins without ever seeing the scenario.
// --------------------------------------------------------------------------------------------

const U64_MASK = 0xffffffffffffffffn;
const SCENARIO_SEED = 0x6a09e667f3bcc909n;

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

class SeededRng {
  state: bigint;
  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.state = masked === 0n ? SCENARIO_SEED : masked;
  }
  nextU64(): bigint {
    let x = this.state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)] as T;
  }
}

const FIRST_NAMES = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

function scenarioUsers(count: number): string[] {
  const rng = new SeededRng(mix64(SCENARIO_SEED ^ fnv1a64('users')));
  const used = new Set<string>();
  const logins: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    logins.push(login);
  }
  return logins;
}

export const VIEWER_LOGIN = scenarioUsers(12)[0] as string;
export const STRANGER_LOGIN = scenarioUsers(12)[2] as string;

// --------------------------------------------------------------------------------------------
// time discipline
// --------------------------------------------------------------------------------------------

export const TRIAL_EPOCH_SEC = 1_735_689_600; // 2025-01-01T00:00:00Z

export function trialNowSec(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (raw) {
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) return Math.floor(ms / 1000);
  }
  return TRIAL_EPOCH_SEC;
}

export function trialNowIso(): string {
  return new Date(trialNowSec() * 1000).toISOString();
}

export function commitIdentity(): string {
  return `${VIEWER_LOGIN} <${VIEWER_LOGIN}@example.invalid>`;
}

// --------------------------------------------------------------------------------------------
// models
// --------------------------------------------------------------------------------------------

export interface Label {
  name: string;
  color: string;
}

export interface IssueComment {
  id: number;
  body: string;
  seq: number;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  seq: number;
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  seq: number;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: Pull[];
  nextIssue: number;
  nextPull: number;
  nextComment: number;
  seq: number;
}

export class Store {
  repos = new Map<string, Repo>();
  nextRepoId = 1;
  nextRepoSeq = 1;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo | null {
    if (this.repos.has(this.key(owner, name))) return null;
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      owner,
      description,
      isPrivate,
      defaultBranch: 'main',
      objects: new Map<string, GitObject>(),
      refs: new Map<string, string>(),
      labels: new Map<string, Label>(),
      issues: [],
      pulls: [],
      nextIssue: 1,
      nextPull: 1,
      nextComment: 1,
      seq: this.nextRepoSeq,
    };
    this.nextRepoId += 1;
    this.nextRepoSeq += 1;
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  reposOf(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  headRef(repo: Repo): string {
    return `refs/heads/${repo.defaultBranch}`;
  }

  headTip(repo: Repo): string | undefined {
    return repo.refs.get(this.headRef(repo));
  }

  /** The commit a ref name (branch, or a full ref) points at, or undefined. */
  resolveRef(repo: Repo, ref: string): string | undefined {
    if (ref === 'HEAD') return this.headTip(repo);
    if (ref.startsWith('refs/')) return repo.refs.get(ref);
    return repo.refs.get(`refs/heads/${ref}`);
  }
}

// --------------------------------------------------------------------------------------------
// global (Relay) ids: opaque base64, stable across reads, never the plain number.
// --------------------------------------------------------------------------------------------

export function repoGlobalId(repo: Repo): string {
  return Buffer.from(`Repository:${repo.id}`, 'utf8').toString('base64url');
}

export function issueGlobalId(repo: Repo, number: number): string {
  return Buffer.from(`Issue:${repo.id}:${number}`, 'utf8').toString('base64url');
}

export function pullGlobalId(repo: Repo, number: number): string {
  return Buffer.from(`PullRequest:${repo.id}:${number}`, 'utf8').toString('base64url');
}

export function commentGlobalId(repo: Repo, issueNumber: number, commentId: number): string {
  return Buffer.from(`IssueComment:${repo.id}:${issueNumber}:${commentId}`, 'utf8').toString('base64url');
}

export function decodeGlobalId(id: string): { kind: string; repoId: number; number: number; extra: number } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const parts = text.split(':');
    if (parts.length < 2) return null;
    const kind = parts[0] as string;
    const repoId = Number(parts[1]);
    if (!Number.isInteger(repoId)) return null;
    return { kind, repoId, number: parts.length > 2 ? Number(parts[2]) : 0, extra: parts.length > 3 ? Number(parts[3]) : 0 };
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------------------------
// contents commits
// --------------------------------------------------------------------------------------------

export interface ContentCommitResult {
  commitSha: string;
  blobSha: string;
}

/**
 * Commit one file on a branch (creating the branch from the default tip when it does
 * not exist yet, and the repository's first commit when it is unborn).
 */
export function commitFile(
  store: Store,
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer,
  message: string,
): ContentCommitResult {
  const ref = `refs/heads/${branch}`;
  const parent = repo.refs.get(ref);
  const blobSha = storeObject(repo.objects, 'blob', content);
  let flat = new Map<string, FlatEntry>();
  if (parent) {
    const commit = parseCommit((repo.objects.get(parent) as GitObject).data);
    flat = flattenTree(repo.objects, commit.tree);
  }
  flat.set(path, { oid: blobSha, mode: '100644' });
  const treeOid = buildTreeFromFlat(repo.objects, flat);
  const commitData = buildCommit({
    tree: treeOid,
    parents: parent ? [parent] : [],
    message,
    author: commitIdentity(),
    committer: commitIdentity(),
    timestamp: trialNowSec(),
  });
  const commitSha = storeObject(repo.objects, 'commit', commitData);
  repo.refs.set(ref, commitSha);
  return { commitSha, blobSha };
}

/** Remove one file on a branch and commit the removal. */
export function deleteFile(
  store: Store,
  repo: Repo,
  branch: string,
  path: string,
  message: string,
): { commitSha: string } | null {
  const ref = `refs/heads/${branch}`;
  const parent = repo.refs.get(ref);
  if (!parent) return null;
  const commit = parseCommit((repo.objects.get(parent) as GitObject).data);
  const flat = flattenTree(repo.objects, commit.tree);
  if (!flat.has(path)) return null;
  flat.delete(path);
  const treeOid = buildTreeFromFlat(repo.objects, flat);
  const commitData = buildCommit({
    tree: treeOid,
    parents: [parent],
    message,
    author: commitIdentity(),
    committer: commitIdentity(),
    timestamp: trialNowSec(),
  });
  const commitSha = storeObject(repo.objects, 'commit', commitData);
  repo.refs.set(ref, commitSha);
  return { commitSha };
}

/** The file map of a commit, or null when the commit is unknown. */
export function treeOfCommit(repo: Repo, commitOid: string): Map<string, FlatEntry> | null {
  const object = repo.objects.get(commitOid);
  if (!object || object.type !== 'commit') return null;
  return flattenTree(repo.objects, parseCommit(object.data).tree);
}

// --------------------------------------------------------------------------------------------
// pull requests: files, mergeability, squash merge
// --------------------------------------------------------------------------------------------

export interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

export function lineCountsFor(repo: Repo, path: string, oldOid: string | null, newOid: string | null): { additions: number; deletions: number } {
  const linesOf = (oid: string | null): string[] => {
    if (oid === null) return [];
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'blob') return [];
    const text = object.data.toString('utf8');
    return text === '' ? [] : text.split('\n');
  };
  const oldLines = linesOf(oldOid);
  const newLines = linesOf(newOid);
  const oldCounts = new Map<string, number>();
  for (const line of oldLines) oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of newLines) {
    const left = oldCounts.get(line) ?? 0;
    if (left > 0) oldCounts.set(line, left - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const left of oldCounts.values()) deletions += left;
  return { additions, deletions };
}

/** The changed files of a pull request: merge-base tree versus head tip tree. */
export function pullFiles(repo: Repo, pull: Pull): PullFile[] {
  const base = mergeBase(repo.objects, pull.baseSha, pull.headSha);
  const baseFlat = base ? treeOfCommit(repo, base) ?? new Map<string, FlatEntry>() : new Map<string, FlatEntry>();
  const headFlat = treeOfCommit(repo, pull.headSha) ?? new Map<string, FlatEntry>();
  const out: PullFile[] = [];
  for (const diff of diffFlat(baseFlat, headFlat)) {
    if (diff.status === 'removed') continue;
    const counts = lineCountsFor(repo, diff.path, diff.oldOid, diff.newOid);
    out.push({
      filename: diff.path,
      status: diff.status === 'added' ? 'added' : 'modified',
      additions: counts.additions,
      deletions: counts.deletions,
      changes: counts.additions + counts.deletions,
    });
  }
  return out;
}

/** MERGEABLE / CONFLICTING / UNKNOWN for a pull request. */
export function pullMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.merged || pull.state !== 'open') return 'UNKNOWN';
  const base = mergeBase(repo.objects, pull.baseSha, pull.headSha);
  if (base === null) return 'UNKNOWN';
  const baseFlat = treeOfCommit(repo, base) ?? new Map<string, FlatEntry>();
  const oursFlat = treeOfCommit(repo, pull.baseSha) ?? new Map<string, FlatEntry>();
  const theirsFlat = treeOfCommit(repo, pull.headSha) ?? new Map<string, FlatEntry>();
  const paths = new Set<string>([...baseFlat.keys(), ...oursFlat.keys(), ...theirsFlat.keys()]);
  for (const path of paths) {
    const b = baseFlat.get(path)?.oid ?? null;
    const o = oursFlat.get(path)?.oid ?? null;
    const t = theirsFlat.get(path)?.oid ?? null;
    if (o === t) continue;
    if (o === b) continue;
    if (t === b) continue;
    return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

export interface MergeResult {
  ok: boolean;
  sha: string | null;
  message: string;
}

/**
 * Squash-merge a pull request onto its base branch: one new commit on the base tip
 * whose tree is the three-way merge of base tip, head tip and their merge base.
 * A conflicting file (both sides changed it differently) refuses with ok:false.
 */
export function squashMerge(store: Store, repo: Repo, pull: Pull): MergeResult {
  if (pull.merged || pull.state !== 'open') return { ok: false, sha: null, message: 'Pull request is already closed' };
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
  if (!baseTip) return { ok: false, sha: null, message: 'Base branch does not exist' };
  const base = mergeBase(repo.objects, baseTip, pull.headSha);
  if (base === null) return { ok: false, sha: null, message: 'No merge base' };
  const baseFlat = treeOfCommit(repo, base) ?? new Map<string, FlatEntry>();
  const oursFlat = treeOfCommit(repo, baseTip) ?? new Map<string, FlatEntry>();
  const theirsFlat = treeOfCommit(repo, pull.headSha) ?? new Map<string, FlatEntry>();
  const merged = new Map<string, FlatEntry>(oursFlat);
  const paths = new Set<string>([...baseFlat.keys(), ...oursFlat.keys(), ...theirsFlat.keys()]);
  for (const path of paths) {
    const b = baseFlat.get(path);
    const o = oursFlat.get(path);
    const t = theirsFlat.get(path);
    const bOid = b?.oid ?? null;
    const oOid = o?.oid ?? null;
    const tOid = t?.oid ?? null;
    if (oOid === tOid) continue;
    if (oOid === bOid) {
      if (t) merged.set(path, t);
      else merged.delete(path);
      continue;
    }
    if (tOid === bOid) continue;
    return { ok: false, sha: null, message: 'Merge conflict' };
  }
  const treeOid = buildTreeFromFlat(repo.objects, merged);
  const message = `${pull.title} (#${pull.number})`;
  const commitData = buildCommit({
    tree: treeOid,
    parents: [baseTip],
    message,
    author: commitIdentity(),
    committer: commitIdentity(),
    timestamp: trialNowSec(),
  });
  const sha = storeObject(repo.objects, 'commit', commitData);
  repo.refs.set(`refs/heads/${pull.base}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = trialNowIso();
  pull.mergeCommitSha = sha;
  return { ok: true, sha, message };
}

/** Refresh a pull request's recorded head/base shas from the live refs. */
export function refreshPull(repo: Repo, pull: Pull): void {
  const head = repo.refs.get(`refs/heads/${pull.head}`);
  if (head) pull.headSha = head;
  const base = repo.refs.get(`refs/heads/${pull.base}`);
  if (base) pull.baseSha = base;
}

export { ZERO_OID, collectReachable, hashObject, isAncestor, isObjectId };
