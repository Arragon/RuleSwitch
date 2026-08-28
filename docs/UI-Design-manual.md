# UI Design Manual for Coding Agents

> 版本：2026-08-29  
> 适用对象：不熟悉前端 / UI / UX，但使用 Claude Code、Codex CLI、Cursor 等 Coding Agent 完成产品前端工作的用户。  
> 目标：你只需要判断“我现在想做什么”，然后复制对应 Prompt 给 Agent；或者把本手册直接交给 Agent，让 Agent 自己根据本手册路由任务。

---

## 0. 最重要的规则：不要同时让多个“设计师”争夺控制权

本手册使用以下职责分层：

- **Intent**：负责 UX。决定“为什么存在、用户怎么走、信息怎么组织”。
- **PRODUCT.md**：产品事实与长期产品约束的权威来源。
- **DESIGN.md**：项目视觉系统与长期设计决策的权威来源。
- **Impeccable**：默认 UI 主设计 / 实现 / 整改 Skill。
- **Vercel Web Design Guidelines**：代码级 UI/UX/a11y 验收员。
- **Vercel React Best Practices**：React / Next.js 前端工程与性能验收员。
- **UI UX Pro Max**：设计系统资料库与早期视觉方向顾问；默认不直接重做已有项目。
- **Taste Skill**：视觉 personality / anti-slop 专项顾问；仅在确有需要时使用。
- **Emil Kowalski Skills**：动效、微交互、设计工程专项专家。

### 权威顺序

任何通用 Skill 与项目既有决策冲突时，默认遵循：

```text
明确的用户当前需求
    ↓
PRODUCT.md
    ↓
DESIGN.md
    ↓
项目现有组件 / tokens / 交互约定
    ↓
任务主 Skill
    ↓
辅助 Skill / 通用最佳实践
```

**绝对不要**让 `Impeccable + Taste + frontend-design + UI UX Pro Max` 同时自由 redesign 同一个页面。需要视觉探索时，只选一个“生成型视觉权威”，其余只能做审查、建议或专项工作。

---

# 1. 第一次使用：只做一次的环境准备

## 1.1 必装核心 Skill

在项目根目录执行。

### A. Impeccable

推荐使用其专用 installer，因为它会针对不同 harness 生成对应版本：

```bash
npx impeccable skills install -y --providers=claude,codex,cursor --scope=project
```

如果你只使用其中某些 Agent，删掉不需要的 provider 即可。

例如只用 Claude Code + Codex：

```bash
npx impeccable skills install -y --providers=claude,codex --scope=project
```

安装后重启 Agent / IDE。

### B. Intent

```bash
npx skills add ghaida/intent --skill '*' -a claude-code -a codex -a cursor -y
```

### C. Vercel Web Design Guidelines + React Best Practices

```bash
npx skills add vercel-labs/agent-skills \
  --skill web-design-guidelines \
  --skill react-best-practices \
  -a claude-code -a codex -a cursor -y
```

如果项目完全不是 React / Next.js，可以只装：

```bash
npx skills add vercel-labs/agent-skills \
  --skill web-design-guidelines \
  -a claude-code -a codex -a cursor -y
```

## 1.2 按需 Skill：不要默认全装

### Taste Skill

先查看当前可用 skill 名称：

```bash
npx skills add Leonxlnx/taste-skill --list
```

常用安装：

```bash
npx skills add Leonxlnx/taste-skill \
  --skill redesign-existing-projects \
  --skill design-taste-frontend \
  -a claude-code -a codex -a cursor -y
```

如只做高级视觉页面，可按需安装：

```bash
npx skills add Leonxlnx/taste-skill \
  --skill high-end-visual-design \
  -a claude-code -a codex -a cursor -y
```

注意：`design-taste-frontend` 当前 v2 仍属于快速迭代版本；不要把它设成所有生产项目的唯一设计规范来源。

### Emil Kowalski Skills

先查看：

```bash
npx skills add emilkowalski/skills --list
```

前端最值得装的一组：

```bash
npx skills add emilkowalski/skills \
  --skill emil-design-eng \
  --skill animate \
  --skill review-animations \
  --skill improve-animations \
  --skill find-animation-opportunities \
  --skill prototype \
  --skill pick-ui-library \
  -a claude-code -a codex -a cursor -y
```

### UI UX Pro Max

只有在“新项目建立设计系统 / 需要系统化风格候选”时才建议安装。

通用安装：

```bash
npx --yes ui-ux-pro-max-cli init --ai all
```

或者只装到一个 Agent：

```bash
npx --yes ui-ux-pro-max-cli init --ai claude
npx --yes ui-ux-pro-max-cli init --ai cursor
npx --yes ui-ux-pro-max-cli init --ai codex
```

如果命令名称随未来版本变化，先执行：

```bash
npx skills add <repo> --list
```

不要凭记忆猜 skill 名。

---

# 2. 第一次进入一个已有项目：初始化设计上下文

如果项目已经开发了一段时间，但没有 `PRODUCT.md` / `DESIGN.md`，先完成本节，再开始 UI 整改。

## 2.1 建立 PRODUCT.md

### 使用 Skill

- Impeccable：`init`

### Claude Code / 支持 slash command 的 harness

```text
/impeccable init
```

然后补充下面的约束 Prompt：

```text
Inspect the existing repository thoroughly before asking me questions.
Infer product facts from code, documentation, routes, data models, and existing behavior.

Create or update the root PRODUCT.md as the durable source of product truth.

Do NOT redesign the UI.
Do NOT modify application code.
Do NOT invent product requirements that cannot be inferred.
Preserve all existing functionality and data semantics.
If a non-critical product fact is unknown, mark it explicitly as unknown/open instead of guessing.
```

### 什么时候执行

- 新接手项目。
- 项目没有清晰产品说明。
- Agent 经常误解产品用途。
- 后续准备进行较大的 UI/UX 整改。

---

## 2.2 从已有 UI 生成 DESIGN.md

### 使用 Skill

- Impeccable：`document`

### Prompt

