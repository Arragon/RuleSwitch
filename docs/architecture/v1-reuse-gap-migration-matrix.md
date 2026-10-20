# v1.0 Reuse / Gap / Migration Matrix（Phase A 审计）

> 状态：**Frozen（M0 / INH-1751）**。本文把 GitHub main（commit `c617707`）的真实实现映射到 v1.0 需求。
> 所有 evidence 均来自当前仓库的代码路径与测试名，不来自 README 摘要。
> **平台事实（M0 冻结时）**：Phase A 的原始真实 evidence 仅 Windows（Node 22.18.0 / Electron 43.4.1），macOS/Linux 当时未运行任何 native 测试，不得据此推断已支持。
> **后续更新（2026-10-20）**：macOS 已完成 typecheck 4 workspace、lint 0 error、unit 259、integration 69、E2E 8 的实测，M1–M6 的 macOS 声明由该 run 支撑；Phase A 的 Windows 证据不再作为唯一平台事实。Linux 仍未测试。本矩阵的 Reuse/Gap 判定本身未变。

## 1. 能力矩阵

| # | 能力 | 当前文件 / contract | 现有测试 evidence | v1.0 目标 | Delta | 迁移风险 | Owner |
|---|------|--------------------|-------------------|-----------|-------|----------|-------|
| 1 | Provider-neutral domain + strict schema | `packages/core/src/contracts.ts`、`schemas.ts`（Zod） | `packages/core/src/__tests__/schemas.unit.test.ts`（logical path 中立、大小写、ChangeSet 语义） | 保留为 Phase A 冻结层；v1.0 新契约在 `packages/core/src/v2/`（identity/reconcile/git-port/harness-adapter/stores/ipc-v2） | Extend（新增并行命名空间，不改旧文件） | 低：纯新增 | M0 已落（INH-1753~1757）；演进归 M1/M2 |
| 2 | Transaction state machine | `packages/core/src/transactions.ts` | `transactions.unit.test.ts`（成功路径、失败/回滚/恢复、非法迁移拒绝） | 原样复用；Batch Apply 为 journaled batch 扩展，不宣称跨 Harness 原子性 | Reuse + Extend（batch journal 在 M4） | 中：journal 需逐 target snapshot/apply/verify | INH-1789 |
| 3 | Preview / ChangeSet / stale preflight | `apps/desktop/src/main/application/rule-switch-application.ts`（preflight 重算 source/target/generated）；`packages/rulesync-provider/src/rulesync-provider.ts` | `tests/integration/walking-skeleton.integration.test.ts`："re-reads and hashes a source after an external modification before rejecting stale apply"、"rejects a stale target before writing and preserves the external edit" | Reuse：Git→runtime Apply、Capture、仓库编辑/删除各自绑定 fresh revision（v2 `PlanBinding`） | Reuse + 概念扩展 | 低 | INH-1783/1784/1848 |
| 4 | Raw-byte Snapshot / manifest v2 / traversal 拒绝 | `apps/desktop/src/main/infrastructure/storage.ts` | 同上："rejects a traversal payload in a tampered snapshot manifest before loading it" | Reuse：Restore/Batch Apply/Capture 前置快照都走同一 snapshot 引擎 | Reuse | 低 | INH-1789/1819 |
| 5 | Atomic write + verify + rollback | `apps/desktop/src/main/infrastructure/node-filesystem.ts` | 同上："rolls back exact bytes when the atomic workspace write fails" | Reuse | Reuse | 低 | INH-1819 |
| 6 | Ownership / delete guard / 反向 Restore | `rule-switch-application.ts` + storage ledger | 同上："restores captured ownership across reversible create and delete history"、"restores original ownership when commit metadata fails" | Reuse；v1.0 扩展到 Structured Merge 的 unmanaged 字段保留 | Reuse + Extend | 中：字段级 ownership 是新面 | INH-1786/1819 |
| 7 | Resource registry / opaque ID / path policy | `apps/desktop/src/main/infrastructure/node-filesystem.ts`（canonical/realpath/case 策略）；`apps/desktop/src/main/ipc.ts` | 同上："rejects forged and cross-workspace capabilities and invalid logical paths"；`apps/desktop/src/main/__tests__/electron-security.unit.test.ts`（IPC sender/frame 匹配、preload 仅 7 方法、CSP） | Reuse：v2 IPC 继续走 opaque ID + Main 侧授权；不新增 path 能力 | Reuse | 低 | INH-1757（v2 通道规则已冻结） |
| 8 | 7-method IPC（`ruleswitch:v1:*`） | `packages/core/src/ipc.ts`；`apps/desktop/src/preload/index.ts` | `packages/core/src/__tests__/ipc.unit.test.ts`（拒绝 path/command 能力） | 兼容窗口内冻结保留；v2 按 `packages/core/src/v2/ipc-v2.ts` 的命名空间规则逐能力增加 | Migrate（渐进） | 中：Renderer 双轨期状态一致性 | INH-1757 / M7 UI 切换 |
| 9 | Rulesync provider（detect/validate/stage/preview） | `packages/rulesync-provider/src/rulesync-provider.ts` | `tests/integration/rulesync-provider.integration.test.ts`（真实 Rulesync 16.14.0、symlink escape 拒绝、case-collision） | 降位为受控 converter（M6 INH-1802：Programmatic API + staging + source-root 防护） | Reposition | 低：边界已符合 | INH-1802 |
| 10 | UI Viewer / Markdown 安全 / Monaco Diff | `packages/ui/src/viewer-model.ts`、`markdown-preview.tsx`、`file-viewer.tsx`、`app.tsx` | `viewer-model.unit.test.ts`、`markdown-security.unit.test.ts`（raw HTML/script/handler 拒绝） | Reuse 组件；M7 重构 Shell/Navigation（INH-1808），单一 design authority | Reuse + Extend | 低 | INH-1808/1814 |
| 11 | Workspace 身份 | session-random（`rule-switch-application.ts`） | 无（已知缺口） | Replace：`v2/identity.ts` 稳定 repositoryId/projectId/assetKeyId/harnessInstanceId（golden vectors 已冻结） | Replace | 中：history rebind 策略见 INH-1757 | M1 INH-1764 |
| 12 | Git 集成 | 无 | 无 | 新建：`v2/git-port.ts` 契约（FF-only、scoped commit、fetch+revalidate push、Index 操作）；实现走 macOS 系统 Git（portable runtime 决策见 ADR-0006） | Gap（全新） | 高：remote race/pending publish | INH-1759~1762、1846 |
| 13 | Asset/Scope/Binding/Provenance | 无 | 无 | 新建：`v2/identity.ts` + `v2/reconcile.ts`（B/L/D truth table、ApplyMode、Generated 归属规则） | Gap（契约已冻结） | 高：M2/M4 实现须严格按契约 | INH-1766~1771、1784~1787 |
| 14 | Harness Adapter（Claude/Codex/Cursor/OpenCode） | 无（仅 Rulesync 单 target） | 无 | 新建：`v2/harness-adapter.ts` 7 方法 + CapabilityMatrix + conformance | Gap | 高 | INH-1775/1776（M3）→ 1803~1806（M6） |
| 15 | Local stores（binding/baseline/provenance/history） | snapshot/history ledger（`storage.ts`，unversioned） | 集成测试覆盖其行为 | Migrate：`v2/stores.ts` envelope v1 + legacy 识别 + 迁移失败阻断；旧 ledger 只读保留 | Migrate | 中：corrupt/partial 处理 | INH-1764/1772/1781 |
| 16 | Watcher | 无（显式 read 重算） | 无 | 新建：只 invalidation（`v2/ipc-v2.ts` WatchInvalidationEvent） | Gap | 中：chokidar 依赖审查 | INH-1782 |
| 17 | E2E | `tests/e2e/walking-skeleton.e2e.spec.ts`（Windows 1 条） | Playwright Electron 真实流程 | 保留；M3/M7/M8 增加 macOS 真机 E2E | Reuse + Extend | 中 | INH-1780/1818/1822 |
| 18 | Packaging/signing | `electron-builder.yml` 预留；未运行 | 无 | M8 才审查执行 | Non-goal（本阶段） | — | INH-1823 |

