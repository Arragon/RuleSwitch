# ADR-0004: Canonical Path Policy

- Status: Accepted
- Scope: v1 baseline

## Context

Windows drive/UNC、POSIX、case behavior、relative traversal、Unicode 和 symlink 使字符串 path 校验不可靠。Rulesync 还会跟随 source tree symlink；Renderer path 输入会扩大攻击面。

## Decision

Core DTO 只使用 `/` 分隔，logical path 不允许 `.`、`..`、绝对路径、drive prefix 或反斜杠；真实 path 留在 Main registry。Privileged operation 从 opaque capability ID 开始：resolve → canonicalize root/candidate（含 nearest existing ancestor）→ realpath → boundary-aware、OS-aware containment → operation，并在关键写入前后复验。字符串 prefix 不是 containment。

每个 workspace/profile/staging/snapshot root 分别授权。越界、dangling、无法检查、case collision 或 symlink ambiguity 均 fail closed。调用 Rulesync 前，应用递归枚举 source tree 并 realpath 每个 entry，拒绝越出批准 source root 的 symlink；生成后同样限制 staging output。

OS-specific path 行为只在 Platform/Filesystem adapters，业务层禁止 `process.platform`。

## Consequences

- Registry 必须维护 canonical metadata 与 capability lifecycle。
- 缺失目标、symlink swap 与大小写 collision 需要专门测试/复验。
- 合法但越界的 source symlink 也会被拒绝，这是应用安全边界强于 Rulesync 默认行为的有意选择。
- Path/security policy 的放宽或改变需 L4 ADR。
