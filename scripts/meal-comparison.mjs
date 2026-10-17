import { validateModelNutritionEstimate } from '../shared/nutrition.mjs';

const NUTRIENTS = Object.freeze([
  ['calories', '热量', 'kcal'],
  ['protein', '蛋白质', 'g'],
  ['carbs', '碳水化合物', 'g'],
  ['fat', '脂肪', 'g'],
]);

const STATUS_LABELS = Object.freeze({
  estimated: '已估算',
  approximate: '近似估算',
  unknown: '未知',
  accepted: '已接受',
  in_flight: '进行中',
  timeout: '超时',
  failed: '失败',
  schema_error: '格式错误',
  format_error: '格式错误',
  request_error: '请求失败',
  upstream_error: '上游失败',
  transport_error: '传输失败',
  http_error: 'HTTP 错误',
  budget_rejected: '请求额度拒绝',
});

const SCOPE_LABELS = Object.freeze({ photo_serving: '照片中的整份餐食', consumed_intake: '实际食用量' });

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function acceptedAnalysis(value) {
  if (!isObject(value)) return null;
  if (Object.hasOwn(value, 'analysis')) {
    if (value.accepted === false || value.resultAccepted === false || value.providerCompleted === false) return null;
    const accepted = value.accepted === true || value.resultAccepted === true || value.status === 'accepted';
    if (!accepted || !isObject(value.analysis)
      || !['estimated', 'approximate', 'unknown'].includes(value.analysis.status)) return null;
    return value.analysis;
  }
  if (value.accepted === false || value.resultAccepted === false) return null;
  if (!['estimated', 'approximate', 'unknown'].includes(value.status)) return null;
  // A bare analysis is treated as an already-selected accepted result. Callers
  // passing an attempt/report wrapper must include its acceptance status above.
  return value;
}

function validRange(value) {
  if (!isObject(value) || !Number.isFinite(value.min) || !Number.isFinite(value.max)
    || value.min < 0 || value.max < value.min) return null;
  return { min: value.min, max: value.max };
}

function rangeOrNull(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return { min: value, max: value };
  return validRange(value);
}

function cleanList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()) : [];
}

function usefulModelReference(component) {
  const source = component.source;
  if (!isObject(source) || source.provider !== 'model' || component.nutritionReferenceStale === true
    || typeof source.model !== 'string' || !source.model.trim()
    || typeof source.generatedAt !== 'string' || !Number.isFinite(Date.parse(source.generatedAt))) return false;
  try {
    validateModelNutritionEstimate({ basisGrams: source.basisGrams, method: source.method, per100g: source.per100gRange,
      recipeBasis: source.recipeBasis, assumptions: source.assumptions, confidence: source.confidence });
    return true;
  } catch { return false; }
}

/**
 * Summarize accepted references and locally calculated intake separately.
 * Model nutrients are read only from the explicit per-100g v3 source snapshot.
 */