## 2. 不得回归的安全不变量（任何 v1.0 任务都不允许放宽）

1. Renderer 无 Node/fs/shell/Rulesync 直连；无 generic path/command IPC（新增仅目的型 v2 通道 + opaque ID）。
2. 写前 Plan→fresh preflight→backup/snapshot→apply→verify；stale plan 不可继续。
3. Unknown/unmanaged 默认 preserve；delete 需 ownership+ledger+digest 证明。
4. Snapshot payload containment（`files/NNNNNN.bin` + snapshot-root 复验）；manifest 篡改拒绝。
5. Source-root symlink 边界（Rulesync 调用前后枚举/realpath；staging/target 拒绝 symlink）。
6. IPC sender + main frame `processId`/`routingId` 双匹配；双向 strict schema。
7. Markdown/raw HTML 不执行、link inert。
8. Commit metadata 失败恢复旧 ownership/history 再 rollback；rollback 不可验证 → `RECOVERY_REQUIRED`。
9. secret 只存 reference；value 不进 repo/log/preview/diagnostic bundle（M5 INH-1798 落地，规则现在生效）。
10. Git FF-only、不 force push、不 auto merge/rebase/stash（v2 契约以方法缺席强制）。
11. macOS evidence 不得由 Windows fixture 冒充；跨平台行为只在 native runner 验证。

