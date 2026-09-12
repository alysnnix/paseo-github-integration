import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { ActivityIndicator, Pressable, Text, View } from "react-native";

import type { Board } from "../../shared/board";
import { relativeTime } from "../lib/time";
import type { Styles } from "../theme/use-styles";
import type { OpenBoardFilter } from "./use-board-filters";

/**
 * The board's title bar: the surface title (dropped on a compact phone,
 * where the mode switcher below needs the width more), a Back button when
 * the settings screen is open, and otherwise the last-fetched stamp, the
 * settings gear and the refresh button — which a compact layout drops too,
 * since pulling the list down already refreshes it there.
 */
export function BoardHeader({
  surfaceProps,
  styles,
  showSettings,
  setShowSettings,
  board,
  busy,
  refresh,
  setOpenFilter,
}: {
  surfaceProps: PluginSurfaceProps;
  styles: Styles;
  showSettings: boolean;
  setShowSettings: (next: boolean) => void;
  board: Board | null;
  busy: boolean;
  refresh: (login?: string, force?: boolean) => Promise<void>;
  setOpenFilter: (next: OpenBoardFilter) => void;
}) {
  return (
    <View style={styles.header}>
      {/* The surface chrome already names the plugin, and on a phone that
          title is the width the mode switcher needs. The settings view
          keeps its own, because the chrome does not say which view this is. */}
      {surfaceProps.layout.compact && !showSettings ? null : (
        <Text style={styles.title}>{showSettings ? "GitHub settings" : "GitHub"}</Text>
      )}
      <View style={styles.headerSpacer} />
      {showSettings ? (
        <Pressable
          accessibilityRole="button"
          style={styles.button}
          onPress={() => setShowSettings(false)}
        >
          <Text style={styles.buttonLabel}>Back to board</Text>
        </Pressable>
      ) : (
        <>
          {board !== null ? (
            <Text style={styles.headerAge} numberOfLines={1}>
              Updated {relativeTime(board.fetchedAt)}
            </Text>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Configure prompts"
            style={({ pressed }) => [styles.iconButton, pressed ? styles.cardPressed : null]}
            onPress={() => {
              setOpenFilter(null);
              setShowSettings(true);
            }}
          >
            <Icon name="Settings" size={15} color={surfaceProps.theme.colors.foreground} />
          </Pressable>
          {/* Compact refreshes by pulling the list down, so the button would
              be a second way to do the same thing in the row with the least
              room for one. */}
          {surfaceProps.layout.compact ? null : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={busy ? "Loading the board" : "Refresh the board"}
              style={({ pressed }) => [styles.iconButton, pressed ? styles.cardPressed : null]}
              onPress={() => void refresh(undefined, true)}
              disabled={busy}
            >
              {/* The spinner takes the glyph's place while a load runs, so
                  the button still says "loading" without a word to say it. */}
              {busy ? (
                <ActivityIndicator size="small" color={surfaceProps.theme.colors.foregroundMuted} />
              ) : (
                <Icon name="RefreshCw" size={14} color={surfaceProps.theme.colors.foreground} />
              )}
            </Pressable>
          )}
        </>
      )}
    </View>
  );
}