```text
/impeccable document

Scan the existing project and document the incumbent visual system in root DESIGN.md.

Inspect at minimum:
- theme / CSS variables / design tokens
- typography
- spacing and sizing scales
- colors and semantic colors
- borders, radius, shadows
- component primitives
- navigation patterns
- page layout patterns
- interaction states
- responsive behavior
- representative rendered screens when possible

This is documentation and normalization, NOT a redesign.
Do not modify application code.
Do not invent a new visual identity.
If the project is inconsistent, document the dominant coherent pattern and explicitly list unresolved inconsistencies.
```

### 什么时候执行

- 已有项目准备让 AI 长期维护 UI。
- 多个页面视觉开始漂移。
- 想让 Claude / Codex / Cursor 使用相同设计语言。

---

# 3. 60 秒任务选择表

先看你现在的需求属于哪一行，然后直接跳到对应章节。

| 我的需求 | 首选 Skill / 命令 | 后续 |
|---|---|---|
| 不知道产品/功能到底应该怎么设计 | Intent `strategize` | `journey` / `organize` |
| 用户流程、步骤、导航关系有问题 | Intent `journey` | `organize` → `wireframe` |
| 信息分类、侧边栏、菜单、设置项怎么组织 | Intent `organize` | `wireframe` |
| 不知道页面元素应该放哪里 | Intent `wireframe` | Impeccable `shape` / 实现 |
| UI 文案、错误提示、CTA 不清晰 | Intent `articulate`（系统级）或 Impeccable `clarify`（局部） | `polish` |
| 新增一个普通页面/功能 | Impeccable `shape` 或自然语言新工作请求 | `audit` → `polish` |
| 现有页面“感觉不好但说不清” | Impeccable `critique` | 依据结果调用专项命令 |
| 页面布局乱、间距差、层级差 | Impeccable `layout` | `polish` |
| 字体、字号、文本层级不好 | Impeccable `typeset` | `polish` |
| 页面太灰、没有重点 | Impeccable `colorize` | `polish` |
| 页面太复杂、卡片太多、信息过载 | Impeccable `distill` | `layout` |
| 页面太无聊、过于安全 | Impeccable `bolder` | 必要时 Taste |
| 页面太花、太吵、动画太多 | Impeccable `quieter` | `polish` |
| 想增加少量有意义的个性 | Impeccable `delight` | `polish` |
| 需要夸张实验型视觉效果 | Impeccable `overdrive` | 只用于明确允许的项目 |
| 响应式 / 手机 / 平板适配 | Impeccable `adapt` | Vercel review |
| Web → Native / Desktop → Mobile 的体验迁移 | Intent `transpose` | Impeccable `adapt` |
| 错误态、空状态、长文本、边界条件 | Intent `fortify` + Impeccable `harden` | audit |
| onboarding / 首次使用 / 激活 | Intent `journey` + `articulate` | Impeccable `onboard` |
| 无障碍设计 | Intent `include` | Impeccable `audit` + Vercel guidelines |
| UI 性能差 | Impeccable `optimize` | React 项目加 `react-best-practices` |
| 动画从零设计 | Emil `animate` | `review-animations` |
| 不知道哪里该加动画 | Emil `find-animation-opportunities` | 选中后 `animate` |
| 已有动画感觉不对 | Emil `review-animations`（局部）/ `improve-animations`（全局） | 执行修复 |
| 想快速看多个 UI 变体 | Impeccable `live` 或 Emil `prototype` | 选一个再固化 |
| 已有 UI 想做较大视觉升级 | Impeccable `critique` → Taste `redesign-existing-projects`（顾问） | 更新 DESIGN.md → Impeccable 实施 |
| 新项目需要先确定视觉系统 | UI UX Pro Max | 写入 DESIGN.md → Impeccable 实现 |
| 页面做完准备交付 | Impeccable `harden` → `audit` → Vercel review → `polish` | smoke test |

---

# 4. 通用 Agent 路由 Prompt：最推荐的“懒人模式”

如果你懒得自己判断 Skill，就把本手册放进项目，例如：

```text
docs/UI-Design-manual.md
```

以后对 Agent 只发下面这段：

```text
Read docs/UI-Design-manual.md first and follow it as the routing policy for this task.

Before editing code:
1. Classify this task according to the manual.
2. Identify the exact primary skill/sub-skill required and any secondary review skill.
3. Check whether the required skill is installed in this project.
4. If a required skill is missing, install only that required skill using the installation command from the manual. Do not install optional design skills unnecessarily.
5. Read PRODUCT.md and DESIGN.md if they exist.
6. Preserve current functionality, data compatibility, and established project conventions unless the task explicitly changes them.
7. Use only one generative visual-design authority at a time.
8. Perform bounded verification after implementation; do not enter an open-ended polish loop.

Task:
[把你的需求写这里]
```

这是最省脑子的默认用法。

---

# 5. 工作流 A：新增普通页面 / 普通 UI 功能

例如：

- 新增 Settings 页面。
- 新增一个文件预览面板。
- 新增订阅详情 drawer。
- 新增筛选栏。
- 新增 Dashboard 的一个区块。

## 判断

如果这个功能的用户流程已经很明确，不需要重新思考 IA / UX，就不要调用 Intent。

## 主 Skill

- Impeccable `shape`：需求还有一定结构设计空间时。
- Impeccable 普通新工作流程：需求已经非常明确时。

## 推荐 Prompt

```text
Use Impeccable as the primary UI skill.

First read PRODUCT.md and DESIGN.md.
Then use `/impeccable shape [feature]` to resolve only the necessary screen structure and interaction decisions before editing code.

Preserve:
- existing functionality
- data compatibility
- established navigation model
- existing design tokens
- reusable components and libraries

Do not create a parallel design system.
Do not perform unrelated refactors.

Implement the feature completely, including loading, empty, disabled, error, and success states when relevant.
Inspect the rendered result at representative desktop and mobile widths where applicable.

Feature:
[写需求]
```

实现后执行：

```text
/impeccable audit [feature]
```

如果是 React / Next.js，再发：

```text
Review the changed frontend code using the installed `react-best-practices` skill.
Fix only meaningful issues introduced or exposed by this task. Do not perform unrelated architecture rewrites.
```

最后：

```text
/impeccable polish [feature]
```

---

# 6. 工作流 B：新增“复杂功能”，涉及用户流程

例如：

