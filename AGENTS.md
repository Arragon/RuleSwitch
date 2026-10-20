# RuleSwitch Agent Guide

本文件适用于整个仓库。更深目录的 `AGENTS.md` 只能增加局部约束，不能放宽这里的架构、安全或数据安全规则。

## Start Here

开始任何任务前依次阅读：

1. `AGENTS.md`
2. `README.md`
3. `docs/architecture.md`
4. `docs/architecture/**`
5. `docs/adr/**`（v1 主线关键决策：0006 技术基线与 Strangler、0007 Config Repo 存储关系、0008 macOS Git runtime、0009 M7 IPC 修订）
6. `docs/v1/**`（冻结契约与 threat model）
7. `docs/know-how.md`
7. 根 `package.json`、相关 package 的 `package.json`、`pnpm-workspace.yaml`
8. 相关源码、fixtures 和 tests

实现新阶段或追溯需求时还需阅读两份原始需求：`docs/ai-coding-config-manager-v0.1-development-plan.md`、`docs/ai-coding-config-manager-v0.1-agent-prompts.md`。UI/UX/样式任务开始前必须阅读 `docs/UI-Design-manual.md`；同一 surface 只允许一个 generative visual-design authority，其他 skill 只能审查或专项辅助。不要建立平行 design system。

## Current Repository Facts

- v1.0 主线（M0–M6）已实现并在 macOS 验证：v2 contracts、GitPort + 稳定身份、Config Repo layout / Asset Graph、One-Skill 与 Project AGENTS 双向纵切、B/L/D reconcile + journaled batch apply、配置类型扩展、四 Harness（Claude Code / Codex / Cursor / OpenCode）adapter 与 conformance。
- M7 产品 UI 进行中：`packages/ui/src/app-v2.tsx` 为七页 shell（Overview / 配置库 / 本机 AI 工具 / 项目 / 同步变更 / 历史 / 设置），消费只读 v2 read model；Phase A v1 workbench 在兼容窗口内保留（`RULESWITCH_SMOKE_WORKSPACE` 触发 v1 smoke 渲染）。
- 2026-10-20 macOS 实测（Electron 43.4.1）：typecheck 4 workspace 通过；lint 0 error；unit 259；integration 69（真实 bare remote、FF-only、remote race、Index 三版本 diff、discard 备份）；E2E 8（v2 shell 6 + Phase A walking skeleton 1 + 交互 1）。
- Phase A 原始证据为 Windows（Node 22.18.0 / Electron 43.4.1）；macOS 已由上述 run 覆盖；Linux 未测试。fixtures/abstraction 不能代替 native runner。
- 仓库文件读取、应用目标选择、adoption 门禁的协议变更见 ADR-0009；`IPC_V2_METHODS` 现为 21。
- `hasOwnership` 在 apply 路径仍恒为 false（未接 INH-1781 SyncBaseline store），因此已存在目标一律走 `needs-adoption`；这是保守偏差，不是静默放行。
- M7 未完成面：onboarding 无 clone/credential/manifest 校验、统一 Preview/Diff 面、本机工具与项目详情页仍为只读列表、仓库内逐项处理、Recovery Center、packaging/signing/CI。M8–M10 未开始。
- Workspace/repository 稳定身份已落地；跨重启 history rebind 由 v2 stores 承担，旧 unversioned ledger 只读保留。完整 crash repair UI 仍缺（manifest scan + mutation gate 已有）。
- 构建派生陷阱：`packages/*` 与 `apps/*` 的 unit/integration 测试解析 `@ruleswitch/core` 的 **dist**，因此 `test:unit` / `test:integration` / `packages/ui` 的 `build`+`typecheck` 都先构建 core；改 core 源码后不要直接跑 vitest，否则会对着旧产物得到假结果。
- Node engine `>=22.13.0`，pnpm 固定 11.24.0；当前环境裸 `pnpm` 不在 PATH。

## Architecture and Dependencies

四层运行时方向：

```text
Renderer / packages/ui
→ typed Preload + Main IPC capability boundary
→ RuleSwitchApplication + @ruleswitch/core
→ RulesyncProvider / ElectronPlatformService / Node filesystem and stores
```

