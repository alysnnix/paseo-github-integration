# CLAUDE.md

A Paseo plugin that adds a **GitHub** sidebar surface, id `github-integration`: a switcher between
Pull requests, Issues, Discussions and Projects, fed by a server-side sweep of everything the
signed-in login is attached to — authored, mentioned, assigned, asked to review — plus everything
open under the organisations and users it watches.

`README.md` covers what a user sees and how to install it. `CONTRIBUTING.md` covers the dev loop,
the module layout, the lint rules and the release process. This file covers what neither says:
where to find the code behind a given behaviour, why the code is shaped the way it is, and the
constraints nothing catches at compile time. The plugin used to be a single `server/board.ts` and
`client/board.tsx`, with four side-by-side columns, a dual `author:`/`user:` search and five
hand-rolled caches; all of that is gone, and this file describes only what is here now.

## Orientation

`CONTRIBUTING.md`'s module table says what each directory holds. This is the finer-grained map: if
you are about to touch one of the following, this is where it actually lives.

- The relation sweep and the bucket merge: `server/board/buckets.ts`, dispatched per column from
  `server/board/issues.ts`, `pull-requests.ts` and `discussions.ts`, orchestrated by
  `server/board/handler.ts`.
- Checks on open pull requests: `server/board/checks.ts`, called only from `pull-requests.ts`.
- The generic cache and rate-limit accounting: `server/cache/cache.ts` and
  `server/github/rate-limit.ts`; every feature-specific cache instance (`boardCache`,
  `detailsCache`, `labelsCache`, `projectIndexCache`, …) lives beside the handler that owns it.
- Review and merge: `server/items/review.ts` on the server, `client/detail/review-actions.tsx` and
  `client/detail/merge-dialog.tsx` on the client.
- The mode switcher, relation chips, owner/repository pickers, search and orderings: the hooks
  under `client/board/use-board-*.tsx`, with the pure logic behind search and sort in
  `client/lib/search.ts` and `client/lib/sort.ts`.
