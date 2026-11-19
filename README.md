# GitHub Core Clone — a GitHub-compatible git forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/turirer/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/turirer/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

Entry for [make.fun](https://make.fun/bounty/github-core-clone-01) competition `github-core-clone-01` — $500, entries close
2026-11-21T06:30:00Z. Account: @brisk-kestrel-81 (GitHub linked as turirer).
Referral: https://make.fun/r/d6btpjsv

## What it is

A from-scratch GitHub-compatible git forge in TypeScript, Node 22 standard
library only, no dependencies, no git binary, no network at runtime. One
process serves the whole surface over HTTP:

- **Smart-HTTP git**: protocol v2 (`fetch`, `ls-refs`, `object-format=sha1`)
  and v0 fetch, `receive-pack` with fast-forward-only pushes, side-band-64k
  report-status, shallow clones (`deepen`, `deepen-relative`, unshallow),
  incremental fetch against `have` lines, annotated-tag peeling, packfiles
  written and read from first principles (SHA-1 objects, OFS/REF delta
  resolution, merge-base, three-way diffs).
- **REST v3** (`/api/v3/`): users, repos, branches, commits, contents
  (blob SHA-1 round-trips), labels, issues, comments, pull requests with
  squash merge and mergeability detection, `Link` pagination,
  `X-GitHub-Request-Id` on every reply, JSON errors everywhere.
- **GraphQL** (`/api/v3/graphql`): hand-rolled parser/executor, Relay global
  ids, introspection, cursor pagination, batched operation documents,
  mutations sharing the same store as REST.
- **MCP** (`/mcp`): JSON-RPC 2.0 Streamable HTTP, `server/discover` plus the
  `initialize` handshake, `tools/list` and `tools/call` for `create_repo`,
  `get_repo`, `create_issue`, `list_issues`, `create_pull_request`,
  `merge_pull_request` on the same store.
- **Deterministic scenario**: the viewer is `adaiversen`, the teammate
  `quinnkeller`, the stranger `olgabauer`, the org `faint-meadow-org`, the
  first repo `amber-thistle` — derived at startup from the seeded RNG the kit
  documents. Dates come from `MAKEFUN_TRIAL_NOW` (else a fixed epoch), so a
  replay leaves identical state.

## Run it

```sh
node --experimental-strip-types main.ts
```

`main.ts` binds an ephemeral port, registers it at
`$MAKEFUN_ENV_URL/register`, then long-polls `$MAKEFUN_ENV_URL/done` until
the environment says the trial is over and exits 0. Auth is
`Authorization: Bearer $MAKEFUN_SHOP_TOKEN`.

For a quick local run without the environment:

```sh
MAKEFUN_SHOP_TOKEN=test-token-123 PORT=8901 \
  node --experimental-strip-types main.ts
```

then `curl -H 'Authorization: Bearer test-token-123' http://127.0.0.1:8901/api/v3/user`.

## Verification

Against the kit's own local conformance runner
(`sdk/run.ts --url http://127.0.0.1:8901 --token test-token-123 --perf`):

- **120/120 checks pass** — git 30/30, repos 15/15, issues 15/15,
  pulls 20/20, protocol 5/5, GraphQL 20/20, MCP 15/15
- **Perf 158/200** (reference forge: 100/200 at the kit's calibration)
- **Total score 958/1000** on the dev VM

Real `git` (2.43) was also exercised against the forge: clone, push, full
clone, `--depth 1` shallow clone, `fetch --deepen=1`, and `--unshallow` all
work.

## Layout

| File | What it does |
| --- | --- |
| `main.ts` | Entrypoint: bind, register, poll `/done`, exit 0 |
| `app.ts` | HTTP server, auth, request-id, routing |
| `git.ts` | Smart-HTTP git: v2/v0 info/refs, fetch, receive-pack |
| `gitobj.ts` | Git objects, SHA-1, trees/commits/tags, pack read/write |
| `store.ts` | In-memory store: repos, refs, issues, PRs, scenario identity |
| `rest.ts` | REST v3 surface |
| `graphql.ts` | GraphQL parser, executor, introspection, mutations |
| `mcp.ts` | MCP JSON-RPC endpoint |
| `http.ts` | Shared request/response types and JSON helpers |

## License

MIT — see [LICENSE](LICENSE).
