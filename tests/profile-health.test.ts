import assert from 'node:assert/strict';
import test from 'node:test';
import JSZip from 'jszip';
import {
  BMI_SCALE, bmiMarkerRatio, bmiSegmentMarkerRatio, bmiStatus, bmiWeightBreakpoints, calculateProfileHealth, effectiveCalorieTarget,
  formatBmiDisplay, initialCalorieTargetMode, profileAgeGroup, profileAgeReference, profileAgeValidationError, profileFromForm, profileInputNumber,
} from '../src/profile-health';
import { BackupError, createBackupArchive, mergeBackupData, parseBackupArchive, validateAppData } from '../src/backup';
import { LocalRepository, type SnapshotStore } from '../src/local-store';
import { summaryInputSnapshot } from '../src/domain';
import { emptyData, type Profile } from '../src/types';

const ready = (changes: Partial<Profile> = {}) => calculateProfileHealth({ goal: 'health', heightCm: 170, weightKg: 70, ...changes });

test('Chinese adult BMI boundaries classify the raw value before display rounding', () => {
  for (const [bmi, status] of [
    [18.49, '偏瘦'], [18.5, '正常'], [23.96, '正常'], [24, '超重'], [27.96, '超重'], [28, '肥胖'],
  ] as const) {
    const reference = ready({ heightCm: 200, weightKg: bmi * 4 });
    assert.equal(reference.bmi, bmi);
    assert.equal(reference.bmiStatus, status);
  }
  assert.equal(formatBmiDisplay(ready({ heightCm: 200, weightKg: 23.96 * 4 }).bmi!), '23.96');
  for (const value of [NaN, Infinity, -Infinity, 0, -1]) assert.equal(bmiStatus(value), null);
});

test('BMI display keeps threshold-adjacent numbers in their raw category with bounded precision', () => {
  for (const [bmi, display] of [
    [18.4, '18.4'], [18.49, '18.49'], [18.499, '18.499'], [18.4999, '<18.5'], [18.5, '18.5'],
    [23.94, '23.9'], [23.96, '23.96'], [23.999, '23.999'], [23.9999, '<24'], [24, '24.0'],
    [27.96, '27.96'], [27.999, '27.999'], [27.9999, '<28'], [28, '28.0'], [30.1234, '30.1'],
  ] as const) {
    assert.equal(formatBmiDisplay(bmi), display, String(bmi));
    if (!display.startsWith('<')) assert.equal(bmiStatus(Number(display)), bmiStatus(bmi), display);
  }
  for (const boundary of BMI_SCALE.boundaries) assert.equal(formatBmiDisplay(boundary - 1e-10), `<${boundary}`);
  for (const invalid of [NaN, Infinity, -Infinity, 0, -1]) assert.equal(formatBmiDisplay(invalid), '—');
});

test('missing, nonnumeric, nonfinite and unreasonable body data never produce a numerical recommendation', () => {
  for (const changes of [
    { heightCm: undefined }, { weightKg: undefined }, { heightCm: NaN }, { heightCm: Infinity }, { weightKg: -1 },
    { heightCm: 99.9 }, { heightCm: 250.1 }, { weightKg: 19.9 }, { weightKg: 300.1 },
    { heightCm: '170' }, { weightKg: '70' },
  ]) {
    const reference = ready(changes as Partial<Profile>);
    assert.equal(reference.bmi, null, JSON.stringify(changes));
    assert.equal(reference.weight.targetKg, null);
    assert.equal(reference.calories.target, null);
    assert.match(reference.bodyReason!, /待补充/);
  }
  const noGoal = ready({ goal: undefined });
  assert.ok(noGoal.bmi! > 24);
  assert.equal(noGoal.weight.targetKg, null);
  assert.equal(noGoal.calories.target, null);
  assert.deepEqual(ready({ heightCm: 200 }).normalWeightKg, { min: 74, max: 95.6 });
});

