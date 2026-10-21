import React, { useEffect, useState } from "react";
import { AppState, Pressable, ScrollView, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { AppData, MealRecord, NutrientRange } from "../types";
import { localDate, mealCalories, summaryMarkdown } from "../domain";
import { MarkdownText, SummaryVersions, useBaseStyles } from "./components";
import { RhythmMatrix, type RhythmMark } from "./rhythm";
import { dateLabel, minutesInto, recordDate, sleepHours, timeLabel } from "./format";
import { radius, type ThemeTokens } from "./theme";
import { useTheme, useThemedStyles } from "./theme-provider";
import type { Kind } from "./app-types";

type NutrientKey = "calories" | "protein" | "carbs" | "fat";

function nutrientMidpointLabel(value: NutrientRange, nutrient: NutrientKey) {
  const digits = nutrient === "calories" ? 0 : 1;
  const factor = 10 ** digits;
  const midpoint = (value.min + value.max) / 2;
  return (Math.round(midpoint * factor) / factor).toFixed(digits);
}

/** Use the same current-input and quantity gates as the saved meal calorie total. */
function mealNutrient(meal: MealRecord, nutrient: NutrientKey): NutrientRange | null {
  if (nutrient === "calories") return mealCalories(meal);
  if (meal.estimate && meal.estimateStatus === "estimated") {
    const value = meal.estimate[nutrient];
    return Number.isFinite(value) ? { min: value, max: value } : null;
  }
  const version = meal.analyses?.at(-1);
  if (!version || version.sourceVersion !== (meal.revision ?? 1)) return null;
  const analysis = version.analysis;
  if (analysis.status !== "estimated"
    && !(analysis.status === "approximate" && (analysis.coverage?.counted ?? 0) > 0)) return null;
  return analysis[nutrient];
}

function nutrientSummary(meals: MealRecord[], nutrient: NutrientKey) {
  const values = meals.map((meal) => mealNutrient(meal, nutrient)).filter((value): value is NutrientRange => value !== null);
  return {
    total: values.length ? values.reduce((sum, value) => ({ min: sum.min + value.min, max: sum.max + value.max }), { min: 0, max: 0 }) : null,
    knownMeals: values.length,
    missingMeals: meals.length - values.length,
  };
}

function hasIncompleteNutrition(meal: MealRecord) {
  const version = meal.analyses?.at(-1);
  const analysis = version?.sourceVersion === (meal.revision ?? 1) ? version.analysis : undefined;
  return ["user-quantity-v2", "ai-per100g-v3", "reference-quantity-v1"].includes(analysis?.nutritionSource?.method ?? "")
    && (analysis?.nutritionSource?.coverage === "incomplete"
      || Boolean(analysis?.coverage?.missingQuantityLabels?.length)
      || Boolean(analysis?.coverage?.unknownNutritionLabels?.length));
}

function ModuleSummary({ kind, value, unit, note }: { kind: "training" | "sleep"; value: string; unit?: string; note: string }) {
  const { color, moduleTone } = useTheme();
  const st = useThemedStyles(createStyles);
  const tone = moduleTone[kind];
  return (
    <View style={st.moduleSummary}>
      <View style={st.moduleHead}>
        <View style={[st.moduleDot, { backgroundColor: tone.hue }]} />
        <Text style={st.moduleTitle}>{kind === "training" ? "训练汇总" : "估算睡眠"}</Text>
      </View>
      <Text style={[st.moduleValue, value === "—" && { color: color.placeholder }]} numberOfLines={1} adjustsFontSizeToFit>
        {value}<Text style={st.moduleUnit}>{value !== "—" && unit ? " " + unit : ""}</Text>
      </Text>
      <Text style={st.moduleNote}>{note}</Text>
    </View>
  );
}

export function Today({
  data,
  contentStyle,
  onOpen,
  onEdit,
  onAi,
  onProfile,
}: {
  data: AppData;
  contentStyle: StyleProp<ViewStyle>;
  onOpen: (kind: Kind) => void;
  onEdit: (kind: Kind, id: string) => void;
  onAi: () => void;
  onProfile: () => void;
}) {
  const { color, type, moduleTone } = useTheme();
  const base = useBaseStyles();
  const st = useThemedStyles(createStyles);
  const [showLocal, setShowLocal] = useState(false);
  const [nowDate, setNowDate] = useState(() => new Date());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const refresh = () => {
      clearTimeout(timer);
      setNowDate(new Date());
      timer = setTimeout(refresh, 60000 - (Date.now() % 60000) + 20);
    };
    refresh();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") refresh();
    });
    return () => { clearTimeout(timer); subscription.remove(); };
  }, []);
  const date = localDate(nowDate);
  const meals = data.meals.filter((record) => recordDate(record) === date);
  const trainings = data.trainings.filter((record) => recordDate(record) === date);
  const sleeps = data.sleeps.filter((record) => recordDate(record) === date);
  const count = meals.length + trainings.length + sleeps.length;
  const days = new Set([
    ...data.meals.map(recordDate),
    ...data.trainings.map(recordDate),
    ...data.sleeps.map(recordDate),
  ]).size;
  const nutrients = {
    calories: nutrientSummary(meals, "calories"),
    protein: nutrientSummary(meals, "protein"),
    carbs: nutrientSummary(meals, "carbs"),
    fat: nutrientSummary(meals, "fat"),
  };
  const knownMeals = nutrients.calories.knownMeals;
  const incompleteMeals = meals.filter(hasIncompleteNutrition).length;
  const insufficientMeals = meals.filter((meal) => hasIncompleteNutrition(meal)
    || (["calories", "protein", "carbs", "fat"] as const).some((nutrient) => mealNutrient(meal, nutrient) === null)).length;
  const calories = nutrients.calories.total;
  const summary = data.summaries.find((record) => record.date === date && record.source !== "ai")?.markdown
    ?? summaryMarkdown(data, date);
  const aiSummaries = data.summaries.filter((record) => record.date === date && record.source === "ai");
  const preview = count
    ? summary.split("\n").filter((line) => line.trim() && !line.startsWith("#") && !line.startsWith("-")).join(" ").slice(0, 180)
    : "暂无记录，开始今天的第一笔数据记录后，可查看本地摘要或请求 AI 生成健康总结。";
  // Include every interval intersecting this local day, including overnight sleep.
  const marks: RhythmMark[] = [
    ...data.sleeps.map((record) => ({ kind: "sleep" as const, start: minutesInto(date, record.fellAsleepAt), end: minutesInto(date, record.wokeAt) })),
    ...data.meals.map((record) => ({ kind: "meal" as const, start: minutesInto(date, record.occurredAt) })),
    ...data.trainings.map((record) => {
      const start = minutesInto(date, record.occurredAt);
      return { kind: "training" as const, start, end: record.mode === "cardio" && record.durationMinutes ? start + record.durationMinutes : undefined };
    }),
  ];
  const now = nowDate.getHours() * 60 + nowDate.getMinutes();
  const workSets = trainings.reduce((sum, record) => sum + record.sets.filter((set) => !set.isWarmup).length, 0);
  const cardio = trainings.filter((record) => record.mode === "cardio");
  const trainingNote = !trainings.length ? "暂无训练"
    : trainings.some((record) => record.mode !== "cardio") ? workSets + " 个工作组"
    : cardio.every((record) => record.durationMinutes !== undefined)
      ? cardio.reduce((sum, record) => sum + record.durationMinutes!, 0) + " 分钟有氧活动"
      : "有氧时长未完整填写";
  const knownSleeps = sleeps.map(sleepHours).filter((value): value is number => value !== null);
  const sleepValue = knownSleeps.length ? knownSleeps.reduce((sum, value) => sum + value, 0).toFixed(1) : "—";
  const sleepNote = !sleeps.length ? "暂无睡眠"
    : knownSleeps.length < sleeps.length ? (sleeps.length - knownSleeps.length) + " 段时长未知"
    : "已知时长合计 · 非设备测量";
  const recent = [
    ...meals.map((record) => ({
      kind: "meal" as Kind, id: record.id, title: record.foodName,
      detail: record.mealType + " · " + timeLabel(record.occurredAt), at: record.occurredAt,
    })),
    ...trainings.map((record) => ({
      kind: "training" as Kind, id: record.id, title: record.exercise,
      detail: (record.mode === "cardio"
        ? record.durationMinutes === undefined ? "时长未知" : record.durationMinutes + " 分钟"
        : record.sets.filter((set) => !set.isWarmup).length + " 工作组") + " · " + timeLabel(record.occurredAt),
      at: record.occurredAt,
    })),
    ...sleeps.map((record) => ({
      kind: "sleep" as Kind, id: record.id, title: "睡眠记录",
      detail: (sleepHours(record) === null ? "时长未知" : sleepHours(record)!.toFixed(1) + " 小时估算睡眠") + " · " + dateLabel(record.wokeAt),
      at: record.wokeAt,
    })),
  ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 5);

  return (
    <ScrollView contentContainerStyle={contentStyle} showsVerticalScrollIndicator={false}>
      <View style={st.head}>
        <View style={st.headText}>
          <Text style={st.protocol}>DAILY PROTOCOL</Text>
          <Text style={st.days}>已记 {days} 天</Text>
          <Text style={st.date} numberOfLines={1} adjustsFontSizeToFit>
            {String(nowDate.getMonth() + 1) + "月" + nowDate.getDate() + "日" + nowDate.toLocaleDateString("zh-CN", { weekday: "long" })}
          </Text>
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel="打开我的资料" onPress={onProfile} style={({ pressed }) => [st.avatar, pressed && base.pressed]}>
          <Ionicons name="person-outline" size={23} color={color.ink} />
        </Pressable>
      </View>

      <View style={st.card}>
        <Text style={st.cardTitle}>24H RHYTHM MATRIX</Text>
        <Text style={st.cardSubtitle}>24格节律矩阵·实时映射三项生理记录</Text>
        <RhythmMatrix marks={marks} now={now} />
      </View>

      <View style={st.recordCount} accessible accessibilityLabel={"今日已记 " + count + " 条记录，饮食 " + meals.length + " 餐，训练 " + trainings.length + " 次，睡眠 " + sleeps.length + " 段"}>
        <Text testID="today-count" style={[st.countNumber, Boolean(count) && { color: color.ink }]}>{count}</Text>
        <Text style={st.countLabel}>条今日记录</Text>
        <Text style={st.countHint}>
          {count ? meals.length + " 餐饮食 · " + trainings.length + " 次训练 · " + sleeps.length + " 段睡眠" : "轻触下方按钮记录今天第一笔数据"}
        </Text>
      </View>

      <View style={st.actions}>
        <Pressable accessibilityRole="button" onPress={() => onOpen("meal")} style={({ pressed }) => [st.action, st.capture, pressed && base.pressed]}>
          <Ionicons name="camera" size={19} color={color.onInk} />
          <Text style={[st.actionText, { color: color.onInk }]}>记饮食</Text>
        </Pressable>
        {(["training", "sleep"] as const).map((kind) => (
          <Pressable
            key={kind}
            accessibilityRole="button"
            onPress={() => onOpen(kind)}
            style={({ pressed }) => [st.action, { borderWidth: 2, borderColor: moduleTone[kind].hue }, pressed && base.pressed]}
          >
            <Ionicons name={moduleTone[kind].icon} size={19} color={moduleTone[kind].text} />
            <Text style={[st.actionText, { color: moduleTone[kind].text }]}>{kind === "training" ? "记训练" : "记睡眠"}</Text>
          </Pressable>
        ))}
      </View>

      <View testID="today-nutrition" style={st.card}>
        <View style={st.nutritionBody}>
          <View style={st.nutritionHeader}>
            <View style={st.nutritionTitle}>
              <View style={[st.moduleDot, { backgroundColor: color.meal }]} />
              <Text style={st.nutritionHeading}>01 / NUTRITION · 今日饮食汇总</Text>
            </View>
            <Text style={st.mealBadge}>已记 {meals.length} 餐</Text>
          </View>
          <View style={st.calorieRow}>
            <Text style={[st.calories, !calories && { color: color.placeholder }]} numberOfLines={1} adjustsFontSizeToFit>
              {calories ? nutrientMidpointLabel(calories, "calories") : "未知"}
            </Text>
            {calories && <Text style={st.calorieUnit}>kcal{nutrients.calories.missingMeals || incompleteMeals ? " · 已知小计" : " · 估算"}</Text>}
          </View>
          <View style={st.nutritionStatus}>
            <Text style={st.statusText}>有营养估算 {knownMeals} 餐</Text>
            <Text style={st.statusText}>信息不足 {insufficientMeals} 餐</Text>
          </View>
          {incompleteMeals > 0 && <Text style={st.nutritionHint}>{incompleteMeals} 餐数据不完整，缺少数量或有效营养参考的菜品未计入。</Text>}
          {meals.length > 0 && knownMeals < meals.length && <Text style={st.nutritionHint}>仅汇总已有估算，未估算的餐食保持未知。</Text>}
          <View style={st.macros}>
            {([["protein", "蛋白质 P"], ["carbs", "碳水 C"], ["fat", "脂肪 F"]] as const).map(([nutrient, label]) => {
              const { total: value, missingMeals } = nutrients[nutrient];
              return (
                <View key={nutrient} testID={"today-nutrient-" + nutrient} style={st.macro}>
                  <Text style={st.macroLabel}>{label}</Text>
                  <View style={st.macroValueRow}>
                    <Text style={[st.macroValue, !value && { color: color.placeholder }]} numberOfLines={1} adjustsFontSizeToFit>
                      {value ? nutrientMidpointLabel(value, nutrient) : "—"}
                    </Text>
                    {value && <Text style={st.macroUnit}>g</Text>}
                  </View>
                  {value && <Text style={st.macroNote}>{missingMeals || incompleteMeals ? "已知小计" : "已有估算"}</Text>}
                  {missingMeals > 0 && <Text style={st.macroNote}>{missingMeals} 餐未知</Text>}
                </View>
              );
            })}
          </View>
        </View>
      </View>

      <View style={[st.card, st.summaryCard]}>
        <View style={st.summaryHeader}>
          <Text style={st.summaryEyebrow}>AI SYNTHESIS</Text>
          <View style={st.summaryBadges}>
            <Text style={[st.badge, st.badgeLocal]}>本地摘要</Text>
            <Text style={[st.badge, st.badgeStatus]}>{!count ? "等待今日记录" : aiSummaries.length ? "含 AI 版本" : "已更新"}</Text>
          </View>
        </View>
        <Text style={st.summaryTitle}>今日健康总结</Text>
        <Text style={st.summaryText}>{preview}</Text>
        <Pressable style={st.link} accessibilityRole="button" onPress={() => setShowLocal(!showLocal)}>
          <Ionicons name={showLocal ? "chevron-up" : "document-text-outline"} size={16} color={color.inkSoft} />
          <Text style={st.linkText}>{showLocal ? "收起摘要" : "查看完整摘要"}</Text>
        </Pressable>
        {showLocal && <MarkdownText value={summary} />}
        <SummaryVersions summaries={aiSummaries} />
        <Pressable accessibilityRole="button" style={({ pressed }) => [st.ai, pressed && base.pressed]} onPress={onAi}>
          <Ionicons name="sparkles" size={17} color={color.ink} />
          <Text style={st.aiText}>请求 AI 综合分析</Text>
        </Pressable>
        <Text style={st.aiNote}>发送前会询问，记录只在你同意后离开本机。</Text>
      </View>

      <View style={st.moduleSummaries}>
        <ModuleSummary kind="training" value={trainings.length ? String(trainings.length) : "—"} unit="次" note={trainingNote} />
        <ModuleSummary kind="sleep" value={sleepValue} unit="小时" note={sleepNote} />
      </View>

      <Text style={st.sectionTitle}>今日记录</Text>
      {recent.length ? (
        <View style={st.timeline}>
          {recent.map((record, index) => (
            <Pressable accessibilityRole="button" key={record.kind + "-" + record.id} onPress={() => onEdit(record.kind, record.id)} style={({ pressed }) => [st.row, pressed && base.pressed]}>
              <View style={st.rail}>
                <View style={[st.railDot, { backgroundColor: moduleTone[record.kind].hue }]} />
                {index < recent.length - 1 && <View style={st.railLine} />}
              </View>
              <View style={st.rowBody}>
                <Text style={type.label}>{record.title}</Text>
                <Text style={type.small}>{record.detail}</Text>
              </View>
              <Ionicons name="chevron-forward" size={17} color={color.inkFaint} style={{ alignSelf: "center" }} />
            </Pressable>
          ))}
        </View>
      ) : (
        <View style={st.timelineEmpty}>
          <Text style={type.small}>保存后可在这里查看今天的记录，或前往“记录”回顾其他日期。</Text>
        </View>
      )}
    </ScrollView>
  );
}

