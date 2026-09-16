import type { PluginTheme } from "@getpaseo/plugin";
import type { ProjectItem } from "../../shared/board";
import { prStatusColors } from "../theme/pr-colors";
import { prStatusIcon } from "./pr-status";

export function projectItemGlyph(item: ProjectItem, colors: PluginTheme["colors"]) {
  if (item.kind === "draft")
    return {
      name: "FileText",
      color: colors.foregroundMuted,
      label: "Draft note",
    };
  if (item.kind === "pull-request") {
    const status = prStatusIcon(
      {
        prState: item.state === "merged" ? "MERGED" : item.state === "closed" ? "CLOSED" : "OPEN",
        prReview: item.prReview,
      },
      item.state === "draft" ? "draft-prs" : "open-prs",
      prStatusColors(colors),
    );
    return {
      name: status.iconName,
      color: status.iconColor,
      label: status.label,
    };
  }
  if (item.state === "closed")
    return {
      name: "CircleSlash",
      color: colors.statusDanger,
      label: "Closed issue",
    };
  return {
    name: "CircleDot",
    color: colors.statusSuccess,
    label: "Open issue",
  };
}
