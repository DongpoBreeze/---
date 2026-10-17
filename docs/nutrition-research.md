# 营养数据源与餐食估算调研

核查日期：2026-10-11。USDA 下载验证：对官方 ZIP URL 发起 HEAD，HTTP 200，`application/zip`，Content-Length `13,456,312` bytes；下载页将其列为 SR Legacy April 2018 JSON。目标是中文优先、Android/iOS、首版免费且可离线记录的健康 App。以下把“看懂照片/估份量”和“按克数查营养”分开；任何单张无称重照片都不能证明营养准确率。

## 结论

首版建议使用 **USDA FoodData Central 的离线基础食材子集**作为可迁移的每 100 g 参考库，照片模型只返回候选食物、份量区间和置信度，用户可纠正；无可靠份量时返回范围或“无法估算”。USDA 数据为 CC0，适合免费再分发，且离线不依赖 API key。对包装食品增加 Open Food Facts 条码查询（或定期下载并自建索引），但必须保留 ODbL 归属/共享条款并遵守限流。

Edamam 适合把用户确认的文字/配方做营养分析，不是照片识别服务，也不是零成本离线库：官方文档要求 `app_id`/`app_key`，并说明新配方/食材行会产生持续许可计费。LogMeal 可从图像识别食物并提供营养、数量/摄入估算，但官方页面将其作为商业 API，价格按方案/额度提供，未核实有可用于公开免费 App 的永久免费额度。不要把任一服务的图像输出当成称重事实。

## 官方证据与接口

### USDA FoodData Central

- API 指南：<https://fdc.nal.usda.gov/api-guide/>。页面实读结果：任何人可用，但每个请求需要 data.gov API key；普通 key 限制为每 IP 每小时 1000 次。`DEMO_KEY` 仅供探索，页面列明每 IP 每小时 30 次、每天 50 次。
- 许可：同一页面 Licensing 段写明数据不受版权保护，按 <https://creativecommons.org/publicdomain/zero/1.0/> 发布；无需许可，但 USDA 请求列出 FoodData Central 为来源。
- 下载：<https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_json_2018-04.zip>（USDA 页面列出的 SR Legacy JSON 下载）。离线导入后只需保留 `fdcId`、名称、食用部分/单位说明及 nutrient records。
- API 形状：查询/食品详情端点在指南的 API Spec 中定义；典型详情响应的营养记录包含 nutrient number/name、amount、unit。能量通常为 kcal（或 kJ），蛋白质、脂肪、碳水为 g；实现时按 nutrient ID/name 映射并记录原始单位，缺字段不得填 0。
- 优点：CC0、可批量离线、基础生鲜和原料覆盖稳定，适合米饭/土豆/豆腐/油等通用食材。
- 限制：SR Legacy 是美国数据，中文名称和中式混合菜覆盖有限；品牌/餐馆/家庭菜配方不保证存在。每 100 g 值不包含照片份量不确定性，烹调吸油、含水量和剩余量需单独建模。

### Open Food Facts

- API 文档：<https://openfoodfacts.github.io/openfoodfacts-server/api/>；实测 `GET https://world.openfoodfacts.org/api/v2/product/3017620422003.json`（自定义 `User-Agent: HealthCompassResearch/0.1 (research@example.invalid)`）返回 HTTP 200，产品 Nutella，`energy-kcal_100g=539`、`proteins_100g=6.3`、`carbohydrates_100g=57.5`、`fat_100g=30.9`。
- 数据许可：官方文档链接 <https://opendatacommons.org/licenses/odbl/1.0/> 并要求阅读 <https://world.openfoodfacts.org/terms-of-use>。再分发数据库需遵守 ODbL（归属及适用的相同许可/共享要求）；产品图片另有许可，不能默认把图片当作 CC0。
- 访问：读取产品不需账号，但必须使用能识别应用的自定义 User-Agent。官方限流为产品读取 15 req/min/IP、搜索 10 req/min/IP；超过可能封禁。超过几百个产品时官方要求下载 CSV/JSONL，或自建 Product Opener 实例。
- 优点：条码、品牌、包装营养标签和多语言名称；对中国进口/包装食品可能比 USDA 更有用。
- 限制：社区录入、字段缺失和质量差异大；它主要是包装产品库，不是中式家常混合菜或熟食份量库；ODbL 合规会增加离线再分发和衍生数据库的法律工作。在线 API 不应从手机端无缓存地高频搜索。

