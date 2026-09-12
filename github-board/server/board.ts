import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { z } from "zod";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type {
  BoardColumn,
  BoardItem,
  CheckSummary,
  ItemComment,
  ItemDetails,
  MergeMethod,
  ProjectItem,
  ProjectSummary,
  Relation,
  RepositoryLabel,
  ReviewState,
  LaunchDefaults,
  LinkedIssue,
  PromptSet,
  PromptSettings,
  approvePullRequest,
  legacySettingsTaken,
  listLabels,
  listProjects,
  loadBoard,
  loadComments,
  loadImage,
  loadItem,
  loadProject,
  mergePullRequest,
  saveLogin,
  sendOptions,
  sendToChat,
  takeLegacySettings,
  toggleLabel,
} from "../shared/board";
// A value import: relation order is read at runtime to sort each item's
// `relations`, not just referenced in a type position like the rest above.
import { RELATION_IDS } from "../shared/board";
import { isGitHubImageHost } from "../shared/image-host";
// A value import, unlike everything taken from `../shared/board`: the row this
// module writes has to carry the same key the client renderer registers, and
// `shared/timeline` imports nothing, so the standalone transpile still runs.
import { BOARD_ITEM_TIMELINE_KIND, BOARD_ITEM_TIMELINE_VERSION } from "../shared/timeline";

const execFileAsync = promisify(execFile);

/** gh search caps out well under this; the ceiling only guards a runaway page. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

function paseoHome(): string {
  return process.env.PASEO_HOME ?? join(homedir(), ".paseo");
}

function settingsPath(): string {
  return join(paseoHome(), "plugins", "github-board", "settings.json");
}

/**
 * What the launch dialog opens on before the user touches it. Written by the
 * send itself, so the second card starts where the first one finished.
 *
 * Nothing here is authoritative: the dialog validates every field against the
 * host's live provider snapshot and drops what no longer exists, which is why
 * the whole record is nullable rather than seeded with a guess.
 */
const EMPTY_LAUNCH: LaunchDefaults = {
  provider: null,
  model: null,
  modeId: null,
  thinkingOptionId: null,
  isolation: "local",
};

/**
 * The four column ids, as a *historical* constant rather than an import of
 * `COLUMN_IDS`. Everything this module takes from `shared/board` is an
 * `import type` so the server half still transpiles and runs standalone (see
 * CLAUDE.md), and this reads a file format frozen by what older versions wrote
 * — so it should not track a schema that may yet gain a column.
 */
const LEGACY_PROMPT_KEYS: readonly (keyof PromptSet)[] = [
  "issues",
  "draft-prs",
  "open-prs",
  "discussions",
];

/**
 * The three values this file used to own and no longer does, as a version
 * before 0.4.0 wrote them. Held only until the app has copied them into the
 * host settings store, because the daemon cannot write there itself — see
 * `takeLegacySettingsHandler`.
 */
interface LegacySettings {
  hiddenRepositories: string[] | null;
  prompts: PromptSettings | null;
  detailWidthFraction: number | null;
}

/**
 * What the *daemon* keeps, which since 0.4.0 is only what its own handlers act
 * on. The repository filter, the prompt templates and the detail panel's width
 * moved to the host settings store, where the app reads them directly — see
 * `shared/settings.ts`.
 */
interface Settings {
  /** Null until the user pins one; the caller falls back to the gh viewer. */
  login: string | null;
  launch: LaunchDefaults;
  /**
   * Non-null only on a file written before the move, and only until the app
   * acknowledges having taken them. Every write puts them back untouched, so a
   * login change made before the app ever loads the board cannot drop them.
   */
  legacy: LegacySettings | null;
}

const EMPTY_SETTINGS: Settings = {
  login: null,
  launch: { ...EMPTY_LAUNCH },
  legacy: null,
};

/** A share of the body, or null for anything that is not one. */
function readFraction(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1
    ? value
    : null;
}

/**
 * The old `prompts` blob, structurally. Deliberately loose: this reads a file
 * written by an older version, so anything unrecognisable is dropped rather
 * than failing the migration for the keys that are fine.
 */
function readLegacyPrompts(value: unknown): PromptSettings | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as { byType?: unknown; byProject?: unknown };
  const byTypeRaw = typeof raw.byType === "object" && raw.byType !== null ? raw.byType : {};
  const byType: Partial<PromptSet> = {};
  for (const key of LEGACY_PROMPT_KEYS) {
    const template = asString((byTypeRaw as Record<string, unknown>)[key]);
    if (template !== null) byType[key] = template;
  }

  const byProjectRaw =
    typeof raw.byProject === "object" && raw.byProject !== null ? raw.byProject : {};
  const byProject: PromptSettings["byProject"] = {};
  for (const [projectId, overrides] of Object.entries(byProjectRaw as Record<string, unknown>)) {
    if (typeof overrides !== "object" || overrides === null) continue;
    const kept: Partial<PromptSet> = {};
    for (const key of LEGACY_PROMPT_KEYS) {
      const template = asString((overrides as Record<string, unknown>)[key]);
      if (template !== null) kept[key] = template;
    }
    if (Object.keys(kept).length > 0) byProject[projectId] = kept;
  }

  if (Object.keys(byType).length === 0 && Object.keys(byProject).length === 0) return null;
  // `byType` is completed against the defaults by the client, which owns them.
  return { byType: byType as PromptSet, byProject };
}

/**
 * The legacy block, or null when there is nothing to hand over: a file already
 * stamped `settingsMigratedAt`, a fresh install, or a file whose old keys are
 * all absent or unreadable.
 */
