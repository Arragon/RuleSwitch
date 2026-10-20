# v1.0 契约 · Repository / Asset / Scope / Project Stable Identity

- 状态：**Frozen**（M0 / INH-1753，含 2026-10-07 原型补充：存储关系见 ADR-0007）
- 代码（canonical）：`packages/core/src/v2/identity.ts`
- 测试（golden vectors）：`packages/core/src/v2/__tests__/identity.golden.unit.test.ts`

## 冻结规则

1. **RepositoryIdentity**：`repo_<64hex>` = SHA-256(`ruleswitch:stable-identity:v1\0repository\0<canonicalRemote>`)（完整 SHA-256 摘要，与冻结 golden vectors 一致）。canonical remote 归一化为协议无关形式 `git://<host>[:port]/<path>`：host 小写、userinfo 丢弃、默认端口（443/22/9418）丢弃、`.git` 后缀与尾斜杠去除、path NFC 且保留大小写。SSH/HTTPS/token-URL 同库同 ID。
   - `file://` 与 local-only（无 origin）：本机稳定、跨设备无保证，`portability:"local-only"` 必须在 UI/store 标记。
2. **DeviceId**：`dev_<64hex>`，平台层生成一次、本地保存，永不进 Git。
3. **ProjectDefinition**：`projectId`（`prj_[a-z0-9][a-z0-9-]{2,62}`，不可变；rename 只改 displayName）+ `remoteMatch` glob（对项目工作仓库 origin 的 canonical remote 匹配；`*` 含 `/`；path 大小写敏感）。本地绝对路径只存在于本地 binding store。
4. **ScopeRef**：`global | project:<projectId>`。
5. **AssetKey** = scope + kind + logicalName。kind ∈ 9 值枚举；logicalName 为 NFC、正斜杠、相对、大小写敏感。ID = `asset_<64hex>`。rename = 旧 key delete + 新 key create（无 rename 操作）；delete 移除 key 与 provenance，运行时目标文件交给 ownership 规则。
6. **HarnessInstanceId** = `harn_<64hex>` = SHA-256(adapterId | scope | bindingKey)。同一 adapter 同 scope 多实例用 bindingKey 区分（默认 `default`）。
7. **ConfigSourceRef**：`repo-head`（HEAD revision）/ `repo-working-draft` / `harness-actual` 三种来源身份不可互替。
8. local path 永不参与以上任何跨设备 identity。

## 边界行为（已由测试固定）

- Unicode：NFC 组合序列归一后同 identity。
- 大小写：host 不敏感（归一）、path/logicalName 敏感（`Acme/Config ≠ acme/config`）。
- 同仓库多 remote：identity 锚定 origin（binding 时记录其余 remote 仅作展示）。
- 项目移动/换目录 clone：identity 不变（不依赖本地路径）。
- 非法输入（空、`..`、反斜杠、绝对路径、未知 scheme、坏端口、IPv6 未闭合）显式 throw，无静默修正。
- Golden vectors：测试内含独立 SHA-256 实现交叉验证冻结常量，防止实现漂移。

## 迁移

Phase A session-random workspaceId 无法重绑为稳定 ID（无 origin 信息）：旧 history 只读保留为 legacy-unbound（`v2/stores.ts` `read-only-legacy`），新写入走稳定 ID（M1 INH-1764）。
