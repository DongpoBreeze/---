# 文档与验证索引

整理日期：2026-10-27。基本使用与检查命令见 [项目 README](../README.md)。

## 现行约定

| 阅读目的 | 文档 | 范围 |
| --- | --- | --- |
| 产品范围与验收 | [首版产品规格](product-spec-v0.1.md) | 三模块、选填性别年龄、BMI 与推荐目标、数据归属、隐私、A-01～A-22 验收要求。定义目标，不表示已全部通过。 |
| 菜品、每 100 g 营养与食用量 | [营养实现规格](nutrition-implementation.md) | 最小 JSON、默认参考量、用户修改、确认同步、旧数据与备份兼容。 |
| AI 连接与持久化 | [用户 AI 设置](user-ai-settings.md) | 用户直连、模型与自定义强度、SecureStore / IndexedDB、保存失败及凭据边界。 |
| 实现顺序和发布条件 | [技术路线图](technical-roadmap.md) | P0～P6 依赖、接口与阶段验收。 |
| 餐食链路的代码落点 | [P2 技术报告](p2-meal-analysis-technical-report.md) | 多图输入、请求、校验、复核、本地换算、版本和备份。 |
| 当前视觉方向 | [方案 A 设计约定](ui-design-a.md) | 24 格节律矩阵、四个 Tab、浅暗主题及设计参考。 |
| 构建与设备验证 | [Android 测试说明](android-testing.md) | 最新 APK 的源码边界、构建命令、签名和限定的模拟器结果。 |
| iPhone 编译与 Windows 安装 | [iOS 测试说明](ios-testing.md) | 隔离源码、macOS 未签名 IPA 构建、用户自行签名及设备验收边界。 |
| 开发和诊断工具 | [脚本说明](../scripts/README.md) | 脚本分类、专项检查、历史冻结及实验约束。 |
| 本次维护发现 | [维护审查](maintenance-review.md) | 文件整理、代码检查、专项测试结果及后续建议。 |

