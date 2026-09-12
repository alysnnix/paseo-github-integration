import { describe, expect, it } from "vitest";
import { htmlToMarkdown } from "./html";

describe("htmlToMarkdown", () => {
  it("handles a 65 KB unterminated backtick run in well under a second", () => {
    // The old token regex, `(`+)[^`\n]*?\1|<...`, matched a code span with a
    // backreference after a greedy quantifier: quadratic on a long run of
    // backticks with no closing run, because the engine retries every
    // possible length of the opening run at every position before giving up.
    // Wrapping it in a real tag keeps `htmlToMarkdown`'s early-exit guard
    // (source has no `<letter`) from skipping the conversion entirely, so
    // this actually exercises the tokenizer the fix rewrote.
    const html = `<div>${"`".repeat(65536)}</div>`;
    const start = performance.now();
    const result = htmlToMarkdown(html);
    const elapsed = performance.now() - start;
    expect(result).toContain("`");
    expect(elapsed).toBeLessThan(500);
  });
});
