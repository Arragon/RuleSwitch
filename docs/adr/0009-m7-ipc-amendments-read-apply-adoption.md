# ADR-0009 · M7 IPC amendments: repository file read, apply target selection, adoption gate

- 状态：**Accepted（2026-10-20）**
- 范围：`packages/core/src/v2/ipc-v2-channels.ts`、`apps/desktop/src/main/ipc-v2.ts`、`apps/desktop/src/preload/index.ts`、`apps/desktop/src/main/application/capabilities-v2.ts`
- 关联：INH-1757（v2 IPC 契约）、INH-1852（多工具/逐目标模式）、INH-1853（仓库编辑）、INH-1814（Preview/结果面）、INH-1809（adoption）

## 背景

M7 实机核对（2026-10-20）发现三处实现与已冻结契约/验收不一致，必须在 UI 层补齐前先修正协议层，否则只能在 Renderer 里伪造结果：

1. **仓库编辑不可用**：`library.editFile` 存在，但 `LibraryEntryDto` 不携带内容，Renderer 无任何读取通道，编辑界面无法预填内容（只能空覆盖，违反安全不变量）。
2. **应用目标不可选择**：`apply.toHarnesses` 只接受 `assets` + 单一 `mode`，Main 内部把 `assetKind` 硬编码为 `"skills"`，并把 `firstAdoptionConfirmed` 硬编码为 `true`——即绕过 adoption，且非 skill 资产被当成 skill 计划。
3. **无逐目标结果**：响应只返回 `batchId`，UI 无法显示 per-target journal（INH-1814 要求）。

## 决定

### 1. 新增只读通道 `ruleswitch:v2:assets:read-file`

- 方法名 `library.readFile`，API `readRepoFile(logicalPath)`。
- 请求 `{ logicalPath }`（= `assetKey`，source-relative、opaque），响应 `{ logicalPath, contentBase64 } | null`。
- Main 每次调用都对当前仓库重跑 inventory 解析，未知路径返回 `null`；不引入通用 `readFile`/path 能力，不接受绝对路径。

### 2. `apply.toHarnesses` 增加两个**可选**字段（向后兼容）

```text
targets?: { harnessInstanceId, mode?, scope?: {kind:"global"} | {kind:"project", projectId} }[]
confirmAdoption?: boolean
```

- 省略 `targets` 时保持旧行为：所有**已安装且已登记**的 harness、global scope、请求级 mode。
- 提供 `targets` 时为穷尽选择：未登记的 harness 直接抛错（不自动配置）；已安装=false 或 project 未绑定 → 进入 journal 的 blocked 条目，不静默降级为 global。
- `mode` 由目标级 `mode` 覆盖请求级 `mode`。
- `confirmAdoption` 默认 `false`。目标已存在且无基线 → `needs-adoption`，未确认则不写。

### 3. 响应从 `{ batchId }` 扩展为 `ApplyOutcome`

`{ batchId, status, appliedCount, blockedCount, failedCount, entries[] }`，`entries` 携带 `harnessInstanceId / adapterId / displayName / scopeKind / projectId / assetKind / mode / action / state / detail`。仍不含任何绝对路径。

### 4. 资产种类与路径能力改由数据驱动

- 计划条目按 **(目标 × 资产种类)** 生成，`assetKind` 取自资产本身。
- harness 根目录与每类能力取自 `HARNESS_MATRIX` / `matrixKindsFor`，删除 `capabilities-v2` 内硬编码的 `.claude/.codex/.cursor/.config/opencode` 映射。

### 5. `add-only` 语义修正（`packages/core/src/v2/apply-plan.ts`）

`add-only` 与已存在目标组合时，`skip-add-only-exists` 必须先于 `needs-adoption` 判定。原顺序会对“绝不覆盖”的模式反而要求用户确认接管，属策略缺陷。

## 备选方案与否决理由

