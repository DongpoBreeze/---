const nutrients = ['calories', 'protein', 'carbs', 'fat'];
const recognitionKeys = ['foodName', 'components', 'unresolved', 'assumptions', 'advice', 'confidence'];
const modelComponentKeys = ['foodId', 'label', 'uncertainty', 'category', 'confidence', 'candidates', 'evidence', 'region', 'preparation', 'cookingMethod'];
const componentKeys = [...modelComponentKeys, 'grams', 'quantitySource', 'consumedFraction', 'estimateBasis', 'userQuantity', 'householdMeasure'];

// Reproducible, deliberately broad reference intervals for components which
// have a category but cannot be mapped to one of the exact USDA rows.
export const DEFAULT_CATEGORY_RANGES = Object.freeze({
  grain: { calories: { min: 100, max: 150 }, protein: { min: 2, max: 4 }, carbs: { min: 20, max: 32 }, fat: { min: 0, max: 3 } },
  noodle: { calories: { min: 90, max: 160 }, protein: { min: 2, max: 8 }, carbs: { min: 18, max: 32 }, fat: { min: 0, max: 5 } },
  vegetable: { calories: { min: 20, max: 60 }, protein: { min: 1, max: 4 }, carbs: { min: 4, max: 15 }, fat: { min: 0, max: 2 } },
  mushroom: { calories: { min: 20, max: 50 }, protein: { min: 1.5, max: 4 }, carbs: { min: 3, max: 10 }, fat: { min: 0, max: 2 } },
  tofu: { calories: { min: 60, max: 180 }, protein: { min: 6, max: 20 }, carbs: { min: 1, max: 10 }, fat: { min: 3, max: 12 } },
  soy: { calories: { min: 60, max: 180 }, protein: { min: 6, max: 20 }, carbs: { min: 1, max: 10 }, fat: { min: 3, max: 12 } },
  egg: { calories: { min: 130, max: 180 }, protein: { min: 10, max: 14 }, carbs: { min: 0, max: 3 }, fat: { min: 8, max: 14 } },
  meat: { calories: { min: 100, max: 250 }, protein: { min: 18, max: 32 }, carbs: { min: 0, max: 5 }, fat: { min: 2, max: 18 } },
  oil: { calories: { min: 800, max: 900 }, protein: { min: 0, max: 0 }, carbs: { min: 0, max: 0 }, fat: { min: 90, max: 100 } },
  sauce: { calories: { min: 20, max: 150 }, protein: { min: 0, max: 10 }, carbs: { min: 2, max: 20 }, fat: { min: 0, max: 10 } },
});
const DEFAULT_CATEGORY_ALIASES = Object.freeze({
  '米饭': 'grain', '米': 'grain', '谷物': 'grain', '饭': 'grain', '面': 'noodle', '面条': 'noodle', '米粉': 'noodle',
  '蔬菜': 'vegetable', '青菜': 'vegetable', '藕': 'vegetable', '土豆': 'vegetable', '马铃薯': 'vegetable', '胡萝卜': 'vegetable', '洋葱': 'vegetable', '西兰花': 'vegetable', '卷心菜': 'vegetable', '菠菜': 'vegetable',
  '菌菇': 'mushroom', '蘑菇': 'mushroom', '金针菇': 'mushroom', '香菇': 'mushroom',
  '豆制品': 'soy', '豆皮': 'soy', '豆腐': 'tofu', '鸡蛋': 'egg', '蛋': 'egg', '肉': 'meat', '鸡肉': 'meat', '牛肉': 'meat', '猪肉': 'meat',
  '食用油': 'oil', '烹调油': 'oil', '油': 'oil', '酱料': 'sauce', '酱汁': 'sauce', '调味汁': 'sauce', '蘸料': 'sauce', '酱油': 'sauce',
});

function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function string(value, limit) { return typeof value === 'string' && value.trim().length > 0 && value.length <= limit; }
function list(value, count, limit) { return Array.isArray(value) && value.length <= count && value.every((item) => string(item, limit)); }
function confidence(value) { return value === undefined || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1); }
function range(value, maximum) {
  return value === null || (object(value) && Object.keys(value).length === 2
    && Number.isFinite(value.min) && Number.isFinite(value.max)
    && value.min >= 0 && value.max >= value.min && value.max <= maximum);
}
function basis(value) { return (typeof value === 'string' && value.trim().length > 0 && value.length <= 500) || (Array.isArray(value) && value.length <= 8 && value.every((item) => typeof item === 'string' && item.trim().length > 0 && item.length <= 500)); }

