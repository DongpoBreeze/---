import React from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { MealAnalysis } from "../types";
import type { MealReviewRow } from "../meal-review";
import type { MealPortionReference } from "../meal-portion-reference";
import { nutritionDataset } from "../nutrition";
import { resolveAiHouseholdMeasure } from "../../shared/nutrition.mjs";
import { Banner, Field, SmallButton, useBaseStyles } from "./components";
import { AnalysisWaitTime } from "./analysis-wait-time";
import { nutritionRangeLabel } from "./format";
import { radius, space, type ThemeTokens } from "./theme";
import { useTheme, useThemedStyles } from "./theme-provider";

const nutrients = [
  ["calories", "热量", "kcal"], ["protein", "蛋白质", "g"],
  ["carbs", "碳水", "g"], ["fat", "脂肪", "g"],
] as const;

type Props = {
  rows: MealReviewRow[];
  note: string;
  status: string;
  error: string;
  busy: boolean;
  startedAt: number | null;
  preview: MealAnalysis | null;
  portionReference: MealPortionReference;
  preservePortions: boolean;
  onChange: (id: string, patch: Partial<Pick<MealReviewRow, "label" | "cookingMethod" | "quantity" | "quantityUnit" | "nutrients">>) => void;
  onNote: (value: string) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
  onBack: () => void;
  onReview: () => void;
  onConfirm: () => void;
  onCancel: () => void;
  onClearError: () => void;
};

export function MealReviewPage(props: Props) {
  const { color, type } = useTheme();
  const base = useBaseStyles();
  const st = useThemedStyles(createStyles);
  const reference = props.portionReference;
  const hasEstimatedQuantity = props.rows.some((row) => row.quantity.trim() && row.quantityOrigin === 'estimated');
  const estimateBasis = reference.basis === 'daily-target' ? "按每日热量目标"
    : reference.basis === 'body-weight' ? `按你的体重 ${reference.weightKg} kg`
      : "按 60 kg 一般成人参考";
  return <KeyboardAvoidingView testID="ai-meal-review" style={st.page} behavior={Platform.OS === "ios" ? "padding" : undefined}>
    <View style={st.header}>
      <Pressable accessibilityRole="button" accessibilityLabel="返回饮食" onPress={props.onBack} style={st.back}>
        <Ionicons name="arrow-back" size={24} color={color.ink} />
      </Pressable>
      <Text style={type.title}>AI 识别</Text>
    </View>
    <ScrollView contentContainerStyle={st.content} keyboardShouldPersistTaps="handled">
      <Text accessibilityRole="alert" style={type.heading}>{props.status || "照片识别完成，请核对。"}</Text>
      <Text style={st.help}>确认后同步菜品名称和本餐营养。修改菜名或做法后，可自行填写营养，或在确认时由 AI 更新。</Text>
      <Text testID="meal-portion-estimate" style={st.help}>{props.preservePortions
        ? '已保留本餐保存的食用量，可按实际情况修改；空白菜品不计入。'
        : reference.status === 'ready'
        ? `${estimateBasis}估计食用量，可按实际情况修改；未修改时按估计量计算。`
        : `食用量可自行填写。${reference.reason || '部分菜品缺少营养参考，暂不能自动估量。'}`}</Text>
      {props.busy && props.startedAt !== null ? <Text style={st.help}><AnalysisWaitTime startedAt={props.startedAt} /></Text> : null}
      {props.busy ? <SmallButton icon="close-circle-outline" label="取消复核" onPress={props.onCancel} /> : null}
      {props.error ? <Banner text={props.error} danger onClose={props.onClearError} /> : null}
      <Text style={st.sectionTitle}>菜品与营养</Text>
      {props.rows.map((row, index) => {
        const prefix = `菜品 ${index + 1}`;
        const unchanged = row.label.trim() === row.component.label.trim()
          && row.cookingMethod.trim() === (row.component.cookingMethod ?? row.component.preparation ?? "").trim();
        const measure = unchanged ? resolveAiHouseholdMeasure(nutritionDataset, row.component) : null;
        return <View key={row.id} style={st.card} testID={`review-dish-${index + 1}`}>
          <View style={st.rowHeader}>
            <Text style={type.heading}>{prefix}</Text>
            <SmallButton icon="trash-outline" label={`删除菜品 ${index + 1}`} danger disabled={props.busy}
              onPress={() => props.onRemove(row.id)} />
          </View>
          <Field label={`${prefix} 名称`} value={row.label} disabled={props.busy} onChangeText={(label) => props.onChange(row.id, { label })} placeholder="待确认菜品" />
          <Field label={`${prefix} 做法`} value={row.cookingMethod} disabled={props.busy} onChangeText={(cookingMethod) => props.onChange(row.id, { cookingMethod })} placeholder="例如：蒸、煮、炒；未知可留空" />
          <Text style={type.label}>每 100 g 营养</Text>
          <Text style={st.help}>填写下限与上限；确定值可填相同数字，未知时全部留空。</Text>
          {nutrients.map(([key, label, unit]) => <View key={key} style={st.rangeRow}>
            <Field label={`${prefix} 每100g${label}下限`} value={row.nutrients[key].min} disabled={props.busy} keyboardType="numeric" placeholder={`${label}下限 ${unit}`}
              onChangeText={(min) => props.onChange(row.id, { nutrients: { ...row.nutrients, [key]: { ...row.nutrients[key], min } } })} />
            <Field label={`${prefix} 每100g${label}上限`} value={row.nutrients[key].max} disabled={props.busy} keyboardType="numeric" placeholder={`${label}上限 ${unit}`}
              onChangeText={(max) => props.onChange(row.id, { nutrients: { ...row.nutrients, [key]: { ...row.nutrients[key], max } } })} />
          </View>)}
          <View testID={`review-dish-${index + 1}-quantity-control`}>
            <Field label={`${prefix} ${row.quantityUnit === "g" ? "食用量" : "食用份数"}`} value={row.quantity} disabled={props.busy} keyboardType="numeric"
              labelAccessory={measure ? <View testID={`review-dish-${index + 1}-quantity-unit`} style={st.unitControl}>
                {([["g", "克（g）"], ["household", "家用份数"]] as const).map(([unit, label]) => <Pressable key={unit}
                  accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected: row.quantityUnit === unit, disabled: props.busy }}
                  disabled={props.busy} onPress={() => { if (row.quantityUnit !== unit) props.onChange(row.id, { quantityUnit: unit, quantity: "" }); }}
                  style={[st.unitButton, row.quantityUnit === unit && st.unitButtonSelected, props.busy && base.dim]}>
                  <Text style={[st.unitText, row.quantityUnit === unit && st.unitTextSelected]}>{label}</Text>
                </Pressable>)}
              </View> : <Text style={st.unitText}>克（g）</Text>}
              placeholder={row.quantityUnit === "g" ? "克（g），留空不计入" : "份数，例如 0.5"} onChangeText={(quantity) => props.onChange(row.id, { quantity })} />
          </View>
          <Text style={st.help}>{row.quantity.trim() && row.quantityOrigin === 'estimated'
            ? `估计食用量 ${row.quantity} g，可修改。`
            : measure ? `参考份数：${measure.label} ≈ ${measure.grams} g` : "使用克数填写，留空的菜品不计入。"}</Text>
        </View>;
      })}
      <SmallButton icon="add-outline" label="添加菜品" onPress={props.onAdd} disabled={props.busy || props.rows.length >= 20} />
      <View style={st.summary}>
        <Text style={type.heading}>{props.preview?.coverage?.missingQuantityLabels?.length ? "已计入菜品小计" : hasEstimatedQuantity ? "本餐营养估计" : "本餐营养"}</Text>
        <Text style={st.help}>{nutrients.map(([key, label, unit]) => `${label} ${props.preview?.[key] ? `约 ${nutritionRangeLabel(props.preview[key], key, ` ${unit}`)}` : "—"}`).join(" · ")}</Text>
        {props.preview?.coverage?.missingQuantityLabels?.length ? <Text style={st.help}>未计入菜品：{props.preview.coverage.missingQuantityLabels.join("、")}</Text> : null}
        {props.preview?.coverage?.unknownNutritionLabels?.length ? <Text style={st.help}>营养值未知：{props.preview.coverage.unknownNutritionLabels.join("、")}</Text> : null}
      </View>
      <Field label="补充说明（用于复核）" value={props.note} onChangeText={props.onNote} disabled={props.busy} multiline placeholder="例如：鸡肉改为鱼肉、少油烹调" />
    </ScrollView>
    <View style={st.footer}>
      <Pressable accessibilityRole="button" accessibilityState={{ disabled: props.busy }} disabled={props.busy}
        style={[st.action, st.reviewAction, props.busy && base.dim]} onPress={props.onReview}>
        <Text style={type.label}>AI 复核</Text>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityState={{ disabled: props.busy }} disabled={props.busy}
        style={[st.action, st.confirmAction, props.busy && base.dim]} onPress={props.onConfirm}>
        <Text style={st.confirmText}>确认填入</Text>
      </Pressable>
    </View>
  </KeyboardAvoidingView>;
}

