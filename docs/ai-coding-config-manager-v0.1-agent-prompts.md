# AI Coding Configuration Manager v0.1
## Agent Prompt 指南

> 使用方式：从 Phase A 开始按顺序执行。  
> 不建议把阶段进一步拆成大量零碎 ticket。每个阶段由对应层级 Agent 自行完成内部任务拆分。  
> 如果前一阶段存在阻塞问题，先解决阻塞问题再继续下一阶段。

所有 Agent 开始工作前必须阅读：

```text
AGENTS.md
README.md
docs/architecture/**
docs/adr/**
package.json
pnpm-workspace.yaml
```

如果 Phase A 尚未创建这些内容，由 Phase A 负责。

任何 Agent 都不得因为“现有架构不方便”而静默绕过架构。需要改变公共 contract、数据模型、安全边界、transaction semantics 或 package dependency direction 时，必须升级到更高层级模型。

---

# Phase A — L4
## Architecture Owner + Walking Skeleton

推荐模型：

```text
首选：GPT-5.6 Sol Max
推荐运行环境：Devin

备选：
GPT-5.6 Sol xhigh
Claude Opus 级高端模型
```

直接发送：

```text
你现在是本项目的 Architecture Owner。

请完整阅读当前 repository，然后负责建立 AI Coding Configuration Manager v0.1 的架构基础，并实现第一条真实可运行的 walking skeleton。

产品定位：

这是一个 Windows、macOS、Linux 多平台桌面工具。v0.1 基于 Rulesync 管理统一的 AI Coding 配置，未来会扩展为 Cursor、Claude Code、Codex 等工具的独立 Native Profile 管理器。

v0.1 核心能力包括：

1. 打开 Workspace。
2. 发现并读取 .rulesync 配置。
3. 浏览配置文件。
4. 查看原始 Source。
5. Markdown 文件支持 Rendered Preview。
6. 使用操作系统默认应用打开配置文件。
7. Rulesync 生成结果必须先进入 staging。
8. 查看 generated file。
9. 查看 current ↔ generated Diff。
10. Apply 前自动备份。
11. 安全 Apply。
12. Apply 后验证。
13. History。
14. Restore。

本阶段不要试图完成所有 UI 或所有 Rulesync feature。

你必须实现一个最小但真实的端到端路径：

Open Workspace
→ Detect .rulesync
→ Select one source Markdown file
→ Raw Preview
→ Rendered Preview
→ Open External
→ Generate one Rulesync target into staging
→ Generated Preview
→ Diff
→ Backup
→ Apply
→ Verify
→ Restore

这条链必须真正运行，而不是 Mock、TODO 或空 interface。

架构必须满足以下约束：

- Electron Renderer 不得访问 Node.js、filesystem、shell 或 Rulesync。
- Renderer 保持 sandbox。
- contextIsolation 必须开启。
- nodeIntegration 必须关闭。
- privileged operation 只能通过 typed preload API → IPC → Main。
- IPC 不允许提供 generic filesystem API、generic shell API 或 arbitrary command execution。
- core/domain 不依赖 React、Electron 或 Rulesync implementation。
- Rulesync 必须位于 ConfigProvider adapter 边界后。
- v0.1 使用 RulesyncProvider，但架构未来允许 CursorProvider / ClaudeProvider / CodexProvider。
- Rulesync 生成必须优先进入 staging，不允许 Preview 阶段直接覆盖真实 workspace。
- Snapshot 保存原始 bytes。
- Apply 必须具备 stale-state detection、backup、write、verify 和 rollback。
- 未明确属于本应用管理范围的文件不得自动删除。
- 所有 OS-specific 行为必须集中在 Platform / Filesystem / Packaging boundary；禁止业务代码散布 process.platform 分支。
- 禁止硬编码 Windows 路径、macOS 路径或 Linux 路径。
- 使用 Node path / Electron app.getPath 等平台 abstraction。
- 对 workspace/profile root 进行 canonical path 验证，防止 symlink/path traversal 越界。
- Raw backup 不得擅自修改 line endings 或 encoding。
- 文件监听事件只能作为 cache invalidation signal，真实状态必须重新 stat/read/hash 确认。
- 所有 filesystem write 都必须考虑 Windows、macOS 和 Linux 行为差异。

技术方向：

Electron
React
TypeScript
Vite/electron-vite
pnpm workspace
Rulesync Programmatic API
Zod
Monaco Editor
react-markdown
remark-gfm
rehype-sanitize
chokidar
Vitest
Playwright

打包系统预留 electron-builder。

优先复用成熟、活跃、许可证宽松的开源方案。不要重复实现 Monaco 已提供的 editor/diff、Electron 已提供的默认应用打开能力、Rulesync 已提供的转换逻辑等。

新增第三方 runtime dependency 前检查：
license、维护状态、安全风险、transitive dependency、跨平台支持以及是否真的需要。

优先允许 MIT / BSD / ISC / Apache-2.0。

请同时创建：

docs/architecture/overview.md
docs/architecture/cross-platform.md
docs/architecture/security.md
docs/architecture/transactions.md
docs/architecture/providers.md
docs/adr/

以及适合后续 Agent 使用的 AGENTS.md。

Repository 建议保持简单：

apps/desktop
packages/core
packages/rulesync-provider
packages/ui
tests/

不要过度 package 化。

定义并冻结第一版：

Workspace
Profile
Target
FileResource
ChangeSet
Snapshot
ApplyTransaction
HistoryEntry
ConfigProvider
PlatformService

同时定义 typed IPC contract。

实现完成后必须：

- 运行 typecheck
- 运行 lint
- 运行 unit tests
- 运行 integration tests
- 在当前 OS 实际启动 Electron
- 实际走完 walking skeleton

如果当前环境只能运行一个 OS，不要声称另外两个 OS 已测试；跨平台行为必须通过 abstraction 和测试 fixture 保证，并留待后续 CI/native runner 验证。

完成后输出简短任务简报：
做了什么、核心架构、真实运行到哪一步、测试结果、仍存在的风险、哪些 contract 后续不得由 L3/L2 随意改变。

不要继续实现 Phase B 的完整产品功能。
```

