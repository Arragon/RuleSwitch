# RuleSwitch Architecture

本文是 RuleSwitch 架构的 **canonical 入口与索引**。已接受 ADR、本文与 `packages/core` v1 contracts 共同定义冻结边界；文档必须区分 Phase A 已实现能力与后续目标。

## 1. Overview and Current Status

RuleSwitch 是面向 Windows、macOS、Linux 的 AI Coding Configuration Manager。v0.1 以 Universal Profile 和 Rulesync provider 将 `.rulesync` source 转换为工具配置，并坚持 preview-first：生成物先进入 staging，用户查看 Generated/Diff 后，事务才可 Snapshot、Apply、Verify、History 和 Restore。

**Phase A walking skeleton 已实现并在 Windows 实测。** 当前链路为：打开 workspace → 检测/读取一个 Rulesync Markdown source → Monaco Raw / sanitized Markdown preview → 系统默认应用打开 → Rulesync 16.14.0 生成 `codexcli/rules` 到 staging → Monaco Generated/Diff → stale preflight → raw-byte snapshot → atomic Apply/Verify → History → transactional Restore。Electron Main/Preload/Renderer、RulesyncProvider、UI、filesystem/storage/transaction executor 和 Playwright E2E 都已存在。

详细分册：

- [总体架构](architecture/overview.md)
- [跨平台策略](architecture/cross-platform.md)
- [安全边界](architecture/security.md)
- [事务与恢复](architecture/transactions.md)
- [Provider 边界](architecture/providers.md)
- [项目持久经验](know-how.md)
- [UI 工作策略](UI-Design-manual.md)
- [第三方声明](../THIRD_PARTY_NOTICES.md)

## 2. Tech Stack

