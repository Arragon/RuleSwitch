// App v2 (M7): the macOS product shell. Seven pages, light theme default,
// consuming ONLY the DesktopApiV2 read models — the Renderer assembles no
// business truth and holds no absolute paths. The v1 workbench stays
// available during the compatibility window.

import type {
  ApplyModeName,
  ApplyOutcome,
  DesktopApiV2,
  GitAreaReadModel,
  LibraryReadModel,
  OverviewReadModel,
  ProjectDto,
  HarnessDto,
  OperationHistoryDto,
  SetCompareReadModel,
  SettingsReadModel
} from "@ruleswitch/core";import { NAV_PAGES, type NavPage } from "./app-v2-model";
import { ConfirmDialog, type DialogRequest } from "./dialog";
import {
  groupLibraryEntries,
  librarySummary,
  overviewStatusLines,
  relationLabel,
  setCompareSummary,
  splitGitChanges
} from "./app-v2-model";
import {
  canProceedFromDetect,
  initialOnboardingState,
  reduceOnboarding,
  type OnboardingAction
} from "./onboarding-model";
import { shapeBatchResult } from "./preview-model";
import { useMemo, useReducer, useState } from "react";

export interface AppV2Props {
  readonly api: DesktopApiV2;
}

/** Renderer-side base64 encode; the Renderer still never sees repository paths. */
function encodeBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function decodeBase64(base64: string): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder().decode(bytes);
}

const APPLY_MODE_LABELS: Record<ApplyModeName, string> = {
  overwrite: "覆盖",
  "merge-add": "合并/新增",
  "add-only": "仅新增"
};

const APPLY_STATE_LABELS: Record<string, string> = {
  COMMITTED: "已应用",
  APPLY_FAILED: "应用失败",
  VERIFY_FAILED: "校验失败",
  SKIPPED_BLOCKED: "未执行",
  PENDING: "未开始",
  ROLLED_BACK: "已回滚"
};

