import type { z } from "zod";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { BoardColumn, BoardItem, loadBoard } from "../../shared/board";
import { resolveViewerLogin } from "../github/gh";
import { readSettings } from "../settings/settings";
import { loadProjectIndex, repositoryIdFor } from "../launch/project-index";
import type { PaseoApi } from "../launch/project-index";
import { fetchDiscussions } from "./discussions";
import { fetchIssues } from "./issues";
import { fetchPullRequests } from "./pull-requests";
import { boardCache, BOARD_TTL_MS } from "./cache";

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
      const project = index.byRepositoryId[repositoryId];
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

  const { columns, fetchedAt } = await boardCache.get(
    key,
    BOARD_TTL_MS,
    async () => {
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

      return { columns, fetchedAt: new Date().toISOString() };
    },
    {
      force,
      // A column that failed is not worth remembering: caching it would keep the
      // error on screen for the whole window even though a retry might succeed.
      shouldCache: (cached) => cached.columns.every((column) => column.error === null),
    },
  );

  return {
    login: resolved,
    ...(await describeRepositoryProjects(paseo, columns)),
    columns,
    fetchedAt,
  };
}