function validateCandidate(value) {
  if (!object(value) || !Object.hasOwn(value, 'foodId') || !Object.hasOwn(value, 'label')
    || !(value.foodId === null || (typeof value.foodId === 'string' && /^[a-z0-9_]{1,64}$/.test(value.foodId)))
    || !string(value.label, 300) || !confidence(value.confidence)
    || (value.category !== undefined && value.category !== null && !string(value.category, 128))) throw new TypeError('Invalid meal candidate.');
  return { foodId: value.foodId, label: value.label.trim(), ...(value.confidence === undefined ? {} : { confidence: value.confidence }), ...(value.category === undefined ? {} : { category: value.category === null ? null : value.category.trim() }) };
}
function validateEvidence(value) {
  if (string(value, 1000)) return value.trim();
  if (!object(value) || !['visual', 'user', 'photo', 'database', 'inference', 'unknown'].includes(value.kind) || !string(value.text, 1000) || !confidence(value.confidence)) throw new TypeError('Invalid meal evidence.');
  return { kind: value.kind, text: value.text.trim(), ...(value.confidence === undefined ? {} : { confidence: value.confidence }) };
}
function validateRegion(value) {
  if (value === null || value === undefined) return value;
  if (!object(value) || !['x', 'y', 'width', 'height'].every((key) => typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0 && value[key] <= 1)
    || value.x + value.width > 1 || value.y + value.height > 1) throw new TypeError('Invalid meal region.');
  return { x: value.x, y: value.y, width: value.width, height: value.height };
}

