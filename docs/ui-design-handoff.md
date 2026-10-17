# 健康罗盘 UI 设计任务交接

## 项目背景

这是一个本地健康记录 App，基于 Expo React Native（Android / iOS / Web 三端共用 TypeScript 代码）。用户可以拍照记录饮食、记录训练、记录睡眠，查看每日 AI 摘要和趋势图表。

**技术栈**：React Native、Expo、TypeScript、本地 AsyncStorage、ZIP 导出备份、可选 AI 分析（用户自行配置 API）。

**当前版本**：v0.5「日间地图」，刚完成今天页（Today）的重设计。调色板和布局原则见 `docs/redesign-vision-v0.5.md`。

## 你的任务

帮我设计和实现健康罗盘的前端 UI。我会逐步推进五个里程碑，现在是**里程碑 1**已完成，接下来需要你继续做**里程碑 2、3、4、5**。

每个里程碑的详细要求见 `docs/redesign-milestone-*.md`（目前只有 milestone-1 存在，后续我会提供）。

## 里程碑 1 已完成（参考）

- **范围**：只改今天页（`src/ui/today.tsx`）和调色板（`src/ui/theme.ts`）
- **视觉方向**：「日间地图」—— 暖白基底、地形分层隐喻、赤土橙 / 青铜绿 / 琥珀金三色模块
- **核心改动**：
  - 去掉 v0.4 的 24 小时表盘，改用三张横向数据卡（饮食 / 训练 / 睡眠）
  - 三个操作按钮（记饮食 / 记训练 / 记睡眠），记饮食按钮更大（`flex: 1.5`）
  - 今日摘要面板用 `raised` 背景色区分层次
  - 今日记录列表用色点 + 分隔线，去掉时间轨竖线
- **结果**：
  - typecheck 通过
  - 60 个单元测试通过
  - UI 测试通过（`npm run test:ui`）
  - 390px 和 360px 截图已生成
  - 其他三个页面（记录、趋势、我的）未改动，保持原样

## 你需要了解的文件结构

### 核心文件（你会改的）
- `src/ui/theme.ts`：调色板、间距、字阶、模块色
- `src/ui/today.tsx`：今天页
- `src/ui/records.tsx`：记录页（里程碑 2）
- `src/ui/trends.tsx`：趋势页（里程碑 2）
- `src/ui/me.tsx`：我的页（里程碑 4）
- `src/ui/meal-form.tsx`、`src/ui/training-form.tsx`、`src/ui/sleep-form.tsx`：三个表单（里程碑 3）
- `src/ui/settings-forms.tsx`：资料和 AI 设置表单（里程碑 4）

### 不能改的文件（数据逻辑和类型）
- `src/types.ts`：所有 TypeScript 类型定义
- `src/storage.ts`：本地存储和 ZIP 导出/恢复
- `src/domain.ts`：数据计算逻辑（热量汇总、训练递增、睡眠时长）
- `src/ai.ts`：AI 服务调用（饮食分析、每日摘要）
- `App.tsx`：主 App 组件（除了 import 路径，其他不要动）

### 测试文件（不能改）
- `tests/*.test.ts`：60 个单元测试
- `tests/ui.spec.ts`：浏览器流程测试

### 参考文档
- `docs/redesign-vision-v0.5.md`：v0.5 视觉方向说明（为什么这样设计，与 v0.3/v0.4 的区别）
- `docs/redesign-milestone-1.md`：里程碑 1 规格（已完成，作为参考）
- `README.md`：项目总览、启动命令、测试命令
- `docs/product-spec-v0.1.md`：产品规格（功能边界、数据结构）

### 备份（不要动）
- `artifacts/backup/ui-v0.3/`：v0.3 浅色版本备份
- `artifacts/backup/ui-v0.4/`：v0.4 深色版本备份
- `artifacts/ui-v0.5/`：v0.5 截图

## 设计约束和原则

### 必须遵守
1. **不改数据逻辑**：只改 UI 展示，不改 `src/types.ts`、`src/storage.ts`、`src/domain.ts`、`src/ai.ts`
2. **保持信息完整**：所有现有数据都必须可见，不能隐藏或折叠必要信息
3. **保持交互完整**：所有现有功能都必须保留，不能让用户失去任何操作入口
4. **通过所有测试**：`npm run typecheck`、`npm test`、`npm run test:ui` 都必须通过
5. **响应式设计**：至少在 360px 和 390px 宽度下正常显示，不横向溢出

### 视觉方向（v0.5「日间地图」）
- **基底**：暖白 `#FBF9F6`，五级浮雕面（paper / surface / raised / sunken / line）
- **文字**：深褐 `#2A2420`（ink），柔和灰 `#6B6258`（inkSoft），淡灰 `#9D9488`（inkFaint）
- **强调色**：青铜绿 `#5A8A6F`（accent），用于链接、AI 按钮
- **模块色**：
  - 饮食（meal）：赤土橙 `#C8593E`
  - 训练（training）：青铜绿 `#5A8A6F`
  - 睡眠（sleep）：琥珀金 `#E09C3E`
- **圆角**：`input: 12, block: 16, pill: 999`
- **间距**：`xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 48`
- **层级策略**：不用阴影，依靠背景色阶区分层次；数据卡片用 1.5px 边框

### 排版原则
- Display 用负字距（-0.6），Body 行高 1.6
- 数值类文字用 `fontVariant: ["tabular-nums"]` 保持等宽对齐
- 标题和标签用 700 或 800 粗细

## 如何开始

