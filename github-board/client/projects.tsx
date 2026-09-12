/**
 * The Projects tab: GitHub Projects (v2) rendered as their own view rather than
 * folded into the four-column board, because a project is not one of the
 * viewer's relationships to an item — it is a container an item can sit in,
 * several at once, including drafts that are not issues at all. See
 * `shared/board.ts` for `listProjects` and `loadProject`.
 */
import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import { copyText, Icon } from "@getpaseo/plugin/client/react-native";
import type { JSX } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import type { ProjectItem, ProjectSummary } from "../shared/board";
import { listProjects, loadProject } from "../shared/board";

type ThemeColors = PluginSurfaceProps["theme"]["colors"];

/**
 * The one command that turns `needsScope` false. Spelled out as a constant
 * rather than trusting the server's `error` sentence to always contain it,
 * so the copy button and the acceptance of this view do not depend on wording
 * the server is free to change.
 */
const SCOPE_COMMAND = "gh auth refresh -h github.com -s read:project";

/** Each platform's own monospace face; there is no cross-platform name. */
const MONOSPACE = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" });

function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const minutes = Math.round((Date.now() - then) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.round(days / 30)}mo ago`;
}

/**
 * One item's leading glyph and colour, by what it is and where it stands.
 * `merged` borrows the accent colour rather than inventing a purple the theme
 * does not expose: the six status/accent tokens are what a plugin gets.
 */
function itemGlyph(item: ProjectItem, colors: ThemeColors): { name: string; color: string } {
  if (item.kind === "draft") return { name: "FileText", color: colors.foregroundMuted };
  if (item.kind === "pull-request") {
    if (item.state === "merged") return { name: "GitMerge", color: colors.accent };
    if (item.state === "closed") return { name: "GitPullRequestClosed", color: colors.statusDanger };
    if (item.state === "draft") return { name: "GitPullRequestDraft", color: colors.foregroundMuted };
    return { name: "GitPullRequest", color: colors.statusSuccess };
  }
  if (item.state === "closed") return { name: "CircleSlash", color: colors.statusDanger };
  return { name: "CircleDot", color: colors.statusSuccess };
}

/** What `loadProject` answered with, plus the reference it was asked for. */
interface ProjectDetail {
  title: string;
  url: string;
  columns: readonly { name: string; items: readonly ProjectItem[] }[];
}

export function ProjectsView(props: {
  theme: PluginSurfaceProps["theme"];
  layout: PluginSurfaceProps["layout"];
  login: string;
  owners: readonly string[];
  onOpenUrl: (url: string) => void;
}): JSX.Element {
  const { theme, layout, login, owners, onOpenUrl } = props;
  const fetchProjects = useRpc(listProjects);
  const fetchProject = useRpc(loadProject);

  const styles = useMemo(() => {
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
  }, [theme, layout]);

  // --- The project list ---

  const [projects, setProjects] = useState<readonly ProjectSummary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [needsScope, setNeedsScope] = useState(false);
  const [listLoading, setListLoading] = useState(true);

  /**
   * `owners` is the caller's live settings array, a fresh reference on every
   * render whether or not its contents changed. The effect keys off its join
   * instead, so a re-render that leaves the list itself unchanged does not
   * repeat the search.
   */
  const ownersKey = owners.join("\n");

  const loadProjects = useCallback(
    async function loadProjects(force: boolean) {
      setListLoading(true);
      setListError(null);
      try {
        const input =
          login === "" ? { owners: [...owners], force } : { login, owners: [...owners], force };
        const result = await fetchProjects(input);
        setProjects(result.projects);
        setListError(result.error);
        setNeedsScope(result.needsScope);
      } catch (cause) {
        setProjects([]);
        setListError(cause instanceof Error ? cause.message : String(cause));
        setNeedsScope(false);
      } finally {
        setListLoading(false);
      }
    },
    [fetchProjects, login, ownersKey],
  );

  useEffect(() => {
    void loadProjects(false);
  }, [loadProjects]);

  // --- Copying the scope command ---

  const [copied, setCopied] = useState(false);
  const copiedTimeout = useRef<NodeJS.Timeout | null>(null);
  useEffect(() => () => clearTimeout(copiedTimeout.current ?? undefined), []);
  const copyCommand = useCallback(async function copyCommand() {
    try {
      await copyText(SCOPE_COMMAND);
      setCopied(true);
      clearTimeout(copiedTimeout.current ?? undefined);
      copiedTimeout.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Denied or unavailable clipboard access. The command stays selectable
      // text in its box either way, so the user can still copy it by hand.
    }
  }, []);

  // --- One project's board ---

  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const openProject = useCallback(
    async function openProject(owner: string, number: number) {
      setDetailOpen(true);
      setDetail(null);
      setDetailError(null);
      setDetailLoading(true);
      try {
        const result = await fetchProject({ owner, number, force: false });
        setDetail({ title: result.title, url: result.url, columns: result.columns });
      } catch (cause) {
        setDetailError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setDetailLoading(false);
      }
    },
    [fetchProject],
  );

  const closeProject = useCallback(function closeProject() {
    setDetailOpen(false);
    setDetail(null);
    setDetailError(null);
  }, []);

  /**
   * An empty column is not the interesting case, but a project with nothing
   * in *any* column is: dropping every column then would leave the board
   * blank with no explanation, so the fallback keeps them all.
   */
  const visibleColumns = useMemo(() => {
    if (detail === null) return [];
    const populated = detail.columns.filter((column) => column.items.length > 0);
    return populated.length === 0 ? detail.columns : populated;
  }, [detail]);

  const renderProjectItem = useCallback(
    (item: ProjectItem, spaced: boolean) => {
      const glyph = itemGlyph(item, theme.colors);
      const rowStyle = spaced ? [styles.itemRow, styles.itemRowSpaced] : styles.itemRow;
      return (
        <Pressable
          key={item.id}
          style={rowStyle}
          accessibilityRole={item.url !== null ? "link" : "text"}
          disabled={item.url === null}
          onPress={item.url !== null ? () => onOpenUrl(item.url as string) : undefined}
        >
          <Icon name={glyph.name} size={16} color={glyph.color} />
          <Text style={styles.itemTitle} numberOfLines={1}>
            {item.title}
          </Text>
          {item.repository !== null && item.number !== null ? (
            <Text style={styles.itemMeta}>
              {item.repository}#{item.number}
            </Text>
          ) : null}
        </Pressable>
      );
    },
    [theme, styles, onOpenUrl],
  );

  if (detailOpen) {
    return (
      <View style={styles.screen}>
        <View style={styles.detailHeader}>
          <Pressable accessibilityRole="button" onPress={closeProject} style={styles.iconButton}>
            <Icon name="ChevronLeft" size={18} color={theme.colors.foreground} />
          </Pressable>
          <Text style={styles.detailTitle} numberOfLines={1}>
            {detail !== null && detail.title !== "" ? detail.title : "Project"}
          </Text>
          <View style={styles.headerSpacer} />
          {detail !== null && detail.url !== "" ? (
            <Pressable
              accessibilityRole="button"
              style={styles.button}
              onPress={() => onOpenUrl(detail.url)}
            >
              <Text style={styles.buttonLabel}>Open on GitHub</Text>
            </Pressable>
          ) : null}
        </View>
        {detailLoading ? (
          <View style={styles.centered}>
            <ActivityIndicator color={theme.colors.accent} />
          </View>
        ) : detailError !== null ? (
          <View style={styles.centered}>
            <Text style={styles.danger}>{detailError}</Text>
          </View>
        ) : (
          <ScrollView contentContainerStyle={styles.boardBody}>
            {visibleColumns.map((column) => (
              <View key={column.name === "" ? "\0no-status" : column.name} style={styles.group}>
                <Text style={styles.groupTitle}>
                  {column.name === "" ? "No status" : column.name}
                </Text>
                {column.items.map((item, index) => renderProjectItem(item, index > 0))}
              </View>
            ))}
          </ScrollView>
        )}
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.title}>Projects</Text>
        <View style={styles.headerSpacer} />
        {listLoading ? (
          <ActivityIndicator size="small" color={theme.colors.foregroundMuted} />
        ) : (
          <Pressable
            accessibilityRole="button"
            onPress={() => void loadProjects(true)}
            style={styles.iconButton}
          >
            <Icon name="RefreshCw" size={14} color={theme.colors.foreground} />
          </Pressable>
        )}
      </View>

      {listLoading && projects === null ? (
        <View style={styles.centered}>
          <ActivityIndicator color={theme.colors.accent} />
        </View>
      ) : needsScope ? (
        <View style={styles.scopeState}>
          <Icon name="Lock" size={28} color={theme.colors.foregroundMuted} />
          <Text style={styles.scopeTitle}>Projects need one more scope</Text>
          <Text style={styles.scopeBody}>
            {listError ?? "The GitHub token is missing the read:project scope Projects v2 needs."}
          </Text>
          <View style={styles.scopeCommandBox}>
            <Text style={styles.scopeCommand} selectable>
              {SCOPE_COMMAND}
            </Text>
          </View>
          <Pressable accessibilityRole="button" style={styles.button} onPress={copyCommand}>
            <Text style={styles.buttonLabel}>{copied ? "Copied" : "Copy command"}</Text>
          </Pressable>
        </View>
      ) : listError !== null ? (
        <View style={styles.centered}>
          <Icon name="AlertTriangle" size={24} color={theme.colors.statusDanger} />
          <Text style={styles.danger}>{listError}</Text>
        </View>
      ) : projects === null || projects.length === 0 ? (
        <View style={styles.centered}>
          <Text style={styles.emptyText}>No projects yet.</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.listBody}>
          {projects.map((project) => (
            <Pressable
              key={project.id}
              style={styles.projectRow}
              accessibilityRole="button"
              onPress={() => void openProject(project.owner, project.number)}
            >
              <View style={styles.projectRowMain}>
                <Text style={styles.projectTitle} numberOfLines={1}>
                  {project.title}
                </Text>
              </View>
              {project.shortDescription !== null && project.shortDescription !== "" ? (
                <Text style={styles.projectDescription} numberOfLines={1}>
                  {project.shortDescription}
                </Text>
              ) : null}
              <View style={styles.projectMetaRow}>
                <Text style={styles.projectMeta}>{project.owner}</Text>
                <Text style={styles.projectMeta}>·</Text>
                <Text style={styles.projectMeta}>
                  {project.itemCount} {project.itemCount === 1 ? "item" : "items"}
                </Text>
                <Text style={styles.projectMeta}>·</Text>
                <Text style={styles.projectMeta}>{relativeTime(project.updatedAt)}</Text>
                {project.closed ? (
                  <>
                    <Text style={styles.projectMeta}>·</Text>
                    <Text style={styles.closedBadge}>Closed</Text>
                  </>
                ) : null}
              </View>
            </Pressable>
          ))}
        </ScrollView>
      )}
    </View>
  );
}
