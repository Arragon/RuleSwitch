# AI Coding Configuration Manager v0.1
## 跨平台开发架构与开发规划

> 目标平台：Windows / macOS / Linux  
> 核心引擎：Rulesync  
> 桌面技术栈：Electron + React + TypeScript  
> 开发策略：L4 Architecture Owner → L3 Feature Owner → L2 Bounded Executor → L4 Release Review

## 1. 产品定义

v0.1 是一个基于 Rulesync 的跨平台 AI Coding Configuration Manager，而不是单纯的 Rulesync GUI。

当前模型：

```text
Universal Profile
      ↓
.rulesync
      ↓
RulesyncProvider
      ↓
Cursor / Claude Code / Codex / Devin / ...
```

长期模型：

```text
Configuration Provider
├─ RulesyncProvider
├─ CursorProvider
├─ ClaudeProvider
├─ CodexProvider
└─ ...
```

v0.1 可以依赖 Rulesync 获得较高开发效率，但不能把未来 Native Profile 架构锁死。

核心用户闭环：

```text
打开项目
→ 发现 Rulesync 配置
→ 浏览配置文件
→ Source / Markdown Preview
→ 外部默认应用打开
→ 选择 Targets
→ 生成到 Staging
→ Generated Preview
→ Diff
→ 自动备份
→ Apply
→ Verify
→ History
→ Restore
```

## 2. 平台支持

“支持 Windows/macOS/Linux”不仅意味着 Electron 能启动，还包括 Runtime、Filesystem Behavior 和 Distribution。

v0.1 Tier-1：

```text
Windows 10/11 x64

macOS
├─ arm64
└─ x64

Linux x64
├─ AppImage
└─ deb
```

macOS 优先支持 universal distribution，如果当前 toolchain 与依赖允许。

Tier-2，不阻塞 v0.1：

```text
Windows ARM64
Linux ARM64
rpm
Flatpak
Snap
```

Linux 不承诺任意发行版、任意 libc、任意 Wayland/X11 与桌面环境组合。最终文档必须明确“已验证平台”和“理论兼容平台”的区别。

## 3. 技术栈

推荐：

```text
Desktop Runtime
Electron

Frontend
React
TypeScript

Build
electron-vite

Packaging
electron-builder

Workspace
pnpm

Config Engine
Rulesync Programmatic API

Validation
Zod

Source / Diff Viewer
Monaco Editor

Markdown
react-markdown
remark-gfm
rehype-sanitize

Watching
chokidar

Tests
Vitest
Playwright
```

v0.1 不引入 SQLite，使用 filesystem-first storage，以降低 native module 和跨平台打包复杂度。

## 4. 总体架构

```text
┌──────────────────────────────────────┐
│               Renderer               │
│                                      │
│ Workspace                            │
│ Profiles                             │
│ File Explorer                        │
│ Viewer / Editor                      │
│ Targets                              │
│ Changes                              │
│ History                              │
└──────────────────┬───────────────────┘
                   │
               Typed IPC
                   │
┌──────────────────▼───────────────────┐
│                Preload               │
│       Narrow Capability Bridge       │
└──────────────────┬───────────────────┘
                   │
┌──────────────────▼───────────────────┐
│              Electron Main           │
│                                      │
│ Application Services                 │
│ ├─ WorkspaceService                  │
│ ├─ ProfileService                    │
│ ├─ FileViewService                   │
│ ├─ PreviewService                    │
│ ├─ ApplyService                      │
│ ├─ SnapshotService                   │
│ └─ HistoryService                    │
│                                      │
│ Provider                             │
│ └─ RulesyncProvider                  │
│                                      │
│ Infrastructure                       │
│ ├─ FilesystemService                 │
│ ├─ PlatformService                   │
│ ├─ WatchService                      │
│ ├─ HashService                       │
│ └─ StagingService                    │
└──────────────────┬───────────────────┘
                   │
                   ▼
              Filesystem / OS
```

## 5. Repository 结构

```text
apps/
  desktop/
    src/
      main/
      preload/
      renderer/

packages/
  core/
  rulesync-provider/
  ui/

tests/
  fixtures/
  integration/
  e2e/

docs/
  architecture/
  adr/
```

避免过早拆成大量 package。

## 6. Dependency Direction

```text
Renderer
   ↓
IPC Contract
   ↓
Application/Core
   ↓
Provider Contract
   ↓
RulesyncProvider
```

禁止：

```text
Renderer → fs
Renderer → Electron shell
Renderer → Rulesync
core → Electron
core → React
core → Rulesync implementation
RulesyncProvider → Renderer
```

Renderer 必须保持 sandbox；`contextIsolation` 开启；`nodeIntegration` 关闭。

## 7. Core Domain

v0.1 至少定义：