当前源码行为以这些规格和实现为准；带日期的测试记录只描述当时的快照、模型和设备。旧记录中的 55 / 90 秒等待、页面内存配置、手动采用参考量等属于历史阶段：当前餐食分析每阶段最多等待 180 秒，每日总结整体最多等待 180 秒；Web 配置使用独立 IndexedDB。识别页根据 AI 给出的本餐菜品份额及营养参考，在本地换算可编辑食用量。最新 Android **0.1.8 / code 9** 已于 2026-10-27 构建，并已上传为 [GitHub 预发布版 v0.1.8](https://github.com/DongpoBreeze/health-compass/releases/tag/v0.1.8)；包校验、选填记录回归及设备验收边界见 [Android 说明](android-testing.md)。此前的 [iOS 0.1.3 / build 1 未签名包](ios-testing.md) 保留原有范围；本轮未构建 iOS。

## 验证记录与原始证据

下表各行只描述对应轮次的结果；新增构建不代表重新执行全部历史测试。完整失败、修正和补跑经过保留在各自记录中，不同轮次的通过项不能相加声称为单轮全通过。

| 主题 | 记录入口 | 证据与边界 |
| --- | --- | --- |
| Android 0.1.8 选填记录与份量建议 | [最新 Android 测试包](android-testing.md#latest-local-build-2026-10-27-018) | Release 双 ABI、签名、56 个打包源码映射及静态数据隔离通过；类型检查、客户端 368/368、服务端 80/80、脚本 150/150；手机/桌面 Web 选填项 8/8、睡眠控件 4/4、新训练/份量建议 6/6。实体手机、原生相机与真实 AI 未验收。 |
| Android 0.1.5 当前工作树测试包 | [本地 Android APK](android-testing.md#latest-local-build-2026-10-26-015) | 双 ABI Release、v2 签名、55 个项目源码映射、静态数据隔离、typecheck、client 345/345、server 80/80、scripts 150/150；Web 流程 18 项分轮通过，无实体手机/原生 AI 验收，未上传远程。 |
| Android 0.1.4 优化后代码 | [最新 Android 测试包](android-testing.md#latest-integrated-build-2026-10-23-014) | 双 ABI Release、签名/源码/名称图标及个人数据隔离通过；本轮类型检查、客户端 342/342、服务端 80/80、工具 150/150；模拟器范围见构建记录，无实体手机或本轮真实 AI 验收。 |
| iOS 0.1.3 / build 1 未签名 IPA | [iOS 测试说明](ios-testing.md) | 云端 18/18 专项、类型检查、Xcode 26.3 原生编译和下载后验包通过；67 文件源码对应、76 个包文件与 13 个原生二进制通过核对。Windows 用户自行重签，iPhone 设备测试未做。 |
| 选填性别年龄与年龄适用判断 | [开发记录](development.md#profile-demographics) | 类型检查、客户端 331/331、相关单元 46/46、网页 10/10；选填/清空、分组边界、保存恢复及备餐参考限制通过，无真实 AI、原生或儿童/老年专门模型验收。 |
| BMI、阶段体重与热量建议 | [开发记录](development.md#profile-health) | 本地计算、自动/手动来源及备份冲突；首轮客户端 319/319、服务端 80/80。参考图布局更新的定向单元 18/18、完整身体参考网页 6/6，含四档公斤区间、分层标记、深浅主题和保存恢复；8081 正常，Android 范围单独记录。 |
| 默认食用量、名称与四项营养同步 | [开发记录](development.md#estimated-portions) | 该功能集成时核心 277/277、服务端 80/80、类型检查通过。Web 的 42 个不同场景/视口组合跨 7 轮各有通过结果；[原始目录](../artifacts/meal-estimated-portion-web-20261021/) 保留初轮失败和定向补跑。 |
| 多餐前图及配置持久化 | [开发记录](development.md#multi-photo-settings) | 多图与受影响流程的 18 个组合分轮通过；[多图证据](../artifacts/meal-before-photos-settings-web-20261021/)。设置场景、事务失败与完整关闭浏览器后恢复的证据详见 [AI 设置验证](user-ai-settings.md#verification-on-2026-10-21)。 |
| 固定 8081 来源重开恢复 | [AI 设置复查](user-ai-settings.md#same-origin-reopen-recheck-2026-10-21) | 长预算回归一轮 2/2；[结果 JSON](../artifacts/ai-reopen-8081-20261020T180840Z/restart-verification-long.json)。早期整条用例超时保留，增加的是测试预算，App 上限未改。 |
| 暗色模式与预览连接 | [开发记录](development.md#appearance) | 主题切换、保存、表单与分析状态的 Web 模拟验证；IPv4 排查单独保留。没有因此完成原生系统栏或用户当前预览窗口的验收。 |
| 方案 A 初次集成 | [设计说明中的历史验证](ui-design-a.md#initial-validation) | 2026-10-18 的 Web 流程、布局及截图；已进入 10 月 19 日 APK。后续暗色和餐食交互变化另见开发记录。 |
| 最小餐食 JSON 的真实首轮 | [开发记录](development.md#frontend-protocol) | [三图报告](../artifacts/meal-frontend-20261018-high-v1/report.md)：固定 `gpt-6.1-sol/high` 的三次首轮均完整有效；没有人工营养真值，未验证长期稳定性。 |
| 旧提示、速度与失败诊断 | [开发历史](development.md#latency-history) | [22 次试验结论](../artifacts/meal-latency-20261018-90s-v1/conclusion.md) 使用当时的 90 秒、冻结源码及旧提示，不是现行配置的速度保证。 |
| Android 0.1.3 身体参考与当前名称/图标 | [历史 Android 包](android-testing.md#previous-integrated-build-2026-10-22) | 签名、源码、名称图标与凭据模式扫描通过；离线 x86_64 模拟器身体参考、保存和冷启动恢复通过。其后参考图布局未进入此历史包；无实体手机/iOS 验收。 |
| Android 0.1.2 当前 UI | [历史 UI 包](android-testing.md#earlier-ui-build-2026-10-22-012) | 隔离 x86_64 模拟器覆盖 0.1.1 后保留一条测试餐食，新版手动营养保存重开、训练/睡眠表单和系统暗色启动通过；未做该轮原生真实 AI、相机、备份恢复或实体设备验收。 |
| Android 0.1.1 | [Android 运行范围](android-testing.md#native-runtime-scope) | 一个 x86_64 模拟器、一次真实 Responses 分析、离线 150 g 换算、同 APK 覆盖安装与原生导出。原生恢复、arm64 实体手机和 iOS 未验收。 |

完整开发时间线及 A-01～A-22 的实现/验证边界集中在 [开发记录](development.md)。Android 各版包身份、历史签名与设备结果集中在 [Android 测试说明](android-testing.md)。新测试应保存自己的运行结果，不改写旧冻结清单、账本或失败产物。

## 历史调研与待完成评估

| 文档 | 用途与时点 |
| --- | --- |
| [营养数据源调研](nutrition-research.md) | 2026-10-11 的 USDA、Open Food Facts、Edamam 和 LogMeal 来源/许可研究；早期方案建议不再定义新的生产协议。 |
| [营养评估记录](nutrition-evaluation.md) | 早期 USDA 及真实照片诊断，保留当时未知值、失败和独立账本口径。 |
| [50 餐真值集工作说明](../data/validation/README.md) | 人工配方、称重与标签采集，以及离线评估器用法；当前为空模板，准确率仍待验。 |
| [移动测试工具调研](mobile-testing-tools-research.md) | 2026-10-11 的工具选型和建议；工具安装、ABI 与设备状态需要结合后续 Android 记录阅读。 |

尚缺代表性供应商与营养真值评估、Android/iPhone 实体设备验收、原生备份恢复及大数据量验证。Web 模拟交互通过、单次真实返回和营养算式正确分别证明不同事项，均不能替代这些验收。

本次维护确认的餐食分析草稿、已保存餐食重分析及训练视频删除恢复问题已修复，复现、修复和回归范围集中在 [维护审查](maintenance-review.md)。最新训练模板和可选睡眠质量的行为及验证见 [开发记录](development.md)；规格要求仍不能读作全部平台验收保证。