const createStyles = ({ color, type }: ThemeTokens) => StyleSheet.create({
  page: { flex: 1, backgroundColor: color.paper },
  header: { flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 64, paddingHorizontal: space.lg, borderTopWidth: 3, borderTopColor: color.meal, borderBottomWidth: 1, borderBottomColor: color.line },
  back: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center" },
  content: { width: "100%", maxWidth: 680, alignSelf: "center", paddingHorizontal: 18, paddingTop: space.lg, paddingBottom: space.xl },
  help: { ...type.small, marginTop: space.xs, marginBottom: space.md },
  sectionTitle: { ...type.heading, marginVertical: space.lg },
  card: { padding: space.lg, backgroundColor: color.surface, borderRadius: radius.block, marginBottom: space.md, borderWidth: 1, borderColor: color.line },
  rowHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm, marginBottom: space.md },
  rangeRow: { flexDirection: "row", gap: space.md },
  unitControl: { flexDirection: "row", flexShrink: 0, padding: 2, borderRadius: radius.pill, backgroundColor: color.sunken },
  unitButton: { minHeight: 40, minWidth: 48, paddingHorizontal: space.sm, justifyContent: "center", alignItems: "center", borderRadius: radius.pill },
  unitButtonSelected: { backgroundColor: color.raised },
  unitText: { ...type.small },
  unitTextSelected: { color: color.mealText, fontWeight: "700" },
  summary: { marginVertical: space.lg, padding: space.lg, borderRadius: radius.block, backgroundColor: color.mealTint, borderTopWidth: 3, borderTopColor: color.meal },
  footer: { width: "100%", maxWidth: 680, alignSelf: "center", flexDirection: "row", gap: space.md, padding: space.lg, borderTopWidth: 1, borderTopColor: color.line },
  action: { flex: 1, minHeight: 48, alignItems: "center", justifyContent: "center", borderRadius: radius.pill },
  reviewAction: { backgroundColor: "transparent", borderWidth: 1.5, borderColor: color.meal },
  confirmAction: { backgroundColor: color.meal },
  confirmText: { ...type.label, fontWeight: "800", color: color.onMeal },
});