| 方案 | 否决理由 |
| --- | --- |
| 把内容塞进 `LibraryEntryDto` | 读模型携带全部资产字节，二进制/大文件代价高，且扩大每次浏览的传输面 |
| 让 Renderer 传内容 + 路径 | 违反 Renderer 无路径、无内容真源的安全边界 |
| 用 `targets` 为空数组表示“全部” | 与“零选择不执行”冲突，语义易被误读 |
| 保持 `confirmAdoption` 恒 true | 直接绕过首次接管确认，违反冻结安全不变量 |
| 在 UI 层做 adoption 判断 | 安全决策下沉到 Renderer，Main 无法自证 |

## 影响与兼容性

- 三个新增请求字段全为可选，旧调用方（preload、既有测试）行为不变。
- `IPC_V2_METHODS` 从 20 增至 21；`assertV2Surface` 全空对象期望值同步为 21。
- Phase A `ruleswitch:v1:*` 7 方法未改动；preload 现为三处暴露（`ruleswitch` / `ruleswitchV2` / `ruleswitchV1SmokeMode`），符合 `docs/v1/contracts/ipc-v2-and-stores.md` 第 2 条兼容窗口。
- 未新增 runtime 依赖。

## 验证

- `capabilities-v2.apply.unit.test.ts`：7 条（仓库字节写入、按种类生成两条目、未确认 adoption 不写、确认后写入、逐目标 add-only、未登记拒绝、未绑定项目 blocked、未安装 blocked）。
- `app-v2.e2e.spec.ts`：新增“应用内 dialog 取代原生 prompt”“未登记工具不会被自动配置”两条真实 Electron 用例。
- 全量：typecheck / lint / 259 unit / 69 integration / 8 E2E 均通过（macOS，Electron 43.4.1）。

## 残余

- `hasOwnership` 仍恒为 `false`（尚未接入 INH-1781 的 SyncBaseline store），因此任何已存在目标都会走 `needs-adoption`。这是**安全方向的保守偏差**，不是静默放行；接入基线后应改为按目标查询 ownership。
- project scope 的 capability 与路径已按矩阵实现，但 UI 尚未提供项目绑定（INH-1855），因此当前仅 global 可在界面选择。

---

## 补记（2026-10-20 第二轮）：preview、validate、project binding、recovery

M7 交互收口时又加入 4 个 purpose-built 通道与 1 个 store，仍全部向后兼容。

### 6. `ruleswitch:v2:operations:preview-apply`（`apply.preview`）

- 与 apply 共用同一 `planApply()` 计划函数，**不写任何字节**。
- 返回 `ApplyPreview { planRevision, entries[], applyCount, unchangedCount, blockedCount, needsAdoptionCount }`。
- `planRevision` 由「资产摘要 + mode + 目标解析结果 + adoption 同意」哈希而成。`apply.toHarnesses` 新增可选 `planRevision`；不匹配时抛 `plan is stale` 并拒绝执行。
- 意义：INH-1814 要求的 Preview → Confirm 闭环不再靠 UI 自觉，Main 侧强制。

### 7. `ruleswitch:v2:repository:validate`（`repository.validate`）

- 对当前仓库重跑 manifest/asset-graph 解析，返回 `{ok, schemaVersion, assetCount, projectCount, profileCount, diagnostics[]}`。
- 不写、不改 gate 状态；仅供 onboarding 的「校验仓库清单」步骤给出可解释诊断。

### 8. `ruleswitch:v2:projects:bind` / `projects:unbind`

- `bindProject({projectId, displayName, localPath, rebind?})`：目录存在性、同目录被他人占用、跨目录移动需 `rebind: true`。
- `remoteVerified` 为三态 `matched | mismatch | unknown`。**永不猜测**：v1 `remoteMatchPatternSchema` 只接受 `git://` / `file://`，https/ssh origin 一律 `unknown` 并附诊断。
- `ProjectDto` 新增 `remoteVerified`，仍不含任何绝对路径。

### 9. `ruleswitch:v2:history:recovery`（`recoveryStatus`）

- 列出非 `ALL_COMMITTED` 或含 `PREFLIGHT_FAILED`/`APPLY_FAILED`/`VERIFY_FAILED`/`ROLLBACK_FAILED` 的批次，附每目标状态与原因。
- `rollbackAvailable` 恒为 `false` 且带 `rollbackReason`：本版本**不持久化 apply 前的 snapshot payload**，因此不提供“一键回滚”按钮——这是已知缺口（见计划 R-08），不是 UI 遗漏。

