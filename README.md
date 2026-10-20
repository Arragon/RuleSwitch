# RuleSwitch

RuleSwitch 是 **Personal Agent Environment as Code**：一个普通 Git 仓库是配置的唯一持久同步事实源，RuleSwitch 负责把它安全投影到本机各 AI 工具的 global / project 配置，并支持反向 Capture → Commit → Publish。

## 当前状态（v1.0 主线）

- **M0–M6 已实现并在 macOS 验证**：v2 契约、GitPort + 稳定身份、Config Repo / Asset Graph、One-Skill 与 Project AGENTS 双向纵切、B/L/D reconcile + journaled batch apply、配置类型扩展、四 Harness（Claude Code / Codex / Cursor / OpenCode）adapter 与 conformance。
- **M7 产品 UI 进行中**：`packages/ui/src/app-v2.tsx` 为七页 shell，消费只读 v2 read model；配置库支持按工具选择目标、逐目标模式、adoption 确认与逐目标结果，并可在应用内编辑/删除仓库资产。
- **M8–M10 未开始**（GA 加固、Windows、Linux）。

最近一次 macOS 实测（Electron 43.4.1）：`typecheck` 4 workspace 通过、`lint` 0 error、unit 259、integration 69、E2E 8。Linux 未测试。

```text
Remote Git
  ↕
Local Config Repo
  ↕
Asset / Project / Binding Graph
  ↕
Bidirectional Reconcile + Conversion
  ↕
Safe Harness Projection
```

## Phase A（历史基线，仍保留于兼容窗口）

```text
Open Workspace
→ detect/read .rulesync Markdown
→ Monaco Raw + sanitized Rendered Preview
→ Open External with system default application
→ Rulesync 16.14.0 codexcli/rules generation into staging
→ Monaco Generated + Diff
→ stale preflight + raw-byte Snapshot
→ atomic Apply + Verify
→ History
→ transactional Restore
```

Phase A 的 transaction / snapshot / ownership / path 语义是 v1 复用的安全基线，由 `tests/integration/walking-skeleton.integration.test.ts` 与 `tests/e2e/walking-skeleton.e2e.spec.ts` 持续守护。

## Architecture

四层运行时方向（v2 在同一方向内增加 purpose-built 通道，不改变分层）：

```text
React/Monaco Renderer
→ typed Preload + Main IPC capability boundary（v1 7 methods + v2 21 channels）
→ RuleSwitchApplication / CapabilityServiceV2 + @ruleswitch/core
→ GitPort / Harness adapters / Electron platform / filesystem and store adapters
```

- `packages/core`：Phase A 冻结 domain、Zod schemas、ports、IPC、SHA-256 revision、transaction state machine；`src/v2/` 为 v1 契约（identity/reconcile/apply-plan/batch-apply/git-port/harness-adapter/stores/ipc-v2-channels）。
- `packages/rulesync-provider`：Rulesync 16.14.0 detect/validate/stage/preview；Programmatic API only。
- `apps/desktop`：Electron composition root、hardened window/preload、resource registry/path policy、transactions/stores、GitPort 与 Harness adapter。
- `packages/ui`：v2 七页 workbench、Phase A workbench、Monaco Editor/DiffEditor、sanitized inert Markdown。
- `tests/integration`、`tests/e2e`：真实 Rulesync/application/Git 与 Playwright Electron flow（E2E 统一 launcher）。

v1 契约与安全边界见 `docs/v1/`、`docs/architecture/`、`docs/adr/`（含 ADR-0006 … ADR-0009）。

这是运行时四层。构建/包装上，desktop 不直接依赖 Rulesync并 externalize `@ruleswitch/rulesync-provider`；provider 用自己的 esbuild 0.27.7 把 adapter 内部模块 bundle 为单一 ESM 入口，Rulesync 仍是 provider 的 external dependency。该包装方式不改变运行时层次。

Canonical detail：[docs/architecture.md](docs/architecture.md)。UI 工作先读 [docs/UI-Design-manual.md](docs/UI-Design-manual.md)。

## Prerequisites

- Node.js `>=22.13.0`（Windows verification 使用 22.18.0）
- Corepack
- 支持 Electron 43.4.1 的桌面环境

Package manager 固定 pnpm 11.24.0。当前 Windows 环境裸 `pnpm` 不在 PATH；所有命令从 repository root 通过 `corepack pnpm` 执行。

## Install and Run

