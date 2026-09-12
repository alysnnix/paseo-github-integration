#!/usr/bin/env node
// Rule: the version in package.json, nix/plugin.nix and the newest released
// CHANGELOG.md heading must agree.
//
// The plugin ships with no build step (see nix/plugin.nix), so nothing
// derives one of these from another the way a bundler's version-stamping
// would: they are three hand-edited numbers, and a release is only honest
// if all three moved together. `## [Unreleased]` is allowed to sit above
// them — it is not a release yet.

import { readFileSync } from "node:fs";

const ROOT = process.cwd();
const violations = [];

function readJsonVersion(path) {
  const json = JSON.parse(readFileSync(`${ROOT}/${path}`, "utf8"));
  if (typeof json.version !== "string") {
    violations.push({ file: path, message: "has no string \"version\" field" });
    return null;
  }
  return json.version;
}

function readNixVersion(path) {
  const text = readFileSync(`${ROOT}/${path}`, "utf8");
  const match = /^\s*version\s*=\s*"([^"]+)"\s*;/m.exec(text);
  if (match === null) {
    violations.push({ file: path, message: 'has no `version = "...";` assignment' });
    return null;
  }
  return { version: match[1], line: text.slice(0, match.index).split("\n").length };
}

function readChangelogVersion(path) {
  const text = readFileSync(`${ROOT}/${path}`, "utf8");
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const match = /^##\s*\[([^\]]+)\]/.exec(lines[i]);
    if (match === null) continue;
    if (match[1].toLowerCase() === "unreleased") continue;
    return { version: match[1], line: i + 1 };
  }
  violations.push({ file: path, message: "has no released `## [x.y.z]` heading" });
  return null;
}

const packageVersion = readJsonVersion("package.json");
const nix = readNixVersion("nix/plugin.nix");
const changelog = readChangelogVersion("CHANGELOG.md");

if (packageVersion !== null && nix !== null && packageVersion !== nix.version) {
  violations.push({
    file: "nix/plugin.nix",
    line: nix.line,
    message: `version "${nix.version}" does not match package.json version "${packageVersion}"`,
  });
}
if (packageVersion !== null && changelog !== null && packageVersion !== changelog.version) {
  violations.push({
    file: "CHANGELOG.md",
    line: changelog.line,
    message: `newest released heading is "${changelog.version}", package.json version is "${packageVersion}"`,
  });
}

if (violations.length === 0) {
  console.log(`version-consistency: ok (${packageVersion})`);
  process.exit(0);
}

console.error(`version-consistency: ${violations.length} mismatch(es)`);
for (const v of violations) {
  const at = v.line !== undefined ? `:${v.line}` : "";
  console.error(`  ${v.file}${at}: ${v.message}`);
}
process.exit(1);