---

# Phase B — L3
## Workspace / Profile / Preview

推荐模型：

```text
首选：GPT-5.6 Sol High
备选：Claude Sonnet 级
成本敏感：GPT-5.6 Terra High
```

直接发送：

```text
你负责实现 v0.1 的 Workspace / Profile / Preview vertical slice。

首先完整阅读 repository、AGENTS.md、docs/architecture 和 ADR。

Phase A 已确定的架构、domain contract、dependency direction、安全边界和 transaction semantics 均视为既定设计。

不要重新设计架构。

本阶段目标是把当前 walking skeleton 扩展成真正可用的配置浏览与预览工作区。

实现：

Workspace：
- Open Workspace
- Recent Workspaces
- .rulesync detection
- workspace unavailable / moved / permission denied 等错误状态

Profile：
- Universal Rulesync Profile
- create
- duplicate
- rename
- remove
- switch
- profile metadata

Configuration File Browser：
- Rules
- Skills
- Commands
- MCP
- 其他当前 Rulesync source file
- 文件树只负责组织与发现，不为每种配置重复开发 viewer

统一 File Viewer：
- Source
- Rendered Preview
- Open External
- readonly / editable state
- source / generated / workspace / snapshot origin

Source Viewer：
- Monaco
- Markdown / JSON / JSONC / YAML / TOML / text syntax highlighting
- read-only 默认
- 明确进入 Edit 后才允许修改

Markdown Preview：
- react-markdown
- remark-gfm
- rehype-sanitize
- 禁止不受信任 raw HTML 执行
- frontmatter 与 Markdown 正文可以分别展示
- 相对文件链接只能访问允许的 workspace/profile root
- http/https 链交由受限 external-open handler
- javascript/data/未知 protocol 拒绝

Open External：
- 必须使用 Electron 的系统默认打开能力
- Renderer 只能发送 FileResource ID
- Main 根据 registry 解析实际路径
- 禁止 Renderer 传 arbitrary path
- canonicalize 后验证 allowed root

External Modification：
- 使用 watcher 监听必要路径
- watcher event 只能触发 invalidate
- 重新 read/stat/hash 后再确认真实变化
- external edit 后 UI 自动刷新
- source 变化后 generated preview 标记 stale

跨平台要求：
- Windows/macOS/Linux 使用同一 domain behavior
- 所有路径操作必须使用 platform-safe API
- 文件名大小写行为不能依赖宿主 OS 的偶然特性
- 不修改原文件 newline/encoding，除非用户明确编辑产生改变
- symlink 指向 allowed root 外时拒绝 privileged operation
- 不使用 xdg-open、open、start 等手写平台命令；由 Electron abstraction 完成

UI 结构建议：

左侧 Configuration File Explorer
右侧统一 Viewer

Viewer tabs：
Source | Preview

工具栏：
Edit
Save
Open External
Reveal in Folder（如果现有安全 contract 允许）

不要在本阶段实现复杂的结构化 Rules/MCP GUI。

文件级管理 + 高质量 Viewer 优先。

补齐：
unit tests
integration tests
renderer component tests

尤其测试：
Markdown sanitize
path boundary
external-open authorization
external file modification
Windows-style path fixture
POSIX path fixture
case-sensitive/case-insensitive edge cases

如果必须修改 Phase A 公共 contract 才能完成任务，不要自行修改；记录原因并停止相关部分。

完成后给出任务简报和测试结果。
```

