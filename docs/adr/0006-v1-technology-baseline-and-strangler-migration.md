# ADR-0006 · v1.0 技术基线与 Strangler Migration（Electron + TS Core）

- 状态：Accepted（M0 / INH-1752）
- 日期：2026-10-07
- 取代：旧 v0.1 计划中的 Rust/Tauri 假设（Legacy · v0.1 Superseded，全部 Canceled）

## Context

Phase A 已在 Windows 真机上验证了一条安全纵切（Preview/Diff、stale preflight、raw-byte Snapshot、Apply/Verify、History/Restore、ownership/delete guard、路径安全、E2E）。v1.0 需要 Git 双向同步、多 Harness、Project Scope 与产品 UI。问题是：重写还是演进。

## Decision

**保留并演进 Electron + React + TypeScript Core + Rulesync，采用 Strangler Migration。**

### 1. 分层与依赖方向（冻结）

```text
Renderer (packages/ui + apps/desktop renderer)
→ typed Preload + versioned IPC capability boundary (v1 7-method 兼容窗口 / v2 目的型通道)
→ Application Services（Repository / Assets / Projects / Reconcile / Capture-Publish / Transaction / History）
→ @ruleswitch/core（policies + schemas + ports，含 v2 契约）
→ Git / Filesystem / OS adapters；Harness Adapters；Rulesync 受控 converter
```

- 编译期 core 不依赖外层；adapter 依赖 core；Main 是唯一 composition root。
- v1.0 新契约位于 `packages/core/src/v2/`（Phase A 已占用 `CONTRACT_VERSION="v1"`，包内 v2 命名空间与 "Adapter v2 / IPC v2" 术语一致；产品版本仍是 v1.0）。

### 2. RuleSwitchApplication 拆分（Strangler 顺序）

现有 `rule-switch-application.ts`（1140 行）不一次性搬迁；按里程碑逐个抽出 application service，旧编排继续工作：

1. M1：`RepositoryService`（GitPort 装配）最先剥离；
2. M2：`AssetService` / `ProjectService`；
3. M4：`ReconcileService` / `CapturePublishService`；
4. 每 step：新 service 先被旧编排调用（阴影读），E2E 绿后旧路径删除。

### 3. IPC：versioned upgrade，不是旁路

- Phase A `ruleswitch:v1:*` 7 方法冻结不动（兼容窗口）。
- v2 按 `v2/ipc-v2.ts` 规则：仅 `ruleswitch:v2:<group>:<action>`（group ∈ 8 个冻结组），逐能力经 ADR/schema 审核加入；opaque ID；watcher 事件只带 identity+reason。
- 不存在 generic fs/shell/command/path 通道；Renderer 无自有持久真源。

### 4. Rulesync 定位

转换引擎而非业务核心：仅 Programmatic API、仅 staging 输出、source-root 防护（Phase A 已具备）；M6 以受控 wrapper（INH-1802）纳入 Adapter v2 体系。

### 5. 本地存储：versioned JSON stores（暂不引入 SQLite）

理由：当前数据规模（单用户、设备本地 binding/baseline/provenance/history）远低于 JSON 顺序读写的成本阈值；`v2/stores.ts` envelope + 迁移管线已冻结版本化语义。
**切换 SQLite 的客观触发条件**（满足其一并在 ADR 中记录）：单 store > 10MB 或 > 5k 条目导致启动解析 > 200ms；需要跨 store 事务性查询；需要增量追加写入以避免整文件重写。

### 6. Release policy

macOS → Windows → Linux 顺序冻结：M0–M8 只验证 macOS GA；Windows（M9）/Linux（M10）是 port，不改业务语义。

## Chosen vs Rejected

| 选项 | 结论 | 理由 |
|------|------|------|
| Electron + TS Core + Strangler（本 ADR） | **Chosen** | 复用已验证安全纵切与供应链审查；增量可回滚；团队/Agent 对栈熟悉 |
| Rust/Tauri 全量重写 | Rejected | 无验证收益；Phase A 安全语义需重新证明；供应链/构建链全部重做 |
| 混合（Electron + Rust sidecar 供 Git/加密） | Rejected | 提前优化；macOS 系统 Git + Node crypto 已满足 v1.0 需求；两套运行时复杂度 |
| 直接替换 Phase A 编排 | Rejected | 一次性大爆炸迁移不可回滚，违反 strangler 原则 |

## Migration order（摘要）

M0 契约（已完成）→ M1 GitPort/store → M2 asset graph → M3 纵切 → M4 reconcile → M5/M6 扩展 → M7 UI 切 v2 → M8 GA。详细 owner 映射见 `docs/architecture/v1-reuse-gap-migration-matrix.md`。

## Compatibility window

- 开始：M0（本 ADR）。
- 结束：M7 UI 全部切到 v2 read models 且 macOS UI E2E（INH-1818）绿。
- 窗口内 v1 7-method IPC 保持行为冻结；窗口结束后 v1 入口移除或封存由 M8 Final Gate（INH-1826）复核批准，旧 snapshot/history ledger 以 legacy 只读格式保留可导出。

## Rollback strategy

- v2 全部为新增文件/通道；任何里程碑失败可让 UI 继续走 v1 路径（Feature flag：Main 侧 capability registry 按通道注册）。
- Git tag 每里程碑打点；回滚 = 恢复 tag + 保留 v2 契约文件（纯新增无副作用）。
- Store 层：envelope v1 数据向前兼容设计；回滚到无 v2 代码时新 store 文件被旧代码当 unknown 文件忽略，不破坏旧数据。

## 重新评估 Rust/Tauri 的客观触发条件

1. macOS 性能基线（INH-1824）：冷启动 > 3s 或常驻内存 > 500MB 且 Electron 层优化无效；
2. Apple sandbox/hardened runtime 出现 Electron 无法满足的强制要求；
3. 跨平台文件系统/credential 原生能力缺口无法由现有 adapter 边界覆盖。
任一满足才开新 ADR；不因偏好重写。

## Consequences

- 短期：双 IPC 轨道与 v1/v2 并存的维护成本（窗口内）。
- 长期：安全证据延续、迁移可回滚、无重写风险。
- 本 ADR 无 TBD 项。
