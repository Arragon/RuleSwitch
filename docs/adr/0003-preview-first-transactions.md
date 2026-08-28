# ADR-0003: Preview-first Transactions

- Status: Accepted
- Scope: v1 baseline

## Context

Provider 生成会影响用户配置；外部编辑、partial write、崩溃、错误 delete 或 rollback failure 都可能造成数据丢失。简单“generate directly into workspace”无法安全恢复。

## Decision

所有生成先进入 isolated staging，形成绑定 source/target/generated SHA-256 aggregates 的 ChangeSet。Apply 使用冻结状态机：`PREPARING → STAGED → PREFLIGHT → BACKED_UP → APPLYING → VERIFYING → COMMITTED`；失败经 `FAILED → ROLLING_BACK → ROLLED_BACK`，无法完整恢复则 `RECOVERY_REQUIRED`。

Preflight 重算 source/target，stale 即拒绝。首次 mutation 前 snapshot affected files 的 raw bytes/absence。写操作采用 filesystem adapter 的 atomic replace，随后重读/hash verify。未知文件默认 preserve，delete 需要 ownership。Restore 创建新 transaction，先 snapshot 当前状态。Workspace mutex 防内部并发，durable manifest 支持 crash diagnostics。

## Consequences

- Apply 较慢且需要额外 storage，但避免旧 preview 覆盖与不可逆 partial apply。
- Snapshot/staging/manifest 在安全完成前不能清理。
- Rulesync 使用 `delete:false`；应用掌握 deletion policy。
- Transaction、snapshot、revision、storage semantics 的改变必须升级 L4 并新增 ADR。