```text
corepack pnpm install --frozen-lockfile
corepack pnpm run dev
```

`dev` 启动 Electron；Open Workspace 使用系统目录选择器。选择的 workspace 至少要有 `.rulesync/rules/*.md`。Apply 会修改生成目标（Phase A 为 `AGENTS.md`），请只对受控 workspace 使用。

## Build and Verification

```text
corepack pnpm run build
corepack pnpm run typecheck
corepack pnpm run lint
corepack pnpm run test:unit
corepack pnpm run test:integration
corepack pnpm run test
corepack pnpm run test:e2e
```

E2E 必须先 build。`test:e2e` 使用 Playwright 启动真实 Electron，将 `tests/fixtures/rulesync-provider/workspace` 复制到带中文和空格的临时 workspace，通过 Main-only `RULESWITCH_SMOKE_WORKSPACE` 选择它，并走完 UI。测试会调用真实 `shell.openPath`，因此系统默认 Markdown 应用可能出现窗口。

不要直接修改 fixture 来手测；先复制 fixture 到临时目录。E2E 最后验证 `AGENTS.md` 恢复为原始 bytes、`unmanaged.txt` 不变、Renderer 无 page/console errors。

本次 Windows Phase A 记录：

- unit：35 passed；
- integration：13 passed；
- Playwright Electron E2E：1 passed；
- Node 22.18.0、Electron 43.4.1；
- system default open 成功；中文+空格 workspace、Rulesync staging、Monaco diff、Apply/Verify/History/Restore 成功；raw BOM+CRLF 精确恢复，unknown file unchanged。

## Platform Statement

Windows 是当前唯一实测平台。macOS/Linux 是目标平台但尚未运行 native test、Electron smoke 或 packaging。Path fixtures 和 abstraction 不能代替 native runner，不能将其描述为已支持。

`apps/desktop/electron-builder.yml` 预留 Windows NSIS、macOS DMG/ZIP、Linux AppImage/deb；electron-builder dependency 未启用，packaging/signing/CI 未执行。原因与供应链决策见 [docs/architecture.md](docs/architecture.md#10-packaging-and-supply-chain)。

## Security and Data Safety

- Renderer `sandbox:true`、`contextIsolation:true`、`nodeIntegration:false`；window/navigation/redirect/webview deny。
- Preload 只暴露 7 个 typed methods；不提供 generic fs/shell/command/path API。
- Main 用 opaque resource ID、strict IPC schemas、匹配 `sender` 与 main frame `processId`/`routingId`、canonical/realpath containment 和 case-collision policy 授权。
- `openExternal` 只接受已授权的 source-origin resource；不是任意 path/URL launcher。
- Markdown raw HTML 不执行，所有 links 在 Phase A preview 中 inert。
- Rulesync 输出只进入 app-data staging，调用前后验证 source；越界 symlink 被拒绝。
- Apply 前重验 source/target/generated；core `Snapshot` public contract 未变。Internal snapshot manifest version 2 保存 raw bytes/hash 与 capture 时受影响路径的 ownership metadata；payload 严格为 `files/NNNNNN.bin` 并做 snapshot-root containment。
- Unknown files 默认保留；delete 要 ownership/ledger/digest 证明。Restore commit 按 source snapshot 恢复 affected ownership，可安全反向 create/delete 且不会把原用户文件误认领为 owned。
- Commit metadata failure 会恢复旧 ownership/history 并 rollback；rollback 无法验证进入 `RECOVERY_REQUIRED`。

## Next-stage Boundaries

Phase B 应增加 watcher/external-change auto refresh、完整 source/change browser 与更多 profile UX，同时不改变 frozen v1 contracts；`chokidar` 尚未依赖，只在 Phase B 需要时再审查引入。P2 仍包括 path-based write 的 check/use TOCTOU 与完整 crash repair；现有复验和 mutation gate 不代表两者已解决。后续还需 stable workspace identity/history rebind、逐 crash phase/rollback itself failure tests、Monaco bundle optimization，以及 macOS/Linux native matrix。Packaging 仍未运行；后续须审查并显式批准 build scripts 或选择替代方案，不得静默放宽供应链策略。

`pnpm allowBuilds` 当前显式保留 `electron`、`esbuild`、`tldjs`，分别服务 Electron 安装、Vite/provider build、Rulesync transitive 安装；esbuild 0.27.7 是 MIT build tooling，不是 shipped runtime。

Third-party summary：[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
