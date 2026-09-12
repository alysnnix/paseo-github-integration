import { Pressable, Text, View } from "react-native";

import { DEFAULT_SORT_ORDER, SORT_ORDERS } from "../lib/sort";
import type { Styles } from "../theme/use-styles";

/**
 * The ordering dropdown, styled like `OwnerFilter` and `RepoFilter` so the
 * three read as one row of controls. Unlike those two there is nothing to
 * search — three rows fit in the popover without one — and nothing to
 * multi-select, so a row carries a tick rather than a checkbox.
 */
export function SortFilter({
  orders,
  active,
  open,
  styles,
  onToggleOpen,
  onSelect,
}: {
  orders: typeof SORT_ORDERS;
  active: string;
  open: boolean;
  styles: Styles;
  onToggleOpen: () => void;
  onSelect: (id: string) => void;
}) {
  const current = orders.find((order) => order.id === active) ?? DEFAULT_SORT_ORDER;
  return (
    <View style={styles.filterAnchor}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Sort: ${current.label}`}
        accessibilityState={{ expanded: open }}
        style={styles.ghostButton}
        onPress={onToggleOpen}
      >
        <Text style={styles.ghostButtonLabel}>{current.label} ▾</Text>
      </Pressable>
      {open ? (
        <View style={styles.dropdown}>
          <View style={styles.dropdownList}>
            {orders.map((order) => {
              const selected = order.id === current.id;
              return (
                <Pressable
                  key={order.id}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  onPress={() => onSelect(order.id)}
                  style={({ pressed }) => [
                    styles.dropdownRow,
                    pressed ? styles.cardPressed : null,
                  ]}
                >
                  <Text style={styles.dropdownLabel} numberOfLines={1}>
                    {order.label}
                  </Text>
                  {selected ? <Text style={styles.popoverTick}>✓</Text> : null}
                </Pressable>
              );
            })}
          </View>
        </View>
      ) : null}
    </View>
  );
}