test('normal health goal maintains current weight and normal fat-loss stays away from the lower boundary', () => {
  const healthy = ready({ heightCm: 180, weightKg: 72 });
  assert.equal(healthy.weight.targetKg, 72);
  assert.equal(healthy.weight.targetBmi, healthy.bmi);
  assert.match(healthy.weight.detail, /维持当前体重/);
  const loss = ready({ heightCm: 180, weightKg: 72, goal: 'fat-loss' });
  assert.equal(loss.weight.targetKg, 72 * 0.98);
  const nearLower = ready({ heightCm: 200, weightKg: 74.4, goal: 'fat-loss' });
  assert.equal(nearLower.weight.targetKg, 74.4);
  assert.equal(nearLower.calories.target, 2250);
  assert.match(nearLower.weight.detail, /优先维持/);
  assert.match(nearLower.calories.detail, /不建议继续减少/);
});

test('underweight fat-loss recommends no further weight loss or energy deficit', () => {
  const reference = ready({ weightKg: 50, goal: 'fat-loss' });
  assert.equal(reference.weight.targetKg, 52.5);
  assert.equal(reference.weight.targetStatus, '偏瘦');
  assert.equal(reference.calories.target, 1600);
  assert.match(reference.weight.detail, /不建议继续减重/);
  assert.match(reference.calories.formula!, /× 1.05/);
  assert.match(reference.calories.detail, /不建议热量缺口/);
  assert.equal(ready({ heightCm: 200, weightKg: 73, goal: 'fat-loss' }).weight.targetKg, 74);
});

test('stage weight suggestions remain conservative and report a target that is still overweight or obese', () => {
  const obese = ready({ heightCm: 170, weightKg: 100, goal: 'fat-loss' });
  assert.equal(obese.weight.targetKg, 95);
  assert.equal(obese.weight.targetStatus, '肥胖');
  const overweight = ready({ heightCm: 200, weightKg: 104, goal: 'fat-loss' });
  assert.equal(overweight.weight.targetKg, 98.8);
  assert.equal(overweight.weight.targetStatus, '超重');
  const nearUpper = ready({ heightCm: 200, weightKg: 96, goal: 'health' });
  assert.equal(nearUpper.weight.targetKg, 95.6);
  assert.equal(nearUpper.weight.targetStatus, '正常');
  for (const weightKg of [60, 160]) {
    const reference = ready({ heightCm: 200, weightKg });
    assert.equal(reference.weight.targetKg, null);
    assert.match(reference.weight.detail, /超出阶段/);
  }
});

test('muscle gain caps normal weight changes and does not require overweight adults to gain weight', () => {
  assert.equal(ready({ heightCm: 200, weightKg: 80, goal: 'muscle-gain' }).weight.targetKg, 81.6);
  assert.equal(ready({ heightCm: 200, weightKg: 95, goal: 'muscle-gain' }).weight.targetKg, 95.6);
  const upperNormal = ready({ heightCm: 200, weightKg: 95.8, goal: 'muscle-gain' });
  assert.equal(upperNormal.bmiStatus, '正常');
  assert.equal(upperNormal.weight.targetKg, 95.8);
  for (const weightKg of [80, 100]) {
    const reference = ready({ heightCm: 170, weightKg, goal: 'muscle-gain' });
    assert.equal(reference.weight.targetKg, weightKg);
    assert.match(reference.weight.detail, /不能区分肌肉和脂肪/);
  }
  const reference = ready({ heightCm: 180, weightKg: 100, goal: 'muscle-gain' });
  assert.equal(reference.calories.target, 3000);
  assert.doesNotMatch(reference.calories.formula!, /1.05/);
});