export function validateMealRecognition(value, { strict = true } = {}) {
  if (!object(value) || ['foodName', 'components', 'unresolved', 'assumptions', 'advice'].some((key) => !Object.hasOwn(value, key))
    || (strict && Object.keys(value).some((key) => !recognitionKeys.includes(key)))
    || !string(value.foodName, 500) || !string(value.advice, 4000)
    || !list(value.assumptions, 80, 1000) || !list(value.unresolved, 100, 1000)
    || !Array.isArray(value.components) || value.components.length > 20
    || (!strict && value.estimateScope !== undefined && !['photo_serving', 'consumed_intake'].includes(value.estimateScope))
    || !confidence(value.confidence)) throw new TypeError('Invalid meal recognition.');
  const components = value.components.map((item) => {
    if (!object(item) || ['foodId', 'label', 'uncertainty'].some((key) => !Object.hasOwn(item, key))
      || (strict && Object.keys(item).some((key) => !modelComponentKeys.includes(key)))
      || !(item.foodId === null || (typeof item.foodId === 'string' && /^[a-z0-9_]{1,64}$/.test(item.foodId)))
      || !string(item.label, 300) || (item.grams !== undefined && !range(item.grams, 100_000))
      || (item.consumedFraction !== undefined && !range(item.consumedFraction, 1))
      || (item.quantitySource !== undefined && !['user', 'visual', 'unknown'].includes(item.quantitySource))
      || (item.grams !== undefined && item.quantitySource !== undefined && (item.grams === null) !== (item.quantitySource === 'unknown'))
      || (item.userQuantity !== undefined && item.userQuantity !== null && (!object(item.userQuantity)
        || !Number.isFinite(item.userQuantity.amount) || item.userQuantity.amount <= 0 || item.userQuantity.amount > 100_000
        || !['g', 'household'].includes(item.userQuantity.unit)))
      || (item.householdMeasure !== undefined && item.householdMeasure !== null && (!object(item.householdMeasure)
        || !string(item.householdMeasure.label, 100) || !Number.isFinite(item.householdMeasure.grams)
        || item.householdMeasure.grams <= 0 || item.householdMeasure.grams > 100_000 || typeof item.householdMeasure.approximate !== 'boolean'))
      || !list(item.uncertainty, 40, 500) || !confidence(item.confidence)
      || (item.category !== undefined && item.category !== null && !string(item.category, 128))
      || (item.preparation !== undefined && !string(item.preparation, 500))
      || (item.cookingMethod !== undefined && !string(item.cookingMethod, 500))
      || (item.candidates !== undefined && (!Array.isArray(item.candidates) || item.candidates.length > 20))
      || (item.evidence !== undefined && (!Array.isArray(item.evidence) || item.evidence.length > 40))
      || (item.region !== undefined && item.region !== null && !object(item.region))
      || (item.estimationBasis !== undefined && !basis(item.estimationBasis))
      || (item.estimateBasis !== undefined && !basis(item.estimateBasis))) throw new TypeError('Invalid meal component.');
    const candidates = item.candidates?.map(validateCandidate);
    const evidence = item.evidence?.map(validateEvidence);
    const region = validateRegion(item.region);
    return {
      foodId: item.foodId, label: item.label.trim(), grams: item.grams == null ? null : { min: item.grams.min, max: item.grams.max },
      quantitySource: item.quantitySource ?? (item.grams == null ? 'unknown' : 'user'),
      consumedFraction: item.consumedFraction == null ? null : { min: item.consumedFraction.min, max: item.consumedFraction.max },
      ...(item.userQuantity === undefined ? {} : { userQuantity: item.userQuantity === null ? null : { amount: item.userQuantity.amount, unit: item.userQuantity.unit } }),
      ...(item.householdMeasure === undefined ? {} : { householdMeasure: item.householdMeasure === null ? null : { label: item.householdMeasure.label.trim(), grams: item.householdMeasure.grams, approximate: item.householdMeasure.approximate } }),
      ...(item.confidence === undefined ? {} : { confidence: item.confidence }), ...(item.category === undefined ? {} : { category: item.category === null ? null : item.category.trim() }),
      ...(item.preparation === undefined ? {} : { preparation: item.preparation.trim() }), ...(item.cookingMethod === undefined ? {} : { cookingMethod: item.cookingMethod.trim() }),
      ...(candidates === undefined ? {} : { candidates }), ...(evidence === undefined ? {} : { evidence }), ...(region === undefined ? {} : { region }),
      ...(item.estimationBasis === undefined ? {} : { estimationBasis: item.estimationBasis }), ...(item.estimateBasis === undefined ? {} : { estimateBasis: item.estimateBasis }),
      uncertainty: item.uncertainty.map((text) => text.trim()),
    };
  });
  return { foodName: value.foodName.trim(), components, unresolved: value.unresolved.map((text) => text.trim()), assumptions: value.assumptions.map((text) => text.trim()), advice: value.advice.trim(), ...(!strict && value.estimateScope !== undefined ? { estimateScope: value.estimateScope } : {}), ...(value.confidence === undefined ? {} : { confidence: value.confidence }) };
}

export function hasMealIdentityConflict(component) {
  if (component.uncertainty.some((issue) => /食材身份|食材种类|无法确认.*食材|无法辨认.*食材|身份(?:待确认|不明|不确定|不清|无法确认)/.test(issue))) return true;
  const candidates = component.candidates ?? [];
  const identities = new Set(candidates.map((item) => item.foodId ?? `label:${item.label.trim().toLocaleLowerCase()}`));
  if (identities.size < 2) return false;
  const scored = candidates.filter((item) => typeof item.confidence === 'number').sort((left, right) => right.confidence - left.confidence);
  if (scored.length < 2 || scored[0].confidence - scored[1].confidence < 0.25) return true;
  return scored[0].foodId !== component.foodId;
}

