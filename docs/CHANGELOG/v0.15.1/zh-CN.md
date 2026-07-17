---
title: Open Design 0.15.1
description: 多模态理解更清晰，长会话更连贯。
---

# Open Design 0.15.1 — 看得更清楚，长任务更连贯

Open Design 0.15.1 全面升级了内置的 **OpenDesign Agent**。多模态模型现在可以读取更细致的图片信息，同时更轻量的上下文处理也让响应更快、更聚焦于真正重要的设计任务。

## ⚡ 核心 Runtime 升级

- **图片中的细节会更完整地到达模型。** 新版 OpenDesign Agent 改善了多模态模型接收和理解图片内容的方式，让截图分析、视觉评审和以图片为输入的设计任务更加可靠。

- **更长的 agent session 会保持连贯，也能更从容地恢复。** OpenDesign Agent 升级改善了 session replay、stream 与 context overflow recovery，并在 compaction 后保留有用上下文，让长时间工作更不容易丢失进度或提前结束。

## ✨ 新增

### 🎨 Studio 与需求澄清

- **澄清问题直接留在对话中。** Deck 和 prototype 的视觉方向问题现在使用可比较、可刷新、可展开的视觉选项，无需离开聊天；提交后，包括多选结果在内的答案都会收拢成清晰的 brief。 (#5496, #5757)

- **首页更明确地表达人与 agent 的协作方式。** 新标题直接邀请你与 agent 一起设计，并同步覆盖所有支持的语言。 (#5699)

### 🧠 Agent、模型与搜索

- **为项目接入合适模型和研究能力的方式更多了。** Open Design 新增 AtomCode agent runtime、SiliconFlow Global BYOK 预设，以及 AMR 并行网页搜索。 (#5654, #5108, #5552)

## 🔁 变化

### ⚡ 更快、更干净的多轮对话

- **多轮任务会更充分地复用已有上下文。** Intent signal 现在以用户真正说过的内容为准，不再被需求表单中的备选文字误触发，从而减少支持 session resume 的 agent 重复发送稳定 prompt。 (#5709)

- **Memory 默认更干净，也更由你掌控。** “从聊天中学习”现在默认关闭；已有 memory、工作档案、手动条目和 connector 导入仍会正常使用。升级时还会清理已知的自动提取噪声，同时保留合法 memory。 (#5708)

- **更新状态更容易理解。** 静默更新设置、状态文案和新版本提示会更明确地告诉你是否已有更新，以及接下来会发生什么。 (#5608, #5609, #5631)

> 📥 **下载：** Tag `open-design-v0.15.1`。
>
> | 平台 | 架构 | 安装包 |
> |---|---|---|
> | macOS | Apple Silicon | [open-design-0.15.1-mac-arm64.dmg](https://github.com/nexu-io/open-design/releases/download/open-design-v0.15.1/open-design-0.15.1-mac-arm64.dmg) |
> | macOS | Intel | [open-design-0.15.1-mac-x64.dmg](https://github.com/nexu-io/open-design/releases/download/open-design-v0.15.1/open-design-0.15.1-mac-x64.dmg) |
> | Windows | x64 | [open-design-0.15.1-win-x64-setup.exe](https://github.com/nexu-io/open-design/releases/download/open-design-v0.15.1/open-design-0.15.1-win-x64-setup.exe) |

## 🐛 修复

### 🖼 HTML、预览与交付

- **成功完成的分析不再看起来像失败任务。** 当你让 Open Design 阅读、检查、点评或分析现有设计时，有效的文字结果会正常完成，不再错误显示 `ARTIFACT_NOT_FOUND`；真正尝试但未能交付文件的运行仍会展示真实错误。 (#5724)

- **HTML 内容会更可靠地出现在屏幕上。** Plan 模式生成 HTML 后会自动打开；原地编辑会保留交付状态和历史；大型预览会在必要时加载并刷新完整源码；重定向循环不会再卡死预览，HTML 项目也会保留视觉封面。 (#5602, #5689, #5710, #5469, #5762)

- **预览和部署反馈保持可见。** 交付状态更清楚，跨项目文件链接会留在应用内，部署成功提示也会显示在触发它的弹窗上方。 (#5557, #5611, #5455, #5696)

### 🎞 Deck 与导出

- **Deck 导出会与已确认的结果一致。** 多页 PPT/PDF 会包含每一页；幻灯片图片和 PDF 不再出现文字重叠；可编辑 PPTX 会保留中日韩字体；已渲染的缩略图也不会消失。 (#5645, #5628, #5644, #5626)

- **演示细节保持同步。** 键盘翻页时页码会正确更新；演讲者备注演示使用更安全的 sandbox；深色主题 Mermaid 图也会保持预期的视觉规范。 (#5594, #5571, #5595)

### 🤖 Agent 与 BYOK

- **Agent 中断后可以恢复，而不是直接结束任务。** AMR 会重试暂时性的 runtime 关闭；OpenDesign Agent resume 遇到 EOF 时会清除过期 session，并进入既有恢复路径继续执行。 (#5564, #5744)

- **BYOK Agent 的失败判断更准确，干扰更少。** 支持的 BYOK 运行不再被权限提示阻塞；provider 返回 “Not Found” 时也会直接、准确地停止，而不是被当作临时 stream 中断不断重试。 (#5701, #5726)

- **模型与媒体集成会返回预期结果。** Pi model discovery 会读取正确输出；长模型名称仍能看到 lock 标识；带调用前缀的 Codex 图片可以正常导入；`od media generate` 也会按文档接受 prompt file。 (#5637, #5533, #5582, #5534)

### 🛟 桌面端与数据可靠性

- **安装包启动与更新更加可靠。** 内置数据库 binary 与打包 runtime 保持一致；重新启动时可以停止旧的不兼容 desktop process；更新器也会等待仍被占用的 launcher file 解锁后再清理。 (#5680, #5677, #5780)

- **并发和外部输入会安全地失败。** 同时导入同一个 Library 内容时会自动去重，不再返回 server error；远程 Library 导入也会阻止不安全的本地网络目标。 (#5662, #5529)

- **小型界面回归不再打断工作。** 首页层级、浏览器引导、question-form 文本、页面滚动、模型控件、品牌样式、全屏设置与 Community 浏览都恢复一致表现；gallery 默认展示所有内容类型。 (#5590, #5596, #5423, #5493, #5607, #5533, #5613, #5550, #5597, #5759)

## 🙏 感谢所有参与 0.15.1 发布的贡献者

@abhi-zit77 · @alchemistklk · @Bodhi848 · @coyaSONG · @EthanGuo-coder · @fancyboi999 · @Hashim-K · @hu-qi · @lefarcen · @leonaburime-ucla · @mturac · @Nissimmiracles · @PerishCode · @roian6 · @ScarletttMoon · @Siri-Ray · @tomsen02 · @TuTouPower · @UNHNQ · @vijaykiran06 · @xne998808-ai · @xxiaoxiong
