# RuleSwitch desktop design preview

状态：HTML 界面原型，业务功能后续实现。只操作页面内存，不读写真实配置或执行 Git。刷新会重置演示状态。没有修改生产 UI、IPC、provider、事务或持久化契约。

## 产品与页面职责

需求依据：用户当前反馈及 Linear 的 [v1.0 Architecture & Execution Baseline](https://linear.app/inhandy/document/ruleswitch-v10-architecture-and-execution-baseline-fee3d17ad800)。现有生产代码仍为 Phase A / v1-compatible Phase B；原型不代表业务接入或产品 Gate 通过。

| 页面 | 展示对象 | 主要动作 |
|---|---|---|
| 配置库 | 当前 Git 仓库、当前分支的配置版本 | 类型分组与折叠、过滤、查看/编辑/删除配置、应用到多个工具和项目 |
| 本机 AI 工具 | 当前设备上工具实际使用的本地设置 | 按工具查看全局/项目文件、读取本机修改、新工具/设备配置 |
| 项目 | 当前设备上的项目设置与实际文件 | 本机目录绑定、关联工具、项目专属配置与全局继承 |
| 同步变更 / Git 仓库 | 本地 Git 工作区、Index、HEAD 与 origin/main 的关系 | 更改与暂存、差异、撤销、提交、Fetch、快进拉取、推送、合并冲突处理 |
| 同步变更 / Harness 配置 | 同一仓库内各工具配置集合的关系 | 选择来源/多个目标与范围、比较同名配置、覆盖/合并/保留/新增/显式删除 |
| 历史 | Git 版本与工具应用记录 | 分别查看与预览恢复 |
| 设置 | 仓库与工具管理、本机偏好 | 常见工具预设匹配、自定义工具、凭据引用与主题 |

仓库文件与工具运行时文件分别管理。Git 推送完成不表示工具已应用；读取工具本地修改后才产生对应仓库文件的更改。配置库与工具/项目页面仍使用各自固定内容示例，尚未建立整个原型的共同业务数据模型。

## 同步变更的两层模型

```text
远程 Git 仓库 origin/main
          ↕ Fetch / Pull / Push
本地 Git 仓库 agent-environment / main
   ├─ shared/                         共享配置
   └─ harnesses/
       ├─ claude-code/  ← 配置差异 →  codex/
       ├─ cursor/
       └─ opencode/
```

用户称为“小仓库”的 Harness 配置在本次界面中表现为仓库内的配置集合。目录名为示意，不确定实际存储方案；没有引入嵌套 `.git` 或 submodule。独立子仓库的 commit/remote/submodule ownership 需要后续架构定义，不由界面原型决定。

Git 区域参照 [VS Code 暂存与提交](https://code.visualstudio.com/docs/sourcecontrol/staging-commits) 和 [仓库与远程](https://code.visualstudio.com/docs/sourcecontrol/repos-remotes)：

- 工作区修改 → 暂存版本 → 本地提交 → 推送远端。暂存后再次修改，后来的内容仍保留在“更改”中；提交只收录 Index。
- Fetch 更新远端引用，工作区和本地 HEAD 不变；Pull 接收远端提交；Push 上传已提交版本，不收录未提交修改。操作分别显示。
- 延续现有原型的快进同步策略：分叉时阻止直接拉取/推送，显示双方提交；Merge/Rebase 的完整流程不在本次实现中。提供合并冲突结果选择与暂存示意。
- 分支/远程面板展示当前关系，分支创建/切换、Stash、部分行暂存、真实提交图算法尚未实现。
- 示例状态覆盖远端领先、分叉、离线、合并冲突和全部同步；控件明确标记为原型测试用途。

Harness 区域管理同一仓库内配置集合的差异。不同范围分别保存演示数据：

- 来源/目标与共同基线比较，区分相同、来源有更新、目标有修改、双方有修改、仅来源/目标存在、不支持。
- 来源到多个目标逐项选择和预览。目标独有配置默认保留；删除必须显式选择并确认；双方修改先选处理方式。
- MCP 示例按字段三方合并，保留目标独有字段；同名字段两边都改为不同值时阻止计划。它只验证此示例，不能作为通用配置转换引擎。
- 同步结果进入目标仓库文件的未暂存更改，回到 Git 界面检查/暂存/提交/推送。运行时工具应用另外确认。
- 手动登记工具未设置映射时阻止自动应用。读取实际工具修改、真实路径授权、配置转换、快照与恢复仍待业务接入。

## 其他已设计入口

- 配置库：多选工具 × 全局/多个项目；覆盖、合并/新增、仅新增，可逐目标调整。覆盖已有内容需确认；无支持/未绑定组合列出原因。
- 本机工具：新工具/设备向导，设备与 Git 来源并排展示，双列工具卡片、全选/反选、已选数量、无选择时下一步禁用。
- 工具详情的“同步修改”进入 Harness 配置工作区；Git 提交/推送在 Git 工作区统一管理。
- 仓库编辑/删除：展示工作树修改与后续提交/推送方向；默认保留本机副本。这些其他操作仍是独立流程示意。
- 设置：常见工具名称与示意图标匹配；完全自定义名称、文字/Emoji 图标、目录和格式。登记只保存在当前会话。

## 视觉与打开

默认亮色，保留暗色切换；复用同一组 tokens、系统字体、细边框和紧凑操作。原生 dialog 支持 Escape。Git 使用文件列表 / 差异查看器布局；Harness 比较复用同样的差异区域。小桌面窗口内代码区可横向滚动，页面整体不横向溢出。

从仓库根运行（无需安装原型依赖）：

```sh
python3 -m http.server 4173 --bind 127.0.0.1
```

访问 http://127.0.0.1:4173/prototypes/desktop/?revision=git-workbench 。也可直接打开 `index.html`。

## 验证与界限

```sh
node --check prototypes/desktop/app.js
node --check prototypes/desktop/sync-workbench.js
node --test prototypes/desktop/prototype.test.cjs
```

24 项原型测试通过，覆盖已有导航/来源/分组/应用/工具管理，以及暂存版本隔离、提交前置条件、远端阻止、共同基线比较、MCP 字段冲突、目标独有内容保留、全局/项目范围隔离。

浏览器已检查：暂存/提交/推送预览、快进拉取、分叉/离线、合并冲突处理、Harness 合并/覆盖确认与结果进入 Git 更改列表。1024×768 下 Git 与 Harness 工作区无 document/main 横向溢出。最终浏览器 error logs 为空；默认亮色与恢复后的 1219×870 桌面布局已检查。

当前截图：`screenshots/git-workbench.jpg`、`screenshots/harness-compare.jpg`。

没有运行生产 build/typecheck/unit/integration/Electron E2E；没有验证 Windows/Linux、native Electron、真实 Git/文件/安全/恢复语义、全套读屏或对比度合规。生产实现需复用 Git 与 Monaco 能力，以及已有 authorization/provider/transaction 边界；静态差异标色和内存演示不能移植为 Git 引擎。

Git 工作区使用独立的“文件更改 / 提交记录”标签；历史列表不嵌在文件差异下方。长文件差异在代码区域内部滚动。切换视图保留文件选择、暂存内容与提交说明。新增回归覆盖 1000 行文件和视图切换；浏览器已验证两个视图切换，控制台无错误。预览截图：`git-history.jpg`。
