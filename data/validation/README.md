# 50 餐人工真值集工作说明

本目录只放离线评估所需的空白结构和合成验算数据。`meal-ground-truth-template.json` 有 50 个待填写样本，所有照片引用、人工标签、营养数值、模型预测和请求账本都留空；它不是已经完成的评估结果。不得把用户凭据、访问令牌、原始照片或可回溯到个人的路径写入仓库。

## 样本招募与记录

招募前为每餐生成一个不可识别的 `mealId`，并取得照片和称重记录的使用同意。`sampleType` 用 `single-item`、`mixed-dish`、`Chinese-bento` 标记主要餐食形态；遮挡、容器、低光是可重叠的采集条件，用 `capture.tags` 标记，例如 `occlusion`、`container`、`low-light`。实际分布应按采集情况填写，而不是凭空补齐标签。

| 场景 | 记录重点 |
| --- | --- |
| 单品 | 能否从餐前图确认一个主要食材、重量和烹调方式；记录是否有油、酱料或配菜。 |
| 混合菜 | 分别称量可分辨的主要食材；无法拆分时记录复合菜名称与配方来源，不把猜测写成食材真值。 |
| 中式盒饭 | 记录盒内各格、米饭/主菜/配菜和容器皮重；同一盒饭保留整餐 `mealId`。 |
| 遮挡 | 在 `capture.tags` 标记遮挡区域和可见范围；只确认人工能从实物、配方或称重记录得到的内容。 |
| 容器 | 记录容器类型、是否称皮重、尺寸或容量依据；容器信息不能替代食物重量。 |
| 低光 | 记录光照条件和照片质量；不因画面暗而删除样本，无法确认的字段保持 `null`。 |

每餐至少采集餐前和餐后照片引用、餐前/餐后/剩余重量（克）以及人工确认的摄入比例。照片引用使用受控存储中的匿名文件标识，例如 `evidence/<opaque-id>/before.jpg`；提交前检查引用不含姓名、账号、设备备份路径或凭据。没有餐后照片或重量时写 `null` 并在 `notes` 说明原因，不用估计值填补。

## 字段约定

- `capture.beforePhotoRef`、`capture.afterPhotoRef`：照片的匿名引用，不能内嵌图片或本机绝对路径。
- `groundTruth.ingredients`：人工确认的食材对象，格式为 `{ "name": 确认名称, "major": 是否主要食材, "aliases": 人工认可的同义名数组 }`。`major: true` 才进入“主要食材识别率”；`major: false` 用于已确认的次要食材。未确认食材写入 `notes` 待复核，不作为真值。可以另记每种食材的 `edibleWeightBeforeG`、`edibleWeightLeftG`、`consumedWeightG` 和来源，油、酱料也应称重。
- `groundTruth.cookingMethods`：对象记录 `ingredientName`、`method` 和 `sourceLabel`。`method` 按实际记录填写，如 `steamed`、`boiled`、`stir-fried`、`deep-fried`、`baked`、`raw`、`braised`、`unknown`。复合菜可有多个对象；不能从外观推断时使用 `unknown`。
- `groundTruth.weightsG`：记录餐前、餐后、剩余和可食部分重量，并注明 `measurementMethod`（秤、包装标示、配方换算等）。
- `groundTruth.intakeRatio`：人工确认的 0–1 摄入比例；若由重量计算，应保留原始重量，避免把四舍五入结果当原始测量。
- `groundTruth.nutrition`：按整餐实际摄入量记录 kcal、蛋白质、碳水、脂肪和钠；`sourceLabel` 标注称重配方、营养标签、食物成分表或其他可复核来源，无法核实的数值为 `null`。
- `sourceLabels`：记录招募来源、授权状态、标注者和数据分层等标签。标签只能描述真实来源，不能用来填充缺失真值。
- `prediction`：回填模型原始估计和 `modelVersion`。模型主要食材写入 `ingredients`；热量点估值写入 `calorieEstimateKcal`，区间写入 `calorieIntervalKcal.min/max`。模型明确无法估算时设置 `unableToEstimate: true` 并说明 `unableReason`。全空字段对象表示模型输出尚未记录；完全没有预测时也可用 `null`。只有 `ingredients` 明确记录为数组（包括空数组）后才参与食材指标。
- `requestLedger`：`stages` 的每项记录 `stage`、非负整数 `requestCount`、`latencyMs` 和可选 `status`。阶段名可用 `preprocess`、`vision`、`nutrition`、`retry` 等；本地处理记 0 次，所有实际远端请求（含失败、取消、重试）均计入。`totalRequests` 必须等于各阶段请求数之和；`totalLatencyMs` 是从本餐首次发出请求到最终完成/失败的实际端到端耗时，包含重试等待，不以阶段耗时相加替代。缺失账本不能视为零次请求或通过预算检查。