- Runtime/build：Node `>=22.13.0`（Windows 实测 22.18.0）、Electron 43.4.1、electron-vite 5、Vite 7、TypeScript 5.9、esbuild 0.27.7（provider build tooling）、pnpm 11.24.0。
- UI：React/React DOM 19.2.4、Monaco 0.52.2、`@monaco-editor/react` 4.7、react-markdown 10.1、remark-gfm 4.0.1、rehype-sanitize 6。
- Engine/data safety：Rulesync 16.14.0 Programmatic API、Zod 4.2.1、write-file-atomic 7。
- Tests：Vitest 4、Playwright 1.62.1 Electron automation。
- Packaging：`apps/desktop/electron-builder.yml` 已预留目标，但 electron-builder dependency 尚未启用；详见 [Packaging and supply chain](#10-packaging-and-supply-chain)。

## 3. Repository and Module Responsibilities

```text
apps/desktop/
  src/main/index.ts                 Electron composition root + hardened BrowserWindow
  src/main/ipc.ts                   7-channel sender/schema validation and error mapping
  src/main/application/             session, stage, Apply/Restore transaction orchestration
  src/main/infrastructure/          Electron platform, resource registry/path policy, stores
  src/preload/index.ts              frozen DesktopApi contextBridge
  src/renderer/                     Vite/React bootstrap + CSP document
packages/core/                      frozen v1 domain, schemas, ports, IPC, state transitions
packages/rulesync-provider/         Rulesync detect/validate/stage/preview adapter
packages/ui/                        Phase A workbench, Monaco editors/diff, Markdown preview/styles
tests/fixtures/                     real Rulesync workspace fixture
tests/integration/                  provider and production-application integration
tests/e2e/                          real sandboxed Electron/Playwright walking skeleton
docs/architecture/                  architecture detail
docs/adr/                           accepted decisions
```

四层运行时方向固定：Renderer/UI → typed Preload/IPC capability boundary → application/core → provider/platform/filesystem adapters。编译期 core 不依赖 Electron、React 或 Rulesync；adapters 依赖 core ports，Main composition root 组装实现。禁止反向依赖与过度 package 化。

构建/包装边界不改变四层：desktop package 不直接依赖 Rulesync，并由 electron-vite externalize `@ruleswitch/rulesync-provider`；provider 以自己的 esbuild 0.27.7 将 `src/index.ts` 及 adapter 内部模块 bundle 成单一 ESM `dist/index.js`，同时将 Rulesync 保持为 provider 的 external dependency。

## 4. Frozen v1 Baseline

`@ruleswitch/core` 冻结：

- domain：`Workspace`、`Profile`、`Target`、`FileResource`、`ChangeSet`、`Snapshot`、`ApplyTransaction`、`HistoryEntry`；
- ports：`ConfigProvider`、`PlatformService`、`HashService`；
- typed IPC：7 个 narrow methods、strict request/response schemas、`ruleswitch:v1:*` channels 与 `ApiResult`；
- transaction、security、canonical path、revision、snapshot 与 storage semantics。

`FileResource.logicalPath` 是 `/` 分隔的 provider-neutral 相对路径，禁止空 segment、`.`、`..`、反斜杠、绝对路径和 drive prefix。绝对 OS path 只保留在 Main resource/root registry。

Revision 对 raw bytes 做 SHA-256。`RevisionAggregate` serialization 是 `ruleswitch:file-revision-set:v1`：按 `resourceId` 字典序排列唯一文件，将 `[resourceId,digest,byteLength]` tuple 数组编码为 UTF-8 JSON，再计算 SHA-256。Preview 绑定 source/target/generated 三个 aggregate；Apply 重算并拒绝 stale。

## 5. Frontend Architecture

Renderer 通过 `window.ruleswitch` 的 7-method `DesktopApi` 工作，不直接接触 Node/Electron/path。`packages/ui/src/app.tsx` 实现三段工作台：source 列表与 Raw/Rendered/Open External；Generated/Diff/Apply；History/Restore。Raw、Generated 使用只读 Monaco Editor，Diff 使用 Monaco DiffEditor；Markdown 使用 GFM + sanitize，link 被替换为 inert text。

Phase B 的 v1-compatible 部分已将 source resources 按 Rules / Skills / Commands / MCP / Other 组织，并以统一只读 Viewer 按 `FileResource.format` 提供 Markdown、JSON/JSONC、YAML、TOML 与 text 高亮；Markdown frontmatter 与正文分区展示，raw HTML 不执行，链接仍保持 inert。Changes 区可选择全部 `ChangeSet.changes`，复用同一 Viewer 显示 generated/workspace origin 与 Diff。

Recent Workspaces、Profile CRUD/switch/persistence、Edit/Save、watcher 主动 invalidation、授权 Markdown links、Reveal 和 snapshot browsing 仍不能由冻结的 7-method IPC 表达，未建立旁路。所需 versioned capability/storage migration 见 Proposed ADR-0005。Monaco bundle 当前仍较大。

所有 UI 任务开始前阅读 `docs/UI-Design-manual.md`；同一界面只能有一个 generative visual-design authority，其余工具仅审查或做专项建议。

## 6. Backend and IPC

Main composition root 创建 `ElectronPlatformService`、`NodeFilesystemInfrastructure`、`DesktopStores`、`RulesyncProvider`、`RuleSwitchApplication`，初始化 incomplete-transaction gate，然后注册 IPC。

Preload 与 Main 均用 core Zod schemas 校验。Main 要求 `event.sender.id` 匹配目标 window，并以 main frame 的 `processId` 与 `routingId` 匹配 IPC frame。7 个方法为：`openWorkspace`、`readResource`、`openExternal`、`stageTarget`、`applyChangeSet`、`listHistory`、`restoreHistory`。不得新增 generic fs/shell/command/path channel。

Resource registry 保存 opaque ID、workspace、root、absolute/canonical path、origin、bytes metadata 与 read/open capability；每次操作复验 registry ownership、root identity、realpath containment 和 case ambiguity。`openExternal` 只授权 `origin:"source"` resource，最终才调用 Electron `shell.openPath`。

## 7. Data Flow

```text
Open Workspace → canonical root + capability registry → Rulesync detect/read
→ validate + safe source enumeration → generate to isolated staging
→ source/target/generated SHA-256 aggregates → ChangeSet → Monaco preview/diff
→ workspace mutex → source/target/generated stale preflight
→ raw-byte snapshot + manifest-v2 captured ownership → atomic write (fsync) → reread/hash verify
→ affected ownership + history → COMMITTED
failure → FAILED → ROLLING_BACK → verify → ROLLED_BACK
rollback failure → RECOVERY_REQUIRED + mutation gate
```

Restore 读取历史 source snapshot，先 snapshot 当前状态，再走同一状态机并写 restore history；commit 时按 source snapshot 恢复 affected ownership。因此 create/delete 可安全反向 Restore，原用户文件不会因恢复内容而被错误认领为 owned。

## 8. Actual Storage Layout

根由 Electron `app.getPath("userData")` 提供。Phase A 实际使用：

```text
<AppData>/
  staging/stage-*/                  isolated Rulesync output
  snapshots/<workspace-id>/<snapshot-id>/
    manifest.json
    files/000000.bin ...            exact raw payloads
  transactions/<transaction-id>/
    manifest.json                   state + per-file mutation ledger
  history/<workspace-id>/
    entries.json
  ownership/<workspace-id>/
    manifest.json
```

Internal snapshot manifest 当前为 version 2：除 public `Snapshot` 的 raw bytes/hash 语义外，还持久化 affected paths capture 时与 digest 匹配的 ownership metadata；core `Snapshot` public contract 未改变。Payload name 只接受 `files/NNNNNN.bin`，解析后还必须通过 snapshot-root containment。Transaction/history/ownership store 仍为 version 1。所有 metadata 经 strict/versioned schema 并用 write-file-atomic `{ fsync:true }` 写入。Profile 当前在 session 内构造，尚未持久化为 profile store。Workspace ID 当前每次 session 随机生成，因此跨重启 history rebind 尚未实现。

## 9. Verification Evidence

本次 Phase A 在 Windows、Node 22.18.0、Electron 43.4.1 上的真实记录：

- unit：35 passed；integration：13 passed；Playwright Electron E2E：1 passed；
- 中文与空格路径 `工作区 with spaces`；Renderer 中无 `require/process/ipcRenderer`，只见 7 个 API；
- Raw/sanitized Markdown、真实 system default open、Rulesync staging、Monaco generated/diff；
- Apply → Verify → History → Restore；BOM + CRLF raw bytes 精确恢复；unknown file 保持不变；
- integration 覆盖 create/delete/反向 Restore ownership、commit metadata failure rollback、篡改 snapshot traversal 拒绝。

这些是 Windows 证据。macOS/Linux 未测试；fixture 与 abstraction 不能替代 native runner。

常用命令见 [README](../README.md)。当前环境必须使用 `corepack pnpm ...`，裸 `pnpm` 不在 PATH。

## 10. Packaging and Supply Chain

`apps/desktop/electron-builder.yml` 预留 NSIS、DMG/ZIP、AppImage/deb，但 packaging/signing/CI 未执行，electron-builder dependency 未启用。Packaging 阶段必须重新审查后显式批准所需脚本或选择其他方案，不能静默放宽。

`pnpm allowBuilds` 当前显式保留且只有 `electron`、`esbuild`、`tldjs`，分别为 Electron 安装、Vite/provider build、Rulesync transitive 安装所必需。`chokidar` 当前不是依赖，留待 Phase B watcher 设计时再审查引入。esbuild 0.27.7（MIT，2026-04-02 发布）只用于构建 provider，不列为 shipped runtime。

直接运行时依赖均为 MIT/ISC。`corepack pnpm licenses list --prod` 显示 transitive 主体为 MIT/ISC/Apache/BSD；已识别的 permissive 例外为 Python-2.0 `argparse`、以 `Apache2` 标识的 `human-readable-ids`、public-domain `uri-templates`。`corepack pnpm audit --prod --registry=https://registry.npmjs.org` 无 known vulnerabilities；默认 npmmirror audit endpoint 不存在是当前环境限制，不等于审计结果。

## 11. Change Control

依赖方向、安全边界、7-method IPC、domain/provider/platform contracts、transaction/snapshot/path/storage semantics 是 v1 baseline。L2 若需修改 public interface、跨 package dependency、schema、filesystem 权限、覆盖/删除、transaction 或 snapshot format，停止并升级 L3。L3 若需修改 Provider contract、Native Provider 兼容性、transaction/security/path semantics、dependency direction、核心 storage 或 IPC，先写 ADR 提案并升级 L4；不得先改后报。

## 12. Remaining Phase A Boundaries and Risks

- 无 watcher/external-change auto refresh；现有 7-method IPC 没有 invalidation event。显式重新读取会 stat/read/hash，Apply stale preflight 仍拒绝外部 source/target 修改。
- 仅支持 Rulesync `codexcli` + `rules` 单 target；UI 已可选择 ChangeSet 全部文件，但 target/feature selection 尚未实现。
- Recent Workspace persistence/reopen、Profile lifecycle、Edit/Save、authorized Markdown links、Reveal 与 snapshot browsing 等待 ADR-0005 的 L4 capability/storage 决策。
- Workspace ID 按 session 随机；跨重启 history rebind 尚未实现。
- 完整 crash repair 仍是 P2：当前只有 manifest scan、root identity matching 与 mutation gate，没有 repair/diagnostics UI。
- Path-based write 的 check/use TOCTOU 仍是 P2；canonical/realpath/preflight 复验只缩小风险，不宣称消除竞态。
- Rollback itself failure、逐 crash phase 与 Windows/macOS/Linux native matrix 仍需扩充验证。
- Monaco bundle 较大。
- Packaging、signing、release CI 均未执行；预留配置不代表产物已验证。