export function summarizeMealAnalysis(input) {
  const analysis = acceptedAnalysis(input);
  if (!analysis) return null;
  const method = analysis.nutritionSource?.method;
  const locallyCalculated = ['ingredient-weight-v1', 'user-quantity-v2', 'ai-per100g-v3'].includes(method);
  const components = Array.isArray(analysis.components) ? analysis.components.filter(isObject).map((component) => ({
    foodId: typeof component.foodId === 'string' ? component.foodId : null,
    label: typeof component.label === 'string' ? component.label : '未标注食材',
    grams: rangeOrNull(component.grams),
    userQuantity: isObject(component.userQuantity) && Number.isFinite(component.userQuantity.amount)
      && ['g', 'household'].includes(component.userQuantity.unit)
      ? { amount: component.userQuantity.amount, unit: component.userQuantity.unit } : null,
    householdMeasure: isObject(component.householdMeasure) && Number.isFinite(component.householdMeasure.grams)
      && typeof component.householdMeasure.label === 'string'
      ? { label: component.householdMeasure.label, grams: component.householdMeasure.grams, approximate: component.householdMeasure.approximate === true } : null,
    reference: isObject(component.source) ? {
      provider: typeof component.source.provider === 'string' ? component.source.provider : null,
      basisGrams: Number.isFinite(component.source.basisGrams) ? component.source.basisGrams : null,
      method: typeof component.source.method === 'string' ? component.source.method : null,
      recipeBasis: typeof component.source.recipeBasis === 'string' ? component.source.recipeBasis : null,
      assumptions: cleanList(component.source.assumptions),
      confidence: Number.isFinite(component.source.confidence) ? component.source.confidence : null,
      model: typeof component.source.model === 'string' ? component.source.model : null,
      reasoningEffort: typeof component.source.reasoningEffort === 'string' ? component.source.reasoningEffort : null,
      generatedAt: typeof component.source.generatedAt === 'string' ? component.source.generatedAt : null,
      stale: component.nutritionReferenceStale === true,
      useful: method === 'ai-per100g-v3' && usefulModelReference(component),
      nutrients: Object.fromEntries(NUTRIENTS.map(([key]) => [key, method === 'ai-per100g-v3'
        ? validRange(component.source.per100gRange?.[key]) : rangeOrNull(component.source.per100g?.[key] ?? component.source.per100gRange?.[key])])),
    } : null,
    consumedFraction: rangeOrNull(component.consumedFraction),
    quantitySource: typeof component.quantitySource === 'string' ? component.quantitySource : null,
    confidence: typeof component.confidence === 'number' && Number.isFinite(component.confidence)
      ? Math.max(0, Math.min(1, component.confidence)) : null,
    uncertainty: cleanList(component.uncertainty),
    candidates: Array.isArray(component.candidates) ? component.candidates.filter(isObject).map((candidate) => ({
      foodId: typeof candidate.foodId === 'string' ? candidate.foodId : null,
      label: typeof candidate.label === 'string' ? candidate.label : '未标注候选食材',
      confidence: typeof candidate.confidence === 'number' && Number.isFinite(candidate.confidence)
        ? Math.max(0, Math.min(1, candidate.confidence)) : null,
    })) : [],
  })) : [];

  const usefulReferenceCount = components.filter((component) => component.reference?.useful).length;
  const referenceCount = Number.isInteger(analysis.coverage?.referenceCount) ? analysis.coverage.referenceCount : null;
  const total = Number.isInteger(analysis.coverage?.total) ? analysis.coverage.total : null;
  const counted = Number.isInteger(analysis.coverage?.counted) ? analysis.coverage.counted : null;
  return {
    status: typeof analysis.status === 'string' ? analysis.status : 'unknown',
    confidence: typeof analysis.confidence === 'number' && Number.isFinite(analysis.confidence)
      ? Math.max(0, Math.min(1, analysis.confidence)) : null,
    estimateScope: typeof analysis.estimateScope === 'string' ? analysis.estimateScope : null,
    foodName: typeof analysis.foodName === 'string' ? analysis.foodName : null,
    components,
    usefulReferenceCount,
    hasUsefulNutritionReference: method === 'ai-per100g-v3' && usefulReferenceCount > 0,
    referenceCoverageComplete: components.length > 0 && usefulReferenceCount === components.length,
    referenceCoverageConsistent: method === 'ai-per100g-v3' ? referenceCount === usefulReferenceCount && total === components.length : null,
    intakeComplete: analysis.nutritionSource?.coverage === 'complete' || (total > 0 && counted === total),
    coverage: isObject(analysis.coverage) ? {
      referenceCount,
      counted,
      total,
      missingQuantityLabels: cleanList(analysis.coverage.missingQuantityLabels),
      unknownNutritionLabels: cleanList(analysis.coverage.unknownNutritionLabels),
    } : null,
    unresolved: cleanList(analysis.unresolved),
    assumptions: cleanList(analysis.assumptions),
    nutrients: Object.fromEntries(NUTRIENTS.map(([key]) => [key, locallyCalculated ? rangeOrNull(analysis[key]) : null])),
    nutritionSource: locallyCalculated ? {
      provider: typeof analysis.nutritionSource.provider === 'string' ? analysis.nutritionSource.provider : null,
      dataset: typeof analysis.nutritionSource.dataset === 'string' ? analysis.nutritionSource.dataset : null,
      method,
      coverage: typeof analysis.nutritionSource.coverage === 'string' ? analysis.nutritionSource.coverage : null,
    } : null,
  };
}