- onboarding。
- 导入项目向导。
- 多步骤支付。
- 账号绑定。
- 创建 / 编辑 / 发布工作流。
- 搜索 → 筛选 → 查看 → 操作完整流程。

## 使用顺序

```text
Intent journey
→ 必要时 organize
→ 必要时 wireframe
→ fortify
→ specify
→ Impeccable 实现
→ audit
→ Vercel review
→ polish
```

## 第一步：流程

Claude Code plugin 中可使用：

```text
/intent:journey
```

其他 Agent 直接描述：

```text
Invoke Intent's `journey` skill for this task.
```

### Prompt

```text
Invoke Intent's `journey` skill.

Read PRODUCT.md first.
Design the end-to-end user flow for the feature below before any UI implementation.

Explicitly cover:
- entry points
- primary happy path
- decision points
- back/cancel behavior
- recoverability
- failure paths
- interrupted/resumed flow
- required user feedback
- completion state

Preserve existing product semantics and navigation unless a change is necessary and justified.
Do not make final visual styling decisions yet.
Do not modify code.

Feature:
[写功能]
```

## 第二步：如果涉及导航 / 分类，再调用 organize

```text
Invoke Intent's `organize` skill using the journey we just established.

Resolve the information architecture, navigation placement, labels, hierarchy, and grouping for this feature.
Prefer extending the existing navigation and taxonomy rather than creating a new parallel structure.
Do not implement code yet.
```

## 第三步：页面结构不明确时，调用 wireframe

```text
Invoke Intent's `wireframe` skill.

Turn the approved journey and information architecture into low-fidelity screen structures.
Focus only on hierarchy, placement, controls, states, and screen-to-screen continuity.
Do not spend time on visual polish, colors, fonts, or decorative styling.
```

## 第四步：边界条件

```text
Invoke Intent's `fortify` skill.

Stress-test the proposed experience against real-world conditions:
- no data
- partial data
- slow operations
- network/server failure
- invalid input
- permission denial
- repeated actions
- long text
- localization expansion
- interruption and retry
- destructive actions
- concurrent/stale state where relevant

Produce concrete state requirements for implementation.
```

## 第五步：交给工程实现

```text
Invoke Intent's `specify` skill.

Convert the approved flow, IA, wireframe, copy requirements, and edge cases into an implementation-ready handoff.
The handoff must be concrete enough for another coding agent to implement without re-deciding the UX.
```

然后给实现 Agent：

```text
Implement the attached/previous Intent specification using Impeccable as the primary UI implementation skill.
Read PRODUCT.md and DESIGN.md first.
Do not re-open settled UX decisions unless implementation reveals a concrete conflict.
Reuse the current component system and tokens.
After implementation run `/impeccable audit [feature]`, then the Vercel review skills, then `/impeccable polish [feature]`.
```

---

# 7. 工作流 C：页面“看着不对”，但你说不出哪里有问题

这是最常见场景。

## 不要直接说

```text
Make it prettier.
```

## 使用

- Impeccable `critique`

### Prompt

```text
/impeccable critique [page/route/component]

Do not redesign yet.
First diagnose the existing rendered UI and rank the problems by impact.

Evaluate at minimum:
- information hierarchy
- visual hierarchy
- cognitive load
- layout rhythm
- typography hierarchy
- color/contrast
- component consistency
- interaction clarity
- state clarity
- density
- generic AI/UI patterns
- accessibility concerns

Separate findings into:
1. structural UX problems
2. layout / hierarchy problems
3. typography problems
4. color / styling problems
5. interaction/state problems
6. polish-only issues

For each high-impact finding, recommend the single most appropriate Impeccable command or Intent skill to fix it.
Do not modify code until the diagnosis is complete.
```

然后按诊断结果选择下面的专项命令，不要一股脑全跑。

---

# 8. 工作流 D：布局、间距、视觉层级不好

## 使用

- Impeccable `layout`

## Prompt

```text
/impeccable layout [target]

Read DESIGN.md and inspect neighboring screens/components first.
Fix layout, spacing, alignment, grouping, density, and visual hierarchy while preserving the existing visual identity and behavior.

Prioritize:
- clear primary/secondary hierarchy
- consistent spacing rhythm
- alignment
- predictable grouping
- scanability
- appropriate density for this product

Do not change typography, color system, navigation, or component semantics unless a layout defect genuinely requires it.
Do not redesign unrelated areas.
```

适合：Dashboard、Settings、列表、详情页、toolbar、sidebar、复杂表单。

---

# 9. 工作流 E：字体 / 字号 / 文本层级不好

## 使用

- Impeccable `typeset`

## Prompt

```text
/impeccable typeset [target]

Preserve DESIGN.md and the incumbent visual identity.
Improve typography only where it materially improves hierarchy, readability, density, or character.

Audit:
- font family and fallback
- heading/body/caption hierarchy
- size scale
- weight usage
- line height
- line length
- letter spacing
- number/data presentation
- truncation and wrapping

Do not use typography changes as an excuse to redesign the layout.
Keep the result practical for the actual product, not a magazine mockup.
```

---

# 10. 工作流 F：页面太灰、没有重点、颜色使用混乱

## 使用

- Impeccable `colorize`

## Prompt

```text
/impeccable colorize [target]

Read DESIGN.md and existing semantic color tokens first.
Improve color usage strategically without replacing the project identity.

Use color to clarify:
- priority
- state
- selection
- risk
- success
- navigation/context

Avoid decorative rainbow palettes and avoid creating new one-off colors when existing semantic tokens can serve the purpose.
Check contrast and dark/light theme compatibility where relevant.
```

---

# 11. 工作流 G：界面太复杂、卡片太多、信息过载

## 使用

- Impeccable `distill`

## Prompt

```text
/impeccable distill [target]

Reduce this interface to its essential structure without removing functionality users actually need.

Identify and remove or merge:
- redundant containers/cards
- duplicate labels
- repeated explanatory text
- unnecessary chrome
- weak secondary actions competing with primary actions
- visual separators that do not encode structure
- controls that can be progressively disclosed

Preserve task completion capability and important information.
If removing something would change product behavior, call it out before doing so.
```

---

# 12. 工作流 H：UI 太无聊、太保守、AI 味重

先用 Impeccable，只有不够时才 Taste。

## 第一级：Impeccable bolder

