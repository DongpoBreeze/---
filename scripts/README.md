# 开发与验证脚本

App 的运行时代码在 `src/`、`shared/` 和 `App.tsx`。本目录用于构建、诊断、离线评估及可追溯的历史试验；手机 App 不依赖这些命令运行。

## 检查入口

在项目根目录运行：

```powershell
npm run typecheck
npm test
npm run test:server
npm run test:scripts
```

前三项分别检查类型、App 核心逻辑和诊断服务。`test:scripts` 覆盖本目录全部 `*.test.mjs`，使用 `tsx` 加载被引用的 TypeScript；每项 Node 测试设置 30 秒上限，避免前置失败后无限等待。这个限制只作用于离线测试，不修改 App 或真实模型请求的等待时间。部分图片处理测试会启动隔离浏览器，Windows 使用本机 Edge。

**最新脚本专项：132/132 通过。** 普通 App 默认超时测试使用当前 120 秒配置；每个历史实验继续显式传入并验证其冻结的 90 秒参数，历史源码指纹仅约束对应真实实验的复现，不再阻止隔离的合成离线测试。修复前的 131 项失败轮次仍保存在 `artifacts/project-maintenance-20261021/script-tests.log`，不覆盖或改写历史结果。

## 按用途查找

| 用途 | 入口与配套模块 | 状态与边界 |
|---|---|---|
| 本地开发预览 | `start-local-preview.mjs` | `npm run web:codex` 的诊断入口；普通 App 使用 `npm run dev`，固定 `http://localhost:8081/` |
| Android 构建 | `android-build.ps1`、`prepare-android.ps1`、`autolinking-ascii.mjs` | 构建步骤和设备验证范围见 [Android 说明](../docs/android-testing.md) |
| 营养数据与离线评估 | `import-usda.mjs`、`evaluate-meal-dataset.mjs` | USDA 用于旧记录兼容；评估器不调用模型，缺少真值时保留待评估状态 |
| 单图及批次诊断 | `test-meal-frontend.mjs`、`test-real-food-image.mjs`、`batch-real-food-image.mjs`、`capture-app-food-image.mjs` | 按各自协议和冻结输入运行；保存请求记录，不覆盖餐食原始输入 |
| 请求账本与报告 | `real-meal-test-ledger.mjs`、`meal-comparison.mjs`、`build-real-meal-comparison.mjs`、`build-meal-ab-report.mjs` | 保留历史请求和失败；报告不替代人工营养真值 |
| 历史对照与速度试验 | `meal-ab-*`、`meal-latency-*`、`meal-effort-speed-trial.*`、`meal-high-nutrition-comparison.*`、`meal-multidish-speed-trial.*` | 保留原路径，以免破坏源码指纹和报告引用；不是当前 App 的调用入口 |
| 早期网关排查 | `test-local-codex.mjs`、`diagnose-image.mjs`、`synthetic-image.mjs` | 用于复现协议和图片异常，网关不是手机 App 的固定后端 |

真实调用属于独立操作，不由上述离线测试命令发起。各诊断入口的请求策略不同；需要调用上游的命令应先核对源码中的参数、冻结输入和账本限制，不因文件名带有 `test` 就当作无成本单测。不要把供应商凭据写入脚本、报告或 APK。

## 产物与复现

- 当前规格从[文档索引](../docs/README.md)进入，历史运行结果从[开发记录](../docs/development.md)查找。
- `artifacts/` 被 Git 忽略，但不等于可以整体删除。真实响应、失败 trace、冻结照片和请求账本可能是唯一证据。
- `server/usda-data.test.mjs` 依赖 `artifacts/usda/` 的原始 USDA ZIP；部分历史脚本测试还依赖以前冻结的图片和 manifest。全新检出后的复现条件尚未完全自足。
- 本轮整理保留旧工具及其冻结检查；后续应将普通离线测试改为临时合成 fixture，将历史实验的复现检查单独运行。
