#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareTrial, normalizeAnalysis, sourceStage } from './meal-ab-core.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const outputDir = resolve(process.argv[2] ?? join(root, 'artifacts', 'meal-ab-20261018-10-v1'));
const readJson = async (name) => JSON.parse(await readFile(join(outputDir, name), 'utf8'));
const stageAnalysis = (record, stage) => stage?.analysis ?? record?.analysis ?? null;
const stageView = (record, firstPass = false) => {
  const stage = sourceStage(record, firstPass);
  if (!stage) return null;
  return {
    analysis: normalizeAnalysis(stageAnalysis(record, stage), stage.recognition),
    stage: stage.stage,
    attemptId: stage.attemptId,
    status: stage.status,
    providerCompleted: stage.providerCompleted,
    accepted: stage.accepted,
    httpStatus: stage.httpStatus,
    errorCode: stage.errorCode,
    errorName: stage.errorName,
    usage: stage.usage ?? null,
    rawArtifact: stage.rawArtifact ?? null,
    rawCaptureStatus: stage.rawCaptureStatus ?? (stage.rawArtifact ? 'captured' : 'not-captured'),
    timing: stage.timing ?? null,
    elapsedMs: stage.elapsedMs ?? null,
  };
};
const attemptView = (record) => (record?.stages ?? []).map((stage) => ({
  attemptId: stage.attemptId, stage: stage.stage, status: stage.status,
  providerCompleted: stage.providerCompleted, accepted: stage.accepted,
  httpStatus: stage.httpStatus ?? null, errorCode: stage.errorCode ?? null,
  errorName: stage.errorName ?? null, usage: stage.usage ?? null,
  rawArtifact: stage.rawArtifact ?? null, rawCaptureStatus: stage.rawCaptureStatus ?? null,
  timing: stage.timing ?? null, elapsedMs: stage.elapsedMs ?? null,
}));
const nutrientReferences = (view) => view?.analysis?.components?.map((component) => ({
  label: component.label, per100g: component.per100g, recipeBasis: component.recipeBasis,
  assumptions: component.assumptions, evidence: component.evidence, uncertainty: component.uncertainty,
})) ?? [];
const redactConfig = (config) => ({
  model: config.model, reasoningEffort: config.reasoningEffort, baseUrl: config.baseUrl,
  protocol: config.protocol, stream: config.stream, maxOutputTokens: config.maxOutputTokens,
  timeoutMs: config.timeoutMs, wholeImageDetail: config.wholeImageDetail,
  cropImageDetail: config.cropImageDetail, groups: config.groups, preprocessing: config.preprocessing,
  retries: config.retries, ledgerLimits: config.ledgerLimits,
});

const results = await readJson('results.json');
const manifest = await readJson('manifest.json');
const observations = await readJson('observations.json');
const reveal = await readJson('reveal-map.json');
const blindScores = await readJson('blind/scores-final.json');
const scoredRows = (blindScores.samples ?? []).filter((row) => row.scored === true && row.scores);
const comparison = compareTrial(results, reveal, { final: scoredRows, firstPass: [] });
const observationByMeal = new Map((observations.samples ?? []).map((row) => [row.mealId, row]));
const scoreBySample = new Map((blindScores.samples ?? []).map((row) => [row.sampleId, row]));
const sampleByMeal = new Map(reveal.entries.map((row) => [row.mealId, row.sampleId]));

const meals = manifest.meals.map((manifestMeal) => {
  const resultMeal = results.meals.find((row) => row.mealId === manifestMeal.mealId);
  const sampleId = sampleByMeal.get(manifestMeal.mealId);
  const observation = observationByMeal.get(manifestMeal.mealId) ?? null;
  const score = scoreBySample.get(sampleId) ?? null;
  const groups = {};
  for (const group of ['project', 'direct']) {
    const record = resultMeal?.[group] ?? { status: 'not_attempted', stages: [] };
    const final = stageView(record);
    const firstPass = stageView(record, true);
    groups[group] = {
      status: record.status, workflowCompleted: record.workflowCompleted === true,
      returnedStage: record.returnedStage ?? null, returnedAttemptId: record.returnedAttemptId ?? null,
      fallbackReason: record.fallbackReason ?? null, elapsedMs: record.elapsedMs ?? null,
      firstPass, final, firstPassNutritionReferences: nutrientReferences(firstPass),
      finalNutritionReferences: nutrientReferences(final), attempts: attemptView(record),
      error: record.error ?? null,
    };
  }
  return {
    sampleId, mealId: manifestMeal.mealId, image: `blind/images/${sampleId}.jpg`,
    originalPath: manifestMeal.sourcePath, original: manifestMeal.original, prepared: manifestMeal.prepared,
    observation: { clearlyVisible: observation?.clearlyVisible ?? [], uncertain: observation?.uncertain ?? [], evaluationNotes: observation?.evaluationNotes ?? [] },
    project: groups.project, direct: groups.direct,
    blindAssessment: score,
  };
});