function readLegacy(parsed: Record<string, unknown>): LegacySettings | null {
  if (asString(parsed.settingsMigratedAt) !== null) return null;
  const hiddenRepositories = Array.isArray(parsed.hiddenRepositories)
    ? parsed.hiddenRepositories.filter((entry): entry is string => typeof entry === "string")
    : null;
  const prompts = readLegacyPrompts(parsed.prompts);
  const detailWidthFraction = readFraction(parsed.detailWidthFraction);
  if (hiddenRepositories === null && prompts === null && detailWidthFraction === null) return null;
  return { hiddenRepositories, prompts, detailWidthFraction };
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * Reads back a saved launch selection, defaulting every field it cannot make
 * sense of. A settings file written by an older version of this plugin has no
 * `launch` key at all, which is the same case as a blank one.
 */
function readLaunch(value: unknown): LaunchDefaults {
  const raw = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  return {
    provider: asString(raw.provider),
    model: asString(raw.model),
    modeId: asString(raw.modeId),
    thinkingOptionId: asString(raw.thinkingOptionId),
    isolation: raw.isolation === "worktree" ? "worktree" : "local",
  };
}

async function readSettings(): Promise<Settings> {
  try {
    const parsed: unknown = JSON.parse(await readFile(settingsPath(), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return EMPTY_SETTINGS;
    const record = parsed as Record<string, unknown>;
    const login = record.login;
    return {
      login: typeof login === "string" && login.trim() !== "" ? login.trim() : null,
      launch: readLaunch(record.launch),
      legacy: readLegacy(record),
    };
  } catch {
    // No settings yet, or a file we can no longer parse. Either way the caller
    // falls back to the authenticated viewer, which always resolves.
    return EMPTY_SETTINGS;
  }
}

/**
 * Read-modify-write, because the login and the launch defaults are saved by
 * separate handlers and a whole-file write from either would drop the other.
 *
 * The legacy block is written back verbatim while it exists, so a login change
 * made before the app has migrated cannot destroy the values it is about to
 * take. Once it is gone the file is stamped instead, which is what makes
 * `readLegacy` return null forever after.
 */
async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await readSettings()), ...patch };
  const { legacy, ...owned } = next;
  const serialized =
    legacy === null
      ? { ...owned, settingsMigratedAt: new Date().toISOString() }
      : {
          ...owned,
          ...(legacy.hiddenRepositories === null
            ? {}
            : { hiddenRepositories: legacy.hiddenRepositories }),
          ...(legacy.prompts === null ? {} : { prompts: legacy.prompts }),
          ...(legacy.detailWidthFraction === null
            ? {}
            : { detailWidthFraction: legacy.detailWidthFraction }),
        };
  const path = settingsPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(serialized, null, 2)}\n`, "utf8");
  return next;
}

function describeGhFailure(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    if ((error as { code?: unknown }).code === "ENOENT") {
      return "GitHub CLI (gh) is not installed or not on the daemon's PATH.";
    }
  }
  const stderr =
    typeof error === "object" && error !== null && "stderr" in error
      ? String((error as { stderr?: unknown }).stderr ?? "").trim()
      : "";
  if (stderr.includes("gh auth login") || stderr.toLowerCase().includes("authentication")) {
    return "GitHub CLI is not authenticated. Run `gh auth login` on the daemon machine.";
  }
  if (stderr !== "") return stderr;
  return error instanceof Error ? error.message : String(error);
}

async function gh(args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("gh", [...args], { maxBuffer: MAX_OUTPUT_BYTES });
    return stdout;
  } catch (error) {
    throw new Error(describeGhFailure(error));
  }
}

/**
 * `@me` resolves differently per search type and is opaque in the UI, so every
 * query runs against a concrete login instead.
 */
async function resolveViewerLogin(): Promise<string> {
  const raw = await gh(["api", "graphql", "-f", "query={ viewer { login } }"]);
  const parsed: unknown = JSON.parse(raw);
  const login = (parsed as { data?: { viewer?: { login?: unknown } } }).data?.viewer?.login;
  if (typeof login !== "string" || login === "") {
    throw new Error("GitHub did not return a login for the authenticated account.");
  }
  return login;
}

interface GhSearchNode {
  id?: unknown;
  number?: unknown;
  title?: unknown;
  url?: unknown;
  updatedAt?: unknown;
  author?: { login?: unknown };
  comments?: { totalCount?: unknown };
  labels?: { nodes?: unknown };
  repository?: { nameWithOwner?: unknown; isArchived?: unknown };
}

function toItem(node: GhSearchNode, detail: string | null): BoardItem {
  const labels = labelNodeNames(node.labels?.nodes);
  const comments = node.comments?.totalCount;
  const repository =
    typeof node.repository?.nameWithOwner === "string" ? node.repository.nameWithOwner : "";
  const ownerSeparator = repository.indexOf("/");
  return {
    id: typeof node.id === "string" ? node.id : String(node.url),
    number: typeof node.number === "number" ? node.number : 0,
    title: typeof node.title === "string" ? node.title : "",
    url: typeof node.url === "string" ? node.url : "",
    repository,
    updatedAt: typeof node.updatedAt === "string" ? node.updatedAt : "",
    commentsCount: typeof comments === "number" ? comments : 0,
    labels,
    // Null rather than empty for a deleted account, which GitHub returns as no
    // author at all; the card shows nothing instead of an authorless byline.
    author: typeof node.author?.login === "string" ? node.author.login : null,
    detail,
    // The owner half of `repository`, for the owner filter.
    owner: ownerSeparator === -1 ? repository : repository.slice(0, ownerSeparator),
    // Overwritten by `mergeBucketResults` the moment the item is first added;
    // never observed empty because an item only exists here as a search hit.
    relations: [],
    // Only pull requests link issues; every other caller keeps the empty list.
    linkedIssues: [],
    // Filled for open pull requests only, by fetchChecks; see attachChecks.
    checks: null,
  };
}

/**
 * An archived repository is read-only, so its open issues and pull requests can
 * never be closed and sit on the board forever. The qualifier filters them out
 * server-side; discussions have no such qualifier and are filtered on the
 * response.
 */
const UNARCHIVED_ONLY = "archived:false";

/** GraphQL aliases cannot contain a hyphen, so relation buckets get plain numeric names. */
function aliasName(index: number): string {
  return `b${index}`;
}

/** One relation the viewer can have to an item, and the search qualifier that finds it. */
interface RelationBucket {
  relation: Relation;
  qualifier: string;
}

/**
 * The relation buckets GitHub search can answer for a login directly.
 * `review-requested` is pull requests only — issues have no such qualifier —
 * so it is left off entirely rather than run and always come back empty.
 */
function personalBuckets(login: string, includeReviewRequested: boolean): RelationBucket[] {
  const buckets: RelationBucket[] = [];
  if (includeReviewRequested) {
    buckets.push({ relation: "review-requested", qualifier: `review-requested:${login}` });
  }
  buckets.push({ relation: "mentioned", qualifier: `mentions:${login}` });
  buckets.push({ relation: "assigned", qualifier: `assignee:${login}` });
  buckets.push({ relation: "author", qualifier: `author:${login}` });
  return buckets;
}

/**
 * One bucket per watched owner, each carrying the `owned` relation. An owner
 * can hold thousands of open items, so every bucket is truncated at `limit`
 * the same as a personal one rather than fetched in full.
 */
function ownedBuckets(owners: readonly string[]): RelationBucket[] {
  return owners.map((owner) => ({ relation: "owned", qualifier: `user:${owner}` }));
}

function nodesOf(result: unknown): unknown[] {
  const nodes = (result as { nodes?: unknown } | undefined)?.nodes;
  return Array.isArray(nodes) ? nodes : [];
}

interface GraphqlError {
  type?: string;
  path?: unknown[];
  message: string;
}

interface GraphqlResult {
  /**
   * Null only when every field GitHub tried to run failed before execution
   * even started, e.g. a scope the token lacks — see `needsProjectScope`.
   * A per-field runtime failure (a deleted owner) still comes back with
   * `data`, just missing that one field.
   */
  data: Record<string, unknown> | null;
  errors: GraphqlError[];
}

function toGraphqlResult(parsed: unknown): GraphqlResult {
  if (typeof parsed !== "object" || parsed === null) return { data: null, errors: [] };
  // The response envelope: only these two top keys are asserted here, whatever
  // they hold is narrowed field by field below.
  const { data, errors }: { data?: unknown; errors?: unknown } = parsed;
  // GraphQL data keys are the request's own aliases, never known ahead of time.
  const record = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : null;
  // Just proved to be an array; each entry's own fields are read via typeof below.
  const list = Array.isArray(errors) ? (errors as GraphqlError[]) : [];
  return { data: record, errors: list };
}

/** `execFile`'s promisified rejection carries the process's stdout here, same as its stderr. */
function readErrorStdout(error: unknown): string {
  if (typeof error !== "object" || error === null) return "";
  const { stdout }: { stdout?: unknown } = error;
  return typeof stdout === "string" ? stdout : "";
}

/**
 * `gh api graphql` exits non-zero the moment a response carries any `errors`
 * at all, even when every field the caller actually wanted came back fine —
 * so the plain `gh()` helper, which keeps only the failure's message, would
 * throw away a perfectly good answer over one bad owner. This reads the
 * partial body off the failed call instead, and only gives up on the request
 * when GitHub sent no body back at all (an auth or network failure, not a
 * GraphQL one).
 */
async function ghGraphqlRaw(args: readonly string[]): Promise<GraphqlResult> {
  try {
    const { stdout } = await execFileAsync("gh", [...args], { maxBuffer: MAX_OUTPUT_BYTES });
    return toGraphqlResult(JSON.parse(stdout));
  } catch (error) {
    const stdout = readErrorStdout(error);
    if (stdout.trim() === "") throw new Error(describeGhFailure(error));
    try {
      return toGraphqlResult(JSON.parse(stdout));
    } catch {
      throw new Error(describeGhFailure(error));
    }
  }
}

/** One relation bucket's results, or omitted entirely when its search failed. */
interface BucketResult {
  relation: Relation;
  nodes: unknown[];
}

/**
 * `RELATION_IDS`'s own order, precomputed once instead of an `indexOf` scan
 * per comparison. The initial value is empty only until the loop below fills
 * every key `RELATION_IDS` declares; the cast just names that guarantee once.
 */
const RELATION_ORDER = RELATION_IDS.reduce(
  (order, relation, index) => {
    order[relation] = index;
    return order;
  },
  {} as Record<Relation, number>,
);

/**
 * Runs every bucket as one aliased request — the same trick the old
 * author/owned pair used, generalised past two names. A bucket GitHub refuses
 * (a mistyped or deleted owner) is warned about and dropped rather than
 * costing the whole column; the column only fails when every bucket did.
 */
async function runBuckets(
  type: "ISSUE" | "DISCUSSION",
  selection: string,
  buckets: readonly RelationBucket[],
  scope: string,
  limit: number,
): Promise<BucketResult[]> {
  if (buckets.length === 0) return [];
  const vars = buckets.map((_, index) => `$${aliasName(index)}: String!`).join(", ");
  const aliases = buckets
    .map(
      (_, index) =>
        `${aliasName(index)}: search(query: $${aliasName(index)}, type: ${type}, first: $limit) { nodes { ${selection} } }`,
    )
    .join("\n  ");
  const query = `query(${vars}, $limit: Int!) {\n  ${aliases}\n}`;

  const args = ["api", "graphql", "-f", `query=${query}`];
  buckets.forEach((bucket, index) => {
    args.push("-f", `${aliasName(index)}=${scope} ${bucket.qualifier}`.trim());
  });
  args.push("-F", `limit=${limit}`);

  const { data, errors } = await ghGraphqlRaw(args);

  const results: BucketResult[] = [];
  const failures: string[] = [];
  buckets.forEach((bucket, index) => {
    const alias = aliasName(index);
    const failure = errors.find((error) => Array.isArray(error.path) && error.path[0] === alias);
    if (failure !== undefined) {
      console.warn(`github-board: bucket "${bucket.qualifier}" (${bucket.relation}) failed: ${failure.message}`);
      failures.push(failure.message);
      return;
    }
    results.push({ relation: bucket.relation, nodes: nodesOf(data?.[alias]) });
  });

  if (results.length === 0 && failures.length > 0) throw new Error(failures.join(" "));
  return results;
}

/**
 * Unions every bucket's nodes by id and keeps every relation that found the
 * item, deduplicated and sorted to `RELATION_IDS` order. `toBoardItem` returns
 * null for a node the caller wants dropped entirely (an archived discussion,
 * an empty node from the other inline fragment matching nothing), which is
 * why it runs before the relation is ever recorded.
 */
function mergeBucketResults<TNode extends GhSearchNode>(
  buckets: readonly BucketResult[],
  toBoardItem: (node: TNode) => BoardItem | null,
  limit: number,
): BoardItem[] {
  const byId = new Map<string, BoardItem>();
  for (const bucket of buckets) {
    for (const raw of bucket.nodes) {
      if (typeof raw !== "object" || raw === null) continue;
      // A generic node shape the caller's own callback narrows further; the
      // `id` check right below is the only guarantee made about it here.
      const node = raw as TNode;
      if (typeof node.id !== "string") continue;
      const existing = byId.get(node.id);
      if (existing !== undefined) {
        if (!existing.relations.includes(bucket.relation)) existing.relations.push(bucket.relation);
        continue;
      }
      const item = toBoardItem(node);
      if (item === null) continue;
      item.relations = [bucket.relation];
      byId.set(node.id, item);
    }
  }
  for (const item of byId.values()) {
    item.relations.sort((a, b) => RELATION_ORDER[a] - RELATION_ORDER[b]);
  }
  return [...byId.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit);
}

const ISSUE_SELECTION = `... on Issue {
  id
  number
  title
  url
  updatedAt
  author { login }
  comments { totalCount }
  labels(first: 20) { nodes { name } }
  repository { nameWithOwner isArchived }
}`;

/**
 * `type: ISSUE` covers issues and pull requests both, so the scope itself has
 * to say `is:issue` — the inline fragment alone would leave every pull request
 * in the response as an empty node.
 */
async function fetchIssues(
  login: string,
  owners: readonly string[],
  limit: number,
): Promise<BoardItem[]> {
  const scope = `is:issue state:open ${UNARCHIVED_ONLY} sort:updated-desc`;
  const buckets = [...personalBuckets(login, false), ...ownedBuckets(owners)];
  const results = await runBuckets("ISSUE", ISSUE_SELECTION, buckets, scope, limit);
  return mergeBucketResults<GhSearchNode>(results, (node) => toItem(node, null), limit);
}

/**
 * Pull requests carry `closingIssuesReferences` — the link from a pull request
 * to the issues it closes, and the only source that sees both closing keywords
 * in the body and issues attached by hand from the Development panel. The board
 * needs it to fold an issue into the pull request that closes it.
 */
const PULL_REQUEST_SELECTION = `... on PullRequest {
  id
  number
  title
  url
  updatedAt
  isDraft
  author { login }
  comments { totalCount }
  labels(first: 20) { nodes { name } }
  repository { nameWithOwner isArchived }
  closingIssuesReferences(first: 20) {
    nodes { id number repository { nameWithOwner } }
  }
}`;

interface GhPullRequestNode extends GhSearchNode {
  isDraft?: unknown;
  closingIssuesReferences?: { nodes?: unknown };
}

function toLinkedIssues(node: GhPullRequestNode): LinkedIssue[] {
  const nodes = node.closingIssuesReferences?.nodes;
  if (!Array.isArray(nodes)) return [];
  return nodes
    .filter((issue): issue is Record<string, unknown> => typeof issue === "object" && issue !== null)
    .map((issue) => ({
      id: typeof issue.id === "string" ? issue.id : "",
      number: typeof issue.number === "number" ? issue.number : 0,
      repository:
        typeof (issue.repository as { nameWithOwner?: unknown } | undefined)?.nameWithOwner ===
        "string"
          ? ((issue.repository as { nameWithOwner: string }).nameWithOwner)
          : "",
    }))
    .filter((issue) => issue.id !== "");
}

/**
 * The checks on each pull request's head commit, by node id.
 *
 * A **separate request** from the search, deliberately. A token without the
 * Checks permission — a fine-grained PAT, typically — answers
 * `statusCheckRollup` with "Resource not accessible", and `gh api graphql`
 * treats any GraphQL error as a failed command. Asking for it inside the search
 * would turn that into a blank Draft PRs *and* Open PRs column; asking for it
 * separately costs pills nobody could have seen anyway.
 *
 * `nodes(ids:)` takes at most 100 ids, which the caller cannot exceed: it asks
 * only for the open pull requests, and the merged list was already cut to
 * `limit`, whose own ceiling is 100.
 */
const CHECKS_QUERY = `query($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on PullRequest {
      id
      commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              contexts(first: 100) {
                nodes {
                  __typename
                  ... on CheckRun {
                    name
                    status
                    conclusion
                    startedAt
                    completedAt
                    checkSuite { workflowRun { databaseId } }
                  }
                  ... on StatusContext {
                    context
                    state
                    createdAt
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

/**
 * Where one check lands in the summary. `ignored` is the fourth outcome that is
 * neither a result nor a wait — a skipped or cancelled run says nothing about
 * whether the pull request is healthy, so it is counted nowhere, exactly as
 * Paseo's own checks summary drops it.
 */
type CheckOutcome = "passed" | "failed" | "pending" | "ignored";

/**
 * Mirrors Paseo's `mapCheckRunStatus` so the board and the sidebar cannot
 * disagree about the same pull request, with one deliberate difference:
 * `STARTUP_FAILURE` and `STALE` are terminal, so reporting them as `pending`
 * would show a run still going that will never report again.
 */
function checkRunOutcome(status: unknown, conclusion: unknown): CheckOutcome {
  if (status !== "COMPLETED") return "pending";
  switch (conclusion) {
    case "SUCCESS":
      return "passed";
    case "FAILURE":
    case "TIMED_OUT":
    case "ACTION_REQUIRED":
    case "STARTUP_FAILURE":
      return "failed";
    case "CANCELLED":
    case "SKIPPED":
    case "NEUTRAL":
    case "STALE":
      return "ignored";
    default:
      return "pending";
  }
}

/** The commit-status half of the rollup, which has states rather than conclusions. */
function statusContextOutcome(state: unknown): CheckOutcome {
  switch (state) {
    case "SUCCESS":
      return "passed";
    case "FAILURE":
    case "ERROR":
      return "failed";
    default:
      return "pending";
  }
}

function parseTime(value: unknown): number {
  if (typeof value !== "string") return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

interface CountedCheck {
  name: string;
  outcome: CheckOutcome;
  /** Higher wins when the same name appears twice; see `foldChecks`. */
  recency: number;
}

function toCountedCheck(node: Record<string, unknown>): CountedCheck | null {
  if (node.__typename === "CheckRun") {
    const workflowRunId = (
      node.checkSuite as { workflowRun?: { databaseId?: unknown } } | undefined
    )?.workflowRun?.databaseId;
    return {
      name: typeof node.name === "string" ? node.name : "",
      outcome: checkRunOutcome(node.status, node.conclusion),
      // A re-run gets a higher run id than the run it replaced, so the id
      // orders attempts even before either of them has a timestamp.
      recency:
        typeof workflowRunId === "number"
          ? workflowRunId
          : parseTime(node.completedAt ?? node.startedAt),
    };
  }
  if (node.__typename === "StatusContext") {
    return {
      name: typeof node.context === "string" ? node.context : "",
      outcome: statusContextOutcome(node.state),
      recency: parseTime(node.createdAt),
    };
  }
  // A rollup entry of some type this query did not ask for.
  return null;
}

/**
 * Folds one commit's rollup into the three counts a card shows.
 *
 * Deduplicated by check name, keeping the most recent: a re-run leaves the
 * attempt it replaced in the rollup, and counting both would report a check
 * that failed and then passed as one of each.
 *
 * Null rather than three zeroes when nothing reported at all, so "no CI here"
 * and "every check was skipped" both render as no pills instead of as an empty
 * summary.
 */
function foldChecks(nodes: readonly unknown[]): CheckSummary | null {
  const latest = new Map<string, CountedCheck>();
  for (const node of nodes) {
    if (typeof node !== "object" || node === null) continue;
    const check = toCountedCheck(node as Record<string, unknown>);
    if (check === null) continue;
    const existing = latest.get(check.name);
    if (existing === undefined || check.recency >= existing.recency) latest.set(check.name, check);
  }
  if (latest.size === 0) return null;

  const summary = { passed: 0, failed: 0, pending: 0 };
  for (const check of latest.values()) {
    if (check.outcome === "passed") summary.passed += 1;
    else if (check.outcome === "failed") summary.failed += 1;
    else if (check.outcome === "pending") summary.pending += 1;
  }
  return summary.passed + summary.failed + summary.pending === 0 ? null : summary;
}

function rollupContexts(node: unknown): unknown[] {
  const commits = (node as { commits?: { nodes?: unknown } } | undefined)?.commits?.nodes;
  if (!Array.isArray(commits)) return [];
  // `commits(last: 1)` is the head commit, which is the only one whose checks
  // describe the pull request as it stands.
  const commit = (commits[0] as { commit?: unknown } | undefined)?.commit;
  const contexts = (
    commit as { statusCheckRollup?: { contexts?: { nodes?: unknown } } } | undefined
  )?.statusCheckRollup?.contexts?.nodes;
  return Array.isArray(contexts) ? contexts : [];
}

async function fetchChecks(ids: readonly string[]): Promise<Map<string, CheckSummary>> {
  const raw = await gh([
    "api",
    "graphql",
    "-f",
    `query=${CHECKS_QUERY}`,
    // gh spells a list variable as a repeated `name[]=` field.
    ...ids.flatMap((id) => ["-f", `ids[]=${id}`]),
  ]);
  const parsed: unknown = JSON.parse(raw);
  const nodes = (parsed as { data?: { nodes?: unknown } }).data?.nodes;
  const summaries = new Map<string, CheckSummary>();
  if (!Array.isArray(nodes)) return summaries;
  for (const node of nodes) {
    if (typeof node !== "object" || node === null) continue;
    const id = (node as { id?: unknown }).id;
    if (typeof id !== "string") continue;
    const summary = foldChecks(rollupContexts(node));
    if (summary !== null) summaries.set(id, summary);
  }
  return summaries;
}

/**
 * Checks are a second round trip, so a failure here must cost the pills and
 * nothing else — the pull requests themselves already loaded. The reason is
 * written to the plugin log rather than dropped, because a permanently
 * pill-less board with no explanation is the one outcome worse than no pills.
 */
async function attachChecks(items: readonly BoardItem[]): Promise<BoardItem[]> {
  const ids = items.map((item) => item.id).filter((id) => id !== "");
  if (ids.length === 0) return [...items];
  let summaries: Map<string, CheckSummary>;
  try {
    summaries = await fetchChecks(ids);
  } catch (error) {
    console.warn(
      `[github-board] pull request checks unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return [...items];
  }
  return items.map((item) => ({ ...item, checks: summaries.get(item.id) ?? null }));
}

/**
 * One search backs two columns. Splitting client-side would ship draft pull
 * requests the open column discards, so the split happens here — after the
 * merge, so the `limit` is spent on the pull requests that exist rather than on
 * one column's share of them.
 */
async function fetchPullRequests(
  login: string,
  owners: readonly string[],
  limit: number,
): Promise<{ draft: BoardItem[]; open: BoardItem[] }> {
  const scope = `is:pr state:open ${UNARCHIVED_ONLY} sort:updated-desc`;
  const buckets = [...personalBuckets(login, true), ...ownedBuckets(owners)];
  const results = await runBuckets("ISSUE", PULL_REQUEST_SELECTION, buckets, scope, limit);

  const drafts = new Set<string>();
  const merged = mergeBucketResults<GhPullRequestNode>(
    results,
    (row) => {
      const id = typeof row.id === "string" ? row.id : String(row.url);
      if (row.isDraft === true) drafts.add(id);
      return { ...toItem(row, null), linkedIssues: toLinkedIssues(row) };
    },
    limit,
  );

  // Checks are fetched for the open column alone: a draft says its work is not
  // finished, so its CI is nobody's business yet, and asking for fewer ids
  // keeps the extra request as small as the thing it feeds.
  return {
    draft: merged.filter((item) => drafts.has(item.id)),
    open: await attachChecks(merged.filter((item) => !drafts.has(item.id))),
  };
}

const DISCUSSION_SELECTION = `... on Discussion {
  id
  number
  title
  url
  updatedAt
  author { login }
  category { name }
  comments { totalCount }
  repository { nameWithOwner isArchived }
}`;

interface GhDiscussionNode extends GhSearchNode {
  category?: { name?: unknown };
}

/**
 * GitHub's discussion search accepts `author:` and `user:` but ignores
 * `mentions:`, `assignee:` and `review-requested:`, so a discussion only ever
 * carries the `author` or `owned` relation, never one that names a personal
 * mention or assignment GitHub has no way to search discussions for.
 */
async function fetchDiscussions(
  login: string,
  owners: readonly string[],
  limit: number,
): Promise<BoardItem[]> {
  const buckets: RelationBucket[] = [
    { relation: "author", qualifier: `author:${login}` },
    ...ownedBuckets(owners),
  ];
  const results = await runBuckets("DISCUSSION", DISCUSSION_SELECTION, buckets, "sort:updated-desc", limit);
  return mergeBucketResults<GhDiscussionNode>(
    results,
    (node) =>
      node.repository?.isArchived === true
        ? null
        : toItem(node, typeof node.category?.name === "string" ? node.category.name : null),
    limit,
  );
}

/**
 * A board costs three `gh` subprocesses and a round trip to GitHub, so one is
 * reused for a short window — the surface remounts on every workspace switch
 * and should not pay that each time. The Refresh button sends `force`.
 *
 * `hiddenRepositories` is deliberately not part of the cached value: settings
 * are read on every load, because a client that saved a new filter and then
 * remounted would otherwise be handed the filter this board was built with.
 */
interface CachedBoard {
  /** Login, limit and the watched owners all change the query, so all three are part of the key. */
  key: string;
  columns: BoardColumn[];
  fetchedAt: string;
  storedAt: number;
}

const BOARD_TTL_MS = 5 * 60_000;

let cachedBoard: CachedBoard | null = null;

/**
 * The project each repository on the board belongs to, keyed the way a card
 * spells its repository so the surface needs no host parsing to look one up.
 *
 * A board carrying the same `owner/name` from two different forges would
 * collapse to one entry; the send button is unaffected, because it resolves
 * from the card's own URL rather than from this map.
 */
/**
 * `owner/name` to project id, for the repositories on this board only. The
 * surface needs it to pick a prompt template during the press gesture, so it
 * rides along rather than costing a round trip mid-gesture.
 *
 * The full project list used to ride along too, for the settings view's
 * per-project overrides. That view now calls `paseo.projects.list()` on the
 * client, which is the same list without the detour.
 */
async function describeRepositoryProjects(
  paseo: PaseoApi,
  columns: readonly BoardColumn[],
): Promise<{ repositoryProjects: Record<string, string> }> {
  const index = await loadProjectIndex(paseo);

  const repositoryProjects: Record<string, string> = {};
  for (const column of columns) {
    for (const item of column.items) {
      if (item.repository === "" || repositoryProjects[item.repository] !== undefined) continue;
      const repositoryId = repositoryIdFor(item.repository, item.url);
      if (repositoryId === null) continue;
      const project = index.byRepositoryId.get(repositoryId);
      if (project !== undefined) repositoryProjects[item.repository] = project.projectId;
    }
  }

  return { repositoryProjects };
}

async function settle(
  id: BoardColumn["id"],
  title: string,
  load: () => Promise<BoardItem[]>,
): Promise<BoardColumn> {
  try {
    return { id, title, items: await load(), error: null };
  } catch (error) {
    return { id, title, items: [], error: error instanceof Error ? error.message : String(error) };
  }
}

export async function loadBoardHandler(
  { login, owners, limit, force }: z.output<typeof loadBoard.input>,
  { paseo }: PluginHandlerContext,
): Promise<z.input<typeof loadBoard.output>> {
  const requested = login?.trim();
  const settings = await readSettings();
  const resolved =
    requested !== undefined && requested !== "" && requested !== "@me"
      ? requested
      : (settings.login ?? (await resolveViewerLogin()));

  const key = `${resolved}\u0000${limit}\u0000${[...owners].sort().join(",")}`;
  if (
    !force &&
    cachedBoard !== null &&
    cachedBoard.key === key &&
    Date.now() - cachedBoard.storedAt < BOARD_TTL_MS
  ) {
    return {
      login: resolved,
      ...(await describeRepositoryProjects(paseo, cachedBoard.columns)),
      columns: cachedBoard.columns,
      fetchedAt: cachedBoard.fetchedAt,
    };
  }

  // Both pull request columns share one request, so they settle together.
  const pullRequests = fetchPullRequests(resolved, owners, limit).then(
    (split) => ({ split, error: null as string | null }),
    (error: unknown) => ({
      split: { draft: [] as BoardItem[], open: [] as BoardItem[] },
      error: error instanceof Error ? error.message : String(error),
    }),
  );

  const [issues, prs, discussions] = await Promise.all([
    settle("issues", "Issues", () => fetchIssues(resolved, owners, limit)),
    pullRequests,
    settle("discussions", "Discussions", () => fetchDiscussions(resolved, owners, limit)),
  ]);

  const columns: BoardColumn[] = [
    issues,
    { id: "draft-prs", title: "Draft PRs", items: prs.split.draft, error: prs.error },
    { id: "open-prs", title: "Open PRs", items: prs.split.open, error: prs.error },
    discussions,
  ];
  const fetchedAt = new Date().toISOString();

  // A column that failed is not worth remembering: caching it would keep the
  // error on screen for the whole window even though a retry might succeed.
  if (columns.every((column) => column.error === null)) {
    cachedBoard = { key, columns, fetchedAt, storedAt: Date.now() };
  }

  return {
    login: resolved,
    ...(await describeRepositoryProjects(paseo, columns)),
    columns,
    fetchedAt,
  };
}

/**
 * Hands the pre-0.4.0 settings to the app, which is the only side that can
 * write a settings document. Nothing is cleared here: the file keeps them
 * until `legacySettingsTakenHandler` confirms they landed.
 */
export async function takeLegacySettingsHandler(): Promise<
  z.input<typeof takeLegacySettings.output>
> {
  const { legacy } = await readSettings();
  if (legacy === null) return { found: false };
  return {
    found: true,
    hiddenRepositories: legacy.hiddenRepositories,
    prompts: legacy.prompts,
    detailWidthFraction: legacy.detailWidthFraction,
  };
}

export async function legacySettingsTakenHandler(): Promise<
  z.input<typeof legacySettingsTaken.output>
> {
  await updateSettings({ legacy: null });
  return {};
}

export async function saveLoginHandler({
  login,
}: z.output<typeof saveLogin.input>): Promise<z.input<typeof saveLogin.output>> {
  const trimmed = login.trim();
  const resolved = trimmed === "" || trimmed === "@me" ? await resolveViewerLogin() : trimmed;
  await updateSettings({ login: resolved });
  return { login: resolved };
}

/** GitHub returns a label as `{ name }`; every list of them needs the same narrowing. */
function labelNodeNames(nodes: unknown): string[] {
  if (!Array.isArray(nodes)) return [];
  const names: string[] = [];
  for (const raw of nodes) {
    if (typeof raw !== "object" || raw === null) continue;
    const label = raw as { name?: unknown };
    if (typeof label.name === "string") names.push(label.name);
  }
  return names;
}

/**
 * Projects v2 sits behind its own OAuth scope, which `gh auth login` never
 * grants automatically, so a token missing it is the ordinary case rather
 * than a failure. GitHub reports it as a validation error with no `data` at
 * all, before any field runs — see `ghGraphqlRaw` — so this is checked ahead
 * of the per-owner partial-failure handling below, not folded into it.
 */
const PROJECT_SCOPE_MESSAGE =
  "GitHub Projects needs a scope this token does not have. Run `gh auth refresh -h github.com -s read:project`, then reload.";

function needsProjectScope(errors: readonly GraphqlError[]): boolean {
  return errors.some(
    (error) => error.type === "INSUFFICIENT_SCOPES" || error.message.includes("read:project"),
  );
}

/** One project summary node, as `PROJECT_SUMMARY_FIELDS` shapes it. */
interface GhProjectSummaryNode {
  id?: unknown;
  number?: unknown;
  title?: unknown;
  url?: unknown;
  shortDescription?: unknown;
  closed?: unknown;
  updatedAt?: unknown;
  items?: { totalCount?: unknown };
  owner?: { login?: unknown };
}

const PROJECT_SUMMARY_FIELDS = `id number title url shortDescription closed updatedAt items { totalCount } owner { ... on User { login } ... on Organization { login } }`;

function toProjectSummary(node: GhProjectSummaryNode): ProjectSummary | null {
  if (typeof node.id !== "string" || typeof node.url !== "string") return null;
  return {
    id: node.id,
    number: typeof node.number === "number" ? node.number : 0,
    title: typeof node.title === "string" ? node.title : "",
    url: node.url,
    shortDescription: typeof node.shortDescription === "string" ? node.shortDescription : null,
    owner: typeof node.owner?.login === "string" ? node.owner.login : "",
    closed: node.closed === true,
    updatedAt: typeof node.updatedAt === "string" ? node.updatedAt : "",
    itemCount: typeof node.items?.totalCount === "number" ? node.items.totalCount : 0,
  };
}

/** Every project node under one `user`/`organization` alias's `projectsV2` connection. */
interface GhOwnerProjectsNode {
  projectsV2?: { nodes?: unknown } | null;
}

interface CachedProjects {
  /** The login and the watched owners both change the result, so both are part of the key. */
  key: string;
  result: z.input<typeof listProjects.output>;
  storedAt: number;
}

const PROJECTS_TTL_MS = 5 * 60_000;

let cachedProjects: CachedProjects | null = null;

export async function listProjectsHandler({
  login,
  owners,
  force,
}: z.output<typeof listProjects.input>): Promise<z.input<typeof listProjects.output>> {
  const requested = login?.trim();
  const settings = await readSettings();
  const resolved =
    requested !== undefined && requested !== "" && requested !== "@me"
      ? requested
      : (settings.login ?? (await resolveViewerLogin()));

  const key = `${resolved}\u0000${[...owners].sort().join(",")}`;
  const cached = cachedProjects;
  if (!force && cached !== null && cached.key === key && Date.now() - cached.storedAt < PROJECTS_TTL_MS) {
    return cached.result;
  }

  const orderBy = "orderBy: { field: UPDATED_AT, direction: DESC }";
  const ownerAliases = owners
    .map(
      (_, index) =>
        `${aliasName(index)}: organization(login: $${aliasName(index)}) { projectsV2(first: 20, ${orderBy}) { nodes { ${PROJECT_SUMMARY_FIELDS} } } }`,
    )
    .join("\n  ");
  const vars = ["$self: String!", ...owners.map((_, index) => `$${aliasName(index)}: String!`)].join(", ");
  const query = `query(${vars}) {
  self: user(login: $self) { projectsV2(first: 20, ${orderBy}) { nodes { ${PROJECT_SUMMARY_FIELDS} } } }
  ${ownerAliases}
}`;

  const args = ["api", "graphql", "-f", `query=${query}`, "-f", `self=${resolved}`];
  owners.forEach((owner, index) => args.push("-f", `${aliasName(index)}=${owner}`));

  const { data, errors } = await ghGraphqlRaw(args);

  if (data === null) {
    return needsProjectScope(errors)
      ? { projects: [], error: PROJECT_SCOPE_MESSAGE, needsScope: true }
      : {
          projects: [],
          error: errors.map((error) => error.message).join(" ") || "GitHub returned no data.",
          needsScope: false,
        };
  }

  const byId = new Map<string, ProjectSummary>();
  const collect = (alias: string, label: string): void => {
    const failure = errors.find((error) => Array.isArray(error.path) && error.path[0] === alias);
    if (failure !== undefined) {
      console.warn(`github-board: projects for "${label}" failed: ${failure.message}`);
      return;
    }
    const ownerNode = data[alias] as GhOwnerProjectsNode | null;
    for (const raw of nodesOf(ownerNode?.projectsV2)) {
      if (typeof raw !== "object" || raw === null) continue;
      const summary = toProjectSummary(raw as GhProjectSummaryNode);
      if (summary !== null) byId.set(summary.id, summary);
    }
  };

  collect("self", resolved);
  owners.forEach((owner, index) => collect(aliasName(index), owner));

  const projects = [...byId.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const result = { projects, error: null, needsScope: false };
  cachedProjects = { key, result, storedAt: Date.now() };
  return result;
}

/** The Status field's own single-select name, read by `fieldValueByName` and `field`. */
const STATUS_FIELD_NAME = "Status";

/** The union `content` resolves to; `__typename` is what tells the three apart. */
interface GhProjectContentNode {
  __typename?: unknown;
  id?: unknown;
  number?: unknown;
  title?: unknown;
  url?: unknown;
  state?: unknown;
  isDraft?: unknown;
  repository?: { nameWithOwner?: unknown };
  author?: { login?: unknown };
  labels?: { nodes?: unknown };
  updatedAt?: unknown;
}

interface GhProjectItemNode {
  fieldValueByName?: { name?: unknown } | null;
  content?: GhProjectContentNode | null;
}

interface GhProjectV2Node {
  title?: unknown;
  url?: unknown;
  field?: { options?: unknown } | null;
  items?: { nodes?: unknown };
}

const PROJECT_QUERY = `fragment ProjectFields on ProjectV2 {
  title
  url
  field(name: "${STATUS_FIELD_NAME}") {
    ... on ProjectV2SingleSelectField {
      options { name }
    }
  }
  items(first: 100) {
    nodes {
      fieldValueByName(name: "${STATUS_FIELD_NAME}") {
        ... on ProjectV2ItemFieldSingleSelectValue { name }
      }
      content {
        __typename
        ... on Issue {
          id
          number
          title
          url
          state
          repository { nameWithOwner }
          author { login }
          labels(first: 20) { nodes { name } }
          updatedAt
        }
        ... on PullRequest {
          id
          number
          title
          url
          state
          isDraft
          repository { nameWithOwner }
          author { login }
          labels(first: 20) { nodes { name } }
          updatedAt
        }
        ... on DraftIssue {
          id
          title
          updatedAt
        }
      }
    }
  }
}

query($owner: String!, $number: Int!) {
  asUser: user(login: $owner) { projectV2(number: $number) { ...ProjectFields } }
  asOrg: organization(login: $owner) { projectV2(number: $number) { ...ProjectFields } }
}`;

/** The Status field's option order, when GitHub could resolve it at all. */
function statusOptionNamesOf(field: GhProjectV2Node["field"]): string[] {
  const options = field?.options;
  if (!Array.isArray(options)) return [];
  const names: string[] = [];
  for (const raw of options) {
    if (typeof raw !== "object" || raw === null) continue;
    const option = raw as { name?: unknown };
    if (typeof option.name === "string") names.push(option.name);
  }
  return names;
}

/** Pull requests carry `isDraft`; a draft note has no open/closed state at all. */
function projectItemStateOf(
  kind: ProjectItem["kind"],
  node: GhProjectContentNode,
): ProjectItem["state"] {
  if (kind === "draft") return null;
  if (kind === "pull-request" && node.isDraft === true) return "draft";
  if (node.state === "OPEN") return "open";
  if (node.state === "MERGED") return "merged";
  if (node.state === "CLOSED") return "closed";
  return null;
}

function toProjectItem(node: GhProjectContentNode): ProjectItem | null {
  const kind: ProjectItem["kind"] | null =
    node.__typename === "Issue"
      ? "issue"
      : node.__typename === "PullRequest"
        ? "pull-request"
        : node.__typename === "DraftIssue"
          ? "draft"
          : null;
  if (kind === null) return null;

  return {
    id: typeof node.id === "string" ? node.id : "",
    kind,
    title: typeof node.title === "string" ? node.title : "",
    url: kind !== "draft" && typeof node.url === "string" ? node.url : null,
    repository:
      kind !== "draft" && typeof node.repository?.nameWithOwner === "string"
        ? node.repository.nameWithOwner
        : null,
    number: kind !== "draft" && typeof node.number === "number" ? node.number : null,
    state: projectItemStateOf(kind, node),
    author: typeof node.author?.login === "string" ? node.author.login : null,
    labels: labelNodeNames(node.labels?.nodes),
    updatedAt: typeof node.updatedAt === "string" ? node.updatedAt : "",
  };
}

/**
 * Groups a project's items by its Status field, in the field's own option
 * order when it could be read at all — a project without a Status field, or
 * one `fieldValueByName` failed to resolve, still groups by whatever name (or
 * lack of one) each item actually carries; only the *order* falls back to
 * insertion order, with the no-status group always last regardless.
 */
function groupProjectItems(project: GhProjectV2Node): Array<{ name: string; items: ProjectItem[] }> {
  const order = statusOptionNamesOf(project.field);
  const groups = new Map<string, ProjectItem[]>();
  for (const raw of nodesOf(project.items)) {
    if (typeof raw !== "object" || raw === null) continue;
    const row = raw as GhProjectItemNode;
    if (typeof row.content !== "object" || row.content === null) continue;
    const item = toProjectItem(row.content);
    if (item === null) continue;
    const statusName = typeof row.fieldValueByName?.name === "string" ? row.fieldValueByName.name : "";
    const bucket = groups.get(statusName);
    if (bucket === undefined) groups.set(statusName, [item]);
    else bucket.push(item);
  }

  const names = [...groups.keys()].sort((a, b) => {
    if (a === "") return 1;
    if (b === "") return -1;
    const orderA = order.indexOf(a);
    const orderB = order.indexOf(b);
    if (orderA === -1 && orderB === -1) return 0;
    if (orderA === -1) return 1;
    if (orderB === -1) return -1;
    return orderA - orderB;
  });

  return names.map((name) => ({ name, items: groups.get(name) ?? [] }));
}

interface CachedProject {
  result: z.input<typeof loadProject.output>;
  storedAt: number;
}

const PROJECT_TTL_MS = 5 * 60_000;

const cachedProject = new Map<string, CachedProject>();

export async function loadProjectHandler({
  owner,
  number,
  force,
}: z.output<typeof loadProject.input>): Promise<z.input<typeof loadProject.output>> {
  const key = `${owner}\u0000${number}`;
  const cached = cachedProject.get(key);
  if (!force && cached !== undefined && Date.now() - cached.storedAt < PROJECT_TTL_MS) {
    return cached.result;
  }

  const { data, errors } = await ghGraphqlRaw([
    "api",
    "graphql",
    "-f",
    `query=${PROJECT_QUERY}`,
    "-f",
    `owner=${owner}`,
    "-F",
    `number=${number}`,
  ]);

  if (data === null) {
    if (needsProjectScope(errors)) throw new Error(PROJECT_SCOPE_MESSAGE);
    throw new Error(errors.map((error) => error.message).join(" ") || "GitHub returned no data.");
  }

  const asUser = data.asUser as { projectV2?: GhProjectV2Node | null } | null;
  const asOrg = data.asOrg as { projectV2?: GhProjectV2Node | null } | null;
  const project = asUser?.projectV2 ?? asOrg?.projectV2;

  if (project === null || project === undefined) {
    const message = errors.map((error) => error.message).join(" ");
    throw new Error(message !== "" ? message : `Project ${owner}/${number} was not found.`);
  }

  const result = {
    title: typeof project.title === "string" ? project.title : "",
    url: typeof project.url === "string" ? project.url : "",
    columns: groupProjectItems(project),
  };

  cachedProject.set(key, { result, storedAt: Date.now() });
  return result;
}

/**
 * The labels a repository defines, cached the way the board is: a label set
 * changes far more slowly than the work it is put on, and the menu is opened
 * card by card on repositories the user keeps returning to.
 */
interface CachedLabels {
  labels: RepositoryLabel[];
  storedAt: number;
}

const LABELS_TTL_MS = 5 * 60_000;

const cachedLabels = new Map<string, CachedLabels>();

/**
 * First 100 by name, which is every label on all but a deliberately elaborate
 * repository. Paging past that would mean a cursor loop for a menu nobody can
 * read anyway; a label past the hundredth is edited on GitHub.
 */
const LABELS_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    labels(first: 100, orderBy: { field: NAME, direction: ASC }) {
      nodes { id name color description }
    }
  }
}`;

/** `owner/name` as every card spells it, and the only form these handlers take. */
function splitRepository(repository: string): { owner: string; name: string } {
  const [owner, name, ...rest] = repository.split("/");
  if (owner === undefined || owner === "" || name === undefined || name === "" || rest.length > 0) {
    throw new Error(`"${repository}" is not an owner/name repository.`);
  }
  return { owner, name };
}

async function fetchRepositoryLabels(repository: string): Promise<RepositoryLabel[]> {
  const { owner, name } = splitRepository(repository);
  const raw = await gh([
    "api",
    "graphql",
    "-f",
    `query=${LABELS_QUERY}`,
    "-f",
    `owner=${owner}`,
    "-f",
    `name=${name}`,
  ]);
  const parsed: unknown = JSON.parse(raw);
  const nodes = (parsed as { data?: { repository?: { labels?: { nodes?: unknown } } } }).data
    ?.repository?.labels?.nodes;
  if (!Array.isArray(nodes)) return [];
  return nodes
    .filter((node): node is Record<string, unknown> => typeof node === "object" && node !== null)
    .map((node) => ({
      id: typeof node.id === "string" ? node.id : "",
      name: typeof node.name === "string" ? node.name : "",
      color: typeof node.color === "string" ? node.color : "",
      description:
        typeof node.description === "string" && node.description !== "" ? node.description : null,
    }))
    .filter((label) => label.id !== "" && label.name !== "");
}

export async function listLabelsHandler({
  repository,
}: z.output<typeof listLabels.input>): Promise<z.input<typeof listLabels.output>> {
  const hit = cachedLabels.get(repository);
  if (hit !== undefined && Date.now() - hit.storedAt < LABELS_TTL_MS) return { labels: hit.labels };

  const labels = await fetchRepositoryLabels(repository);
  cachedLabels.set(repository, { labels, storedAt: Date.now() });
  return { labels };
}

/**
 * Both mutations answer with the labelable they changed, so the item's new
 * labels come back in the same round trip that set them — no read-after-write,
 * and no window where the card and GitHub disagree.
 *
 * `Labelable` is an interface, so the labels have to be selected through an
 * inline fragment per concrete type; issues and pull requests are the two the
 * board offers this on.
 */
const LABELABLE_SELECTION = `labelable {
      ... on Issue { labels(first: 20) { nodes { name } } }
      ... on PullRequest { labels(first: 20) { nodes { name } } }
    }`;

const ADD_LABEL_MUTATION = `mutation($item: ID!, $label: ID!) {
  addLabelsToLabelable(input: { labelableId: $item, labelIds: [$label] }) {
    ${LABELABLE_SELECTION}
  }
}`;

const REMOVE_LABEL_MUTATION = `mutation($item: ID!, $label: ID!) {
  removeLabelsFromLabelable(input: { labelableId: $item, labelIds: [$label] }) {
    ${LABELABLE_SELECTION}
  }
}`;

function labelNamesOf(result: unknown): string[] {
  const nodes = (
    result as { labelable?: { labels?: { nodes?: unknown } } } | undefined
  )?.labelable?.labels?.nodes;
  if (!Array.isArray(nodes)) return [];
  return nodes
    .map((node) => (node as { name?: unknown }).name)
    .filter((name): name is string => typeof name === "string");
}

/**
 * Keeps the cached board honest. Without this a label edited now would be
 * undone on screen by the next cache hit — the board is remembered for five
 * minutes, and a surface remounts on every workspace switch.
 */
function patchCachedLabels(itemId: string, labels: readonly string[]): void {
  if (cachedBoard === null) return;
  cachedBoard = {
    ...cachedBoard,
    columns: cachedBoard.columns.map((column) => ({
      ...column,
      items: column.items.map((item) => (item.id === itemId ? { ...item, labels: [...labels] } : item)),
    })),
  };
}

export async function toggleLabelHandler({
  itemId,
  labelId,
  add,
}: z.output<typeof toggleLabel.input>): Promise<z.input<typeof toggleLabel.output>> {
  const raw = await gh([
    "api",
    "graphql",
    "-f",
    `query=${add ? ADD_LABEL_MUTATION : REMOVE_LABEL_MUTATION}`,
    "-f",
    `item=${itemId}`,
    "-f",
    `label=${labelId}`,
  ]);
  const parsed: unknown = JSON.parse(raw);
  const data = (parsed as { data?: Record<string, unknown> }).data;
  const labels = labelNamesOf(add ? data?.addLabelsToLabelable : data?.removeLabelsFromLabelable);
  patchCachedLabels(itemId, labels);
  return { labels };
}

/**
 * The body of one card, fetched when its panel opens rather than with the
 * board: a body is the largest field an item has, and thirty of them per column
 * would weigh down a refresh for text the user reads one at a time.
 *
 * `node(id:)` resolves any node type, so one query serves all three kinds and
 * the inline fragments decide which fields come back. A discussion carries no
 * assignees on GitHub, and only a pull request has branches.
 */
const ITEM_QUERY = `query($id: ID!) {
  node(id: $id) {
    ... on Issue {
      body state createdAt
      assignees(first: 20) { nodes { login } }
    }
    ... on PullRequest {
      body state isDraft createdAt baseRefName headRefName
      viewerDidAuthor mergeable
      viewerLatestReview { state }
      assignees(first: 20) { nodes { login } }
      repository {
        viewerPermission
        mergeCommitAllowed
        squashMergeAllowed
        rebaseMergeAllowed
      }
    }
    ... on Discussion { body closed createdAt }
  }
}`;

interface GhItemNode {
  body?: unknown;
  state?: unknown;
  isDraft?: unknown;
  closed?: unknown;
  createdAt?: unknown;
  baseRefName?: unknown;
  headRefName?: unknown;
  assignees?: { nodes?: unknown };
  viewerLatestReview?: { state?: unknown };
  viewerDidAuthor?: unknown;
  mergeable?: unknown;
  repository?: {
    viewerPermission?: unknown;
    mergeCommitAllowed?: unknown;
    squashMergeAllowed?: unknown;
    rebaseMergeAllowed?: unknown;
  };
}

function itemStateOf(node: GhItemNode): ItemDetails["state"] {
  if (node.state === "MERGED") return "merged";
  if (node.state === "CLOSED" || node.closed === true) return "closed";
  if (node.isDraft === true) return "draft";
  return "open";
}

/** Repository permissions that let the viewer press Merge. */
const MERGE_PERMISSIONS: Record<string, true> = { ADMIN: true, MAINTAIN: true, WRITE: true };

/**
 * GitHub answers `UNKNOWN` while it computes the test merge, for a few seconds
 * after a push, so an unknown is a "not yet" rather than a conflict. Merge
 * stays off for both, because only `MERGEABLE` is a merge that would land.
 */
function mergeableOf(value: unknown): ReviewState["mergeable"] {
  if (value === "MERGEABLE") return "mergeable";
  if (value === "CONFLICTING") return "conflicting";
  return "unknown";
}

/** Squash first because it is the common default, then merge, then rebase. */
function mergeMethodsOf(repository: GhItemNode["repository"]): MergeMethod[] {
  const candidates: readonly (readonly [MergeMethod, unknown])[] = [
    ["squash", repository?.squashMergeAllowed],
    ["merge", repository?.mergeCommitAllowed],
    ["rebase", repository?.rebaseMergeAllowed],
  ];
  return candidates.filter(([, allowed]) => allowed === true).map(([method]) => method);
}

/**
 * What the panel is allowed to do with this pull request, decided here rather
 * than on the client so the buttons and the mutations cannot disagree.
 *
 * A draft can be reviewed, so Approve stays on for one; it cannot be merged
 * without being marked ready, which is a decision this board does not make, so
 * Merge stays off rather than offering a press that always fails.
 */
function toReviewState(node: GhItemNode, state: ItemDetails["state"]): ReviewState {
  const viewerDidAuthor = node.viewerDidAuthor === true;
  const mergeable = mergeableOf(node.mergeable);
  const settled = state === "merged" || state === "closed";
  const permission = node.repository?.viewerPermission;
  const canWrite = typeof permission === "string" && MERGE_PERMISSIONS[permission] === true;
  const mergeMethods = mergeMethodsOf(node.repository);
  // The viewer's own latest review is the only thing that answers "have I
  // approved this?": a review someone else left is not it, and a dismissed or
  // superseded one is not either.
  const viewerHasApproved = node.viewerLatestReview?.state === "APPROVED";
  return {
    viewerHasApproved,
    viewerDidAuthor,
    viewerCanApprove: !viewerDidAuthor && !settled,
    viewerCanMerge:
      canWrite && state === "open" && mergeable === "mergeable" && mergeMethods.length > 0,
    mergeable,
    mergeMethods,
  };
}

function toItemDetails(node: GhItemNode): ItemDetails {
  const assigneeNodes = node.assignees?.nodes;
  const assignees = Array.isArray(assigneeNodes)
    ? assigneeNodes
        .map((assignee) => (assignee as { login?: unknown }).login)
        .filter((login): login is string => typeof login === "string")
    : [];
  const state = itemStateOf(node);
  const branches =
    typeof node.headRefName === "string" && typeof node.baseRefName === "string"
      ? { head: node.headRefName, base: node.baseRefName }
      : null;
  return {
    state,
    body: typeof node.body === "string" ? node.body : "",
    createdAt: typeof node.createdAt === "string" ? node.createdAt : "",
    assignees,
    branches,
    // Branches are what makes it a pull request: an issue has none, and a
    // discussion has neither branches nor anything to approve.
    review: branches === null ? null : toReviewState(node, state),
  };
}

async function fetchItemDetails(id: string): Promise<ItemDetails> {
  const raw = await gh(["api", "graphql", "-f", `query=${ITEM_QUERY}`, "-f", `id=${id}`]);
  const parsed: unknown = JSON.parse(raw);
  const node = (parsed as { data?: { node?: unknown } }).data?.node;
  if (typeof node !== "object" || node === null) {
    throw new Error("GitHub no longer has this item, or the account cannot see it.");
  }
  return toItemDetails(node as GhItemNode);
}

/**
 * Cached like the board, and for the same reason: the panel is reopened on the
 * same few cards, and each open would otherwise be a `gh` subprocess. `force`
 * is the panel's Refresh button, for a body edited on GitHub in the meantime.
 */
const DETAILS_TTL_MS = 5 * 60_000;

const cachedDetails = new Map<string, { details: ItemDetails; storedAt: number }>();

export async function loadItemHandler({
  id,
  force,
}: z.output<typeof loadItem.input>): Promise<z.input<typeof loadItem.output>> {
  const hit = cachedDetails.get(id);
  if (!force && hit !== undefined && Date.now() - hit.storedAt < DETAILS_TTL_MS) {
    return hit.details;
  }
  const details = await fetchItemDetails(id);
  cachedDetails.set(id, { details, storedAt: Date.now() });
  return details;
}

const APPROVE_MUTATION = `mutation($id: ID!, $body: String!) {
  addPullRequestReview(input: { pullRequestId: $id, event: APPROVE, body: $body }) {
    pullRequestReview { state }
  }
}`;

const MERGE_MUTATION = `mutation($id: ID!, $method: PullRequestMergeMethod!) {
  mergePullRequest(input: { pullRequestId: $id, mergeMethod: $method }) {
    pullRequest { state }
  }
}`;

const MERGE_METHOD_NAMES: Record<MergeMethod, string> = {
  merge: "MERGE",
  squash: "SQUASH",
  rebase: "REBASE",
};

/**
 * A mutation, and the errors GitHub reports in a 200 body rather than as an
 * exit status. `gh` usually fails the process on those, but a partial error
 * beside partial data does not, and a merge that silently did nothing is the
 * one outcome this must never report as success.
 */
async function ghMutation(query: string, variables: Record<string, string>): Promise<void> {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [name, value] of Object.entries(variables)) {
    args.push("-f", `${name}=${value}`);
  }
  const parsed: unknown = JSON.parse(await gh(args));
  const errors =
    typeof parsed === "object" && parsed !== null && "errors" in parsed ? parsed.errors : null;
  if (!Array.isArray(errors) || errors.length === 0) return;
  const message = errors
    .map((entry) =>
      typeof entry === "object" && entry !== null && "message" in entry ? entry.message : null,
    )
    .filter((entry): entry is string => typeof entry === "string" && entry !== "")
    .join("; ");
  throw new Error(message === "" ? "GitHub rejected the request." : message);
}

/**
 * Re-reads the item past the cache and stores what came back, so the panel
 * repaints from GitHub's state after the write rather than from the caller's
 * assumption about it.
 */
async function refreshDetails(id: string): Promise<ItemDetails> {
  const details = await fetchItemDetails(id);
  cachedDetails.set(id, { details, storedAt: Date.now() });
  return details;
}

/**
 * Drops one card from the cached board. A merged pull request no longer
 * answers the `state:open` search the board runs, so leaving it in the cache
 * would show it as open again for up to five minutes after it landed.
 */
function dropCachedItem(itemId: string): void {
  if (cachedBoard === null) return;
  cachedBoard = {
    ...cachedBoard,
    columns: cachedBoard.columns.map((column) => ({
      ...column,
      items: column.items.filter((item) => item.id !== itemId),
    })),
  };
}

export async function approveHandler({
  id,
  body,
}: z.output<typeof approvePullRequest.input>): Promise<z.input<typeof approvePullRequest.output>> {
  await ghMutation(APPROVE_MUTATION, { id, body });
  return refreshDetails(id);
}

export async function mergeHandler({
  id,
  method,
}: z.output<typeof mergePullRequest.input>): Promise<z.input<typeof mergePullRequest.output>> {
  await ghMutation(MERGE_MUTATION, { id, method: MERGE_METHOD_NAMES[method] });
  const details = await refreshDetails(id);
  dropCachedItem(id);
  return details;
}

/**
 * The conversation on one card. `comments` on an issue or a pull request is
 * the flat conversation; a discussion threads one level deep, so its replies
 * are selected too and flattened with `depth: 1`. The page sizes are what a
 * panel can be scrolled through — anything longer is read on GitHub, which
 * `truncated` tells the panel to say.
 */
const COMMENTS_PAGE = 50;
const REPLIES_PAGE = 20;

const COMMENT_FIELDS = "id body createdAt author { login }";

const COMMENTS_QUERY = `query($id: ID!, $first: Int!, $replies: Int!) {
  node(id: $id) {
    ... on Issue {
      comments(first: $first) { totalCount nodes { ${COMMENT_FIELDS} } }
    }
    ... on PullRequest {
      comments(first: $first) { totalCount nodes { ${COMMENT_FIELDS} } }
    }
    ... on Discussion {
      comments(first: $first) {
        totalCount
        nodes {
          ${COMMENT_FIELDS}
          replies(first: $replies) { totalCount nodes { ${COMMENT_FIELDS} } }
        }
      }
    }
  }
}`;

interface GhCommentNode {
  id?: unknown;
  body?: unknown;
  createdAt?: unknown;
  author?: { login?: unknown };
  replies?: { totalCount?: unknown; nodes?: unknown };
}

function toComment(node: GhCommentNode, depth: number): ItemComment {
  return {
    id: typeof node.id === "string" ? node.id : "",
    author: typeof node.author?.login === "string" ? node.author.login : null,
    createdAt: typeof node.createdAt === "string" ? node.createdAt : "",
    body: typeof node.body === "string" ? node.body : "",
    depth,
  };
}

function commentNodesOf(value: unknown): GhCommentNode[] {
  const nodes = (value as { nodes?: unknown } | undefined)?.nodes;
  if (!Array.isArray(nodes)) return [];
  return nodes.filter(
    (node): node is GhCommentNode => typeof node === "object" && node !== null,
  );
}

function countOf(value: unknown): number {
  const total = (value as { totalCount?: unknown } | undefined)?.totalCount;
  return typeof total === "number" ? total : 0;
}

async function fetchComments(id: string): Promise<{ comments: ItemComment[]; truncated: boolean }> {
  const raw = await gh([
    "api",
    "graphql",
    "-f",
    `query=${COMMENTS_QUERY}`,
    "-f",
    `id=${id}`,
    "-F",
    `first=${COMMENTS_PAGE}`,
    "-F",
    `replies=${REPLIES_PAGE}`,
  ]);
  const parsed: unknown = JSON.parse(raw);
  const node = (parsed as { data?: { node?: unknown } }).data?.node;
  if (typeof node !== "object" || node === null) {
    throw new Error("GitHub no longer has this item, or the account cannot see it.");
  }
  const connection = (node as { comments?: unknown }).comments;
  const comments: ItemComment[] = [];
  let truncated = countOf(connection) > COMMENTS_PAGE;
  for (const commentNode of commentNodesOf(connection)) {
    comments.push(toComment(commentNode, 0));
    // Replies are a discussion's second level; issues and pull requests have none.
    if (countOf(commentNode.replies) > REPLIES_PAGE) truncated = true;
    for (const reply of commentNodesOf(commentNode.replies)) {
      comments.push(toComment(reply, 1));
    }
  }
  return { comments: comments.filter((comment) => comment.id !== ""), truncated };
}

/** Cached like the body, and for as long; `force` is the same Refresh button. */
const cachedComments = new Map<
  string,
  { result: { comments: ItemComment[]; truncated: boolean }; storedAt: number }
>();

export async function loadCommentsHandler({
  id,
  force,
}: z.output<typeof loadComments.input>): Promise<z.input<typeof loadComments.output>> {
  const hit = cachedComments.get(id);
  if (!force && hit !== undefined && Date.now() - hit.storedAt < DETAILS_TTL_MS) {
    return hit.result;
  }
  const result = await fetchComments(id);
  cachedComments.set(id, { result, storedAt: Date.now() });
  return result;
}

/**
 * An image out of a comment, fetched here because the app cannot: a
 * `github.com/user-attachments/assets/…` URL on a private repository answers
 * 404 to anyone without the token, and with it answers a 302 to a signed S3
 * URL good for five minutes. `fetch` follows that redirect, and drops the
 * Authorization header on the way across origins as the spec says — the S3
 * URL is signed and needs none.
 *
 * Only GitHub hosts, checked again here rather than trusted from the client,
 * because this is the daemon fetching a URL that a comment's author chose.
 */
const IMAGE_MAX_BYTES = 4 * 1024 * 1024;
const IMAGE_CACHE_ENTRIES = 24;

/** `gh auth token`, remembered for the same five minutes everything else is. */
let cachedToken: { token: string; storedAt: number } | null = null;

async function ghToken(): Promise<string> {
  if (cachedToken !== null && Date.now() - cachedToken.storedAt < DETAILS_TTL_MS) {
    return cachedToken.token;
  }
  const token = (await gh(["auth", "token"])).trim();
  if (token === "") throw new Error("GitHub CLI has no token for this account.");
  cachedToken = { token, storedAt: Date.now() };
  return token;
}

async function fetchImage(url: string): Promise<string> {
  if (!isGitHubImageHost(url)) {
    throw new Error("Only images hosted on GitHub are fetched through the daemon.");
  }
  const response = await fetch(url, {
    headers: { Authorization: `token ${await ghToken()}` },
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(`GitHub answered ${response.status} for this image.`);
  }
  const type = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
  if (!type.startsWith("image/")) {
    throw new Error(`Not an image: GitHub answered with ${type || "no content type"}.`);
  }
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > IMAGE_MAX_BYTES) {
    throw new Error("This image is too large to show here.");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > IMAGE_MAX_BYTES) {
    throw new Error("This image is too large to show here.");
  }
  return `data:${type};base64,${bytes.toString("base64")}`;
}

/**
 * A handful of images, by URL, so scrolling back through a thread does not
 * fetch a screenshot twice. Bounded by count rather than time: each entry is
 * a whole image, and the oldest is evicted when the next one arrives.
 */
const cachedImages = new Map<string, string>();

export async function loadImageHandler({
  url,
}: z.output<typeof loadImage.input>): Promise<z.input<typeof loadImage.output>> {
  const hit = cachedImages.get(url);
  if (hit !== undefined) return { dataUrl: hit };
  const dataUrl = await fetchImage(url);
  cachedImages.set(url, dataUrl);
  if (cachedImages.size > IMAGE_CACHE_ENTRIES) {
    const oldest = cachedImages.keys().next().value;
    if (oldest !== undefined) cachedImages.delete(oldest);
  }
  return { dataUrl };
}

/**
 * The host API a handler is given. Every project lookup below needs it, so it
 * is threaded down from the handler rather than reached for globally.
 */
type PaseoApi = PluginHandlerContext["paseo"];

/**
 * Paseo's own project registry, as the daemon reports it. Only the fields this
 * plugin matches on are named; the descriptor carries more.
 *
 * A project with a git remote is keyed `remote:<host>/<owner>/<name>`, always
 * lowercased, which is exactly the identity a board card carries — so a card is
 * matched to a project by that key rather than by guessing at directory names.
 * A project without a remote is keyed `host:<serverId>:<path>` and can never
 * match, which is correct: the board only ever shows remote repositories. The
 * key is optional on the wire, and a project missing one simply matches
 * nothing by key — its git remotes still get their turn.
 */
interface ProjectRecord {
  projectId: string;
  rootPath: string;
  displayName: string;
  projectKey: string;
  /**
   * `git`, `non_git`, or `directory`, as the daemon records it. Paseo offers a
   * worktree for exactly the git ones (`workspace-structure.ts`), so this is
   * what decides whether the launch dialog can offer one.
   */
  kind: string;
}

/**
 * Every project Paseo knows about, asked of the daemon rather than read off
 * disk. `projects.list` is the daemon's own view: it covers projects that have
 * no workspace open, it drops archived ones for us, and its display name is the
 * one the user renamed the project to — none of which reading `projects.json`
 * gave us. Requested without a `sync` cursor, so the answer is always the whole
 * list rather than a diff against a cursor this plugin does not keep.
 */
async function readProjects(paseo: PaseoApi): Promise<ProjectRecord[]> {
  const { projects } = await paseo.projects.list();
  return projects.map((project) => ({
    projectId: project.projectId,
    rootPath: project.projectRootPath,
    displayName: project.projectDisplayName,
    projectKey: project.projectKey ?? "",
    kind: project.projectKind,
  }));
}

/**
 * A repository's identity as both a project key and a git remote spell it:
 * `<host>/<owner>/<name>`, lowercased. The host comes from the item's own URL
 * rather than a hardcoded `github.com`, so a GitHub Enterprise card matches the
 * enterprise project and not a same-named repository on github.com.
 */
function repositoryIdFor(repository: string, url: string): string | null {
  if (!repository.includes("/")) return null;
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return null;
  }
  if (host === "") return null;
  return `${host}/${repository}`.toLowerCase();
}

/**
 * Normalises any git remote URL to the same `<host>/<owner>/<name>` form,
 * covering the scp-like `git@host:owner/name.git` that `new URL` cannot parse
 * alongside the `https://` and `ssh://` spellings.
 */
function normalizeRemoteUrl(remote: string): string | null {
  const trimmed = remote.trim();
  if (trimmed === "") return null;

  let host: string;
  let path: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      host = parsed.host;
      path = parsed.pathname;
    } catch {
      return null;
    }
  } else {
    const scp = /^(?:[^@/]+@)?([^/:]+):(.+)$/.exec(trimmed);
    if (scp === null || scp[1] === undefined || scp[2] === undefined) return null;
    host = scp[1];
    path = scp[2];
  }

  const name = path
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  if (host === "" || name === "") return null;
  return `${host}/${name}`.toLowerCase();
}

/**
 * Every repository the checkout at `root` points at, not just `origin`. A fork
 * conventionally keeps the repository it was forked from as `upstream`, and a
 * card always names the repository the issue or pull request lives in — the
 * parent — so `origin` alone cannot match work done from a fork.
 *
 * A directory that is not a git checkout, or has gone missing, contributes
 * nothing rather than failing the search for every other project.
 */
async function gitRemotes(root: string): Promise<string[]> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("git", ["-C", root, "remote", "-v"], {
      maxBuffer: MAX_OUTPUT_BYTES,
    }));
  } catch {
    return [];
  }
  const seen = new Set<string>();
  for (const line of stdout.split("\n")) {
    const url = line.trim().split(/\s+/)[1];
    if (url === undefined) continue;
    const normalized = normalizeRemoteUrl(url);
    if (normalized !== null) seen.add(normalized);
  }
  return [...seen];
}

/**
 * Every live project, and every repository id that reaches one. Built once and
 * shared by the board (which labels each card's project) and by the send button
 * (which needs the project's directory), so the `git` subprocess per project is
 * paid once rather than per lookup.
 */
interface ProjectIndex {
  projects: ProjectRecord[];
  /** `<host>/<owner>/<name>` to the project it belongs to. */
  byRepositoryId: Map<string, ProjectRecord>;
}

const PROJECT_INDEX_TTL_MS = 5 * 60_000;

let cachedProjectIndex: { index: ProjectIndex; storedAt: number } | null = null;

async function buildProjectIndex(paseo: PaseoApi): Promise<ProjectIndex> {
  const projects = await readProjects(paseo);
  const byRepositoryId = new Map<string, ProjectRecord>();

  // `projectKey` first, across all projects, because it is the repository Paseo
  // itself considers a project's home. Only then the other remotes, and only
  // where nothing has claimed the id — so a repository that is one project's
  // origin and another's upstream resolves to the one it belongs to.
  for (const project of projects) {
    const key = project.projectKey.toLowerCase();
    if (!key.startsWith("remote:")) continue;
    const repositoryId = key.slice("remote:".length);
    if (!byRepositoryId.has(repositoryId)) byRepositoryId.set(repositoryId, project);
  }

  const scanned = await Promise.all(
    projects.map(async (project) => ({ project, remotes: await gitRemotes(project.rootPath) })),
  );
  for (const { project, remotes } of scanned) {
    for (const repositoryId of remotes) {
      if (!byRepositoryId.has(repositoryId)) byRepositoryId.set(repositoryId, project);
    }
  }

  return { projects, byRepositoryId };
}

async function loadProjectIndex(paseo: PaseoApi, force = false): Promise<ProjectIndex> {
  if (
    !force &&
    cachedProjectIndex !== null &&
    Date.now() - cachedProjectIndex.storedAt < PROJECT_INDEX_TTL_MS
  ) {
    return cachedProjectIndex.index;
  }
  const index = await buildProjectIndex(paseo);
  cachedProjectIndex = { index, storedAt: Date.now() };
  return index;
}

/**
 * A miss is retried against a freshly built index, so a project added moments
 * ago is found instead of being denied for the rest of the cache window.
 */
async function findProject(
  paseo: PaseoApi,
  repositoryId: string,
): Promise<ProjectRecord | undefined> {
  const cached = await loadProjectIndex(paseo);
  const hit = cached.byRepositoryId.get(repositoryId);
  if (hit !== undefined) return hit;
  const fresh = await loadProjectIndex(paseo, true);
  return fresh.byRepositoryId.get(repositoryId);
}

/** Workspace titles are capped at the same length the daemon caps agent titles. */
const MAX_TITLE_CHARS = 200;

/**
 * The project one card can be sent to, or a refusal that says what to do about
 * it. Both handlers below start here, so "no project" reads the same whether
 * the dialog is opening or the send is running.
 */
async function requireProject(
  paseo: PaseoApi,
  repository: string,
  url: string,
): Promise<ProjectRecord> {
  const repositoryId = repositoryIdFor(repository, url);
  if (repositoryId === null) {
    throw new Error(`${repository} has no repository URL to match a project against.`);
  }

  const project = await findProject(paseo, repositoryId);
  if (project === undefined) {
    throw new Error(
      `No Paseo project has a git remote pointing at ${repository}. Add it as a project — or add it as a remote on the fork you already have — then send this card again.`,
    );
  }
  return project;
}

export async function sendOptionsHandler(
  { repository, url }: z.output<typeof sendOptions.input>,
  { paseo }: PluginHandlerContext,
): Promise<z.input<typeof sendOptions.output>> {
  const [project, settings] = await Promise.all([
    requireProject(paseo, repository, url),
    readSettings(),
  ]);
  const supportsWorktree = project.kind === "git";
  return {
    project: {
      id: project.projectId,
      name: project.displayName,
      rootPath: project.rootPath,
      supportsWorktree,
    },
    // A worktree preference saved against a git project must not survive into a
    // project that has no worktrees to offer, or the dialog opens on a choice
    // its own picker cannot show.
    defaults: supportsWorktree ? settings.launch : { ...settings.launch, isolation: "local" },
  };
}

export async function sendToChatHandler(
  {
    repository,
    number,
    title,
    url,
    author,
    labels,
    prompt,
    isolation,
    provider,
    model,
    modeId,
    thinkingOptionId,
  }: z.output<typeof sendToChat.input>,
  { paseo }: PluginHandlerContext,
): Promise<z.input<typeof sendToChat.output>> {
  const project = await requireProject(paseo, repository, url);
  if (isolation === "worktree" && project.kind !== "git") {
    throw new Error(`${project.displayName} is not a git checkout, so it cannot be worktreed.`);
  }

  const trimmed = title.trim();
  /**
   * `firstAgentContext` is passed here and *only* here, because this handler
   * really does create the agent it promises. The daemon reads it two ways: as
   * naming context for the workspace and its branch, and as `expectsInitialAgent`,
   * which flips the new workspace to an optimistic `running`. A caller that
   * passes it and then creates nothing leaves a workspace spinning until it
   * settles on `done`.
   */
  const workspace = await paseo.workspaces.create({
    title: (trimmed === "" ? `${repository} #${number}` : trimmed).slice(0, MAX_TITLE_CHARS),
    firstAgentContext: { prompt, attachments: [] },
    source:
      isolation === "worktree"
        ? {
            // No `worktreeSlug`: the daemon mints a mnemonic one, and then
            // renames the branch after the prompt once the agent is running.
            kind: "worktree",
            cwd: project.rootPath,
            projectId: project.projectId,
          }
        : { kind: "directory", path: project.rootPath, projectId: project.projectId },
  });

  /**
   * The agent is created *in* the workspace, so the SDK places it on the
   * workspace's own directory — the worktree's path, not the project root, when
   * one was cut. `prompt` rides along as the first message rather than being
   * sent afterwards, so there is no window where the workspace exists with a
   * silent agent in it.
   */
  const agent = await workspace.agents
    .create({
      config: {
        // `provider/model`, which is the only spelling the SDK accepts.
        provider: `${provider}/${model}`,
        ...(modeId === null ? {} : { modeId }),
        ...(thinkingOptionId === null ? {} : { thinkingOptionId }),
      },
      prompt,
    })
    .catch((cause: unknown) => {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new Error(
        `Workspace “${workspace.name ?? project.displayName}” was created, but the agent could not be started: ${detail}`,
      );
    });

  /**
   * The card the agent is working on, as a persisted row in its own transcript.
   *
   * It lands *after* the opening prompt rather than above it, because the prompt
   * rides along with `agents.create` and there is no agent to append to until
   * that has resolved. That ordering is the price of not opening a window where
   * the workspace exists with a silent agent in it, which matters more.
   *
   * Deliberately not fatal. By this point the workspace and the agent both
   * exist and the prompt has been delivered — the send the user asked for has
   * happened. Failing it here would report an error for a launch that worked and
   * invite the user to send the card a second time, which would cut a second
   * worktree. A missing row costs the transcript its header and nothing else.
   */
  await agent.timeline
    .append({
      type: "plugin",
      id: `${BOARD_ITEM_TIMELINE_KIND}:${repository}#${number}`,
      kind: BOARD_ITEM_TIMELINE_KIND,
      version: BOARD_ITEM_TIMELINE_VERSION,
      data: { repository, number, title, url, author, labels },
    })
    .catch((cause: unknown) => {
      console.warn("[github-board] could not append the timeline row", cause);
    });

  // Saved only once the send has actually worked, so a configuration that the
  // host rejected is not what the next card opens on.
  await updateSettings({ launch: { provider, model, modeId, thinkingOptionId, isolation } });

  return {
    workspaceId: workspace.id,
    workspaceName: workspace.name ?? project.displayName,
    projectName: project.displayName,
    agentId: agent.id,
  };
}