编译期 core 声明 ports 且不依赖外层；adapters 依赖 core；Main composition root 组装。禁止 Renderer 访问 Node/fs/shell/Rulesync，禁止 core 依赖 Electron/React/Rulesync implementation，禁止 provider 依赖 Renderer。

构建/包装边界与上述四层运行时方向是两回事：desktop package 不直接依赖 Rulesync；`@ruleswitch/rulesync-provider` 用自己的 esbuild 0.27.7 将 adapter 内部模块 bundle 为单一 ESM 入口，Rulesync 保持 provider 的 external dependency；desktop 构建 externalize provider。不得把这种包装边界描述为运行时分层改变。

Package/module responsibilities：

- `packages/core`：provider-neutral domain、strict schemas、ports、Phase A 7-method IPC、v2 contracts（`src/v2/`：identity/reconcile/apply-plan/batch-apply/git-port/harness-adapter/stores/ipc-v2-channels）、revision/state rules；
- `packages/rulesync-provider`：Rulesync 16.14.0 detect/validate/stage/preview，并作为受控 converter（`rulesync-converter.ts`）；
- `apps/desktop/src/main`：window/IPC/application composition、authorization、transactions；
- `apps/desktop/src/main/application/capabilities-v2.ts`：唯一 v2 读模型与写能力入口（21 通道）；
- `apps/desktop/src/main/infrastructure`：Electron platform、resource registry/path policy、atomic fs/stores、`git/`（runtime/porcelain/identity/binding/sync-state）、`harness/`（adapter v2 / skill slice）；
- `apps/desktop/src/preload`：暴露 frozen `DesktopApi`、`DesktopApiV2` 与 v1-smoke 布尔标志；
- `packages/ui`：v2 七页 workbench（`app-v2.tsx` + model 层 + `dialog.tsx` 确认面）与 Phase A workbench、Monaco、sanitized Markdown；
- `tests/integration`、`tests/e2e`：真实 provider/application 与 Electron flow；E2E 统一走 `tests/e2e/launcher.ts`。

## Frozen v1 Baseline

以下保持冻结：

- `Workspace`、`Profile`、`Target`、`FileResource`、`ChangeSet`、`Snapshot`、`ApplyTransaction`、`HistoryEntry`；
- `ConfigProvider`、`PlatformService`、现有 `HashService`；
- 7 个 typed IPC 方法、strict schemas 与 `ruleswitch:v1:*` channels；
- SHA-256 revision aggregate；
- transaction state machine、raw snapshot、stale preflight、atomic write/verify/rollback/restore/recovery semantics；
- Renderer/resource capability security boundary；
- canonical path/symlink/allowed-root/unknown deletion policy；
- filesystem-first storage semantics 与 package dependency direction。

不得复制 domain、绕过 schema、把 path 暴露给 Renderer、扩大 IPC 或用 CLI 绕过 provider。

### Escalation

L2 若需修改 public interface、增加跨 package dependency、schema 无法表达、直接 filesystem access、覆盖/删除、transaction 或 snapshot format，停止并升级 L3。

L3 若需修改 Provider contract、Native Provider compatibility、transaction/security/path semantics、dependency direction、核心 storage 或 IPC contract，先提交 ADR/migration/version proposal 并升级 L4，不得先改后报。L2/L3 都不能静默修改 frozen baseline。

## Security and Data Safety