const report = {
  schemaVersion: 'meal-ab-comparison.v1',
  runId: results.runId, generatedAt: new Date().toISOString(),
  exploratory: true,
  experiment: {
    sampleCount: meals.length, selection: 'natural-order first five breakfast and first five dinner folders',
    model: manifest.config.model, reasoningEffort: manifest.config.reasoningEffort,
    providerBaseUrl: manifest.config.baseUrl, protocol: manifest.config.protocol,
    inputParity: 'both groups received the same prepared JPEG bytes; project crops were only available in its optional second stage',
    timeoutMs: manifest.config.timeoutMs, retries: 0, projectMaxStages: 2, directMaxStages: 1,
    maxRequests: manifest.config.maxRequests, actualRequests: results.requests.length,
  },
  configuration: redactConfig(manifest.config),
  ledger: results.ledger ?? null,
  groups: comparison.groups,
  contentQuality: comparison.content,
  firstPassControl: comparison.firstPassControl,
  blindAssessment: {
    path: 'blind/scores-final.json', sampleCount: blindScores.samples?.length ?? 0,
    scoredPairs: scoredRows.length, eligiblePairs: comparison.content.eligiblePairs,
    conclusion: comparison.content.winner, reason: comparison.content.reason,
    rubric: blindScores.rubric,
  },
  meals,
  limitations: [
    '本轮只有 1 张项目组结果和 1 张直接组结果，且不是同一张照片；没有完整 X/Y 配对，不能判断内容质量谁更强。',
    '18 次请求在 90 秒内没有完整 response.completed 事件，HTTP 200 或部分流不计成功；失败阶段和分母均保留。',
    '18 个超时阶段由启动于 raw 采集修复前的 runner 执行，rawArtifact 为空并标记 missing_from_prior_runner；未重发补齐。',
    '每 100 g 数值是模型按典型配方估算的参考，不是称重、配方实测或营养真值；没有营养准确率结论。',
    '观察清单是独立 AI 视觉观察，不是人工真值；结果只适用于这 10 张图片，不能外推。',
    '输入验证覆盖 Web canvas JPEG 链路；Android 原生图像处理尚未在本轮验收。',
  ],
};

