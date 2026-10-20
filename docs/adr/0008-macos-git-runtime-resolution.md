# ADR-0008 · macOS Git Runtime 解析策略（Dugite 评估）

- 状态：Accepted（M1 / INH-1759）
- 日期：2026-10-07
- 关联：`apps/desktop/src/main/infrastructure/git/git-runtime.ts`

## Context

RuleSwitch 的核心 Git 流程不能强依赖"用户已装 Xcode Command Line Tools"。需要决定 Git 可执行文件的供给方式，并保证：版本可控、完整性可校验、spawn 环境固定（无交互提示）、超时与错误分类稳定、凭据永不进日志。

## Decision

**分层解析的 GitRuntime：显式覆盖 → env 覆盖 → 捆绑运行时槽位 → macOS 系统 Git；不在 M1 引入 Dugite 捆绑。**

解析顺序（`createGitRuntime`）：
1. `options.executable`（测试/诊断显式指定）；
2. `RULESWITCH_GIT_PATH` env（用户/CI 覆盖，非 Renderer 可达）；
3. `options.bundledRuntimeDir`（打包期内置 portable Git 槽位；启用时必须提供 `bundledExecutableSha256`，校验失败直接拒绝执行，不回退任意 shell）；
4. darwin 系统 `/usr/bin/git`（存在时），否则 PATH 上的 `git`。

每次创建记录 `git --version`；超时默认 30s（网络命令映射 remote-error，本地命令 local-error）；`GIT_TERMINAL_PROMPT=0` + `GIT_ASKPASS=/bin/true` + `LC_ALL=C`；stderr/argv 经 `redactGitText`/`safeCommandForLog` 去 userinfo 后才可进日志。

## Dugite 评估（为什么 M1 不采用）

| 维度 | 结论 |
|------|------|
| License | dugite-core 捆绑的 portable Git 为 GPLv2（带 linking exception 争议区），当前 runtime deps 全 MIT/ISC；引入需重做 THIRD_PARTY_NOTICES 与法律复核 |
| 维护 | dugite 活跃，但其发布节奏绑定 Git for Windows 构建链，macOS arm64 产物体积 ~100MB+ |
| 打包 | M8 才做 packaging/notarization；现在捆绑会提前放大 bundle 并影响 M8 体积预算与签名流程 |
| 行为等价 | 系统 Apple Git 2.54 与 plumbing 命令（porcelain v2/-z、ls-files -s、hash-object）行为一致；GitPort 只用稳定 plumbing，不依赖发行版差异 |
| 需求紧迫度 | v1.0 目标用户（AI coding 工具用户）几乎都已有 CLT/git；"无 CLT 用户"由打包期的槽位方案覆盖 |

**触发重新评估的条件**：M8 packaging 阶段实测（a）目标用户缺 CLT 比例高，或（b）系统 Git 版本碎片导致 plumbing 行为差异。届时在打包 ADR 中决定是否启用捆绑槽位（可用 dugite 产物或自建构建，均需 license 复核与 sha256 清单）。

## Consequences

- M1 交付的 GitRuntime 已含捆绑槽位 + 完整性校验 + 版本记录，打包前后同一 smoke 路径（`git --version` + 一次 status）可复用（INH-1765 自动化矩阵即该 smoke 的扩展）。
- 不新增 runtime dependency；THIRD_PARTY_NOTICES 无需变更（本次为零依赖变化）。
- 失败永不回退到 arbitrary shell execution：解析失败/校验失败 = 结构化 local-error。
