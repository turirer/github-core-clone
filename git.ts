// Git smart HTTP: info/refs advertisements (protocol v2 for upload-pack, v0 for
// receive-pack), v2 ls-refs and fetch, v0 fetch, and receive-pack pushes.
// The wire shapes follow the protocol the conformance client speaks.

import {
  collectReachable,
  decodePktLines,
  hashObject,
  isAncestor,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  pktDelim,
  pktFlush,
  pktLine,
  readPack,
  writePack,
  ZERO_OID,
  type GitObject,
} from './gitobj.ts';
import { VIEWER_LOGIN, type Repo, type Store } from './store.ts';

import { jsonResult as jsonResponse, type HttpRequest as GitRequest, type HttpResult as GitResponse } from './http.ts';

function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  const out: Array<{ name: string; oid: string }> = [];
  for (const [name, oid] of repo.refs) out.push({ name, oid });
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

function headOid(repo: Repo): string | undefined {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
}

/** The peeled commit of an annotated tag ref, or null. */
function peeledOid(repo: Repo, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'tag') return null;
  try {
    return parseTag(object.data).object;
  } catch {
    return null;
  }
}

const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

/** A v2 capability advertisement for upload-pack. */
function v2Advertisement(): Buffer {
  const parts: Buffer[] = [
    pktLine('# service=git-upload-pack\n'),
    pktFlush(),
    pktLine('version 2\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow wait-for-done\n'),
    pktLine('object-format=sha1\n'),
    pktLine('agent=forge/1.0\n'),
    pktFlush(),
  ];
  return Buffer.concat(parts);
}

