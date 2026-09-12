import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";

import { normalizeSearchText, repositoryMatchesQuery } from "../lib/search";
import type { Styles } from "../theme/use-styles";

/**
 * Repository filter. The selection is held as the set of *hidden* repositories
 * rather than the visible ones, so a repository that only shows up on a later
 * refresh — or that the saved filter has never seen — arrives selected, which
 * is what "starts with all repos selected" means once the board can change
 * under the filter.
 */
export function RepoFilter({
  repositories,
  hidden,
  open,
  styles,
  onToggleOpen,
  onToggleRepo,
  onSelectAll,
  onSelectNone,
}: {
  repositories: readonly string[];
  hidden: ReadonlySet<string>;
  open: boolean;
  styles: Styles;
  onToggleOpen: () => void;
  onToggleRepo: (repository: string) => void;
  onSelectAll: () => void;
  onSelectNone: () => void;
}) {
  const selected = repositories.filter((repository) => !hidden.has(repository)).length;
  const allSelected = selected === repositories.length;
  const [query, setQuery] = useState("");
  // The search stays behind when the dropdown closes, so reopening it does not
  // silently keep a scoped-down list the user cannot see the reason for.
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);
  const normalizedQuery = query.trim().toLowerCase();
  const visibleRepositories =
    normalizedQuery === ""
      ? repositories
      : repositories.filter((repository) => repositoryMatchesQuery(repository, normalizedQuery));

  return (
    <View style={styles.filterAnchor}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Filter repositories: ${selected} of ${repositories.length} shown`}
        accessibilityState={{ expanded: open }}
        style={styles.ghostButton}
        onPress={onToggleOpen}
      >
        <Text style={styles.ghostButtonLabel}>
          {allSelected ? "All repos" : `${selected}/${repositories.length} repos`} ▾
        </Text>
      </Pressable>
      {open ? (
        <View style={styles.dropdown}>
          <View style={styles.dropdownActions}>
            <Pressable style={styles.chipButton} onPress={onSelectAll}>
              <Text style={styles.chipLabel}>All</Text>
            </Pressable>
            <Pressable style={styles.chipButton} onPress={onSelectNone}>
              <Text style={styles.chipLabel}>None</Text>
            </Pressable>
          </View>
          <TextInput
            accessibilityLabel="Filter repositories by name"
            style={styles.popoverSearch}
            placeholder="Filter repositories…"
            placeholderTextColor={styles.popoverEmpty.color}
            value={query}
            onChangeText={setQuery}
            autoCorrect={false}
          />
          <ScrollView contentContainerStyle={styles.dropdownList}>
            {visibleRepositories.length === 0 ? (
              <Text style={styles.popoverEmpty}>No repositories match.</Text>
            ) : (
              visibleRepositories.map((repository) => {
                const checked = !hidden.has(repository);
                return (
                  <Pressable
                    key={repository}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked }}
                    onPress={() => onToggleRepo(repository)}
                    style={({ pressed }) => [styles.dropdownRow, pressed ? styles.cardPressed : null]}
                  >
                    <View style={[styles.checkbox, checked ? styles.checkboxChecked : null]}>
                      {checked ? <Text style={styles.checkmark}>✓</Text> : null}
                    </View>
                    <Text style={styles.dropdownLabel} numberOfLines={1}>
                      {repository}
                    </Text>
                  </Pressable>
                );
              })
            )}
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}

/**
 * Owner filter, alongside the repository one: the list of distinct owners on
 * the board, each with how many items the current mode and relation filter
 * would show for it. Shaped the same way `RepoFilter` is — a hidden set, an
 * always-visible search box — so the two dropdowns read as one control.
 */
export function OwnerFilter({
  owners,
  counts,
  hidden,
  open,
  styles,
  onToggleOpen,
  onToggleOwner,
  onSelectAll,
  onSelectNone,
}: {
  owners: readonly string[];
  counts: ReadonlyMap<string, number>;
  hidden: ReadonlySet<string>;
  open: boolean;
  styles: Styles;
  onToggleOpen: () => void;
  onToggleOwner: (owner: string) => void;
  onSelectAll: () => void;
  onSelectNone: () => void;
}) {
  const selected = owners.filter((owner) => !hidden.has(owner)).length;
  const allSelected = selected === owners.length;
  const [query, setQuery] = useState("");
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);
  const normalizedQuery = normalizeSearchText(query);
  const visibleOwners =
    normalizedQuery === ""
      ? owners
      : owners.filter((owner) => normalizeSearchText(owner).includes(normalizedQuery));

  return (
    <View style={styles.filterAnchor}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Filter owners: ${selected} of ${owners.length} shown`}
        accessibilityState={{ expanded: open }}
        style={styles.ghostButton}
        onPress={onToggleOpen}
      >
        <Text style={styles.ghostButtonLabel}>
          {allSelected ? "All owners" : `${selected}/${owners.length} owners`} ▾
        </Text>
      </Pressable>
      {open ? (
        <View style={styles.dropdown}>
          <View style={styles.dropdownActions}>
            <Pressable style={styles.chipButton} onPress={onSelectAll}>
              <Text style={styles.chipLabel}>All</Text>
            </Pressable>
            <Pressable style={styles.chipButton} onPress={onSelectNone}>
              <Text style={styles.chipLabel}>None</Text>
            </Pressable>
          </View>
          <TextInput
            accessibilityLabel="Filter owners by name"
            style={styles.popoverSearch}
            placeholder="Filter owners…"
            placeholderTextColor={styles.popoverEmpty.color}
            value={query}
            onChangeText={setQuery}
            autoCorrect={false}
          />
          <ScrollView contentContainerStyle={styles.dropdownList}>
            {visibleOwners.length === 0 ? (
              <Text style={styles.popoverEmpty}>No owners match.</Text>
            ) : (
              visibleOwners.map((owner) => {
                const checked = !hidden.has(owner);
                return (
                  <Pressable
                    key={owner}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked }}
                    onPress={() => onToggleOwner(owner)}
                    style={({ pressed }) => [styles.dropdownRow, pressed ? styles.cardPressed : null]}
                  >
                    <View style={[styles.checkbox, checked ? styles.checkboxChecked : null]}>
                      {checked ? <Text style={styles.checkmark}>✓</Text> : null}
                    </View>
                    <Text style={styles.dropdownLabel} numberOfLines={1}>
                      {owner}
                    </Text>
                    <Text style={styles.dropdownCount}>{counts.get(owner) ?? 0}</Text>
                  </Pressable>
                );
              })
            )}
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}