function rounded(value, direction) {
  const scaled = value * 10;
  const nearest = Math.round(scaled);
  const normalized = Math.abs(scaled - nearest) <= Number.EPSILON * Math.max(1, Math.abs(scaled)) * 8 ? nearest : scaled;
  return (direction === 'min' ? Math.floor(normalized) : Math.ceil(normalized)) / 10;
}
function categoryRange(dataset, id) {
  const categories = dataset?.categories ?? dataset?.categoryRanges;
  const row = categories && object(categories) ? categories[id] : undefined;
  return row ?? DEFAULT_CATEGORY_RANGES[id];
}
function resolveCategory(dataset, component) {
  const categories = dataset?.categories ?? dataset?.categoryRanges;
  const aliases = object(dataset?.aliases) ? dataset.aliases : DEFAULT_CATEGORY_ALIASES;
  const explicit = typeof component.category === 'string' ? component.category.trim() : '';
  const candidateCategories = [...new Set((component.candidates ?? []).map((candidate) => candidate.category).filter((id) => typeof id === 'string' && categoryRange(dataset, id)))];
  if (candidateCategories.length > 1 || (explicit && candidateCategories.length === 1 && explicit !== candidateCategories[0])) return undefined;
  if (explicit && categoryRange(dataset, explicit)) return { id: explicit, range: categoryRange(dataset, explicit) };
  if (candidateCategories.length === 1) return { id: candidateCategories[0], range: categoryRange(dataset, candidateCategories[0]) };
  // Only resolve a complete generic food label (optionally with a simple
  // preparation prefix). Substring matching mistakes composite dishes such
  // as 油条 for an ingredient such as 油.
  // Caveats about quantity or preparation do not erase a confirmed category.
  const label = component.label.toLocaleLowerCase();
  const baseLabel = label.replace(/^(?:水煮的?|煮熟的?|蒸熟的?|焯水的?|熟制的?|生的?|熟|生|蒸|煮|焯水)/, '');
  const match = Object.entries(aliases)
    .filter(([alias, id]) => string(alias, 100) && typeof id === 'string' && categoryRange(dataset, id)
      && (label === alias.toLocaleLowerCase() || baseLabel === alias.toLocaleLowerCase()))
    .sort(([left], [right]) => right.length - left.length)[0];
  if (match) return { id: match[1], range: categories?.[match[1]] ?? DEFAULT_CATEGORY_RANGES[match[1]] };
  return undefined;
}
function nutrientRange(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return { min: value, max: value };
  if (object(value) && Number.isFinite(value.min) && Number.isFinite(value.max) && value.min >= 0 && value.max >= value.min) return { min: value.min, max: value.max };
  throw new TypeError('Invalid reference nutrient.');
}

function householdMeasure(dataset, component, food, categoryMatch) {
  const measures = dataset?.householdMeasures;
  const id = food?.id ?? null;
  const stored = id && object(measures) ? measures[id] : undefined;
  if (object(stored) && string(stored.label, 100) && Number.isFinite(stored.grams) && stored.grams > 0 && stored.grams <= 100_000 && typeof stored.approximate === 'boolean') {
    return { label: stored.label.trim(), grams: stored.grams, approximate: stored.approximate };
  }
  const label = component.label.trim();
  const category = categoryMatch?.id;
  if ((category === 'grain' && /米饭|熟饭|白饭/.test(label)) || ['米饭', '熟饭', '白饭'].includes(label)) {
    return { label: '半碗熟米饭', grams: 100, approximate: true };
  }
  if (category === 'egg' && /鸡蛋|鸡蛋/.test(label)) return { label: '1 个鸡蛋', grams: 50, approximate: true };
  if (category === 'oil' && /油/.test(label)) return { label: '1 平汤匙食用油', grams: 14, approximate: true };
  return undefined;
}

