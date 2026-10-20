// M7 UI v2 read-model shaping helpers (INH-1808/1810/1811): pure functions
// over Main-produced DTOs. The Renderer never assembles business truth —
// these helpers only group/sort/present what the capability service sent.

import type {
  GitAreaReadModel,
  LibraryEntryDto,
  LibraryReadModel,
  OverviewReadModel,
  SetCompareReadModel
} from "@ruleswitch/core";

export type NavPage =
  | "overview"
  | "library"
  | "harnesses"
  | "projects"
  | "changes"
  | "history"
  | "settings";

export const NAV_PAGES: readonly { readonly id: NavPage; readonly label: string }[] = Object.freeze([
  { id: "overview", label: "Overview" },
  { id: "library", label: "配置库" },
  { id: "harnesses", label: "本机 AI 工具" },
  { id: "projects", label: "项目" },
  { id: "changes", label: "同步变更" },
  { id: "history", label: "历史" },
  { id: "settings", label: "设置" }
]);

/** Library groups: by kindGroup, deterministic order, drafts surfaced first inside each group. */
export function groupLibraryEntries(
  entries: readonly LibraryEntryDto[]
): readonly { readonly group: string; readonly entries: readonly LibraryEntryDto[] }[] {
  const groups = new Map<string, LibraryEntryDto[]>();
  for (const entry of entries) {
    const bucket = groups.get(entry.kindGroup) ?? [];
    bucket.push(entry);
    groups.set(entry.kindGroup, bucket);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([group, groupEntries]) => ({
      group,
      entries: [...groupEntries].sort((left, right) => {
        if (left.state !== right.state) {
          return left.state === "draft" ? -1 : 1;
        }
        return left.logicalName < right.logicalName ? -1 : 1;
      })
    }));
}

export function librarySummary(library: LibraryReadModel | null): string {
  if (library === null) {
    return "未连接配置库";
  }
  const draftPart = library.draftCount > 0 ? `，${library.draftCount} 个工作树草稿` : "";
  return `HEAD ${library.headRevision?.slice(0, 7) ?? "（空）"} · ${library.entries.length} 个资产${draftPart}`;
}

export function overviewStatusLines(overview: OverviewReadModel | null): readonly string[] {
  if (overview === null || !overview.repositoryBound) {
    return ["尚未连接配置库", "通过 设置 → 连接 Git 仓库 开始"];
  }
  const lines = [
    `配置库已连接${overview.pendingPublish ? "（有待发布提交）" : ""}`,
    `工作树：${overview.workingTree}`,
    `项目 ${overview.projectCount} 个 · 本机工具 ${overview.harnessCount} 个`
  ];
  if (overview.libraryDrafts > 0) {
    lines.push(`配置库有 ${overview.libraryDrafts} 个未提交草稿`);
  }
  return lines;
}

/** Git area: managed/unmanaged split for the two-pane working area (INH-1856). */
export function splitGitChanges(gitArea: GitAreaReadModel | null): {
  readonly managed: readonly string[];
  readonly unmanaged: readonly string[];
  readonly summary: string;
} {
  if (gitArea === null) {
    return { managed: [], unmanaged: [], summary: "未连接配置库" };
  }
  const managed = gitArea.changes.filter((change) => change.managed).map((change) => change.logicalPath);
  const unmanaged = gitArea.changes.filter((change) => !change.managed).map((change) => change.logicalPath);
  const parts = [`${managed.length} 个受管更改`, `${unmanaged.length} 个未纳管文件`];
  if (gitArea.pendingPublish) {
    parts.push("有待发布提交");
  }
  return { managed, unmanaged, summary: parts.join(" · ") };
}

/** Set-compare presentation labels per the prototype copy (完整保留/效果一致/部分无法应用/不支持). */
export function relationLabel(relation: SetCompareReadModel["diffs"][number]["relation"]): string {
  switch (relation) {
    case "identical":
      return "效果一致";
    case "source-only":
      return "仅来源有";
    case "target-only":
      return "完整保留（目标独有）";
    case "source-updated":
      return "来源有更新";
    case "target-modified":
      return "目标有本地修改";
    case "both-modified":
      return "双方都有修改（需先解决）";
    case "unsupported":
      return "不支持";
  }
}

export function setCompareSummary(compare: SetCompareReadModel | null): string {
  if (compare === null) {
    return "未连接配置库";
  }
  const prefix =
    compare.confidence === "trusted" ? "有可信共同基线" : "无可信共同基线，以下仅作参考";
  const blocking = compare.diffs.filter((diff) => diff.relation === "both-modified" || diff.relation === "unsupported").length;
  return `${prefix} · ${compare.diffs.length} 项差异${blocking > 0 ? `（${blocking} 项需先处理）` : ""}`;
}
