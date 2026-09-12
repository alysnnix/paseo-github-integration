/**
 * The same prompt-and-login editor the board's gear button opens, reachable
 * from **Settings → Plugins → GitHub board** as well.
 *
 * Two entry points, one editor: both frames render `PromptSettingsView` and
 * both bind to the `promptSettings` document, so they cannot show different
 * values or overwrite each other with a stale draft — a save against a revision
 * the other frame has already moved past fails and reports, rather than
 * winning. That is the reason this is a second door rather than a replacement:
 * `PluginSurfaceProps` carries no `openSettings`, so a surface cannot route to
 * its own settings screen, and moving the editor out would leave the board's
 * gear button with nowhere to go.
 */
import { type PluginSurfaceProps, useRpc, useSettings } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import {
  SettingsAction,
  SettingsInput,
  type SettingsInputHandle,
  SettingsRow,
  SettingsSection,
} from "@getpaseo/plugin/client/ui";
import { useCallback, useMemo, useRef, useState } from "react";
import { View } from "react-native";

import type { PromptSettings } from "../../shared/board";
import { saveLogin } from "../../shared/board";
import { displaySettings, normalizePrompts, promptSettings } from "../../shared/settings";
import { useStyles } from "../theme/use-styles";
import { EMPTY_PROMPTS, PromptSettingsView } from "./prompt-settings-view";

/**
 * Strips what a pasted `@owner` or stray whitespace would otherwise turn into
 * a broken search qualifier, and refuses blank input without treating it as
 * an error — the empty string is just "nothing typed yet".
 */
function normalizeOwner(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const stripped = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  if (stripped === "" || /\s/.test(stripped)) return null;
  return stripped;
}

export function BoardSettingsScreen(props: PluginSurfaceProps) {
  const styles = useStyles(props);
  const prompts = useSettings(promptSettings);
  const display = useSettings(displaySettings);
  const persistLogin = useRpc(saveLogin);
  const toast = useToast();

  /**
   * The login is the daemon's, not the app's — it is what `gh` runs as — so it
   * still goes through its RPC rather than a settings document. This screen
   * only pins it; the board picks the new one up on its next load.
   */
  const [login, setLogin] = useState("");
  const [busy, setBusy] = useState(false);

  /** The owner box's own draft, tracked only to know whether Add has anything to add. */
  const [ownerDraft, setOwnerDraft] = useState("");
  const ownerInputRef = useRef<SettingsInputHandle>(null);
  const watchedOwners = display.status === "ready" ? display.values.watchedOwners : [];

  const applyLogin = useCallback(
    // Async function expression, not an async arrow — Hermes evaluates an async
    // arrow in an eval'd bundle to `undefined`.
    async function applyLogin(next: string) {
      const trimmed = next.trim();
      if (trimmed === "") return;
      setBusy(true);
      try {
        const saved = await persistLogin({ login: trimmed });
        setLogin(saved.login);
        toast.show(`Board login set to ${saved.login}`, { variant: "success" });
      } catch (cause) {
        toast.error(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [persistLogin, toast],
  );

  const applyPrompts = useCallback(
    async function applyPrompts(next: PromptSettings) {
      if (prompts.status !== "ready") return;
      const saved = await prompts.save(normalizePrompts(next), prompts.revision);
      if (saved) toast.show("Prompts saved", { variant: "success" });
      else toast.error(prompts.saveError ?? "The templates were not saved.");
    },
    [prompts, toast],
  );

  const addOwner = useCallback(
    async function addOwner() {
      if (display.status !== "ready") return;
      const normalized = normalizeOwner(ownerDraft);
      setOwnerDraft("");
      ownerInputRef.current?.replaceText("");
      if (normalized === null) return;
      if (display.values.watchedOwners.some((owner) => owner.toLowerCase() === normalized.toLowerCase())) {
        return;
      }
      const saved = await display.save(
        { ...display.values, watchedOwners: [...display.values.watchedOwners, normalized] },
        display.revision,
      );
      if (saved) toast.show(`Watching ${normalized}`, { variant: "success" });
      else toast.error(display.saveError ?? "The owner was not saved.");
    },
    [display, ownerDraft, toast],
  );

  const removeOwner = useCallback(
    async function removeOwner(owner: string) {
      if (display.status !== "ready") return;
      const saved = await display.save(
        {
          ...display.values,
          watchedOwners: display.values.watchedOwners.filter((existing) => existing !== owner),
        },
        display.revision,
      );
      if (saved) toast.show(`Stopped watching ${owner}`, { variant: "success" });
      else toast.error(display.saveError ?? "The owner was not removed.");
    },
    [display, toast],
  );

  const screenStyle = useMemo(() => ({ flex: 1 }), []);
  /**
   * The owners section renders at its natural height above the prompt editor,
   * which keeps its own internal `ScrollView` — nesting two scrolling views
   * would fight each other's gestures, so this one gets the remaining space
   * instead of its own scroll container.
   */
  const promptsWrapperStyle = useMemo(() => ({ flex: 1 }), []);

  return (
    <View style={screenStyle}>
      <SettingsSection
        title="Watched owners"
        info="GitHub search has no scope for everything, so the board sweeps these owners in addition to whatever has a relation to you."
      >
        <SettingsInput
          ref={ownerInputRef}
          label="New owner"
          hint="Organization or user login"
          placeholder="octocat"
          onChangeText={setOwnerDraft}
          disabled={display.status !== "ready"}
        />
        <SettingsAction
          label="Add owner"
          actionLabel="Add"
          onPress={addOwner}
          disabled={display.status !== "ready" || display.saving || normalizeOwner(ownerDraft) === null}
        />
        {watchedOwners.length === 0 ? (
          <SettingsRow label="No watched owners yet" />
        ) : (
          watchedOwners.map((owner) => (
            <SettingsAction
              key={owner}
              label={owner}
              actionLabel="Remove"
              onPress={() => removeOwner(owner)}
              disabled={display.saving}
            />
          ))
        )}
      </SettingsSection>
      <View style={promptsWrapperStyle}>
        <PromptSettingsView
          styles={styles}
          prompts={prompts.status === "ready" ? prompts.values : EMPTY_PROMPTS}
          login={login}
          busy={busy}
          mutedColor={props.theme.colors.foregroundMuted}
          onSave={applyPrompts}
          onApplyLogin={applyLogin}
        />
      </View>
    </View>
  );
}