- The client's caching: `client/board/use-board-query.tsx` (the board itself),
  `client/board/label-menu.tsx` (a repository's label catalogue) and
  `client/detail/remote-image.tsx` (one image), all `@tanstack/react-query`.
- Prompt templates and their settings screen: `shared/board.ts` (`PromptSetSchema`,
  `COLUMN_IDS`), `shared/settings.ts` (`normalizePrompts` and friends) and
  `client/settings/prompt-settings-view.tsx`.

One naming quirk worth knowing before it looks like a bug: `paseo-plugin.json`'s id is
`github-integration` and the cache directory (`server/cache/paths.ts`) is named for it, but the
daemon-local settings file (`server/settings/settings.ts`) still lives at
`$PASEO_HOME/plugins/github-board/settings.json` — a path frozen from before the repository was
renamed. Renaming it would orphan every installed user's saved login and launch defaults for no
behavioural gain, so it stays `github-board` on purpose.

## Checking a change against reality

`npm test`, `npm run typecheck` and `npm run lint` are described in `CONTRIBUTING.md` and are the
first line of defence; there is no UI harness beyond them, so a `client/` change still needs a
human to open the surface on a wide window *and* a compact one, and to switch theme.

The server half is still checkable on its own without a daemon, but the recipe has to name the
whole module tree `server/board.ts` used to be:

```bash
npx tsc server/github/*.ts server/cache/*.ts server/board/*.ts server/items/*.ts \
  server/launch/*.ts server/projects/*.ts server/images/images.ts server/settings/settings.ts \
  shared/board.ts shared/image-host.ts shared/timeline.ts \
  --module esnext --target es2022 --moduleResolution bundler --outDir /tmp/ghcheck \
  --skipLibCheck --types node --ignoreConfig
# then call loadBoardHandler (or whichever handler changed) from a throwaway .mjs in that
# directory, and delete it after
```

Two things changed since this used to be one file and three. First, almost every server module
still imports `shared/board` as `import type` only, which is what lets that file elide to nothing
at compile time — except `server/board/types.ts`, which imports `RELATION_IDS` as a genuine runtime
value to build `RELATION_ORDER`. That one import means `shared/board.ts` itself has to transpile
and execute for this check to work, not just type-check, which in turn means its own dependency —
`zod` — has to be resolvable from wherever the emitted files run; run the check from the repository
root so `npx` finds it in `node_modules` rather than copying files out on their own. Second, run it
with `PASEO_HOME` pointed at a scratch directory so a throwaway never writes the real
`settings.json`.

`npm test` covers the pure logic this recipe cannot reach at all — the bucket merge, the cache's
TTL and single-flight behaviour, search parsing, the sort comparators, prompt templates — with a
fake `gh` executor standing in for the network. What it does not cover, and what the recipe above
is for, is a change to a GraphQL query's actual shape: a renamed field, a qualifier `gh api graphql`
rejects, a schema `gh` itself has moved past. That still needs a real `gh` subprocess against a
real GitHub account.

## The relation sweep

`shared/board.ts` declares `RELATION_IDS` as `["author", "review-requested", "mentioned",
"assigned", "owned"]`. Every card on the board carries a `relations: Relation[]` array — never
empty, because a card only exists on the board because some search matched it — and that array is
the whole reason a card can belong to someone else's pull request without the board drowning in
strangers' work: the server unions every relationship it can find and the relation chips are a
client-side narrowing of an answer already in hand, never another round trip.

`server/board/buckets.ts` builds the buckets a login's own work can match — `personalBuckets`
pushes `mentions:<login>`, `assignee:<login>` and `author:<login>` always, and
`review-requested:<login>` only where the caller says to, because GitHub's issue search has no such
qualifier and running it anyway would just return nothing for `mentioned`'s sake. `ownedBuckets`
adds one `user:<owner>` bucket per watched owner, every one carrying the `owned` relation — the
odd one out, meaning the item lives under a watched owner with no personal relationship on it at
all, which is the pile the "Other" chip exists to be able to hide.

Each of the three server-side fetches picks its own subset: `fetchPullRequests` asks for every
bucket including `review-requested`; `fetchIssues` asks for every bucket except it, since issues
have no review; `fetchDiscussions` asks for `author` and `owned` only, because GitHub's discussion
search accepts `author:` and `user:` but ignores `mentions:`, `assignee:` and `review-requested:`
entirely. None of this costs one `gh` subprocess per bucket: `runBuckets` aliases every bucket for
one column into a single `gh api graphql` request — the same trick the old `dualSearchQuery`
used for two searches, generalised to however many a column needs — so a refresh is three
guaranteed subprocesses (issues, one combined pull-request search split client-side by `isDraft`,
discussions) plus a fourth, conditional one for checks, not one per relationship.

`mergeBucketResults` (`server/board/buckets.ts`) is the union: every bucket's nodes are folded into
one `Map` keyed by node id, and a node seen by a second bucket gets that bucket's relation appended
to the array already recorded rather than replacing it, deduplicated and sorted to `RELATION_IDS`'s
own order. `toBoardItem` runs before a relation is ever recorded and can return null to drop a node
the caller does not want on the board at all, which is why a rejected node never contributes a
stray relation to anything. The result is sorted by `updatedAt` and cut to `limit` only after every
bucket has been merged in, so a personal item and a watched-owner item compete on equal footing for
the same budget rather than each bucket getting its own.

Every search still goes through `gh api graphql` rather than `gh search`, for the same two reasons
as before: `closingIssuesReferences` — the link from a pull request to the issues it closes, still
requested on every pull request fetch — has no `gh search` field, and aliasing several searches
into one request, which is what keeps the relation sweep at three subprocesses instead of one per
bucket, is a GraphQL feature `gh search` cannot reach.

## Issues folded into their pull requests

An issue claimed by an open pull request is dropped from the Issues view and rendered as an `Issue
#123` pill on the pull request's card instead — one piece of work, one card. The claiming happens
in `client/board/use-board-filters.tsx`'s `filteredColumns` memo, *after* the repository filter, so
a pull request the filter hides stops claiming its issue instead of taking the issue's card off the
board with it. Drafts claim too. `client/lib/formatting.ts`'s `linkedIssueLabel` renders the pill as
`Issue #N` when the issue is in the same repository as the card and `Issue owner/repo#N` when it is
not.

There is no longer an "empty columns come off the board" story to preserve: the columns themselves
are gone. `useBoardFilters` keeps every column, empty or not, because which one is on screen is now
the user's own choice through the mode switcher rather than a layout decision made for them; the
list's own empty state (below) is what used to be four "Nothing here." columns doing the same job.

## Checks on open pull requests

`BoardItem.checks` is still three counts — `passed`, `failed`, `pending` — or null, folded the same
way Paseo's own `getChecksSummaryCounts` folds them, so the board and the sidebar cannot disagree
about a pull request they both show. Skipped and cancelled runs are counted nowhere: neither a
result nor a wait.

It is still its own `gh api graphql` request (`server/board/checks.ts`), not a field on the search,
for the reason the file's own comment states verbatim: a token without the Checks permission
answers `statusCheckRollup` with "Resource not accessible", `gh` treats any GraphQL error as a
failed command, and the rollup lives under the search's own selection — so asking for it there
would blank Draft PRs *and* Open PRs for those users. `attachChecks` swallows a failure to
`console.warn` rather than the caller, because the pull requests themselves already loaded and a
missing pill costs nobody who could not have seen it anyway; the reason is written to the plugin
log rather than dropped silently.

The query is still `nodes(ids: [...])` over the open pull requests only, still capped by GitHub at
100 ids and by the caller's own `limit`, whose ceiling is also 100. Drafts are still skipped
deliberately — a draft's CI is not yet anyone's business, and fewer ids is a smaller request.
`foldChecks` still deduplicates by check name keeping the highest `recency` (preferring
`checkSuite.workflowRun.databaseId`, falling back to `completedAt ?? startedAt`), and
`checkRunOutcome` still folds `STARTUP_FAILURE` to failed and `STALE` to ignored rather than
pending, because a run that will never report again is worse than a disagreement with the sidebar.

The three counts still render as one grouped pill leading the row's trailing group in
`client/board/item-row.tsx`, with the same `✓ ✕ ●` glyphs and the same colour split — danger for
failed, accent for still running, muted for passed — because the glyph carries the meaning where
colour cannot.

## The cache module

One class, `server/cache/cache.ts`'s `Cache<T>`, replaces every hand-rolled module-scope cache the
server used to keep. One instance per feature — `boardCache`, `detailsCache`, `commentsCache`,
`labelsCache`, `projectIndexCache`, `projectsCache`, `projectCache`, a token cache for images — each
keyed by whatever distinguishes its own queries: a login and its watched owners, a node id, an
`owner/name` pair.

Its contract is four methods:

- `get(key, ttl, load, { force?, shouldCache? })` answers from memory when a live entry is younger
  than `ttl` — a parameter of the call, not of the cache, so one class serves a five-minute board
  and a five-minute label catalogue without repeating the constant on the class itself — otherwise
  runs `load()`. Concurrent callers of the same key while a load is in flight share that one
  promise rather than each starting their own sweep; `force` bypasses the memory check entirely,
  which is what the Refresh button asks for. `shouldCache` lets a caller refuse to remember a bad
  answer — `loadBoardHandler` refuses to cache any board where a column carries an error, so a
  transient failure is retried on the next call rather than pinned on screen for the whole window.
- `set(key, value)` stores a value the caller already has, bypassing `load` — a mutation's own
  response, written straight in.
- `invalidate(key)` drops one entry outright, so the next `get` for that exact key reloads
  regardless of age. Nothing in this codebase calls it in production; every write instead reaches
  for `set` (a genuine read-after-write, when the caller knows exactly which key changed and what
  the fresh value is) or `patchAll` (below, when it does not).
- `patchAll(updater)` rewrites every currently cached entry across every key, preserving each
  entry's original `storedAt` — a patch never resets the TTL clock. This is for a write whose
  effect is scattered across cache keys the caller cannot enumerate: a label toggle or a merge might
  affect a board cached under any login/owner combination that happened to include that card, and
  there is no key to `set` for "every board that has this item in it". `patchCachedLabels` and
  `dropCachedItem` (`server/board/cache.ts`) both wrap `boardCache.patchAll`, called from
  `toggleLabelHandler` and `mergeHandler` respectively.

Persistence is one JSON file per cache instance, under `cacheDataDir()`
(`server/cache/paths.ts`) — `$XDG_STATE_HOME` or `~/.local/state`, joined with
`paseo-github-integration/cache/<name>.json`, chosen because `PluginHandlerContext` exposes nothing
that names a per-plugin data directory. A reload or a daemon restart hydrates from that file lazily,
once, so the plugin resumes from the last answer instead of re-sweeping GitHub cold. Because the
whole in-memory map round-trips through `JSON.stringify`, a cached value has to be plain
JSON-safe data — which is why `ProjectIndex.byRepositoryId` (`server/launch/project-index.ts`) is a
plain object rather than a `Map`: a `Map` would come back from disk as `{}`.

When you add a write that changes something a cache remembers, ask which of the two you need: `set`
if you can name the one key that changed and you have the fresh value in hand (the pattern
`refreshDetails` uses after approving or merging — it re-fetches the item and calls
`detailsCache.set`), `patchAll` if the write's effect could be sitting under any key and you only
know how to transform a cached value in place, not which cached values exist.

## The rate limit

Every GraphQL request this plugin makes has `rateLimit { cost remaining limit resetAt }` textually
inserted as a sibling of the operation's own selection (`injectRateLimit`,
`server/github/rate-limit.ts`, which skips past any leading `fragment` blocks to find the right
brace). The reading is recorded after every call and checked before the next one: `assertBudget`
refuses to run a further `gh api graphql` call once the last known `remaining` drops below the
100-point floor, with the message

