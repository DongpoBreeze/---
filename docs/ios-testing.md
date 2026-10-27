# iOS 测试版

更新：2026-10-23。iOS 复用当前 Expo / React Native 客户端，名称为“有节”，包标识 `com.healthcompass.app`，版本 `0.1.3`、iOS build number `1`。当前源码包含新的 BMI 布局和选填性别、年龄；已交付的 Android 0.1.3 包仍是此前快照。

## 本轮产物

[下载有节 0.1.3 iOS 未签名 IPA](../artifacts/ios-cloud-20261022T101837Z/ipa/youjie-0.1.3-1-ios-arm64-UNSIGNED.ipa)，11,649,723 字节，arm64 真机架构，最低 iOS **16.4**。SHA-256：

```text
79ea65f9e4d22bce1af4f247d0b47c1739b3ea2ec6ab2ee77b3cecd6666b4765
```

[macOS 云构建 39767746525](https://github.com/DongpoBreeze/health-compass/actions/runs/39767746525) 已成功；专用分支为 `codex/ios-unsigned-20261022t101837z`，提交 `2a9caf01c8b9de8a2e7ce4efbf64c744391b8837`。构建实际使用 Xcode 26.3、Swift 6.2.4、iPhoneOS SDK 26.2，完成 18/18 专项测试、类型检查、原生编译、链接和 IPA 审计。默认分支保持 `codex/health-recording-updates`。

下载后的 [独立验包结果](../artifacts/ios-cloud-20261022T101837Z/download-verification.json) 核对 SHA-256、76 个文件、13 个 Mach-O 二进制、arm64/iOS 平台、权限和原生 JS 哈希通过。未发现代码签名、描述文件、个人媒体或内置 Key。完整轮次、失败与修正见 [构建报告](../artifacts/ios-cloud-20261022T101837Z/report.md)；[IPA 清单](../artifacts/ios-cloud-20261022T101837Z/ipa/unsigned-ipa-manifest.json) 与安装包一同保存。尚未签名安装或进行 iPhone 真机功能测试。

## 本次使用方式

用户目前只有 Windows 和普通免费 Apple 账号，没有苹果设备。现有产物是云端 Mac 编译的 **arm64 真机用未签名 IPA**，取得 iPhone 后才可在 Windows 上签名安装。未签名 IPA 不能直接安装；生成 IPA、完成签名和真机测试分别验收。

没有苹果设备时，可另外构建 iOS 模拟器专用 `.app`，在云端 Mac 的 iOS 模拟器中运行，保存测试结果、截图或录屏。模拟器不需要 Apple 设备签名，不受免费真机签名的 7 天限制；当前真机 IPA 不适用于模拟器。项目的 `eas.json` 已有 `ios-simulator` 配置，模拟器原生包和运行测试尚未完成。Windows 本机可用安卓模拟器运行已有 Android APK。

Apple 的免费 Personal Team 设备签名有效期通常为 7 天，到期后需重新签名安装。Windows 可使用 [Sideloadly 官网](https://sideloadly.io/) 提供的工具；Apple 账号和验证码只在用户自己的签名工具中输入，不交给项目脚本、GitHub 或聊天。该路线不需要购买 Apple Developer Program，也不提供 TestFlight 分发。

本轮实际产物的 `MinimumOSVersion` 为 iOS 16.4，与当前 Expo 模块最低要求一致；后续构建仍以实际产物为准。

## 构建入口

- `npm run ios:check`：核对精确源码清单、iOS 配置及 `.easignore`。
- `npm run test:ios`：运行源码隔离与未签名打包专项离线测试。
- `npm run ios:prepare`：隔离客户端源码，检查 iOS 配置并实际导出 iOS JS/资源，保存 Windows 原生 prebuild 的真实限制。
- `npm run ios:package`：仅生成安全源码 ZIP；该 ZIP 不是 IPA。
- `npm run ios:unsigned`：在有 Xcode、CocoaPods 和锁定依赖的 Mac 上构建 Release arm64 App，再打包为带 `UNSIGNED` 名称和清单的 IPA。Windows 直接执行会明确报错。
- [GitHub 工作流](../.github/workflows/ios-unsigned.yml)：使用 macOS runner 执行同一套脚本。工作流不读取 Apple 证书、密码或 EAS 登录信息，不使用付费签名服务。

GitHub 构建仅操作专用分支，不合并默认分支。先通过精确清单进行稀疏检出，再复制到独立目录，安装 `package-lock.json` 锁定的依赖，执行检查、Expo prebuild、CocoaPods 和 Xcode 无签名构建。只上传 IPA、校验值、清单与必要构建日志。云构建的实际状态、提交和下载位置另随运行记录保存，不能将本地资源导出视为云编译成功。

当前工作流在 `macos-15` 显式选择 Xcode 26.3，并分别检查 RN 的 Xcode 最低值、iPhoneOS SDK 和锁定 SwiftPM 清单要求。Expo 的 Swift 包最低要求为 6.2，不能只用 RN 的 Xcode 16.1 最低值判断兼容性。

锁定的 `expo-modules-jsi@57.1.1` 还需 [Expo 官方 PR #51040](https://github.com/expo/expo/pull/51040) 的 Swift 6.2 兼容修复。构建脚本在独立依赖副本中精确回补 [SDK 57 官方提交](https://github.com/expo/expo/commit/bd2ade709029be3fbb44b6ba49bff32b02e66c81) 的三个生产文件：保留所有权注解的工厂方法、对应 Swift 调用者及内部 Sendable 包装。版本、原始文件和修复后哈希均先校验，漂移或部分应用时停止；不更改依赖版本或调用者已安装的 `node_modules`。来源与哈希进入构建报告及 IPA 清单。

## 数据与权限

- 只有已列出的客户端代码、品牌素材和两个公共营养 JSON 可进入构建；不上传 `.env`、开发网关、`server/data`、餐食验证照片、浏览器存储、历史备份或本地 `artifacts`。
- 构建子进程禁用 dotenv 和客户端环境变量注入，使用筛选后的系统环境；App 从空健康资料与未配置 AI 开始。公共默认 API URL 保留，Key、模型和强度由手机使用者配置。
- 原生 AI 配置继续使用 SecureStore 的 `WHEN_UNLOCKED_THIS_DEVICE_ONLY`；健康 ZIP 不含 Key。设备上曾保存的数据或 Keychain 内容与包内预置数据须分别判断。
- 相机仅用于餐食照片，相册用于选择照片或训练视频；不请求麦克风、Face ID、HealthKit 或跟踪权限。插件设置也会使后续 Android prebuild 不再默认加入录音权限，现有 APK 不变。
- 禁止任意明文网络加载；用户 AI 地址继续要求 HTTPS。公共依赖的 Required Reason API 隐私声明由实际原生依赖与 CocoaPods 归并，不凭文档猜测。

## Windows 安装

1. 下载本轮云构建产出的 `*-ios-arm64-UNSIGNED.ipa`，核对同目录 SHA-256 与 `unsigned-ipa-manifest.json`。
2. 从 Sideloadly 官网安装 Windows 版本，并按其说明安装所需的 Apple 设备驱动。
3. USB 连接 iPhone，在手机上信任电脑；按系统要求启用开发者模式。
4. 在 Sideloadly 中选择该 iPhone 和 IPA，使用自己的免费 Apple 账号完成签名和安装；设备信任提示按 iOS 实际要求处理。
5. 打开“有节”，检查首次资料与记录、设置自己的 AI 连接，测试照片分析、离线营养换算、训练、睡眠、导出与恢复。

七天签名到期后重新签名安装，保持相同应用标识和账号以利于保留数据；重要数据先从 App 导出备份。实际签名行为和升级保留效果需要在用户手机上验证，不把工具的功能说明当作本次实测。

## 当前证据与边界

初始本机准备证据位于 [iOS 准备记录](../artifacts/ios-preparation-20261022/ios-preparation-final/verification.json)：隔离源码类型检查、12 项专项测试、实际 iOS 平台 JS/资源导出与配置检查通过。客户端快照为 67 个文件，iOS JS 导出为 2,544,094 字节；19 项导出资源均为依赖字体。准备阶段源码 ZIP 为 [health-compass-ios-source.zip](../artifacts/ios-preparation-20261022/ios-preparation-final/health-compass-ios-source.zip)，SHA-256 为 `16b75fe18919a6f2ff58580d5024ac570658fe9c798c2394007e7fe7340c4411`。该 ZIP 记录修复前的构建脚本，不是安装包；实际云构建的 67 文件清单见 [云端源码清单](../artifacts/ios-cloud-20261022T101837Z/source-manifest-cloud.json)，已与实际构建报告逐项对应。

Windows 本机没有 Xcode；Expo CLI 跳过 iOS 原生 prebuild 的原始限制日志保留。IPA 由上述 macOS 云构建完成原生编译。Apple 免费签名、USB 安装、首次启动、相机权限、真机 AI、原生备份恢复和七天续签仍需独立设备验收。

参考：[Apple 开发者账号与 Personal Team 限制](https://developer.apple.com/support/compare-memberships/)、[Sideloadly](https://sideloadly.io/)、[Expo iOS 构建流程](https://docs.expo.dev/build-reference/ios-builds/)。2026-10-22 读取。
