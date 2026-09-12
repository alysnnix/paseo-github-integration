#!/usr/bin/env node
// Used by .github/workflows/release.yml once `git verify-tag` has already
// confirmed the tag itself is signed. This script checks that the tag names
// the version this checkout actually is, and extracts that version's
// CHANGELOG.md section verbatim — the release body is never regenerated
// from commit messages, so what ships is exactly what a human wrote and
// reviewed.
//
// Usage:
//   node scripts/verify-release.mjs <tag>          exits 0 if the tag matches
//                                                   package.json and CHANGELOG.md
//                                                   has a released section for it
//   node scripts/verify-release.mjs <tag> --notes  same check, then prints the
//                                                   CHANGELOG section to stdout

import { readFileSync } from "node:fs";

const [, , rawTag, flag] = process.argv;
if (!rawTag) {
  console.error("usage: verify-release.mjs <tag> [--notes]");
  process.exit(2);
}

const tagVersion = rawTag.startsWith("v") ? rawTag.slice(1) : rawTag;
const pkg = JSON.parse(readFileSync("package.json", "utf8"));

if (pkg.version !== tagVersion) {
  console.error(
    `tag "${rawTag}" names version "${tagVersion}", but package.json version is "${pkg.version}"`,
  );
  process.exit(1);
}

const changelog = readFileSync("CHANGELOG.md", "utf8");
const lines = changelog.split("\n");
const headingRe = /^##\s*\[([^\]]+)\]/;

let start = -1;
for (let i = 0; i < lines.length; i++) {
  const match = headingRe.exec(lines[i]);
  if (match !== null && match[1] === tagVersion) {
    start = i;
    break;
  }
}
if (start === -1) {
  console.error(`CHANGELOG.md has no released "## [${tagVersion}]" section`);
  process.exit(1);
}

let end = lines.length;
for (let i = start + 1; i < lines.length; i++) {
  if (headingRe.test(lines[i])) {
    end = i;
    break;
  }
}

if (flag === "--notes") {
  console.log(lines.slice(start, end).join("\n").trim());
} else {
  console.log(`ok: tag "${rawTag}" matches package.json and CHANGELOG.md "${tagVersion}"`);
}