```text
/impeccable bolder [target]

The current UI is coherent but too safe/generic.
Increase visual confidence and distinctiveness without changing product behavior, information architecture, or DESIGN.md invariants.

Prefer meaningful improvements to composition, hierarchy, typography, accent strategy, and signature details over arbitrary gradients, oversized cards, or decorative effects.
```

如果仍然不够，再进入 Taste。

## 第二级：Taste `redesign-existing-projects`

仅用于已有项目较明显的视觉升级。

```text
Use Taste skill `redesign-existing-projects` as a bounded visual-design consultant.

PRODUCT.md and DESIGN.md remain authoritative.
Do not change:
- navigation model
- user flow
- product semantics
- data structure
- established reusable component contracts
without explicit justification.

Audit the current surface first, then propose a targeted upgrade plan.
Do NOT rewrite the frontend from scratch.

Desired direction:
[例如：更精密、更克制、更像专业桌面生产力工具；减少 AI dashboard 味]

Keep the redesign scope limited to:
[target]

Before implementation, clearly identify which DESIGN.md rules remain, which need refinement, and why.
```

确认视觉方向后，应把长期有效的新决策更新进 `DESIGN.md`，再交回 Impeccable 实施/收尾。

---

# 13. 工作流 I：UI 太花、太吵、太“设计师自嗨”

## 使用

- Impeccable `quieter`

```text
/impeccable quieter [target]

The interface is visually overstimulating.
Reduce unnecessary contrast, decoration, motion, competing accents, and hierarchy noise while preserving usability and product identity.

Do not flatten important state distinctions or remove affordances merely for minimalism.
The target is calm clarity, not featureless gray UI.
```

---

# 14. 工作流 J：想增加“精致感 / 小惊喜”，但不想重做

## 使用

- Impeccable `delight`

```text
/impeccable delight [target]

Add a small amount of product-appropriate personality and delight without changing the core layout or interaction model.

Prefer one or two high-leverage touches such as:
- meaningful micro-feedback
- subtle state transition
- refined empty/success state
- useful contextual affordance
- restrained typographic or icon detail

Avoid decorative gimmicks, confetti everywhere, excessive motion, or novelty that slows repeated workflows.
```

---

# 15. 工作流 K：新项目建立视觉系统

这是 UI UX Pro Max 最适合的使用方式之一。

## 使用

1. Intent（如产品/UX 还没定）
2. UI UX Pro Max：只做 design-system direction
3. 写入 DESIGN.md
4. Impeccable 负责实际实现

## Prompt

```text
Use UI UX Pro Max as a design-system research and direction tool only.
Read PRODUCT.md first.

Generate 3 genuinely distinct but product-appropriate design-system directions for this product.
For each direction provide:
- design rationale
- visual tone
- density
- typography roles
- color / semantic color strategy
- spacing scale
- radius/border/shadow language
- component language
- navigation language
- data visualization guidance if relevant
- motion level
- accessibility considerations
- common anti-patterns to avoid

Do not implement UI yet.
Do not combine the three directions into one average design.
Recommend one default direction and explain why it best fits the product.

Product-specific constraints:
[填写，例如：桌面工具、信息密度高、不要 Material You、不要明显 AI dashboard 味]
```

选定后：

```text
Convert the selected design-system direction into a concise root DESIGN.md.
Keep only durable, reusable project decisions.
Do not include temporary page-specific details.
Do not implement code yet.
```

之后：

```text
Implement the first surface using Impeccable as the primary UI implementation skill.
Treat PRODUCT.md and DESIGN.md as authoritative.
```

---

# 16. 工作流 L：Landing Page / 官网 / Portfolio，需要强视觉表现

这类页面和 Dashboard / 工具型 App 不一样，可以让 Taste 成为主视觉权威。

## 推荐组合

```text
Taste design-taste-frontend
→ Impeccable critique
→ Impeccable audit
→ Vercel web-design-guidelines
→ Impeccable polish
```

注意：Taste 自己也明确更适合 landing page、portfolio、redesign，而不是复杂 data table / multi-step product UI。

## Prompt

```text
Use Taste skill `design-taste-frontend` as the primary visual-design authority for this landing/marketing surface.
Read PRODUCT.md and DESIGN.md first if present.

Infer a strong, coherent visual direction from the product instead of defaulting to generic SaaS styling.

Constraints:
- preserve brand/product truth
- one coherent aesthetic direction
- no generic purple AI gradient
- no unnecessary card grid
- no decorative complexity without purpose
- production-ready responsive implementation

Set the visual behavior approximately as:
DESIGN_VARIANCE = [6-9]
MOTION_INTENSITY = [3-7]
VISUAL_DENSITY = [3-6]

Task:
[写页面需求]
```

如果你要“高级、克制、昂贵感”的视觉，可改用 Taste：

```text
high-end-visual-design
```

如果你明确要 Notion / Linear 一类克制编辑器感，可考虑：

```text
minimalist-ui
```

不要在一个页面同时让 `design-taste-frontend`、`high-end-visual-design`、`minimalist-ui` 三个一起主导。

---

# 17. 工作流 M：重做导航 / Sidebar / Settings 信息架构

这是典型 UX 任务，不应该一开始就让视觉 Skill 改 CSS。

## 使用顺序

```text
Intent organize
→ Intent journey（若有多步骤流程）
→ Intent wireframe
→ Intent specify
→ Impeccable 实现
```

## Prompt

```text
Invoke Intent's `organize` skill.

Read PRODUCT.md and inspect the current navigation, route structure, settings taxonomy, and existing labels.

Redesign the information architecture for:
[target]

Optimize for:
- findability
- predictable grouping
- stable mental model
- clear labels
- scalable future additions
- minimal navigation depth
- preserving existing user expectations where reasonable

Do not make visual styling decisions.
Do not modify code yet.
Do not move items merely to make the result look different.

After the IA is resolved, invoke `wireframe` to define screen structure, then `specify` for engineering handoff.
```

---

# 18. 工作流 N：表单 / Settings / 配置页面

简单表单直接 Impeccable；复杂表单先 Intent。

## 简单表单

