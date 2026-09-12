# Contributing

Thanks for taking a look. This repository is one Paseo plugin, and its root is the plugin root:
`paseo-plugin.json`, `index.client.tsx`, `index.server.ts`, and the three runtime directories.

```bash
npm install
npm run typecheck   # tsc --noEmit, the type gate
npm run lint        # the project's own rules, plus oxlint
npm test            # vitest over the pure logic
```

## Trying a change against a running daemon

`paseo plugin install` records the absolute directory it was given, so install from your clone and
reload after each change. Reload, never restart: the daemon manages the user's running agents.

```bash
paseo plugin install "$PWD" --id github-integration-dev
paseo plugin reload github-integration-dev
paseo plugin logs github-integration-dev     # load errors and stderr
```

**A failed reload stays failed.** Paseo does not restore the previous code; read the logs, fix, and
reload again.

There is no harness for plugin UI. A clean typecheck and a clean reload prove a `client/` change
compiles and loads, nothing more. Look at the surface yourself: a wide window *and* a compact one,
and switch theme — unstyled text and hardcoded colours only show up in one of them.

## Layout

The `client` / `server` / `shared` split is imposed by the Paseo SDK: `client/` is compiled into the
app bundle, `server/` into the daemon subprocess, `shared/` into both. A client import of `server/`,
a server import of React, or a Node import from `shared/` is a build error, and `npm run lint`
catches all three before the build does.

Inside each runtime the split is by feature.

| Directory          | Holds                                                                     |
| ------------------ | ------------------------------------------------------------------------- |
| `shared/`          | the Zod RPC contracts and the two settings documents                      |
| `client/board/`    | the surface, the switcher, the chips, the pickers, search, orderings, rows |
| `client/detail/`   | the panel, review and merge, comments, Markdown, HTML, images             |
| `client/launch/`   | the send-to-chat dialog and its provider and model pickers                |
| `client/projects/` | the Projects list and one project's board                                 |
| `client/settings/` | the settings screen and the prompt editor                                 |
| `client/lib/`      | pure helpers: search, sort, templates, time, relations                    |
| `client/web.ts`    | the only module allowed to touch browser globals                          |
| `server/github/`   | the `gh` executor, the GraphQL client, rate-limit accounting              |
| `server/board/`    | the search buckets, the relation merge, checks                            |
| `server/items/`    | details, comments, labels, approve and merge                              |
| `server/projects/` | the Projects v2 queries                                                   |
| `server/cache/`    | the one cache: TTL, single-flight, disk persistence                       |

`index.client.tsx` and `index.server.ts` are wiring only: they bind contracts to handlers and
register contributions. No other code module may sit at the root.

## The rules the linter enforces

`npm run lint` runs four zero-dependency Node scripts in `scripts/`, then `oxlint`. They are
deliberately not an ESLint plugin tree: four project rules do not justify hundreds of transitive
packages in a repository whose whole point is that you trust its code.

- **400 code lines per file.** Comment lines are free, on purpose: this codebase documents *why* at
  length and must not be pushed to stop.
- **No duplicated function bodies.** Two functions with identical normalised bodies are one
  function in the wrong place.
- **Import boundaries**, the ones the compiler cannot see: the SDK split above, and browser globals
  confined to `client/web.ts`.
- **Version agreement** between `package.json`, `nix/plugin.nix` and the CHANGELOG heading.

`oxlint` covers the general rules — unused values, `no-explicit-any`, floating promises, complexity.
A disable is acceptable only next to the line it applies to, with a comment saying why the rule is
wrong there.

## Tests

vitest, over the logic that is pure and load-bearing: search parsing and matching, the sort
comparators, prompt templates, the bucket merge, and the cache's TTL, single-flight and persistence.
A test earns its place by failing when a plausible bug is introduced. Do not add a test so that a
change "has tests"; do not assert that a function merely returns.

Anything that needs GitHub is not a unit test. Server handlers take their `gh` executor as an
injected dependency so the network stays out of the suite.

## Style

- Comments explain **why**, in full sentences, and travel with the code they explain. A comment
  restating the code is noise; a comment naming the constraint that made the code look this way is
  the point.
- No `any`, no unchecked casts. Validate at the boundary with Zod, narrow with type guards inside.
- React Native primitives only. Colours from `theme.colors`, spacing from `layout.compact`.
- Commits are Conventional Commits with a bullet body:

```
type(scope): short description    ← 50 characters max, imperative, lowercase

- what changed and why
```

## Releasing

A release is a signed tag. The workflow refuses an unsigned one, checks the tag against
`package.json`, takes the release notes verbatim from the matching `CHANGELOG.md` section, and
publishes a source tarball with `SHA256SUMS` and GitHub build provenance.

```bash
# bump package.json, nix/plugin.nix and the CHANGELOG heading together
git tag -s v0.6.0 -m "v0.6.0"
git push origin v0.6.0
```