test('calorie starting values use a 30 kcal/kg baseline, mild goal factors and 50 kcal rounding', () => {
  assert.equal(ready({ heightCm: 180 }).calories.target, 2100);
  assert.equal(ready({ heightCm: 180, goal: 'fat-loss' }).calories.target, 1900);
  assert.equal(ready({ heightCm: 180, goal: 'muscle-gain' }).calories.target, 2200);
  assert.match(ready({ heightCm: 180, goal: 'fat-loss' }).calories.formula!, /70 kg × 30 kcal\/kg\/日 × 0.9.*50 kcal/);
  assert.equal(ready({ heightCm: 140, weightKg: 40 }).calories.target, 1200);
  assert.equal(ready({ heightCm: 210, weightKg: 40 }).calories.target, null); // BMI outside reference.
});

test('unreliable calorie inputs or outputs are declined explicitly instead of being clamped', () => {
  for (const changes of [
    { heightCm: 139 }, { heightCm: 211 }, { weightKg: 39 }, { weightKg: 121 },
    { heightCm: 200, weightKg: 60 }, { heightCm: 160, weightKg: 90 },
  ]) {
    const reference = ready(changes);
    assert.equal(reference.calories.target, null);
    assert.match(reference.calories.detail, /超出热量自动建议范围/);
  }
  for (const changes of [
    { heightCm: 140, weightKg: 40, goal: 'fat-loss' as const },
    { heightCm: 180, weightKg: 101 },
    { heightCm: 210, weightKg: 120 },
  ]) {
    const reference = ready(changes);
    assert.equal(reference.calories.target, null);
    assert.match(reference.calories.detail, /未作上下限截断/);
  }
});

test('BMI scale preserves actual values and clamps every finite marker to its display range', () => {
  assert.equal(bmiMarkerRatio(5), 0);
  assert.equal(bmiMarkerRatio(BMI_SCALE.min), 0);
  assert.equal(bmiMarkerRatio(BMI_SCALE.max), 1);
  assert.equal(bmiMarkerRatio(100), 1);
  assert.equal(bmiMarkerRatio(25), 0.5);
  for (const invalid of [NaN, Infinity, -Infinity, 0, -1]) assert.equal(bmiMarkerRatio(invalid), null);
  for (const value of [5, 14, 18.5, 24, 28, 36, 80]) {
    assert.ok(bmiMarkerRatio(value)! >= 0 && bmiMarkerRatio(value)! <= 1);
  }
});

test('display bands put each Chinese category boundary at its own edge and clamp extreme markers', () => {
  for (const [bmi, ratio] of [[14, 0], [18.5, 0.25], [24, 0.5], [28, 0.75], [36, 1], [5, 0], [80, 1]] as const) {
    assert.equal(bmiSegmentMarkerRatio(bmi), ratio);
  }
  assert.equal(bmiSegmentMarkerRatio((18.5 + 24) / 2), 0.375);
  assert.equal(bmiSegmentMarkerRatio((24 + 28) / 2), 0.625);
  assert.ok(bmiSegmentMarkerRatio(23.96)! < 0.5);
  assert.ok(bmiSegmentMarkerRatio(23.9999)! < 0.5);
  let previous = 0;
  for (let bmi = 5; bmi <= 80; bmi += 0.1) {
    const ratio = bmiSegmentMarkerRatio(bmi)!;
    assert.ok(ratio >= previous && ratio >= 0 && ratio <= 1);
    previous = ratio;
  }
  for (const invalid of [NaN, Infinity, -Infinity, 0, -1]) assert.equal(bmiSegmentMarkerRatio(invalid), null);
});

test('display kg boundaries derive from the current valid height without changing normal reference or classification', () => {
  assert.deepEqual(bmiWeightBreakpoints(200), [74, 96, 112]);
  assert.deepEqual(bmiWeightBreakpoints(250), [115.625, 150, 175]);
  for (const heightCm of [100, 140, 165, 180, 210, 250]) {
    const thresholds = bmiWeightBreakpoints(heightCm)!;
    assert.equal(thresholds.length, 3);
    for (let index = 0; index < thresholds.length; index++) {
      assert.equal(thresholds[index], BMI_SCALE.boundaries[index] * (heightCm / 100) ** 2);
    }
  }
  for (const invalid of [undefined, null, '180', NaN, Infinity, 0, 99.9, 250.1]) assert.equal(bmiWeightBreakpoints(invalid), null);
  assert.deepEqual(ready({ heightCm: 200 }).normalWeightKg, { min: 74, max: 95.6 });
  assert.equal(ready({ heightCm: 200, weightKg: 95.84 }).bmiStatus, '正常');
});