```text
Use Impeccable for this form/settings task.
Read PRODUCT.md and DESIGN.md.

Implement or improve the form with emphasis on:
- label clarity
- grouping
- validation
- disabled/loading/submitting/success/error states
- keyboard behavior
- focus behavior
- destructive action safety
- sensible defaults
- inline help only when needed

Use `/impeccable clarify [target]` for unclear labels/messages,
`/impeccable layout [target]` for grouping/layout,
and `/impeccable harden [target]` before shipping.

Do not redesign unrelated settings.
```

## 复杂多步骤表单

先走第 6 章的 Intent `journey` 流程。

---

# 19. 工作流 O：Onboarding / 首次使用 / Empty State

## 使用顺序

```text
Intent journey
→ Intent articulate
→ Intent include
→ Impeccable onboard
→ Impeccable harden
```

## Prompt

```text
First invoke Intent's `journey` skill to design the first-run path and activation goal.
Then invoke Intent's `articulate` skill for onboarding copy and empty-state guidance.
Use Intent's `include` skill to make sure the flow works for keyboard, screen-reader, cognitive, and motor accessibility needs.

After those UX decisions are settled, use `/impeccable onboard [target]` to implement the onboarding / empty states within the existing DESIGN.md.

Requirements:
- do not block experienced users unnecessarily
- allow escape/skip where appropriate
- do not overload the first screen
- explain value before asking for effort
- handle zero-data state usefully
- include recovery if setup fails
```

---

# 20. 工作流 P：UI 文案 / 按钮名称 / 错误提示

有两个工具，范围不同。

## A. 只改局部 UI 文案

使用 Impeccable `clarify`。

```text
/impeccable clarify [target]

Improve labels, button text, helper text, validation, empty-state text, and error messages for clarity.
Preserve factual meaning, product terminology, legal meaning, and brand voice.
Do not invent promises or system behavior.
Ensure the user can understand what happened, what matters, and what to do next.
```

## B. 整个功能的内容策略 / voice / terminology

使用 Intent `articulate`。

```text
Invoke Intent's `articulate` skill.

Design the content strategy and UI language for this feature.
Define:
- terminology
- CTA hierarchy
- error-message pattern
- confirmation pattern
- empty-state voice
- tone under stress vs success
- consistency rules

Do not change product facts.
```

---

# 21. 工作流 Q：错误态、边界条件、真实世界可靠性

## 设计层

Intent `fortify`

## 实现层

Impeccable `harden`

## Prompt

```text
First invoke Intent's `fortify` skill and produce a concrete state inventory for this feature.

Then run:
/impeccable harden [target]

Implement the relevant real-world states, including where applicable:
- loading
- slow loading
- no data
- partial data
- permission denied
- validation failure
- backend/network failure
- stale data
- retry
- duplicate action
- destructive action confirmation/recovery
- long content
- narrow viewport
- localization expansion
- keyboard-only use

Do not create fake states that the product/backend cannot actually represent.
```

---

# 22. 工作流 R：响应式 / 手机 / 平板适配

## 情况 1：只是 Web 响应式

使用 Impeccable `adapt`。

```text
/impeccable adapt [target]

Adapt this existing interface across representative viewport classes while preserving task priority and DESIGN.md.

Do not merely shrink everything.
Re-evaluate:
- content priority
- navigation collapse
- control reachability
- table/list strategy
- wrapping/truncation
- touch target size
- sticky/fixed elements
- modal/drawer behavior

Verify at least one narrow mobile width and one desktop width.
```

## 情况 2：Web → Native、Desktop → Mobile，交互模式也要变

先 Intent `transpose`：

```text
Invoke Intent's `transpose` skill.

Adapt this experience from [source platform] to [target platform].
Preserve user intent and product semantics, but follow target-platform conventions where the interaction model should change.

Explicitly identify:
- what remains invariant
- what must change because of platform context
- navigation changes
- input changes
- density/content-priority changes
- platform-specific affordances

Do not implement code yet.
```

再由 Impeccable `adapt` 实现。

---

# 23. 工作流 S：无障碍

无障碍不是只跑一个 lint。

## 设计层：Intent include

```text
Invoke Intent's `include` skill.

Evaluate this experience as an accessibility design problem, not only a checklist.
Cover WCAG 2.2-relevant concerns plus:
- keyboard-only path
- screen-reader order and announcements
- focus model
- cognitive load
- motor accessibility
- target size
- color-independent state communication
- reduced motion
- error recovery

Produce concrete design requirements before implementation changes.
```

## 实现层：Impeccable audit

```text
/impeccable audit [target]
```

## 最终代码验收：Vercel web-design-guidelines

```text
Review the implemented surface using the installed `web-design-guidelines` skill.
Focus on semantic HTML, forms, keyboard behavior, focus states, accessibility, responsive behavior, interaction states, typography, images, and frontend UI correctness.
Fix concrete violations without changing the approved design direction.
```

---

# 24. 工作流 T：动画 / 微交互

动效质量要求高时，优先使用 Emil 专项 Skill，而不是泛化 `make it smooth`。

## 24.1 不知道哪里该加动画

使用：`find-animation-opportunities`

```text
Invoke Emil's `find-animation-opportunities` skill on [target].

Do not implement animation yet.
Identify only interactions where motion has a clear purpose: feedback, spatial continuity, or state indication.
Explicitly reject areas that should remain instant because they are high-frequency or keyboard-driven.
Return prioritized opportunities with concrete motion recipes.
```

## 24.2 已经知道哪个组件要动画

使用：`animate`

```text
Invoke Emil's `animate` skill.

Implement purposeful motion for:
[target]

Purpose:
[feedback / spatial consistency / state indication]

Respect existing motion tokens and component architecture.
Do not install a motion dependency unless the existing stack cannot reasonably implement the required behavior.
Ship reduced-motion handling and appropriate hover/pointer gating with the implementation.
```

## 24.3 检查刚写的动画

使用：`review-animations`

```text
Invoke Emil's `review-animations` skill and review the animation changes in this task.
Fix concrete issues with easing, duration, interruption, exit behavior, properties, accessibility, or excessive motion.
Do not broaden the scope to unrelated UI.
```

## 24.4 全项目动画普查

使用：`improve-animations`

注意该 Skill 主要是审计 / 计划，不直接修改源码。