### 10. SyncBaseline store（`sync-baselines`，INH-1781）

- `apps/desktop/src/main/infrastructure/git/baseline-store.ts`，versioned envelope，`sync-baselines` 为冻结 store 名。
- apply 通过 `digestsFor(repositoryId, harnessInstanceId)` 计算真实 `hasOwnership`；仅在 verify 成功后经 `baselineOutcome` 推进。
- 效果：重复应用为 `noop`（此前不可达）；用户在本机改动后再次应用被拒为 `UNMANAGED_TARGET_CHANGED`（而非静默覆盖）。

### 11. `apply-plan` 的 `noop` 判定修正

原实现把 `localDigest` 与 `planRevision`（计划级哈希）比较，二者永不相等，`noop` 不可达。现以新增的可选 `sourceDigest`（同编码的源侧聚合摘要）比较，语义为“本地字节已等于将要写入的字节”。

### 影响

- `IPC_V2_METHODS` 21 → 27（新增 `repository.clone`）；`assertV2Surface` 期望值同步。
- `repository.clone({remoteUrl, targetDirectory})`：目标目录必须不存在，克隆后校验 `ruleswitch.yaml` 是否存在（`manifestPresent`）；凭据完全交给系统 Git，应用不接触凭据。
- 仍无通用 fs/shell/path 能力；所有新通道使用 opaque ID 或逻辑名，绝对路径只在 Main 内部使用。
- 新增 store 文件 `v2/sync-baselines-v1.json`；删除后可从 Git 重新 bootstrap。

---

## 补记（2026-10-21）：批量快照/回滚、本机扫描、逐项同步

### 12. `ruleswitch:v2:operations:rollback`（`rollbackBatch`）

- `BatchSnapshotStore` 在 apply 每个目标成功后立即落盘该目标 apply 前的字节（`v2/batch-snapshots/<batchId>/`），因此进程中途退出仍可恢复已提交的目标。
- 回滚语义：**逐字节恢复**；apply 前不存在的文件则删除。若某文件在 apply 之后又被改动（当前摘要 ≠ 记录的 appliedDigest），该文件被记为失败而**不覆盖用户新内容**，批次转 `RECOVERY_REQUIRED`。
- kind 边界：快照 blob 只接受 `files/<n>.bin`，加载时复验；manifest 中的相对路径再过 `isSafeRelativePath`，拒绝 `..`、绝对路径、盘符、反斜杠。
- `rollbackAvailable` 由「磁盘上是否真有快照 + 批次状态」推导，不再是常量 false。

### 13. `ruleswitch:v2:harnesses:scan`（`scanHarness`）

- 有界遍历：最多 2000 文件、深度 6；**跳过符号链接**（不跟随）。
- 只返回相对路径；`managed` 仅在 `SyncBaseline` 能证明 RuleSwitch 写过该路径时为 true。
- 分类基于跨适配器成立的布局约定（`skills/`、`prompts/`、`rules/`、根级 `AGENTS.md` 等），不认识的一律 `kind: null`，不猜。

### 14. `HarnessChangeDto` 增加双边路径

- 新增 `sourceAssetKey` / `targetAssetKey`（repo-relative，可为 null 或“目标尚不存在的目标位置”）。
- 目的：逐项处理由 Renderer 复用 `readRepoFile` + `editRepoFile` 完成，**不新增写通道**，也不让 Renderer 组装路径。
- 同时修正 `setCompare` 的摘要口径：源侧原本走 `Buffer.toString("binary")` 再哈希，目标侧用 `contentDigest`，两侧永不可能相等；现统一为 `contentDigest`。

### 15. `editRepoFile` 创建父目录

- 提升 source-only 资产需要在 `global/native/<adapter>/...` 下新建文件；在 `safeRepoPath` 已经完成 containment 校验后 `mkdir -p`。

### 影响

- `IPC_V2_METHODS` 增至 **29**；`assertV2Surface` 期望值同步。
- 仍无通用 fs/shell/path 能力。
