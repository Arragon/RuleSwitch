# ADR-0007 · 配置仓库与 Harness 配置集合的存储关系

- 状态：Accepted（M0 / INH-1753 的存储设计子决策）
- 日期：2026-10-07
- 关联：INH-1753、`packages/core/src/v2/identity.ts`

## Context

桌面原型示意了"一个大配置库 + 多个 Harness 配置集合"的界面关系，但未定义存储 schema。必须在实现 Library/集合对比（INH-1850/1851）前冻结：Harness 配置集合是普通目录、嵌套独立 Git 仓库，还是 submodule。

## Decision

**单一普通 Git 仓库（ordinary clone）。Harness 配置集合是仓库内普通目录，不是嵌套 `.git`、不是 submodule、不是 subtree。**

```text
<config-repo>/                 ← 唯一持久同步事实源（一个普通 Git clone）
  ruleswitch.yaml              ← v1 manifest
  global/<kind>/...            ← Global Scope 资产
  projects/<projectId>/...     ← Project Scope 资产（projectId 稳定，路径不进 Git）
  profiles/...                 ← Profile 定义
  native/<harness>/...         ← Native 变体
  .ruleswitch/                 ← 仓库内工具元数据（可选）
```

### 依据比较

| 方案 | identity | commit/remote | ownership | 共同基线 | 迁移成本 | 结论 |
|------|----------|---------------|-----------|----------|----------|------|
| 普通目录（**Chosen**） | repositoryId = 规范化 origin 的 SHA-256（已冻结 golden vectors）；集合 identity = repositoryId + scope + adapterId 组合键（`harn_*` / `asset_*`），无第二身份体系 | 单一 HEAD/upstream；FF-only/push 规则只此一处 | 单一 working tree/index，scoped commit 与 unmanaged 保护直接复用 | 集合比较的共同基线 = 同一仓库 revision，天然可信 | 无额外结构 | **Chosen** |
| 嵌套独立 Git 仓库 | 需要 repo-of-repos 注册表或自动发现 `.git`，身份与发现都引入第二事实源 | 每个子仓库独立 commit/push；用户必须理解 N 个 upstream 与逐个同步 | 子仓库间 unmanaged/staged 语义交叉，scoped commit 边界模糊 | 跨集合比较需先对齐 N 个 revision，"共同基线"不可信场景激增 | 高，且双向同步引擎复杂度 ×N | Rejected |
| Git submodule | 集合身份退化为 gitlink SHA；RuleSwitch 无法在仓库内直接版本化集合内容（改动必须先提交子仓库再更新指针） | 双层 commit 顺序强约束，与"Capture→工作树→提交"模型冲突 | 指针与内容分离，partial clone 状态更复杂 | 指针即基线，但内容基线仍需子仓库 | 高 | Rejected |

### 读写授权

- 所有写路径（仓库编辑/删除、Capture、集合同步）只写主仓库 working tree 的受管路径，然后统一经 stage→scoped commit→push。无云端写旁路。
- 集合目录之间不存在独立授权单元；授权粒度仍是"受管路径集合 + ownership proof"。

### 三种来源身份（与原型对齐）

同一文件内容因来源不同而是不同 `ConfigSourceRef`（`v2/identity.ts`）：

- `repo-head`：Library 保存版本 = HEAD revision 下的内容；
- `repo-working-draft`：仓库 working draft（未提交状态），UI 显式标记，不冒充 HEAD；
- `harness-actual`：本机工具/项目实际设置（`harn_*` 实例）。

集合比较仅当双方都能锚定可信共同基线（同一 revision 或可信 baseline 记录）时给出结论，否则明示 unknown-baseline（`v2/reconcile.ts`）。

## Consequences

- Library/Changes/Harness 配置同步 UI 全部以"一个 Git 工作区 + 仓库内目录对比"建模（INH-1846/1850/1856/1857 的输入契约）。
- 未来若确需隔离某集合（如超大的 native 目录），走新 ADR 显式引入，不允许实现期顺手创建 nested repo/submodule。
