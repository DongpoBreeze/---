import React, { useEffect, useRef, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import type { AnalysisVersion, MealAnalysis, MealComponent, MealRecord, NutritionSource, NutrientRange } from "../types";
import { calculateMealNutrition, catalogFoods, correctionComponent, nutritionDataset, searchCatalogFoods, type CatalogFood } from "../nutrition";
import { resolveAiHouseholdMeasure } from "../../shared/nutrition.mjs";
import { createCorrectionSaveGate, fractionToPercent } from "../nutrition-correction";
import { buildMealReviewAnalysis, createMealReviewRows, updateMealReviewRow } from "../meal-review";
import { uid } from "../domain";
import { Banner, CheckRow, Choice, Field, Legend, SmallButton, useBaseStyles } from "./components";
import { errorText, localDateTime, nutritionRangeLabel } from "./format";
import { radius, space, type ThemeTokens } from "./theme";
import { useTheme, useThemedStyles } from "./theme-provider";
import type { SaveNutritionCorrection } from "./app-types";

function Macro({ label, value, unit, nutrient }: { label: string; value: NutrientRange | null | undefined; unit: string; nutrient: "protein" | "carbs" | "fat" }) {
  const st = useThemedStyles(createStyles);
  const known = Boolean(value);
  return (
    <View style={st.macro}>
      <Text style={st.macroLabel}>{label}</Text>
      <Text style={[st.macroValue, !known && st.macroUnknown]}>{known ? `约 ${nutritionRangeLabel(value, nutrient)}` : "未知"}</Text>
      <Text style={st.macroUnit}>{known ? unit : "未估算"}</Text>
    </View>
  );
}

function referenceRange(value: number | NutrientRange | null | undefined): NutrientRange | null {
  if (typeof value === "number") return { min: value, max: value };
  return value ?? null;
}

function confidenceLabel(confidence: number | undefined) {
  if (confidence === undefined) return "未知";
  const level = confidence >= 0.8 ? "高" : confidence >= 0.55 ? "中" : "低";
  return `${level}（${Math.round(confidence * 100)}%）`;
}

function basisLabel(value: MealComponent["estimationBasis"] | MealComponent["estimateBasis"]) {
  const labels: Record<string, string> = {
    user_weight: "用户称重", visual_portion: "视觉份量估算", photo_serving: "照片整份",
    consumed_intake: "实际摄入", usda_exact: "USDA 食材数据", category_range: "通用类别区间", unknown: "估算依据未知",
  };
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return values.map((item) => labels[item] ?? item).join("、");
}

function cookingLabel(component: MealComponent) {
  return component.cookingMethod ?? component.preparation
    ?? (component.source?.provider !== "model" ? component.source?.preparation : undefined);
}

function nutritionSourceLabel(provider: NutritionSource["provider"]) {
  if (provider === "usda-fdc") return "USDA 食品数据库";
  if (provider === "local-category") return "本地通用类别区间";
  if (provider === "mixed") return "多来源营养参考";
  if (provider === "manual") return "手动记录";
  return "AI 每 100 g 估值";
}

function componentSourceLabel(component: MealComponent) {
  if (component.userNutritionPer100g !== undefined)
    return component.userNutritionPer100g === null ? "营养参考未知" : "用户填写的每 100 g 营养参考";
  const source = component.source;
  if (source?.provider === "model") return source.method === "category" ? "AI按类别近似估算" : "AI按典型配方估算";
  if (source?.provider === "usda-fdc") return "USDA 食品数据库";
  if (source?.provider === "local-category") return "本地通用类别区间";
  return "营养参考未知";
}

function reliableHouseholdMeasure(component: MealComponent) {
  return resolveAiHouseholdMeasure(nutritionDataset, component);
}

/** Production compact rows show only dish, nutrition and quantity fields. */
export function MealNutritionReference({ component, compact = false }: { component: MealComponent; compact?: boolean }) {
  const base = useBaseStyles();
  const st = useThemedStyles(createStyles);
  const source = component.source;
  const per100 = component.userNutritionPer100g !== undefined ? component.userNutritionPer100g
    : component.nutritionReferenceStale ? null
      : source?.per100gRange ?? (source?.provider !== "model" ? source?.per100g : undefined);
  const measure = reliableHouseholdMeasure(component);
  if (compact) {
    const label = source || component.userNutritionPer100g ? component.label : "待确认菜品";
    const cooking = cookingLabel(component);
    return <View style={st.referenceRow}>
      <Text style={st.referenceTitle}>{label}</Text>
      {cooking ? <Text style={base.helper}>做法：{cooking}</Text> : null}
      {per100 ? <Text style={base.helper}>
        每 100 g：热量 {nutritionRangeLabel(referenceRange(per100.calories), "calories", " kcal")} · 蛋白质 {nutritionRangeLabel(referenceRange(per100.protein), "protein", " g")} · 碳水 {nutritionRangeLabel(referenceRange(per100.carbs), "carbs", " g")} · 脂肪 {nutritionRangeLabel(referenceRange(per100.fat), "fat", " g")}
      </Text> : <Text style={base.helper}>每 100 g：—</Text>}
      {measure ? <Text style={base.helper}>参考份数：{measure.label} ≈ {measure.grams} g</Text> : null}
      {component.userQuantity ? <Text style={base.helper}>{component.userQuantity.origin === 'estimated' ? '估计食用量' : '已填数量'}：{component.userQuantity.amount} {component.userQuantity.unit === "g" ? "g" : `× ${measure?.label ?? "家用单位"}`}</Text> : null}
    </View>;
  }
  return <View style={st.referenceRow}>
    <Text style={st.referenceTitle}>{component.label}</Text>
    <Text style={base.helper}>来源：{componentSourceLabel(component)}</Text>
    {source?.provider === "model" && component.userNutritionPer100g === undefined && <Text style={base.helper}>营养置信度：{confidenceLabel(source.confidence)}</Text>}
    {per100 ? <Text style={base.helper}>
      {source?.provider === "model" ? "每 100 g 可食用成品" : "每 100 g"}：热量 {nutritionRangeLabel(referenceRange(per100.calories), "calories", " kcal")} · 蛋白质 {nutritionRangeLabel(referenceRange(per100.protein), "protein", " g")} · 碳水 {nutritionRangeLabel(referenceRange(per100.carbs), "carbs", " g")} · 脂肪 {nutritionRangeLabel(referenceRange(per100.fat), "fat", " g")}
    </Text> : <Text style={base.helper}>营养参考未知，当前不计入小计。</Text>}
    {measure && <Text style={base.helper}>本地家用换算：{measure.label} ≈ {measure.grams} g</Text>}
    {component.userQuantity && <Text style={base.helper}>{component.userQuantity.origin === 'estimated' ? '估计食用量' : '用户食用量'}：{component.userQuantity.amount} {component.userQuantity.unit === "g" ? "g" : `× ${measure?.label ?? "家用单位"}`}</Text>}
    {component.nutritionReferenceStale && component.userNutritionPer100g == null && <Text style={st.warn}>旧参考已失效：菜名或做法已修改，请补充新的每 100 g 参考。</Text>}
  </View>;
}

export function MealNutritionBasis({ component }: { component: MealComponent }) {
  const base = useBaseStyles();
  const st = useThemedStyles(createStyles);
  const source = component.source;
  return <View style={st.component}>
    <Text style={st.componentText}>
      菜品：{component.label}{component.userQuantity ? ` · ${component.userQuantity.origin === 'estimated' ? '参考估计' : '用户填写'} ${component.userQuantity.amount} ${component.userQuantity.unit === "g" ? "g" : `× ${reliableHouseholdMeasure(component)?.label ?? "家用单位"}`}` : " · 尚未填写数量"}
      {cookingLabel(component) ? ` · 烹调：${cookingLabel(component)}` : ""}
      {` · 识别置信度：${confidenceLabel(component.confidence)}`}
    </Text>
    <Text style={base.helper}>来源：{componentSourceLabel(component)}</Text>
    {source?.provider === "model" ? <>
      <Text style={base.helper}>营养置信度：{confidenceLabel(source.confidence)}</Text>
      <Text style={base.helper}>配方依据：{source.recipeBasis}</Text>
      {source.assumptions?.map((assumption, index) => <Text key={`recipe-${index}`} style={base.helper}>营养假设：{assumption}</Text>)}
      <Text style={base.helper}>生成模型：{source.model}{source.reasoningEffort ? ` · 推理强度 ${source.reasoningEffort}` : ""} · {localDateTime(source.generatedAt)}</Text>
    </> : <>
      <Text style={base.helper}>食用比例：{fractionToPercent(component.consumedFraction ?? component.eatenFraction ?? component.edibleFraction)}</Text>
      {basisLabel(component.estimationBasis ?? component.estimateBasis) ? <Text style={base.helper}>估算方式：{basisLabel(component.estimationBasis ?? component.estimateBasis)}</Text> : null}
      {source?.provider === "usda-fdc" && <Text style={base.helper}>USDA {source.fdcId ?? ""}{source.preparation ? ` · ${source.preparation}` : ""}</Text>}
    </>}
    {component.nutritionReferenceStale && <Text style={st.warn}>上述配方是修改前的旧依据，待重新分析。</Text>}
    {component.candidates?.length ? <Text style={base.helper}>识别候选：{component.candidates.map((candidate) => `${candidate.label}${candidate.confidence === undefined ? "" : ` ${Math.round(candidate.confidence * 100)}%`}`).join("、")}</Text> : null}
    {component.evidence?.map((evidence, index) => <Text key={index} style={base.helper}>识别依据：{typeof evidence === "string" ? evidence : evidence.text}</Text>)}
    {component.region && <Text style={base.helper}>照片区域：{[component.region.x, component.region.y, component.region.width, component.region.height].map((value) => Math.round(value * 100)).join("% / ")}%</Text>}
    {(component.uncertainty ?? []).map((warning, index) => <Text key={index} style={st.warn}>待确认：{warning}</Text>)}
  </View>;
}

export function MealAnalysisList({ meal, onSaveCorrection }: {
  meal: MealRecord;
  onSaveCorrection: SaveNutritionCorrection;
}) {
  const { type } = useTheme();
  const base = useBaseStyles();
  const st = useThemedStyles(createStyles);
  const [showHistory, setShowHistory] = useState(false);
  const [showRevisions, setShowRevisions] = useState(false);
  const [correctionBase, setCorrectionBase] = useState<AnalysisVersion | null>(null);
  const analyses = meal.analyses ?? [];
  const latest = analyses.filter((item) => item.sourceVersion === (meal.revision ?? 1)).at(-1);
  const previous = analyses.filter((item) => item.id !== latest?.id);
  return (
    <View style={st.wrap}>
      <Legend text="饮食分析" />
      {!latest && (
        <Text style={base.helper}>
          {analyses.length
            ? "已修改原始记录，旧分析仅保留为历史版本。"
            : meal.estimate
              ? "手动营养值已保存，尚未请求 AI 分析。"
              : "还没有 AI 分析，摄入保持未知。"}
        </Text>
      )}
      {[...(latest ? [latest] : []), ...(showHistory ? previous : [])].map((item) => {
        const current = item.id === latest?.id;
        const a = item.analysis;
        const manualTotal = a.nutritionSource?.method === "manual-total-v1";
        const components = a.components ?? [];
        return (
          <View key={item.id} testID={current ? "current-meal-analysis" : `meal-analysis-history-${item.id}`} style={[st.card, !current && st.cardOld]}>
            <Text style={st.cardTag}>{current ? manualTotal ? "营养值（手动修改）" : "饮食营养" : `历史营养 · 输入版本 ${item.sourceVersion}`}</Text>
            <Text style={st.kcalLine}>
              <Text style={st.kcalLabel}>{manualTotal ? "热量 " : "已填写菜品小计 · 热量 "}</Text>
              <Text style={[st.kcalValue, !a.calories && st.macroUnknown]}>{a.calories ? `约 ${nutritionRangeLabel(a.calories, "calories", " kcal")}` : manualTotal ? "未知" : "待填写菜品数量"}</Text>
            </Text>
            <View style={st.macros}>
              <Macro label={manualTotal ? "蛋白质" : "蛋白质小计"} value={a.protein} nutrient="protein" unit="g" />
              <Macro label={manualTotal ? "碳水" : "碳水小计"} value={a.carbs} nutrient="carbs" unit="g" />
              <Macro label={manualTotal ? "脂肪" : "脂肪小计"} value={a.fat} nutrient="fat" unit="g" />
            </View>
            {components.map((component, index) => <MealNutritionReference key={`reference-${item.id}-${index}`} component={component} compact />)}
            {!manualTotal && a.coverage?.missingQuantityLabels?.length ? <Text style={st.partial}>未计入菜品：{a.coverage.missingQuantityLabels.map((label) => label || "待确认菜品").join("、")}</Text> : null}
            {!manualTotal && a.coverage?.unknownNutritionLabels?.length ? <Text style={st.partial}>营养值未知：{a.coverage.unknownNutritionLabels.map((label) => label || "待确认菜品").join("、")}</Text> : null}
          </View>
        );
      })}
      <View style={st.actions}>
        {latest?.analysis.components?.length ? <SmallButton icon="create-outline" label="填写菜品数量" onPress={() => setCorrectionBase(latest)} /> : null}
        {previous.length > 0 && (
          <SmallButton
            icon={showHistory ? "chevron-up" : "time-outline"}
            label={showHistory ? "收起历史分析" : `查看 ${previous.length} 个历史分析`}
            onPress={() => setShowHistory(!showHistory)}
          />
        )}
        {meal.revisions && meal.revisions.length > 0 && (
          <SmallButton
            icon="git-branch-outline"
            label={showRevisions ? "收起输入修改历史" : `查看 ${meal.revisions.length} 次输入修改历史`}
            onPress={() => setShowRevisions(!showRevisions)}
          />
        )}
      </View>
      {correctionBase && <NutritionCorrection meal={meal} base={correctionBase} onSave={onSaveCorrection} onClose={() => setCorrectionBase(null)} />}
      {showRevisions && meal.revisions?.map((item, index) => (
        <View key={index} style={[st.card, st.cardOld]}>
          <Text style={type.label}>输入版本 {item.revision ?? 1} · {item.foodName}</Text>
          <Text style={st.cardMeta}>
            {localDateTime(item.updatedAt ?? item.createdAt)} · {item.portion || "份量未填写"} · {item.remaining || "剩余量未填写"}
          </Text>
          {Boolean(item.note) && <Text style={st.advice}>{item.note}</Text>}
        </View>
      ))}
    </View>
  );
}
type CorrectionRow = {
  id: string;
  component: MealComponent;
  quantity: string;
  quantityUnit: 'g' | 'household';
  quantityEdited: boolean;
  cookingMethod: string;
  originalLabel: string;
  originalCookingMethod: string;
  uncertaintyReviewed: boolean;
};

function correctionRow(component: MealComponent): CorrectionRow {
  return {
    id: uid(), component: { ...component },
    quantity: component.userQuantity ? String(component.userQuantity.amount) : "",
    quantityUnit: component.userQuantity?.unit ?? "g",
    quantityEdited: false,
    cookingMethod: cookingLabel(component) ?? "",
    originalLabel: component.label,
    originalCookingMethod: cookingLabel(component) ?? "",
    uncertaintyReviewed: false,
  };
}

function dishChanged(row: CorrectionRow) {
  return row.component.label.trim() !== row.originalLabel.trim()
    || row.cookingMethod.trim() !== row.originalCookingMethod.trim();
}

function CatalogFoodPicker({ value, onChange, disabled = false }: {
  value: string | null;
  onChange: (food: CatalogFood | null) => void;
  disabled?: boolean;
}) {
  const { color, type } = useTheme();
  const base = useBaseStyles();
  const st = useThemedStyles(createStyles);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const foods = catalogFoods();
  const selected = foods.find((food) => food.id === value);
  const matches = searchCatalogFoods(query);
  return (
    <View style={{ marginBottom: space.md }}>
      <Text style={base.fieldLabel}>USDA 食材与烹调状态</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="选择 USDA 食材"
        style={st.picker} onPress={() => setOpen(!open)} disabled={disabled}>
        <Ionicons name="search-outline" size={17} color={color.inkSoft} />
        <Text style={[st.pickerText, !selected && { color: color.inkFaint }]}>{selected?.label ?? "未匹配/未知食材"}</Text>
        <Ionicons name={open ? "chevron-up" : "chevron-down"} size={16} color={color.inkFaint} />
      </Pressable>
      {open && (
        <View style={st.pickerPanel}>
          <Field label="搜索食材" value={query} onChangeText={setQuery} disabled={disabled} />
          <SmallButton icon="help-circle-outline" label="未匹配/未知食材" disabled={disabled} onPress={() => { onChange(null); setOpen(false); }} />
          {matches.map((food) => (
            <Pressable key={food.id} accessibilityRole="button" style={st.pickerRow}
              accessibilityLabel={`选择食材 ${food.label}`}
              onPress={() => { onChange(food); setOpen(false); }} disabled={disabled}>
              <Text style={type.label}>{food.label}</Text>
              <Text style={base.helper}>{food.preparation} · USDA {food.fdcId}{food.aliases?.length ? ` · ${food.aliases.slice(0, 3).join("、")}` : ""}</Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}
function NutritionCorrection({ meal, base: baseVersion, onSave, onClose }: {
  meal: MealRecord;
  base: AnalysisVersion;
  onSave: SaveNutritionCorrection;
  onClose: () => void;
}) {
  const { color } = useTheme();
  const base = useBaseStyles();
  const st = useThemedStyles(createStyles);
  const snapshotReferences = baseVersion.analysis.nutritionSource?.method === "ai-per100g-v3"
    || baseVersion.analysis.nutritionSource?.method === "reference-quantity-v1"
    || (baseVersion.analysis.nutritionSource?.method === "manual-total-v1"
      && Boolean(baseVersion.analysis.components?.length));
  const [rows, setRows] = useState<CorrectionRow[]>(() =>
    (baseVersion.analysis.components ?? []).map(correctionRow));
  const rowsRef = useRef(rows);
  const [coverage, setCoverage] = useState(false);
  const [resolvedIssues, setResolvedIssues] = useState<Set<number>>(() => new Set());
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const mountedRef = useRef(true);
  const saveGate = useRef(createCorrectionSaveGate()).current;
  useEffect(() => () => {
    mountedRef.current = false;
    saveGate.invalidate();
  }, [saveGate]);
  const update = (id: string, patch: Partial<CorrectionRow>) => {
    if (savingRef.current) return;
    const next = rowsRef.current.map((item) => item.id === id ? { ...item, ...patch,
      ...(('quantity' in patch || 'quantityUnit' in patch) ? { quantityEdited: true } : {}) } : item);
    rowsRef.current = next;
    setRows(next);
  };
  const updateDish = (row: CorrectionRow, patch: Partial<CorrectionRow>) => update(row.id, {
    ...patch,
    ...(snapshotReferences && row.quantityUnit === "household" ? { quantity: "", quantityUnit: "g" } : {}),
  });
  const save = async () => {
    const token = saveGate.begin();
    if (token === null) return;
    savingRef.current = true;
    setSaving(true);
    setError("");
    try {
      let analysis: MealAnalysis;
      if (snapshotReferences) {
        const reviewRows = rowsRef.current.map((row) => {
          const original = createMealReviewRows({ ...baseVersion.analysis, components: [{ ...row.component,
            label: row.originalLabel, cookingMethod: row.originalCookingMethod || undefined }] })[0];
          const edited = updateMealReviewRow(original, { label: row.component.label, cookingMethod: row.cookingMethod });
          return row.quantityEdited
            ? updateMealReviewRow(edited, { quantity: row.quantity, quantityUnit: row.quantityUnit })
            : { ...edited, quantity: row.quantity, quantityUnit: row.quantityUnit };
        });
        analysis = buildMealReviewAnalysis(baseVersion.analysis, reviewRows);
      } else {
        const components = rowsRef.current.map((row) => {
          const label = row.component.label.trim();
          if (!label) throw new Error("食材标签不能为空。");
          const quantityText = row.quantity.trim();
          const quantity = quantityText ? Number(quantityText) : null;
          if (quantityText && (!Number.isFinite(quantity) || quantity! <= 0 || quantity! > 100_000)) throw new Error(`${label}数量必须大于 0 且不超过 100000。`);
          const cookingMethod = row.cookingMethod.trim();
          const selectedFood = catalogFoods().find((food) => food.id === row.component.foodId);
          const preparationMismatch = Boolean(selectedFood && cookingMethod
            && selectedFood.preparation.trim().toLocaleLowerCase() !== cookingMethod.toLocaleLowerCase());
          const { userQuantityCleared: wasCleared, ...original } = row.component;
          return {
            ...original, label, grams: null, cookingMethod: cookingMethod || undefined,
            userQuantity: quantity === null ? null : { amount: quantity, unit: row.quantityUnit,
              origin: row.quantityEdited ? 'user' as const : row.component.userQuantity?.origin ?? 'user' as const },
            ...(quantity === null && (row.quantityEdited || wasCleared) ? { userQuantityCleared: true } : {}),
            foodId: preparationMismatch ? null : row.component.foodId,
            quantitySource: "unknown" as const,
            consumedFraction: null,
            uncertainty: [
              ...(row.uncertaintyReviewed && coverage ? [] : row.component.uncertainty),
              ...(preparationMismatch ? ["所填烹调方式与所选 USDA 条目不符，已停止使用该精确食材数据。"] : []),
            ],
          };
        });
        const unresolved = [
          ...(coverage ? (baseVersion.analysis.unresolved ?? []).filter((_, index) => !resolvedIssues.has(index)) : (baseVersion.analysis.unresolved ?? [])),
          ...components.flatMap((item) => item.uncertainty.map((issue) => `${item.label}：${issue}`)),
          ...(!coverage ? ["食物、油和酱料覆盖未确认。"] : []),
        ];
        analysis = calculateMealNutrition({
          ...baseVersion.analysis, foodName: meal.foodName, components,
          estimateScope: undefined,
          unresolved: [...new Set(unresolved)],
          assumptions: ["食材、重量和食用比例按用户本次校正；未确认项保持未知。"],
          advice: "依据已确认食材和份量查看营养参考。",
        }, undefined, "user-quantity-v2");
      }
      if (!saveGate.isCurrent(token)) throw new Error("校正表单已过期，请重新打开。");
      await onSave(meal.id, meal.revision ?? 1, baseVersion.id, analysis);
      // A successful onSave has already committed the new version. Do not
      // turn a later invalidation/unmount into a false save failure.
      if (mountedRef.current && saveGate.isCurrent(token)) onClose();
    } catch (e) {
      if (mountedRef.current && saveGate.isCurrent(token)) setError(errorText(e));
    } finally {
      saveGate.finish(token);
      savingRef.current = false;
      if (mountedRef.current) setSaving(false);
    }
  };
  const close = () => {
    if (savingRef.current) return;
    saveGate.invalidate();
    onClose();
  };
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={close}>
      <SafeAreaView style={base.sheet}>
        <View style={[base.sheetEdge, { backgroundColor: color.meal }]} />
        <View style={base.sheetHeader}>
          <Pressable accessibilityLabel="关闭校正" disabled={saving} onPress={close} style={base.sheetIcon}>
            <Ionicons name="close" size={24} color={color.ink} />
          </Pressable>
          <Text style={base.sheetTitle} numberOfLines={1}>{snapshotReferences ? "填写数量与修正菜品" : "填写菜品数量"}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="保存营养校正"
            disabled={saving} onPress={() => void save()} style={[base.saveButton, saving && base.saveButtonOff]}>
            <Text style={[base.saveText, saving && base.saveTextOff]}>{saving ? "保存中" : "保存"}</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={base.form} keyboardShouldPersistTaps="handled">
          {error ? <Banner text={error} danger onClose={() => setError("")} /> : null}
          <Text style={st.intro}>修改每道菜的食用克数，或选择已有本地换算的家用份数。估计量可按实际情况调整；留空不计入小计，数量在本机换算。</Text>
          {snapshotReferences && <Text style={st.intro}>可修正菜名和做法；修改后旧参考会失效。保存后点击“重新分析已修正菜品”，生成新的营养参考。</Text>}
          {rows.map((row, index) => {
            const component = snapshotReferences && dishChanged(row)
              ? { ...row.component, foodId: null, nutritionReferenceStale: true, userNutritionPer100g: null } : row.component;
            const measure = reliableHouseholdMeasure(component);
            return (
            <View key={row.id} style={st.card}>
              <Legend text={`${snapshotReferences ? "菜品" : "食材"} ${index + 1}`} />
              {!snapshotReferences && <CatalogFoodPicker value={row.component.foodId} disabled={saving} onChange={(food) => update(row.id, {
                quantity: "", quantityUnit: "g",
                cookingMethod: food?.preparation ?? "",
                component: {
                  ...correctionComponent(food, food?.label ?? row.component.label),
                  candidates: row.component.candidates,
                  evidence: row.component.evidence,
                  region: row.component.region,
                  confidence: row.component.confidence,
                  category: row.component.category,
                  uncertainty: row.component.uncertainty,
                },
              })} />}
              <Field label={snapshotReferences ? `菜品 ${index + 1} 名称` : `食材 ${index + 1} 标签`} value={row.component.label}
                onChangeText={(label) => updateDish(row, { component: { ...row.component, label } })} disabled={saving} />
              <Field label={snapshotReferences ? `菜品 ${index + 1} 做法` : `食材 ${index + 1} 烹调方式`} value={row.cookingMethod}
                onChangeText={(cookingMethod) => updateDish(row, { cookingMethod })}
                placeholder="例如：水煮、清炒、油炸" disabled={saving} />
              {snapshotReferences && <MealNutritionReference component={component} compact />}
              <View style={st.two}>
                <Field label={snapshotReferences ? `菜品 ${index + 1} ${row.quantityUnit === 'g' ? '食用量' : '食用份数'}` : `食材 ${index + 1} 数量`} value={row.quantity}
                  onChangeText={(quantity) => update(row.id, { quantity })} keyboardType="numeric" placeholder={measure ? "填写实际数量" : "填写克数（g）"} disabled={saving} />
                {measure
                  ? <View style={st.unitChoice}><Choice label="单位" value={row.quantityUnit} tone="meal" choices={[["g", "克（g）"], ["household", "家用份数"]]} onChange={(quantityUnit) => {
                      if (!savingRef.current) update(row.id, { quantityUnit, quantity: "" });
                    }} /><Text style={base.helper}>1 份 {measure.label} ≈ {measure.grams} g</Text></View>
                  : <Text style={base.helper}>无可靠家用换算，请用克数填写。</Text>}
              </View>
              {!snapshotReferences && row.component.uncertainty.length > 0 && (
                <>
                  {row.component.uncertainty.map((issue, issueIndex) =>
                    <Text key={issueIndex} style={st.warn}>待核实：{issue}</Text>)}
                  <CheckRow checked={row.uncertaintyReviewed}
                    label={`已核实食材 ${index + 1} 的上述疑问`}
                    onPress={() => update(row.id, { uncertaintyReviewed: !row.uncertaintyReviewed })}
                    disabled={saving} />
                </>
              )}
              <SmallButton icon="trash-outline" label={`移除${snapshotReferences ? "菜品" : "食材"} ${index + 1}`} danger
                disabled={saving}
                onPress={() => {
                  if (savingRef.current) return;
                  rowsRef.current = rowsRef.current.filter((item) => item.id !== row.id);
                  setRows(rowsRef.current);
                }} />
            </View>
          ); })}
          {rows.length < 20 && <SmallButton icon="add-outline" label={snapshotReferences ? "添加菜品" : "添加食材"}
            disabled={saving}
            onPress={() => {
              if (savingRef.current) return;
              rowsRef.current = [...rowsRef.current, correctionRow(snapshotReferences
                ? { ...correctionComponent(null, ""), label: "", uncertainty: [], nutritionReferenceStale: true }
                : correctionComponent(null, ""))];
              setRows(rowsRef.current);
            }} />}
          {!snapshotReferences && (baseVersion.analysis.unresolved ?? []).map((issue, index) => (
            <View key={index} style={st.issue}>
              <Text style={st.warn}>待解决：{issue}</Text>
              <CheckRow checked={resolvedIssues.has(index)} label={`已核实疑问 ${index + 1}`}
                disabled={saving}
                onPress={() => { if (savingRef.current) return; setResolvedIssues((current) => {
                  const next = new Set(current);
                  if (next.has(index)) next.delete(index); else next.add(index);
                  return next;
                }); }} />
            </View>
          ))}
          {!snapshotReferences && <CheckRow checked={coverage} label="我已确认所有食物、油和酱料均已列出"
            disabled={saving}
            onPress={() => { if (!savingRef.current) setCoverage((current) => !current); }} />}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

const createStyles = ({ color, type }: ThemeTokens) => StyleSheet.create({
  wrap: { marginTop: space.lg },
  intro: { ...type.bodySoft, marginBottom: space.lg },
  card: {
    backgroundColor: color.surface, borderRadius: radius.block, padding: space.lg, marginBottom: space.md,
    borderWidth: 1, borderColor: color.line,
  },
  cardOld: { backgroundColor: color.sunken, borderColor: color.sunken },
  cardHead: { gap: 2 },
  cardTag: { ...type.cap, color: color.mealText },
  cardMeta: { ...type.small },
  food: { ...type.heading, marginTop: space.md },
  recognized: { ...type.body, marginTop: space.sm, color: color.ink },
  referenceRow: { marginTop: space.sm, padding: space.md, backgroundColor: color.sunken, borderRadius: 10 },
  referenceTitle: { ...type.label, marginBottom: 2 },
  referenceStatus: { ...type.bodySoft, marginTop: space.sm },
  partial: { ...type.small, color: color.mealText, marginTop: space.sm },
  metaPills: { flexDirection: "row", flexWrap: "wrap", gap: space.xs, marginTop: space.sm },
  pill: { ...type.small, color: color.mealText, backgroundColor: color.mealTint, borderRadius: radius.pill, overflow: "hidden", paddingHorizontal: 10, paddingVertical: 5 },
  pillMuted: { color: color.inkSoft, backgroundColor: color.sunken },
  kcalLine: { marginTop: space.sm },
  kcalLabel: { ...type.small },
  kcalValue: { fontSize: 24, lineHeight: 30, fontWeight: "800", color: color.ink, ...type.mono },
  macros: { flexDirection: "row", gap: space.sm, marginTop: space.md },
  macro: { flex: 1, minWidth: 0, backgroundColor: color.sunken, borderRadius: 10, paddingVertical: 10, paddingHorizontal: space.sm },
  macroLabel: { ...type.small },
  macroValue: { fontSize: 16, fontWeight: "800", color: color.ink, marginTop: 2, ...type.mono },
  macroUnknown: { color: color.inkFaint },
  macroUnit: { fontSize: 11, color: color.inkFaint },
  advice: { ...type.body, marginTop: space.md, marginBottom: space.sm },
  component: { marginTop: space.sm, paddingLeft: space.md, borderLeftWidth: 2, borderColor: color.meal },
  componentText: { ...type.small, color: color.ink },
  warn: { ...type.small, color: color.mealText, marginTop: 2, marginBottom: 4 },
  basisButton: { minHeight: 42, flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6, borderTopWidth: 1, borderColor: color.line, marginTop: space.md, paddingTop: space.sm },
  basisButtonText: { color: color.mealText, fontSize: 13, fontWeight: "800" },
  coverageText: { ...type.small, marginLeft: "auto" },
  basisPanel: { backgroundColor: color.sunken, borderRadius: 10, padding: space.md, marginTop: space.xs },
  actions: { flexDirection: "row", flexWrap: "wrap", columnGap: space.sm },
  two: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.md, marginTop: space.sm },
  unitChoice: { flex: 1, minWidth: 170 },
  picker: {
    minHeight: 48, flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: 14,
    borderRadius: radius.input, borderWidth: 1, borderColor: color.line, backgroundColor: color.surface,
  },
  pickerText: { flex: 1, ...type.body },
  pickerPanel: { marginTop: space.sm, padding: space.md, borderRadius: 10, backgroundColor: color.sunken },
  pickerRow: { paddingVertical: 10, borderTopWidth: 1, borderColor: color.line },
  issue: { marginBottom: space.sm },
});
