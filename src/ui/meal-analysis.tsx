import React, { useEffect, useRef, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import type { AnalysisVersion, MealComponent, MealRecord, NutritionSource, NutrientRange } from "../types";
import { calculateMealNutrition, catalogFoods, correctionComponent, nutritionDataset, searchCatalogFoods, type CatalogFood } from "../nutrition";
import { createCorrectionSaveGate, fractionToPercent } from "../nutrition-correction";
import { uid } from "../domain";
import { Banner, CheckRow, Choice, Field, Legend, SmallButton, s as base } from "./components";
import { errorText, localDateTime, nutritionRangeLabel } from "./format";
import { color, radius, space, type } from "./theme";
import type { SaveNutritionCorrection } from "./app-types";

function Macro({ label, value, unit, nutrient }: { label: string; value: NutrientRange | null | undefined; unit: string; nutrient: "protein" | "carbs" | "fat" }) {
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
  if (provider === "mixed") return "USDA 与本地类别数据";
  if (provider === "manual") return "手动记录";
  return "AI 每 100 g 估值";
}

function componentSourceLabel(component: MealComponent) {
  const source = component.source;
  if (source?.provider === "model") return source.method === "category" ? "AI按类别近似估算" : "AI按典型配方估算";
  if (source?.provider === "usda-fdc") return "USDA 食品数据库";
  if (source?.provider === "local-category") return "本地通用类别区间";
  return "营养参考未知";
}

function reliableHouseholdMeasure(component: MealComponent) {
  if (component.nutritionReferenceStale) return null;
  const measure = component.householdMeasure
    ?? (component.source?.provider !== "model" ? component.source?.householdMeasure : undefined);
  if (!measure || !Number.isFinite(measure.grams) || measure.grams <= 0) return null;
  // Household units must have an existing local gram equivalent, never an AI guess.
  return Object.values(nutritionDataset.householdMeasures ?? {}).some((known) =>
    known.label === measure.label && known.grams === measure.grams)
    ? measure : null;
}

/** The reference is visible immediately; recipe evidence is shown separately on demand. */
export function MealNutritionReference({ component }: { component: MealComponent }) {
  const source = component.source;
  const per100 = source?.provider === "usda-fdc" ? source.per100g : source?.per100gRange;
  const measure = reliableHouseholdMeasure(component);
  return <View style={st.referenceRow}>
    <Text style={st.referenceTitle}>{component.label}</Text>
    <Text style={base.helper}>来源：{componentSourceLabel(component)}</Text>
    {source?.provider === "model" && <Text style={base.helper}>营养置信度：{confidenceLabel(source.confidence)}</Text>}
    {per100 ? <Text style={base.helper}>
      {source?.provider === "model" ? "每 100 g 可食用成品" : "每 100 g"}：热量 {nutritionRangeLabel(referenceRange(per100.calories), "calories", " kcal")} · 蛋白质 {nutritionRangeLabel(referenceRange(per100.protein), "protein", " g")} · 碳水 {nutritionRangeLabel(referenceRange(per100.carbs), "carbs", " g")} · 脂肪 {nutritionRangeLabel(referenceRange(per100.fat), "fat", " g")}
    </Text> : <Text style={base.helper}>营养参考未知，当前不计入小计。</Text>}
    {measure && <Text style={base.helper}>本地家用换算：{measure.label} ≈ {measure.grams} g</Text>}
    {component.userQuantity && <Text style={base.helper}>实际食用量：{component.userQuantity.amount} {component.userQuantity.unit === "g" ? "g" : `× ${measure?.label ?? "家用单位"}`}</Text>}
    {component.nutritionReferenceStale && <Text style={st.warn}>旧参考已失效：菜名或做法已修改，重新分析前不计入小计。</Text>}
  </View>;
}

export function MealNutritionBasis({ component }: { component: MealComponent }) {
  const source = component.source;
  return <View style={st.component}>
    <Text style={st.componentText}>
      菜品：{component.label}{component.userQuantity ? ` · 用户填写 ${component.userQuantity.amount} ${component.userQuantity.unit === "g" ? "g" : `× ${reliableHouseholdMeasure(component)?.label ?? "家用单位"}`}` : " · 尚未填写数量"}
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
  const [showHistory, setShowHistory] = useState(false);
  const [showRevisions, setShowRevisions] = useState(false);
  const [openBasisId, setOpenBasisId] = useState<string | null>(null);
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
        const components = a.components ?? [];
        const aiPer100g = a.nutritionSource?.method === "ai-per100g-v3";
        const referenceCount = a.coverage?.referenceCount ?? components.filter((component) => component.source && !component.nutritionReferenceStale).length;
        const recognized = [...new Set(components.filter((component) => component.label.trim()).map((component) => component.label.trim()))];
        const basisOpen = openBasisId === item.id;
        return (
          <View key={item.id} testID={current ? "current-meal-analysis" : `meal-analysis-history-${item.id}`} style={[st.card, !current && st.cardOld]}>
            <View style={st.cardHead}>
              <Text style={[st.cardTag, !current && { color: color.inkSoft }]}>
                {current ? "当前分析" : `历史分析 · 输入版本 ${item.sourceVersion}`}
              </Text>
              <Text style={st.cardMeta}>{localDateTime(item.createdAt)} · {item.model}</Text>
            </View>
            <Text style={st.food}>{a.foodName}</Text>
            <Text style={st.recognized}>
              {recognized.length ? `识别到：${recognized.join("、")}` : "尚未可靠识别出具体食材"}
            </Text>
            <View style={st.metaPills}>
              <Text style={[st.pill, a.confidence === undefined && st.pillMuted]}>识别置信度：{confidenceLabel(a.confidence)}</Text>
              <Text style={st.pill}>营养参考按每道菜列出</Text>
              {a.status === "approximate" && <Text style={st.pill}>近似小计</Text>}
            </View>
            {aiPer100g && <Text style={st.referenceStatus}>
              {referenceCount ? `已生成 ${referenceCount}/${components.length} 道菜的每 100 g AI 营养参考。` : "当前没有可用营养参考，请核对菜品后重新分析。"}
              {a.coverage?.counted ? `已计入 ${a.coverage.counted}/${components.length} 道菜，按实际填写数量换算。` : referenceCount ? "填写实际食用量后计算摄入小计。" : ""}
            </Text>}
            <Text style={st.kcalLine}>
              <Text style={st.kcalLabel}>{a.coverage?.counted ? "已填写菜品小计 · 热量 " : "摄入热量 "}</Text>
              <Text style={[st.kcalValue, !a.calories && st.macroUnknown]}>{a.calories ? `约 ${nutritionRangeLabel(a.calories, "calories", " kcal")}` : "待填写菜品数量"}</Text>
            </Text>
            <View style={st.macros}>
              <Macro label="蛋白质小计" value={a.protein} nutrient="protein" unit="g" />
              <Macro label="碳水小计" value={a.carbs} nutrient="carbs" unit="g" />
              <Macro label="脂肪小计" value={a.fat} nutrient="fat" unit="g" />
            </View>
            {components.map((component, index) => <MealNutritionReference key={`reference-${item.id}-${index}`} component={component} />)}
            {a.coverage?.missingQuantityLabels?.length ? <Text style={st.warn}>未计入（未填数量）：{a.coverage.missingQuantityLabels.join("、")}</Text> : null}
            {a.coverage?.unknownNutritionLabels?.length ? <Text style={st.warn}>未计入（营养数据未知）：{a.coverage.unknownNutritionLabels.join("、")}</Text> : null}
            {current && components.some((component) => component.nutritionReferenceStale) && <Text style={st.warn}>请使用下方“重新分析已修正菜品”生成新参考；历史分析保留修改前的数量和依据。</Text>}
            <Text style={st.advice}>{a.advice}</Text>
            {a.nutritionSource && (
              <Text style={base.helper}>
                营养来源：{nutritionSourceLabel(a.nutritionSource.provider)}
                {a.nutritionSource.dataset ? ` · ${a.nutritionSource.dataset}` : ""}
                {a.nutritionSource.coverage === "incomplete" ? " · 数量或参考不完整" : aiPer100g ? " · 数量填写完整，仍为近似值" : ""}
              </Text>
            )}
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: basisOpen }}
              accessibilityLabel={basisOpen ? "收起估算依据" : "查看估算依据"}
              style={st.basisButton}
              onPress={() => setOpenBasisId(basisOpen ? null : item.id)}
            >
              <Ionicons name={basisOpen ? "chevron-up" : "information-circle-outline"} size={17} color={color.mealText} />
              <Text style={st.basisButtonText}>{basisOpen ? "收起估算依据" : "查看估算依据"}</Text>
              {a.coverage && <Text style={st.coverageText}>{aiPer100g ? `参考 ${referenceCount}/${a.coverage.total}` : `目录匹配 ${a.coverage.matched}/${a.coverage.total}`}</Text>}
            </Pressable>
            {basisOpen && <View accessibilityLabel="估算依据" style={st.basisPanel}>
              {components.map((component, index) => <MealNutritionBasis key={`${component.foodId ?? "unknown"}-${index}`} component={component} />)}
              {a.coverage?.unknownLabels.map((label, index) => <Text key={`unknown-${index}`} style={st.warn}>未匹配食材：{label}</Text>)}
              {a.unresolved?.map((warning, index) => <Text key={`unresolved-${index}`} style={st.warn}>待确认：{warning}</Text>)}
              {a.assumptions.map((line, index) => <Text key={`assumption-${index}`} style={base.helper}>估算假设：{line}</Text>)}
            </View>}
          </View>
        );
      })}
      <View style={st.actions}>
        {latest ? <SmallButton icon="create-outline" label="填写菜品数量" onPress={() => setCorrectionBase(latest)} /> : null}
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
  const aiPer100g = baseVersion.analysis.nutritionSource?.method === "ai-per100g-v3";
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
    const next = rowsRef.current.map((item) => item.id === id ? { ...item, ...patch } : item);
    rowsRef.current = next;
    setRows(next);
  };
  const updateDish = (row: CorrectionRow, patch: Partial<CorrectionRow>) => update(row.id, {
    ...patch,
    ...(aiPer100g && row.quantityUnit === "household" ? { quantity: "", quantityUnit: "g" } : {}),
  });
  const save = async () => {
    const token = saveGate.begin();
    if (token === null) return;
    savingRef.current = true;
    setSaving(true);
    setError("");
    try {
      const components = rowsRef.current.map((row) => {
        const label = row.component.label.trim();
        if (!label) throw new Error("食材标签不能为空。");
        const quantityText = row.quantity.trim();
        const quantity = quantityText ? Number(quantityText) : null;
        if (quantityText && (!Number.isFinite(quantity) || quantity! <= 0 || quantity! > 100_000)) throw new Error(`${label}数量必须大于 0 且不超过 100000。`);
        const cookingMethod = row.cookingMethod.trim();
        if (aiPer100g) {
          const changed = dishChanged(row);
          return {
            ...row.component, label, cookingMethod: cookingMethod || undefined, preparation: undefined,
            grams: null,
            userQuantity: quantity === null || (changed && row.quantityUnit === "household")
              ? null : { amount: quantity, unit: row.quantityUnit },
            nutritionReferenceStale: Boolean(row.component.nutritionReferenceStale || changed),
            ...(changed ? { foodId: null, householdMeasure: null } : {}),
            quantitySource: "unknown" as const,
            consumedFraction: null,
          };
        }
        const selectedFood = catalogFoods().find((food) => food.id === row.component.foodId);
        const preparationMismatch = Boolean(selectedFood && cookingMethod
          && selectedFood.preparation.trim().toLocaleLowerCase() !== cookingMethod.toLocaleLowerCase());
        return {
          ...row.component, label, grams: null, cookingMethod: cookingMethod || undefined,
          userQuantity: quantity === null ? null : { amount: quantity, unit: row.quantityUnit },
          foodId: preparationMismatch ? null : row.component.foodId,
          quantitySource: "unknown" as const,
          consumedFraction: null,
          uncertainty: [
            ...(row.uncertaintyReviewed && coverage ? [] : row.component.uncertainty),
            ...(preparationMismatch ? ["所填烹调方式与所选 USDA 条目不符，已停止使用该精确食材数据。"] : []),
          ],
        };
      });
      const unresolved = aiPer100g ? (baseVersion.analysis.unresolved ?? []) : [
        ...(coverage ? (baseVersion.analysis.unresolved ?? []).filter((_, index) => !resolvedIssues.has(index)) : (baseVersion.analysis.unresolved ?? [])),
        ...components.flatMap((item) => item.uncertainty.map((issue) => `${item.label}：${issue}`)),
        ...(!coverage ? ["食物、油和酱料覆盖未确认。"] : []),
      ];
      const analysis = await calculateMealNutrition({
        ...baseVersion.analysis, foodName: meal.foodName, components,
        estimateScope: undefined,
        unresolved: [...new Set(unresolved)],
        assumptions: aiPer100g ? baseVersion.analysis.assumptions : ["食材、重量和食用比例按用户本次校正；未确认项保持未知。"],
        advice: aiPer100g ? "按已填写的实际食用量换算近似小计；修改菜名或做法后请重新分析。" : "依据已确认食材和份量查看营养参考。",
      }, undefined, aiPer100g ? "ai-per100g-v3" : "user-quantity-v2");
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
          <Text style={base.sheetTitle} numberOfLines={1}>{aiPer100g ? "填写数量与修正菜品" : "填写菜品数量"}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="保存营养校正"
            disabled={saving} onPress={() => void save()} style={[base.saveButton, saving && base.saveButtonOff]}>
            <Text style={[base.saveText, saving && base.saveTextOff]}>{saving ? "保存中" : "保存"}</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={base.form} keyboardShouldPersistTaps="handled">
          {error ? <Banner text={error} danger onClose={() => setError("")} /> : null}
          <Text style={st.intro}>填写每道菜实际吃下的可食用成品克数，或选择已有本地克数换算的家用单位。留空只保留每 100 g 营养参考，不计入小计。数量在本机换算。</Text>
          {aiPer100g && <Text style={st.intro}>可修正菜名和做法；修改后旧参考会失效。保存后点击“重新分析已修正菜品”，生成新的营养参考。</Text>}
          {rows.map((row, index) => {
            const component = aiPer100g && dishChanged(row)
              ? { ...row.component, foodId: null, nutritionReferenceStale: true } : row.component;
            const measure = reliableHouseholdMeasure(component);
            return (
            <View key={row.id} style={st.card}>
              <Legend text={`${aiPer100g ? "菜品" : "食材"} ${index + 1}`} />
              {!aiPer100g && <CatalogFoodPicker value={row.component.foodId} disabled={saving} onChange={(food) => update(row.id, {
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
              <Field label={aiPer100g ? `菜品 ${index + 1} 名称` : `食材 ${index + 1} 标签`} value={row.component.label}
                onChangeText={(label) => updateDish(row, { component: { ...row.component, label } })} disabled={saving} />
              <Field label={aiPer100g ? `菜品 ${index + 1} 做法` : `食材 ${index + 1} 烹调方式`} value={row.cookingMethod}
                onChangeText={(cookingMethod) => updateDish(row, { cookingMethod })}
                placeholder="例如：水煮、清炒、油炸" disabled={saving} />
              {aiPer100g && <MealNutritionReference component={component} />}
              <View style={st.two}>
                <Field label={aiPer100g ? `菜品 ${index + 1} 实际食用量` : `食材 ${index + 1} 数量`} value={row.quantity}
                  onChangeText={(quantity) => update(row.id, { quantity })} keyboardType="numeric" placeholder={measure ? "填写实际数量" : "填写克数（g）"} disabled={saving} />
                {measure
                  ? <View style={st.unitChoice}><Choice label="单位" value={row.quantityUnit} tone="meal" choices={[["g", "克（g）"], ["household", "家用份数"]]} onChange={(quantityUnit) => {
                      if (!savingRef.current) update(row.id, { quantityUnit, quantity: "" });
                    }} /><Text style={base.helper}>1 份 {measure.label} ≈ {measure.grams} g</Text></View>
                  : <Text style={base.helper}>无可靠家用换算，请用克数填写。</Text>}
              </View>
              {!aiPer100g && row.component.uncertainty.length > 0 && (
                <>
                  {row.component.uncertainty.map((issue, issueIndex) =>
                    <Text key={issueIndex} style={st.warn}>待核实：{issue}</Text>)}
                  <CheckRow checked={row.uncertaintyReviewed}
                    label={`已核实食材 ${index + 1} 的上述疑问`}
                    onPress={() => update(row.id, { uncertaintyReviewed: !row.uncertaintyReviewed })}
                    disabled={saving} />
                </>
              )}
              <SmallButton icon="trash-outline" label={`移除${aiPer100g ? "菜品" : "食材"} ${index + 1}`} danger
                disabled={saving}
                onPress={() => {
                  if (savingRef.current) return;
                  rowsRef.current = rowsRef.current.filter((item) => item.id !== row.id);
                  setRows(rowsRef.current);
                }} />
            </View>
          ); })}
          {rows.length < 20 && <SmallButton icon="add-outline" label={aiPer100g ? "添加菜品" : "添加食材"}
            disabled={saving}
            onPress={() => {
              if (savingRef.current) return;
              rowsRef.current = [...rowsRef.current, correctionRow(aiPer100g
                ? { ...correctionComponent(null, ""), label: "", uncertainty: [], nutritionReferenceStale: true }
                : correctionComponent(null, ""))];
              setRows(rowsRef.current);
            }} />}
          {!aiPer100g && (baseVersion.analysis.unresolved ?? []).map((issue, index) => (
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
          {!aiPer100g && <CheckRow checked={coverage} label="我已确认所有食物、油和酱料均已列出"
            disabled={saving}
            onPress={() => { if (!savingRef.current) setCoverage((current) => !current); }} />}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

const st = StyleSheet.create({
  wrap: { marginTop: space.lg },
  intro: { ...type.bodySoft, marginBottom: space.lg },
  card: {
    backgroundColor: color.surface, borderRadius: radius.block, padding: space.lg, marginBottom: space.md,
    borderWidth: StyleSheet.hairlineWidth, borderColor: color.lineStrong,
  },
  cardOld: { backgroundColor: color.sunken, borderColor: color.sunken },
  cardHead: { gap: 2 },
  cardTag: { fontSize: 13, fontWeight: "800", color: color.mealText },
  cardMeta: { ...type.small },
  food: { ...type.heading, marginTop: space.md },
  recognized: { ...type.body, marginTop: space.sm, color: color.ink },
  referenceRow: { marginTop: space.sm, padding: space.md, backgroundColor: color.paper, borderRadius: radius.input },
  referenceTitle: { ...type.label, marginBottom: 2 },
  referenceStatus: { ...type.bodySoft, marginTop: space.sm },
  metaPills: { flexDirection: "row", flexWrap: "wrap", gap: space.xs, marginTop: space.sm },
  pill: { ...type.small, color: color.mealText, backgroundColor: color.mealTint, borderRadius: radius.pill, overflow: "hidden", paddingHorizontal: 10, paddingVertical: 5 },
  pillMuted: { color: color.inkSoft, backgroundColor: color.sunken },
  kcalLine: { marginTop: space.sm },
  kcalLabel: { ...type.small },
  kcalValue: { fontSize: 24, lineHeight: 30, fontWeight: "800", color: color.ink, ...type.numeric },
  macros: { flexDirection: "row", gap: space.sm, marginTop: space.md },
  macro: { flex: 1, minWidth: 0, backgroundColor: color.paper, borderRadius: radius.input, paddingVertical: 10, paddingHorizontal: space.sm },
  macroLabel: { ...type.small },
  macroValue: { fontSize: 16, fontWeight: "800", color: color.ink, marginTop: 2, ...type.numeric },
  macroUnknown: { color: color.inkFaint },
  macroUnit: { fontSize: 11, color: color.inkFaint },
  advice: { ...type.body, marginTop: space.md, marginBottom: space.sm },
  component: { marginTop: space.sm, paddingLeft: space.md, borderLeftWidth: 2, borderColor: color.mealTint },
  componentText: { ...type.small, color: color.ink },
  warn: { ...type.small, color: color.mealText, marginTop: 2, marginBottom: 4 },
  basisButton: { minHeight: 42, flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6, borderTopWidth: StyleSheet.hairlineWidth, borderColor: color.lineStrong, marginTop: space.md, paddingTop: space.sm },
  basisButtonText: { color: color.mealText, fontSize: 13, fontWeight: "800" },
  coverageText: { ...type.small, marginLeft: "auto" },
  basisPanel: { backgroundColor: color.paper, borderRadius: radius.input, padding: space.md, marginTop: space.xs },
  actions: { flexDirection: "row", flexWrap: "wrap", columnGap: space.sm },
  two: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.md, marginTop: space.sm },
  unitChoice: { flex: 1, minWidth: 170 },
  picker: {
    minHeight: 48, flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: 14,
    borderRadius: radius.input, borderWidth: 1, borderColor: color.line, backgroundColor: color.surface,
  },
  pickerText: { flex: 1, ...type.body },
  pickerPanel: { marginTop: space.sm, padding: space.md, borderRadius: radius.input, backgroundColor: color.paper },
  pickerRow: { paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth, borderColor: color.lineStrong },
  issue: { marginBottom: space.sm },
});
