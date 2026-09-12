import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Cache } from "./cache";

// `Cache` reads `XDG_STATE_HOME` (via `cacheDataDir`) once per instance, at
// construction time, so every test gets its own throwaway directory under the
// OS temp dir rather than touching the real user state directory.
let dataDir: string;
const originalXdgStateHome = process.env.XDG_STATE_HOME;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "github-integration-cache-test-"));
  process.env.XDG_STATE_HOME = dataDir;
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});

afterEach(async () => {
  vi.useRealTimers();
  if (originalXdgStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = originalXdgStateHome;
  await rm(dataDir, { recursive: true, force: true });
});

describe("Cache.get", () => {
  it("answers from memory within the TTL without calling the loader again", async () => {
    const cache = new Cache<number>("ttl-hit");
    const load = vi.fn().mockResolvedValue(1);
    expect(await cache.get("k", 10_000, load)).toBe(1);
    vi.setSystemTime(1_000_000 + 9_999);
    expect(await cache.get("k", 10_000, load)).toBe(1);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("reloads once the entry is older than the TTL", async () => {
    const cache = new Cache<number>("ttl-miss");
    const load = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    expect(await cache.get("k", 10_000, load)).toBe(1);
    vi.setSystemTime(1_000_000 + 10_001);
    expect(await cache.get("k", 10_000, load)).toBe(2);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight load between concurrent callers for the same key", async () => {
    const cache = new Cache<number>("single-flight");
    const load = vi.fn().mockResolvedValue(7);
    // Both calls are issued before either resolves, so the second must join
    // the first's in-flight sweep rather than starting its own.
    const [first, second] = await Promise.all([
      cache.get("k", 10_000, load),
      cache.get("k", 10_000, load),
    ]);
    expect(first).toBe(7);
    expect(second).toBe(7);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("persists across instances so a fresh Cache resumes without reloading", async () => {
    const first = new Cache<string>("persisted");
    await first.get("k", 10_000, () => Promise.resolve("stored value"));

    const second = new Cache<string>("persisted");
    const load = vi.fn().mockResolvedValue("should not be used");
    // Same faked "current" time, so the entry the second instance hydrates
    // from disk is still within its TTL: a real reload here would mean
    // persistence did not actually round-trip.
    expect(await second.get("k", 10_000, load)).toBe("stored value");
    expect(load).not.toHaveBeenCalled();
  });

  it("writes JSON to the on-disk cache file a persisted instance can read back", async () => {
    const cache = new Cache<string>("on-disk");
    await cache.get("k", 10_000, () => Promise.resolve("v"));
    const raw = await readFile(join(dataDir, "paseo-github-integration", "cache", "on-disk.json"), "utf8");
    const parsed = JSON.parse(raw) as Record<string, { value: string; storedAt: number }>;
    expect(parsed.k?.value).toBe("v");
  });
});

describe("Cache.invalidate", () => {
  it("drops the entry so the next get reloads regardless of its age", async () => {
    const cache = new Cache<number>("invalidate");
    const load = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    expect(await cache.get("k", 10_000, load)).toBe(1);
    await cache.invalidate("k");
    // Still well within the TTL window; only invalidation should force a reload.
    expect(await cache.get("k", 10_000, load)).toBe(2);
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe("Cache.patchAll", () => {
  it("rewrites every cached value in place without resetting its stored age", async () => {
    const cache = new Cache<{ n: number }>("patch-all");
    await cache.set("a", { n: 1 });
    await cache.set("b", { n: 10 });

    await cache.patchAll((value) => ({ n: value.n + 1 }));

    const load = vi.fn().mockResolvedValue({ n: -1 });
    // Still inside the TTL relative to the original `set` time, so the
    // patched value must come back untouched by `load`.
    vi.setSystemTime(1_000_000 + 500);
    expect(await cache.get("a", 10_000, load)).toEqual({ n: 2 });
    expect(await cache.get("b", 10_000, load)).toEqual({ n: 11 });
    expect(load).not.toHaveBeenCalled();

    // Patching must not refresh `storedAt`: once the original age crosses
    // the TTL, a get still reloads even though patchAll ran more recently.
    vi.setSystemTime(1_000_000 + 10_001);
    expect(await cache.get("a", 10_000, load)).toEqual({ n: -1 });
    expect(load).toHaveBeenCalledTimes(1);
  });
});
