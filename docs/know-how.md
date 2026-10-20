# RuleSwitch Know-How

这里只记录可长期复用的项目事实、边界和踩坑，不记录任务流水账。

## Runtime and Commands

- 根要求 Node `>=22.13.0`、pnpm `11.24.0`；Windows 验证环境为 Node 22.18.0、Electron 43.4.1；macOS 验证环境 Electron 43.4.1。
- 当前环境裸 `pnpm` 不在 PATH；从仓库根使用 `corepack pnpm ...`。E2E 前先 `corepack pnpm run build`。
- `RULESWITCH_SMOKE_WORKSPACE` 是 Main-only test override，不扩展 Renderer 的空 `openWorkspace` DTO。
- **测试解析 dist，不是 src**：`apps/**` 与 `packages/**` 的 unit/integration 通过 node_modules 解析 `@ruleswitch/core` 的 `dist`。因此 `test:unit`、`test:integration`、`packages/ui` 的 `build`/`typecheck` 都先构建 core；只改 core 源码后直接跑 vitest 会对着旧产物得到假结果。遇到“源码改了但测试行为没变”先检查 dist 时间戳。
- E2E 统一走 `tests/e2e/launcher.ts`，支持 `RULESWITCH_E2E_ELECTRON`（可执行路径）与 `RULESWITCH_E2E_ELECTRON_ARGS`（附加参数）两个环境变量，并总是剥离 `ELECTRON_RUN_AS_NODE`。
- 若父进程导出 `ELECTRON_RUN_AS_NODE=1`，`electron --version` 会返回 Node 版本、ESM main 在 `import ... from "electron"` 处报 “does not provide an export named 'BrowserWindow'”。验证 Electron 行为前先 `env -u ELECTRON_RUN_AS_NODE`。
- 受限 runner（容器/嵌套沙箱）里 Chromium 进程沙箱会失败（`sandbox initialization failed: Operation not permitted`，随后 GPU/network service crash）。这不等于应用缺陷；用 `RULESWITCH_E2E_ELECTRON_ARGS="--no-sandbox --disable-gpu"` 复现，正式 CI 不应带该参数。
- 某些沙箱会拦截 pnpm 的项目注册 symlink（`EEXIST ... pnpm/store/v11/projects/*`）。可用 `corepack pnpm --config.verify-deps-before-run=false run <script>` 绕过自动 install 校验；这是环境限制，不写进仓库配置。


## Current Phase A Facts

- Walking skeleton 已实现并在 Windows 真实 Electron/Playwright 上走通：Open、Raw/Rendered、default open、Rulesync staging、Monaco Diff、Apply/Verify/History/Restore。
- 当前验证记录：unit 35、integration 13、E2E 1；中文+空格 workspace 可用，BOM+CRLF 精确恢复，unknown file 不变；integration 还覆盖 create/delete/反向 Restore ownership、commit metadata failure rollback、tampered snapshot traversal。
- macOS/Linux 未测试；fixture/abstraction 不等于 native support。
- 当前仍仅有 `codexcli/rules` 单 target。v1-compatible Phase B UI 已按 Rules / Skills / Commands / MCP / Other 浏览全部 source，并可选择 ChangeSet 全部文件；统一只读 Viewer 支持 Markdown、JSON/JSONC、YAML、TOML、text 与 origin metadata。
- Markdown frontmatter 使用原始文本与正文分区展示；raw HTML 不解析，所有链接继续 inert，避免在没有 link capability 时从 Renderer 建立旁路。
- 无 watcher/auto refresh，`chokidar` 尚未依赖。显式 `readResource` 会重新 stat/read/hash，Apply preflight 能拒绝 stale source/target，但这不等于 watcher UX。

## Rulesync 16.14.0

- 使用 named-export `generate`，不 CLI spawn/stdout parsing。
- 参数是 `inputRoot` 与 `outputRoots`；output 必须是独立 app-data staging，显式 `delete:false`。
- Rulesync 会跟随 source symlink。调用前后都要由应用枚举/realpath source；只允许 canonical source root 内链接。Staging/target 拒绝 symlink。
- Source generation 前后 aggregate 不同即 stale；升级 Rulesync 必须重跑 pinned output fixtures 与 E2E。
- Desktop package 不直接依赖 Rulesync并 externalize provider。Provider 用自己的 esbuild 0.27.7 bundle adapter 内部模块为单一 ESM 入口，Rulesync 保持 external dependency；这是 build/packaging boundary，不改变运行时四层。

## Security and Data Safety

- BrowserWindow 固定 sandbox/contextIsolation/nodeIntegration off，deny window/navigation/redirect/webview；Renderer 只有 7-method contextBridge。
- Main IPC 同时匹配 sender ID 与 main frame `processId`/`routingId`，Preload/Main 双向 strict schema。绝不新增 generic fs/shell/command/path channel。
- Opaque ID 由 Main registry 绑定 workspace/root/canonical path/operation；每次操作重验 realpath、containment、case ambiguity。`openExternal` 只授权 source origin。
- Markdown raw HTML 不解析，GFM 后 sanitize，所有 link 渲染为 inert span。
- Apply preflight 重算 source/target/generated；watcher 不存在时仍能阻止 stale overwrite，但不会自动刷新 UI。
- Core `Snapshot` public contract 未变；internal snapshot manifest 为 version 2，除 raw `.bin` payload/hash外还保存 affected paths capture 时匹配的 ownership metadata。Payload 必须是 `files/NNNNNN.bin` 并再做 snapshot-root containment。
- write-file-atomic 使用 fsync，写后重读/hash。Unknown 默认 preserve；delete 需要 ownership + ledger + current digest。
- Restore 先 snapshot 当前状态，commit 时按 source snapshot 替换 affected ownership；可安全反向 create/delete，不会把原用户文件误认领为 owned。Commit metadata failure 会恢复旧 ownership/history 后 rollback。
- 完整 crash repair 是 P2；当前只有 non-terminal manifest scan、root identity gate 和日志，无 repair UI。Path-based write TOCTOU 同样仍是 P2，现有复验不等于解决。
- Workspace ID 是 session 随机值；跨重启 history rebind 尚未实现。

## Cross-platform Pitfalls

- OS 分支只应存在 Platform/Filesystem/Packaging boundary。当前 Windows case-fold 位于 filesystem adapter。
- Atomic rename、permissions、locking、case、symlink、watcher 与 packaging 必须在 native Windows/macOS/Linux 验证；crash-phase 与 rollback itself failure 也仍待 fault matrix。
- Monaco bundle 较大；优化应保持现有 worker/CSP 和 Editor/Diff 功能。

## Supply-chain and Licensing

- 直接 runtime dependencies 均为 MIT/ISC；完整列表见 `THIRD_PARTY_NOTICES.md`。
- `corepack pnpm licenses list --prod` 的 transitive 主体为 MIT/ISC/Apache/BSD；permissive 例外：Python-2.0 `argparse`、`Apache2` 标识的 `human-readable-ids`、public-domain `uri-templates`。
- 默认 npmmirror audit endpoint 在当前环境不存在；使用 `corepack pnpm audit --prod --registry=https://registry.npmjs.org`，当前结果无 known vulnerabilities。
- `pnpm allowBuilds` 只显式保留 `electron`、`esbuild`、`tldjs`：分别为 Electron 安装、Vite/provider build、Rulesync transitive 安装所必需。不要静默放宽。
- esbuild 0.27.7（MIT，2026-04-02 发布）是 build tooling，不是 shipped runtime。Packaging 尚未运行；后续阶段仍需显式审查批准所需脚本或选替代方案。
