# 健康罗盘

饮食、训练、睡眠的本地健康记录 App，使用 Expo、React Native 和 TypeScript。Android / iOS 共用客户端，Web 用于开发预览；当前界面采用方案 A。

## 本地启动

需要 Node.js 24 和 npm：

```powershell
npm install
npm run dev
```

固定打开 **http://localhost:8081/**。该地址也是本机健康记录和 AI 配置的存储来源；继续使用同一浏览器和地址，避免切换主机名或端口后进入另一份本地数据。启动命令已处理 Windows 的 IPv4 监听问题。

## 使用

- 在“我的 → AI 服务设置”填写自己的 HTTPS URL 和 Key，选择 Responses 或 Chat Completions 协议，获取模型并选择模型及推理强度；支持服务默认、上游选项和自定义强度。App 直接连接所选服务，开发网关只用于诊断。默认预填 `https://api.bblabu.ai/v1`，没有内置 Key、模型或选定强度。
- 原生配置使用 SecureStore，Web 使用独立 IndexedDB，写入提交后才提示保存成功；同一浏览器、同一来源重开后恢复。健康 ZIP 不包含 AI 连接配置或 Key。旧版仅存于内存且已丢失的配置需重新填写一次。
- 饮食可手动记录，也可追加或一次多选餐前照片，同餐最多 4 张；旧餐后照片继续兼容。识别后在独立页面核对菜品、每 100 g 营养与食用量，确认后同步餐名和四项营养。本地默认量可修改或清空，属于一般成人参考估计，不能视为照片称重；旧餐保存量不随新资料重算。
- “我的 → 外观”支持跟随系统、浅色和暗色，选择在本机保存。原始媒体、健康记录、分析版本与 Markdown 总结可导出恢复；外观偏好独立于健康备份。

未配置 AI 时仍可记录、查看本地反馈和导出。外部 AI 的费用、额度和数据保留政策由所选供应商决定。

## 检查

```powershell
npm run typecheck
npm test
npm run test:server
npm run test:scripts
```

`test:scripts` 补充诊断、实验与评估工具的专项检查，每项上限 30 秒。最新检查为 132/132 通过；历史试验仍冻结各自的 90 秒请求参数，与当前 App 默认 120 秒相互独立。修复与验证记录见 [脚本说明](scripts/README.md) 和 [维护审查](docs/maintenance-review.md)。

Web 流程先启动固定预览，在另一终端运行 `npm run test:ui`。模拟 AI 流程使用：

```powershell
$env:TEST_BASE_URL = 'http://localhost:8081'
$env:TEST_AI_MOCK = '1'
npm run test:ui
```

未设置 `TEST_AI_MOCK=1` 时运行本地记录与布局用例；设置为 `1` 时运行模拟供应商用例。既有验证结果、分轮失败与补跑证据见 [文档与验证索引](docs/README.md)，不代表本次重新执行全量 Web 或真实 AI 检查。

## Android 测试包

最新已构建 APK：[health-compass-arm64-v8a-x86_64-release-20261019-171837.apk](artifacts/health-compass-arm64-v8a-x86_64-release-20261019-171837.apk)，版本 **0.1.1 / code 2**，支持 API 24+、arm64-v8a / x86_64。构建、签名、安装方法和模拟器验证范围见 [Android 测试说明](docs/android-testing.md)。

该包包含 10 月 19 日的源码快照与方案 A 初次集成，**不包含 10 月 20～21 日的独立识别页、最新表单、暗色、多图、Web 配置持久化和默认食用量等工作树更新**。Android 实体手机和 iOS 尚未验收。

## 文档入口

[文档与验证索引](docs/README.md) 汇总现行规格、技术说明、设计参考和历史证据。主要约定见 [产品规格](docs/product-spec-v0.1.md)、[营养实现规格](docs/nutrition-implementation.md)、[AI 服务设置](docs/user-ai-settings.md)；实现结构见 [技术路线图](docs/technical-roadmap.md) 与 [P2 技术报告](docs/p2-meal-analysis-technical-report.md)。

50 餐人工营养真值仍待采集，不能用协议成功或模拟数据证明营养准确率。本地健康数据、真实 Key 和导出备份不应提交到 Git。