```text
Invoke Emil's `improve-animations` skill.
Audit animation and motion across this codebase.
Produce a prioritized set of self-contained implementation plans.
Do not modify source code during the audit.
```

## 24.5 普通、小范围动画，也可以用 Impeccable

```text
/impeccable animate [target]
```

选择原则：

- 普通 UI refinement：Impeccable `animate` 足够。
- 动效是产品体验重点：用 Emil `animate`。
- 全项目 motion 质量治理：用 Emil 系列。

---

# 25. 工作流 U：尝试多个 UI 方案，让我肉眼选

## 方法 A：Impeccable live

适用于已有页面局部元素，需要在浏览器里直接看多个变体。

```text
/impeccable live
```

然后告诉 Agent：

```text
Use live variant mode on [target element].
Keep PRODUCT.md and DESIGN.md identity constraints.
Generate genuinely different variants along the axis of [layout / typeset / colorize / quieter / bolder / etc.], not three tiny cosmetic variations.
```

`live` 通常需要正在运行的 dev server 或可打开的静态页面。

## 方法 B：Emil prototype

适合一个组件/小块 UI 做多个真正不同的实现：

```text
Invoke Emil's `prototype` skill.
Build several genuinely different variants of [component] behind its visual picker.
The variants must differ in interaction/composition strategy, not only color or radius.
Preserve project constraints and make it easy for me to choose one winner.
```

选定后只保留赢家，删除实验性分支代码。

---

# 26. 工作流 V：提取重复组件 / Design Tokens

## 使用

- Impeccable `extract`

```text
/impeccable extract [target]

Inspect the target for repeated UI patterns, duplicated components, hard-coded design values, and inconsistent variants.

Extract only patterns that are genuinely reusable.
Prefer existing design-system locations and naming conventions.
Do not create a new component abstraction for a one-off element.
Do not introduce a new dependency just to abstract simple code.
Preserve behavior and visual output.
```

适合在 UI 已经稳定、重复模式出现后再做。不要在第一版页面还没定型时提前抽象一切。

---

# 27. 工作流 W：UI 性能问题

## 通用 UI 性能

```text
/impeccable optimize [target]
```

Prompt：

```text
/impeccable optimize [target]

Diagnose the actual UI performance problem before changing architecture.
Prioritize measurable high-impact issues such as excessive rendering, large assets, layout/paint cost, blocking work, and unnecessary frontend work.
Preserve behavior and visual output.
Avoid speculative micro-optimization.
```

## React / Next.js

额外运行 Vercel `react-best-practices`：

```text
Review this React/Next.js implementation using the installed `react-best-practices` skill.
Prioritize critical/high-impact issues first, especially waterfalls, unnecessary client work, bundle cost, rendering boundaries, and avoidable re-renders.
Do not perform low-value stylistic refactors.
```

---

# 28. 工作流 X：最终交付前检查

任何不是“一次性 demo”的 UI 功能，完成后建议走：

```text
harden
→ audit
→ Vercel web-design-guidelines
→ React best practices（如果适用）
→ 修复
→ polish
→ 最后一次 smoke test
```

## 可直接复制的一体化 Prompt

```text
The feature is implementation-complete. Run the final frontend delivery workflow.

1. Run `/impeccable harden [target]` for real-world states and edge cases.
2. Run `/impeccable audit [target]` for technical UI quality, accessibility, responsive behavior, and performance concerns.
3. Review the changed UI using Vercel `web-design-guidelines` and fix concrete violations.
4. If this is React/Next.js, review the changed code using `react-best-practices` and fix meaningful high-impact issues.
5. Run `/impeccable polish [target]` as a bounded final refinement pass.
6. Smoke-test the primary user path and representative failure/empty states.

Constraints:
- do not redesign the product during final QA
- do not perform unrelated refactors
- PRODUCT.md and DESIGN.md remain authoritative
- stop after one normal fix pass plus at most one confirmation pass; do not enter an endless polish loop

Report only:
- what was fixed
- any remaining known issue
- whether the feature is ready to ship
```

---

# 29. 什么时候该用 Intent 的其他 Skill

Intent 不仅有 journey / organize / wireframe。

| Intent Skill | 什么时候用 |
|---|---|
| `strategize` | 需求本身模糊，不知道真正问题是什么；新项目 kickoff |
| `investigate` | 需要用户研究、访谈、survey、已有研究材料综合 |
| `blueprint` | 前台体验背后依赖多个系统/服务/流程，需要 service blueprint |
| `journey` | 用户流程、task flow、多步骤交互 |
| `organize` | IA、导航、taxonomy、内容层级 |
| `wireframe` | 页面结构和控件布局还没定 |
| `articulate` | UX writing、voice、术语、系统性文案 |
| `evaluate` | 做 UX heuristic evaluation / 设计审查 |
| `fortify` | 错误态、边界条件、恶劣真实环境 |
| `include` | accessibility / inclusive design |
| `transpose` | 跨平台体验迁移 |
| `localize` | i18n、RTL、文化适配、语言膨胀 |
| `measure` | HEART、指标、A/B test、成功衡量方式 |
| `specify` | 设计 → 工程 handoff |
| `philosopher` | 真的卡住，需要发散而不是立即收敛 |
| `storytelling` | 产品叙事、设计方案表达、stakeholder story |

## Intent evaluate 的正确用法

如果你怀疑“不是 UI 漂不漂亮，而是 UX 本身有毛病”，使用：

```text
Invoke Intent's `evaluate` skill.

Evaluate [flow/page/feature] as a UX system before proposing visual changes.
Route each finding to the appropriate Intent skill (journey, organize, wireframe, articulate, include, fortify, etc.).
Do not use aesthetic preference as evidence of a UX defect.
```

---

# 30. Impeccable 23 个命令：人话速查

> 当前 Impeccable 4.x 的核心命令。`craft` 已是 deprecated alias，不需要专门使用。