function attemptSummary(attempt) {
  if (!isObject(attempt)) return null;
  return {
    stage: typeof attempt.stage === 'string' ? attempt.stage : null,
    status: typeof attempt.status === 'string' ? attempt.status : 'unknown',
    elapsedMs: Number.isFinite(attempt.elapsedMs) && attempt.elapsedMs >= 0 ? attempt.elapsedMs : null,
    httpStatus: Number.isInteger(attempt.httpStatus) ? attempt.httpStatus : null,
    providerCompleted: typeof attempt.providerCompleted === 'boolean' ? attempt.providerCompleted : null,
    resultAccepted: typeof attempt.resultAccepted === 'boolean' ? attempt.resultAccepted : attempt.status === 'accepted',
    stageSucceeded: attempt.providerCompleted === true && attempt.resultAccepted === true && attempt.status === 'accepted'
      && attempt.httpStatus >= 200 && attempt.httpStatus < 300,
    model: typeof attempt.model === 'string' ? attempt.model : null,
    reasoningEffort: typeof attempt.reasoningEffort === 'string' ? attempt.reasoningEffort : null,
    resultVersion: Number.isSafeInteger(attempt.resultVersion) ? attempt.resultVersion : null,
    usage: isObject(attempt.usage) ? Object.fromEntries(Object.entries(attempt.usage).filter(([key, value]) =>
      ['input_tokens', 'output_tokens', 'total_tokens', 'cached_input_tokens', 'reasoning_tokens'].includes(key) && Number.isSafeInteger(value) && value >= 0)) : null,
    errorCode: typeof attempt.errorCode === 'string' ? attempt.errorCode : null,
    startedAt: typeof attempt.startedAt === 'string' ? attempt.startedAt : null,
  };
}

/** Build one stable, serializable per-meal comparison record. */
export function createMealComparison({ mealId, previous = null, current = null, attempts = [], batchStatus = null, stageRejections = [], batchError = null } = {}) {
  const previousSummary = summarizeMealAnalysis(previous);
  const currentSummary = summarizeMealAnalysis(current);
  return {
    mealId: String(mealId ?? ''),
    previous: previousSummary,
    previousLabel: previousSummary ? '此前已接受结果' : '此前无已接受结果',
    current: currentSummary,
    currentLabel: currentSummary ? '本次已接受结果' : '本次无已接受结果',
    attempts: Array.isArray(attempts) ? attempts.map(attemptSummary).filter(Boolean) : [],
    batchStatus: typeof batchStatus === 'string' ? batchStatus : null,
    stageRejections: Array.isArray(stageRejections) ? stageRejections.filter(isObject).map(({ stage, kind, code }) => ({
      stage: typeof stage === 'string' ? stage : null, kind: typeof kind === 'string' ? kind : 'failed', code: typeof code === 'string' ? code : null,
    })) : [],
    batchError: isObject(batchError) ? { kind: typeof batchError.kind === 'string' ? batchError.kind : null, code: typeof batchError.code === 'string' ? batchError.code : null } : null,
  };
}

function formatNumber(value) {
  if (!Number.isFinite(value)) return null;
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(1)));
}

function formatRange(value, unit) {
  const range = validRange(value);
  if (!range) return '未知';
  const min = formatNumber(range.min);
  const max = formatNumber(range.max);
  const display = min === max ? min : `${min}–${max}`;
  return `${display}${unit ? ` ${unit}` : ''}`;
}

function confidenceText(value) {
  return Number.isFinite(value) ? `${Math.round(value * 100)}%` : '未提供';
}

function stageLabel(stage) {
  return ({ whole: '整图', crop_review: '局部复核', final_merge: '最终合并' })[stage] ?? stage ?? '请求';
}