```text
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
```

Profile 预留 Native Profile：

```ts
interface Profile {
  id: string
  name: string
  kind: "universal" | "native"
  provider: string
  sourceRoot: string
  targets: string[]
}
```

v0.1：

```text
kind = universal
provider = rulesync
```

未来可以：

```text
kind = native
provider = cursor
```

## 8. Provider Boundary

```ts
interface ConfigProvider {
  detect(...): Promise<DetectionResult>
  validate(...): Promise<ValidationResult>
  stage(...): Promise<StagedOutput>
  preview(...): Promise<ChangeSet>
}
```

v0.1 唯一实现：

```text
RulesyncProvider
```

Rulesync 必须使用 Programmatic API。正常实现不使用：

```text
spawn rulesync
→ parse stdout
```

Preview 阶段不允许直接写真实 workspace。

## 9. Preview-first 架构

Preview 是一级能力，而不是某个编辑页面的附属功能。

统一：

```ts
interface FileResource {
  id: string
  path: string

  origin:
    | "source"
    | "generated"
    | "workspace"
    | "snapshot"

  format:
    | "markdown"
    | "json"
    | "jsonc"
    | "yaml"
    | "toml"
    | "text"
    | "unknown"

  readonly: boolean
}
```

同一 Viewer 复用在：

```text
.rulesync source
generated staging
current workspace
snapshot
```

Viewer 按上下文提供：

```text
Source
Preview
Current
Generated
Diff
```

### Source

使用 Monaco Editor。

默认 read-only；用户明确进入 Edit 状态后才允许修改。

支持 Markdown、JSON、JSONC、YAML、TOML 与普通文本语法高亮。

### Markdown Preview

使用：

```text
react-markdown
remark-gfm
rehype-sanitize
```

默认不开放 raw HTML 执行。

Markdown frontmatter 可拆分为 Metadata + Rendered Content。

### Generated Preview

Rulesync 输出首先进入 staging：

```text
.rulesync
   ↓
RulesyncProvider
   ↓
staging/<transaction-id>
   ↓
Generated Preview / Diff
```

用户在 Apply 前必须能直接查看最终生成的 `AGENTS.md`、`CLAUDE.md`、`.cursor/rules/*.mdc` 等目标文件。

### Diff

使用 Monaco Diff Editor，不重复实现 Diff UI。

### Open External

使用操作系统当前默认程序打开对应文件。

Renderer 只发送 `FileResource.id`；Main 根据 registry 解析路径并做 canonical path / allowed-root 校验。

禁止向 Renderer 暴露：

```ts
openPath(path: string)
```

这种 generic shell/file launcher。

## 10. Platform Boundary

所有 OS-specific 行为集中到：

```text
PlatformService
FilesystemService
Packaging
```

业务代码禁止散布：

```ts
if (process.platform === "win32") ...
```

示例：

```ts
interface PlatformService {
  openPath(resourceId: string): Promise<Result<void>>
  revealPath(resourceId: string): Promise<Result<void>>
  getAppDataRoot(): Promise<string>
}
```

应用数据目录由 Electron 平台 API 获取，不手写：

```text
%APPDATA%
~/Library/Application Support
~/.config
```

## 11. Path Policy

所有 privileged filesystem path 经过：

```text
Input
↓
Resolve
↓
Canonicalize
↓
Allowed-root validation
↓
Operation
```

需要考虑：

```text
Windows drive path
UNC
POSIX path
relative path
symlink
Unicode
spaces
case sensitivity
```

Raw path 可保留用于展示，但安全操作必须使用统一 PathPolicy。

symlink 指向 allowed root 外时拒绝 privileged operation。

## 12. File Watching

采用 chokidar，但 watcher 不是 source of truth。

正确模型：

```text
watch event
↓
invalidate
↓
stat/read
↓
hash
↓
state update
```

这样可以容忍不同 OS 和编辑器造成的 duplicate event、atomic save、temp-file replace 与事件顺序差异。

外部编辑器修改 source 后：

```text
Source changed
↓
Generated Preview = STALE
↓
debounce
↓
validate
↓
regenerate staging
↓
refresh Changes
```

如果 generation 失败：

```text
Generated Preview unavailable until fixed
```

真实 workspace 保持不变。

## 13. Preview Revision / Stale Protection

Preview 必须绑定输入状态：

```ts
interface PreviewRevision {
  sourceHash: string
  targetStateHash: string
  generatedHash: string
}
```

Apply 前重新验证：

```text
Preview revision
↓
Preflight recheck
↓
match?
├─ yes → Apply
└─ no  → STALE / Re-preview
```

旧 Preview 不得覆盖用户刚刚通过外部编辑器修改的新状态。

## 14. ChangeSet

