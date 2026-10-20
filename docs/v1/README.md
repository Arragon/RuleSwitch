# v1.0 Rebaseline 契约索引（M0 冻结）

| 契约 | 文档 | 代码 | 测试 | Linear |
|------|------|------|------|--------|
| 稳定身份 | [contracts/identity.md](contracts/identity.md) | `packages/core/src/v2/identity.ts` | `__tests__/identity.golden.unit.test.ts` | INH-1753 |
| 同步/冲突/ApplyMode | [contracts/sync-reconcile.md](contracts/sync-reconcile.md) | `v2/reconcile.ts` | `__tests__/reconcile.truth-table.unit.test.ts` | INH-1754 |
| Harness Adapter v2 | [contracts/harness-adapter.md](contracts/harness-adapter.md) | `v2/harness-adapter.ts` | `__tests__/harness-adapter.conformance.unit.test.ts` | INH-1755 |
| GitPort / Publish Safety | [contracts/git-port.md](contracts/git-port.md) | `v2/git-port.ts` | `__tests__/git-port.classify.unit.test.ts` | INH-1756 |
| IPC v2 + Stores | [contracts/ipc-v2-and-stores.md](contracts/ipc-v2-and-stores.md) | `v2/ipc-v2.ts`、`v2/stores.ts` | `__tests__/stores.migration.unit.test.ts` | INH-1757 |
| 威胁模型 | [threat-model.md](threat-model.md) | —（映射到机制） | 见文内 evidence 列 | INH-1758 |
| 技术基线/迁移 | [../adr/0006-...md](../adr/0006-v1-technology-baseline-and-strangler-migration.md) | — | — | INH-1752 |
| 仓库存储关系 | [../adr/0007-...md](../adr/0007-config-repo-storage-relationship.md) | — | — | INH-1753 |
| Phase A 审计矩阵 | [../architecture/v1-reuse-gap-migration-matrix.md](../architecture/v1-reuse-gap-migration-matrix.md) | — | — | INH-1751 |

规则：修改任一契约 = 修改 frozen baseline，须先 ADR + Linear 升级，不得实现期静默变更。Phase A v1 契约（`packages/core/src/contracts.ts` 等）在兼容窗口内同样冻结。
