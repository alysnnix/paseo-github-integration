# One repository, one GitHub integration

Design for turning `paseo-plugins` — a fork carrying three unrelated plugins — into
`paseo-github-integration`, a public repository whose whole content is the Paseo plugin that
integrates GitHub into Paseo.

Status: approved 2026-09-12. Supersedes the "three sibling npm projects, no workspace root" layout
inherited from the upstream fork.

## Why

Four things are wrong today, in the order they hurt.

**The repository holds code that is not ours and that nobody here runs.** `skills/` and
`launchd-jobs/` come from `gpambrozio/paseo-plugins`; `launchd-jobs` drives `launchctl` and plists,
which is macOS-only and dead weight on this machine. Publishing the fork publishes their work with
our commits layered on top, and the "forked from" badge points contributors and pull requests at a
repository that no longer shares a file with this one.

**Two files hold the whole plugin.** `client/board.tsx` is 5146 lines and `server/board.ts` is
2410. Between them they carry the list, the filters, the search, the orderings, the label menu, the
detail panel, review and merge, the launch dialog, the model picker, the prompt editor, the image
loader, the `gh` wrapper, every GraphQL query, and six caches. A reviewer cannot see a change in
context, and an edit has to be aimed by line number.

**Caching is six hand-rolled module globals.** `cachedBoard`, `cachedProjects`, `cachedProject`,
`cachedLabels` and `cachedDetails` on the server; `cachedBoard`, `cachedOwners`,
`cachedRepositoryLabels` and `cachedImages` on the client. Each repeats its own five-minute TTL.
None survives a `paseo plugin reload` or a daemon restart, because every one is a module variable.
None deduplicates concurrent callers, so two identical loads run two sweeps. The client never uses
`@tanstack/react-query`, which the host supplies as a runtime module, so `useRpc` — a bare invoker
with no request state — is called again on every remount. The result is GitHub rate limit spent on
answers the plugin already had.

**There is no safety net.** The plugin defines no `test` script while both sibling plugins use
vitest. Every check is `tsc --noEmit` plus a human opening the surface. The logic that broke in
recent sessions — the search parser, the sort comparator, the bucket merge — is pure and would have
been caught by a unit test.

## Target layout

The plugin becomes the repository root, so `paseo plugin add alysnnix/paseo-github-integration`
needs no `:path` suffix.

```text
paseo-github-integration/
  paseo-plugin.json        id: github-integration
  package.json             name: paseo-github-integration
  tsconfig.json
  index.client.tsx         wiring only
  index.server.ts          wiring only
  client/                  app bundle
  server/                  daemon bundle
  shared/                  contracts imported by both
  nix/plugin.nix           source-only derivation
  flake.nix                packages.github-integration, default, checks
  docs/                    screenshots and this spec
  README.md CHANGELOG.md CONTRIBUTING.md CLAUDE.md LICENSE
```

`skills/` and `launchd-jobs/` are removed in a single commit that keeps the history and the
upstream LICENSE. The repository is pushed to a new remote rather than renamed, which drops the
fork relationship while preserving every commit and its author.

### Modules

The `client` / `server` / `shared` split is imposed by the SDK and stays. Inside each runtime the
split is by feature, and no file is expected to pass roughly 400 lines.

| Runtime  | Directory   | Holds                                                              |
| -------- | ----------- | ------------------------------------------------------------------ |
| `shared` | `contracts/`| one module per feature: board, items, projects, timeline           |
| `shared` | `settings/` | the two settings documents and their defaults                      |
| `client` | `board/`    | the list, the mode switcher, relation chips, owner and repo pickers, search, orderings |
| `client` | `detail/`   | the panel, review actions, the merge dialog, comments, markdown, images |
| `client` | `launch/`   | the send dialog, provider and model pickers                        |
| `client` | `projects/` | the projects list and one project's board                          |
| `client` | `settings/` | the settings screen and the prompt editor                          |
| `client` | `theme/`    | styles, split alongside the features that consume them             |
| `client` | `lib/`      | pure helpers: search parsing, relative time, template rendering    |
| `server` | `github/`   | the `gh` executor, the GraphQL client, rate-limit accounting       |
| `server` | `board/`    | search buckets, the relation merge, checks                         |
| `server` | `items/`    | details, comments, labels, review and merge mutations              |
| `server` | `projects/` | the Projects v2 queries                                            |
| `server` | `cache/`    | one TTL cache with single-flight and disk persistence              |