### 1. 熟悉项目
```bash
# 克隆或打开项目目录
cd C:\Users\14360\Documents\ChatGPT\身体规划

# 安装依赖（如果还没安装）
npm install

# 启动 Web 预览（用于开发和截图）
npm run web
# 访问 http://localhost:8085

# 运行类型检查
npm run typecheck

# 运行单元测试
npm test

# 运行浏览器流程测试（需要先启动 npm run web）
npm run test:ui
```

### 2. 查看当前 UI（v0.5）
- 截图：`artifacts/ui-v0.5/today-390.png` 和 `today-360.png`
- 源码：`src/ui/today.tsx`（今天页）、`src/ui/theme.ts`（调色板）
- 对比：`artifacts/backup/ui-v0.4/today.tsx.bak`（上一版深色表盘方案）

### 3. 阅读视觉方向文档
- `docs/redesign-vision-v0.5.md`：为什么去掉表盘？为什么用三张数据卡？为什么记饮食按钮更大？

### 4. 接收里程碑任务
我会给你下一个里程碑的规格文档（例如 `docs/redesign-milestone-2.md`），你按文档要求：
- 备份当前版本（如果需要）
- 修改指定的 UI 文件
- 运行 typecheck 和测试
- 截图验证（390px 和 360px）
- 写视觉说明（如果有新的设计决策）

### 5. 交付检查清单
每个里程碑完成后，确认：
- [ ] 备份已创建（如果改了现有页面）
- [ ] `npm run typecheck` 通过
- [ ] `npm test` 60 个测试全部通过
- [ ] `npm run test:ui` 通过
- [ ] 390px 和 360px 截图无横向溢出
- [ ] 所有必需信息可见
- [ ] 所有交互正常
- [ ] 未改动的页面未受影响

## 常见问题

### Q1: 我需要改 `App.tsx` 吗？
**A**: 除了 import 路径（例如新增了 `src/ui/xxx.tsx` 组件需要 import），其他部分不要动。`App.tsx` 有 891 行，包含状态管理、导航逻辑、表单控制，改动风险高。

### Q2: 我可以新增组件文件吗？
**A**: 可以，在 `src/ui/` 下新增 `.tsx` 文件。例如里程碑 1 新增了 `src/ui/dial.tsx`（24 小时表盘组件，虽然 v0.5 已经不用了，但保留在代码里供参考）。

### Q3: 我可以改 `src/ui/components.tsx` 吗？
**A**: 可以，这是共享组件文件（如 `MarkdownText`、`SummaryVersions`、表单输入框样式）。但改动会影响所有页面，测试时注意检查其他页面是否正常。

### Q4: 为什么 `color.pine` 和 `color.pineTint` 还在 `theme.ts` 里？
**A**: 这是向后兼容的别名。v0.4 用 `pine`（青色）作为强调色，v0.5 改用 `accent`（青铜绿），但其他页面（记录、趋势、我的）还在用 `color.pine`，所以保留别名指向 `accent`，避免改一堆文件。

### Q5: 里程碑 2 会改其他页面，会不会影响里程碑 1 的今天页？
**A**: 不会。每个里程碑只改指定的文件，改动互相独立。例如里程碑 2 只改 `records.tsx` 和 `trends.tsx`，不动 `today.tsx`。

### Q6: 截图用什么工具？
**A**: 开发时在浏览器里用开发者工具调整视口宽度（390px 或 360px），然后截图保存到 `artifacts/ui-v0.5/` 或对应版本目录。

### Q7: 测试照片在哪里？
**A**: `C:\Users\14360\Desktop\options\breakfast\` 和 `C:\Users\14360\Desktop\options\dinner\` 下有真实饮食照片，可以用来测试饮食分析功能（但这不是 UI 设计任务的必须步骤）。

### Q8: 我需要懂 AI 分析逻辑吗？
**A**: 不需要。你只需要知道：用户点"请求 AI 综合分析"按钮后，会弹窗询问，用户同意后发送数据到用户自己配置的 API，返回 Markdown 摘要。UI 层只负责显示摘要、显示加载状态、显示错误提示。

### Q9: 如果 typecheck 或测试失败怎么办？
**A**: 先看错误信息。常见问题：
- `Property 'xxx' does not exist on type`：可能改了 `theme.ts` 但忘了保留旧的颜色名（如 `pine`）
- 测试失败：可能改了组件的文字或结构，导致 Playwright 找不到元素。看测试代码 `tests/ui.spec.ts`，调整选择器或恢复必要的文字

### Q10: 我可以问你之前的设计决策吗？
**A**: 可以。你可以阅读 `docs/redesign-vision-v0.5.md` 了解 v0.5 的设计思路，或者直接问我"为什么 v0.5 去掉表盘？"之类的问题。

## 沟通建议

当你接到一个里程碑任务时，建议的沟通流程：

1. **确认理解**：读完规格文档后，用一两句话总结"这个里程碑要做什么"，确认我们理解一致
2. **提出问题**：如果规格有歧义，或者你有更好的设计想法，先问我再动手
3. **边做边报告**：改完一个文件后可以告诉我进度，不用等全部做完才说
4. **交付说明**：完成后告诉我：
   - 改了哪些文件
   - typecheck 和测试是否通过
   - 截图路径
   - 有没有新的设计决策（如果有，写在哪个文档里）

## 下一步

现在你已经了解了项目背景、文件结构、设计约束和工作流程。

**如果你准备好了**，回复"已了解，可以开始里程碑 2"，然后我会提供里程碑 2 的规格文档。

**如果你还有疑问**，列出来，我会逐一解答。
