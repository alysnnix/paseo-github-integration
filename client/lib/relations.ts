import type { Relation } from "../../shared/board";
import { RELATION_IDS } from "../../shared/board";
import type { BoardMode } from "./board-modes";

/**
 * The relation filter chips, in the order the filter bar shows them. `"all"`
 * is not a `Relation` GitHub reports — it means "every relation" — so it is
 * spelled out here rather than folded into `RELATION_IDS`.
 *
 * `modes` is the set of switcher modes a chip means anything in: GitHub only
 * requests review on a pull request, so the chip is dead weight on the issues
 * and discussions lists, where it would read as a permanent zero and, once
 * picked, empty the list with no way to tell why.
 */
export const RELATION_FILTERS: readonly { id: string; label: string; modes?: readonly BoardMode[] }[] = [
  { id: "all", label: "All" },
  { id: "review-requested", label: "Needs my review", modes: ["pull-requests"] },
  { id: "mentioned", label: "Mentions me" },
  { id: "assigned", label: "Assigned to me" },
  { id: "author", label: "Mine" },
  { id: "owned", label: "Other" },
];

/** Whether a saved or freshly-picked string is one of the relations GitHub reports. */
export function isRelation(value: string): value is Relation {
  return (RELATION_IDS as readonly string[]).includes(value);
}
