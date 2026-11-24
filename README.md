# DSH Better Plan · 计划预览增强

在 DSH Web 界面中，以 Antigravity 风格的文档阅读和批注计划。插件与 Better Sidebar 的文件页签共用右栏，保留 DSH 原生计划卡片、历史记录和审批流程。

[下载安装包](https://github.com/Ling-ye-Future/dsh-better-plan/releases) · [English summary](#english-summary)

## 安装与回退

| 组件 | 已验证版本 |
| --- | --- |
| DSH Web 界面 | `0.2.2-rc.5` |
| Better Sidebar（需启用） | `0.32.1` |

1. 从 [v0.1.9 Release](https://github.com/Ling-ye-Future/dsh-better-plan/releases/tag/v0.1.9) 下载 `dsh-better-plan-0.1.9.tgz`。仓库为私有时，需要有访问权限的 GitHub 账号；可用发布说明中的 SHA-256 校验下载文件。
2. 解压安装包，在 DSH 的 **插件 → 添加插件** 中选择含插件清单 `package.json` 的目录（解压后的 `package/`），启用 **计划预览增强**。安装发布包不需要 npm 或本地构建。
3. 使用 `/plan` 进入计划模式。计划可在右栏自动打开，也可从原生卡片点击 **查看完整计划**；批准或要求修改仍使用原生控件。

如果缺少匹配的 Better Sidebar 服务，DSH 会保留原生预览。要回退，禁用或移除 **计划预览增强** 即可；不需要重装 Better Sidebar，也不会删除计划记录。

## 预览功能

- **文档排版**：支持浅色和深色主题、GFM 提示块，以及 `[NEW]`、`[MODIFY]`、`[DELETE]`、`[RENAME]`、`[MOVE]` 行首动作徽章。
- **代码与公式**：代码块支持语法高亮、语言标签、复制和换行切换；KaTeX 使用内置字体离线渲染行内公式 `$…$` 和块级公式 `$$…$$`。
- **Mermaid**：遇到 `mermaid`、`mermaidjs` 或 `mmd` 代码块时才加载渲染组件。图表在沙箱中渲染，SVG 经净化后展示，支持图形与源码切换及弹窗缩放。
- **工作区链接**：普通会话计划可打开当前会话工作区内的文件，支持相对路径、绝对路径、`file://` 和 `#L1-L5` 行范围。越出工作区的路径不会打开，临时和子代理预览也不提供文件跳转。插件不会将计划正文写入工作区，也不会自动加载正文中的图片或外链。

## 审阅与批注

1. 在实时待审的普通会话计划中，选中**同一段落或列表项**内的文字，从选区旁或顶部工具栏选择 **添加批注**。也可用浏览器光标浏览创建键盘选区。代码块、图表、公式、表格和跨段选区不支持批注。
2. 保存后可以编辑或删除批注，点击批注行号可跳回并标出对应正文。每次审阅最多保存 10 条，每条最多 800 字。
3. 点击 **带批注继续规划**，将摘录、原 Markdown 的行范围和意见一起发给代理。此操作**不会批准执行**；原生 **要求修改** 和 **同意执行** 都不会发送右栏批注。

批注仅在宿主提供审阅调用 ID 时可用。草稿只保存在当前审阅的内存中：关闭预览或切换会话后，同一审阅可继续使用草稿；刷新页面或结束审阅会清空未发送的批注，修订版不会继承。历史、临时和子代理计划只能阅读，不能批注。

## 计划结构引导

| 插件设置 | 默认值 | 作用 |
| --- | --- | --- |
| `planGuidance` | `true` | 在计划模式下按任务复杂度引导计划结构。 |
| `customGuidance` | 空字符串 | 在默认引导后追加团队约定。 |

这两项设置可在运行中调整。引导只在计划模式下且宿主的 `plan:policy` 非空时注入，不改变非计划模式的提示词。简单任务（L0）使用精简结构；多文件、架构或高风险任务（L1/L2）按需列出目标、需确认事项、按子系统分组的改动和验证步骤。

## 本地构建与打包

从源码构建需要 **Node.js ≥ 20** 和 npm。在仓库根目录运行：

```powershell
npm ci --ignore-scripts
npm run build

New-Item -ItemType Directory -Path dist -Force | Out-Null
npm pack --ignore-scripts --pack-destination ./dist
```

构建完成后，才能从源码目录添加插件。打包会在 `dist/` 生成 `.tgz`，包含宿主入口、预览脚本、按需加载的 Mermaid 组件和第三方许可说明。分发时应上传该 `.tgz`，而不是 GitHub 自动生成的源码压缩包。

## 验证

**自动测试：** 当前分支不跟踪测试用例，安装包也不包含它们。已有本地用例时，可运行 `npm test`（包含构建）；没有用例时，请完成构建和下列 GUI 检查，不要把零测试通过视为验证。

**GUI 验收：**

1. 打开含 Mermaid、公式、代码块和带 `#L1-L5` 的工作区链接的待审计划，检查预览、缩放、复制、换行和文件跳转；关闭后从原生卡片重新打开。
2. 保存、编辑和回跳两条批注，切换会话或文件页签后再回到同一审阅。发送批注后应继续规划而非批准执行，且修订版不继承草稿。
3. 在窄栏及浅、深主题下检查工具栏、键盘焦点和横向滚动。历史、临时和子代理计划不得出现批注入口；工作区外的路径不得打开，普通 Markdown 文件仍使用 Better Sidebar 原有查看器。
4. 关闭 `planGuidance` 检查仅结构引导停止；禁用插件后，确认回到 DSH 原生计划预览。

## 许可与致谢

本项目采用 [MIT 许可证](<./LICENSE>)。视觉布局参考 [Google Antigravity 官方示例](https://codelabs.developers.google.com/static/getting-started-google-antigravity/img/e5f7bdf6da2674d8.png)，插件不分发 Antigravity 的图片、字体或其他品牌素材。

## English summary

DSH Better Plan adds a document view for native plans in the DSH web sidebar. The verified setup is DSH `0.2.2-rc.5` with Better Sidebar `0.32.1` enabled. Download a prebuilt package from [GitHub Releases](https://github.com/Ling-ye-Future/dsh-better-plan/releases), extract it, and add the extracted package folder in DSH. No npm build is needed for the prebuilt package.

The preview supports Mermaid, KaTeX, syntax highlighting, and workspace-scoped file links. In an active review, select text in one paragraph or list item, add a comment, then choose **Continue planning with comments** to send feedback without approving the plan. Native review controls remain available. Disable the add-on to restore the native preview.
