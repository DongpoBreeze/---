# 健康罗盘

饮食、训练、睡眠的本地健康记录 App。基于 Expo React Native，Android / iOS 共用 TypeScript 代码，Web 用于开发预览。

## 本地启动

需要 Node.js 24 和 npm：

```powershell
npm install
npm run web
```

Android 测试包：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\android-build.ps1
```

最新 APK：[health-compass-arm64-v8a-release-20261016-045028.apk](artifacts/health-compass-arm64-v8a-release-20261016-045028.apk)，arm64、API 24+、测试签名，SHA-256：`ceeeb9dc259352f906ceb42f283aee46dfe6180c0b0250a49c2aab1c97c6b3a5`。包签名和包内配置扫描通过；尚未连接真机安装。构建、签名和包扫描记录见 [Android 测试说明](docs/android-testing.md)。

常用检查：

```powershell
npm run typecheck
npm test
npm run test:server
```

Web 流程测试先启动 `npm run web`，再运行 `npm run test:ui`；可用 `TEST_BASE_URL` 指定预览地址。

50 餐真实评估尚待人工采集真值；评估器及空模板用法见 [真值集工作说明](data/validation/README.md)。

## AI 服务设置

手机测试包默认预填 `https://api.bblabu.ai/v1` 作为 API 地址，但不内置任何 API Key、模型或推理强度。用户在“我的 → AI 服务设置”中填写自己的 Key，选择 Responses 或 Chat Completions 协议，向上游请求模型列表和模型能力，再自行选择模型及上游实际提供的推理强度。上游未提供强度元数据时使用服务默认值，不猜测或探测能力。

原生 Key 使用 SecureStore 保存，不进入健康 ZIP；浏览器预览只在当前页面会话保存配置。删除 AI 配置不影响健康记录，清除本机数据会一并清除 AI 配置。外部服务可能收费，数据保留策略依供应商而定；App 与各服务的兼容性仍需逐项验证。

当前测试：

```powershell
$env:TEST_AI_MOCK = '1'
$env:TEST_BASE_URL = 'http://localhost:8084'
npm run test:ui
```

## 产品与数据边界

- 饮食拍照是入口，同时提供训练、睡眠、趋势和每日 Markdown 总结。
- 原始照片、视频、记录、分析版本和 Markdown 均可导出与恢复；AI 结果不能覆盖原始数据。
- USDA 离线营养子集位于 `data/nutrition/usda-sr-legacy.json`，原始归档位于 `artifacts/usda/`，用于可复现导入和本地校正。
- 历史本机 Codex 网关和真实诊断报告仅用于开发排查，不是手机 App 的默认服务，也不包含在当前用户配置流程中。历史 PNG 400 原因已记录在 [开发记录](docs/development.md)。
- 2026-10-15 曾有一次真实餐前照片请求完整返回；2026-10-16 使用本机配置的 `gpt-6.1-sol/max` 对同一附图再次验证时，HTTP 200 后 180 秒未收到完整响应，按超时失败记录，未自动重试。本次回归不能用于准确率统计；50 餐人工真值评估仍为 pending。仍需真机验证、同条件稳定性测试及隐私保留策略核实。

产品规格见 [docs/product-spec-v0.1.md](docs/product-spec-v0.1.md)，当前用户 AI 设置约定见 [docs/user-ai-settings.md](docs/user-ai-settings.md)，开发验证见 [docs/development.md](docs/development.md)。

App 前端当前为 v0.4「夜间仪表」深色方案：今天页以 24 小时表盘为中心，页面与表单在 `src/ui/`，设计 token 在 `src/ui/theme.ts`，截图在 `artifacts/ui-v0.4/`。上一版浅色方案（v0.3）备份在 `artifacts/backup/ui-v0.3/`。旧版 Figwright 设计稿见 [设计规格](docs/app-design-v0.2.md)；重做前的 App.tsx 备份在 `artifacts/backup/App.v0.1.tsx.bak`。

本地数据和导出备份可能包含敏感健康信息。不要把真实数据、Key 或备份提交到 Git。
