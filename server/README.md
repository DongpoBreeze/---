# 健康管理分析网关

这是首版客户端使用的可选本地/自托管 AI 网关。网关只负责用户主动触发的饮食分析或综合总结；本地记录、规则反馈、导出和恢复不依赖它。未配置上游、访问令牌或单次成本上限时，`GET /api/health` 返回 `configured: false`，`POST /api/analyze` 返回结构化 `503`，不会伪造模型结果。

服务需要 Node.js 24（使用内置 `node:sqlite`），启动命令为：

```powershell
$env:SERVER_ACCESS_TOKEN = "local-development-token"
$env:MODEL_API_URL = "http://127.0.0.1:9000/v1/chat/completions"
$env:MODEL_API_KEY = "upstream-key"
$env:MODEL_NAME = "vision-model"
$env:MAX_REQUEST_COST_CNY = "0.50"
node server/index.mjs
```

默认仅监听 `127.0.0.1:8787`。可以设置 `HOST`、`PORT` 和 `HEALTH_DB_PATH`。`HOST` 只有在明确需要局域网访问时才应改为其他地址；生产上游 URL 必须使用 HTTPS，HTTP 只允许本机服务。

使用本机 Codex 的活动供应商可运行 `npm run server:codex`，固定模型 `gpt-6.1-sol`、思考强度 `max`，供应商凭据仅保留在进程内存。专用开发令牌与临时预算设置保存在忽略的 `server/data/local-codex.json`，客户端仅得到这个开发令牌；不支持把 Codex 的登录态或全局凭据直接交给客户端。当前支持活动供应商的 `env_key` 或 `experimental_bearer_token`。

该启动器固定监听本机，输出上限 8192 token；每个上游分析阶段最多等待 180 秒，每餐最多 3 个阶段。客户端保留约 545 秒的整餐分析生命周期，以容纳三个阶段和收尾余量。供应商价格未核实时，默认每次 10 元只是临时记账预留，不是账单保证。当前模型的合成 PNG、JPEG 均已有成功调用。此前图片 HTTP 400 是 JSON 模式输入标记缺失：供应商没有将 `instructions` 中的 JSON 算入输入校验，网关现已在实际 `input_text` 中添加 `JSON record:\n`。App 分析副本采用 JPEG，原媒体仍独立保存；合成成功不代表营养质量或延迟稳定性通过。

相同 128×128 PNG/JPEG 在修复前均复现同一校验错误，旧 JPEG 成功不能证明格式差异。修复后的 356 字节原 PNG 在一次 120 秒诊断上限下于 19.705 秒成功，此前一次默认 55 秒请求超时；新增同尺寸 JPEG 在默认 55 秒上限下于 17.975 秒成功。两次成功均返回 `unknown`、四营养字段 `null`。上述合成诊断阶段共 9 次调用；后续真实餐食照片及账本记录见 [开发记录](../docs/development.md)，不能沿用合成阶段次数作为当前总数。

## 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `SERVER_ACCESS_TOKEN` | 空 | 客户端 `Authorization: Bearer ...` 访问令牌；不写入日志或响应。 |
| `MODEL_API_URL` | 空 | 完整模型 URL。也接受 `MODEL_BASE_URL`，根据协议补上 `/chat/completions` 或 `/responses`。 |
| `MODEL_API_PROTOCOL` | `chat_completions` | `chat_completions` 或 `responses`；已有配置保持默认 Chat 协议。 |
| `MODEL_API_KEY` | 空 | 上游模型服务密钥。也接受 `MODEL_API_TOKEN`。 |
| `MODEL_NAME` | 空 | 上游模型名称。 |
| `MODEL_REASONING_EFFORT` | 空 | 可配置 `none/minimal/low/medium/high/xhigh/max`，原样交给上游，是否支持由供应商决定。 |
| `MODEL_STREAM` | `false` | 可选 `true/false`，仅支持 Responses；服务端读取 SSE，客户端仍接收完整 JSON。 |
| `MAX_REQUEST_COST_CNY` | 未配置即禁用 | 单次最大保守预留，必须显式配置且大于 0。 |
| `MONTHLY_BUDGET_CNY` | `300` | 本机当月总预算，包含 AI、固定成本、非 AI 成本和安全预留。 |
| `FIXED_MONTHLY_COST_CNY` | `0` | 月度固定成本预留。 |
| `NON_AI_MONTHLY_COST_CNY` | `0` | 流量/存储等非 AI 成本预留。 |
| `SAFETY_RESERVE_CNY` | `30` | 不开放给 AI 请求的安全预留。 |
| `INSTALLATION_DAILY_QUOTA` | `10` | 每个 `installationId` 每日请求上限，包含处理中和失败请求。 |
| `MAX_CONCURRENT_REQUESTS` | `4` | 全局并发上限。 |
| `MAX_CONCURRENT_PER_INSTALLATION` | `1` | 单安装并发上限。 |
| `MODEL_MAX_OUTPUT_TOKENS` | `1200` | 固定输出上限，范围 32-8192。 |
| `MAX_BODY_BYTES` | `8388608` | 请求体上限，包含内嵌图片 data URL。 |
| `MAX_PHOTO_BYTES` | `3145728` | 单张图片解码后大小上限。 |
| `MAX_PHOTOS` | `2` | 一次饮食分析最多照片数。 |
| `UPSTREAM_TIMEOUT_MS` | `180000` | 每个上游分析阶段的超时上限；单餐最多三个阶段。仅在收到完整响应并通过校验后回填结果。 |
| `BUDGET_TIMEZONE` | `Asia/Shanghai` | 每日/每月额度结算时区。 |
| `RESULT_CACHE_TTL_MS` | `600000` | 成功结果仅在内存中短暂缓存，重启后不恢复正文。 |
| `HEALTH_DB_PATH` | `server/health-compass.sqlite` | SQLite 额度账本路径。 |

