import { expect, it } from "vitest";
import { ProjectItemSchema } from "../../shared/board";
import { toProjectItem } from "./single";

it("preserves project PR review status through the RPC schema", () => {
  for (const [decision, expected] of [
    ["APPROVED", "approved"],
    ["CHANGES_REQUESTED", "changes-requested"],
    ["REVIEW_REQUIRED", "review-required"],
  ]) {
    const item = ProjectItemSchema.parse(
      toProjectItem({
        __typename: "PullRequest",
        state: "OPEN",
        reviewDecision: decision,
      }),
    );
    expect(item.prReview).toBe(expected);
  }
});

it("uses current opinions when projects have no required review decision", () => {
  expect(
    toProjectItem({
      __typename: "PullRequest",
      state: "OPEN",
      reviewDecision: null,
      latestOpinionatedReviews: {
        nodes: [{ state: "APPROVED" }],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    })?.prReview,
  ).toBe("approved");
  expect(toProjectItem({ __typename: "Issue", reviewDecision: "APPROVED" })?.prReview).toBeNull();
});

it("shows a closed project PR as closed even when it was a draft", () => {
  expect(toProjectItem({ __typename: "PullRequest", state: "CLOSED", isDraft: true })?.state).toBe(
    "closed",
  );
});
