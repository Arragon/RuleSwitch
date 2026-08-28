# Provider Architecture

## Implemented Boundary

`packages/rulesync-provider` 已实现 core `ConfigProvider` v1：`descriptor`、`detect`、`validate`、`stage`、`preview`。它依赖 `@ruleswitch/core` 和 Rulesync，不依赖 Electron/Renderer；absolute path、realpath、resource registration 和 staging root 由 Main 实现的 `RulesyncProviderInfrastructure` capability boundary 提供。Application 执行 Apply/Snapshot/History，provider 不直接写 workspace。

Desktop package 不再直接依赖 Rulesync，并在 electron-vite 构建中 externalize `@ruleswitch/rulesync-provider`。Provider 使用自己的 esbuild 0.27.7，将 `src/index.ts` re-export 的 adapter 内部模块 bundle 为单一 ESM `dist/index.js`；`--packages=external` 使 Rulesync 保持 provider 的 external dependency。这只是构建/包装边界，不改变 Renderer → IPC → application/core → adapters 的四层运行时方向。

Phase A descriptor 固定一个 target：provider `rulesync` 16.14.0、`providerTarget:"codexcli"`、`features:["rules"]`。Native/multi-provider 仍是后续目标，不能把当前单目标说成完整 v0.1。

## Actual Rulesync 16.14.0 API

Adapter 直接 import named export `generate`；不 spawn CLI、不解析 stdout。实际调用为：

```ts
generate({
  inputRoot: workspaceRoot,
  outputRoots: [stagingOutputRoot],
  targets: ["codexcli"],
  features: ["rules"],
  delete: false,
  silent: true
})
```

16.14.0 参数是单数 `inputRoot`（其中包含 `.rulesync`）和复数 `outputRoots`，不是 `inputRoots`。`createEmptyStagingRoot` 在 Electron userData 下创建独立 `staging/stage-*`；每次 stage 都是新目录。显式 `delete:false` 避免 Rulesync 清理 workspace；未知删除由 RuleSwitch transaction/ownership policy 管理。

## Detect and Validate

`detect` 在已授权 workspace root 下注册 `.rulesync` source root，递归同步 source resources，要求至少一个 Markdown。`validate` 要求 detection context、选中的 resource ID 属于该 context 且为 Markdown，并返回整个 source tree 的 SHA-256 aggregate；unsafe refresh 返回 validation issue。

Source resources 保持 provider-neutral logical path 与 opaque ID。绝对 path 不进入 core DTO 或 Renderer；`openExternal` capability 也只授予 source-origin resource。

## Source Symlink Safety

Rulesync 16.14.0 会跟随 source symlink，且自身不逐 entry 做 realpath boundary sandbox。因此 adapter 每次 detect/validate/stage 都经 infrastructure 递归枚举 source：

- source policy 为 `allow-contained`；每项 `lstat`/`realpath` 后必须仍在 canonical `.rulesync` root；
- canonical visited-directory set 防 cycle/重复；
- logical path 做 exact 与 case-fold collision 检查；
- 越界、dangling、权限失败或非普通 file/directory 失败关闭；
- 每个 resource refresh 再检查 canonical identity。

Stage 在 `generate` 前计算 source aggregate，生成后再次完整枚举/hash；变化则抛 `SOURCE_STALE` 并丢弃结果。Staging output 用 `symlinkPolicy:"reject"` 重新枚举，拒绝任何 symlink。Path-based operation 的 check/use TOCTOU/symlink-swap 仍是 P2 残余，现有复验不表示已解决；native platform variations 仍需扩充测试。

## Stage and Preview

Stage 获取 authorized workspace/staging roots，调用 Programmatic API，只发现 staging 真实输出。每个 generated path 注册 `origin:"generated"`、readonly resource；同 path 的现有 workspace file 注册为 `origin:"workspace"`。输出绑定：

- sourceState：generation 后 source resources；
- targetState：对应 current workspace resources；
- generatedState：staging resources。

三个 `RevisionAggregate` 都按 `resourceId` 排序，对 `[resourceId,digest,byteLength]` UTF-8 JSON tuple 数组做 SHA-256。

Preview 校验 staged output 的 workspace/profile/target context，按 path 排序并生成 create/modify/unchanged。当前 provider 不扫描 ownership 中“旧生成但本次缺失”的路径，所以不会产生 delete；transaction delete policy 虽已实现，不能据此宣称 provider 自动清理。Preview/cache 都保存在当前 provider 进程实例。

## Implemented Tests

真实 Rulesync integration 覆盖：精确 descriptor、detect/validate、在 staging 生成并 preview `AGENTS.md` modify、workspace 与 unknown file 在 preview 阶段不变、独立多次 staging、create、missing `.rulesync`、escaping source symlink rejection、forged source capability。Application integration 还覆盖 create/delete/反向 Restore ownership、commit metadata failure rollback、tampered snapshot traversal；E2E 继续验证 stage→Apply/Restore。Windows 当前总记录为 integration 13、E2E 1。

## Upgrade Rule

Rulesync 必须保持 exact version。升级前重新审阅 Programmatic API、output fixtures、source symlink behavior、license/audit，并执行 provider integration 与完整 Electron E2E。不能浮动升级后静默接受生成差异，也不能以 CLI fallback 绕过 adapter。

esbuild 0.27.7 是 provider dev/build tooling（MIT，2026-04-02 发布），不是 provider runtime API 或 shipped runtime dependency。它的 build script approval 只服务 provider/Vite build。