| 命令 | 你可以理解成 |
|---|---|
| `init` | 建 PRODUCT.md / 项目产品上下文 |
| `document` | 从已有项目生成 DESIGN.md |
| `shape` | 写代码前把 UI/UX 结构想清楚 |
| `extract` | 把重复组件/tokens 正式抽出来 |
| `critique` | “这 UI 到底哪里不对？” |
| `audit` | 技术质量、a11y、responsive、performance 检查 |
| `polish` | 上线前最后精修，不允许偷偷 redesign |
| `bolder` | 太怂、太普通 → 更有主见 |
| `quieter` | 太吵、太花 → 收敛 |
| `distill` | 太复杂 → 删冗余、抓本质 |
| `harden` | 错误态、长文本、边界条件、真实世界 |
| `onboard` | onboarding / empty state / activation |
| `animate` | 加有目的的动效 |
| `colorize` | 用颜色建立重点/状态，不是乱加彩色 |
| `typeset` | 字体、字号、行高、文本 hierarchy |
| `layout` | 间距、对齐、节奏、布局 hierarchy |
| `delight` | 小而克制的产品 personality |
| `overdrive` | 明确需要实验型/突破型视觉时才用 |
| `clarify` | 文案、label、error message 看不懂 |
| `adapt` | responsive / 不同设备 |
| `optimize` | UI 性能 |
| `live` | 浏览器内多个视觉变体 |
| `craft` | 已 deprecated；普通“做新 UI”请求即可，不必调用 |

---

# 31. “症状 → Prompt”超短懒人表

如果你今晚脑子完全不想动，只看这一节。

## “这个页面好丑，但我不知道为什么”

```text
/impeccable critique [页面]
Diagnose first. Do not edit until you rank the highest-impact problems and map each one to the correct Impeccable command or Intent skill.
```

## “布局很乱”

```text
/impeccable layout [页面]
Preserve DESIGN.md and behavior. Fix hierarchy, grouping, spacing, alignment and density only.
```

## “字体看起来土/层级不清”

```text
/impeccable typeset [页面]
Preserve layout and identity. Fix typography hierarchy and readability.
```

## “像 AI 生成的 SaaS 模板”

```text
/impeccable bolder [页面]
Make it more distinctive without changing UX or DESIGN.md invariants. Avoid generic gradients/card grids.
```

不够再：

```text
Use Taste `redesign-existing-projects` as a bounded consultant. Audit first; do not rewrite or change UX. PRODUCT.md and DESIGN.md remain authoritative.
```

## “太花了”

```text
/impeccable quieter [页面]
Reduce visual noise while preserving affordances and important states.
```

## “东西太多，看不懂”

```text
/impeccable distill [页面]
Remove redundancy and unnecessary chrome without removing required functionality.
```

## “手机上炸了”

```text
/impeccable adapt [页面]
Adapt hierarchy/navigation/content priority for mobile instead of merely shrinking the desktop layout.
```

## “按钮、错误提示看不懂”

```text
/impeccable clarify [页面/组件]
Preserve facts and terminology. Make each state explain what happened and what the user should do next.
```

## “这个流程很别扭”

```text
Invoke Intent `journey`. Redesign the end-to-end task flow before touching visual styling or code.
```

## “侧边栏/菜单不知道怎么分”

```text
Invoke Intent `organize`. Fix information architecture, taxonomy and navigation before styling.
```

## “页面应该放哪些东西、怎么排”

```text
Invoke Intent `wireframe`. Resolve low-fidelity screen structure before visual design.
```

## “需要做动效，但我不会”

```text
Invoke Emil `animate` for [组件]. Decide first whether it should animate at all, then implement the correct motion including reduced-motion behavior.
```

## “我甚至不知道哪里值得动”

```text
Invoke Emil `find-animation-opportunities`. Read-only: propose only motion with a clear UX purpose and explicitly reject high-frequency interactions that should stay instant.
```

## “做完了，帮我验收”

```text
Run `/impeccable harden [target]`, then `/impeccable audit [target]`, then Vercel `web-design-guidelines`; if React/Next.js also run `react-best-practices`; fix concrete issues; finally `/impeccable polish [target]` and smoke-test the primary flow.
```

---

# 32. 给 Agent 的“禁止事项”

建议把下面这段长期放进项目 Agent 规则中。

```text
UI/UX AGENT RULES

1. PRODUCT.md and DESIGN.md are durable project sources of truth.
2. Preserve existing functionality and data compatibility unless the task explicitly changes them.
3. Reuse existing components, tokens, and maintained dependencies where appropriate. Do not create parallel UI systems.
4. Only one generative visual-design skill may own a task at a time.
5. Intent owns UX structure; Impeccable owns default UI craft; Vercel skills are quality gates; Taste is optional visual-direction consulting; Emil skills own specialist motion work.
6. Do not redesign during audit/polish unless a redesign is explicitly requested.
7. Do not install a dependency for a trivial UI effect if the existing stack can implement it cleanly.
8. Do not hand-roll complex interaction primitives (dialog, menu, combobox, toast, etc.) when a mature, actively maintained, license-compatible library already used by the project can provide them.
9. Do not replace a coherent existing design system because a generic skill prefers a different aesthetic.
10. Verify rendered UI after implementation. Use bounded passes: one inspection/fix pass and at most one confirmation pass unless a concrete blocker remains.
11. Accessibility, loading/error/empty states, keyboard behavior, responsiveness, and realistic content are part of feature completeness, not optional polish.
12. Avoid generic AI UI defaults unless genuinely justified: excessive card grids, gratuitous purple gradients, huge rounded rectangles, indiscriminate glassmorphism, decorative charts, excessive pill controls, weak gray-on-gray hierarchy, and animation without purpose.
```

---

# 33. 推荐的完整常用工作流

## 33.1 80% 的普通 UI 开发

```text
读 PRODUCT.md + DESIGN.md
→ Impeccable shape（必要时）
→ 实现
→ Impeccable audit
→ Vercel web-design-guidelines
→ React 项目：react-best-practices
→ Impeccable polish
```

## 33.2 UX 较复杂的新功能

```text
Intent journey
→ organize（必要时）
→ wireframe（必要时）
→ fortify
→ specify
→ Impeccable 实现
→ audit
→ Vercel
→ polish
```

## 33.3 已有 UI 整改

```text
Impeccable critique
→ 只选最对应的专项命令：
   layout / typeset / colorize / distill / bolder / quieter / clarify / adapt ...
→ harden
→ audit
→ Vercel
→ polish
```

## 33.4 大幅视觉升级，但 UX 不动