## 3. v1.0 核心能力的唯一 owner 映射

每个 v1.0 核心能力恰好一个后续 owner（或明确 Non-goal），防止重复实现：

- 稳定身份/local rebind → INH-1764（M1）
- Git runtime/portable、status/clone、fetch/FF/divergence、commit/push/pending-publish、Index/diff/log → INH-1759 / 1760 / 1761 / 1762 / 1846（M1）
- bare-remote 集成矩阵 + macOS smoke → INH-1765（M1）
- ruleswitch.yaml、repo layout loader、AssetKey 图、project binding、profile precedence、binding engine、local binding store、golden fixtures、Harness 登记 → INH-1766~1773、1847（M2）
- Skill asset 语义、Claude/Codex slice adapter、Capture、Publish+Cross-harness、Project AGENTS、M3 E2E → INH-1774~1780（M3）
- Scanner、B/L/D engine、structured merge ownership、conflict model、capture plan/provenance、batch apply、pending publish 恢复、crash recovery、watch、repo 编辑删除、应用模式、集合同步 → INH-1781~1790、1848~1850（M4）
- Config kinds + secret/dependency/conversion grade → INH-1791~1800（M5）
- 四 Harness adapter + conformance + Rulesync wrapper → INH-1801~1807（M6）
- 产品 UI（Onboarding/Overview/Library/Harnesses/Projects/Changes/History/Settings/Menu bar/UI E2E） → INH-1808~1818、1851~1857（M7）
- 安全迁移复核、failure injection、Recovery Center、clean-machine、packaging、性能、文档、Final Gate → INH-1819~1826（M8）
- Non-goal（本仓库范围外）：Android/移动端实现（仅数据格式兼容）。

## 4. 迁移顺序（与 ADR-0006 一致）

1. M0：v2 契约冻结（本文 + `packages/core/src/v2/` + golden/truth-table/conformance 测试）。
2. M1–M2：新 store envelope 与稳定身份落地；Phase A v1 IPC 原样保留（兼容窗口开始）。
3. M3–M6：v2 能力按里程碑实现；Phase A 行为保持可用。
4. M7：UI 切到 v2 read models；v1 7-method 仅在 E2E 兼容检查中保留。
5. M8：GA 前移除或封存 v1 独有入口（需 Final Gate 复核），旧 ledger 以 legacy 只读导出。
