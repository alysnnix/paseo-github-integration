import { useCallback, useEffect, useRef, useState } from "react";
import { usePaseo } from "@getpaseo/plugin/client";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";

import type { ColumnId, ProjectRef, PromptSet, PromptSettings } from "../../shared/board";
import { PLACEHOLDERS } from "../lib/templates";
import type { Styles } from "../theme/use-styles";

/**
 * The four columns in display order, with the label the settings view gives
 * each one. Declared here rather than read off the board so the settings view
 * renders every type even before a board has loaded.
 */
export const PROMPT_TYPES: readonly { id: ColumnId; label: string }[] = [
  { id: "issues", label: "Issues" },
  { id: "draft-prs", label: "Draft PRs" },
  { id: "open-prs", label: "Open PRs" },
  { id: "discussions", label: "Discussions" },
];

/**
 * Stands in while the settings read is pending. Blank templates are what
 * `normalizePrompts` reads as "use the default", so the settings view opened
 * before the document lands shows empty fields rather than inventing values
 * that saving would disagree with.
 */
export const EMPTY_PROMPTS: PromptSettings = {
  byType: { issues: "", "draft-prs": "", "open-prs": "", discussions: "" },
  byProject: {},
};

const NO_PROJECTS: readonly ProjectRef[] = [];

/**
 * The "Configure prompts" view. It edits a local draft and persists on Save, so
 * leaving without saving discards — the alternative, writing on every
 * keystroke, would save half-typed templates and cost a round trip per
 * character.
 *
 * The scope selector decides *what* the four fields edit: the type defaults, or
 * one project's overrides. One set of fields serves both, because a project
 * override is the same four templates with "inherit" as an option.
 */