## 统计口径

- 主要食材识别率是按人工确认的主要食材计算的召回率：命中数 ÷ 主要真值食材数。食材名称按空白和大小写归一；只有人工明确填写的 `aliases` 作为同义名，不自动模糊匹配。预测标签对同一个主要真值最多计一次。
- 热量区间覆盖率是区间包含人工 kcal 真值的餐数 ÷ 同时有有效 kcal 真值、预测、`unableToEstimate: false` 和有效区间的餐数。端点包含在区间内；模型明确无法估算的样本单独计入无法估算率，跳过区间覆盖率分母。
- 无法估算率是显式 `unableToEstimate` 为 `true` 的预测餐数 ÷ 有明确无法估算状态的预测餐数。缺少预测或状态时跳过并报告缺失。
- 平均延迟是具有完整请求账本和 `totalLatencyMs` 的餐的端到端耗时算术平均值。总请求数从各阶段请求数相加校验；账本不完整时不提供完整总数或最大每餐请求数。已知请求数下界若已超限仍判超限。
- 零个可评估样本时指标返回 `null`，而不是 0%。样本、标签或阶段账本缺失会令总状态保持 `incomplete`；超过请求限制或数据矛盾会令状态为 `invalid`。

计划验收阈值由评估器以 `acceptance` 字段单独报告：主要食材召回率至少 0.80，热量区间覆盖率至少 0.80，无法估算率不超过 0.20，每餐请求不超过 3 次且 50 餐总请求不超过 75 次。只有恰好 50 条 `real-evaluation` 样本的相关分母和账本完整时，该项才会给出 `passed` 或 `failed`；空白模板、合成 fixture 和相关数据缺失均为 `pending`。所有条件通过才整体 `passed`，任一完整条件失败则整体 `failed`，否则 `pending`；校验问题也会阻止整体通过。即使已知请求下界超限，账本不完整时验收条件仍为 `pending`，原始预算状态会单独保留 `exceeded` 供核查。

人工复核建议由两名标注者独立填写食材、烹调方式和重量，再由第三人处理分歧；每次修改保留变更时间和理由。只有已经有真值和预测的样本才进入相应指标分母。没有真值或预测的样本由评估器报告为缺失并跳过，不能算作正确。

## 离线评估

在仓库根目录运行：

```text
node scripts/evaluate-meal-dataset.mjs data/validation/meal-ground-truth-template.json
node scripts/evaluate-meal-dataset.mjs --fixture
node scripts/evaluate-meal-dataset.mjs data/validation/meal-ground-truth-template.json --json
node --test scripts/evaluate-meal-dataset.test.mjs
```

`--fixture` 使用脚本内明确标为 `synthetic-fixture` 的微型数据，只验证算法和预算校验，输出不得当作产品准确率。评估器报告主要食材识别率、热量区间真值覆盖率、无法估算率、最大单餐请求数、总请求预算状态和平均延迟，并逐项列出缺失真值/预测/账本。空白模板预期大部分指标为 `null` 或 `incomplete`，这是待采集状态，不是通过。

退出码：`0` 表示真实完整数据满足计划阈值，或使用 `--fixture` 时合成算法断言通过；`1` 表示输入无效、原始预算超限或完整验收条件失败；`2` 表示数据不完整或验收待定。直接运行空白模板预期返回 `2`。评估器仅检查数值结构和统计口径，不会读取照片或独立验证人工标签的真实性。