> GitHub's GraphQL budget is at `${remaining}` points, below the 100-point floor this plugin keeps
> in reserve. It resets at `${resetAt}`.

rather than spending the last of the budget on a request that risks tripping GitHub's own limit
mid-flight and losing whatever partial answer it would otherwise have given back. `currentRateLimit`
exposes the last reading for a caller that wants to surface it, but nothing calls it today — the
only visible trace of the budget right now is the daemon's own `console.log` per request. Wiring it
into `board.load`'s response and the surface header is un-started work, not a decision against it.

## The client's react-query cache

`@tanstack/react-query`, a module the host supplies, replaces every module-scope cache the client
used to keep. There is exactly one left at module scope in `client/board/`:
`legacyMigrationAttempted`, a one-shot boolean guard for the settings migration (below), which holds
no board or label data and would gain nothing from a query cache.

The board itself is `client/board/use-board-query.tsx`'s `useQuery`, keyed by `boardQueryKey(login,
owners)` — `["board", login ?? null, [...owners].sort()]`, sorted so widening or narrowing the
watched owners in a different order never reads as a different board — with `staleTime:
STALE_AFTER_MS` (five minutes, `client/board/constants.ts`) and `placeholderData: keepPreviousData`.
That last option is what the hand-written cache used to do by simply never changing identity: the
previous key's board stays on screen while a new key's fetch is in flight, rather than the list
flashing empty. A remount within the stale window renders the cached answer immediately with no
refetch; widening the sweep, narrowing it, or switching the resolved login is simply a different
key, which the query client fetches on its own with no hand-written comparison to keep in sync.

The label menu's per-repository catalogue (`client/board/label-menu.tsx`) is a second `useQuery`,
keyed by `["repository-labels", item.repository]` with the same `STALE_AFTER_MS`, explicitly
replacing the old module-scope `cachedRepositoryLabels` map — "the query client's cache outlives
this component the same way the module-scope cache it replaces did," per the file's own comment,
because the surface still unmounts on every workspace switch and the cache still must not. One
image (`client/detail/remote-image.tsx`) is a third, keyed by `["image", url]` with `staleTime:
Infinity` — an image never goes stale on its own, so nothing needed the fixed 24-entry cap the old
client cache enforced by hand; react-query's own garbage collection evicts what nothing still
references.

A mutation that already knows its outcome patches the board's cached data directly rather than
triggering a refetch: `mutateBoardCache` (returned by `useBoardQuery`, consumed by
`use-board-overlays.tsx`) wraps `queryClient.setQueryData(boardQueryKey(...), updater)` and is the
only thing in the codebase that is allowed to know the query key — every caller only ever describes
*how* the board changes. `applyItemLabels` patches one card's `labels` after a toggle; `dropItem`
filters a merged card out of every column after a merge. Neither calls `invalidateQueries`: the
server already told the client exactly what changed, and asking again would be strictly worse than
using the answer already in hand.

## The detail panel

A press on a card still opens it in a panel over the board rather than the browser. The panel is
now `client/detail/detail-panel.tsx`, composing `detail-header.tsx` (the chrome — repository, state
pill, Reload, Close), `detail-body.tsx` (the static summary and description), `detail-comments.tsx`
plus `use-item-comments.tsx` (the conversation, on request), `use-detail-resize.tsx` (the drag) and
`detail-actions-row.tsx` (Approve, Merge, Send to chat, Open on GitHub) — a file split with no
behaviour change from what one file used to do.

**The body is still a separate `board.item` call, not a field on the search**, looked up by
`node(id:)` so one query serves an issue, a pull request or a discussion with inline fragments
deciding which fields come back, cached for five minutes by id (`detailsCache`,
`server/items/details.ts`) with `force` from the panel's Refresh bypassing it. `state` is still
derived rather than copied — `MERGED`/`CLOSED` from GitHub's `state`, a discussion's from `closed`,
a draft from `draft` rather than `open` — so the panel is the first place a card that has since
closed says so, since the board itself only ever lists open items.

**The panel is still positioned inside the body, not the screen**, painting over the columns by
order alone and leaving the header reachable while it is open. On the wide layout it is still the
right half over a blurred, scrimmed board (`detailScrim`, a wash toward `surface0` plus a
`backdropFilter` blur the native renderer has no library for and simply skips); a press on the scrim
still closes the panel, and the open card still keeps its accent border so the panel reads as
that card's through the blur. On compact it is still the whole body with no scrim, and Close is the
way back.

**Opening and closing still animate on one `Animated.Value`**, threaded into `use-detail-resize.tsx`
as `progress` and interpolated for both the scrim's opacity and the panel's `translateX` — 220ms
ease-out to open, 160ms ease-in to close, with the target cleared only when a *finished* animation
says the close completed, so an interrupted close reopened mid-slide finds the panel where it left
it. **The wide panel is still resizable** by a `PanResponder` anchored to its left edge, refusing
`onPanResponderTerminationRequest` so a drag that crosses the board's own scroll views is not handed
away mid-gesture, and still tracked past the handle on web through `trackPointerOnDocument`
(`client/web.ts`) for document-level `pointermove`/`pointerup` and a window `blur` standing in for a
release the browser cannot otherwise report.

The chosen width is still committed once, on release, as a share of the body rather than pixels —
`onWidthCommitted` (wired to `commitWidth` in `client/board/use-board-settings.tsx`) writes
`detailWidthFraction` into the `displaySettings` document, and the panel adopts a share saved
elsewhere only when no drag is in flight, so an external update never yanks the edge out from under
a pointer mid-drag.

## Approve and merge

New since the four-column board: a pull request can be approved and merged from the same panel that
already showed it, without leaving for GitHub.

`ReviewState` (`shared/board.ts`), attached to `ItemDetails.review`, is computed entirely on the
server (`toReviewState`, `server/items/details.ts`) so the buttons and the mutations they trigger
can never disagree about what is allowed. `viewerHasApproved` reads the viewer's own *latest*
review rather than `reviewDecision`, which GitHub leaves null on any repository that requires no
review however many approvals a pull request already has — a button keyed on `reviewDecision` would
still read "Approve" right after approving. `viewerCanApprove` is `!viewerDidAuthor && !settled`,
because GitHub refuses an approval on your own work and a merged or closed pull request has nothing
left to approve. `viewerCanMerge` needs write access (`ADMIN`/`MAINTAIN`/`WRITE`), the pull request
open, `mergeable === "mergeable"` (GitHub answers `UNKNOWN` for a few seconds after a push while it
computes the test merge — a "not yet," not a conflict, and merge stays off for both), and at least
one method the repository allows.

`client/detail/review-actions.tsx`'s `approveLabel`/`mergeLabel` turn that state into the button's
own text rather than disabling it silently: **Approved**, **Your pull request**, **Draft**,
**Conflicts**, **Checking...**, **No merge access**, or **No method allowed** each name the reason a
press would fail, so the panel answers the question before it is asked. Merge opens
`client/detail/merge-dialog.tsx` — the host's `Modal`, the same component the send dialog uses —
which is confirmation and method picker in one: one button per method the repository allows, in the
order squash, merge, rebase, and the press that picks a method is the press that merges, because
there is nothing left to confirm twice.

The two mutations (`server/items/review.ts`) are `addPullRequestReview(event: APPROVE)` and
`mergePullRequest(mergeMethod: ...)`; both then call `refreshDetails`, which re-fetches the item
past the cache and `detailsCache.set`s the fresh answer, so the panel repaints from what GitHub
reports after the write rather than from what the client assumed going in. A successful merge
additionally calls `dropCachedItem` (`server/board/cache.ts`), because the board's own search is
`state:open` and a merged pull request no longer matches it — leaving it cached would show it as
open again for up to five minutes. On the client, `use-item-actions.tsx`'s `runApprove`/`runMerge`
patch the open panel from the RPC's own response (`onDetailsChanged`) and, for a merge, call
`onMerged` — wired to `dropItem` (`use-board-overlays.tsx`) — which patches the react-query board
cache directly the same way a label toggle does, rather than waiting on a refetch.

## Comments

Comments are still a third call, `board.comments`, and still only on request — a button at the foot
of the panel, because most panels are opened for the description and the conversation is an item's
long tail. Still capped at 50 comments and 20 replies (`COMMENTS_PAGE`/`REPLIES_PAGE`,
`server/items/comments.ts`), with `truncated` pointing the panel at GitHub for the rest rather than
paging, and discussion replies still flattened one level deep so the panel can indent them. Still
cached for five minutes by id — now `commentsCache`, an instance of the generic `Cache<T>` rather
than a bespoke map — with the panel's Refresh re-requesting with `force` only once a request has
actually been made.

## Images

Images on their own line are still rendered, and GitHub-hosted ones — `github.com` and
`*.githubusercontent.com`, decided by `isGitHubImageHost` (`shared/image-host.ts`) and checked
independently on both sides of the wire — still come through the daemon via `board.image`, because
an attachment on a private repository answers 404 without the `gh` token and the app never holds
one. `Image.getSize`'s callback form is still used to measure before painting, so the frame is sized
by `aspectRatio` before the bitmap arrives, capped at 480pt tall
(`detail.styles.ts`'s `imageFrame.maxHeight`).

The cache split in two along the same line the rest of the caching did. On the client,
`remote-image.tsx` is a react-query entry (`["image", url]`, `staleTime: Infinity`, above) — no more
fixed 24-entry client cap. On the server, `server/images/images.ts` deliberately keeps its own
hand-rolled `Map`, still bounded at 24 entries evicted oldest-first, rather than routing through the
generic `Cache<T>`: each entry is a whole decoded image rather than something with a meaningful
staleness window, so the TTL half of the generic cache's contract would buy nothing here. The `gh
auth token` itself, by contrast, *is* TTL-shaped and does go through the generic cache, for five
minutes.

## Markdown and HTML rendering

`client/detail/markdown.tsx` and `client/detail/html.tsx` are unchanged in behaviour from what one
file used to describe. HTML is still rewritten into Markdown before parsing, not parsed alongside
it — `html.tsx`'s `htmlToMarkdown` walks a comment's or body's tags with a small stack and emits
each one's Markdown spelling, still motivated by Dependabot's HTML-only bodies. `<details>` and
`<summary>` are still the one thing emitted back as literal tags, because Markdown has no spelling
for them, and `parseMarkdown` still collects up to the matching `</details>` and parses the inside
recursively; `DetailsBlock` still starts collapsed unless the source said `open`. `newline()` is
still idempotent, so a tag-implied line break stacked on the source's own newline cannot manufacture
a blank line that would end a list early. Inline tokens are still `.split(...).map(...)`, never
looped, because a closure made in a loop body captures the final binding under Hermes. Pipe tables
still render an image-only cell through `renderImage` rather than as text, which is how a
screenshot comparison table renders as a table of screenshots.

## Editing labels from a card

Right-click (long-press on touch) a card and its repository's labels still open as a menu at the
pointer, each row a toggle, discussions still excluded. Each press is still one `board.toggle-label`
call applied immediately and answered by the mutation's own response — `addLabelsToLabelable` /
`removeLabelsFromLabelable` return the labelable's new label set, so there is still no
read-after-write and a label someone else added meanwhile still lands on the card rather than being
silently overwritten. The row still waits for that answer rather than moving optimistically, still
dimmed while it does, and a failure still shows *inside* the menu, which stays open. `board.labels`
still lists the first 100 labels and still caches them for five minutes — now via react-query on the
client (above) and the generic `Cache<T>` on the server (`labelsCache`, `server/items/labels.ts`).

Two things this menu did not have before: it now filters its own catalogue with a small search box,
shown only once a repository has more than eight labels — a repository with six needs no filter
between the pointer and the label it came for — and `patchCachedLabels`/`dropCachedItem`
(`server/board/cache.ts`) express the server-side patch through `Cache.patchAll` rather than a
bespoke mutation of a module-scope object, though the effect on the running plugin is identical to
before: a label edited now is not undone by the next cache hit.

### Opening at the pointer

Unchanged: `onContextMenu` still lives on the `Pressable` behind a `@ts-expect-error`, since React
Native's types do not know it; long press is still native-only, since a browser's long press is
already a held left click that right-click covers. The surface still measures itself with
`measureInWindow` in the callback, per open, and still clamps the menu to open right-and-down from
the pointer unless that would run off an edge, hanging it from `bottom` when it opens upward so its
foot tracks the pointer. Android's `pageY` still excludes the status bar that the measured window
includes, corrected the same way Paseo's own `ContextMenuTrigger` corrects it. The menu's scrim is
still transparent and still carries an explicit **Close** row, because a plugin surface receives no
key events to fall back an Escape onto.

## Send to chat

Every card still carries a **Send to chat** button, bottom-right, revealed on hover, opening
`client/launch/send-dialog.tsx` narrowed to one card. `board.send-options` still finds the project
and its launch defaults; `usePaseo().providers.snapshot({ cwd })` on the client still supplies
providers, models, thinking options and permission modes, mirroring the same catalogue Paseo's own
composer renders rather than freezing a copy of it. A provider with no selectable model is still
dropped rather than shown, since `paseo.agents.create` cannot start one without a model to name.

### The dialog

Still the host's `Modal` — a bottom sheet on compact, a centred dialog otherwise — with dismissal
answered per case in `requestClose`:

| State | A backdrop press, Escape, back action or swipe does |
| --- | --- |
| A popover is open | Closes the popover |
| A send is in flight | Nothing; it is not interruptible |
| The prompt has been edited | Nothing, and a toast points at Cancel |
| The prompt is untouched | Closes the dialog |

### The popovers

Still anchored to their row rather than their chip, still opening in the direction (up or down) that
keeps them inside the card rather than off its edge, still using the host's own sheet-aware
scrollers so they share the sheet's gestures instead of competing with it on Android. The model
popover is still two steps — providers, then one provider's models behind a back arrow — skipping
the provider step when there is only one provider or one already chosen, and its search still
reaches across every provider from the top step and stays inside one from the model step.

### Creating the workspace and the agent

Still `workspace.create` with a worktree or a directory source and no `worktreeSlug`, the agent then
created through the workspace handle so it lands on the worktree's own path, with `prompt` riding
along as `initialPrompt` rather than sent afterwards, so there is no window where the workspace
holds a silent agent.

### The timeline row

Still a persisted `type: "plugin"` row (`shared/timeline.ts`'s `BOARD_ITEM_TIMELINE_KIND`/
`BOARD_ITEM_TIMELINE_VERSION`), appended after the agent exists, its failure still swallowed to a
`console.warn` because the send itself already succeeded by that point. `client/timeline.tsx`'s
`BoardTimelineCard` still renders it, validated at the boundary by `BoardTimelineItemSchema`, and a
row that fails validation still renders as nothing rather than throwing.

### Selecting the new workspace

Still `props.navigation.openAgent({ agentId })`, run in the client bundle because the server half
lives beside the daemon, which on a remote host is a different machine from the one the user is
looking at. The plugin now requires Paseo `>=0.8.0` outright, so the pre-navigation-prop fallback
this section used to describe is gone: every client that can run this bundle at all received the
`navigation` prop with it.

## The compact layout and the keyboard

There is no longer a "different layout, not the same one narrowed" story to tell about columns,
because the columns are gone: `client/board/github-board.tsx` renders one mode switcher and one
`FlatList` on both compact and wide, differing only in a handful of specific places. Compact hides
the Refresh button and the "GitHub" title (the surface chrome already names the plugin) and pulls to
refresh with a `RefreshControl` instead; wide keeps both, plus the "Updated …" timestamp that
compact also still shows since nothing else there says how old the board is. The mode switcher
itself — `pull-requests`/`issues`/`discussions`/`projects` — is the same component in both layouts
and carries no per-mode counts (only the relation chips do); it is not persisted anywhere, module
scope or settings, so a remount always reopens on **Pull requests**, deliberately, the way a
browser tab resets.

The launch dialog's prompt field is still the SDK's own `TextInput`, which raises the form for the
keyboard rather than covering it, and the settings view's `ScrollView` still uses
`automaticallyAdjustKeyboardInsets` to the same end. Opening any picker still calls
`Keyboard.dismiss()` first, since the popovers are sized to a card whose own size the keyboard has
already shrunk.

## Prompts, and the settings view

The prompt templates are still keyed by the four *historical* column ids — `issues`, `draft-prs`,
`open-prs`, `discussions` (`COLUMN_IDS`, `shared/board.ts`) — independently of the switcher's own
four modes (`pull-requests`/`issues`/`discussions`/`projects`, `client/lib/board-modes.ts`). This is
deliberate, not a leftover: a card's type still decides which template it opens with regardless of
which switcher tab the user happened to be on when they sent it, and the switcher's own modes being
renamed since did not touch what the send dialog actually keys its templates on. Do not
"fix" `PROMPT_TYPES` in `client/settings/prompt-settings-view.tsx` to match `BOARD_MODES` — they
answer different questions.

Blank still means inherit at both levels — a blank `byType` entry reads as the built-in default, a
blank project override is dropped entirely — normalised at the save boundary by `normalizePrompts`
rather than on read, so a draft mid-edit can hold a blank field without the saved document reading
it as cleared before Save is pressed. Overrides are still keyed by Paseo project id rather than
repository, because a card that reaches no project cannot be sent anywhere and a fork's origin and
upstream are two repositories but one project. The editor still has two doors and one
implementation — the board's own gear, and `client/settings/settings-screen.tsx` under Settings →
Plugins — both bound to the same `promptSettings` document, so they cannot disagree or silently
clobber each other; a save against a revision the other has moved past fails and reports rather than
winning.

New since the four-column board: `displaySettings.watchedOwners` is what the relation sweep sweeps
beyond the viewer's own buckets, edited from `BoardSettingsScreen`'s own section rather than the
prompt editor, and it is a different thing from the owner *filter* in the board's own filter bar —
the filter only hides owners from the current view among what was already swept, is not persisted,
and resets every session, where `watchedOwners` decides what gets fetched at all and is saved.

## Settings and caching

Two stores, split the same way the root rule describes: read-only settings the client needs to
paint go through the host's own store (`shared/settings.ts`'s `displaySettings` and
`promptSettings`), and values only a handler acts on stay in the daemon's own file
(`server/settings/settings.ts`).

| Where | What | Why there |
| --- | --- | --- |
| Host settings store, `shared/settings.ts` | `hiddenRepositories`, `detailWidthFraction`, `watchedOwners`, `relation`, `sort` (`display`); the prompt templates (`prompts`) | Read only to draw the board. `useSettings` puts them on the client with no round trip, and the host pushes an edit to every connected client. |
| `$PASEO_HOME/plugins/github-board/settings.json` | `login`, the `launch` defaults | Handlers act on them: `gh` runs every query as that login, and `board.send-options` answers with those defaults. A settings document is readable from the client only. |

`relation` and `sort` are strings rather than enums for the same reason `hiddenRepositories` always
was: a document saved by a newer build must still parse on an older one, and an id this build does
not recognise falls back to a safe default on read rather than failing to parse at all.

### Migrating the pre-0.4.0 file

Unchanged: the daemon still cannot write a settings document itself, so the three values that moved
out of its own file are still handed across as a round trip —

```text
board.legacy-settings       → daemon reads its file, returns the old values (writes nothing)
                            → app writes them into the two settings documents
