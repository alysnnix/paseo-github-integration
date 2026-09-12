import type { z } from "zod";
import type { loadImage } from "../../shared/board";
import { isGitHubImageHost } from "../../shared/image-host";
import { gh } from "../github/gh";
import { Cache } from "../cache/cache";

/**
 * An image out of a comment, fetched here because the app cannot: a
 * `github.com/user-attachments/assets/…` URL on a private repository answers
 * 404 to anyone without the token, and with it answers a 302 to a signed S3
 * URL good for five minutes. `fetch` follows that redirect, and drops the
 * Authorization header on the way across origins as the spec says — the S3
 * URL is signed and needs none.
 *
 * Only GitHub hosts, checked again here rather than trusted from the client,
 * because this is the daemon fetching a URL that a comment's author chose.
 */
const IMAGE_MAX_BYTES = 4 * 1024 * 1024;
const IMAGE_CACHE_ENTRIES = 24;

/** `gh auth token`, remembered for the same five minutes everything else is. */
const TOKEN_TTL_MS = 5 * 60_000;
const TOKEN_KEY = "token";
const tokenCache = new Cache<string>("github-token");

async function ghToken(): Promise<string> {
  return tokenCache.get(TOKEN_KEY, TOKEN_TTL_MS, async () => {
    const token = (await gh(["auth", "token"])).trim();
    if (token === "") throw new Error("GitHub CLI has no token for this account.");
    return token;
  });
}

async function fetchImage(url: string): Promise<string> {
  if (!isGitHubImageHost(url)) {
    throw new Error("Only images hosted on GitHub are fetched through the daemon.");
  }
  const response = await fetch(url, {
    headers: { Authorization: `token ${await ghToken()}` },
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(`GitHub answered ${response.status} for this image.`);
  }
  const type = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
  if (!type.startsWith("image/")) {
    throw new Error(`Not an image: GitHub answered with ${type || "no content type"}.`);
  }
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > IMAGE_MAX_BYTES) {
    throw new Error("This image is too large to show here.");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > IMAGE_MAX_BYTES) {
    throw new Error("This image is too large to show here.");
  }
  return `data:${type};base64,${bytes.toString("base64")}`;
}

/**
 * A handful of images, by URL, so scrolling back through a thread does not
 * fetch a screenshot twice. Bounded by count rather than time, unlike every
 * other cache in this plugin: each entry is a whole image rather than
 * something with a meaningful staleness window, so a plain count-bounded map
 * is kept here instead of routing through the shared TTL cache.
 */
const cachedImages = new Map<string, string>();

export async function loadImageHandler({
  url,
}: z.output<typeof loadImage.input>): Promise<z.input<typeof loadImage.output>> {
  const hit = cachedImages.get(url);
  if (hit !== undefined) return { dataUrl: hit };
  const dataUrl = await fetchImage(url);
  cachedImages.set(url, dataUrl);
  if (cachedImages.size > IMAGE_CACHE_ENTRIES) {
    const oldest = cachedImages.keys().next().value;
    if (oldest !== undefined) cachedImages.delete(oldest);
  }
  return { dataUrl };
}
