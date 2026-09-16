import { Pressable, Text, View } from "react-native";
import type { Styles } from "../theme/use-styles";
import { openExternalUrl } from "../web";
import type { useSearchResults } from "./use-search-results";

export function ResultsToolbar({
  search,
  preview,
  canRefresh,
  styles,
}: {
  search: ReturnType<typeof useSearchResults>;
  preview: boolean;
  canRefresh: boolean;
  styles: Styles;
}) {
  return (
    <View style={styles.banner}>
      <Text style={styles.sectionHint}>
        {preview ? "Preview · " : ""}
        {search.isFetching
          ? "Loading…"
          : search.page === null
            ? "Create a view to search GitHub pull requests."
            : `${search.items.length} of ${search.page.total} pull requests · GitHub search order`}
      </Text>
      {search.error === null ? null : <Text style={styles.danger}>{search.error.message}</Text>}
      {search.page === null ? null : (
        <Text selectable style={styles.sectionHint}>
          {search.page.resolvedQuery}
        </Text>
      )}
      <View style={styles.scopeRow}>
        {canRefresh ? (
          <Pressable
            accessibilityRole="button"
            disabled={search.isFetching}
            style={styles.ghostButton}
            onPress={() => void search.refresh()}
          >
            <Text style={styles.ghostButtonLabel}>Refresh results</Text>
          </Pressable>
        ) : null}
        {search.page === null ? null : (
          <Pressable
            accessibilityRole="button"
            style={styles.ghostButton}
            onPress={() =>
              openExternalUrl(
                `https://github.com/issues?q=${encodeURIComponent(search.page?.resolvedQuery ?? "")}`,
              )
            }
          >
            <Text style={styles.ghostButtonLabel}>Open search on GitHub</Text>
          </Pressable>
        )}
        {search.hasNextPage ? (
          <Pressable
            accessibilityRole="button"
            disabled={search.isFetching}
            style={styles.ghostButton}
            onPress={() => void search.fetchNextPage()}
          >
            <Text style={styles.ghostButtonLabel}>Load more</Text>
          </Pressable>
        ) : null}
      </View>
      {(search.page?.total ?? 0) > 1000 ? (
        <Text style={styles.sectionHint}>
          GitHub exposes at most 1,000 search results. Narrow the query to see more.
        </Text>
      ) : null}
    </View>
  );
}