board.legacy-settings-taken → daemon stamps `settingsMigratedAt`, drops the old keys
```

— and the same three properties still make it safe: the daemon's copy is the fallback until the app
acknowledges, so an interrupted migration is retried rather than lost; `updateSettings` still writes
the legacy block back verbatim while it exists, so a login change made before migration cannot
destroy the values about to be taken; and each document is still written only if it is still
untouched (`hiddenRepositories` empty, `detailWidthFraction` null, `isDefaultPrompts(...)` true), so
someone who customised their prompts on 0.4.0 before an older client got round to migrating keeps
what they customised rather than having it overwritten by the older values. The client guard is
still `legacyMigrationAttempted` at module scope (`client/board/use-board-settings.tsx`), since the
surface still remounts on every workspace switch and a second attempt in one session could only ever
be a wasted round trip.

A plugin surface still unmounts on every workspace switch, which is the whole reason any of this
caching exists: the react-query board cache and the label/image query caches are what let a
remount repaint instantly instead of re-asking GitHub, and the server's own `Cache<T>` instances are
what let a *cold* client — a fresh reload, a different device, a daemon restart — skip the `gh`
calls too. `force` on `board.load` is still the Refresh button asking both layers to bypass
themselves at once. Whatever should outlive an unmount and is not shaped like a cache belongs in one
of the two settings stores instead — that is the only other thing here that survives one.
