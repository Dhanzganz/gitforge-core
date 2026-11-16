# gitforge-core

A self-hosted git forge in a single Node process: git smart HTTP (protocol v0 and v2),
the GitHub REST API v3 surface, the GraphQL v4 surface, and an MCP server — built for the
make.fun bounty [github-core-clone-01](https://make.fun/bounty/github-core-clone-01).

[![Competition](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![Rank](https://make.fun/badge/github-core-clone-01/Dhanzganz/gitforge-core/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![Reward](https://make.fun/badge/github-core-clone-01/Dhanzganz/gitforge-core/reward.svg)](https://make.fun/bounty/github-core-clone-01)

Competition: https://make.fun/bounty/github-core-clone-01

## What it does

- **Git smart HTTP** — ref advertisements (v0 and v2), `ls-refs` with prefix filtering and
  peeling, `fetch` with want/have negotiation, shallow clones and deepen, and
  `receive-pack` pushes with `report-status` (fast-forward enforcement, branch/tag
  deletes, mixed ok/ng reports). The git object model and the pack format are implemented
  from scratch on `node:zlib` and `node:crypto`: no git binary, no dependencies.
- **REST API v3** — repositories (create/read/patch/delete), branches, commits, git refs,
  the Contents API, labels, issues with comments, and pull requests with file diffs and
  squash/merge merges (405 on conflicts), GitHub-shaped errors, `Link` pagination and
  `X-GitHub-Request-Id` on every reply.
- **GraphQL v4** — a hand-written lexer, parser and executor covering the viewer,
  repository, issue and pull request documents, cursor-paginated connections, the
  create/close/merge mutations, `node(id:)` with opaque global ids, operation batching,
  and the introspection surface the schema queries need.
- **MCP** — `server/discover`, `initialize`, `ping`, `tools/list` and `tools/call` over
  streamable HTTP JSON, with the six forge tools (`create_repo`, `get_repo`,
  `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`) sharing
  the same store as the REST and GraphQL surfaces.

State is in-memory and fully deterministic: timestamps come from a synthetic clock, so
two runs of the same request sequence export byte-identical state.

## Running

Requires Node 22 or newer. No install step — there are no dependencies.

```sh
node --experimental-strip-types main.ts
```

The entry registers its ephemeral port with `$MAKEFUN_ENV_URL` and serves until the env
reports the trial done. Every API surface answers under the trial's bearer token;
`/healthz` is open.

## Layout

- `main.ts` — the trial lifecycle (register, serve, exit), verbatim from the kit starter.
- `app.ts` — HTTP routing, auth and the JSON protocol discipline.
- `src/gitcore.ts` — SHA-1 object ids, trees/commits/tags, pkt-lines, pack read/write.
- `src/smart.ts` — the git smart-HTTP protocol (advertise, ls-refs, fetch, push).
- `src/store.ts` — the in-memory store: repos, objects, refs, issues, pulls, merges.
- `src/rest.ts` — the REST v3 surface.
- `src/graphql.ts` — the GraphQL v4 surface (lexer, parser, schema, executor).
- `src/mcp.ts` — the MCP server.
- `src/identity.ts` — the scenario identity derivation (viewer, users, org).

## License

MIT — see `LICENSE`.
