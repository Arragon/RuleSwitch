# v1.0 契约 · GitPort、Publish Safety 与 Credential Boundary（含 IDE 式 Index 契约）

- 状态：**Frozen**（M0 / INH-1756，含 2026-10-07 原型补充）
- 代码（canonical）：`packages/core/src/v2/git-port.ts`
- 测试：`packages/core/src/v2/__tests__/git-port.classify.unit.test.ts`（publish/commit 分类纯函数 + 禁止操作清单断言）

## Port 方法

`open` / `clone` / `status` / `fetch` / `fastForwardOnly` / `stage` / `unstage` / `commitStaged` / `push` / `diff(head-to-index | index-to-worktree)` / `log(分页)` / `discardWorktreeChanges`。

## Publish Safety（冻结）

1. **FF-only**：port 完全没有 merge/rebase/stash/force-push/reset-hard 方法（`GIT_FORBIDDEN_OPERATIONS` 常量断言防漂移）；diverged → blocked。
2. **Scoped commit**：`commitStaged` 带 `allowedManagedPaths`；staged 中出现非受管路径 → `unmanaged-staged-content` 错误（`classifyCommitReadiness`）。Index 中 unmanaged 内容一律显式阻止，不被顺带提交。
3. **Push 前置**：`push(request.expectedHead)` 要求先 fetch 且远端仍在该 revision；远端已移动 → `remote-race`（remote-error 类），本地 commit 保留并进入 `PENDING_PUBLISH`。
4. **Revision 绑定**：所有写操作携带 `ExpectedRevisions{head, worktreeDigest}`，不匹配 → `stale-revision`。**stage 后的 late edit 留在工作树，不进 commit**。
5. **Structured states**：remote ∈ `up-to-date|behind-ff|ahead|diverged|remote-unreachable`；working tree ∈ `clean|dirty-managed|dirty-unmanaged|dirty-mixed`；`pendingPublish` 由应用层维护。destructive/ambiguous 默认 blocked（`classifyPublishDecision`）。
6. **Discard**：仅 `discardWorktreeChanges`（带 expected revisions + 必须的 backupSnapshotRef），有 Preview/backup/stale guard。Fetch/Pull/Push 是分开的能力，Push 只发布已提交版本。

## Credential Boundary（冻结）

- 凭据只经 SSH agent/ssh config、Git credential helper（osxkeychain 等）、或 OS secure store resolver（M5 INH-1798 的 macOS Keychain resolver）。
- 凭据 token/密码永不出现在 port 类型、请求参数、Git 仓库内容、日志或错误消息中；auth 失败统一为 `auth-error`（不含凭据细节）。
- Core 不感知 GitHub/GitLab/Gitee/Forgejo：只依赖本 port；bare remote fixture（M1 INH-1765）是验收实现之一。

## Index / diff / log（原型补充）

- stage/unstage 绑定 repo identity + expected revisions；
- 三版本差异 = `head-to-index` 与 `index-to-worktree` 两个显式版本（digest 级），长内容 diff 由 UI 层按需取内容；
- log 分页（cursor + pageSize），commit diff 按 revision 取；
- 每次操作结果都携带新的 `GitRepositoryStatus` 供 UI 刷新。