test('numeric parsing rejects hexadecimal, nonnumeric and nonfinite text without treating it as empty', () => {
  assert.equal(profileInputNumber('  '), undefined);
  assert.equal(profileInputNumber('173.5'), 173.5);
  assert.equal(profileInputNumber('.5'), 0.5);
  for (const value of ['abc', 'NaN', 'Infinity', '0x70', '1e4', '1,700']) assert.ok(Number.isNaN(profileInputNumber(value)));
  assert.throws(() => profileFromForm({ goal: 'none', height: 'abc', weight: '', calories: '', calorieMode: 'manual' }), /身高/);
});

test('legacy manual numeric goals survive changing body inputs and do not gain a source field', () => {
  const initial = { goal: 'fat-loss' as const, heightCm: 170, weightKg: 70, calorieTarget: 2100 };
  assert.equal(initialCalorieTargetMode(initial), 'manual');
  assert.equal(effectiveCalorieTarget({ ...initial, weightKg: 80, goal: 'muscle-gain' }, 'manual', '2100'), '2100');
  const saved = profileFromForm({ goal: 'muscle-gain', height: '170', weight: '80', calories: '2100', calorieMode: 'manual' });
  assert.deepEqual(JSON.parse(JSON.stringify(saved)), { goal: 'muscle-gain', heightCm: 170, weightKg: 80, calorieTarget: 2100 });
  assert.equal(Object.hasOwn(saved, 'calorieTargetSource'), false);
  assert.equal(initialCalorieTargetMode({ calorieTarget: 0 }), 'manual'); // Never silently overwrite even an old unusable manual value.
});

test('automatic mode recomputes on each edit and explicitly empty manual mode survives reopening', () => {
  assert.equal(initialCalorieTargetMode({}), 'recommended');
  const form = { goal: 'health' as const, height: '180', weight: '70', calories: '9999', calorieMode: 'recommended' as const };
  assert.equal(profileFromForm(form).calorieTarget, 2100);
  assert.equal(profileFromForm({ ...form, weight: '80' }).calorieTarget, 2400);
  assert.equal(profileFromForm({ ...form, goal: 'fat-loss' }).calorieTarget, 1900);
  const missing = profileFromForm({ ...form, goal: 'none' });
  assert.equal(missing.calorieTarget, undefined);
  assert.equal(missing.calorieTargetSource, 'recommended');
  const manualEmpty = profileFromForm({ ...form, calories: '', calorieMode: 'manual' });
  assert.equal(manualEmpty.calorieTarget, undefined);
  assert.equal(manualEmpty.calorieTargetSource, 'manual');
  assert.equal(initialCalorieTargetMode(manualEmpty), 'manual');
  assert.equal(effectiveCalorieTarget(manualEmpty, initialCalorieTargetMode(manualEmpty), ''), '');
  assert.equal(profileFromForm({ ...form, weight: '200' }).calorieTarget, undefined);
});

test('age applicability groups use optional completed years with explicit 17/18 and 64/65 product boundaries', () => {
  for (const [ageYears, group] of [
    [undefined, 'unknown'], [1, 'minor'], [17, 'minor'], [18, 'adult'], [64, 'adult'],
    [65, 'older-adult'], [120, 'older-adult'],
  ] as const) {
    assert.equal(profileAgeGroup(ageYears), group);
    assert.equal(profileAgeValidationError(ageYears), null);
    assert.equal(profileAgeReference(ageYears).adultApplicable, group === 'unknown' || group === 'adult');
  }
  for (const invalid of [0, -1, 17.5, 120.1, 121, NaN, Infinity, -Infinity, '18', null, true]) {
    assert.equal(profileAgeGroup(invalid), 'invalid');
    assert.equal(profileAgeReference(invalid).adultApplicable, false);
    assert.match(profileAgeValidationError(invalid)!, /年龄/);
  }
  assert.match(profileAgeValidationError(17.5)!, /整数周岁.*小数/);
  assert.match(profileAgeValidationError(-1)!, /1–120 岁之间/);
  assert.equal(profileAgeReference(undefined).label, '年龄未填写 · 成人参考');
});

