# v1.0 契约 · Harness Adapter v2 与 Capability Matrix

- 状态：**Frozen**（M0 / INH-1755，含 2026-10-07 原型补充：登记≠能力）
- 代码（canonical）：`packages/core/src/v2/harness-adapter.ts`
- 测试：`packages/core/src/v2/__tests__/harness-adapter.conformance.unit.test.ts`（mock adapter + conformance harness + 结构化诊断校验 + 登记/自动写拒绝）

## 七方法 port

`descriptor` / `detectInstances(scope)` / `scan(instanceId)` / `describeCapabilities()` / `import(scan)` / `render(instanceId, assets)` / `verify(instanceId, expectations)`。

返回值统一为 `ConversionOutcome<T>`（grade + diagnostics + output|null）：

- `unsupported`：必须 output=null 且 diagnostics 非空（解释原因）；
- `degraded`：必须至少一条 `severity:"loss"` 诊断（列出损失）；
- **silent ignore 即 conformance 失败**（`validateConversionOutcome` 强制）。

## CapabilityMatrix

按 config kind 声明：Global/Project 读写级别（`read-write|read-only|unsupported`）、verify 支持、自 round-trip grade、runtimeRequirements（如 `claude-cli`）、platformConstraints。Core 对 harness 的能力判断只读此矩阵，**不出现 harness-name 条件分支**。

## 强制边界

- Adapter 接口上不存在 commit/history/backup/delete/conflict 能力（编译期缺席即执行）。
- 绝对路径仅存在于 main 侧 port 类型（scan/render 输入输出），永不进入 Renderer contract。
- Mock adapter（`createMockHarnessAdapter`）+ conformance harness（`runAdapterConformance`）已提供，M3/M6 可只依赖本契约并行开发；M6 扩展为真实四 Harness fixture 矩阵（INH-1807）。

## 登记与能力的差别（原型补充）

- `HarnessRegistration`：displayName/图标/格式提示/installed/presetMatched——纯展示与本地绑定。
- `REGISTRATION_GRANTS_WRITE = false`（冻结常量）。
- `canAutoCaptureOrApply(registration, detectedByAdapter)`：`custom:` 前缀 adapter、未安装、预设不匹配、或 adapter detector 未识别 → 显式拒绝自动 Capture/Apply，附 reason。名字相似永远不构成支持证据。