```ts
type ChangeKind =
  | "create"
  | "modify"
  | "delete"
  | "unchanged"
```

`staging` 中不存在某个文件不代表可以删除真实 workspace 文件。

DELETE 需要通过 ownership policy。

## 15. Ownership

维护 generated ownership manifest：

```json
{
  "profile": "...",
  "provider": "rulesync",
  "generatedFiles": []
}
```

只有确认属于本应用管理范围的 generated files 才能自动清理。

未知文件默认：

```text
PRESERVE
```

## 16. Snapshot

Snapshot 保存 affected files 的原始 bytes，而不是 parsed representation。

```ts
interface SnapshotFile {
  relativePath: string
  existed: boolean
  hash?: string
  content?: Uint8Array
}
```

这样不会因为 parser 或格式化过程丢失：

```text
CRLF / LF
BOM
encoding
comments
unknown fields
```

## 17. Apply Transaction

状态机：

```text
PREPARING
→ STAGED
→ PREFLIGHT
→ BACKED_UP
→ APPLYING
→ VERIFYING
→ COMMITTED
```

失败：

```text
FAILED
→ ROLLING_BACK
→ ROLLED_BACK
```

严重恢复异常：

```text
RECOVERY_REQUIRED
```

Apply 必须：

```text
preview
→ preflight
→ snapshot
→ filesystem operation
→ reread
→ hash verify
→ history commit
```

禁止：

```text
点击 Save
→ Rulesync 直接覆盖 workspace
```

## 18. Restore

Restore 本身也是 transaction：

```text
Current
↓
Snapshot Current
↓
Restore Selected Snapshot
↓
Verify
↓
History
```

因此 Restore 本身也可以反向恢复。

## 19. Storage

```text
AppData/

profiles/
  <profile-id>/
    profile.json
    .rulesync/

snapshots/
  <workspace-id>/
    <snapshot-id>/

transactions/

history/

staging/
```

AppData 位置由 Electron API 决定。

## 20. Configuration UI

v0.1 优先做“文件工作台”，而不是为每种 Rulesync feature 造复杂表单。

推荐双栏：

```text
┌──────────────┬──────────────────────────────┐
│ Files        │                              │
│              │                              │
│ Rules        │       Viewer / Editor        │
│ ├ base.md    │                              │
│ ├ tests.md   │   Source | Preview | Diff   │
│              │                              │
│ Skills       │                              │
│ └ review     │                              │
│   └ SKILL.md │                              │
│              │                              │
│ MCP          │                              │
│ └ mcp.json   │                              │
└──────────────┴──────────────────────────────┘
```

## 21. Changes UI

按 Target 分组：

```text
Cursor
  ~ .cursor/rules/project.mdc

Claude Code
  ~ CLAUDE.md

Codex
  + AGENTS.md
```

点击文件可以切换：

```text
Current
Generated
Diff
Rendered
```

## 22. OSS-first 工程原则

采用顺序：

```text
1. Platform / Standard API
2. Existing dependency capability
3. Mature permissive OSS
4. Small local implementation
5. New subsystem
```

目标是积极复用成熟实现，但避免 dependency 堆积。

当前建议直接采用：

```text
Rulesync
Monaco Editor
react-markdown
remark-gfm
rehype-sanitize
chokidar
electron-vite
electron-builder
```

建议评估：

```text
write-file-atomic
```

重点参考但不一定依赖：

```text
chezmoi
ccsettings
```

特别值得借鉴 chezmoi 的：

```text
source state
target state
diff
dry-run
apply
external modification protection
```

以及 ccsettings 在配置领域的：

```text
dry-run
backup
apply
merge
validation
```

## 23. License Policy

默认优先接受：

```text
MIT
BSD-2-Clause
BSD-3-Clause
ISC
Apache-2.0
```

GPL / AGPL 默认不作为 v0.1 runtime dependency。

LGPL / MPL 需要先分析具体链接、修改和分发边界。

SSPL / BUSL / Commons Clause / 非标准商业限制默认不直接集成。

维护：

```text
THIRD_PARTY_NOTICES.md
```

新增 runtime dependency 至少检查：

```text
license
activity
maintenance
security
bundle impact
transitive dependencies
cross-platform support
whether platform API already solves it
```

## 24. Packaging

推荐：

```text
electron-vite
↓
built application
↓
electron-builder
```

Windows：

```text
NSIS
Portable optional
```

macOS：

```text
DMG
ZIP
Universal where practical
```

Linux：

```text
AppImage
deb
```

v0.1 不为了“Linux 支持”同时维护十几种包格式。

## 25. Code Signing

开发构建可以 unsigned。

Release：

```text
Windows
Authenticode signing

macOS
Developer ID + notarization
```

签名 credentials 只能放 CI secrets，不进入 repository、profile 或配置文件。