test('sex and adult age do not change existing BMI formula, classification, stage weight or calories', () => {
  const { age: _age, ...legacy } = ready({ heightCm: 200, weightKg: 95.84, goal: 'fat-loss' });
  for (const ageYears of [undefined, 18, 30, 64]) {
    for (const sex of [undefined, 'male', 'female'] as const) {
      const { age, ...current } = ready({ heightCm: 200, weightKg: 95.84, goal: 'fat-loss', sex, ageYears });
      assert.equal(age.adultApplicable, true);
      assert.deepEqual(current, legacy);
      assert.equal(formatBmiDisplay(current.bmi!), '23.96');
      assert.equal(current.bmiStatus, '正常');
      assert.equal(current.calories.target, 2600);
    }
  }
});

test('known non-adult and invalid ages retain valid BMI numbers but suppress all ordinary adult conclusions', () => {
  for (const ageYears of [1, 17, 65, 120, 0, -1, 17.5, 121, NaN, Infinity]) {
    const reference = ready({ heightCm: 180, weightKg: 70, ageYears });
    assert.equal(reference.bmi, 70 / 1.8 ** 2);
    assert.equal(reference.bmiStatus, null);
    assert.equal(reference.normalWeightKg, null);
    assert.deepEqual([reference.weight.targetKg, reference.weight.targetBmi, reference.weight.targetStatus], [null, null, null]);
    assert.equal(reference.calories.target, null);
    assert.equal(reference.calories.formula, null);
    assert.match(reference.bodyReason!, /未成年|老年|年龄/);
    assert.equal(effectiveCalorieTarget({ goal: 'health', heightCm: 180, weightKg: 70, ageYears }, 'recommended', '2100'), '');
    assert.equal(effectiveCalorieTarget({ goal: 'health', ageYears }, 'manual', '1980'), '1980');
  }
  assert.match(ready({ ageYears: 17 }).bodyReason!, /未提供儿童生长曲线/);
  assert.match(ready({ ageYears: 65 }).bodyReason!, /未提供老年专用模型/);
  const invalidPreview = ready({ ageYears: profileInputNumber('abc') });
  assert.equal(invalidPreview.age.group, 'invalid');
  assert.equal(invalidPreview.calories.target, null);
});

test('optional sex and age save, change and clear without introducing defaults, and invalid age cannot save in either calorie mode', () => {
  const base = { goal: 'health' as const, height: '180', weight: '70', calories: '1980', calorieMode: 'manual' as const };
  for (const sex of ['male', 'female'] as const) {
    const saved = profileFromForm({ ...base, sex, age: '65' });
    assert.equal(saved.sex, sex);
    assert.equal(saved.ageYears, 65);
    assert.equal(saved.calorieTarget, 1980);
  }
  for (const input of [base, { ...base, sex: 'none' as const, age: '  ' }]) {
    const cleared = profileFromForm(input);
    assert.equal(Object.hasOwn(cleared, 'sex'), false);
    assert.equal(Object.hasOwn(cleared, 'ageYears'), false);
    assert.deepEqual(JSON.parse(JSON.stringify(cleared)), { goal: 'health', heightCm: 180, weightKg: 70, calorieTarget: 1980 });
  }
  for (const calorieMode of ['manual', 'recommended'] as const) {
    for (const age of ['abc', 'NaN', 'Infinity', '-Infinity', '-1', '0', '17.5', '121', '0x12', '1e1']) {
      assert.throws(() => profileFromForm({ ...base, calorieMode, age }), /年龄/, `${calorieMode}: ${age}`);
    }
  }
  assert.throws(() => profileFromForm({ ...base, sex: 'other' as Profile['sex'] }), /性别/);
  for (const age of ['17', '65']) assert.equal(profileFromForm({ ...base, calorieMode: 'recommended', age }).calorieTarget, undefined);
  for (const age of ['', '18', '64']) assert.equal(profileFromForm({ ...base, calorieMode: 'recommended', age }).calorieTarget, 2100);
});

