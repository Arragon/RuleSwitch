# Security Architecture

## Implemented Trust Boundaries

Workspace/`.rulesync`、Markdown、symlink、外部编辑和 provider output 都不可信。Phase A 已实现 Renderer（低权限）→ Preload（窄 bridge）→ Main（授权与 orchestration）→ provider/filesystem/platform 的边界。

## Electron Window and Navigation

`apps/desktop/src/main/index.ts` 创建 BrowserWindow 时固定：

- `sandbox: true`；
- `contextIsolation: true`；
- `nodeIntegration: false`；
- 未关闭 `webSecurity`；
- `setWindowOpenHandler` 一律 deny；
- `will-navigate`、`will-redirect`、`will-attach-webview` 一律 prevent。

Playwright 在真实 Renderer 验证 `require`、`process`、`ipcRenderer` 均为 `undefined`，且 `window.ruleswitch` 只有 7 个方法。Preload 不暴露 Electron primitives。

Renderer CSP 当前为：default/script/connect 仅 self；style 为 self + inline（支持当前 bundling/style）；worker 为 self + blob（Monaco worker）；image 为 self + data；object/frame/base/form 禁止。不得静默放宽或引入远程 script。

## Typed IPC and Sender Authorization

Preload 将每个 request 经 strict core Zod schema 后 `ipcRenderer.invoke`，并验证 response。Main 先匹配创建窗口的 `event.sender.id`，再匹配 main frame 的稳定 `processId` 与 `routingId`，之后再次校验 request/response；错误映射为有限 `ApiErrorDto`。不依赖 frame object reference identity。

唯一方法是 `openWorkspace`、`readResource`、`openExternal`、`stageTarget`、`applyChangeSet`、`listHistory`、`restoreHistory`。禁止 generic filesystem、shell、URL/path launcher、arbitrary command 或 CLI spawn channel。`openWorkspace` 的 Renderer request 为空；测试用 `RULESWITCH_SMOKE_WORKSPACE` 仅在 Main 读取，不扩大 DTO。

## Resource Registry and Path Policy

`NodeFilesystemInfrastructure` 维护 root/resource registry。Opaque ID 使用随机 bytes，绑定 workspace、root、absolute/canonical path、origin、hash/length 和 read/open operation set。Application 同时校验 workspace/profile/target/provider/source/changeSet/history relationships。

每次 read/open 重新 realpath root/resource，比较注册时 canonical identity，并在读取前后复验 identity。Candidate 按 logical segments 解析，拒绝绝对/drive/traversal/backslash/NUL/空 segment；`path.relative` 做 boundary-aware containment；目录 entry 和枚举进行 case-insensitive ambiguity/collision 检查。字符串 prefix 不构成授权。

Source tree 在 Rulesync 调用前递归枚举并 realpath：仅允许仍在批准 `.rulesync` root 内的 symlink，越界/dangling/不可检查会失败，visited canonical directories 防 cycle。Generated staging 和 workspace target 使用 reject-symlink policy。Path-based write 在最终检查与使用之间仍存在 TOCTOU/symlink-swap 窗口，这是 P2 残余；当前复验不能被描述为已解决。各 native OS 行为也仍待测试。

## External Open

Renderer 只发送 `resourceId`。Application 在 capability lookup 前后都要求 `origin:"source"`，filesystem 再验证 `open-external` operation/session/canonical path，`ElectronPlatformService` 最后授权一次后才调用 `shell.openPath(absolutePath)`。Generated/workspace origin 不可 external-open。Windows E2E 已真实成功调用系统默认应用；这不是任意 path/command launcher。

## CSP and Markdown

`MarkdownPreview` 使用 react-markdown、remark-gfm、rehype-sanitize，不启用 raw HTML plugin；所有 `<a>` 被替换为 inert `span`，因此 Phase A preview 中连 HTTPS link 也不会变成 launch capability。单元测试覆盖 script/img/handler 与 javascript/data/file links 不进入 executable output。

## Mutation and Delete Authorization

Preview 只写 app-data staging。Apply 需要内存中 ready ChangeSet，并在 mutex 内重验 source、affected target 与 generated aggregates。Target parent 禁止 symlink；写使用 atomic+fsync，写后 hash/length verify。Snapshot payload manifest 只接受 `files/NNNNNN.bin`，解析后还做 snapshot-root containment，拒绝篡改 traversal。

Provider 当前只从 generated entries 产生 create/modify/unchanged，不产生 delete。Transaction 的 delete primitive 仍要求：ownership manifest 匹配 profile/provider/digest、ledger 已记录、当前 digest 未变。Rollback 删除 transaction 新建文件还要求 `existed:false`、mutation completed 与 expected digest。Internal snapshot manifest v2 保存 affected paths capture 时的匹配 ownership；Restore commit 按 source snapshot 替换 affected ownership，使 create/delete 可反向恢复且不会把原用户文件错误认领为 owned。Unknown file 默认 preserve；Windows integration/E2E 已验证不变。

## Recovery and Remaining Security Work

启动会扫描非 terminal transaction manifests，以 stable workspace root identity 将重新打开的 session 加入 mutation gate。完整 crash repair 仍是 P2：当前没有 repair/diagnostics UI，只有日志和阻止 Apply/Restore；不得把它描述为自动 crash repair。

仍待验证：rollback itself failure、每个 crash phase、manifest corruption/repair UX、path-based write TOCTOU、permissions/readonly、macOS/Linux native behavior、packaging/signing/CI。Monaco bundle size 是性能/分发风险，不是放宽 CSP 的理由。

## Supply-chain Boundary

直接 runtime dependencies 均为 MIT/ISC。esbuild 0.27.7（MIT）是 provider build tooling，不是 shipped runtime。带 registry override 的 production audit 无 known vulnerabilities。`pnpm allowBuilds` 只显式保留 `electron`、`esbuild`、`tldjs`，分别服务 Electron 安装、Vite/provider build、Rulesync transitive 安装；不得静默扩大。`chokidar` 尚未依赖。Packaging 仍未运行，未来必须显式审查和批准所需脚本或选择替代方案。
