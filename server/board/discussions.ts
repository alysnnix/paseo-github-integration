import type { BoardItem } from "../../shared/board";
import { ownedBuckets, runBuckets, mergeBucketResults } from "./buckets";
import { toItem } from "./item";
import type { GhSearchNode, RelationBucket } from "./types";

const DISCUSSION_SELECTION = `... on Discussion {
  id
  number
  title
  url
  updatedAt
  createdAt
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
export async function fetchDiscussions(
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