## 26. CI

必须使用原生 platform matrix：

```text
Windows
macOS
Linux
```

每个平台至少执行：

```text
pnpm install --frozen-lockfile
typecheck
lint
unit tests
integration tests
build
package
smoke test
```

能够运行 GUI E2E 的平台增加 Playwright / Electron smoke。

不能：

```text
Linux build success
→ claim cross-platform support
```

## 27. Cross-platform Fixtures

长期保留：

```text
ASCII path
Path With Spaces
中文路径
Unicode characters
nested path
long-ish path
Windows path fixture
UNC-style fixture
POSIX path fixture
CRLF
LF
UTF-8 BOM
symlink
readonly file
missing directory
deleted/recreated directory
```

## 28. 开发阶段与模型层级

不要根据代码量分模型，而根据错误成本。

### Phase A — L4：Architecture + Walking Skeleton

目标不是创建空目录，而是完成一条真实的端到端路径：

```text
Open Workspace
→ Detect .rulesync
→ Raw Preview
→ Markdown Preview
→ Open External
→ Generate one target to staging
→ Generated Preview
→ Diff
→ Backup
→ Apply
→ Verify
→ Restore
```

同时冻结核心 domain、Provider、IPC、Transaction、Path/Security contracts。

推荐：
- GPT-5.6 Sol Max
- 备选同级高端 coding/agent 模型

### Phase B — L3：Workspace / Profile / Preview

完成真正可用的：
- Workspace
- Recent Workspace
- Universal Profile
- File Browser
- Source Viewer
- Markdown Preview
- External Open
- External Change Detection

推荐：
- GPT-5.6 Sol High
- Claude Sonnet 级
- Terra High/Max 作为成本平衡替代

### Phase C — L3：Rulesync Generation / Generated Preview / Diff

完成：
- RulesyncProvider
- target selection
- staging
- generated discovery
- ChangeSet
- Generated Preview
- Diff
- stale preview protection

### Phase D — L3：Apply / Snapshot / Restore / History

这是最关键的 L3 阶段，不建议降到 L2。

完成：
- Apply transaction
- preflight
- backup
- verify
- rollback
- crash/interruption recovery
- History
- Restore transaction

### Phase E — L2：UI 与边界状态

只在 contract 冻结后进入。

适合：
- UI polish
- icons
- typography
- loading/error/empty state
- keyboard navigation
- accessibility
- component tests
- fixtures
- bounded validation
- deterministic refactors

不得修改：
- ConfigProvider
- domain model
- IPC architecture
- storage schema
- transaction semantics
- security boundary

### Phase F — L3：Cross-platform Hardening / Packaging / CI

验证 Windows/macOS/Linux 的：
- path
- filesystem
- watcher
- external open
- staging
- apply
- restore
- packaging
- CI

### Phase G — L4：Release Gate

重点审：
- data loss
- unknown deletion
- stale overwrite
- partial apply
- rollback failure
- restore reversibility
- symlink/path traversal
- Renderer capability leakage
- Markdown security
- Rulesync coupling
- future Native Provider readiness
- platform branch leakage
- watcher misuse
- dependency licenses
- packaging/CI false-green

L4 只修 P0/P1，不做低价值风格重构。

## 29. Escalation Rule

L2 遇到以下情况必须升级：

```text
需要修改公共 interface
需要新增跨 package dependency
schema 无法表达需求
需要绕过 architecture
需要直接访问 filesystem
涉及配置覆盖/删除
需要修改 transaction
需要修改 snapshot format
```

L3 遇到以下情况升级 L4：

```text
Provider contract 不够用
Native Provider future compatibility 冲突
transaction semantics 改变
security model 改变
核心 dependency direction 改变
```

## 30. v0.1 Definition of Done

用户能够：

```text
打开项目
↓
看到 Rulesync 配置
↓
浏览文件
↓
Source Preview
↓
Markdown Preview
↓
系统默认应用打开
↓
外部修改自动刷新
↓
选择 Targets
↓
生成 staging
↓
Generated Preview
↓
Diff
↓
Apply
↓
History
↓
Restore
```

数据安全要求：

```text
未知文件不静默删除
旧 Preview 不覆盖新修改
Apply 失败可恢复
Rollback 失败不会伪装成功
Snapshot 保存原始数据
Rulesync failure 不写 workspace
Renderer 无任意 filesystem 权限
```

架构要求：

```text
未来新增 Cursor / Claude / Codex Native Provider
无需重写 Viewer、Diff、Snapshot、History、Transaction 与 Workspace UI
```

平台要求：

```text
Windows ✅
macOS ✅
Linux ✅
```

这里的 ✅ 必须由 native CI / 实机验证支撑，而不是仅指“理论兼容”。
