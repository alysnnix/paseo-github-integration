import type { BoardItem } from "../../shared/board";

/**
 * Separators are noise in a search box: `octo-org/checkout-frontend` is the
 * same repository whether it is typed with the slash, with the hyphens, or as
 * two plain words. Every side of a comparison goes through this, so "checkout
 * frontend" and "octo org" both land on the same normalised haystack.
 */
export function normalizeSearchText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Which part of a card one typed word is about. */
type SearchField = "any" | "repository" | "number" | "author";

interface SearchTerm {
  field: SearchField;
  /** Already normalised, and never empty: a lone sigil is dropped while it is being typed. */
  value: string;
}

/**
 * The sigils the box understands, each claiming one field. A bare word still
 * searches title, repository and number together, which is what someone who
 * has never seen this types.
 */
const SEARCH_FIELD_BY_SIGIL: Record<string, SearchField> = {
  "/": "repository",
  "#": "number",
  "@": "author",
};

/**
 * Splits the box into terms that all have to match. Words are separated by
 * spaces, so `/frontend @dependabot` is "a frontend repository, opened by
 * dependabot"; a word carrying no sigil keeps the old broad behaviour. A term
 * is *not* re-split on the separators `normalizeSearchText` flattens, so
 * `/checkout-frontend` stays one phrase rather than two independent words.
 */
export function parseSearchQuery(query: string): SearchTerm[] {
  const terms: SearchTerm[] = [];
  for (const word of query.split(/\s+/)) {
    if (word === "") continue;
    const field = SEARCH_FIELD_BY_SIGIL[word[0] ?? ""] ?? "any";
    const rest = field === "any" ? word : word.slice(1);
    const value = field === "number" ? rest.replace(/\D+/g, "") : normalizeSearchText(rest);
    if (value === "") continue;
    terms.push({ field, value });
  }
  return terms;
}

/**
 * Whether one card satisfies every term. Terms are AND-ed, because narrowing
 * is what a second word is for; within a `"any"` term the three fields are
 * OR-ed, since the user has not said which one they meant.
 */
export function matchesSearchTerms(item: BoardItem, terms: readonly SearchTerm[]): boolean {
  if (terms.length === 0) return true;
  const title = normalizeSearchText(item.title);
  const repository = normalizeSearchText(item.repository);
  const author = item.author === null ? "" : normalizeSearchText(item.author);
  const number = String(item.number);
  for (const term of terms) {
    const matched =
      term.field === "repository"
        ? repository.includes(term.value)
        : term.field === "author"
          ? author.includes(term.value)
          : term.field === "number"
            ? number.includes(term.value)
            : title.includes(term.value) ||
              repository.includes(term.value) ||
              number.includes(term.value);
    if (!matched) return false;
  }
  return true;
}

/**
 * Whether a repository matches a picker query. Both sides lose their
 * separators, so `octo-org/checkout-frontend` answers to "octo org",
 * to "checkout frontend" and to "frontend" alike — the owner does not have to
 * be typed first, and a hyphen the user did not type is not a miss.
 */
export function repositoryMatchesQuery(repository: string, query: string): boolean {
  const haystack = normalizeSearchText(repository);
  const words = normalizeSearchText(query).split(" ");
  return words.every((word) => word === "" || haystack.includes(word));
}