const createStyles = ({ color, type, shadow }: ThemeTokens) => StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 24 },
  headText: { flex: 1, minWidth: 0, gap: 4 },
  protocol: { fontSize: 11, fontWeight: "600", color: color.inkFaint, letterSpacing: 1 },
  days: { fontSize: 12, color: color.inkFaint },
  date: { ...type.display, lineHeight: 39, letterSpacing: -0.6 },
  avatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: color.surface, alignItems: "center", justifyContent: "center", ...shadow.card },
  card: { backgroundColor: color.surface, borderRadius: radius.block, padding: 20, marginBottom: 16, ...shadow.card },
  cardTitle: { fontSize: 11, fontWeight: "700", color: color.inkFaint, letterSpacing: 0.5, marginBottom: 8 },
  cardSubtitle: { fontSize: 13, lineHeight: 19, color: color.inkSoft, marginBottom: 16 },
  recordCount: { alignItems: "center", paddingTop: 30, paddingBottom: 32 },
  countNumber: { fontSize: 56, lineHeight: 60, fontWeight: "800", color: color.placeholder, marginBottom: 8, ...type.numeric },
  countLabel: { fontSize: 14, lineHeight: 20, fontWeight: "600", color: color.placeholder },
  countHint: { fontSize: 13, lineHeight: 19, color: color.inkFaint, marginTop: 12, textAlign: "center" },
  actions: { flexDirection: "row", gap: 12, marginBottom: 16 },
  action: { flex: 1, minWidth: 0, height: 56, borderRadius: radius.pill, backgroundColor: color.surface, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, ...shadow.card },
  capture: { backgroundColor: color.ink },
  actionText: { fontSize: 15, fontWeight: "700", flexShrink: 1 },
  nutritionBody: { borderTopWidth: 1, borderColor: color.line, paddingTop: 16 },
  nutritionHeader: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 16 },
  nutritionTitle: { flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 1, minWidth: 0 },
  nutritionHeading: { fontSize: 11, fontWeight: "700", color: color.inkFaint, letterSpacing: 0.3, flexShrink: 1 },
  mealBadge: { fontSize: 11, lineHeight: 16, fontWeight: "700", color: color.mealText, backgroundColor: color.mealTint, paddingVertical: 4, paddingHorizontal: 10, borderRadius: 12, overflow: "hidden" },
  moduleDot: { width: 6, height: 6, borderRadius: 3 },
  calorieRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", columnGap: 8, marginBottom: 8 },
  calories: { fontSize: 40, lineHeight: 49, fontWeight: "800", color: color.ink, flexShrink: 1, ...type.numeric },
  calorieUnit: { fontSize: 12, color: color.inkFaint },
  nutritionStatus: { flexDirection: "row", flexWrap: "wrap", gap: 16 },
  statusText: { fontSize: 12, lineHeight: 18, color: color.inkFaint },
  nutritionHint: { fontSize: 12, lineHeight: 18, color: color.inkSoft, marginTop: 8 },
  macros: { flexDirection: "row", gap: 12, marginTop: 16 },
  macro: { flex: 1, minWidth: 0, alignItems: "center", justifyContent: "center", backgroundColor: color.softSurface, paddingVertical: 12, paddingHorizontal: 6, borderRadius: 8 },
  macroLabel: { fontSize: 12, color: color.inkFaint, marginBottom: 4 },
  macroValueRow: { flexDirection: "row", alignItems: "baseline", justifyContent: "center", columnGap: 3, maxWidth: "100%" },
  macroValue: { fontSize: 16, lineHeight: 21, fontWeight: "700", color: color.ink, textAlign: "center", flexShrink: 1, ...type.numeric },
  macroUnit: { fontSize: 10, lineHeight: 15, color: color.inkFaint },
  macroNote: { fontSize: 10, lineHeight: 15, color: color.inkFaint, marginTop: 3 },
  summaryCard: { backgroundColor: color.softSurface, borderWidth: 1, borderColor: color.line },
  summaryHeader: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 12 },
  summaryEyebrow: { fontSize: 11, fontWeight: "700", color: color.inkFaint, letterSpacing: 0.5 },
  summaryBadges: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  badge: { fontSize: 10, lineHeight: 14, fontWeight: "700", paddingVertical: 3, paddingHorizontal: 8, borderRadius: 4, overflow: "hidden" },
  badgeLocal: { backgroundColor: color.empty, color: color.inkSoft },
  badgeStatus: { backgroundColor: color.trainingTint, color: color.trainingText },
  summaryTitle: { fontSize: 20, lineHeight: 27, fontWeight: "800", color: color.ink, marginBottom: 8 },
  summaryText: { fontSize: 13, lineHeight: 21, color: color.inkFaint },
  link: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 44, marginTop: 4 },
  linkText: { color: color.inkSoft, fontWeight: "600", fontSize: 13 },
  ai: { minHeight: 48, borderRadius: radius.pill, backgroundColor: color.surface, borderWidth: 1, borderColor: color.lineStrong, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
  aiText: { color: color.ink, fontSize: 14, fontWeight: "700" },
  aiNote: { fontSize: 11, lineHeight: 17, color: color.inkFaint, textAlign: "center", marginTop: 8 },
  moduleSummaries: { flexDirection: "row", gap: 12 },
  moduleSummary: { flex: 1, minWidth: 0, backgroundColor: color.surface, borderRadius: radius.block, padding: 16, ...shadow.card },
  moduleHead: { flexDirection: "row", alignItems: "center", gap: 6 },
  moduleTitle: { fontSize: 12, color: color.inkFaint },
  moduleValue: { fontSize: 28, lineHeight: 36, fontWeight: "800", color: color.ink, marginTop: 8, ...type.numeric },
  moduleUnit: { fontSize: 12, fontWeight: "500", color: color.inkSoft },
  moduleNote: { fontSize: 11, lineHeight: 17, color: color.inkFaint, marginTop: 2 },
  sectionTitle: { ...type.title, marginTop: 24, marginBottom: 12 },
  timeline: { backgroundColor: color.surface, borderRadius: radius.block, paddingHorizontal: 16, paddingVertical: 4, ...shadow.card },
  row: { flexDirection: "row", alignItems: "stretch", gap: 12, minHeight: 64 },
  rail: { width: 14, alignItems: "center", paddingTop: 22 },
  railDot: { width: 10, height: 10, borderRadius: 5 },
  railLine: { flex: 1, width: 2, backgroundColor: color.line, marginTop: 4 },
  rowBody: { flex: 1, minWidth: 0, justifyContent: "center", paddingVertical: 12 },
  timelineEmpty: { backgroundColor: color.surface, borderRadius: radius.block, padding: 20, ...shadow.card },
});
