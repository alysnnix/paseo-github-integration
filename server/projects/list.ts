import type { z } from "zod";
import type { ProjectSummary, listProjects } from "../../shared/board";
import { aliasName, ghGraphqlRaw, nodesOf } from "../github/graphql";
import { resolveViewerLogin } from "../github/gh";
import { Cache } from "../cache/cache";
import { readSettings } from "../settings/settings";
import { needsProjectScope, PROJECT_SCOPE_MESSAGE } from "./scope";

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

const PROJECTS_TTL_MS = 5 * 60_000;

type ListProjectsResult = z.input<typeof listProjects.output>;

const projectsCache = new Cache<ListProjectsResult>("projects");

export async function listProjectsHandler({
  login,
  owners,
  force,
}: z.output<typeof listProjects.input>): Promise<ListProjectsResult> {
  const requested = login?.trim();
  const settings = await readSettings();
  const resolved =
    requested !== undefined && requested !== "" && requested !== "@me"
      ? requested
      : (settings.login ?? (await resolveViewerLogin()));

  const key = `${resolved}\u0000${[...owners].sort().join(",")}`;

  return projectsCache.get(
    key,
    PROJECTS_TTL_MS,
    async () => {
      const orderBy = "orderBy: { field: UPDATED_AT, direction: DESC }";
      const ownerAliases = owners
        .map(
          (_, index) =>
            `${aliasName(index)}: organization(login: $${aliasName(index)}) { projectsV2(first: 20, ${orderBy}) { nodes { ${PROJECT_SUMMARY_FIELDS} } } }`,
        )
        .join("\n  ");
      const vars = ["$self: String!", ...owners.map((_, index) => `$${aliasName(index)}: String!`)].join(
        ", ",
      );
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
      return { projects, error: null, needsScope: false };
    },
    {
      force,
      // A failed sweep (no scope, a transient GitHub error) is not worth
      // remembering: it should not linger on screen for the whole TTL window.
      shouldCache: (result) => result.error === null,
    },
  );
}