/** A v0 ref advertisement, for upload-pack or receive-pack. */
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? 'symref=HEAD:refs/heads/main multi_ack_detailed side-band-64k thin-pack ofs-delta shallow agent=forge/1.0'
      : 'report-status report-status-v2 side-band-64k ofs-delta delete-refs symref=HEAD:refs/heads/main agent=forge/1.0';
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const head = headOid(repo);
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headLine = head
      ? `${head} HEAD\0${caps}\n`
      : `${ZERO_OID} HEAD\0${caps}\n`;
    parts.push(pktLine(headLine));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      const peeled = peeledOid(repo, ref.oid);
      if (peeled) parts.push(pktLine(`${peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function infoRefs(repo: Repo, service: string, gitProtocol: string | undefined): GitResponse {
  if (service === 'git-upload-pack') {
    if (gitProtocol === 'version=2') {
      return { status: 200, contentType: UPLOAD_AD, body: v2Advertisement() };
    }
    return { status: 200, contentType: UPLOAD_AD, body: v0Advertisement(repo, 'git-upload-pack') };
  }
  if (service === 'git-receive-pack') {
    return { status: 200, contentType: RECEIVE_AD, body: v0Advertisement(repo, 'git-receive-pack') };
  }
  return jsonResponse(400, { message: `Unknown service ${service}` });
}

// --------------------------------------------------------------------------------------------
// v2 ls-refs / fetch
// --------------------------------------------------------------------------------------------

interface V2Command {
  command: string;
  args: string[];
}

function parseV2Body(body: Buffer): V2Command {
  const packets = decodePktLines(body);
  let command = '';
  const argLines: string[] = [];
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data' || !packet.payload) continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!seenDelim) {
      if (text.startsWith('command=')) command = text.slice('command='.length);
      continue;
    }
    argLines.push(text);
  }
  return { command, args: argLines };
}

function lsRefsResponse(repo: Repo, args: string[]): Buffer {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const head = headOid(repo);
  // HEAD is listed when no ref-prefix filters the answer, or when a prefix
  // matches it (real git asks for ref-prefix HEAD alongside the ref prefixes).
  if (symrefs && keep('HEAD')) {
    if (head) parts.push(pktLine(`${head} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    else if (unborn) parts.push(pktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
  }
  for (const ref of sortedRefs(repo)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    const peeled = peel ? peeledOid(repo, ref.oid) : null;
    if (peeled) line += ` peeled:${peeled}`;
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

interface FetchPlan {
  /** Objects to send, by oid. */
  send: Map<string, GitObject>;
  shallow: string[];
  unshallow: string[];
}

/** BFS distance between two commits over parent links, or null when unrelated. */
function commitDistance(objects: Map<string, GitObject>, from: string, target: string): number | null {
  if (from === target) return 0;
  const seen = new Set<string>([from]);
  let frontier = [from];
  let distance = 0;
  while (frontier.length > 0) {
    distance += 1;
    const next: string[] = [];
    for (const oid of frontier) {
      const object = objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (parent === target) return distance;
        if (!seen.has(parent)) {
          seen.add(parent);
          next.push(parent);
        }
      }
    }
    frontier = next;
  }
  return null;
}

/**
 * Plan a fetch: which objects the client still needs, and the new shallow boundary.
 * `haves` are commits the client holds; `shallow` are its current shallow boundaries
 * (their parents are not held, so the held-closure stops at them).
 * With `deepenRelative`, `depth` counts generations beyond each shallow boundary
 * instead of from the wants.
 */
function planFetch(
  repo: Repo,
  wants: string[],
  haves: string[],
  shallow: string[],
  depth: number | null,
  deepenRelative = false,
): FetchPlan {
  const held = new Set<string>();
  {
    const shallowSet = new Set(shallow);
    const queue: string[] = [];
    for (const have of haves) if (isObjectId(have) && repo.objects.has(have)) queue.push(have);
    while (queue.length > 0) {
      const oid = queue.pop() as string;
      if (held.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (!object) continue;
      held.add(oid);
      if (object.type === 'commit') {
        if (shallowSet.has(oid)) continue; // a shallow boundary has no parents on the client
        const commit = parseCommit(object.data);
        queue.push(commit.tree);
        for (const parent of commit.parents) queue.push(parent);
      } else if (object.type === 'tag') {
        queue.push(parseTag(object.data).object);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) {
          if (entry.mode !== '160000') queue.push(entry.oid);
        }
      }
    }
  }

  // Deepen: an absolute depth counts from the wants; a relative depth counts
  // from each shallow boundary the client reports (git sends `deepen-relative`
  // for --deepen). The client holds dist+1 generations up to a boundary at
  // distance dist from a want, so a relative deepen of n makes depth dist+1+n.
  let effectiveDepth = depth;
  if (depth !== null && deepenRelative && shallow.length > 0) {
    let maxExtra = 0;
    for (const boundary of shallow) {
      for (const want of wants) {
        const distance = commitDistance(repo.objects, want, boundary);
        if (distance !== null) maxExtra = Math.max(maxExtra, distance + depth + 1);
      }
    }
    if (maxExtra > 0) effectiveDepth = maxExtra;
  }

  // Walk from the wants, honouring depth. A tag want resolves to its target at the same distance.
  // The shallow boundary is the deepest included commit (its parents stay behind).
  const included = new Set<string>();
  const boundary = new Set<string>();
  const unshallow: string[] = [];
  {
    const distance = new Map<string, number>();
    const queue: Array<{ oid: string; dist: number }> = [];
    for (const want of wants) {
      if (!isObjectId(want) || !repo.objects.has(want)) continue;
      queue.push({ oid: want, dist: 0 });
    }
    while (queue.length > 0) {
      const { oid, dist } = queue.shift() as { oid: string; dist: number };
      if (included.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (!object) continue;
      if (effectiveDepth !== null && object.type === 'commit' && dist >= effectiveDepth) continue;
      included.add(oid);
      distance.set(oid, dist);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        queue.push({ oid: commit.tree, dist });
        for (const parent of commit.parents) queue.push({ oid: parent, dist: dist + 1 });
      } else if (object.type === 'tag') {
        queue.push({ oid: parseTag(object.data).object, dist });
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) {
          if (entry.mode !== '160000') queue.push({ oid: entry.oid, dist });
        }
      }
    }
    if (effectiveDepth !== null) {
      for (const [oid, dist] of distance) {
        if (dist !== effectiveDepth - 1) continue;
        const object = repo.objects.get(oid);
        if (object && object.type === 'commit') boundary.add(oid);
      }
    }
    for (const old of shallow) {
      if (included.has(old)) unshallow.push(old);
    }
  }

  const send = new Map<string, GitObject>();
  for (const oid of included) {
    if (held.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object) send.set(oid, object);
  }
  return { send, shallow: [...boundary].sort(), unshallow };
}

function sidebandPackets(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(offset + CHUNK, pack.length));
    const payload = Buffer.concat([Buffer.from([1]), slice]);
    out.push(pktLine(payload));
  }
  return out;
}