```text
Impeccable critique
→ Taste redesign-existing-projects（只做受控视觉方向）
→ 确认并更新 DESIGN.md
→ Impeccable 实现 / refinement
→ Vercel
→ polish
```

## 33.5 新项目从零建立视觉体系

```text
Intent strategize / journey / organize（按需）
→ UI UX Pro Max 给 3 个 design-system 方向
→ 人或高能力 Agent 选 1 个
→ 写 DESIGN.md
→ Impeccable 实现
→ Vercel
→ polish
```

## 33.6 高视觉 Landing Page

```text
Taste design-taste-frontend（主视觉权威）
→ 实现
→ Impeccable critique
→ Impeccable audit
→ Vercel web-design-guidelines
→ Impeccable polish
```

## 33.7 动效专项

```text
Emil find-animation-opportunities（不知道哪里该动）
→ Emil animate（实现选中的动效）
→ Emil review-animations
→ Impeccable audit / polish
```

---

# 34. 让另一个 AI 自动使用本手册的 System / Project Rule

如果你希望 Claude Code / Cursor / Codex 自己判断，不想每次人工查表，可以把下面这段作为项目规则，并让它读取本文件。

```text
For any frontend/UI/UX task, read `docs/UI-Design-manual.md` before deciding how to proceed.

Use the manual as the routing policy, not as inspiration.
Classify the request, select the narrowest appropriate skill/sub-skill, and follow its workflow.

Before editing:
- inspect PRODUCT.md and DESIGN.md when present;
- inspect existing tokens/components and representative adjacent UI;
- verify required skills are installed;
- if a required skill is missing, install only that skill using the manual's command;
- do not load multiple competing generative design skills for the same stage.

UX/IA/flow decisions route to Intent.
Default UI implementation/refinement routes to Impeccable.
Motion-specialist work routes to Emil skills.
Taste is opt-in for deliberate visual personality or bounded redesign.
UI UX Pro Max is primarily for early design-system exploration.
Vercel web-design-guidelines and react-best-practices are review/quality gates, not visual art direction.

Preserve functionality, data compatibility, PRODUCT.md, DESIGN.md, and incumbent component contracts unless the explicit task changes them.
Do not silently broaden scope.

For implementation tasks, finish with the manual's appropriate verification workflow.
```

---

# 35. 版本与上游变化处理

Agent Skills 生态变化很快。本手册的 Skill 名称与安装方法基于 2026-08-29 上游状态整理。

如果未来某条命令失败：

1. 不要改用来路不明的 fork。
2. 先运行：

```bash
npx skills add <owner/repo> --list
```

3. 查看上游 README / SKILL.md 的当前名称。
4. 如果只是 Skill 重命名，更新本手册对应名字。
5. 如果 Skill 的职责发生变化，应重新判断它在本手册中的角色，而不是机械替换名称。

---

# 36. 上游来源与核对依据

本手册主要依据以下项目的当前 README / SKILL.md / reference 文档整理：

- Impeccable: https://github.com/pbakaus/impeccable
- Intent: https://github.com/ghaida/intent
- Vercel Agent Skills: https://github.com/vercel-labs/agent-skills
- Agent Skills CLI: https://github.com/vercel-labs/skills
- Taste Skill: https://github.com/Leonxlnx/taste-skill
- Emil Kowalski Skills: https://github.com/emilkowalski/skills
- UI UX Pro Max: https://github.com/nextlevelbuilder/ui-ux-pro-max-skill

关键当前事实：

- Impeccable 4.x 以 `/impeccable <command>` 为主要入口，包含 `init`、`document`、`shape`、`critique`、`audit`、`polish`、`layout`、`typeset`、`adapt`、`harden`、`live` 等明确 playbook；`craft` 已为 deprecated alias。
- Intent 提供 UX 路由，包括 `strategize`、`investigate`、`blueprint`、`journey`、`organize`、`wireframe`、`articulate`、`evaluate`、`fortify`、`include`、`transpose`、`localize`、`measure`、`specify` 等。
- Vercel `web-design-guidelines` 适合作为 Web UI review gate；`react-best-practices` 面向 React / Next.js 的工程、性能与实现质量。
- Taste `design-taste-frontend` 当前更明确定位于 landing pages / portfolios / redesigns，而不是复杂 dashboard/data-table/multi-step product UI。
- Emil 的 `animate`、`review-animations`、`improve-animations`、`find-animation-opportunities` 等 Skill 已把动效工作进一步拆分为构建、局部审查、全局审计和机会发现。

---

# 最终只记住这一张图

```text
我现在有一个前端需求
│
├─ 产品/流程/导航/信息结构不知道怎么设计？
│   └─ Intent
│      ├─ journey     流程
│      ├─ organize    IA/导航
│      ├─ wireframe   页面结构
│      ├─ articulate  文案系统
│      ├─ fortify     边界状态
│      ├─ include     无障碍设计
│      └─ specify     交给工程
│
├─ UX 已明确，只需要做/改 UI？
│   └─ Impeccable
│      ├─ shape       开工前想清结构
│      ├─ critique    不知道哪里不好
│      ├─ layout      布局
│      ├─ typeset     字体
│      ├─ colorize    色彩
│      ├─ distill     简化
│      ├─ bolder      太普通
│      ├─ quieter     太吵
│      ├─ clarify     文案
│      ├─ adapt       响应式
│      ├─ harden      边界条件
│      ├─ optimize    性能
│      └─ polish      最终精修
│
├─ 就是想明显提升视觉 personality？
│   └─ Taste（按需，单独主导这一阶段）
│
├─ 动画/微交互很重要？
│   └─ Emil
│      ├─ find-animation-opportunities
│      ├─ animate
│      ├─ review-animations
│      └─ improve-animations
│
├─ 新项目需要先建视觉系统？
│   └─ UI UX Pro Max → 选一个方向 → DESIGN.md
│
└─ 做完了？
    └─ harden
       → Impeccable audit
       → Vercel web-design-guidelines
       → React: react-best-practices
       → Impeccable polish
       → smoke test
```

**一句话版：Intent 决定体验结构，DESIGN.md 决定长期规则，Impeccable 负责默认 UI craft，Emil 负责专业动效，Taste 只在需要强视觉 personality 时介入，Vercel 负责最后工程验收。**
