import { Pressable, Text, TextInput, View } from "react-native";

import { BOARD_MODES } from "../lib/board-modes";
import type { BoardMode } from "../lib/board-modes";
import { RELATION_FILTERS } from "../lib/relations";
import type { SortOrder } from "../lib/sort";
import type { Styles } from "../theme/use-styles";
import { OwnerFilter, RepoFilter } from "./repo-owner-filters";
import { RelationFilterBar } from "./relation-filter-bar";
import { SortFilter } from "./sort-filter";
import type { OpenBoardFilter } from "./use-board-filters";

/**
 * The mode switcher: the four ways the board can be viewed, one at a time.
 * Discussions only earns a place once there is something to show for it, or
 * a reason it failed to load — `showDiscussionsMode` is where that is
 * decided, upstream of this bar.
 */
export function BoardModeBar({
  mode,
  showDiscussionsMode,
  selectColumnMode,
  styles,
}: {
  mode: BoardMode;
  showDiscussionsMode: boolean;
  selectColumnMode: (id: BoardMode) => void;
  styles: Styles;
}) {
  return (
    <View style={styles.modeBar}>
      {/* `.map`, not `for…of`: a closure made in a loop body captures the
          binding's final value under Hermes. */}
      {BOARD_MODES.filter((entry) => entry.id !== "discussions" || showDiscussionsMode).map(
        (entry) => {
          const active = entry.id === mode;
          return (
            <Pressable
              key={entry.id}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              onPress={() => selectColumnMode(entry.id)}
              style={[styles.modeButton, active ? styles.modeButtonActive : null]}
            >
              <Text style={[styles.modeButtonLabel, active ? styles.modeButtonLabelActive : null]}>
                {entry.label}
              </Text>
            </Pressable>
          );
        },
      )}
    </View>
  );
}

/**
 * The relation, owner, repository and sort filters, plus the search field —
 * hidden entirely on the Projects mode and on the settings screen, neither of
 * which the filter pipeline touches.
 */
export function BoardFilterBar({
  visibleRelations,
  effectiveRelation,
  relationCounts,
  commitRelation,
  allOwners,
  ownerCounts,
  hiddenOwners,
  toggleOwner,
  selectAllOwners,
  selectNoOwners,
  repositories,
  hiddenRepos,
  toggleRepo,
  selectAllRepos,
  selectNoRepos,
  visibleSortOrders,
  effectiveSort,
  commitSort,
  searchQuery,
  setSearchQuery,
  openFilter,
  setOpenFilter,
  styles,
}: {
  visibleRelations: typeof RELATION_FILTERS;
  effectiveRelation: string;
  relationCounts: ReadonlyMap<string, number>;
  commitRelation: (next: string) => void;
  allOwners: readonly string[];
  ownerCounts: ReadonlyMap<string, number>;
  hiddenOwners: ReadonlySet<string>;
  toggleOwner: (owner: string) => void;
  selectAllOwners: () => void;
  selectNoOwners: () => void;
  repositories: readonly string[];
  hiddenRepos: ReadonlySet<string>;
  toggleRepo: (repository: string) => void;
  selectAllRepos: () => void;
  selectNoRepos: () => void;
  visibleSortOrders: readonly SortOrder[];
  effectiveSort: string;
  commitSort: (next: string) => void;
  searchQuery: string;
  setSearchQuery: (next: string) => void;
  openFilter: OpenBoardFilter;
  setOpenFilter: (next: OpenBoardFilter) => void;
  styles: Styles;
}) {
  return (
    <View style={styles.filterBar}>
      <RelationFilterBar
        filters={visibleRelations}
        active={effectiveRelation}
        counts={relationCounts}
        styles={styles}
        onSelect={commitRelation}
      />
      {allOwners.length > 0 ? (
        <OwnerFilter
          owners={allOwners}
          counts={ownerCounts}
          hidden={hiddenOwners}
          open={openFilter === "owner"}
          styles={styles}
          onToggleOpen={() => setOpenFilter(openFilter === "owner" ? null : "owner")}
          onToggleOwner={toggleOwner}
          onSelectAll={selectAllOwners}
          onSelectNone={selectNoOwners}
        />
      ) : null}
      {repositories.length > 0 ? (
        <RepoFilter
          repositories={repositories}
          hidden={hiddenRepos}
          open={openFilter === "repo"}
          styles={styles}
          onToggleOpen={() => setOpenFilter(openFilter === "repo" ? null : "repo")}
          onToggleRepo={toggleRepo}
          onSelectAll={selectAllRepos}
          onSelectNone={selectNoRepos}
        />
      ) : null}
      <SortFilter
        orders={visibleSortOrders}
        active={effectiveSort}
        open={openFilter === "sort"}
        styles={styles}
        onToggleOpen={() => setOpenFilter(openFilter === "sort" ? null : "sort")}
        onSelect={(id) => {
          commitSort(id);
          setOpenFilter(null);
        }}
      />
      <TextInput
        accessibilityLabel="Search: a plain word matches title, repository or number; /name a repository, #123 a number, @login an author"
        style={styles.searchInput}
        placeholder="Search, or /repo #123 @author"
        placeholderTextColor={styles.subtle.color}
        value={searchQuery}
        onChangeText={setSearchQuery}
        autoCorrect={false}
      />
    </View>
  );
}