test('old profiles and both source modes roundtrip strict backup and summary snapshot schemas', async () => {
  for (const profile of [
    { goal: 'health', heightCm: 180, weightKg: 70, calorieTarget: 2100 },
    { goal: 'health', heightCm: 180, weightKg: 70, calorieTarget: 2100, calorieTargetSource: 'recommended' },
    { goal: 'fat-loss', heightCm: 170, weightKg: 70, calorieTargetSource: 'manual' },
    { sex: 'male', ageYears: 17, heightCm: 180, weightKg: 70, calorieTarget: 1980 },
    { sex: 'female', ageYears: 65, calorieTargetSource: 'recommended' },
    { ageYears: 18, calorieTarget: 2100, calorieTargetSource: 'recommended' },
  ] satisfies Profile[]) {
    const data = { ...emptyData(), profile };
    data.summaries.push({
      id: 'profile-source-summary', date: '2026-10-22', markdown: 'saved', sourceVersion: 0,
      status: 'current', createdAt: '2026-10-22T00:00:00Z', source: 'ai', model: 'mock',
      inputSnapshot: summaryInputSnapshot(data, '2026-10-22'),
    });
    const bytes = await createBackupArchive(data, []);
    const restored = await parseBackupArchive(bytes);
    assert.deepEqual(restored.data.profile, profile);
    assert.deepEqual(restored.data.summaries[0].inputSnapshot!.profile, profile);
    const zip = await JSZip.loadAsync(bytes);
    const readme = await zip.file('README.md')!.async('string');
    for (const field of ['calorieTargetSource', 'sex', 'ageYears', 'inputSnapshot.profile', 'product applicability groups']) assert.ok(readme.includes(field));
    assert.equal(Object.hasOwn(restored.data.profile, 'sex'), Object.hasOwn(profile, 'sex'));
    assert.equal(Object.hasOwn(restored.data.profile, 'ageYears'), Object.hasOwn(profile, 'ageYears'));
  }
  for (const calorieTargetSource of ['unknown', 'auto', true, 1]) {
    assert.throws(() => validateAppData({ ...emptyData(), profile: { calorieTargetSource } }));
  }
  assert.throws(() => validateAppData({ ...emptyData(), profile: { unsupportedField: 1 } }));
});

test('strict backup rejects invalid sex and age in both current profile and historical input snapshot without persisting derived groups', () => {
  const invalidFields = [
    ...['unknown', 'none', 'other', '', true, 1, null].map((sex) => ({ sex })),
    ...[0, -1, 17.5, 121, NaN, Infinity, -Infinity, '18', null, true].map((ageYears) => ({ ageYears })),
    { ageGroup: 'adult' },
  ];
  for (const fields of invalidFields) {
    assert.throws(() => validateAppData({ ...emptyData(), profile: fields }), JSON.stringify(fields));
    assert.throws(() => validateAppData({ ...emptyData(), summaries: [{
      id: 'invalid-profile-snapshot', date: '2026-10-22', markdown: 'saved', sourceVersion: 0,
      status: 'current', createdAt: '2026-10-22T00:00:00Z',
      inputSnapshot: { date: '2026-10-22', profile: fields, summary: 'snapshot', recordVersions: [] },
    }] }), JSON.stringify(fields));
  }
});