function fetchV2Response(repo: Repo, args: string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let deepenRelative = false;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) depth = Number.parseInt(arg.slice(7).trim(), 10);
    else if (arg === 'deepen-relative') deepenRelative = true;
  }
  if (depth !== null && !Number.isFinite(depth)) depth = null;

  const plan = planFetch(repo, wants, haves, shallow, depth, deepenRelative);
  const objects = [...plan.send.values()].sort((a, b) => {
    const ao = hashObject(a.type, a.data);
    const bo = hashObject(b.type, b.data);
    return ao < bo ? -1 : ao > bo ? 1 : 0;
  });
  const pack = writePack(objects);

  const parts: Buffer[] = [];
  // acknowledgments: only when the client sent have lines (protocol-v2 requires
  // the section to be omitted otherwise; real git rejects it there).
  const heldHaves = haves.filter((have) => repo.objects.has(have));
  if (haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    for (const have of heldHaves) parts.push(pktLine(`ACK ${have}\n`));
    if (heldHaves.length === 0) parts.push(pktLine('NAK\n'));
    else parts.push(pktLine('ready\n'));
    parts.push(pktDelim());
  }
  // shallow-info, only when a depth was asked for or boundaries moved
  if (depth !== null || plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  // packfile (always present, even when empty: a zero-object pack)
  parts.push(pktLine('packfile\n'));
  for (const packet of sidebandPackets(pack)) parts.push(packet);
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function fetchV0Response(repo: Repo, body: Buffer): Buffer {
  // v0: want lines (+caps on the first), shallow/deepen lines, flush, have lines, done, flush.
  const packets = decodePktLines(body);
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data' && packet.payload) lines.push(packet.payload.toString('utf8'));
  }
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let deepenRelative = false;
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    const first = line.split('\0')[0] as string;
    if (first.startsWith('want ')) wants.push(first.slice(5).split(' ')[0] as string);
    else if (first.startsWith('have ')) haves.push(first.slice(5).trim());
    else if (first.startsWith('shallow ')) shallow.push(first.slice(8).trim());
    else if (first.startsWith('deepen ')) depth = Number.parseInt(first.slice(7).trim(), 10);
    else if (first === 'deepen-relative') deepenRelative = true;
  }
  if (depth !== null && !Number.isFinite(depth)) depth = null;
  const plan = planFetch(repo, wants, haves, shallow, depth, deepenRelative);
  const objects = [...plan.send.values()].sort((a, b) => {
    const ao = hashObject(a.type, a.data);
    const bo = hashObject(b.type, b.data);
    return ao < bo ? -1 : ao > bo ? 1 : 0;
  });
  const pack = writePack(objects);
  const parts: Buffer[] = [];
  const heldHaves = haves.filter((have) => repo.objects.has(have));
  if (heldHaves.length > 0) {
    for (const have of heldHaves) parts.push(pktLine(`ACK ${have}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  for (const packet of sidebandPackets(pack)) parts.push(packet);
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function uploadPack(repo: Repo, req: GitRequest): GitResponse {
  const protocol = req.headers['git-protocol'];
  if (protocol === 'version=2') {
    let parsed: V2Command;
    try {
      parsed = parseV2Body(req.body);
    } catch {
      return jsonResponse(400, { message: 'Malformed pkt-line in upload-pack request' });
    }
    if (parsed.command === 'ls-refs') {
      return { status: 200, contentType: UPLOAD_RESULT, body: lsRefsResponse(repo, parsed.args) };
    }
    if (parsed.command === 'fetch') {
      return { status: 200, contentType: UPLOAD_RESULT, body: fetchV2Response(repo, parsed.args) };
    }
    return jsonResponse(400, { message: `Unknown upload-pack command ${parsed.command}` });
  }
  // v0 fetch
  try {
    return { status: 200, contentType: UPLOAD_RESULT, body: fetchV0Response(repo, req.body) };
  } catch {
    return jsonResponse(400, { message: 'Malformed pkt-line in upload-pack request' });
  }
}

// --------------------------------------------------------------------------------------------
// receive-pack
// --------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function receivePack(repo: Repo, req: GitRequest): GitResponse {
  const commands: PushCommand[] = [];
  let packBytes: Buffer = Buffer.alloc(0);
  let sideband = false;
  try {
    // Scan the raw body for the first flush packet (0000) at a packet boundary.
    // Everything after it is the raw packfile, not pkt-lines.
    let cursor = 0;
    let firstFlushEnd = -1;
    while (cursor + 4 <= req.body.length) {
      const header = req.body.subarray(cursor, cursor + 4).toString('ascii');
      if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
      const length = Number.parseInt(header, 16);
      if (length === 0) {
        firstFlushEnd = cursor + 4;
        break;
      }
      if (length < 4 || cursor + length > req.body.length) break;
      const payload = req.body.subarray(cursor + 4, cursor + length).toString('utf8');
      const firstLine = payload.split('\0')[0] as string;
      const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)\n?$/.exec(firstLine.trim());
      if (match) {
        commands.push({ oldOid: match[1] as string, newOid: match[2] as string, ref: match[3] as string });
        if (commands.length === 1) {
          const caps = payload.split('\0')[1] ?? '';
          sideband = caps.split(' ').includes('side-band-64k');
        }
      }
      cursor += length;
    }
    if (firstFlushEnd < 0) return jsonResponse(400, { message: 'Push command list has no flush' });
    packBytes = req.body.subarray(firstFlushEnd);
  } catch {
    return jsonResponse(400, { message: 'Malformed pkt-line in receive-pack request' });
  }

  const reportLines: string[] = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  const hasUpdates = commands.some((command) => command.newOid !== ZERO_OID);
  if (hasUpdates) {
    try {
      const objects = readPack(packBytes, (oid) => repo.objects.get(oid));
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }

  if (unpackOk) {
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      let ok = false;
      let reason = '';
      if (command.newOid === ZERO_OID) {
        // delete
        if (!current) {
          reason = 'ref does not exist';
        } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
          reason = 'old value does not match';
        } else {
          ok = true;
        }
      } else if (command.oldOid === ZERO_OID) {
        // create
        if (current) {
          reason = 'already exists';
        } else if (!repo.objects.has(command.newOid)) {
          reason = 'object not found';
        } else {
          ok = true;
        }
      } else {
        // update: fast-forward only
        if (!current) {
          reason = 'ref does not exist';
        } else if (current !== command.oldOid) {
          reason = 'old value does not match';
        } else if (!repo.objects.has(command.newOid)) {
          reason = 'object not found';
        } else if (!isAncestor(repo.objects, command.oldOid, command.newOid)) {
          reason = 'non-fast-forward';
        } else {
          ok = true;
        }
      }
      if (ok) {
        if (command.newOid === ZERO_OID) repo.refs.delete(command.ref);
        else repo.refs.set(command.ref, command.newOid);
        reportLines.push(`ok ${command.ref}`);
      } else {
        reportLines.push(`ng ${command.ref} ${reason}`);
      }
    }
  } else {
    for (const command of commands) reportLines.push(`ng ${command.ref} unpack failed`);
  }

  // Each report line is its own pkt-line inside band 1 (real git reads the report
  // line by line; a single pkt-line holding several lines does not parse).
  const reportParts: Buffer[] = [pktLine(`unpack ${unpackOk ? 'ok' : unpackDetail}\n`)];
  for (const line of reportLines) reportParts.push(pktLine(`${line}\n`));
  reportParts.push(pktFlush());
  const inner = Buffer.concat(reportParts);
  let body: Buffer;
  if (sideband) {
    body = Buffer.concat([...sidebandPackets(inner), pktFlush()]);
  } else {
    body = inner;
  }
  return { status: 200, contentType: RECEIVE_RESULT, body };
}

// --------------------------------------------------------------------------------------------
// router
// --------------------------------------------------------------------------------------------

/** Handle a git smart-HTTP request. Returns null when the path is not a git route. */
export function handleGit(store: Store, req: GitRequest): GitResponse | null {
  const match = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(req.pathname);
  if (!match) return null;
  const owner = decodeURIComponent(match[1] as string);
  const repoName = decodeURIComponent(match[2] as string);
  const service = match[3] as string;
  if (owner !== VIEWER_LOGIN) return jsonResponse(404, { message: 'Not Found' });
  const repo = store.getRepo(owner, repoName);
  if (!repo) return jsonResponse(404, { message: 'Not Found' });
  if (service === 'info/refs' && req.method === 'GET') {
    const serviceParam = req.query.get('service') ?? '';
    return infoRefs(repo, serviceParam, req.headers['git-protocol']);
  }
  if (service === 'git-upload-pack' && req.method === 'POST') return uploadPack(repo, req);
  if (service === 'git-receive-pack' && req.method === 'POST') return receivePack(repo, req);
  return jsonResponse(404, { message: 'Not Found' });
}

export { collectReachable };
