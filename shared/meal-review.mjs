// Adaptive meal-review decision, shared by the app's direct provider and the optional gateway.
import { hasMealIdentityConflict, preservesMealComponents } from './nutrition.mjs';

const LOW_CONFIDENCE = 0.65;
const SAME_REGION = 0.65;
const NEAR_REGION = 0.35;
const CRITICAL_UNRESOLVED = /重复|身份(?:待确认|不明|不确定|冲突|无法确认)|(?:菜品|食材|菜名|种类).*(?:无法识别|无法确认|无法辨认|待确认|不明|不确定|冲突|疑似|看不清)|无法(?:识别|辨认).*(?:菜品|食材)|duplicate|identity|(?:dish|food|ingredient).*(?:ambiguous|conflict|uncertain)/i;

function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null; }
function components(value) { return Array.isArray(object(value)?.components) ? value.components : []; }
function normalizedLabel(value) {
  return typeof value === 'string' ? value.normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '') : '';
}
function sameLabel(left, right) {
  const label = normalizedLabel(left?.label);
  return label !== '' && label === normalizedLabel(right?.label);
}
function validRegion(region) {
  return Boolean(object(region)) && ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(region[key]));
}
function overlap(left, right) {
  if (!validRegion(left) || !validRegion(right)) return 0;
  const width = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
  const height = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
  const intersection = width * height;
  const union = left.width * left.height + right.width * right.height - intersection;
  return union > 0 ? intersection / union : 0;
}

function reviewReasons(value) {
  const row = object(value);
  if (!row) return [];
  const reasons = new Set();
  const rows = components(value);
  const confidence = [row.confidence, ...rows.map((item) => item?.confidence)].filter((item) => Number.isFinite(item) && item >= 0 && item <= 1);
  if (confidence.some((item) => item < LOW_CONFIDENCE)) reasons.add('low_confidence');
  const unresolved = Array.isArray(row.unresolved) ? row.unresolved.filter((item) => typeof item === 'string') : [];
  if (unresolved.some((item) => CRITICAL_UNRESOLVED.test(item))) reasons.add('critical_unresolved');
  if (rows.some(hasMealIdentityConflict)) reasons.add('identity_conflict');
  for (let i = 0; i < rows.length; i += 1) for (let j = i + 1; j < rows.length; j += 1) {
    const left = rows[i], right = rows[j];
    const sameFood = Boolean(left?.foodId && left.foodId === right?.foodId);
    if (sameLabel(left, right) || (sameFood && overlap(left?.region, right?.region) >= NEAR_REGION)) reasons.add('duplicate_components');
    if (overlap(left?.region, right?.region) >= SAME_REGION && left?.foodId && right?.foodId && left.foodId !== right.foodId) reasons.add('overlapping_conflict');
  }
  return [...reasons];
}

/** Up to four suspicious components; without regions they can only be reviewed when the caller keeps whole photos. */
function reviewIndices(value, includeWithoutRegions) {
  const rows = components(value);
  const indices = new Set();
  rows.forEach((item, index) => {
    if ((Number.isFinite(item?.confidence) && item.confidence < LOW_CONFIDENCE) || hasMealIdentityConflict(item)) indices.add(index);
    for (let other = index + 1; other < rows.length; other += 1) {
      if (sameLabel(item, rows[other]) || overlap(item?.region, rows[other]?.region) >= SAME_REGION) { indices.add(index); indices.add(other); }
    }
  });
  if (!indices.size) rows.forEach((item, index) => { if (item?.region) indices.add(index); });
  return [...indices].filter((index) => includeWithoutRegions || validRegion(rows[index]?.region)).slice(0, 4);
}

function reviewRegions(value, indices) {
  const rows = components(value);
  return indices.map((index) => rows[index]?.region).filter(validRegion)
    .map((region) => ({ x: region.x, y: region.y, width: region.width, height: region.height }));
}

function materiallyConflicts(initial, review, allowUncertainIdentityChanges) {
  if (!preservesMealComponents(initial, review, { allowUncertainIdentityChanges })) return true;
  const first = components(initial), second = components(review);
  for (const left of first) {
    const match = second.find((right) => overlap(left?.region, right?.region) >= NEAR_REGION
      || normalizedLabel(left?.label) === normalizedLabel(right?.label)
      || Boolean(left?.foodId && left.foodId === right?.foodId));
    if (!match) continue;
    // A review can rewrite an ambiguous label while keeping the same visual
    // dish. Only two different resolved IDs require another merge pass.
    const identityDiffers = Boolean(left?.foodId && match?.foodId && left.foodId !== match.foodId);
    const confidenceGap = Math.abs((left?.confidence ?? 0.5) - (match?.confidence ?? 0.5));
    if (identityDiffers && confidenceGap < 0.25) return true;
  }
  return Math.abs(first.length - second.length) >= 2;
}

/** Pure, UI-independent adaptive review decision. */
export function decideMealReview(initial, review, hasPhotos = true, allowUncertainIdentityChanges = false) {
  if (!hasPhotos) return null;
  if (review === undefined) {
    const reasons = reviewReasons(initial);
    if (!reasons.length) return null;
    const componentIndices = reviewIndices(initial, allowUncertainIdentityChanges);
    return { stage: 'crop_review', reasons, componentIndices, regions: reviewRegions(initial, componentIndices) };
  }
  if (!materiallyConflicts(initial, review, allowUncertainIdentityChanges)) return null;
  const reasons = [...new Set([...reviewReasons(review), 'review_conflict'])];
  const componentIndices = reviewIndices(review, allowUncertainIdentityChanges);
  return { stage: 'final_merge', reasons, componentIndices, regions: reviewRegions(review, componentIndices) };
}