test('recommended and deliberately empty targets persist atomically while prior health records stay unchanged', async () => {
  const saved = new Map<string, string>();
  const store: SnapshotStore = {
    getItem: async (key) => saved.get(key) ?? null,
    setItem: async (key, value) => { saved.set(key, value); },
    removeItem: async (key) => { saved.delete(key); },
  };
  const repository = new LocalRepository(store);
  const data = emptyData();
  data.meals.push({ id: 'prior-meal', type: 'meal', createdAt: '2026-10-22T00:00:00Z', occurredAt: '2026-10-22T00:00:00Z', mealType: '午餐', foodName: '原记录', portion: '100g', note: '', source: 'manual', estimateStatus: 'estimated', estimate: { calories: 250, protein: 10, carbs: 30, fat: 5 } });
  const originalMeals = structuredClone(data.meals);
  for (const calorieMode of ['recommended', 'manual'] as const) {
    data.profile = profileFromForm({ goal: 'health', sex: 'female', age: '30', height: '180', weight: '70', calories: '', calorieMode });
    await repository.commit({ storageVersion: 1, data, drafts: {} });
    const read = await repository.read();
    assert.equal(read.data.profile.calorieTargetSource, calorieMode);
    assert.equal(read.data.profile.calorieTarget, calorieMode === 'recommended' ? 2100 : undefined);
    assert.equal(read.data.profile.sex, 'female');
    assert.equal(read.data.profile.ageYears, 30);
    assert.deepEqual(read.data.meals, originalMeals);
  }
});

test('backup union preserves optional demographics and reports conflicting sex or age instead of overwriting', () => {
  const conflict = (error: unknown) => error instanceof BackupError && error.code === 'import-conflict';
  const base = { ...emptyData(), profile: { sex: 'female' as const, ageYears: 30 } };
  const before = structuredClone(base);
  for (const profile of [{ sex: 'male' as const }, { ageYears: 31 }]) {
    const incoming = { ...emptyData(), profile };
    assert.throws(() => mergeBackupData(base, incoming), conflict);
    assert.throws(() => mergeBackupData(incoming, base), conflict);
  }
  assert.deepEqual(base, before);
  assert.deepEqual(mergeBackupData(emptyData(), base).profile, base.profile);
  assert.deepEqual(mergeBackupData(base, emptyData()).profile, base.profile);
  assert.deepEqual(mergeBackupData(base, base).profile, base.profile);
  assert.deepEqual(mergeBackupData({ ...emptyData(), profile: { sex: 'female' } }, { ...emptyData(), profile: { ageYears: 30 } }).profile, base.profile);
});

test('backup union treats manual and automatic target intent as one fact and preserves an explicitly empty manual target', () => {
  const manual = { ...emptyData(), profile: { calorieTarget: 2100 } };
  const recommended = { ...emptyData(), profile: { calorieTarget: 2100, calorieTargetSource: 'recommended' as const } };
  const emptyManual = { ...emptyData(), profile: { calorieTargetSource: 'manual' as const } };
  const conflict = (error: unknown) => error instanceof BackupError && error.code === 'import-conflict';
  const before = structuredClone({ manual, recommended, emptyManual });
  assert.throws(() => mergeBackupData(manual, recommended), conflict);
  assert.throws(() => mergeBackupData(recommended, manual), conflict);
  assert.throws(() => mergeBackupData(manual, emptyManual), conflict);
  assert.throws(() => mergeBackupData(emptyManual, manual), conflict);
  assert.throws(() => mergeBackupData(recommended, emptyManual), conflict);
  assert.deepEqual({ manual, recommended, emptyManual }, before);
  assert.deepEqual(mergeBackupData(emptyData(), recommended).profile, recommended.profile);
  assert.deepEqual(mergeBackupData(emptyData(), emptyManual).profile, emptyManual.profile);
  assert.deepEqual(mergeBackupData(emptyManual, emptyManual).profile, emptyManual.profile);
  assert.deepEqual(mergeBackupData(manual, manual).profile, manual.profile);
});