---

# Phase C — L3
## Rulesync Generation / Generated Preview / Changes / Diff

推荐模型：

```text
GPT-5.6 Sol High
或 Claude Sonnet 级
```

直接发送：

```text
实现 Rulesync generation、Generated Preview 和 Changes/Diff vertical slice。

阅读并严格遵守已有 architecture、ADR、AGENTS.md 与 Phase A/B contracts。

目标流程：

Profile source
→ validate
→ RulesyncProvider
→ staging
→ discover generated files
→ compare current workspace
→ ChangeSet
→ Generated Preview
→ Diff

Rulesync 必须通过 Programmatic API 使用，不得通过 shell CLI + stdout parsing 作为正常实现。

Rulesync implementation 必须封装在 RulesyncProvider 内。

支持：
- target selection
- feature selection（以当前 v0.1 已支持范围为准）
- staging generation
- generation errors
- generated file discovery
- current/generated comparison
- CREATE
- MODIFY
- UNCHANGED
- DELETE candidate

DELETE 必须非常保守。

只有 ownership manifest 或现有 architecture 明确确认属于应用管理范围的文件才能成为自动 DELETE。

未知文件默认保留。

Changes UI：

按 Target 分组。

点击任意文件可以切换：

Current
Generated
Diff
Rendered（适用 Markdown 时）

Source/Diff 使用 Monaco / Monaco DiffEditor，不重新实现 diff engine UI。

Generated Preview 必须可以在 Apply 前完整查看目标文件。

Source file 外部修改后：
- staging 标记 stale
- 旧 ChangeSet 不得继续 Apply
- debounce 后重新 validate/generate
- generation failure 时明确显示错误，并保持真实 workspace 不变

必须加入 stale preview/version token：

Preview 时记录输入 source hash + relevant target state hash。

Apply 之前如果实际状态与 Preview state 不一致，必须拒绝使用旧 ChangeSet，并要求重新 Preview。

跨平台测试至少覆盖：
- Windows path
- POSIX path
- CRLF/LF raw comparison
- Unicode file names
- spaces in paths
- workspace path containing non-ASCII characters

不要修改 Apply transaction architecture。

完成后执行完整 tests，并输出简短任务简报。
```

---

# Phase D — L3
## Safe Apply / Snapshot / Rollback / History

推荐模型：

```text
优先：GPT-5.6 Sol High
这是 L3 中最不适合降级的一阶段。
```

直接发送：

```text
实现 v0.1 的安全 Apply、Snapshot、Rollback 与 History vertical slice。

这是数据安全关键模块。

不要为了减少代码而降低 transaction safety。

读取并遵守 docs/architecture/transactions.md 和所有 ADR。

Apply 必须遵循：

PREPARING
→ STAGED
→ PREFLIGHT
→ BACKED_UP
→ APPLYING
→ VERIFYING
→ COMMITTED

失败：

FAILED
→ ROLLING_BACK
→ ROLLED_BACK

Apply 前再次验证：

- Preview token 未 stale
- source hash 未变化
- target affected files 未被外部修改
- allowed-root
- permissions
- ownership/delete policy
- staging 存在且完整

Snapshot 保存 affected files 的原始 bytes，以及：
path
exists-before
hash
timestamp
transaction id
profile id
target
engine/version metadata

不得只保存 parsed representation。

Apply write：

优先评估成熟宽松许可的 atomic-write OSS，例如 write-file-atomic，但必须确认所选版本与当前 Electron/Node runtime 兼容。

不得为了使用某个库强行升级 runtime。

如果最终自行实现 filesystem primitive，也只能集中在 FilesystemService 中，并为 Windows/macOS/Linux 行为编写测试。

不要在业务 service 手写 platform-specific rename hack。

Apply 后：
重新读取实际目标文件并 hash verify。

失败必须回滚。

如果 rollback 自身失败：
- 不得报告成功
- 保留 snapshot
- 明确列出未恢复文件
- History 标记 RECOVERY_REQUIRED

History：
记录 apply / restore transaction，而不是只写一条普通操作日志。

Restore 本身也必须是 transaction：
Restore 前先备份当前状态，因此 restore 仍可反向恢复。

不要自动删除未知文件。

不要把 watcher 当锁。
watcher 仅用于发现变化。

使用 transaction mutex 防止本应用内部并发 Apply，同时依赖 preflight hash 防止与外部编辑器发生 stale overwrite。

加入 crash/interruption recovery：
如果启动时发现未完成 transaction manifest，进入 recovery diagnostics，而不是假设 Apply 已成功。

测试至少覆盖：
- apply success
- write failure
- permission denied
- stale source
- stale target
- partial write
- verify mismatch
- rollback
- rollback failure simulation
- restore
- Windows path fixture
- POSIX path fixture

完成后不得继续做 UI 美化。

输出测试结果和残余风险。
```