### Edamam Nutrition Analysis API

- 官方文档：<https://developer.edamam.com/edamam-docs-nutrition-api>。页面说明 base URL `https://api.edamam.com`，Nutrition Analysis API 对非结构化食材/配方文本做实体、数量和营养计算，并可处理烹调相关调整；列出的 cuisine types 包含 Chinese。
- 认证与成本证据：文档要求 `app_id` 与 `app_key`；未提供凭据的实测 `POST https://api.edamam.com/api/nutrition-details?app_id=demo&app_key=demo` 返回 HTTP 401。文档还写明每个新分析的 recipe/ingredient line 会产生月度 licensing fee，ETag 仅避免重复计费，不等于免费额度。
- 适用范围：用户确认“100 g 米饭、1 汤匙油”等文本后做配方合计；不读取照片、不保证中国家常菜名称匹配，不适合作为离线基础库。正式接入前必须核对当前开发者计划、商业再分发权和预算。

### LogMeal Food AI Engine

- 官方能力页：<https://logmeal.com/solutions/food-ai-engine/>；页面描述开发者 API 可从 food images 输出 recognition、nutrition、quantity estimation、intake monitoring 等结构化结果。
- 价格/授权：<https://logmeal.com/pricing/> 可访问，页面展示按方案、月度 credits、每请求消耗 credit、最大终端用户和每日图片数等商业计费字段；具体价格/额度由页面动态加载或销售方案返回。本次未注册、未上传图片、未把它列为免费承诺。
- 适用范围：候选食物识别和数量估计能力与本 App 的拍照入口匹配，但服务端上传照片、供应商保留/处理政策、中文菜覆盖、误差和免费额度必须在采购前单独核对。图像输出仍是估算，应保存模型/服务版本、范围和用户纠正。

## 中国食物成分资料

中国常见的《中国食物成分表》版本和商业数据库在网页上容易找到转载，但本次没有核实到一个同时具备明确免费商业再分发许可、稳定官方 API/下载和版本完整性的公开来源，因此不建议直接抓取第三方转载。可在后续取得授权或逐条人工核验后，增加中文别名映射层；在此之前用 USDA 通用原料 + 用户手动营养值，并标记来源和未知项。日本食品成分表（文部科学省标准成分表）可作为研究参考，但其日本食材/单位和再分发条件仍需逐版核对，不能代替中国数据。

## 落地数据约定

1. 数据层保存 `source`（`usda`/`off`/`user`/`vision`）、原始 ID、版本/抓取日期、每 100 g 的 kcal/protein/carbohydrate/fat 及单位。
2. 视觉层只产生候选食物、估计克数上下界、置信度和假设（餐前/餐后、容器参考物等）；数据库层按克数线性换算，混合菜按确认的配料或手动总量计算。
3. 任一营养字段缺失保持 `null`/unknown；当天汇总只累计有有效数值的记录。用户纠正后保留原始视觉结果和新分析版本。
4. 离线优先：把经过人工筛选的 USDA 子集打包在 App 或可导出的数据库中；在线 USDA/OFF 仅用于更新或条码补充。OFF 生产 API 请求应经服务端缓存/限流，不把密钥或高频搜索放在客户端。
5. 评估必须使用称重和配方真值样本，报告 kcal/macros 误差、区间覆盖率、无法估算比例和中式混合菜分层结果；仅凭一张照片得到“看起来合理”的数字不能证明准确率。

## 未决风险

- USDA 2018 SR Legacy 下载版本较旧，需在发布前核对是否使用更新下载并记录版本；CC0 只解决数据版权，不解决模型、隐私或医疗建议责任。
- OFF 的 ODbL 归属/衍生数据库义务和图片许可需由发布者审阅；数据质量和中国商品覆盖随社区变化。
- Edamam 当前免费计划、许可费和商业再分发条款未在本次匿名访问中确认；不能以 demo key 或 401 结果推导价格。
- LogMeal 的实际报价、照片保留、区域可用性、中文/中餐识别质量和免费额度未核实；接入前需书面确认并完成隐私评估。
- 没有任何上述数据库能从单张无标尺照片可靠推出克数。首版应允许用户选择份量/参考物、修改食物和拒绝保存不确定估算。




