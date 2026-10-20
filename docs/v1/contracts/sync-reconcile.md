# v1.0 契约 · Binding / Provenance / Sync Baseline / Reconcile / ApplyMode

- 状态：**Frozen**（M0 / INH-1754，含 2026-10-07 原型补充）
- 代码（canonical）：`packages/core/src/v2/reconcile.ts`
- 测试（全组合 truth table）：`packages/core/src/v2/__tests__/reconcile.truth-table.unit.test.ts`（27/27 B/L/D 组合）

## BindingMode

`mirror | structured-merge | generated | native`。Generated 反向归属：候选 provenance 中 digest 唯一匹配 → unique；多于一个 → ambiguous；无 → unattributable。ambiguous/unattributable 必须人工归属或存为 native variant，**禁止隐式猜测**（`attributeGeneratedChange`）。

## Provenance 字段（`provenanceRecordSchema`）

targetLogicalPath、sourceAssetKey（序列化 key）、sourceRevision、converterId、converterVersion、managedRegion（结构化绑定的受管区，mirror 为 null）、outputDigest、conversionGrade、recordedAt。

## B/L/D 状态机（`reconcileState`）

输入只有 digest（null=absent），无任何时间字段——mtime/last-write-wins 在类型上不可表达：

| B | L | D | 状态 | 动作 |
|---|---|---|------|------|
| null | * | * | UNMANAGED | confirm-ownership（首次接管 Preview + ownership 确认） |
| b | =b | =b | CLEAN | none |
| b | ≠b | =b | LOCAL_CHANGED | capture |
| b | =b | ≠b | REMOTE_CHANGED | apply |
| b | ≠b | ≠b | L=D | CLEAN（收敛） | none |
| b | ≠b | ≠b | L≠D | CONFLICT | resolve-conflict |

生命周期状态由操作引擎叠加，不从 digest 推导：`PENDING_APPLY`、`PENDING_PUBLISH`、`BLOCKED_SECRET`、`BLOCKED_DEPENDENCY`、`DEGRADED`、`RECOVERY_REQUIRED`（枚举全集在 `SYNC_STATES`）。

## ApplyMode（原型补充）

- 基础模式：`overwrite` / `merge-add` / `add-only`；逐目标为 `{ kind:"per-target", defaultMode, targets{} }`（显式用户选择）。
- 文本类 kind（instructions/skills/commands/prompts/agents/native）`merge-add` 一律 blocked，必须逐目标显式选择（`resolveApplyMode`）。
- `STRUCTURED_MERGE_PRESERVES_UNKNOWN = true`：结构化合并保留 unmanaged 字段，**任何模式（含 overwrite）都不得关闭该保留**。
- 计划种类隔离（`PLAN_KINDS`）：`repo-set-sync`（集合对比→只写仓库工作树）、`git-to-runtime-apply`（只写 harness 目标）、`runtime-to-git-capture`（只写受管 repo 路径）。每个 plan 携带自己的 fresh revision + snapshotRef + ownershipProofRefs（`PlanBinding`），plan 之间不可互用旧数据。
- 跨集合比较：无可信共同基线 → `unknown-baseline`（明示未知，不猜测）。

## 一致性要求

同输入必须确定性输出同状态（truth table 测试逐组合断言两次调用一致）。
