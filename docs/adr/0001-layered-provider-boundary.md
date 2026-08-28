# ADR-0001: Layered Provider Boundary

- Status: Accepted
- Scope: v1 baseline

## Context

v0.1 使用 Rulesync，但长期要支持 Cursor、Claude、Codex 等 Native Provider。Renderer、transaction 和 Viewer 若直接依赖 Rulesync，将使替换 provider、权限收敛与测试变得困难。本 ADR 作出时先冻结 `packages/core` contracts；Phase A 随后按该边界实现了 Rulesync adapter、Electron application 与 UI。

## Decision

采用四层：Presentation（Renderer/UI）→ Capability Boundary（Preload/Main IPC）→ Application & Domain（services/`packages/core`）→ Adapters & Infrastructure（RulesyncProvider/platform/filesystem）。这是运行时调用方向；编译期 core 声明 ports 且零外层依赖，adapter 依赖 core 并实现 `ConfigProvider`/`PlatformService`，Main composition root 组装。

`ConfigProvider` v1 固定 `descriptor`、`detect`、`validate`、`stage`、`preview`。Rulesync implementation 与 types 只存在于 `packages/rulesync-provider`；Renderer 和 core 不 import Rulesync。Provider 只能生成 staging/ChangeSet，不拥有真实 Apply、Snapshot、History 或 UI。

## Consequences

- Rulesync 16.14.0 必须经 Programmatic API adapter 使用，不能 CLI spawn。
- 新 Native Provider 可复用 domain、Viewer、Diff、transaction/history。
- 会增加 adapter/DTO 映射，但换来可测试与最小权限。
- 修改 Provider contract 或依赖方向需 L4 ADR；L2/L3 不得静默穿透边界。