export function AppV2({ api }: AppV2Props) {
  const [page, setPage] = useState<NavPage>("overview");
  const [overview, setOverview] = useState<OverviewReadModel | null>(null);
  const [library, setLibrary] = useState<LibraryReadModel | null>(null);
  const [gitArea, setGitArea] = useState<GitAreaReadModel | null>(null);
  const [setCompare, setSetCompare] = useState<SetCompareReadModel | null>(null);
  const [settings, setSettings] = useState<SettingsReadModel | null>(null);
  const [projects, setProjects] = useState<readonly ProjectDto[]>([]);
  const [harnesses, setHarnesses] = useState<readonly HarnessDto[]>([]);
  const [operations, setOperations] = useState<readonly OperationHistoryDto[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [commitMessage, setCommitMessage] = useState("");
  const [logPage, setLogPage] = useState<{ commits: readonly { revision: string; authorName: string; authoredAt: string; subject: string }[]; nextCursor: string | null } | null>(null);
  const [applyMode, setApplyMode] = useState<ApplyModeName>("overwrite");
  const [applyTargets, setApplyTargets] = useState<
    Record<string, { readonly selected: boolean; readonly mode: ApplyModeName }>
  >({});
  const [confirmAdoption, setConfirmAdoption] = useState(false);
  const [applyOutcome, setApplyOutcome] = useState<ApplyOutcome | null>(null);
  const [editor, setEditor] = useState<{ readonly logicalPath: string; readonly content: string } | null>(
    null
  );
  const [dialog, setDialog] = useState<DialogRequest | null>(null);
  const [onboarding, dispatchOnboarding] = useReducer(
    (state: ReturnType<typeof initialOnboardingState>, action: OnboardingAction) =>
      reduceOnboarding(state, action),
    initialOnboardingState()
  );
  const [onboardingOpen, setOnboardingOpen] = useState(false);

  const safeRun = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作未完成");
    } finally {
      setBusy(false);
    }
  };

  const refresh = (target: NavPage): Promise<void> => {
    switch (target) {
      case "overview":
        return safeRun(async () => {
          setOverview(await api.repositoryStatus());
        });
      case "library":
        return safeRun(async () => {
          setLibrary(await api.browseLibrary());
          const detected = await api.listHarnesses();
          setHarnesses(detected);
          // Target selection defaults to installed harnesses; an existing
          // choice (including a per-target mode) is preserved across refresh.
          setApplyTargets((current) => {
            const next: Record<string, { readonly selected: boolean; readonly mode: ApplyModeName }> = {};
            for (const harness of detected) {
              next[harness.harnessInstanceId] =
                current[harness.harnessInstanceId] ?? {
                  selected: harness.installed,
                  mode: "overwrite"
                };
            }
            return next;
          });
        });
      case "harnesses":
        return safeRun(async () => {
          setHarnesses(await api.listHarnesses());
        });
      case "projects":
        return safeRun(async () => {
          setProjects(await api.listProjects());
        });
      case "changes":
        return safeRun(async () => {
          setGitArea(await api.gitArea());
          setSetCompare(await api.setCompare());
        });      case "history":
        return safeRun(async () => {
          setOperations(await api.operationHistory());
        });
      case "settings":
        return safeRun(async () => {
          setSettings(await api.getSettings());
        });
    }
  };

  const selectPage = (target: NavPage): Promise<void> => {
    setPage(target);
    return refresh(target);
  };

  const connectRepository = (): Promise<void> =>
    new Promise((resolve) => {
      setDialog({
        title: "连接配置库",
        message: "输入本地 Git 仓库根目录路径。RuleSwitch 只会读取该仓库，不会自动推送。",
        confirmLabel: "连接",
        input: { label: "仓库路径", placeholder: "/Users/you/config-repo", initialValue: "" },
        onConfirm: async (directory) => {
          setDialog(null);
          await safeRun(async () => {
            const result = await api.openRepositoryFromDirectory(directory.trim());
            if (result === null) {
              setError("无法打开该目录为配置库（需要是一个 Git 仓库根目录）");
              return;
            }
            setOverview(result);
            setPage("overview");
          });
          resolve();
        }
      });
    });

  const selectedApplyTargets = Object.entries(applyTargets)
    .filter(([, choice]) => choice.selected)
    .map(([harnessInstanceId, choice]) => ({ harnessInstanceId, mode: choice.mode }));

  const saveEditor = (): Promise<void> =>
    safeRun(async () => {
      if (editor === null) {
        return;
      }
      const ok = await api.editRepoFile(editor.logicalPath, encodeBase64(editor.content));
      if (!ok) {
        setError("保存被拒绝（路径不在受管范围，或仓库版本已变化，请刷新后重试）");
        return;
      }
      setMessage(`已保存 ${editor.logicalPath}，进入 Git 未暂存更改`);
      setEditor(null);
      setLibrary(await api.browseLibrary());
      setGitArea(await api.gitArea());
    });

  const applySelected = (adoption: boolean): Promise<void> =>
    safeRun(async () => {
      const current = library ?? (await api.browseLibrary());
      if (current === null) {
        setError("未连接配置库");
        return;
      }
      const assets = current.entries
        .filter((entry) => entry.kind !== "native")
        .map((entry) => ({
          assetKey: entry.assetKey,
          kind: entry.kind,
          logicalName: entry.logicalName,
          contentBase64: ""
        }));
      if (assets.length === 0) {
        setError("配置库没有可应用的资产");
        return;
      }
      if (selectedApplyTargets.length === 0) {
        setError("请至少选择一个目标工具");
        return;
      }
      const outcome = await api.applyToHarnesses(assets, applyMode, {
        confirmAdoption: adoption,
        targets: selectedApplyTargets
      });
      setApplyOutcome(outcome);
      setMessage(
        `批量应用 ${outcome.status}：已应用 ${outcome.appliedCount} / 未执行 ${outcome.blockedCount} / 失败 ${outcome.failedCount}`
      );
      setOverview(await api.repositoryStatus());
      setOperations(await api.operationHistory());
    });

  const libraryGroups = useMemo(() => groupLibraryEntries(library?.entries ?? []), [library]);
  const gitSplit = splitGitChanges(gitArea);

  return (
    <div className="app-v2" data-theme={settings?.theme ?? "light"}>
      <nav className="app-v2-nav" aria-label="主导航">
        {NAV_PAGES.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={page === entry.id ? "nav-item active" : "nav-item"}
            onClick={() => void selectPage(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </nav>
      <main className="app-v2-main">
        {error.length > 0 && (
          <p className="app-v2-error" role="alert">
            {error}
          </p>
        )}
        {busy && <p aria-live="polite">处理中…</p>}

        {page === "overview" && (
          <section aria-label="Overview">
            <h1>Overview</h1>
            <ul>
              {overviewStatusLines(overview).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <button type="button" onClick={() => void connectRepository()}>
              连接配置库
            </button>{" "}
            <button
              type="button"
              onClick={() => {
                setOnboardingOpen(true);
              }}
            >
              配置新工具 / 新设备
            </button>
          </section>
        )}

        {onboardingOpen && (
          <section aria-label="Onboarding" className="onboarding">
            <h2>配置新工具 / 新设备</h2>
            <p>
              步骤 {onboarding.step} · 当前设备与 Git 来源可见（revision {onboarding.overview?.repositoryId?.slice(0, 7) ?? "—"}）
            </p>
            {onboarding.error !== null && (
              <p role="alert" className="onboarding-error">
                {onboarding.error}
              </p>
            )}
            {onboarding.step === "connect" && (
              <button
                type="button"
                onClick={() =>
                  void safeRun(async () => {
                    const result = await api.repositoryStatus();
                    if (result === null) {
                      dispatchOnboarding({ type: "connect-failed", message: "请先在 Overview 连接配置库" });
                      return;
                    }
                    dispatchOnboarding({ type: "connected", overview: result });
                  })
                }
              >
                下一步：检测本机工具
              </button>
            )}
            {onboarding.step === "detect" && (
              <div>
                <p>
                  已安装工具 {onboarding.selectedHarnessIds.length}/{onboarding.detectedHarnesses.length}（未安装工具请先安装/检测）
                </p>
                <button type="button" onClick={() => dispatchOnboarding({ type: "select-all-harnesses" })}>
                  全选
                </button>
                <button type="button" onClick={() => dispatchOnboarding({ type: "deselect-all-harnesses" })}>
                  反选
                </button>
                <ul>
                  {onboarding.detectedHarnesses.map((harness) => (
                    <li key={harness.harnessInstanceId}>
                      <label>
                        <input
                          type="checkbox"
                          checked={onboarding.selectedHarnessIds.includes(harness.harnessInstanceId)}
                          onChange={() => dispatchOnboarding({ type: "toggle-harness", harnessInstanceId: harness.harnessInstanceId })}
                        />
                        {harness.displayName}（{harness.installed ? "已安装" : "未安装——先安装/检测"}）
                      </label>
                    </li>
                  ))}
                </ul>
                <button type="button" disabled={!canProceedFromDetect(onboarding)} onClick={() => void refresh("harnesses")}>
                  下一步：绑定项目
                </button>
              </div>
            )}
            {onboarding.step === "bind" && (
              <div>
                <p>全局与多个项目选择：项目绑定需通过 Git remote 身份验证。</p>
                <button
                  type="button"
                  onClick={() =>
                    void safeRun(async () => {
                      setProjects(await api.listProjects());
                      dispatchOnboarding({ type: "projects-loaded", projects: await api.listProjects() });
                    })
                  }
                >
                  下一步：总预览
                </button>
              </div>
            )}
            {onboarding.step === "preview" && (
              <div>
                {onboarding.adoptionRequired && (
                  <p role="alert">检测到已有目标文件——首次接管需要 Adoption/Ownership 确认，不会直接覆盖。</p>
                )}
                <p>成功后不会自动 Push；重复执行不会重置你的本地内容。</p>
                <button type="button" onClick={() => dispatchOnboarding({ type: "reset" })}>
                  完成
                </button>
              </div>
            )}
          </section>
        )}

        {page === "library" && (
          <section aria-label="配置库">
            <h1>配置库</h1>
            <p>{librarySummary(library)}</p>

            {editor !== null && (
              <div className="app-v2-editor" role="group" aria-label="编辑仓库文件">
                <h2>编辑 {editor.logicalPath}</h2>
                <p className="app-v2-hint">
                  保存后仅进入 Git 未暂存更改；提交、推送与本机工具应用都是独立操作。
                </p>
                <textarea
                  aria-label="文件内容"
                  value={editor.content}
                  rows={14}
                  onChange={(event) =>
                    setEditor({ logicalPath: editor.logicalPath, content: event.target.value })
                  }
                />
                <div className="app-v2-actions">
                  <button type="button" onClick={() => setEditor(null)}>
                    取消
                  </button>
                  <button type="button" onClick={() => void saveEditor()}>
                    保存到工作树
                  </button>
                </div>
              </div>
            )}

            {libraryGroups.map((group) => (
              <div key={group.group}>
                <h2>{group.group}</h2>
                <ul className="app-v2-list">
                  {group.entries.map((entry) => (
                    <li key={entry.assetKey}>
                      <span className="app-v2-asset">{entry.logicalName}</span>{" "}
                      {entry.state === "draft" ? <span className="draft-badge">草稿</span> : null}{" "}
                      <button
                        type="button"
                        onClick={() =>
                          void safeRun(async () => {
                            const file = await api.readRepoFile(entry.assetKey);
                            if (file === null) {
                              setError("无法读取该资产内容（可能已被移动或删除）");
                              return;
                            }
                            setEditor({
                              logicalPath: entry.assetKey,
                              content: decodeBase64(file.contentBase64)
                            });
                          })
                        }
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setDialog({
                            title: `删除 ${entry.logicalName}？`,
                            message:
                              "该资产会从配置库工作树删除并进入 Git 未暂存更改；本机工具副本保持不变，提交后才会影响远端。",
                            confirmLabel: "删除",
                            tone: "danger",
                            onConfirm: async () => {
                              setDialog(null);
                              await safeRun(async () => {
                                const ok = await api.deleteRepoAsset([entry.assetKey], true);
                                if (!ok) {
                                  setError("删除被拒绝（需要 ownership/digest 证明）");
                                  return;
                                }
                                setMessage("已删除，进入 Git 未暂存更改");
                                setLibrary(await api.browseLibrary());
                                setGitArea(await api.gitArea());
                              });
                            }
                          });
                        }}
                      >
                        删除
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}

            <h2>应用到本机工具</h2>
            {harnesses.length === 0 ? (
              <p className="app-v2-hint">
                尚未登记本机工具。请先在向导或设置中检测已安装工具；未登记的工具不会被自动配置。
              </p>
            ) : (
              <>
                <p className="app-v2-hint">
                  为每个目标工具单独选择模式。目标已存在且没有 RuleSwitch 基线时，需要显式勾选接管确认，否则不会写入。
                </p>
                <table className="app-v2-table">
                  <thead>
                    <tr>
                      <th scope="col">选择</th>
                      <th scope="col">目标工具</th>
                      <th scope="col">作用域</th>
                      <th scope="col">模式</th>
                    </tr>
                  </thead>
                  <tbody>
                    {harnesses.map((harness) => {
                      const choice = applyTargets[harness.harnessInstanceId];
                      return (
                        <tr key={harness.harnessInstanceId}>
                          <td>
                            <input
                              type="checkbox"
                              aria-label={`选择 ${harness.displayName}`}
                              checked={choice?.selected ?? false}
                              disabled={!harness.installed}
                              onChange={(event) =>
                                setApplyTargets((current) => ({
                                  ...current,
                                  [harness.harnessInstanceId]: {
                                    selected: event.target.checked,
                                    mode: current[harness.harnessInstanceId]?.mode ?? "overwrite"
                                  }
                                }))
                              }
                            />
                          </td>
                          <td>
                            {harness.displayName}（{harness.adapterId}）
                            {harness.installed ? "" : " · 未安装"}
                          </td>
                          <td>全局</td>
                          <td>
                            <select
                              aria-label={`${harness.displayName} 应用模式`}
                              value={choice?.mode ?? "overwrite"}
                              onChange={(event) =>
                                setApplyTargets((current) => ({
                                  ...current,
                                  [harness.harnessInstanceId]: {
                                    selected: current[harness.harnessInstanceId]?.selected ?? false,
                                    mode: event.target.value as ApplyModeName
                                  }
                                }))
                              }
                            >
                              {Object.entries(APPLY_MODE_LABELS).map(([value, label]) => (
                                <option key={value} value={value}>
                                  {label}
                                </option>
                              ))}
                            </select>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>

                <div className="app-v2-actions">
                  <label className="app-v2-inline">
                    默认模式
                    <select
                      value={applyMode}
                      aria-label="默认应用模式"
                      onChange={(event) => setApplyMode(event.target.value as ApplyModeName)}
                    >
                      {Object.entries(APPLY_MODE_LABELS).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    onClick={() =>
                      setApplyTargets((current) => {
                        const next: Record<
                          string,
                          { readonly selected: boolean; readonly mode: ApplyModeName }
                        > = {};
                        for (const [id, choice] of Object.entries(current)) {
                          next[id] = { selected: choice.selected, mode: applyMode };
                        }
                        return next;
                      })
                    }
                  >
                    全部设为默认模式
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setApplyTargets((current) => {
                        const next: Record<
                          string,
                          { readonly selected: boolean; readonly mode: ApplyModeName }
                        > = {};
                        for (const harness of harnesses) {
                          if (!harness.installed) {
                            continue;
                          }
                          next[harness.harnessInstanceId] = {
                            selected: true,
                            mode: current[harness.harnessInstanceId]?.mode ?? applyMode
                          };
                        }
                        return next;
                      })
                    }
                  >
                    全选已安装
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setApplyTargets((current) => {
                        const next: Record<
                          string,
                          { readonly selected: boolean; readonly mode: ApplyModeName }
                        > = {};
                        for (const [id, choice] of Object.entries(current)) {
                          next[id] = { selected: false, mode: choice.mode };
                        }
                        return next;
                      })
                    }
                  >
                    全不选
                  </button>
                </div>

                <label className="app-v2-inline">
                  <input
                    type="checkbox"
                    checked={confirmAdoption}
                    onChange={(event) => setConfirmAdoption(event.target.checked)}
                  />
                  已确认接管已存在的目标（Adoption）
                </label>

                <div className="app-v2-actions">
                  <button
                    type="button"
                    disabled={selectedApplyTargets.length === 0 || busy}
                    onClick={() => void applySelected(confirmAdoption)}
                  >
                    应用到所选工具（{selectedApplyTargets.length}）
                  </button>
                </div>

                {applyOutcome !== null && (
                  <div className="app-v2-outcome" role="status" aria-label="应用结果">
                    <p>
                      {applyOutcome.status} · 已应用 {applyOutcome.appliedCount} / 未执行{" "}
                      {applyOutcome.blockedCount} / 失败 {applyOutcome.failedCount}
                    </p>
                    <ul>
                      {applyOutcome.entries.map((entry) => (
                        <li key={entry.targetKey}>
                          {entry.displayName} · {entry.assetKind} ·{" "}
                          {APPLY_MODE_LABELS[entry.mode] ?? entry.mode} ·{" "}
                          {APPLY_STATE_LABELS[entry.state] ?? entry.state}
                          {entry.detail !== null ? ` — ${entry.detail}` : ""}
                        </li>
                      ))}
                    </ul>
                    {applyOutcome.entries.some((entry) => entry.action === "needs-adoption") &&
                      !confirmAdoption && (
                        <p className="app-v2-hint">
                          有目标已存在但缺少基线。勾选“已确认接管已存在的目标”后重新应用即可写入。
                        </p>
                      )}
                  </div>
                )}
              </>
            )}
          </section>
        )}

        {page === "harnesses" && (
          <section aria-label="本机 AI 工具">
            <h1>本机 AI 工具</h1>
            {harnesses.length === 0 ? (
              <p>尚未登记本机工具。在设置中登记或检测已安装工具。</p>
            ) : (
              <ul>
                {harnesses.map((harness) => (
                  <li key={harness.harnessInstanceId}>
                    {harness.displayName}（{harness.adapterId}）— {harness.installed ? "已安装" : "未安装"} ·{" "}
                    {harness.readiness}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {page === "projects" && (
          <section aria-label="项目">
            <h1>项目</h1>
            {projects.length === 0 ? (
              <p>尚未绑定项目。</p>
            ) : (
              <ul>
                {projects.map((project) => (
                  <li key={project.projectId}>
                    {project.displayName}（{project.projectId}）—{" "}
                    {project.available ? "可用" : "不可用（路径移动或缺失）"}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {page === "changes" && (
          <section aria-label="同步变更">
            <h1>同步变更</h1>
            <h2>Git 仓库</h2>
            <p>{gitSplit.summary}</p>
            <ul>
              {gitSplit.managed.map((path) => (
                <li key={path}>
                  受管：{path}{" "}
                  <button
                    type="button"
                    onClick={() =>
                      void safeRun(async () => {
                        await api.stagePaths([path]);
                        setGitArea(await api.gitArea());
                      })
                    }
                  >
                    暂存
                  </button>{" "}
                  <button
                    type="button"
                    onClick={() =>
                      void safeRun(async () => {
                        await api.unstagePaths([path]);
                        setGitArea(await api.gitArea());
                      })
                    }
                  >
                    取消暂存
                  </button>
                </li>
              ))}
              {gitSplit.unmanaged.map((path) => (
                <li key={path}>未纳管：{path}</li>
              ))}
            </ul>
            <div>
              <input
                type="text"
                placeholder="提交说明"
                value={commitMessage}
                onChange={(event) => setCommitMessage(event.target.value)}
              />
              <button
                type="button"
                disabled={commitMessage.trim().length === 0}
                onClick={() =>
                  void safeRun(async () => {
                    const result = await api.commit(commitMessage.trim());
                    if (!result.ok) {
                      setError(result.reason);
                      return;
                    }
                    setCommitMessage("");
                    setMessage(`已提交 ${result.revision.slice(0, 7)}`);
                    setGitArea(await api.gitArea());
                  })
                }
              >
                提交（仅暂存版本）
              </button>
              <button
                type="button"
                onClick={() =>
                  void safeRun(async () => {
                    const result = await api.push();
                    if (!result.ok) {
                      setError(result.reason ?? "push failed");
                      return;
                    }
                    setMessage("推送成功");
                    setGitArea(await api.gitArea());
                  })
                }
              >
                推送
              </button>
              <button
                type="button"
                onClick={() =>
                  void safeRun(async () => {
                    const ok = await api.fetchRemote();
                    setMessage(ok ? "Fetch 完成（未改本地文件）" : "Fetch 失败");
                    setGitArea(await api.gitArea());
                  })
                }
              >
                Fetch
              </button>
              <button
                type="button"
                onClick={() =>
                  void safeRun(async () => {
                    const result = await api.fastForward();
                    if (!result.ok) {
                      setError(result.reason ?? "fast-forward failed");
                      return;
                    }
                    setMessage("已快前进到远端版本");
                    setGitArea(await api.gitArea());
                  })
                }
              >
                Fast-forward Pull
              </button>
            </div>
            {message && <p aria-live="polite">{message}</p>}
            <h3>提交记录</h3>
            <button
              type="button"
              onClick={() =>
                void safeRun(async () => {
                  setLogPage(await api.logPage(null, 10));
                })
              }
            >
              加载提交记录
            </button>
            {logPage !== null && (
              <ul>
                {logPage.commits.map((commit) => (
                  <li key={commit.revision}>
                    {commit.revision.slice(0, 7)} · {commit.subject} · {commit.authorName}
                  </li>
                ))}
              </ul>
            )}
            <h2>Harness 配置</h2>
            <p>{setCompareSummary(setCompare)}</p>
            <ul>
              {(setCompare?.diffs ?? []).map((diff) => (
                <li key={diff.assetKey}>
                  {diff.assetKey} — {relationLabel(diff.relation)}
                </li>
              ))}
            </ul>
          </section>
        )}

        {page === "history" && (
          <section aria-label="历史">
            <h1>历史</h1>
            {operations.length === 0 ? (
              <p>暂无设备操作记录。</p>
            ) : (
              <ul>
                {operations.map((operation) => {
                  const view = shapeBatchResult({
                    batchId: operation.batchId,
                    planId: operation.planId,
                    startedAt: operation.updatedAt,
                    updatedAt: operation.updatedAt,
                    status: operation.status as "PARTIAL_SUCCESS",
                    entries: operation.targets.map((target) => ({
                      targetKey: target.targetKey,
                      mode: target.mode as "overwrite",
                      planRevision: "",
                      state: target.state as "COMMITTED",
                      snapshotRef: null,
                      verifyDigest: null,
                      failureDetail: null,
                      rollbackOf: false
                    }))
                  });
                  return (
                    <li key={operation.batchId}>
                      {operation.updatedAt.slice(0, 19)} · {view.status} · 成功 {view.successful.length} / 失败{" "}
                      {view.failed.length} / 未开始 {view.notStarted.length}
                      {view.recoveryRequired ? " · 需要恢复" : ""}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        )}

        {page === "settings" && (
          <section aria-label="设置">
            <h1>设置</h1>
            <p>主题（默认亮色）：</p>
            <button
              type="button"
              onClick={() =>
                void safeRun(async () => {
                  setSettings(await api.setTheme("light"));
                })
              }
            >
              亮色
            </button>
            <button
              type="button"
              onClick={() =>
                void safeRun(async () => {
                  setSettings(await api.setTheme("dark"));
                })
              }
            >
              深色
            </button>
            <button
              type="button"
              onClick={() =>
                void safeRun(async () => {
                  setSettings(await api.setTheme("system"));
                })
              }
            >
              跟随系统
            </button>
          </section>
        )}
      </main>
      {dialog !== null && (
        <ConfirmDialog request={dialog} onCancel={() => setDialog(null)} />
      )}
    </div>
  );
}
