import type { PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";

/**
 * The board's screen id, shared by `addScreen`, this row and the command-center entry. It stays
 * `"board"`, the id the legacy `addSidebarItem` registration used: Paseo resolves a remembered
 * `/sidebar/board` route to a screen with the same id, so a restored tab still lands on the board.
 */
export const BOARD_SCREEN_ID = "board";

/**
 * The sidebar header row. The host draws one row per item even with several hosts connected, picks
 * the host itself, and labels the row with the registered title, so this only decides the icon and
 * when the row reads as active.
 */
export function BoardSidebarItem(props: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="GitPullRequest"
      active={props.currentScreen?.screenId === BOARD_SCREEN_ID}
      onPress={() => props.openScreen({ screenId: BOARD_SCREEN_ID })}
    />
  );
}