function calculateUserQuantityNutrition(input, dataset) {
  const recognition = validateMealRecognition(input, { strict: false });
  if (!object(dataset) || dataset.provider !== 'usda-fdc' || dataset.license !== 'CC0-1.0'
    || !string(dataset.dataset, 200) || !string(dataset.sourceUrl, 2000)
    || !/^[A-Fa-f0-9]{64}$/.test(dataset.archiveSha256) || !Array.isArray(dataset.foods)) throw new TypeError('Invalid nutrition dataset.');
  const foods = new Map(dataset.foods.map((food) => [food.id, food]));
  const totals = Object.fromEntries(nutrients.map((key) => [key, { min: 0, max: 0 }]));
  const totalsComplete = Object.fromEntries(nutrients.map((key) => [key, true]));
  const missingQuantityLabels = [];
  const unknownNutritionLabels = [];
  const unknownLabels = [];
  const unresolved = [...recognition.unresolved];
  let counted = 0;
  let matchedCount = 0;
  let exactCount = 0;
  let categoryCount = 0;
  let hasApproximateQuantity = false;
  const components = recognition.components.map((component) => {
    const food = component.foodId ? foods.get(component.foodId) : undefined;
    const categoryMatch = resolveCategory(dataset, component);
    const category = categoryMatch?.range;
    const reference = food
      ? Object.fromEntries(nutrients.map((key) => [key, nutrientRange(food.per100g?.[key])]))
      : category ? Object.fromEntries(nutrients.map((key) => [key, nutrientRange(category[key])])) : null;
    const measure = householdMeasure(dataset, component, food, categoryMatch);
    const enteredQuantity = component.userQuantity ?? null;
    const userQuantity = enteredQuantity?.unit === 'household' && !measure ? null : enteredQuantity;
    const grams = userQuantity?.unit === 'g' ? userQuantity.amount
      : userQuantity?.unit === 'household' && measure ? userQuantity.amount * measure.grams : null;
    if (food || category) matchedCount += 1;
    if (food) exactCount += 1;
    else if (category) categoryCount += 1;
    if (!reference || Object.values(reference).some((amount) => amount === null)) {
      unknownLabels.push(component.label);
      unknownNutritionLabels.push(component.label);
    }
    if (enteredQuantity && enteredQuantity.unit === 'household' && !measure) {
      missingQuantityLabels.push(component.label);
      unresolved.push(`${component.label}：没有本地可靠家用单位换算，请改填克数。`);
    } else if (grams === null) {
      missingQuantityLabels.push(component.label);
    } else if (reference && Object.values(reference).every((amount) => amount !== null)) {
      counted += 1;
      hasApproximateQuantity ||= userQuantity.unit === 'household' && measure.approximate;
      for (const key of nutrients) {
        const nutrient = reference[key];
        if (nutrient === null) {
          totalsComplete[key] = false;
          if (!unknownNutritionLabels.includes(component.label)) unknownNutritionLabels.push(component.label);
          continue;
        }
        totals[key].min += nutrient.min * grams / 100;
        totals[key].max += nutrient.max * grams / 100;
      }
    }
    if (component.uncertainty.length) unresolved.push(...component.uncertainty.map((issue) => `${component.label}：${issue}`));
    const source = food ? {
      provider: 'usda-fdc', fdcId: food.fdcId, dataset: dataset.dataset, sourceUrl: dataset.sourceUrl,
      description: food.description, preparation: component.cookingMethod ?? component.preparation ?? food.preparation,
      per100g: Object.fromEntries(nutrients.map((key) => [key, food.per100g?.[key] ?? null])),
      ...(measure ? { householdMeasure: measure } : {}),
    } : category ? {
      provider: 'local-category', dataset: 'Local generic category ranges v1', categoryId: categoryMatch.id,
      per100gRange: Object.fromEntries(nutrients.map((key) => [key, nutrientRange(category[key])])),
      ...(measure ? { householdMeasure: measure } : {}),
    } : undefined;
    return {
      ...component,
      grams: null,
      quantitySource: 'unknown',
      consumedFraction: null,
      userQuantity,
      ...(measure ? { householdMeasure: measure } : { householdMeasure: null }),
      ...(source ? { source } : { source: null }),
    };
  });
  if (!components.length) unresolved.push('没有识别到可展示营养参考的菜品。');
  const hasNutrients = Object.values(totalsComplete).some(Boolean) && counted > 0;
  const complete = components.length > 0 && counted === components.length && unknownLabels.length === 0
    && missingQuantityLabels.length === 0 && unknownNutritionLabels.length === 0
    && Object.values(totalsComplete).every(Boolean) && categoryCount === 0 && !hasApproximateQuantity && unresolved.length === 0;
  const status = counted === 0 || !hasNutrients ? 'unknown' : complete ? 'estimated' : 'approximate';
  const resultTotals = Object.fromEntries(nutrients.map((key) => [key,
    status === 'unknown' || !totalsComplete[key] ? null : { min: rounded(totals[key].min, 'min'), max: rounded(totals[key].max, 'max') }]));
  const coverage = {
    matched: matchedCount, total: components.length, unknownLabels: [...new Set(unknownLabels)], counted,
    missingQuantityLabels: [...new Set(missingQuantityLabels)], unknownNutritionLabels: [...new Set(unknownNutritionLabels)],
  };
  const sourceProvider = categoryCount && exactCount ? 'mixed' : categoryCount ? 'local-category' : 'usda-fdc';
  const assumptions = [...recognition.assumptions];
  if (counted > 0 && (!complete || missingQuantityLabels.length || unknownNutritionLabels.length)) {
    assumptions.push('显示已填写且可匹配营养数据的菜品小计；未填份量或无法匹配的菜品未计入。');
  }
  const confidenceValues = [recognition.confidence, ...components.map((item) => item.confidence)].filter((value) => typeof value === 'number');
  const confidenceValue = confidenceValues.length ? Math.min(...confidenceValues, status === 'approximate' ? 0.5 : 1) : status === 'estimated' ? 1 : status === 'approximate' ? 0.5 : 0;
  return {
    status, confidence: confidenceValue, coverage, foodName: recognition.foodName, ...resultTotals, components,
    unresolved: [...new Set(unresolved)], assumptions: [...new Set(assumptions)], advice: recognition.advice,
    nutritionSource: {
      provider: sourceProvider,
      dataset: categoryCount ? 'USDA SR Legacy + local generic category ranges v1' : dataset.dataset,
      ...(sourceProvider === 'usda-fdc' || sourceProvider === 'mixed' ? { sourceUrl: dataset.sourceUrl, archiveSha256: dataset.archiveSha256, license: dataset.license } : {}),
      method: 'user-quantity-v2', coverage: complete ? 'complete' : 'incomplete',
    },
  };
}

