/**
 * Shared, so it lands in both bundles: the client uses it to decide whether an
 * image needs the daemon, and the server to refuse anything else. Like every
 * `shared/` module it must stay free of Node and React imports.
 */
/**
 * Hosts whose images the server fetches on the client's behalf. An attachment
 * on a private repository answers 404 without the `gh` token, and the token
 * lives on the daemon — the app never sees it. Anything else the app loads
 * itself: sending the daemon after an arbitrary URL from a comment anyone
 * could have written is a fetch nobody asked for.
 */
export function isGitHubImageHost(url: string): boolean {
  // Parsed, never matched. A regex over the raw string decides on different
  // text than `fetch` does: WHATWG ends the host at a backslash too, so
  // `https://evil.example\.githubusercontent.com/a.png` reads as the
  // attacker's host to `fetch` and as a GitHub subdomain to a pattern, which
  // is the daemon handing `gh auth token` to whoever wrote the comment.
  let host: URL;
  try {
    host = new URL(url);
  } catch {
    return false;
  }
  if (host.protocol !== "https:") return false;
  // Credentials in the URL are refused rather than parsed around: they carry
  // no meaning for a GitHub attachment and they are the other half of every
  // host-confusion trick.
  if (host.username !== "" || host.password !== "") return false;
  const name = host.hostname.toLowerCase();
  return name === "github.com" || name.endsWith(".githubusercontent.com");
}

