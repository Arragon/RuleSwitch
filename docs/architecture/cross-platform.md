# Cross-platform Policy

## Verified vs Intended

当前原生证据仅来自 Windows：Node 22.18.0、Electron 43.4.1。Phase A 的 Playwright Electron E2E 在临时 `工作区 with spaces` workspace 上真实完成 Raw/Rendered、系统默认应用打开、Rulesync staging、Monaco Diff、Apply/Verify/History/Restore；integration 证明 BOM + CRLF raw bytes 精确恢复、unknown file 不变，并覆盖 reverse Restore ownership、commit metadata rollback、tampered snapshot traversal。本次记录为 unit 35、integration 13、E2E 1。

macOS 与 Linux 尚未测试。目标仍是 Windows 10/11 x64、macOS arm64/x64、Linux x64，但 abstraction、POSIX fixture 或 Windows build 都不能替代 native runner，不能据此宣称跨平台已验证。

## Platform Boundary

OS-specific behavior 集中在 `ElectronPlatformService`、`NodeFilesystemInfrastructure` 和 packaging。Application/core/UI 不应散布平台分支。当前唯一 `process.platform` 分支位于 filesystem adapter 的 canonical-key comparison，用于 Windows case folding。

Workspace picker 使用 Electron dialog；app data 使用 `app.getPath("userData")`；default open 使用 `shell.openPath`。业务层不硬编码 `%APPDATA%`、macOS/Linux app-data path，也不手写 `start`/`open`/`xdg-open`。

## Path and Case Semantics

Core logical path 固定为 `/` 分隔的相对路径。Main registry 保存真实 OS paths，并执行：

```text
opaque capability → workspace/root ownership
→ path.resolve/realpath root identity
→ segment-by-segment lstat/realpath
→ path.relative containment
→ case ambiguity/collision check
→ operation and post-read identity check
```

Source enumeration 允许仅指向 source root 内的 symlink，使用 canonical visited set 防 cycle；staging 和 target mutation 使用 `symlinkPolicy:"reject"`。目录 entry 采用显式 case-fold collision 检查，不能依赖宿主 filesystem 的偶然行为。Windows drive、UNC 与 POSIX fixture 仍需扩充，真实 behavior 必须上 native runners。

## Writes, Rename, and Encoding

`write-file-atomic` 7 在 target/storage path 上以 `{ fsync:true }` 使用；目标 parent 按 segment 创建并拒绝 symlink/non-directory。写后重新 read/hash/byteLength verify。Snapshot payload 保存 exact bytes 为 `.bin`，不经过文本 round-trip，因此 BOM、CRLF/LF、encoding、comments 和 unknown fields 不被恢复过程重写。

Windows 已验证 Phase A fixture 的 BOM+CRLF Restore。macOS/Linux 的 rename-over-existing、mode/permissions、locking、readonly、跨设备、long path 与 crash durability 未验证。Path-based write 的最终检查/使用 TOCTOU 仍是 P2 残余；无法确认安全时必须 fail closed，不能在 application service 加平台 rename hack。

## Watchers

Phase A **没有 watcher 或 external-change auto refresh**，也尚未依赖 `chokidar`。现有 Apply preflight 会重新 validate source、读取 affected targets、校验 generated staging，因此能阻止 preview 后的外部修改覆盖，但 UI 不会自动刷新；`chokidar` 只在 Phase B 需要时再审查引入。

后续 watcher 仍只能作为 invalidation signal：

```text
watch event → debounce/invalidate → stat/read/hash → state update
```

它不是锁或 source of truth；workspace mutex 只防应用内并发，preflight hash 才防外部 stale overwrite。

## Fixture and Native Test Strategy

现有 fixtures 覆盖真实 Rulesync source/output、create/modify、stale target、atomic-write rollback、create/delete/reverse Restore ownership、commit metadata failure rollback、forged/cross-workspace capability、tampered snapshot traversal、Windows 可用时的 escaping symlink、中文+空格路径、BOM+CRLF 与 unknown file preservation。

后续仍需：

- Windows drive/UNC、POSIX、long path、更多 Unicode/case collision；
- root 内/外、dangling/cyclic file/directory symlink；
- readonly/permission denied、missing/delete-recreate、partial write、rename-over-existing；
- watcher duplicate/missing/out-of-order/atomic-save；
- rollback itself failure、每个 crash phase 与完整 crash repair（P2）；
- path-based write TOCTOU（P2）；
- Windows/macOS/Linux native Electron, filesystem, packaging smoke。

`apps/desktop/electron-builder.yml` 仅预留 NSIS、DMG/ZIP、AppImage/deb；electron-builder dependency 未启用，packaging/signing/CI 没有执行或平台证据。

## M9/M10 准备（2026-10-21，无 native runner）

在拿到 Windows/Linux 真机之前，先把**与平台无关即可验证**的部分固化成测试，避免"我机器上能跑"被误当作 containment 规则：

- `apps/desktop/src/main/infrastructure/path-safety.ts` 是 Main 侧唯一的相对路径守卫（`capabilities-v2` 已改为复用它），拒绝：空路径、NUL、反斜杠、`/`/盘符开头、`..`/`.` 段、`//`、**Windows 保留设备名**（`NUL`、`CON`、`COM1-9`、`LPT1-9`，含带扩展名形式）、**尾随点/空格**（Windows 会静默改写）。
- `collidesCaseInsensitively()` 报告在 Windows 与默认 macOS 上会被合并的大小写冲突：发现冲突必须上报，不能替用户挑一个。
- 上述均已在 `path-safety.unit.test.ts`（10 例）用 Windows 形状输入验证；这些断言在任何平台上跑都是同一个结果。
- 仍未验证（必须 native runner）：rename-over-existing、文件权限/locking、长路径、UNC、跨设备、以及 Windows 上的真实 crash durability。进程级崩溃矩阵目前只在 macOS 跑过。