可用 AI 预算 = `MONTHLY_BUDGET_CNY - FIXED_MONTHLY_COST_CNY - NON_AI_MONTHLY_COST_CNY - SAFETY_RESERVE_CNY`。所有金额使用整数微元保存，避免浮点误差。上游成功、失败、超时、客户端取消和模型格式错误均按 `MAX_REQUEST_COST_CNY` 保守计入；这可以牺牲额度换取不低估供应商费用。失败请求进入终态，重复使用同一 `requestId` 不会再次调用模型。

额度预留、每日配额、并发上限和请求指纹使用 SQLite `BEGIN IMMEDIATE` 事务。账本只保存安装 ID、请求 ID 的 HMAC 指纹、类型、状态、时间、额度和错误码，不保存原始请求、照片、摘要或模型文本。成功正文仅短暂保存在进程内存，最长由 `RESULT_CACHE_TTL_MS` 控制；成功请求在重启后返回 `410 result_expired`，不会重复调用模型。模型上游自身必须遵守照片和健康数据的保留策略。

## HTTP 协议

### `GET /api/health`

无需鉴权，响应不包含密钥：

```json
{
  "configured": true,
  "limits": {
    "monthlyBudgetCny": 300,
    "installationDailyQuota": 10,
    "maxRequestCostCny": 0.5,
    "aiBudgetCny": 270
  },
  "storage": "ready"
}
```

### `POST /api/analyze`

请求头：`Content-Type: application/json`、`Authorization: Bearer <SERVER_ACCESS_TOKEN>`。

请求体：

```json
{
  "requestId": "meal-2026-10-10-001",
  "installationId": "local-device-abc",
  "kind": "meal",
  "payload": {
    "mealType": "午餐",
    "title": "番茄鸡蛋面",
    "photos": ["data:image/jpeg;base64,..."]
  }
}
```

`kind` 只能是 `meal` 或 `summary`。饮食 `payload.photos` 可选，最多 `MAX_PHOTOS` 个真实 JPEG/PNG/WebP `data:image/...;base64,...` URL，服务端会校验图片魔数；综合总结不接收照片。其它字段保持客户端标准化记录，网关不会把供应商消息格式当作数据模型。

