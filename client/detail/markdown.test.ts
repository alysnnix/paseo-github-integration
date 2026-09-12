import { describe, expect, it } from "vitest";
import { MAX_NESTING_DEPTH } from "./html";
import { parseMarkdown, TABLE_SEPARATOR, type Block } from "./markdown-parse";

/** How many "quote" blocks are nested inside one another, walking down `blocks`. */
function quoteNestingDepth(blocks: Block[]): number {
  let deepest = 0;
  for (const block of blocks) {
    if (block.kind !== "quote") continue;
    deepest = Math.max(deepest, 1 + quoteNestingDepth(block.blocks));
  }
  return deepest;
}

describe("parseMarkdown", () => {
  it("returns rather than overflowing the stack on thousands of nested quote levels", () => {
    // Nothing sanitises a comment body before it reaches the renderer: a
    // single line of ~5,000 `>` characters used to recurse `parseBlocks`
    // once per level, deep enough to blow the JavaScript stack during React
    // render with no error boundary to catch it.
    const source = `${">".repeat(5000)} a comment nobody sanitised`;
    const blocks = parseMarkdown(source);
    expect(quoteNestingDepth(blocks)).toBeLessThanOrEqual(MAX_NESTING_DEPTH);
  });
});

describe("TABLE_SEPARATOR", () => {
  it("rejects a long whitespace-only line in well under a second", () => {
    // `^\s*\|?\s*` used to let two adjacent `\s*` groups fight over the same
    // whitespace whenever the optional `|` between them was absent, which is
    // quadratic to reject. A generous bound keeps this from being flaky on a
    // slow CI machine while still catching a reintroduced O(n²) regex, which
    // would take seconds rather than milliseconds here.
    const line = " ".repeat(65536);
    const start = performance.now();
    const matched = TABLE_SEPARATOR.test(line);
    const elapsed = performance.now() - start;
    expect(matched).toBe(false);
    expect(elapsed).toBeLessThan(500);
  });
});
