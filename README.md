# 日常有节

“有节”是一款本地优先的日常健康记录 App：拍照或手填饮食、记录整次力量训练与睡眠，在本机算出营养、BMI 与趋势，需要时再交给自己配置的 AI 做识别和总结。记录默认只保存在设备上，可完整导出恢复。

https://github.com/user-attachments/assets/47463215-2006-49ff-99ef-32e74380905e



## 使用注意

- 在“设置 → AI 服务设置”填写自己的 HTTPS URL 和 Key，选择 Responses 或 Chat Completions 协议，获取模型并选择模型及推理强度；支持服务默认、上游选项和自定义强度。App 直接连接所选服务，开发网关只用于诊断。默认预填 `https://api.bblabu.ai/v1`，没有内置 Key、模型或选定强度。
- 
未配置 AI 时仍可记录、查看本地反馈和导出。外部 AI 的费用、额度和数据保留政策由所选供应商决定。


## Android 测试包

最新 Android 测试包为 **0.1.8 / code 9**，支持 Android 7.0（API 24）及以上、arm64-v8a / x86_64。包含按身高体重调整的餐食建议量、每次新建训练使用空白草稿，以及饮食营养、训练目标和睡眠选填项修复。

**下载：[GitHub Release v0.1.8](https://github.com/DongpoBreeze/youjie-health/releases/tag/v0.1.8)**，在页面 Assets 中下载 `health-compass-0.1.8-code9-arm64-v8a-x86_64.apk`，同页附 SHA-256 校验文件和构建清单。测试包沿用既有签名，可作为兼容更新安装；签名与设备验收范围见 [Android 测试说明](docs/android-testing.md)。

本版本通过类型检查、客户端 **368/368**、服务端 **80/80**、脚本 **150/150**；选填记录、睡眠时间、新训练及份量建议的手机/桌面 Web 专项测试通过。APK 源码对应、签名和包内配置检查通过。实体手机安装、原生相机和真实 AI 请求尚未验收。

## iOS 测试版

最近一次 iOS 构建为有节 **0.1.3** 未签名 IPA，build **1**，支持 **iOS 16.4+ / arm64**；它早于当前 Android 0.1.8，尚未上传到 GitHub Release。macOS 原生编译、18 项专项测试、下载后验包通过；包含当时的 BMI 布局和选填性别年龄（不含其后的四 Tab 导航与整次训练模板），包内不含电脑上的记录、照片、身高体重或 AI Key。

需在 Windows 使用 Sideloadly 和自己的 Apple 账号重签后安装；免费账号的签名通常有效 7 天。Apple 密码和验证码不交给项目。安装步骤、校验值、构建修复及尚未进行的 iPhone 设备测试见 [iOS 测试说明](docs/ios-testing.md)。

## 文档入口

[文档与验证索引](docs/README.md) 汇总现行规格、技术说明、设计参考和历史证据。主要约定见 [产品规格](docs/product-spec-v0.1.md)、[营养实现规格](docs/nutrition-implementation.md)、[AI 服务设置](docs/user-ai-settings.md)；实现结构见 [技术路线图](docs/technical-roadmap.md) 与 [P2 技术报告](docs/p2-meal-analysis-technical-report.md)。

50 餐人工营养真值仍待采集，不能用协议成功或模拟数据证明营养准确率。本地健康数据、真实 Key 和导出备份不应提交到 Git。