function attemptText(attempt) {
  const status = STATUS_LABELS[attempt.status] ?? attempt.status ?? '未知';
  const elapsed = attempt.elapsedMs === null ? '耗时未知' : `${(attempt.elapsedMs / 1000).toFixed(1)} 秒`;
  const http = attempt.httpStatus === null ? '' : `，HTTP ${attempt.httpStatus}`;
  const accepted = attempt.resultAccepted ? '，结果已接受' : '';
  const completed = attempt.providerCompleted === true ? '，传输已完成' : attempt.providerCompleted === false ? '，传输未完成' : '';
  const error = attempt.errorCode ? `，错误：${attempt.errorCode}` : '';
  return `${stageLabel(attempt.stage)}：${status}，${elapsed}${http}${accepted}${completed}${error}`;
}

function componentText(component) {
  const id = component.foodId ? `（${component.foodId}）` : component.reference?.provider === 'model' ? '（AI 营养参考）' : '（未匹配目录）';
  const quantity = component.userQuantity
    ? component.userQuantity.unit === 'g' ? `，用户填写 ${formatNumber(component.userQuantity.amount)} g`
      : `，用户填写 ${formatNumber(component.userQuantity.amount)} × ${component.householdMeasure?.label ?? '家用单位'}`
    : component.grams ? `，旧分析记录 ${formatRange(component.grams, 'g')}` : '，数量未填写';
  const fraction = component.consumedFraction ? `，食用比例 ${formatRange(component.consumedFraction, '')}` : '';
  const confidence = component.confidence === null ? '' : `，置信度 ${confidenceText(component.confidence)}`;
  const uncertainty = component.uncertainty.length ? `；不确定：${component.uncertainty.join('、')}` : '';
  const candidates = component.candidates.length
    ? `；候选：${component.candidates.map(({ label, foodId }) => `${label}${foodId ? `（${foodId}）` : ''}`).join('、')}` : '';
  const reference = component.reference ? `；每 100 g 参考：${NUTRIENTS.map(([key, name, unit]) => `${name} ${formatRange(component.reference.nutrients[key], unit)}`).join('、')}` : '';
  const method = component.reference?.method ? `；方法：${({ typical_recipe: '典型配方', category: '品类范围' })[component.reference.method] ?? component.reference.method}` : '';
  const recipe = component.reference?.recipeBasis ? `；配方依据：${component.reference.recipeBasis}` : '';
  const assumptions = component.reference?.assumptions.length ? `；参考假设：${component.reference.assumptions.join('；')}` : '';
  const provenance = component.reference?.provider === 'model'
    ? `；模型：${component.reference.model ?? '未提供'}，推理强度：${component.reference.reasoningEffort ?? '未提供'}；生成：${component.reference.generatedAt ?? '未提供'}` : '';
  const stale = component.reference?.stale ? '；参考已失效，待重新估值' : '';
  const measure = component.householdMeasure ? `；约 ${component.householdMeasure.label} = ${formatNumber(component.householdMeasure.grams)} g` : '';
  return `- ${component.label}${id}${quantity}${fraction}${confidence}${reference}${method}${recipe}${assumptions}${provenance}${stale}${measure}${uncertainty}${candidates}`;
}