export function PromptSettingsView({
  styles,
  prompts,
  login,
  busy,
  mutedColor,
  onSave,
  onApplyLogin,
}: {
  styles: Styles;
  prompts: PromptSettings;
  login: string;
  busy: boolean;
  mutedColor: string;
  onSave: (next: PromptSettings) => Promise<void>;
  onApplyLogin: (login: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState<PromptSettings>(prompts);
  const [scope, setScope] = useState<string | null>(null);
  const [loginDraft, setLoginDraft] = useState(login);
  const [saving, setSaving] = useState(false);

  /**
   * Every live project, for the per-project override picker. Asked of the
   * daemon directly rather than carried on `board.load`: this is a normal Paseo
   * operation, and the board only ever knew the projects its own cards mapped
   * to plus the rest along for the ride.
   */
  const paseo = usePaseo();
  const [projects, setProjects] = useState<readonly ProjectRef[]>(NO_PROJECTS);
  useEffect(() => {
    let cancelled = false;
    paseo.projects
      .list()
      .then((result) => {
        if (cancelled) return;
        setProjects(
          result.projects.map((project) => ({
            id: project.projectId,
            name: project.projectDisplayName,
          })),
        );
      })
      .catch((cause: unknown) => {
        console.warn("[github-board] could not list projects", cause);
      });
    return () => {
      cancelled = true;
    };
  }, [paseo]);

  // The saved value is the baseline for "dirty". Adopting it whenever the
  // server hands back a new one is what turns a successful save back into a
  // clean state without a second signal.
  const savedRef = useRef(prompts);
  useEffect(() => {
    if (savedRef.current === prompts) return;
    savedRef.current = prompts;
    setDraft(prompts);
  }, [prompts]);

  // Same adopt-on-change rule for the login: the prop only moves when a board
  // load confirms a new one, so this never fights what is being typed.
  const loginRef = useRef(login);
  useEffect(() => {
    if (loginRef.current === login) return;
    loginRef.current = login;
    setLoginDraft(login);
  }, [login]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(prompts);

  const setTemplate = useCallback(
    (type: ColumnId, value: string) => {
      setDraft((current) => {
        if (scope === null) {
          return { ...current, byType: { ...current.byType, [type]: value } };
        }
        // Rebuilt key by key rather than spread: `exactOptionalPropertyTypes`
        // rejects the `string | undefined` a spread of a Partial produces.
        const existing = current.byProject[scope];
        const overrides: Partial<PromptSet> = {};
        for (const candidate of PROMPT_TYPES) {
          const template = existing?.[candidate.id];
          if (template !== undefined) overrides[candidate.id] = template;
        }
        if (value.trim() === "") delete overrides[type];
        else overrides[type] = value;
        const byProject = { ...current.byProject };
        if (Object.keys(overrides).length === 0) delete byProject[scope];
        else byProject[scope] = overrides;
        return { ...current, byProject };
      });
    },
    [scope],
  );

  const save = useCallback(() => {
    if (saving) return;
    setSaving(true);
    void onSave(draft).finally(() => setSaving(false));
  }, [draft, onSave, saving]);

  return (
    // The settings view is nothing but text fields, and the keyboard covers the
    // lower half of them on a phone. This is the iOS-native version of the
    // dialog's inset — a ScrollView can just be told to inset itself; the
    // dialog is centred rather than scrolled, so it cannot.
    <ScrollView
      automaticallyAdjustKeyboardInsets
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={styles.settingsBody}
    >
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>GitHub account</Text>
        <Text style={styles.sectionHint}>
          The login every column is queried for. Leave it empty to use whichever account `gh` is
          authenticated as on the daemon machine.
        </Text>
        <View style={styles.row}>
          <TextInput
            style={styles.loginInput}
            value={loginDraft}
            onChangeText={setLoginDraft}
            onSubmitEditing={() => void onApplyLogin(loginDraft)}
            placeholder="github login"
            placeholderTextColor={mutedColor}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="done"
          />
          <Pressable
            accessibilityRole="button"
            style={styles.ghostButton}
            disabled={busy}
            onPress={() => void onApplyLogin(loginDraft)}
          >
            <Text style={styles.ghostButtonLabel}>{busy ? "Loading…" : "Apply"}</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Prompts</Text>
        <Text style={styles.sectionHint}>
          What the "Send to chat" dialog opens with — edit it there before sending. Available
          placeholders:{" "}
          {PLACEHOLDERS.join(", ")}. Pick a project to override its prompts; a card is matched to a
          project by the repository's git remote, the same way sending one is.
        </Text>

        <View style={styles.scopeRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: scope === null }}
            style={[styles.chipButton, scope === null ? styles.scopeChipSelected : null]}
            onPress={() => setScope(null)}
          >
            <Text style={scope === null ? styles.scopeLabelSelected : styles.chipLabel}>
              All projects
            </Text>
          </Pressable>
          {projects.map((project) => {
            const selected = scope === project.id;
            const overridden = Object.keys(draft.byProject[project.id] ?? {}).length > 0;
            return (
              <Pressable
                key={project.id}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                style={[styles.chipButton, selected ? styles.scopeChipSelected : null]}
                onPress={() => setScope(project.id)}
              >
                <Text style={selected ? styles.scopeLabelSelected : styles.chipLabel}>
                  {project.name}
                  {overridden ? " •" : ""}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {PROMPT_TYPES.map(({ id, label }) => {
          const inherited = draft.byType[id];
          const override = scope === null ? undefined : draft.byProject[scope]?.[id];
          const value = scope === null ? inherited : (override ?? "");
          return (
            <View key={id} style={styles.section}>
              <Text style={styles.fieldLabel}>{label}</Text>
              <TextInput
                style={styles.templateInput}
                value={value}
                onChangeText={(next) => setTemplate(id, next)}
                multiline
                placeholder={scope === null ? "Uses the built-in default when empty" : inherited}
                placeholderTextColor={mutedColor}
                autoCapitalize="none"
                autoCorrect={false}
              />
              {scope !== null && override === undefined ? (
                <Text style={styles.inheritedNote}>Inherited from all projects.</Text>
              ) : null}
            </View>
          );
        })}

        <View style={styles.row}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: !dirty || saving }}
            style={[styles.button, !dirty || saving ? styles.buttonDisabled : null]}
            disabled={!dirty || saving}
            onPress={save}
          >
            <Text style={styles.buttonLabel}>
              {saving ? "Saving…" : dirty ? "Save prompts" : "Saved"}
            </Text>
          </Pressable>
          {dirty ? (
            <Pressable
              accessibilityRole="button"
              style={styles.ghostButton}
              onPress={() => setDraft(prompts)}
            >
              <Text style={styles.ghostButtonLabel}>Revert</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    </ScrollView>
  );
}
