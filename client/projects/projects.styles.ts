import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Platform, StyleSheet } from "react-native";

/** Each platform's own monospace face; there is no cross-platform name. */
const MONOSPACE = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" });

/**
 * The Projects tab's own styles: the list's header and rows, the "needs
 * read:project scope" empty state, and one project's own board once opened.
 * Built with `StyleSheet.create` rather than composed into the plugin-wide
 * `Styles` object the rest of the client shares, since the Projects tab
 * predates that convention and nothing outside it reads these keys.
 */
export function buildProjectsStyles(
  theme: PluginSurfaceProps["theme"],
  layout: PluginSurfaceProps["layout"],
) {
  const { colors } = theme;
  const compact = layout.compact;
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.surface0 },
    header: {
      flexDirection: "row",
      alignItems: "center",
      gap: compact ? 8 : 12,
      paddingHorizontal: compact ? 12 : 20,
      paddingVertical: compact ? 10 : 14,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    title: { color: colors.foreground, fontSize: compact ? 17 : 20, fontWeight: "600" },
    headerSpacer: { flex: 1 },
    iconButton: {
      width: compact ? 32 : 28,
      height: compact ? 32 : 28,
      borderRadius: 6,
      alignItems: "center",
      justifyContent: "center",
    },
    centered: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      padding: 24,
    },
    emptyText: { color: colors.foregroundMuted, fontSize: 13 },
    danger: { color: colors.statusDanger, fontSize: 13, textAlign: "center" },

    listBody: { padding: compact ? 12 : 20, gap: compact ? 8 : 6 },
    projectRow: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 8,
      paddingHorizontal: 14,
      paddingVertical: compact ? 12 : 10,
      gap: 4,
    },
    projectRowMain: { flexDirection: "row", alignItems: "baseline", gap: 8 },
    projectTitle: {
      color: colors.foreground,
      fontSize: 14,
      fontWeight: "600",
      flexShrink: 1,
    },
    projectDescription: { color: colors.foregroundMuted, fontSize: 12, flexShrink: 1 },
    projectMetaRow: { flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" },
    projectMeta: { color: colors.foregroundMuted, fontSize: 12 },
    closedBadge: { color: colors.statusDanger, fontSize: 12, fontWeight: "600" },

    // --- The "needs read:project" empty state ---
    scopeState: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      gap: 10,
      padding: 24,
    },
    scopeTitle: { color: colors.foreground, fontSize: 15, fontWeight: "600" },
    scopeBody: {
      color: colors.foregroundMuted,
      fontSize: 13,
      textAlign: "center",
      lineHeight: 18,
      maxWidth: 360,
    },
    scopeCommandBox: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 6,
      paddingHorizontal: 12,
      paddingVertical: 8,
      backgroundColor: colors.surface1,
    },
    scopeCommand: { color: colors.foreground, fontSize: 12, fontFamily: MONOSPACE },
    button: {
      backgroundColor: colors.accent,
      borderRadius: 6,
      paddingHorizontal: 14,
      paddingVertical: 8,
    },
    buttonLabel: { color: colors.accentForeground, fontSize: 13, fontWeight: "600" },

    // --- One project's own board ---
    detailHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: compact ? 8 : 12,
      paddingHorizontal: compact ? 12 : 20,
      paddingVertical: compact ? 10 : 14,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    detailTitle: {
      color: colors.foreground,
      fontSize: compact ? 16 : 18,
      fontWeight: "600",
      flexShrink: 1,
    },
    boardBody: { padding: compact ? 12 : 20, gap: 18 },
    group: { gap: 6 },
    groupTitle: {
      color: colors.foregroundMuted,
      fontSize: 12,
      fontWeight: "700",
      textTransform: "uppercase",
    },
    itemRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 10,
      paddingVertical: compact ? 10 : 8,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 6,
    },
    itemRowSpaced: { marginTop: 6 },
    itemTitle: { color: colors.foreground, fontSize: 13, flex: 1, flexShrink: 1 },
    itemMeta: { color: colors.foregroundMuted, fontSize: 12 },
  });
}

export type ProjectsStyles = ReturnType<typeof buildProjectsStyles>;
