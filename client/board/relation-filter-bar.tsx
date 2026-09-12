import { Pressable, Text, View } from "react-native";

import { RELATION_FILTERS } from "../lib/relations";
import type { Styles } from "../theme/use-styles";

/**
 * The relation chips: every relationship the viewer can filter by, plus "All".
 * Filtering is client-side over `item.relations`, which is the whole point of
 * fetching more than the viewer's own work — the server unions every relevant
 * search, and this bar is where the user narrows it back down.
 */
export function RelationFilterBar({
  filters,
  active,
  counts,
  styles,
  onSelect,
}: {
  filters: typeof RELATION_FILTERS;
  active: string;
  counts: ReadonlyMap<string, number>;
  styles: Styles;
  onSelect: (id: string) => void;
}) {
  return (
    <View style={styles.relationRow}>
      {filters.map((filter) => {
        const selected = filter.id === active;
        return (
          <Pressable
            key={filter.id}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            onPress={() => onSelect(filter.id)}
            style={[styles.relationChip, selected ? styles.relationChipActive : null]}
          >
            <Text
              style={[styles.relationChipLabel, selected ? styles.relationChipLabelActive : null]}
            >
              {filter.label}
            </Text>
            <Text
              style={[
                styles.relationChipCount,
                selected ? styles.relationChipLabelActive : null,
              ]}
            >
              {counts.get(filter.id) ?? 0}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
