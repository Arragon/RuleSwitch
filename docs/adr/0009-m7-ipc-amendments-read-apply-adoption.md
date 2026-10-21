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

---

## 补记（2026-10-21）：行级 diff 与进程崩溃断点

### 16. `ruleswitch:v2:operations:diff-apply`（`diffApplyTarget`）

- 目的：让 Preview 能显示**真实的逐行差异**，而不是结构化目标列表。请求沿用 `apply.preview` 的入参并追加 `targetKey`（可选 `planRevision`）。
- 两侧文本都在 Main 解码：左＝目标当前字节，右＝将写入的仓库字节。Renderer 只拿到文本，**永远拿不到路径**。
- 非文本内容（含 NUL 或非法 UTF-8）用 `binary: true` 报告并且 `sourceText/targetText` 为 null，UI 明确不渲染行级 diff，而不是给出有损近似（写入仍按字节原样进行）。
- 与 apply 同一套 stale 保护：传入的 `planRevision` 与当前计划不符即拒绝。
- 该通道只读：不写目标、不改基线、不产生 journal。

### 17. batch apply 的持久阶段与崩溃恢复

- 阶段（按顺序，每个阶段之间 journal 均已落盘）：`journal-started` → `snapshot-recorded` → `write-started` → `write-finished` → `target-committed`。
- **快照前移**：pre-apply 字节在写入之前读取并落盘（原实现在写入并校验之后才存，崩溃窗口内无法回滚）。
- `reconcileInterruptedBatches()` 在启动时对仍为 `RUNNING` 的批次用磁盘上的真实字节判定：
  - 当前字节 == 将写入的字节 → `COMMITTED`（等价于通过写入后校验）；
  - 当前字节 == 写入前字节（或文件仍不存在且本来就不存在）→ `PENDING`（未写入），批次结算为 `FAILED`；
  - 两者都不是 → `APPLY_FAILED` + `RECOVERY_REQUIRED`，不做猜测，也不覆盖。
- `rollbackAvailable` 增加“可恢复性”判定：快照存在但任一文件当前字节不等于写入字节时，按钮不再谎称可回滚。
- 回滚对“崩溃发生在写入之前”的目标计为 restored（本就处于 apply 前状态），不再误报失败。

### 影响

- `IPC_V2_METHODS` 增至 **30**；`assertV2Surface` 期望值同步。
- 新增 `tests/crash/crash-drill.child.test.ts` + `vitest.crash-drill.config.ts`（不匹配任何默认 glob，只被崩溃矩阵显式拉起）。
- 崩溃矩阵进程级覆盖：子进程被 **SIGKILL** 真杀（非抛异常），父进程在磁盘上核对 journal / 快照 / 目标字节。

### 18. 多仓库：`currentRoot()` 必须跟随“最近打开”的仓库

- 原实现返回 `registry` 中**首个**注册仓库。打开第二个仓库后，所有 root-based 读（library 资产字节、`readRepoFile`、`setCompare`、inventory）仍读第一个仓库 —— 在跨仓库场景下会把 A 的字节当成 B 的字节写入本机工具。
- 现由 `GitPortAdapter` 记录 `activeRepositoryId`（`open` / `clone` 时更新），`currentRoot()` 优先取 active；新增 `currentRepositoryId()`。
- 所有权仍然按 (repositoryId, harnessInstanceId, targetPath) 判定：A 的 baseline 不会让 B 免接管，也不会授权 A 覆盖 B 写入后又被改动的文件（回归见 `capabilities-v2.ownership.unit.test.ts`）。

### 19. 批次中途写失败：错误必须入账，回滚按字节判定（2026-10-21 round 6）

写阶段（`applyRenderedTargets`）的文件系统错误（EACCES 等）**不得逃逸**：原实现无 try/catch，异常抛给调用方、journal 停在 `APPLYING`，与崩溃不可区分且恢复面不可见。现固定为：`APPLY_FAILED` + `write failed: …` 详情落盘，未启动目标按 frozen batch rule 停止。

回滚与可回滚性判定统一为三分支字节规则（与 `reconcileInterruptedBatches` 同口径）：

- 当前字节 == `appliedDigest`（意图写入）→ 可恢复到快照；
- 当前字节 == `previousDigest`（pre-apply）→ **写入从未落地**（中途失败/崩溃于写入前/已回滚），恢复为无操作，计 restored；
- 其他 → 分歧，拒绝并报告，绝不覆盖。

`rollbackAvailable` 额外要求批次至少一个 `COMMITTED` 目标：全预检失败的批次没有任何已提交目标，回滚 CTA 无意义（恢复面文案：「该批次没有已提交的目标，无需回滚」）。

注入证据：`capabilities-v2.apply.unit.test.ts`「records a mid-batch write failure …」——第二 harness 根目录 chmod `0o555` 产生真实 EACCES；断言第一目标 COMMITTED 且可回滚、第二目标字节未动、回滚恢复精确字节。注意 `git status --porcelain` 断言必须 `trimEnd()` 而非 `trim()`：porcelain 把状态编码在**行首字符**（未暂存修改恰为 `" M "`），`trim()` 会把行首空格一并剥掉导致误判（见 INH-1857 验收 4 用例）。

### 20. 回滚自身失败与状态落盘的持久性（2026-10-21 round 7）

**回滚必须先验快照完整性，再动目标**。原实现读到 blob 后直接写入，写入后才比对 `previousDigest`：损坏/截断的 blob 会先把目标覆盖成无法自证的字节，然后才报失败。现顺序固定为「读 blob → 校验 `digest(blob) === previousDigest` → 写入 → 回读校验」，校验不过只记失败、目标不动。

**回滚期间的 fs 错误不得逃逸**：恢复写入（temp + rename）、删除新建文件都包在 try/catch 内，失败计 `failed` 并把批次转为 `RECOVERY_REQUIRED`，而不是把异常抛给调用方。

**按目标记账**：`restored`/`failed` 同时按 `targetKey` 累计。只有自身失败的目标标 `ROLLBACK_FAILED`；同一批次中已成功恢复的目标标 `ROLLED_BACK`（原实现用全局 failed>0 把所有 COMMITTED 目标一起改写，等于谎报）。没有快照文件记录的 COMMITTED 目标保持原状态，不声称回滚。

**落盘持久性**：新增 `infrastructure/durable-write.ts` 的 `writeFileDurably()` —— 写临时文件 → `fsync` → `rename` → 目录 `fsync`（目录打开失败则跳过，文件本身已 sync）。journal/baseline/settings 存储与批次快照的 blob、manifest 全部改走它。原因：temp+rename 只保证「读者看不到半截文件」，不保证「rename 可见时数据块已落盘」；断电窗口内 recovery 可能读到不可信的 journal 或全零 blob。

**证据边界（不夸大）**：进程级 SIGKILL 不会丢 page cache，因此 fsync 的断电语义在本环境**无法被测试证明**。`durable-write.unit.test.ts` 只证明可观察的性质：字节精确、原子替换、无临时残留、失败不破坏原文件、符号链接目标不被跟随。断电持久性属设计层保证，需真机断电/CI VM 才能取证。
