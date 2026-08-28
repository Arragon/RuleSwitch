# ADR-0002: Capability-based Typed IPC

- Status: Accepted
- Scope: v1 baseline

## Context

Sandbox Renderer 需要读取/展示文件、打开默认应用并发起 stage/apply/restore，但暴露 path、filesystem、shell 或 command API 会把 Renderer compromise 扩大成主机权限。当前 core 已定义 strict IPC schemas。

## Decision

Preload 只暴露 7 个 narrow methods：`openWorkspace`、`readResource`、`openExternal`、`stageTarget`、`applyChangeSet`、`listHistory`、`restoreHistory`，使用 `ruleswitch:v1:*` channels 和 strict Zod request/response。拒绝 extra fields。

Main 维护 resource registry；Renderer 只持 opaque capability IDs 和 logical metadata。每次调用校验 session/ownership/operation，并重新做 canonical/realpath allowed-root 检查。`openWorkspace` 请求为空且由 Main 打开选择器；read/open 只接受 resource ID。禁止 generic fs/shell/command 与任意 path/URL launcher。

Renderer 固定 sandbox、`contextIsolation:true`、`nodeIntegration:false`，不获得 Electron/Node primitives。

## Consequences

- 文件选择和 resource lifecycle 必须由 Main 管理，不能由 Renderer 随意拼 path。
- 新功能若不能由现有 capability 表达，需要安全审查；不能临时加 generic escape hatch。
- IPC、resource authorization 或 security semantics 的改动需 L4 ADR；L2/L3 不得自行扩权。