---

# Phase E — L2
## UI 完成、边界状态和测试补齐

推荐模型：

```text
GPT-5.6 Luna High / Max
GPT-5.6 Terra Medium
或已经通过项目校准的低成本模型
```

直接发送：

```text
你负责 v0.1 的 bounded product-completion 工作。

严格遵守现有 architecture 与 public contract。

不得修改：
ConfigProvider
domain model
IPC architecture
storage schema
transaction state machine
snapshot semantics
path security model
dependency direction

如果任务需要修改以上内容，请停止该部分并报告。

在现有接口上完成：

- Configuration file tree UI
- file type / target icons
- Source / Preview / Current / Generated / Diff tab polish
- Markdown typography
- frontmatter metadata presentation
- loading states
- empty states
- permission/error states
- stale preview state
- generation failed state
- Apply progress state
- rollback/recovery warning UI
- History list
- Restore confirmation UI
- keyboard navigation
- accessibility labels
- focus behavior
- responsive desktop window layout
- Windows/macOS/Linux 下字体与 spacing 不依赖某个系统字体存在

不要建立独立的第二套 design system。

优先复用当前 UI primitives。

同时补齐大量确定性测试：

- component tests
- serialization fixtures
- validation tests
- file viewer tests
- Markdown renderer tests
- empty/error/loading state tests

不要为了让测试通过而 mock 掉核心 behavior。

遇到真实 architecture bug，报告给 L3/L4，而不是绕过去。

完成后运行现有 lint/typecheck/test suite，并输出任务简报。
```

---

# Phase F — L3
## Windows / macOS / Linux Hardening + Packaging + CI

推荐模型：

```text
GPT-5.6 Sol High
或 GPT-5.6 Terra Max
```

直接发送：

```text
负责 v0.1 的跨平台 hardening、packaging 与 release CI。

本阶段不是重新设计应用，而是验证现有 architecture 在 Windows、macOS、Linux 上成立。

目标 Tier-1：

Windows:
Windows 10/11 x64

macOS:
Apple Silicon arm64
Intel x64
优先生成 universal distribution（如果当前 toolchain 与依赖允许）

Linux:
x64 mainstream desktop distributions
首要发布格式 AppImage
同时提供 deb

rpm 可以在不会显著增加维护成本时加入，否则留到后续版本。

Windows ARM64 / Linux ARM64 暂作为 Tier-2，不得阻塞 v0.1。

Packaging 推荐：
electron-vite 负责 Main / Preload / Renderer build。
electron-builder 负责 distributable packaging。

不要同时叠加 Electron Forge + electron-builder，除非已有工程确有理由。

CI 必须使用 native platform matrix，而不是假设一个 OS 的成功构建代表全部平台。

至少：

windows runner
macos runner
linux runner

每个平台执行：

pnpm install --frozen-lockfile
typecheck
lint
unit tests
integration tests
build
packaging smoke test

能运行 GUI E2E 的平台增加 Playwright/Electron smoke。

必须实际验证：

- Open Workspace
- Raw Preview
- Markdown Preview
- Open External
- external modification refresh
- Rulesync staging generation
- Diff
- Apply
- Restore

跨平台审查：

Paths：
- 不允许 "/" 拼路径
- 不硬编码 drive letter
- UNC path 不得因为 parser 假设崩溃
- spaces / Unicode path
- canonical path security
- symlinks

Filesystem：
- permissions
- readonly
- atomic-write behavior
- temp file 必须与目标 filesystem 兼容
- newline 与 encoding preservation

Watcher：
- watcher event 视为 invalidation
- debounce
- duplicate event tolerance
- false event tolerance
- deleted/recreated directory handling
- network filesystem 不作为 v0.1 Tier-1，但不得导致数据损坏

External Open：
统一使用 Electron shell abstraction。

Application data：
统一通过 Electron app.getPath() 等平台 API 确定。

不要自己维护：
%APPDATA%
~/Library/Application Support
~/.config
等路径字符串。

Renderer security：
sandbox on
contextIsolation on
nodeIntegration off

IPC 重新检查，不得因跨平台适配增加 generic shell/filesystem escape hatch。

Packaging：

Windows:
NSIS installer
可选 portable build

macOS:
DMG
ZIP 可以作为 updater/release artifact
准备 code signing / notarization 配置，但 secrets 不进入 repo

Linux:
AppImage
deb

不要因为本地缺签名证书而禁用整个发布流程：
CI 将 unsigned development artifacts 与 signed release artifacts 分开。

生成 docs/release.md 与 docs/platform-support.md。

明确列出：
真正测试的平台/架构
理论兼容但未实际测试的平台
不支持范围

绝不能把未测试的平台写成“已验证”。

完成后提交完整 cross-platform test matrix 与 packaging 结果。
```

