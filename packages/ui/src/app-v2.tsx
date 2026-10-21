// App v2 (M7): the macOS product shell. Seven pages, light theme default,
// consuming ONLY the DesktopApiV2 read models — the Renderer assembles no
// business truth and holds no absolute paths. The v1 workbench stays
// available during the compatibility window.

import type {
  ApplyModeName,
  ApplyOutcome,
  ApplyPreview,
  DesktopApiV2,
  GitAreaReadModel,
  LibraryReadModel,
  OverviewReadModel,
  ProjectDto,
  RecoveryReadModel,
  HarnessDto,
  HarnessScanReadModel,
  OperationHistoryDto,
  RepositoryValidation,
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

/** Assets eligible for apply: native files are versioned, never projected. */
function applyAssetsOf(library: LibraryReadModel): {
  assetKey: string;
  kind: string;
  logicalName: string;
  contentBase64: string;
}[] {
  return library.entries
    .filter((entry) => entry.kind !== "native")
    .map((entry) => ({
      assetKey: entry.assetKey,
      kind: entry.kind,
      logicalName: entry.logicalName,
      contentBase64: ""
    }));
}

const APPLY_MODE_LABELS: Record<ApplyModeName, string> = {
  overwrite: "覆盖",
  "merge-add": "合并/新增",
  "add-only": "仅新增"
};

const REMOTE_VERIFIED_LABELS: Record<string, string> = {
  matched: "已匹配",
  mismatch: "不匹配",
  unknown: "未验证"
};

const PREVIEW_ACTION_LABELS: Record<string, string> = {
  apply: "将写入",
  noop: "已同步",
  "needs-adoption": "需接管确认",
  "skip-add-only-exists": "仅新增：已存在跳过",
  blocked: "被阻止"
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
  const [recovery, setRecovery] = useState<RecoveryReadModel | null>(null);
  const [harnessScan, setHarnessScan] = useState<HarnessScanReadModel | null>(null);
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
  const [applyPreview, setApplyPreview] = useState<ApplyPreview | null>(null);
  const [editor, setEditor] = useState<{ readonly logicalPath: string; readonly content: string } | null>(
    null
  );
  const [dialog, setDialog] = useState<DialogRequest | null>(null);
  const [repositoryValidation, setRepositoryValidation] = useState<RepositoryValidation | null>(null);
  const [projectForm, setProjectForm] = useState({
    projectId: "",
    displayName: "",
    localPath: ""
  });
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
          setHarnessScan(null);
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
          setRecovery(await api.recoveryStatus());
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
        fields: [
          { name: "directory", label: "仓库路径", placeholder: "/Users/you/config-repo", initialValue: "" }
        ],
        onConfirm: async (values) => {
          setDialog(null);
          const directory = values[0] ?? "";
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

  const cloneRepository = (): Promise<void> =>
    new Promise((resolve) => {
      setDialog({
        title: "克隆配置库",
        message:
          "从远端克隆一个新的配置库并打开。目标目录必须不存在；克隆成功不会自动推送，凭据由系统 Git 处理。",
        confirmLabel: "克隆并打开",
        fields: [
          {
            name: "remoteUrl",
            label: "远端地址",
            placeholder: "git@github.com:you/config.git",
            initialValue: ""
          },
          {
            name: "targetDirectory",
            label: "目标目录",
            placeholder: "/Users/you/RuleSwitch/config-repo",
            initialValue: ""
          }
        ],
        onConfirm: async (values) => {
          setDialog(null);
          const remoteUrl = (values[0] ?? "").trim();
          const targetDirectory = (values[1] ?? "").trim();
          await safeRun(async () => {
            const outcome = await api.cloneRepository(remoteUrl, targetDirectory);
            if (!outcome.ok) {
              setError(outcome.reason ?? "克隆失败（检查凭据、地址与目录权限）");
              return;
            }
            if (!outcome.manifestPresent) {
              setError("克隆成功但仓库根目录没有 ruleswitch.yaml，无法作为配置库使用");
            }
            const status = await api.repositoryStatus();
            if (status !== null) {
              setOverview(status);
            }
            setMessage("克隆完成并已打开配置库");
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

  const previewSelected = (): Promise<void> =>
    safeRun(async () => {
      const current = library ?? (await api.browseLibrary());
      if (current === null) {
        setError("未连接配置库");
        return;
      }
      if (selectedApplyTargets.length === 0) {
        setError("请至少选择一个目标工具");
        return;
      }
      setApplyOutcome(null);
      setApplyPreview(
        await api.previewApply(applyAssetsOf(current), applyMode, {
          confirmAdoption,
          targets: selectedApplyTargets
        })
      );
      setMessage("预览已生成；确认后才会写入");
    });

  const applySelected = (adoption: boolean): Promise<void> =>
    safeRun(async () => {
      const current = library ?? (await api.browseLibrary());
      if (current === null) {
        setError("未连接配置库");
        return;
      }
      const assets = applyAssetsOf(current);
      if (assets.length === 0) {
        setError("配置库没有可应用的资产");
        return;
      }
      if (selectedApplyTargets.length === 0) {
        setError("请至少选择一个目标工具");
        return;
      }
      if (applyPreview === null) {
        setError("请先生成预览再确认应用");
        return;
      }
      let outcome: ApplyOutcome;
      try {
        outcome = await api.applyToHarnesses(assets, applyMode, {
          confirmAdoption: adoption,
          targets: selectedApplyTargets,
          planRevision: applyPreview.planRevision
        });
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : "";
        if (message.includes("stale")) {
          // The plan no longer matches reality: force a fresh preview so the
          // user cannot confirm a plan built from old bytes.
          setApplyPreview(null);
          setError("预览已过期（仓库或目标已变化），请重新预览后确认");
          return;
        }
        throw cause;
      }
      setApplyPreview(null);
      setApplyOutcome(outcome);
      setMessage(
        `批量应用 ${outcome.status}：已应用 ${outcome.appliedCount} / 已同步 ${outcome.unchangedCount} / 未执行 ${outcome.blockedCount} / 失败 ${outcome.failedCount}`
      );
      setOverview(await api.repositoryStatus());
      setOperations(await api.operationHistory());
    });

  const validateCurrentRepository = (): Promise<void> =>
    safeRun(async () => {
      const validation = await api.validateRepository();
      setRepositoryValidation(validation);
      if (validation === null) {
        setError("未连接配置库");
            return;
      }
      setMessage(validation.ok ? "清单校验通过" : "清单存在问题，见下方诊断");
    });

  const beginDetect = (): Promise<void> =>
    safeRun(async () => {
      const status = await api.repositoryStatus();
      if (status === null) {
        dispatchOnboarding({ type: "connect-failed", message: "请先连接配置库" });
        return;
      }
      dispatchOnboarding({ type: "connected", overview: status });
      const detected = await api.listHarnesses();
      setHarnesses(detected);
      dispatchOnboarding({
        type: "harnesses-detected",
        harnesses: detected.map((harness) => ({
          harnessInstanceId: harness.harnessInstanceId,
          displayName: harness.displayName,
          installed: harness.installed
        }))
      });
    });

  const confirmHarnesses = (): Promise<void> =>
    safeRun(async () => {
      if (onboarding.selectedHarnessIds.length === 0) {
        dispatchOnboarding({ type: "error", message: "至少选择一个已安装工具" });
        return;
      }
      const bound = await api.listProjects();
      setProjects(bound);
      dispatchOnboarding({ type: "projects-loaded", projects: bound });
    });

  const runFirstPreview = (): Promise<void> =>
    safeRun(async () => {
      const current = library ?? (await api.browseLibrary());
      if (current === null) {
        dispatchOnboarding({ type: "error", message: "配置库尚未就绪，请先连接并校验" });
        return;
      }
      const preview = await api.previewApply(applyAssetsOf(current), applyMode, {
        targets: onboarding.selectedHarnessIds.map((harnessInstanceId) => ({ harnessInstanceId }))
      });
      dispatchOnboarding({
        type: "previewed",
        preview: {
          planRevision: preview.planRevision,
          applyCount: preview.applyCount,
          unchangedCount: preview.unchangedCount,
          needsAdoptionCount: preview.needsAdoptionCount,
          blockedCount: preview.blockedCount
        }
      });
    });

  const bindProject = (rebind: boolean): Promise<void> =>
    safeRun(async () => {
      const outcome = await api.bindProject({
        projectId: projectForm.projectId.trim(),
        displayName: projectForm.displayName.trim(),
        localPath: projectForm.localPath.trim(),
        ...(rebind ? { rebind: true } : {})
      });
      if (!outcome.ok) {
        setError(outcome.reason ?? "绑定失败");
        return;
      }
      setProjects(await api.listProjects());
      setProjectForm({ projectId: "", displayName: "", localPath: "" });
      setMessage(
        outcome.diagnostic !== null
          ? `项目已绑定（${REMOTE_VERIFIED_LABELS[outcome.remoteVerified]}）：${outcome.diagnostic}`
          : `项目已绑定（${REMOTE_VERIFIED_LABELS[outcome.remoteVerified]}）`
      );
    });

  const unbindProject = (projectId: string): Promise<void> =>
    safeRun(async () => {
      const ok = await api.unbindProject(projectId);
      if (!ok) {
        setError("解除绑定失败（项目未绑定）");
        return;
      }
      setProjects(await api.listProjects());
      setMessage(`已解除绑定 ${projectId}（配置库内容未改动）`);
    });

  const resolveCompareItem = (
    diff: SetCompareReadModel["diffs"][number],
    direction: "adopt-source" | "keep-target"
  ): Promise<void> =>
    safeRun(async () => {
      const fromPath = direction === "adopt-source" ? diff.sourceAssetKey : diff.targetAssetKey;
      const toPath = direction === "adopt-source" ? diff.targetAssetKey : diff.sourceAssetKey;
      if (fromPath === null || toPath === null) {
        setError("该条目缺少一侧的仓库路径，无法逐项处理");
        return;
      }
      const file = await api.readRepoFile(fromPath);
      if (file === null) {
        setError("无法读取来源内容（可能已被移动或删除）");
        return;
      }
      const written = await api.editRepoFile(toPath, file.contentBase64);
      if (!written) {
        setError("写入被拒绝（路径不在受管范围，或仓库版本已变化）");
        return;
      }
      setSetCompare(await api.setCompare());
      setGitArea(await api.gitArea());
      setMessage(
        `已按${direction === "adopt-source" ? "来源" : "目标"}覆盖：${diff.assetKey}（进入 Git 未暂存更改）`
      );
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
            <p className="app-v2-hint">
              步骤 {onboarding.step} · Git 来源分支{" "}
              {onboarding.overview?.branch ?? "—"} · 工作树{" "}
              {onboarding.overview?.workingTree ?? "—"}
            </p>
            {onboarding.error !== null && (
              <p role="alert" className="onboarding-error">
                {onboarding.error}
              </p>
            )}

            {onboarding.step === "connect" && (
              <div>
                <div className="app-v2-actions">
                  <button type="button" onClick={() => void connectRepository()}>
                    连接已有配置库
                  </button>
                  <button type="button" onClick={() => void cloneRepository()}>
                    克隆配置库
                  </button>
                  <button type="button" onClick={() => void validateCurrentRepository()}>
                    校验仓库清单
                  </button>
                  <button type="button" onClick={() => void beginDetect()}>
                    下一步：检测本机工具
                  </button>
                </div>
                {repositoryValidation !== null && (
                  <div className="app-v2-outcome" role="status" aria-label="仓库校验">
                    {repositoryValidation.ok ? (
                      <p>
                        清单有效：schema v{repositoryValidation.schemaVersion ?? "?"} ·{" "}
                        {repositoryValidation.assetCount} 个资产 ·{" "}
                        {repositoryValidation.projectCount} 个项目定义 ·{" "}
                        {repositoryValidation.profileCount} 个 profile
                      </p>
                    ) : (
                      <>
                        <p>清单不可用，需要先修复以下问题：</p>
                        <ul>
                          {repositoryValidation.diagnostics.map((diagnostic, index) => (
                            <li key={`${diagnostic.code}-${index}`}>
                              {diagnostic.code}
                              {diagnostic.logicalPath !== null ? ` · ${diagnostic.logicalPath}` : ""} —{" "}
                              {diagnostic.message}
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}

            {onboarding.step === "detect" && (
              <div>
                <p>
                  已安装工具 {onboarding.selectedHarnessIds.length}/
                  {onboarding.detectedHarnesses.length}（未安装工具请先安装/检测；未登记工具不会被自动配置）
                </p>
                <div className="app-v2-actions">
                  <button type="button" onClick={() => dispatchOnboarding({ type: "select-all-harnesses" })}>
                    全选
                  </button>
                  <button type="button" onClick={() => dispatchOnboarding({ type: "deselect-all-harnesses" })}>
                    全不选
                  </button>
                </div>
                <ul className="app-v2-list">
                  {onboarding.detectedHarnesses.map((harness) => (
                    <li key={harness.harnessInstanceId}>
                      <label className="app-v2-inline">
                        <input
                          type="checkbox"
                          checked={onboarding.selectedHarnessIds.includes(harness.harnessInstanceId)}
                          onChange={() =>
                            dispatchOnboarding({
                              type: "toggle-harness",
                              harnessInstanceId: harness.harnessInstanceId
                            })
                          }
                        />
                        {harness.displayName}（{harness.installed ? "已安装" : "未安装——先安装/检测"}）
                      </label>
                    </li>
                  ))}
                </ul>
                <div className="app-v2-actions">
                  <button
                    type="button"
                    disabled={!canProceedFromDetect(onboarding)}
                    onClick={() => void confirmHarnesses()}
                  >
                    下一步：绑定项目
                  </button>
                </div>
              </div>
            )}

            {onboarding.step === "bind" && (
              <div>
                <p>
                  项目绑定需要本地目录与远端身份校验。当前已绑定 {onboarding.projects.length} 个项目；
                  全局 scope 不依赖项目绑定即可继续。
                </p>
                <ul className="app-v2-list">
                  {onboarding.projects.length === 0 ? (
                    <li>尚未绑定项目。</li>
                  ) : (
                    onboarding.projects.map((project) => (
                      <li key={project.projectId}>
                        <span className="app-v2-asset">
                          {project.displayName}（{project.projectId}）
                        </span>
                        {project.available ? "可用" : "不可用"}
                      </li>
                    ))
                  )}
                </ul>
                <div className="app-v2-actions">
                  <button
                    type="button"
                    onClick={() => {
                      setPage("projects");
                      setOnboardingOpen(false);
                      void refresh("projects");
                    }}
                  >
                    前往项目页绑定
                  </button>
                  <button type="button" onClick={() => void runFirstPreview()}>
                    下一步：总预览
                  </button>
                </div>
              </div>
            )}

            {onboarding.step === "preview" && (
              <div>
                {onboarding.preview !== null && (
                  <div className="app-v2-outcome" role="status" aria-label="首个总预览">
                    <p>
                      将写入 {onboarding.preview.applyCount} / 已同步{" "}
                      {onboarding.preview.unchangedCount} / 需接管{" "}
                      {onboarding.preview.needsAdoptionCount} / 被阻止{" "}
                      {onboarding.preview.blockedCount}
                    </p>
                  </div>
                )}
                {onboarding.adoptionRequired && (
                  <p role="alert">
                    检测到已有目标文件——首次接管需要 Adoption/Ownership 确认，不会直接覆盖。
                  </p>
                )}
                <p className="app-v2-hint">
                  成功后不会自动 Push；重复执行不会重置你的本地内容。正式写入请到“配置库”页预览后确认。
                </p>
                <div className="app-v2-actions">
                  <button
                    type="button"
                    onClick={() => {
                      dispatchOnboarding({ type: "reset" });
                      setOnboardingOpen(false);
                    }}
                  >
                    完成
                  </button>
                </div>
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
                    onClick={() => void previewSelected()}
                  >
                    预览变更（{selectedApplyTargets.length} 个目标）
                  </button>
                  <button
                    type="button"
                    className="primary"
                    disabled={applyPreview === null || busy}
                    onClick={() => void applySelected(confirmAdoption)}
                  >
                    确认应用
                  </button>
                </div>

                {applyPreview !== null && (
                  <div className="app-v2-outcome" role="group" aria-label="变更预览">
                    <p>
                      预览 · 将写入 {applyPreview.applyCount} / 已同步{" "}
                      {applyPreview.unchangedCount} / 需接管 {applyPreview.needsAdoptionCount} /
                      被阻止 {applyPreview.blockedCount}
                    </p>
                    <ul>
                      {applyPreview.entries.map((entry) => (
                        <li key={entry.targetKey}>
                          {entry.displayName} · {entry.assetKind} ·{" "}
                          {APPLY_MODE_LABELS[entry.mode] ?? entry.mode} ·{" "}
                          {PREVIEW_ACTION_LABELS[entry.action] ?? entry.action}
                          {entry.blockedReason !== null ? ` — ${entry.blockedReason}` : ""}
                          {entry.requiresConfirmation ? "（需确认）" : ""}
                        </li>
                      ))}
                    </ul>
                    <p className="app-v2-hint">
                      确认会按此计划写入；若仓库、目标或接管选择在预览后发生变化，写入会被拒绝并要求重新预览。
                    </p>
                  </div>
                )}

                {applyOutcome !== null && (
                  <div className="app-v2-outcome" role="status" aria-label="应用结果">
                    <p>
                      {applyOutcome.status} · 已应用 {applyOutcome.appliedCount} / 已同步{" "}
                      {applyOutcome.unchangedCount} / 未执行 {applyOutcome.blockedCount} / 失败{" "}
                      {applyOutcome.failedCount}
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
            <p className="app-v2-hint">
              这里只展示本机已登记的真实工具与它们实际可写的配置类型。完整的分文件本地状态
              与 Capture 入口属于 INH-1854，尚未接入。
            </p>
            {harnesses.length === 0 ? (
              <p>尚未登记本机工具。在向导中检测已安装工具；未登记的工具不会被自动配置。</p>
            ) : (
              <table className="app-v2-table">
                <thead>
                  <tr>
                    <th scope="col">工具</th>
                    <th scope="col">状态</th>
                    <th scope="col">全局可写类型</th>
                    <th scope="col">项目可写类型</th>
                    <th scope="col">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {harnesses.map((harness) => (
                    <tr key={harness.harnessInstanceId}>
                      <td>
                        {harness.displayName}（{harness.adapterId}）
                      </td>
                      <td>{harness.installed ? `已安装 · ${harness.readiness}` : "未安装"}</td>
                      <td>{harness.globalKinds.length > 0 ? harness.globalKinds.join("、") : "无"}</td>
                      <td>{harness.projectKinds.length > 0 ? harness.projectKinds.join("、") : "无"}</td>
                      <td>
                        <button
                          type="button"
                          onClick={() =>
                            void safeRun(async () => {
                              const scan = await api.scanHarness(harness.harnessInstanceId);
                              setHarnessScan(scan);
                              if (scan === null) {
                                setError("该工具未登记，无法扫描");
                              }
                            })
                          }
                        >
                          扫描本机
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {harnessScan !== null && (
              <div className="app-v2-outcome" role="status" aria-label="本机扫描结果">
                <p>
                  {harnessScan.displayName} · 扫描于 {harnessScan.scannedAt.slice(0, 19)} ·
                  已纳管 {harnessScan.managedCount} · 未分类 {harnessScan.unclassifiedCount}
                  {harnessScan.truncated ? " · 结果已截断" : ""}
                </p>
                {!harnessScan.rootPresent ? (
                  <p>未发现该工具的全局目录（可能尚未安装或使用自定义位置）。</p>
                ) : harnessScan.files.length === 0 ? (
                  <p>目录存在但没有文件。</p>
                ) : (
                  <ul>
                    {harnessScan.files.map((file) => (
                      <li key={file.relativePath}>
                        {file.relativePath} · {file.byteLength} B ·{" "}
                        {file.kind ?? "未分类"} · {file.managed ? "RuleSwitch 管理" : "本机自有"}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </section>
        )}

        {page === "projects" && (
          <section aria-label="项目">
            <h1>项目</h1>
            <p className="app-v2-hint">
              项目本地设置与全局继承分别标记。绑定会校验目录可用性；远端身份只在能证明时报告为“匹配”，
              无法证明时明确显示“未验证”，不会静默应用。
            </p>
            <div className="app-v2-actions">
              <input
                type="text"
                aria-label="项目 ID"
                placeholder="项目 ID（如 prj_demo）"
                value={projectForm.projectId}
                onChange={(event) =>
                  setProjectForm({ ...projectForm, projectId: event.target.value })
                }
              />
              <input
                type="text"
                aria-label="项目名称"
                placeholder="项目名称"
                value={projectForm.displayName}
                onChange={(event) =>
                  setProjectForm({ ...projectForm, displayName: event.target.value })
                }
              />
              <input
                type="text"
                aria-label="项目目录"
                placeholder="本地项目目录绝对路径"
                value={projectForm.localPath}
                onChange={(event) =>
                  setProjectForm({ ...projectForm, localPath: event.target.value })
                }
              />
              <button
                type="button"
                disabled={
                  projectForm.projectId.trim().length === 0 ||
                  projectForm.displayName.trim().length === 0 ||
                  projectForm.localPath.trim().length === 0 ||
                  busy
                }
                onClick={() => void bindProject(false)}
              >
                绑定
              </button>
            </div>

            {projects.length === 0 ? (
              <p>尚未绑定项目。绑定后可在应用目标中选择该项目作用域。</p>
            ) : (
              <table className="app-v2-table">
                <thead>
                  <tr>
                    <th scope="col">项目</th>
                    <th scope="col">目录</th>
                    <th scope="col">远端身份</th>
                    <th scope="col">状态</th>
                    <th scope="col">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {projects.map((project) => (
                    <tr key={project.projectId}>
                      <td>
                        {project.displayName}（{project.projectId}）
                      </td>
                      <td>{project.localPathPresent ? "已绑定目录" : "未绑定"}</td>
                      <td>{REMOTE_VERIFIED_LABELS[project.remoteVerified] ?? project.remoteVerified}</td>
                      <td>{project.available ? "可用" : "不可用（路径移动或缺失）"}</td>
                      <td>
                        <button
                          type="button"
                          onClick={() => {
                            setProjectForm({
                              projectId: project.projectId,
                              displayName: project.displayName,
                              localPath: ""
                            });
                            setMessage("填入新目录后点击“绑定”将请求重新绑定确认");
                          }}
                        >
                          重新绑定
                        </button>{" "}
                        <button
                          type="button"
                          className="danger"
                          onClick={() => void unbindProject(project.projectId)}
                        >
                          解除绑定
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
            {(setCompare?.diffs ?? []).length === 0 ? (
              <p className="app-v2-hint">仓库内没有可比较的 Harness 配置集合。</p>
            ) : (
              <table className="app-v2-table">
                <thead>
                  <tr>
                    <th scope="col">资产</th>
                    <th scope="col">关系</th>
                    <th scope="col">逐项处理</th>
                  </tr>
                </thead>
                <tbody>
                  {(setCompare?.diffs ?? []).map((diff) => (
                    <tr key={diff.assetKey}>
                      <td>{diff.assetKey}</td>
                      <td>{relationLabel(diff.relation)}</td>
                      <td>
                        {diff.relation === "identical" || diff.relation === "unsupported" ? (
                          <span className="app-v2-hint">
                            {diff.relation === "identical" ? "无需处理" : "该类型不支持同步"}
                          </span>
                        ) : (
                          <>
                            <button
                              type="button"
                              disabled={diff.sourceAssetKey === null || diff.targetAssetKey === null}
                              onClick={() => void resolveCompareItem(diff, "adopt-source")}
                            >
                              采用来源
                            </button>{" "}
                            <button
                              type="button"
                              disabled={diff.sourceAssetKey === null || diff.targetAssetKey === null}
                              onClick={() => void resolveCompareItem(diff, "keep-target")}
                            >
                              保留目标
                            </button>
                            {diff.relation === "both-modified" ? (
                              <p className="app-v2-hint">双方都修改过，必须显式选择一侧。</p>
                            ) : null}
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
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
            <h2>待处理批次（Recovery Center）</h2>
            {recovery === null || recovery.batches.length === 0 ? (
              <p>没有需要处理的批次。</p>
            ) : (
              <ul className="app-v2-list">
                {recovery.batches.map((batch) => (
                  <li key={batch.batchId}>
                    <div>
                      <strong>{batch.status}</strong> · {batch.updatedAt.slice(0, 19)} ·{" "}
                      {batch.batchId}
                      <p className="app-v2-hint">{batch.guidance}</p>
                      <p className="app-v2-hint">
                        自动回滚：{batch.rollbackAvailable ? "可用" : "不可用"}
                        {batch.rollbackReason !== null ? `（${batch.rollbackReason}）` : ""}
                      </p>
                      {batch.rollbackAvailable && (
                        <div className="app-v2-actions">
                          <button
                            type="button"
                            className="danger"
                            onClick={() => {
                              setDialog({
                                title: `回滚批次 ${batch.batchId}？`,
                                message:
                                  "将把该批次写过的文件恢复成 apply 之前的字节；apply 之后又被修改的文件会被跳过并标记为需要人工处理。",
                                confirmLabel: "回滚",
                                tone: "danger",
                                onConfirm: async () => {
                                  setDialog(null);
                                  await safeRun(async () => {
                                    const outcome = await api.rollbackBatch(batch.batchId);
                                    if (!outcome.ok) {
                                      setError(
                                        `${outcome.reason ?? "回滚未完成"}（已恢复 ${outcome.restored}，失败 ${outcome.failed}）`
                                      );
                                    } else {
                                      setMessage(
                                        `已回滚 ${outcome.restored} 个文件（批次状态 ${outcome.status}）`
                                      );
                                    }
                                    setOperations(await api.operationHistory());
                                    setRecovery(await api.recoveryStatus());
                                  });
                                }
                              });
                            }}
                          >
                            回滚该批次
                          </button>
                        </div>
                      )}
                      <ul>
                        {batch.targets.map((target) => (
                          <li key={target.targetKey}>
                            {target.targetKey} · {target.state}
                            {target.detail !== null ? ` — ${target.detail}` : ""}
                          </li>
                        ))}
                      </ul>
                    </div>
                  </li>
                ))}
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
