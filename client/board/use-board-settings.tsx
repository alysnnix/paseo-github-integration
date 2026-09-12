import { useCallback, useEffect } from "react";
import { type SettingsState, useRpc, useSettings } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import type { SettingsDefinition } from "@getpaseo/plugin";

import type { PromptSettings } from "../../shared/board";
import { legacySettingsTaken, takeLegacySettings } from "../../shared/board";
import {
  completePrompts,
  displaySettings,
  isDefaultPrompts,
  normalizePrompts,
  promptSettings,
} from "../../shared/settings";

/** The Zod schema `displaySettings` was defined with, recovered so `display`'s type below need not repeat it. */
type DisplaySchema = typeof displaySettings extends SettingsDefinition<infer Schema> ? Schema : never;

/**
 * Whether the one-way migration out of the daemon's old settings file has been
 * attempted in this app session. Module scope because the surface remounts on
 * every workspace switch and the answer cannot change underneath us: the
 * daemon stamps the file once the values have landed, so a second attempt
 * would only ever be a wasted round trip.
 *
 * A *failed* attempt leaves this true for the session but the file unstamped,
 * so the next launch tries again rather than losing the values.
 */
let legacyMigrationAttempted = false;

/** What `useBoardSettings` exposes to the surface and to the other board hooks. */
export interface UseBoardSettingsResult {
  display: SettingsState<DisplaySchema>;
  savedFraction: number | null;
  /** The organisations and users to sweep beyond the viewer's own buckets. */
  watchedOwners: readonly string[];
  promptValues: PromptSettings | null;
  applyPrompts: (next: PromptSettings) => Promise<void>;
  /**
   * The panel's width, once per drag. A failure is logged and not shown: the
   * width the user just chose is on screen regardless, and a setting that did
   * not save is not a problem with the card in front of them.
   */
  commitWidth: (fraction: number) => void;
}

/**
 * How this client draws the board, kept by the host rather than by the
 * daemon: the filter and the panel width are read only to paint, so they no
 * longer ride along on `board.load` and no longer cost an RPC to save. The
 * host pushes a change to every connected client on its own. Also runs the
 * one-way migration out of the daemon's pre-0.4.0 settings file, the first
 * time both documents are readable.
 */
export function useBoardSettings(): UseBoardSettingsResult {
  const display = useSettings(displaySettings);
  const prompts = useSettings(promptSettings);
  const savedFraction = display.status === "ready" ? display.values.detailWidthFraction : null;
  const watchedOwners = display.status === "ready" ? display.values.watchedOwners : [];
  const toast = useToast();
  const promptValues = prompts.status === "ready" ? prompts.values : null;

  const takeLegacy = useRpc(takeLegacySettings);
  const ackLegacy = useRpc(legacySettingsTaken);
  /**
   * Copies the settings a pre-0.4.0 daemon still holds into the host settings
   * store, once, the first time both documents are readable.
   *
   * The app has to do this because the daemon cannot: a settings document is
   * written over the client's RPC channel and there is no server-side
   * equivalent. So the daemon hands the values out, the app writes them, and
   * only then does the daemon stamp its file — which is why an interrupted
   * migration is retried rather than half-applied.
   *
   * Each document is written only if it is still untouched. Someone who has
   * already customised their prompts on 0.4.0 before an older client got round
   * to migrating keeps what they customised; the older values are dropped
   * rather than reinstated on top of them.
   */
  useEffect(() => {
    if (legacyMigrationAttempted) return;
    if (display.status !== "ready" || prompts.status !== "ready") return;
    legacyMigrationAttempted = true;

    void (async function migrateLegacySettings() {
      try {
        const legacy = await takeLegacy({});
        if (!legacy.found) return;

        let migrated = false;

        const takeFilter =
          legacy.hiddenRepositories !== null && display.values.hiddenRepositories.length === 0;
        const takeWidth =
          legacy.detailWidthFraction !== null && display.values.detailWidthFraction === null;
        if (takeFilter || takeWidth) {
          const saved = await display.save(
            {
              ...display.values,
              hiddenRepositories: takeFilter
                ? [...(legacy.hiddenRepositories ?? [])].sort()
                : display.values.hiddenRepositories,
              detailWidthFraction: takeWidth
                ? legacy.detailWidthFraction
                : display.values.detailWidthFraction,
            },
            display.revision,
          );
          if (!saved) return;
          migrated = true;
        }

        if (legacy.prompts !== null && isDefaultPrompts(prompts.values)) {
          const saved = await prompts.save(
            normalizePrompts(completePrompts(legacy.prompts)),
            prompts.revision,
          );
          if (!saved) return;
          migrated = true;
        }

        // Only now: the daemon's copy is the fallback until this returns.
        await ackLegacy({});
        if (migrated) {
          toast.show("Your board settings moved to Paseo's own storage.", { variant: "info" });
        }
      } catch (cause) {
        console.warn("[github-board] could not migrate the saved settings", cause);
      }
    })();
  }, [ackLegacy, display, prompts, takeLegacy, toast]);

  const commitWidth = useCallback(
    (fraction: number) => {
      if (display.status !== "ready") return;
      void display
        .save({ ...display.values, detailWidthFraction: fraction }, display.revision)
        .then((saved) => {
          if (!saved) console.warn("[github-board] could not save the panel width");
        });
    },
    [display],
  );

  const applyPrompts = useCallback(
    // Async function expression, not an async arrow — see `use-board-query.tsx`.
    async function applyPrompts(next: PromptSettings) {
      if (prompts.status !== "ready") return;
      // Normalised here rather than in the schema, so the editor's draft can
      // hold a blank field while it is being cleared and only the *saved*
      // document reads a blank as "inherit".
      const saved = await prompts.save(normalizePrompts(next), prompts.revision);
      if (!saved) toast.error(prompts.saveError ?? "The templates were not saved.");
    },
    [prompts, toast],
  );

  return {
    display,
    savedFraction,
    watchedOwners,
    promptValues,
    applyPrompts,
    commitWidth,
  };
}