export function calculateMealNutrition(input, dataset, { mode = 'legacy' } = {}) {
  if (mode === 'user-quantity-v2') return calculateUserQuantityNutrition(input, dataset);
  // Recognition is rebuilt here. Model totals and model provenance are ignored.
  const recognition = validateMealRecognition(input, { strict: false });
  if (!object(dataset) || dataset.provider !== 'usda-fdc' || dataset.license !== 'CC0-1.0'
    || !string(dataset.dataset, 200) || !string(dataset.sourceUrl, 2000)
    || !/^[A-Fa-f0-9]{64}$/.test(dataset.archiveSha256) || !Array.isArray(dataset.foods)) throw new TypeError('Invalid nutrition dataset.');
  const foods = new Map(dataset.foods.map((food) => [food.id, food]));
  const unresolved = [...recognition.unresolved];
  const unknownLabels = [];
  const totals = Object.fromEntries(nutrients.map((key) => [key, { min: 0, max: 0 }]));
  const totalsComplete = Object.fromEntries(nutrients.map((key) => [key, true]));
  let exactCount = 0;
  let categoryCount = 0;
  let calculable = 0;
  let matchedCount = 0;
  // Keep legacy records conservative: before the new scope field existed, a
  // missing eaten fraction meant the meal intake could not be stated. New
  // recognitions explicitly use photo_serving for a whole photographed plate.
  const legacyScope = recognition.estimateScope === undefined;
  const estimateScope = recognition.estimateScope ?? 'consumed_intake';
  const components = recognition.components.map((component) => {
    const food = component.foodId ? foods.get(component.foodId) : undefined;
    const categoryMatch = resolveCategory(dataset, component);
    const category = categoryMatch?.range;
    const quantity = component.grams === null ? null : { min: component.grams.min, max: component.grams.max };
    const fraction = estimateScope === 'photo_serving' ? { min: 1, max: 1 } : component.consumedFraction;
    if (component.uncertainty.length) unresolved.push(...component.uncertainty.map((issue) => `${component.label}：${issue}`));
    if (!food && !category) { unknownLabels.push(component.label); if (component.foodId) unresolved.push(`${component.label}：尚未匹配食材及烹调状态。`); }
    if (component.grams === null) unresolved.push(`${component.label}：重量未知。`);
    if (fraction === null) unresolved.push(`${component.label}：实际食用比例未知。`);
    const categoryRef = category ? Object.fromEntries(nutrients.map((key) => [key, nutrientRange(category[key])])) : null;
    // An exact USDA ID wins. Generic category ranges are a separate fallback
    // for components that have no exact identity; they must not fill holes in
    // an otherwise exact row.
    const ref = food ? Object.fromEntries(nutrients.map((key) => [key, nutrientRange(food.per100g?.[key])])) : categoryRef;
    if (food) {
      exactCount += 1;
    } else if (category) {
      categoryCount += 1;
    }
    if (food || category) matchedCount += 1;
    if (ref && quantity !== null && fraction !== null) {
      calculable += 1;
      for (const key of nutrients) {
        if (ref[key] === null) { totalsComplete[key] = false; unresolved.push(`${component.label}：参考库缺少 ${key}。`); continue; }
        totals[key].min += ref[key].min * quantity.min * fraction.min / 100;
        totals[key].max += ref[key].max * quantity.max * fraction.max / 100;
      }
    }
    if (!food) return category ? { ...component, category: component.category ?? categoryMatch.id, source: { provider: 'local-category', dataset: 'Local generic category ranges v1', categoryId: categoryMatch.id, per100gRange: categoryRef } } : component;
    const per100g = Object.fromEntries(nutrients.map((key) => [key, food.per100g?.[key] ?? null]));
    return { ...component, source: { provider: 'usda-fdc', fdcId: food.fdcId, dataset: dataset.dataset, sourceUrl: dataset.sourceUrl, description: food.description, preparation: component.cookingMethod ?? component.preparation ?? food.preparation, per100g } };
  });
  if (!components.length) unresolved.push('没有可计算的食材记录。');
  // A complete meal can be published as an exact USDA estimate. When only
  // some components are measurable, keep the numeric interval for those
  // components and label the result approximate; unidentified or unweighed
  // components remain in the record and are explicitly excluded from totals.
  // Legacy records without an explicit scope retain the old conservative
  // all-or-nothing behavior so imports cannot silently change meaning.
  const completeMeal = calculable > 0 && calculable === components.length
    && unknownLabels.length === 0 && unresolved.length === 0 && Object.values(totalsComplete).every(Boolean);
  const usableNutrientCount = Object.values(totalsComplete).filter(Boolean).length;
  const canPublish = calculable > 0 && usableNutrientCount > 0 && (!legacyScope || completeMeal);
  const approximate = canPublish && (categoryCount > 0 || !completeMeal);
  const status = !canPublish ? 'unknown' : approximate ? 'approximate' : 'estimated';
  const suppliedConfidence = [recognition.confidence, ...components.map((item) => item.confidence)].filter((value) => typeof value === 'number');
  const baseConfidence = suppliedConfidence.length ? Math.min(...suppliedConfidence) : status === 'estimated' ? 1 : status === 'approximate' ? 0.5 : 0;
  const confidenceValue = Math.max(0, Math.min(status === 'approximate' ? 0.5 : 1, baseConfidence));
  const resultTotals = Object.fromEntries(nutrients.map((key) => [key, status === 'unknown' || !totalsComplete[key] ? null : { min: rounded(totals[key].min, 'min'), max: rounded(totals[key].max, 'max') }]));
  const coverage = { matched: matchedCount, total: components.length, unknownLabels: [...new Set(unknownLabels)] };
  const complete = canPublish && completeMeal;
  const sourceProvider = categoryCount && exactCount ? 'mixed' : categoryCount ? 'local-category' : 'usda-fdc';
  const assumptions = [...recognition.assumptions];
  if (status === 'approximate' && !complete) assumptions.push('本次区间仅包含能按营养目录及份量计算的成分；缺少身份、重量或食用比例的成分未计入。');
  return { status, confidence: confidenceValue, estimateScope, coverage, foodName: recognition.foodName, ...resultTotals,
    components, unresolved: [...new Set(unresolved)], assumptions: [...new Set(assumptions)], advice: recognition.advice,
    nutritionSource: { provider: sourceProvider, dataset: categoryCount ? 'USDA SR Legacy + local generic category ranges v1' : dataset.dataset,
      ...(sourceProvider === 'usda-fdc' || sourceProvider === 'mixed' ? { sourceUrl: dataset.sourceUrl, archiveSha256: dataset.archiveSha256, license: dataset.license } : {}),
      method: 'ingredient-weight-v1', coverage: complete ? 'complete' : 'incomplete' } };
}