function analysisSection(label, analysis, missingMessage) {
  if (!analysis) return `### ${label}\n${missingMessage}`;
  const status = STATUS_LABELS[analysis.status] ?? analysis.status;
  const scope = ['user-quantity-v2', 'ai-per100g-v3'].includes(analysis.nutritionSource?.method)
    ? '按用户填写数量；未填菜品不计入'
    : SCOPE_LABELS[analysis.estimateScope] ?? analysis.estimateScope ?? '未提供';
  const lines = [
    `### ${label}`,
    `状态：${status}；置信度：${confidenceText(analysis.confidence)}；估算范围：${scope}。`,
    `食材：${analysis.foodName ?? '未命名餐食'}`,
    ...(analysis.components.length ? analysis.components.map(componentText) : ['- 无食材明细']),
    '',
    '| 指标 | 本地计算区间 |',
    '| --- | --- |',
    ...NUTRIENTS.map(([key, name, unit]) => `| ${name} | ${formatRange(analysis.nutrients[key], unit)} |`),
  ];
  if (analysis.coverage && analysis.coverage.counted !== null && analysis.coverage.total !== null) {
    lines.push(`数量覆盖：已计入 ${analysis.coverage.counted}/${analysis.coverage.total} 道菜；摄入完整：${analysis.intakeComplete ? '是' : '否'}。`);
    if (analysis.coverage.referenceCount !== null) lines.push(`营养参考覆盖：${analysis.coverage.referenceCount}/${analysis.coverage.total} 道菜；四项有效参考：${analysis.usefulReferenceCount} 道；有用营养参考：${analysis.hasUsefulNutritionReference ? '是' : '否'}。`);
    if (analysis.coverage.missingQuantityLabels.length) lines.push(`未填写数量：${analysis.coverage.missingQuantityLabels.join('、')}。`);
    if (analysis.coverage.unknownNutritionLabels.length) lines.push(`营养数据未知：${analysis.coverage.unknownNutritionLabels.join('、')}。`);
  }
  if (analysis.unresolved.length) lines.push('', `待解决：${analysis.unresolved.join('；')}`);
  if (analysis.assumptions.length) lines.push('', `假设：${analysis.assumptions.join('；')}`);
  return lines.join('\n');
}

function requestSummaryText(summary) {
  if (!isObject(summary)) return '';
  const entries = Object.entries(summary).filter(([, value]) => value !== null && value !== undefined && typeof value !== 'object');
  if (!entries.length) return '';
  const labels = { totalRequests: '请求数', completedRequests: '完成传输', acceptedRequests: '已接受', successfulStages: '成功阶段',
    failedRequests: '失败', cumulativeRequests: '累计请求', remainingRequests: '剩余请求', totalElapsedMs: '总耗时毫秒', elapsedMs: '耗时毫秒' };
  const fields = entries.map(([key, value]) => `${labels[key] ?? key}：${value}`);
  if (isObject(summary.statusCounts)) {
    fields.push(`状态统计：${Object.entries(summary.statusCounts).map(([key, value]) => `${STATUS_LABELS[key] ?? key} ${value}`).join('、')}`);
  }
  return fields.join('；');
}

/** Render a compact Chinese report; nutrient values come only from summaries. */
export function renderMealComparisonMarkdown({ runId, model, reasoningEffort, comparisons = [], requestSummary = null } = {}) {
  const lines = ['# 餐食分析对比', '', `运行：${runId ?? '未提供'}；模型：${model ?? '未提供'}；推理强度：${reasoningEffort ?? '未提供'}。`];
  const overallRequests = requestSummaryText(requestSummary);
  if (overallRequests) lines.push(`请求汇总：${overallRequests}。`);
  for (const comparison of Array.isArray(comparisons) ? comparisons : []) {
    if (!isObject(comparison)) continue;
    lines.push('', `## ${comparison.mealId || '未命名餐食'}`, '',
      ...(comparison.batchStatus ? [`本轮流程状态：${STATUS_LABELS[comparison.batchStatus] ?? comparison.batchStatus}${comparison.batchError?.code ? `（${comparison.batchError.code}）` : ''}。`] : []),
      ...(Array.isArray(comparison.stageRejections) && comparison.stageRejections.length
        ? comparison.stageRejections.map((rejection) => `阶段未发送：${stageLabel(rejection.stage)}，${STATUS_LABELS[rejection.kind] ?? rejection.kind}（${rejection.code ?? '无错误码'}）。`) : []),
      '',
      analysisSection('此前结果', comparison.previous, '此前无已接受结果，无法建立营养基线。'), '',
      analysisSection('本次结果', comparison.current, '本次没有已接受的分析结果。'));
    if (Array.isArray(comparison.attempts) && comparison.attempts.length) {
      lines.push('', '请求记录：', ...comparison.attempts.map((attempt) => `- ${attemptText(attempt)}`));
    } else {
      lines.push('', '请求记录：无可用记录。');
    }
  }
  return `${lines.join('\n')}\n`;
}
