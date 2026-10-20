# v1.0 契约 · IPC v2 与 Local Store Versioning / Migration

- 状态：**Frozen**（M0 / INH-1757，含 2026-10-07 原型补充）
- 代码（canonical）：`packages/core/src/v2/ipc-v2.ts`（通道命名空间/事件/主题）、`packages/core/src/v2/stores.ts`（envelope/迁移/gate）
- 测试：`packages/core/src/v2/__tests__/stores.migration.unit.test.ts`（schema vectors、legacy fixture、corrupt fixture、迁移失败保真）

## IPC v2

1. **命名空间**：仅 `ruleswitch:v2:<group>:<action>`，group ∈ 8 冻结组（repository/projects/harnesses/assets/changes/history/operations/settings），`ipcV2ChannelSchema` 强校验。每个通道独立 ADR/schema 审核后加入，携带自己的 strict request/response schema 与 Main 侧授权。
2. **兼容窗口**：Phase A `ruleswitch:v1:*` 7 方法行为冻结并存；窗口关闭条件与回滚见 ADR-0006。Renderer 无自建持久真源，read model 一律 Main 产出 DTO。
3. **Opaque ID**：DTO 只用 `repo_/prj_/asset_/harn_/dev_` 稳定 ID 与句柄，任意 path/command 不存在。
4. **Watcher 事件**（`WatchInvalidationEvent`）：reason（6 值枚举）+ subjectId + occurredAt。只触发 invalidation → 重新 stat/read/hash/containment；事件本身永不授权写。
5. **v2 read model 覆盖面**（逐能力落通道时验收）：Library HEAD 与 draft 状态区分、本机工具/项目实际来源、Git Index/三版本差异/分页历史、仓库编辑删除计划、集合对比同步、多目标×多项目 mode 选择、Harness 本地登记。
6. **主题**：`light|dark|system`，默认 light，用户显式选择只存本地 settings store。

### 2026-10-20 修订（ADR-0009）

M7 实机核对后对 v2 IPC 做三处**向后兼容**修订，理由与备选方案见 `docs/adr/0009-m7-ipc-amendments-read-apply-adoption.md`：

1. 新增 `ruleswitch:v2:assets:read-file`（`library.readFile` / `readRepoFile(logicalPath)`）：请求 `{ logicalPath }`（= `assetKey`），响应 `{ logicalPath, contentBase64 } | null`；Main 每次对当前仓库重跑 inventory，未知路径返回 null，不引入通用 readFile 能力。方法总数 20 → 21。
2. `ruleswitch:v2:operations:apply-to-harnesses` 增加可选 `targets[]`（`harnessInstanceId` + 可选 `mode` + 可选 `scope`）与可选 `confirmAdoption`。省略 `targets` 保持旧行为；提供时为穷尽选择，未登记 harness 抛错，未安装/未绑定 project 记为 blocked。`confirmAdoption` 默认 false，已存在目标一律先 `needs-adoption`。
3. 响应由 `{ batchId }` 扩展为 `ApplyOutcome`（含 per-target `action/state/detail`），仍不含路径。

同时修正 `apply-plan.ts` 中 `add-only` 与 `needs-adoption` 的判定顺序：`add-only` 必须在 ownership 门禁之前短路，否则“绝不覆盖”的模式反而要求用户确认接管。

## Local stores

1. **Envelope**：`{ store, version, writtenAt, data }`，version 从 1 起。8 个冻结 store（repositories/projects/harness-registry/profiles/sync-baselines/provenance/operations-history/settings）。
2. **解析结果即值**（不 throw）：`ok | legacy(unversioned-phase-a) | future-version | corrupt | wrong-store`；分别映射 gate 状态 `open / read-only-legacy / blocked-future-version / blocked-corrupt`。
3. **迁移管线**（`migrateStore` 纯函数）：按 fromVersion→toVersion 步骤链顺序执行；缺步或步骤抛错 → `migration-failed(originalPreserved:true)`，宿主必须保持原文件原样并将 store 标记 blocked-migration-failed，**阻断一切 destructive mutation**。
4. **Corrupt**：宿主 quarantine（改名保留），不删除；修复前 gate 阻断。
5. **Phase A 迁移策略**：旧 unversioned snapshot/history ledger → `legacy`，只读可导出；session-random workspaceId 无法重绑稳定 ID，标 legacy-unbound。迁移失败不得破坏原数据（测试固定）。