- BrowserWindow：sandbox/contextIsolation on、nodeIntegration off；deny new window/navigation/redirect/webview；保持 CSP。
- Preload 暴露面锁定为三处：frozen v1 `DesktopApi`（7 methods）、`DesktopApiV2`（21 个 purpose-built 通道，见 ADR-0009）、`ruleswitchV1SmokeMode` 布尔标志。`electron-security.unit.test.ts` 断言这三处；新增第四处需 ADR。Main 同时匹配 IPC `sender` 与 main frame 的 `processId`/`routingId`；Preload/Main 双向 schema validation。
- v2 通道只接受 opaque 逻辑名/稳定 ID（`repo_/prj_/asset_/harn_/dev_`），不得新增通用 filesystem/shell/command/path/URL 能力；`readRepoFile` 每次对当前仓库重跑 inventory 解析，未知路径返回 null。
- `openExternal` 只授权 `origin:"source"` resource。
- Opaque resource ID 在 Main registry 绑定 workspace/root/canonical path/operation；每次操作重验 realpath/containment/case。
- Markdown raw HTML 不执行，sanitize 后所有 link inert。
- Rulesync source 调用前后枚举/realpath；仅允许 source-root 内 symlink，staging/target 拒绝 symlink。
- Preview 只写 staging；Apply preflight 重算 source/target/generated。Core `Snapshot` public contract 不变；internal snapshot manifest 为 version 2，除 exact bytes/hash 还保存 affected path capture 时匹配 digest 的 ownership metadata。
- Snapshot payload 只接受 `files/NNNNNN.bin` 并再次做 snapshot-root containment；write-file-atomic 使用 fsync 并重读/hash。
- Unknown 默认 preserve；delete 需 ownership+ledger+digest。Restore commit 按 source snapshot 替换 affected ownership，支持安全 create/delete 反向 Restore且不错误认领原用户文件。
- Commit metadata 写入失败先恢复旧 ownership/history，再 rollback；Rollback 无法验证进入 `RECOVERY_REQUIRED`。Restore 先 snapshot 当前状态。
- Watcher 后续只能触发 invalidation，不能代替 stat/read/hash 或 mutex/preflight；`chokidar` 仅在 Phase B 需要时再审查引入。

## Rulesync Rules

固定 Rulesync 16.14.0，使用 named `generate(...)` Programmatic API，不 spawn CLI/解析 stdout。参数为 `inputRoot` 与 `outputRoots`；输出只到独立 staging；固定 `targets:["codexcli"]`、`features:["rules"]`、`delete:false`。升级必须审查 API、symlink behavior、license/audit，并重跑 pinned fixtures 与 E2E。

## Commands

从 repository root 使用 Corepack；**不要使用裸 `pnpm`**：

```text
corepack pnpm install --frozen-lockfile
corepack pnpm run dev
corepack pnpm run build
corepack pnpm run typecheck
corepack pnpm run lint
corepack pnpm run test:unit
corepack pnpm run test:integration
corepack pnpm run test
corepack pnpm run test:e2e
corepack pnpm licenses list --prod
corepack pnpm audit --prod --registry=https://registry.npmjs.org
```

E2E 前先 build。涉及平台行为须在 native OS runner 验证；不得把 `--if-present`、fixture 或单 OS 结果描述为其他平台通过。

## Supply-chain and Packaging

直接 runtime dependencies 均为 MIT/ISC；见 `THIRD_PARTY_NOTICES.md`。esbuild 0.27.7（MIT，2026-04-02 发布）仅是 provider build tooling，不得误列为 shipped runtime。默认 npmmirror audit endpoint 不存在，必须用显式可用 registry，endpoint failure 不是 clean audit。

`pnpm allowBuilds` 显式保留且只有 `electron`、`esbuild`、`tldjs`：分别是 Electron 安装、Vite/provider build、Rulesync transitive 安装所必需。不得静默修改/放宽；`chokidar` 当前不在依赖中。

`apps/desktop/electron-builder.yml` 只是预留；packaging 阶段仍须审查并显式批准所需脚本或选择替代方案。不要声称 packaging/signing/CI 已运行。

## Working Rules and Definition of Done

- 修改前检查 `git status`，保护用户已有变更；不提交，除非用户明确要求。
- 最小化修改；不碰无关 code/config/lockfile。
- 新行为补正常、错误、边界与安全测试，不能 mock 掉核心安全语义。
- 新 runtime dependency 先检查标准能力、license、发布时间/维护、安全、transitive、build scripts、bundle 与跨平台。
- 架构、contract、命令、当前状态或持久踩坑改变时同步 canonical docs/ADR/know-how；know-how 只写复用事实。
- 完成报告必须列出修改、真实命令/结果、未运行项、未验证平台与风险。