Entries stay wiring only: they bind contracts to handlers and register contributions, as they do
now.

## Caching and the rate limit

One cache module on the server replaces the five module globals. It provides:

- **TTL per entry**, with the TTL passed in by the caller rather than copied into each call site.
- **Single-flight**: concurrent callers of one key await the same in-flight promise, so a remount
  racing a refresh costs one sweep, not two.
- **Disk persistence** under the plugin's data directory, so a reload or a daemon restart resumes
  from the last answer instead of re-sweeping GitHub.
- **Explicit invalidation**, which the existing label and merge mutations already need and today do
  by hand-patching `cachedBoard`.

Every GraphQL request additionally asks for `rateLimit { cost remaining limit resetAt }`. The cost
is logged per query, the remaining budget is exposed to the surface, and a sweep is refused with a
readable message when the budget is below a floor, instead of failing with GitHub's error.

On the client, `@tanstack/react-query` — a module the host provides — replaces the four manual
caches. Each RPC gets a query key and an explicit `staleTime`, so two open surfaces and a remount
share one request, and the "stale board stays on screen while the refresh runs" behaviour that
`cachedBoard` implements by hand becomes the library's default.

## Testing, linting and release

vitest over the logic that is pure:

- search parsing and matching, including the `/`, `#` and `@` sigils and separator normalisation;
- the sort comparators, including the missing-date fallback;
- the bucket merge: relation union, dedupe by node id, ordering, the limit;
- the cache: TTL expiry, single-flight, persistence round-trip, invalidation;
- prompt template rendering and placeholder handling.

Server handlers become testable without the network by taking their `gh` executor as an injected
dependency, with a fake in tests. Client rendering stays verified by a human opening the surface;
there is no RN harness here and inventing one is out of scope.

The project's own rules are enforced by small zero-dependency Node scripts under `scripts/`, not by
a plugin tree: no source file over 400 code lines, no duplicated function bodies, the SDK import
boundaries the compiler cannot see (`client` never imports `server`, `shared` imports neither Node
nor React, browser globals only in `client/web.ts`), and agreement between the version in
`package.json`, in `nix/plugin.nix` and in the CHANGELOG heading. A general linter is adopted only
if it is a single self-contained binary; the ESLint plus typescript-eslint plus sonarjs plus jscpd
stack would add hundreds of transitive packages to enforce four rules, and is rejected on supply
chain grounds. Runtime dependencies stay at exactly one, `@getpaseo/plugin`, which the host
supplies anyway.

CI runs typecheck, lint, vitest and `nix build` on push and pull request.

A release is cut by pushing a **signed** tag. The release workflow refuses an unsigned one, checks
the tag against the `package.json` version, takes the release notes verbatim from the CHANGELOG
section rather than generating them from commits, publishes a source tarball of exactly what the
plugin ships alongside `SHA256SUMS`, and attests it with GitHub's build provenance so anyone can
run `gh attestation verify` against the repository. No signing key is stored: the attestation uses
the workflow's OIDC identity, and the tag carries the maintainer's own SSH signature.

## Documentation

`README.md` and `CLAUDE.md` still describe four side-by-side columns and a dual `author:`/`user:`
search, which the relation sweep replaced two sessions ago. Both are rewritten against the current
behaviour. The previous author's screenshots are removed and replaced with fresh captures of this
board, and the README credits `gpambrozio/paseo-plugins` as the fork this started from.

## Non-goals

- No behaviour change. The refactor is structural; the board looks and works exactly as it does
  today when it lands.
- No React Native test harness, and no snapshot tests of surfaces.
- No change to the `client` / `server` / `shared` split, which the SDK enforces.
- No renaming of the settings documents or their persisted fields, which would drop the user's
  saved filters, owners and prompts.

## Migration

1. Delete the upstream plugins, move the plugin to the root, rename id and package, rewrite the
   nix derivation and the flake for the new root, push to the new remote.
2. Split `server/board.ts` and `client/board.tsx` into the module tree above, one owner per file,
   no behaviour change.
3. Introduce the cache module and the rate-limit accounting; adopt `@tanstack/react-query` on the
   client.
4. Add vitest, the tests listed above, and CI.
5. Rewrite `README.md` and `CLAUDE.md`, which still describe four columns and a dual search that
   the relation sweep replaced.
6. Point the nalyx flake input, overlay attribute and daemon config at the new repository and id.