---

# Phase G — L4
## Release Architecture / Safety Review

推荐：

```text
GPT-5.6 Sol Max
最好使用与主体 L3 不同的独立上下文。

如果有可靠的另一家高端模型，也适合作为异构 reviewer。
```

直接发送：

```text
你现在只负责 v0.1 release gate。

不要为了个人风格重写正常工作的代码。

完整审查 repository、architecture、ADR、tests 和 packaging configuration。

重点验证：

1. 用户配置是否存在丢失路径。
2. 是否可能删除未知文件。
3. stale preview 是否可能覆盖外部编辑。
4. partial Apply 是否能恢复。
5. rollback failure 是否被正确暴露。
6. Restore 是否自身可回滚。
7. symlink/path traversal 是否可能逃出 workspace/profile root。
8. Renderer 是否能获得 arbitrary filesystem / shell capability。
9. external-open 是否可能成为 arbitrary command/path launcher。
10. Markdown preview 是否存在不受信任内容执行问题。
11. Rulesync 是否被隔离在 Provider boundary。
12. core 是否错误依赖 Electron/React/Rulesync implementation。
13. 新增 Native Provider 是否需要推翻 UI/domain。
14. Windows/macOS/Linux 是否存在业务层平台分支扩散。
15. path/case/newline/encoding 是否有跨平台隐式假设。
16. watcher 是否错误地被当作 source of truth。
17. Rulesync upgrade 是否可能静默改变行为。
18. dependency licenses 是否符合项目要求。
19. packaging 是否真实覆盖 Tier-1 平台。
20. CI 是否存在“只 build、不真正验证”的假绿灯。

运行完整测试。

发现 P0/P1 问题可以直接修复。

低价值 cosmetic refactor 不做。

最终输出：

Release verdict:
PASS / PASS WITH CONDITIONS / BLOCK

Blocking issues
Non-blocking issues
Architecture health
Cross-platform health
Data-safety health
Security health
Future Native Provider readiness

只有阻塞 v0.1 发布的问题才应标记为 Blocking。
```

---

# 模型升级规则

L2 如果发现以下情况，不继续自行决策，升级给 L3：

```text
需要修改公共 interface
需要新增跨 package dependency
现有 schema 无法表达需求
测试要求绕过 architecture
需要直接访问 filesystem
涉及配置覆盖/删除
需要修改 transaction
需要改变 snapshot format
```

L3 如果发现以下情况，升级给 L4：

```text
Provider contract 不够用
Native Provider future compatibility 冲突
transaction semantics 需要变化
security model 需要变化
dependency direction 需要变化
核心 storage / IPC contract 需要变化
```

---

# 推荐执行顺序

```text
Phase A — L4
↓
Phase B — L3
↓
Phase C — L3
↓
Phase D — L3
↓
Phase E — L2
↓
Phase F — L3
↓
Phase G — L4
```

如果 Phase B/C/D 内存在一些已经完全由 contract 限定的机械工作，可以让 L3 自行派给 L2 subagent，但不要由用户手工把大阶段继续切碎。

核心原则：

```text
L4 决定不可逆架构
L3 负责完整功能纵切
L2 负责冻结边界内的实现
L4 最后做架构与发布复核
```
