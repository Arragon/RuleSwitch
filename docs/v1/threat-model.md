# Threat Model v1 · macOS-first 双向同步、Project Scope 与可执行配置

- 状态：**Frozen**（M0 / INH-1758）
- 范围：v1.0 引入双向 Capture/Publish、Project Scope、多 Harness、Git 同步后的威胁重建模。Phase A 单向 Apply 时代的已验证控制继续有效（见 `docs/architecture/security.md` 与 reuse-gap 矩阵第 2 节不变量）。

## 1. Trust boundaries 与数据流

```text
[Remote Git host]          ← 不信任：repo 内容可能恶意
  ↕ (GitPort: fetch/FF/push；credential 只出 OS 安全层)
[Local config repo clone]  ← 半信任：内容受控解析；路径策略约束
  ↕ (Asset/Binding/Reconcile 引擎；schema 强校验)
[Local binding/baseline/provenance stores]  ← 信任（本机 app-data，envelope+gate）
  ↕ (Adapter v2 scan/render；staging 隔离)
[Harness 本地配置文件]      ← 不信任读取：用户/工具可能任意修改；写入必须事务
  ↕ (Rulesync converter 只在 staging)
[Electron Renderer]         ← 不信任：仅 v1/v2 目的型 IPC + opaque ID
```

关键不变量：恶意 repo 内容在成为预览/应用计划前，每一步都过 schema、路径策略与 ownership 规则；Renderer 永远拿不到 path/shell。

## 2. Abuse cases、阻断策略与测试向量

| # | 威胁 | 阻断策略（契约/机制） | 测试向量 / evidence | Owner |
|---|------|----------------------|--------------------|-------|
| A1 | 恶意 config repo：路径穿越/绝对路径/盘符写入 | logical path 中立 schema；canonical/realpath containment；v2 asset logicalName 同规则 | `schemas.unit.test.ts`（Windows/POSIX 绝对路径拒绝）、`identity.golden.unit.test.ts`（拒绝 `..`/反斜杠/绝对）；M2 loader 回归 | Core（复用 Phase A 文件系统策略） |
| A2 | Symlink escape（Rulesync source 跟随链接） | 调用前后枚举+realpath；仅 source-root 内 symlink；staging/target 拒绝 symlink | `rulesync-provider.integration.test.ts`："rejects a source symlink that escapes the canonical .rulesync root" | Provider（已验证，M6 复核） |
| A3 | Project rebind 欺骗（伪造 remoteMatch 认领他人项目） | projectId 不可变 + remoteMatch 只做"建议"，接管仍需 ownership confirmation（UNMANAGED 状态） | `reconcile.truth-table.unit.test.ts`（UNMANAGED→confirm-ownership）；M2 INH-1769 回归 | Core |
| A4 | Structured merge 覆盖 unmanaged 字段 | Provenance managedRegion + `STRUCTURED_MERGE_PRESERVES_UNKNOWN`；字段级 ownership ledger | M4 INH-1786（测试为该票验收） | Core |
| A5 | Generated reverse mapping 错归属 | `attributeGeneratedChange`：unique/ambiguous/unattributable；后两者必须人工归属 | `reconcile.truth-table.unit.test.ts`（ambiguity 拒绝） | Core（已落） |
| A6 | Secret 泄漏（进 repo/log/preview/history/diagnostic） | secret 只存 reference；resolver 只在 Main（env/Keychain）；全链路 redaction | M5 INH-1798（验收含 redaction 测试）；本模型现在起禁止任何实现把 secret 写入上述面 | Core+OS |
| A7 | Hook 预览执行（可执行配置在 preview 阶段被触发） | **Preview 永不执行 Hook**；新增/修改 executable hook 提高风险提示 + 显式确认 | M5 INH-1794（事件映射与确认流）；E2E 不允许 preview 触发执行 | Core+UI |
| A8 | Git credential/log 泄漏 | credential 只经 SSH agent/helper/Keychain；port 类型无凭据字段；错误统一 auth-error | M1 INH-1763（诊断边界测试）；`git-port.ts` 契约（无凭据参数） | GitPort+OS |
| A9 | Remote race（push 时远端已移动） | fetch+revalidate expectedHead；不匹配 → remote-race + PENDING_PUBLISH，本地 commit 不丢 | `git-port.classify.unit.test.ts`（diverged/unreachable blocked）；M1 INH-1762 集成 | GitPort |
| A10 | TOCTOU（check/use 间隙篡改） | 每操作 fresh stat/read/hash + expected revisions + Phase A 复验；已知残余：path-based write check/use 竞态为 P2（M8 INH-1819/1820 复核） | Phase A stale preflight 集成测试；INH-1820 kill-point 矩阵 | Core+M8 |
| A11 | Snapshot traversal（篡改 manifest 读任意文件） | payload 仅 `files/NNNNNN.bin` + snapshot-root containment + 重读 hash | "rejects a traversal payload in a tampered snapshot manifest"（已验证） | Storage（已落，M8 复核） |
| A12 | Renderer capability escalation | 双 IPC 轨道都走 strict schema + sender/frame 匹配；无 generic 通道；watch 事件无 path | `electron-security.unit.test.ts`、`ipc.unit.test.ts`；v2 `ipcV2ChannelSchema` | IPC（已落） |
| A13 | 仓库编辑/删除越权（写非受管路径或绕过 Git） | 仅受管路径；编辑/删除/Capture/Apply 各自 plan 绑定 fresh revision+snapshot；无云端写旁路 | M4 INH-1848（scoped commit + unmanaged staged 阻断测试已落 `git-port.classify.unit.test.ts`） | GitPort+Core |
| A14 | 集合对比无基线误报差异 | `unknown-baseline` 明示；不猜测 | `reconcile.truth-table.unit.test.ts` | Core（已落） |
| A15 | 自定义工具冒充已支持 Harness 自动写入 | `REGISTRATION_GRANTS_WRITE=false` + `canAutoCaptureOrApply` 四重拒绝 | `harness-adapter.conformance.unit.test.ts` | Adapter（已落） |
| A16 | 本地 store 篡改/损坏后继续写入 | envelope gate；corrupt→quarantine+阻断；migration-failed 保真阻断 | `stores.migration.unit.test.ts` | Stores（已落） |

## 3. 风险分级

- **P0**（必须阻断，owner+测试已绑定）：A1、A2、A6、A7、A8、A9、A11、A12、A15。
- **P1**（高强度缓解 + 里程碑验收）：A3、A4、A5、A13、A14、A16。
- **P2**（已知残余，M8 处理）：A10 的 path-based write TOCTOU 与 rollback-itself failure（INH-1819/1820）。

## 4. 责任分层

- **Core**：schema/路径策略、B/L/D 语义、ownership/provenance、ApplyMode 限制、plan 绑定。
- **Adapter（v2）**：真实 harness 探测/渲染保真、capability matrix 如实申报；不承担 Git/历史/删除决策。
- **OS/platform**：Keychain/env resolver、文件系统原子性、权限、git 二进制与 credential helper。
- **Git backend（GitPort 实现）**：FF/push 安全、revision 绑定、remote race 检测；凭据永不越过 OS 安全层。

## 5. DoD 对照

- P0 全部有 owner issue 与测试向量（见上表；已落测试列名，未落项绑定到对应里程碑票）。
- Hook Preview 明确不执行（A7，契约级禁令已写入本模型与 INH-1794 验收）。
- unknown/unmanaged 默认 preserve（reuse-gap 矩阵不变量 3，Phase A evidence + v2 契约延续）。