await writeFile(join(outputDir, 'comparison.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
const s = (value) => value === null || value === undefined ? '未知' : `${(value / 1000).toFixed(1)} 秒`;
const lines = [
  '# 10 张餐食图片：项目分析与模型直接分析对照', '',
  `运行 ${report.runId}。本报告为 10 张图片上的探索性结果，不外推为所有餐食。`, '',
  '## 结论', '',
  '本轮无法判断项目组或直接组的内容质量更强：只有 1 张项目组和 1 张直接组完整，且不是同一张照片，因此完整配对数为 0，盲评没有可评分对。',
  `实际可用性：项目组 ${report.groups.project.businessAcceptedMeals}/10，直接组 ${report.groups.direct.businessAcceptedMeals}/10；两组各有 9 次超时。`,
  `首轮控制比较：${report.firstPassControl.eligiblePairs} 对完整样本、${report.firstPassControl.scoredCompletePairs} 对已评分；结论 ${report.firstPassControl.winner}（${report.firstPassControl.reason}）。`,
  '建议下一轮先解决上游完成事件延迟或改用更快的视觉请求配置，再进行同图配对质量比较。', '',
  '## 汇总', '',
  '| 指标 | 项目组 | 直接组 |', '|---|---:|---:|',
  `| 请求数 | ${report.groups.project.requests} | ${report.groups.direct.requests} |`,
  `| 完整 response.completed | ${report.groups.project.completeResponseStages} | ${report.groups.direct.completeResponseStages} |`,
  `| 业务接受餐数 | ${report.groups.project.businessAcceptedMeals}/10 | ${report.groups.direct.businessAcceptedMeals}/10 |`,
  `| 含可用每100g参考 | ${report.groups.project.usefulReferenceMeals}/10 | ${report.groups.direct.usefulReferenceMeals}/10 |`,
  `| 整组耗时中位数 / P90 | ${s(report.groups.project.latencyMs.median)} / ${s(report.groups.project.latencyMs.p90)} | ${s(report.groups.direct.latencyMs.median)} / ${s(report.groups.direct.latencyMs.p90)} |`,
  `| 成功请求 input / output tokens | ${report.groups.project.usage.input_tokens ?? '未知'} / ${report.groups.project.usage.output_tokens ?? '未知'} | ${report.groups.direct.usage.input_tokens ?? '未知'} / ${report.groups.direct.usage.output_tokens ?? '未知'} |`,
  `| usage 未报告请求 | ${report.groups.project.usageMissingStages} | ${report.groups.direct.usageMissingStages} |`, '',
  `请求账本：本轮 ${report.ledger?.totals?.localRequests ?? report.experiment.actualRequests} 次；关联历史 ${report.ledger?.totals?.relatedRequests ?? '未知'} 次；累计记录 ${report.ledger?.totals?.totalRequests ?? '未知'} 次。本轮 totalRequests 为 null，不受历史 75 次停止条件拦截。`, '',
  '## 逐图结果', '',
  '| 样本 | 照片 | 项目组 | 直接组 | 盲评 |', '|---|---|---|---|---|',
];
for (const meal of meals) {
  const p = meal.project, d = meal.direct, score = meal.blindAssessment;
  const pRef = p.finalNutritionReferences.map((row) => row.label).join('、') || '无';
  const dRef = d.finalNutritionReferences.map((row) => row.label).join('、') || '无';
  lines.push(`| ${meal.sampleId} | ${meal.mealId} | ${p.status}；${pRef}；${s(p.elapsedMs)} | ${d.status}；${dRef}；${s(d.elapsedMs)} | ${score?.scored ? '已评分' : '不可评分：完整配对缺失'} |`);
}
lines.push('', '## 成功结果中的每 100 g 参考', '');
for (const meal of meals) for (const group of ['project', 'direct']) {
  const refs = meal[group].finalNutritionReferences;
  if (!refs.length) continue;
  lines.push(`### ${meal.sampleId} / ${group}`, '');
  for (const ref of refs) lines.push(`- ${ref.label}：${JSON.stringify(ref.per100g)}；依据：${ref.recipeBasis ?? '未知'}。`);
}
lines.push('', '## 逐图观察与结果', '');
for (const meal of meals) {
  lines.push(`### ${meal.sampleId} / ${meal.mealId}`, '', `![${meal.sampleId}](${meal.image})`, '');
  lines.push(`可见观察：${meal.observation.clearlyVisible.join('；') || '无记录'}。`);
  lines.push(`无法确认：${meal.observation.uncertain.join('；') || '无记录'}。`);
  const writeResult = (label, record, view, references) => {
    lines.push(`${label}：${record?.status ?? 'not_attempted'}，阶段 ${view?.stage ?? '无'}，耗时 ${s(view?.elapsedMs ?? record?.elapsedMs ?? null)}，请求 ${(record?.attempts ?? []).length} 次。`);
    for (const ref of references ?? []) lines.push(`- ${label}识别 ${ref.label}：每100g ${JSON.stringify(ref.per100g)}；配方依据 ${ref.recipeBasis ?? '未知'}。`);
  };
  writeResult('项目组首轮', meal.project, meal.project.firstPass, meal.project.firstPassNutritionReferences);
  writeResult('项目组最终', meal.project, meal.project.final, meal.project.finalNutritionReferences);
  writeResult('直接组', meal.direct, meal.direct.final, meal.direct.finalNutritionReferences);
  lines.push(`盲评：${meal.blindAssessment?.scored ? '已评分' : '不可评分，缺少完整 X/Y 配对'}。`, '');
}
lines.push('', '## 限制', '', ...report.limitations.map((item) => `- ${item}`), '', '完整原始产物、请求账本、盲评文件和逐阶段结果见同目录的 `manifest.json`、`results.json`、`requests.sqlite`、`blind/` 和本报告 JSON。', '');
await writeFile(join(outputDir, 'comparison.md'), lines.join('\n'), { mode: 0o600 });
console.log(JSON.stringify({ outputDir, comparison: join(outputDir, 'comparison.json'), markdown: join(outputDir, 'comparison.md'), acceptedPairs: report.contentQuality.eligiblePairs }));
