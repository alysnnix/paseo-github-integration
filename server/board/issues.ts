import type { BoardItem } from "../../shared/board";
import { ownedBuckets, personalBuckets, runBuckets, mergeBucketResults } from "./buckets";
import { toItem } from "./item";
import type { GhSearchNode } from "./types";
import { UNARCHIVED_ONLY } from "./types";

const ISSUE_SELECTION = `... on Issue {
  id
  number
  title
  url
  updatedAt
  createdAt
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
export async function fetchIssues(
  login: string,
  owners: readonly string[],
  limit: number,
): Promise<BoardItem[]> {
  const scope = `is:issue state:open ${UNARCHIVED_ONLY} sort:updated-desc`;
  const buckets = [...personalBuckets(login, false), ...ownedBuckets(owners)];
  const results = await runBuckets("ISSUE", ISSUE_SELECTION, buckets, scope, limit);
  return mergeBucketResults<GhSearchNode>(results, (node) => toItem(node, null), limit);
}