Responses 使用 `instructions`、`input_text/input_image`、`reasoning.effort`、`max_output_tokens`、`text.format=json_object`，同时设置 `store:false`；默认 `stream:false`，可通过 `MODEL_STREAM=true` 启用 SSE。`input_text` 的 `JSON record:\n` 前缀保证 JSON 模式标记位于输入中，兼容不检查 `instructions` 的供应商校验。只接受 completed 的 assistant output_text；reasoning 不作为正文。未完成、工具调用、拒绝或无效业务 JSON 返回错误。协议参照 [OpenAI Docs 的 Responses 接口](https://developers.openai.com/api/reference/resources/responses/methods/create)，自定义供应商的模型别名、推理级别和计费仍按实际服务验证。

流式读取使用 `eventsource-parser`，只在收到有效 `response.completed` 后校验和计算营养；临时文本、`[DONE]` 或流结束均不能替代完成事件。单事件缓冲上限 128 KiB、整条流上限 2 MiB，总等待时间仍受 `UPSTREAM_TIMEOUT_MS` 限制。只记录事件类型和时间，不保存 delta 或推理正文，不自动重连。参考 [OpenAI Docs 流式响应](https://developers.openai.com/api/docs/guides/streaming-responses)。

本机上游错误诊断只输出 HTTP 状态和固定分类/字段标签，不输出上游原始错误、输入、结果正文或凭据。`store:false` 是请求参数，不等于已经核实供应商数据保留政策。

`json_mode_input_missing` 专门表示上游要求输入包含“json”的 JSON 模式校验错误，不将其归因于图片编码。`upstream_gateway_timeout` 用于上游 HTTP 504/524，区别于本地计时器触发的 `upstream_timeout`。`scripts/diagnose-image.mjs` 使用合成灰色图片单独诊断；它不读取或上传用户照片，真实调用仍计入已有 SQLite 预算账本。

`scripts/test-real-food-image.mjs --app-copy --stream --live --timeout-ms=180000` 使用指定真实照片的 App Web 压缩副本进行一次诊断。`--live` 是显式调用开关，`--stream` 是受控流式对照，延长等待只影响诊断进程；本机 App 的默认超时和 Codex 全局配置不会改变。报告只保存图片大小、哈希、上游状态/时间与最终分析，不记录图片 base64 或凭据。

成功响应的 `analysis` 严格按类型区分：

饮食：

```json
{
  "analysis": {
    "status": "estimated",
    "foodName": "熟白米饭",
    "calories": { "min": 130, "max": 130 },
    "protein": { "min": 2.6, "max": 2.7 },
    "carbs": { "min": 28.1, "max": 28.2 },
    "fat": { "min": 0.2, "max": 0.3 },
    "assumptions": ["用户确认 100 g，全部吃完，无其他食物或油酱"],
    "advice": "保留实际份量记录。",
    "unresolved": []
  },
  "model": "vision-model",
  "createdAt": "2026-10-10T12:00:00.000Z"
}
```

营养计算使用已打包的 139 条 USDA SR Legacy 食材目录，包括原有 29 条和 110 条常见食材扩展。模型只返回受控食材 ID、候选标签、克数/摄入比例区间、疑问与建议；四项营养由 `shared/nutrition.mjs` 按每 100 g 数据计算，并附带数据库来源。不能匹配的成分会保留但不计入营养；部分范围标记为 approximate，完全未知时为 null。上例仅展示主要结果字段，实际响应还包含食材明细和完整来源。

无法可靠估算时使用 `status: "unknown"`，四个营养字段必须为 `null`，保留候选食材、未知重量/摄入比例及 `unresolved`；未知值不能写成 `0`。只有所有食材、重量、摄入比例、四项参考值和油酱覆盖均完整，且没有未解决疑问时，才返回 `estimated` 和四项范围。不把部分食材的小计显示为整餐摄入。数据契约见 [营养集成说明](../docs/nutrition-implementation.md)。

综合总结：

```json
{
  "analysis": { "text": "仅根据已记录内容整理的日常总结。" },
  "model": "vision-model",
  "createdAt": "2026-10-10T12:00:00.000Z"
}
```

常见错误均使用统一结构 `{ "error": { "code": "...", "message": "..." } }`：`401 unauthorized`、`409 request_in_progress/request_id_conflict`、`413 payload_too_large/photo_too_large`、`415 unsupported_media_type`、`429 monthly_budget_exhausted/daily_quota_exhausted/concurrency_limit`、`502 upstream_unavailable/invalid_model_response`、`503 server_not_configured`、`504 upstream_timeout`。失败请求保留客户端草稿；模型已经收到请求时不会释放额度，客户端应使用新的请求 ID 重试。

## 验证

```powershell
npm run test:server
```

测试使用本地 mock Chat Completions/Responses 服务，不发送真实健康数据，也不会消耗真实模型额度；覆盖配置 fail-closed、图片输入校验、严格分析 schema、幂等/指纹、内存缓存 TTL、SQLite 账本、预算预留并发、每日配额、失败计费、进程重启、崩溃恢复及本机 Codex 配置与凭据隔离。JSON 模式回归模拟供应商忽略 `instructions` 的校验，并区分缺少输入标记与图片格式错误。
