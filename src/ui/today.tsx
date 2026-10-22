import React, { useEffect, useState } from "react";
import { Animated, AppState, Pressable, ScrollView, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { AppData, MealRecord, NutrientRange } from "../types";
import { localDate, mealCalories, summaryMarkdown } from "../domain";
import { MarkdownText, SummaryVersions, useBaseStyles } from "./components";
import { hourKinds, intersectsHour, RhythmMatrix, type RhythmMark } from "./rhythm";
import { minutesInto, recordDate, sleepHours, timeLabel } from "./format";
import type { ThemeTokens } from "./theme";
import { useTheme, useThemedStyles } from "./theme-provider";
import { animateLayout, PressScale, Reveal, useTween } from "./motion";
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

type Filter = "all" | Kind;
type Row = { kind: Kind; id: string; title: string; time: string; meta: string; at: string; mark: RhythmMark };

const pad = (value: number) => String(value).padStart(2, "0");

function greeting(hour: number) {
  if (hour < 5) return "夜深了";
  if (hour < 11) return "早上好";
  if (hour < 14) return "中午好";
  if (hour < 18) return "下午好";
  return "晚上好";
}

function Kpi({ kind, value, unit, sub, index }: { kind: Kind; value: string; unit: string; sub: string; index: number }) {
  const { moduleTone, color } = useTheme();
  const st = useThemedStyles(createStyles);
  const tone = moduleTone[kind];
  const empty = value === "—";
  return (
    <Reveal index={index} style={st.kpiSlot}>
    <View style={[st.kpi, { backgroundColor: tone.tint }]}>
      <View style={st.kpiLabelRow}>
        <View style={[st.kpiIcon, { backgroundColor: tone.hue }]}>
          <Ionicons name={tone.icon} size={13} color={tone.onHue} />
        </View>
        <Text style={st.kpiLabel}>{tone.name}</Text>
      </View>
      <Text style={[st.kpiValue, empty && { color: color.inkFaint }]} numberOfLines={1} adjustsFontSizeToFit>
        {value}{!empty && <Text style={st.kpiUnit}> {unit}</Text>}
      </Text>
      <Text style={st.kpiSub} numberOfLines={1}>{sub}</Text>
    </View>
    </Reveal>
  );
}

export function Today({
  data,
  contentStyle,
  onOpen,
  onEdit,
  onAi,
  onProfile,
  onAllRecords,
}: {
  data: AppData;
  contentStyle: StyleProp<ViewStyle>;
  onOpen: (kind: Kind) => void;
  onEdit: (kind: Kind, id: string) => void;
  onAi: () => void;
  onProfile: () => void;
  onAllRecords: () => void;
}) {
  const { color, moduleTone } = useTheme();
  const base = useBaseStyles();
  const st = useThemedStyles(createStyles);
  const [showLocal, setShowLocal] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [selectedHour, setSelectedHour] = useState<number | null>(null);
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
  const quality = [...sleeps].sort((a, b) => Date.parse(b.wokeAt) - Date.parse(a.wokeAt)).find((record) => record.quality)?.quality;
  const latestTraining = [...trainings].sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))[0];
  const calorieLabel = calories ? nutrientMidpointLabel(calories, "calories") : null;
  const target = data.profile.calorieTarget && data.profile.calorieTarget > 0 ? data.profile.calorieTarget : null;
  const progress = target && calories ? Math.min(1, Number(calorieLabel) / target) : 0;
  const rows: Row[] = [
    ...meals.map((record) => {
      const value = mealCalories(record);
      return {
        kind: "meal" as Kind, id: record.id, title: record.foodName, time: timeLabel(record.occurredAt), at: record.occurredAt,
        meta: record.mealType + (value ? " · " + nutrientMidpointLabel(value, "calories") + " kcal" : ""),
        mark: { kind: "meal" as const, start: minutesInto(date, record.occurredAt) },
      };
    }),
    ...trainings.map((record) => {
      const start = minutesInto(date, record.occurredAt);
      return {
        kind: "training" as Kind, id: record.id, title: record.exercise, time: timeLabel(record.occurredAt), at: record.occurredAt,
        meta: record.mode === "cardio"
          ? record.durationMinutes === undefined ? "时长未知" : record.durationMinutes + " 分钟"
          : record.sets.filter((set) => !set.isWarmup).length + " 工作组",
        mark: { kind: "training" as const, start, end: record.mode === "cardio" && record.durationMinutes ? start + record.durationMinutes : undefined },
      };
    }),
    ...sleeps.map((record) => {
      const hours = sleepHours(record);
      return {
        kind: "sleep" as Kind, id: record.id, title: "睡眠记录", time: timeLabel(record.wokeAt), at: record.wokeAt,
        meta: hours === null ? "时长未知" : hours.toFixed(1) + " 小时估算睡眠",
        mark: { kind: "sleep" as const, start: minutesInto(date, record.fellAsleepAt), end: minutesInto(date, record.wokeAt) },
      };
    }),
  ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const filteredMarks = filter === "all" ? marks : marks.filter((mark) => mark.kind === filter);
  const activeHours = hourKinds(marks).filter((kinds) => kinds.length).length;
  const filtered = filter === "all" ? rows : rows.filter((row) => row.kind === filter);
  const inHour = (row: Row) => selectedHour !== null && intersectsHour(row.mark, selectedHour);
  const visible = selectedHour === null ? filtered.slice(0, 5) : filtered;
  const hourCount = filtered.filter(inHour).length;
  const selectFilter = (next: Filter) => { animateLayout(); setFilter(next); setSelectedHour(null); };
  const selectHour = (hour: number | null) => { animateLayout(); setSelectedHour(hour); };
  const fill = useTween(progress);

  return (
    <ScrollView contentContainerStyle={[contentStyle, st.screen]} showsVerticalScrollIndicator={false}>
      <Reveal index={0} style={st.head}>
        <View style={st.headText}>
          <View style={st.capRow}>
            <Text style={st.cap}>DAILY PROTOCOL</Text>
            <Text style={st.pill}>已记 {days} 天</Text>
          </View>
          <Text style={st.greeting}>{greeting(nowDate.getHours())}</Text>
          <Text style={st.headSub}>{count ? "今天已留下 " + count + " 条记录，保持这个节奏。" : "从一餐、一次训练或一段睡眠开始。"}</Text>
        </View>
        <PressScale accessibilityRole="button" accessibilityLabel="打开我的资料" onPress={onProfile} style={st.avatar} scaleTo={0.9}>
          <Ionicons name="person-outline" size={18} color={color.ink} />
        </PressScale>
      </Reveal>

      <View style={st.kpis}>
        <Kpi index={1} kind="meal" value={calorieLabel ?? "—"} unit="kcal" sub={meals.length ? meals.length + " 餐 · " + (nutrients.calories.missingMeals || incompleteMeals ? "已知小计" : "估算") : "暂无饮食"} />
        <Kpi index={2} kind="training" value={trainings.length ? String(trainings.length) : "—"} unit="次" sub={trainingNote} />
        <Kpi index={3} kind="sleep" value={sleepValue} unit="h" sub={quality ? "质量 " + quality + "/5" : sleepNote} />
      </View>

      <Reveal index={4} style={st.actions}>
        <PressScale accessibilityRole="button" onPress={() => onOpen("meal")} style={[st.action, st.capture]}>
          <Ionicons name="camera" size={17} color={color.onMeal} />
          <Text style={[st.actionText, { color: color.onMeal }]}>记饮食</Text>
        </PressScale>
        {(["training", "sleep"] as const).map((kind) => (
          <PressScale
            key={kind}
            accessibilityRole="button"
            onPress={() => onOpen(kind)}
            style={[st.action, st.outline, { borderColor: moduleTone[kind].hue, backgroundColor: moduleTone[kind].tint }]}
          >
            <Ionicons name={moduleTone[kind].icon} size={15} color={moduleTone[kind].hue} />
            <Text style={st.actionText}>{kind === "training" ? "记训练" : "记睡眠"}</Text>
          </PressScale>
        ))}
      </Reveal>

      <Text style={st.hint}>拍照或直接写下吃了什么 · <Text style={st.hintStrong}>已有 {days} 个日期</Text>留下记录</Text>

      <Reveal index={5}>
      <View testID="today-nutrition" style={st.card}>
        <View style={st.ctop}>
          <View style={st.capRow}>
            <View style={[st.chip, { backgroundColor: color.meal }]} />
            <Text style={st.cap}>01 / NUTRITION · 今日饮食</Text>
          </View>
          <Text style={st.pill}>已记 {meals.length} 餐</Text>
        </View>
        <View style={st.kcalRow}>
          <Text style={[st.kcal, !calories && { color: color.inkFaint }]} numberOfLines={1} adjustsFontSizeToFit>
            {calorieLabel ?? "未知"}
          </Text>
          {calories && <Text style={st.kcalUnit}>kcal{nutrients.calories.missingMeals || incompleteMeals ? " · 已知小计" : " · 估算"}</Text>}
        </View>
        <View style={st.bar}>
          <Animated.View style={[st.barFill, { width: fill.interpolate({ inputRange: [0, 1], outputRange: ["0%", "100%"] }) }]} />

        </View>
        <View style={st.barText}>
          <Text style={st.barLabel}>{target ? (calorieLabel ?? "—") + " / " + target + " kcal" : "未设置热量目标"}</Text>
          <Text style={st.barLabel}>{target ? (calories ? Math.round(progress * 100) + "%" : "—") : "可在「我的」中设置"}</Text>
        </View>
        <View style={st.status}>
          <Text style={st.statusText}>有营养估算 {knownMeals} 餐</Text>
          <Text style={st.statusText}>信息不足 {insufficientMeals} 餐</Text>
        </View>
        {incompleteMeals > 0 && <Text style={st.nutritionHint}>{incompleteMeals} 餐数据不完整，缺少数量或有效营养参考的菜品未计入。</Text>}
        {meals.length > 0 && knownMeals < meals.length && <Text style={st.nutritionHint}>仅汇总已有估算，未估算的餐食保持未知。</Text>}
        {meals.length ? (
          <View style={st.macros}>
            {([["protein", "蛋白质 P"], ["carbs", "碳水 C"], ["fat", "脂肪 F"]] as const).map(([nutrient, label]) => {
              const { total: value, missingMeals } = nutrients[nutrient];
              return (
                <View key={nutrient} testID={"today-nutrient-" + nutrient} style={st.macro}>
                  <Text style={st.macroLabel}>{label}</Text>
                  <View style={st.macroValueRow}>
                    <Text style={[st.macroValue, !value && { color: color.inkFaint }]} numberOfLines={1} adjustsFontSizeToFit>
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
        ) : (
          <View style={st.macroEmpty}>
            <View style={st.macroEmptyIcon}><Text style={st.macroEmptyGlyph}>✦</Text></View>
            <Text style={st.macroEmptyText}>拍照记录后会自动估算蛋白质 / 碳水 / 脂肪</Text>
          </View>
        )}
      </View>
      </Reveal>

      <Reveal index={6} style={st.dual}>
        <View style={[st.card, st.half]}>
          <View style={st.capRow}>
            <View style={[st.chip, { backgroundColor: color.training }]} />
            <Text style={st.cap}>02 / 训练</Text>
          </View>
          <Text style={[st.halfValue, !trainings.length && { color: color.inkFaint }]}>
            {trainings.length || "—"}{trainings.length > 0 && <Text style={st.halfUnit}> 次</Text>}
          </Text>
          <Text style={st.halfSub} numberOfLines={2}>{latestTraining ? timeLabel(latestTraining.occurredAt) + " " + latestTraining.exercise + " · " + trainingNote : trainingNote}</Text>
        </View>
        <View style={[st.card, st.half]}>
          <View style={st.capRow}>
            <View style={[st.chip, { backgroundColor: color.sleep }]} />
            <Text style={st.cap}>03 / 睡眠</Text>
          </View>
          <Text style={[st.halfValue, sleepValue === "—" && { color: color.inkFaint }]}>
            {sleepValue}{sleepValue !== "—" && <Text style={st.halfUnit}> h</Text>}
          </Text>
          <View style={st.qbar} accessible accessibilityLabel={quality ? "主观质量 " + quality + " / 5" : "主观质量未填写"}>
            {[1, 2, 3, 4, 5].map((step) => <View key={step} style={[st.qstep, quality !== undefined && step <= quality && { backgroundColor: color.sleep }]} />)}
          </View>
          <Text style={st.halfSub} numberOfLines={2}>{sleepNote}</Text>
        </View>
      </Reveal>

      <Reveal index={7}>
      <View style={st.card}>
        <View style={st.ctop}>
          <Text style={st.cap}>AI SYNTHESIS · 今日总结</Text>
          <View style={st.badges}>
            <Text style={st.pill}>本地摘要</Text>
            <Text style={[st.pill, { backgroundColor: color.trainingTint, color: color.trainingText }]}>{!count ? "等待今日记录" : aiSummaries.length ? "含 AI 版本" : "已更新"}</Text>
          </View>
        </View>
        <Text style={st.summaryTitle}>今日健康总结</Text>
        <Text style={st.summaryText}>{preview}</Text>
        <Pressable style={({ pressed }) => [st.link, pressed && base.pressed]} accessibilityRole="button" onPress={() => { animateLayout(); setShowLocal(!showLocal); }}>
          <Ionicons name={showLocal ? "chevron-up" : "document-text-outline"} size={14} color={color.inkSoft} />
          <Text style={st.linkText}>{showLocal ? "收起摘要" : "查看完整摘要"}</Text>
        </Pressable>
        {showLocal && <MarkdownText value={summary} />}
        <SummaryVersions summaries={aiSummaries} />
        <PressScale accessibilityRole="button" style={st.ai} onPress={onAi}>
          <Ionicons name="sparkles" size={15} color={color.paper} />
          <Text style={st.aiText}>请求 AI 综合分析</Text>
        </PressScale>
        <Text style={st.aiNote}>发送前会询问，记录只在你同意后离开本机。</Text>
      </View>
      </Reveal>

      <Reveal index={8}>
      <View testID="today-timeline" style={st.card}>
        <View style={st.thead}>
          <View>
            <Text style={st.cap}>TIMELINE · 今日记录</Text>
            <View style={st.countRow} accessible accessibilityLabel={"今日已记 " + count + " 条记录，饮食 " + meals.length + " 餐，训练 " + trainings.length + " 次，睡眠 " + sleeps.length + " 段"}>
              <Text testID="today-count" style={st.countNumber}>{count}</Text>
              <Text style={st.countSmall}>条 · 活跃 {activeHours}/24H</Text>
            </View>
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel="查看全部记录" hitSlop={8} onPress={onAllRecords} style={({ pressed }) => pressed && base.pressed}>
            <Text style={st.allLink}>查看全部 ›</Text>
          </Pressable>
        </View>
        <RhythmMatrix marks={filteredMarks} now={now} compact selectedHour={selectedHour} onSelectHour={selectHour} />
        <View style={st.filters} accessibilityRole="radiogroup" accessibilityLabel="筛选今日记录">
          {(["all", "sleep", "meal", "training"] as const).map((key) => {
            const on = filter === key;
            return (
              <Pressable
                key={key}
                accessibilityRole="radio"
                accessibilityState={{ checked: on }}
                accessibilityLabel={"筛选 " + (key === "all" ? "全部" : moduleTone[key].name)}
                onPress={() => selectFilter(key)}
                style={({ pressed }) => [st.filter, on && st.filterOn, pressed && base.pressed]}
              >
                {key !== "all" && <View style={[st.swatch, { backgroundColor: moduleTone[key].hue }]} />}
                <Text style={[st.filterText, on && st.filterTextOn]}>{key === "all" ? "全部" : moduleTone[key].name}</Text>
              </Pressable>
            );
          })}
        </View>
        {selectedHour === null ? <View style={st.divider} /> : (
          <View style={st.selbar}>
            <Text style={st.selText}>
              <Text style={st.selStrong}>{pad(selectedHour)}:00 – {pad(selectedHour + 1)}:00</Text> · {hourCount} 条记录
            </Text>
            <Pressable accessibilityRole="button" accessibilityLabel="清除时段选择" hitSlop={8} onPress={() => selectHour(null)}>
              <Text style={st.selText}>清除 ✕</Text>
            </Pressable>
          </View>
        )}
        {visible.length ? visible.map((row, index) => {
          const hit = inHour(row);
          return (
            <Pressable
              accessibilityRole="button"
              key={row.kind + "-" + row.id}
              onPress={() => onEdit(row.kind, row.id)}
              style={({ pressed }) => [st.row, index > 0 && st.rowLine, selectedHour !== null && (hit ? st.rowHit : st.rowDim), pressed && base.pressed]}
            >
              <Text style={st.rowTime}>{row.time}</Text>
              <View style={[st.swatch, st.rowSwatch, { backgroundColor: moduleTone[row.kind].hue }]} />
              <Text style={st.rowTitle} numberOfLines={1}>{row.title}</Text>
              <Text style={st.rowMeta} numberOfLines={1}>{row.meta}</Text>
            </Pressable>
          );
        }) : (
          <Text style={st.empty}>{count ? "这个分类今天还没有记录。" : "保存后可在这里查看今天的记录，或在“我的 → 全部记录”回顾其他日期。"}</Text>
        )}
        {selectedHour === null && filtered.length > visible.length && (
          <Pressable accessibilityRole="button" onPress={onAllRecords} style={({ pressed }) => [st.more, pressed && base.pressed]}>
            <Text style={st.allLink}>还有 {filtered.length - visible.length} 条 · 查看全部 ›</Text>
          </Pressable>
        )}
      </View>
      </Reveal>
    </ScrollView>

  );
}

const createStyles = ({ color, type, shadow }: ThemeTokens) => StyleSheet.create({
  screen: { gap: 14 },
  head: { flexDirection: "row", alignItems: "flex-start", gap: 12, marginBottom: 2 },
  greeting: { fontSize: 28, lineHeight: 34, fontWeight: "800", color: color.ink, letterSpacing: -0.5, marginTop: 6 },
  headSub: { fontSize: 12.5, lineHeight: 18, color: color.inkSoft, marginTop: 2 },
  headText: { flex: 1, minWidth: 0 },
  capRow: { flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 1 },
  cap: { ...type.cap, flexShrink: 1 },
  pill: { fontSize: 10, lineHeight: 14, fontWeight: "700", color: color.inkSoft, backgroundColor: color.sunken, paddingVertical: 2, paddingHorizontal: 8, borderRadius: 999, overflow: "hidden" },
  avatar: { width: 42, height: 42, borderRadius: 21, backgroundColor: color.surface, borderWidth: 1, borderColor: color.line, alignItems: "center", justifyContent: "center", ...shadow.card },
  kpis: { flexDirection: "row", gap: 10 },
  kpiSlot: { flex: 1, minWidth: 0 },
  kpi: { flex: 1, minHeight: 128, borderRadius: 20, paddingTop: 14, paddingHorizontal: 12, paddingBottom: 14, justifyContent: "space-between" },
  kpiLabelRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  kpiIcon: { width: 22, height: 22, borderRadius: 11, alignItems: "center", justifyContent: "center" },
  kpiLabel: { fontSize: 13, lineHeight: 17, fontWeight: "800", color: color.inkSoft },
  kpiValue: { fontSize: 32, lineHeight: 38, fontWeight: "800", color: color.ink, marginTop: 10, ...type.mono },
  kpiUnit: { fontSize: 13, fontWeight: "700", color: color.inkSoft },
  kpiSub: { fontSize: 12, lineHeight: 16, color: color.inkFaint, marginTop: 6 },
  actions: { flexDirection: "row", gap: 8 },
  action: { flex: 1, minWidth: 0, height: 50, borderRadius: 999, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6 },
  capture: { flex: 1.4, backgroundColor: color.meal, ...shadow.card },
  outline: { borderWidth: 1 },
  actionText: { fontSize: 14, fontWeight: "800", color: color.ink, flexShrink: 1 },
  hint: { fontSize: 11, lineHeight: 16, color: color.inkFaint, textAlign: "center", marginTop: -2 },
  hintStrong: { color: color.inkSoft, fontWeight: "700" },
  card: { backgroundColor: color.surface, borderRadius: 20, padding: 18, borderWidth: 1, borderColor: color.line, ...shadow.card },
  ctop: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8 },
  chip: { width: 8, height: 8, borderRadius: 2 },
  kcalRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", columnGap: 4, marginTop: 10 },
  kcal: { fontSize: 30, lineHeight: 36, fontWeight: "800", color: color.ink, flexShrink: 1, ...type.mono },
  kcalUnit: { fontSize: 12, fontWeight: "700", color: color.inkSoft },
  bar: { height: 8, borderRadius: 4, backgroundColor: color.sunken, marginTop: 10, overflow: "hidden" },
  barFill: { height: "100%", borderRadius: 4, backgroundColor: color.meal },
  barText: { flexDirection: "row", justifyContent: "space-between", marginTop: 4, gap: 8 },
  barLabel: { fontSize: 10, lineHeight: 14, color: color.inkFaint, ...type.mono },
  status: { flexDirection: "row", flexWrap: "wrap", columnGap: 14, marginTop: 10 },
  statusText: { fontSize: 11, lineHeight: 16, color: color.inkSoft },
  nutritionHint: { fontSize: 11, lineHeight: 17, color: color.inkSoft, marginTop: 6 },
  macros: { flexDirection: "row", gap: 8, marginTop: 12 },
  macro: { flex: 1, minWidth: 0, alignItems: "center", backgroundColor: color.sunken, paddingVertical: 12, paddingHorizontal: 6, borderRadius: 14 },
  macroLabel: { fontSize: 10.5, lineHeight: 14, fontWeight: "700", color: color.inkSoft, marginBottom: 4 },
  macroValueRow: { flexDirection: "row", alignItems: "baseline", justifyContent: "center", columnGap: 2, maxWidth: "100%" },
  macroValue: { fontSize: 16, lineHeight: 21, fontWeight: "800", color: color.ink, flexShrink: 1, ...type.mono },
  macroUnit: { fontSize: 10, lineHeight: 15, fontWeight: "700", color: color.inkSoft },
  macroNote: { fontSize: 10, lineHeight: 14, color: color.inkFaint, marginTop: 2 },
  macroEmpty: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 12, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10, backgroundColor: color.sunken },
  macroEmptyIcon: { width: 22, height: 22, borderRadius: 11, backgroundColor: color.mealTint, alignItems: "center", justifyContent: "center" },
  macroEmptyGlyph: { fontSize: 12, lineHeight: 14, color: color.meal },
  macroEmptyText: { flex: 1, fontSize: 11.5, lineHeight: 16, color: color.inkSoft },
  dual: { flexDirection: "row", gap: 8 },
  half: { flex: 1, minWidth: 0 },
  halfValue: { fontSize: 24, lineHeight: 30, fontWeight: "800", color: color.ink, marginTop: 8, ...type.mono },
  halfUnit: { fontSize: 11, fontWeight: "700", color: color.inkSoft },
  halfSub: { fontSize: 10.5, lineHeight: 15, color: color.inkFaint, marginTop: 4 },
  qbar: { flexDirection: "row", gap: 3, marginTop: 8 },
  qstep: { flex: 1, height: 5, borderRadius: 2, backgroundColor: color.sunken },
  badges: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  summaryTitle: { fontSize: 16, lineHeight: 22, fontWeight: "800", color: color.ink, marginTop: 10 },
  summaryText: { fontSize: 12.5, lineHeight: 21, color: color.inkSoft, marginTop: 6 },
  link: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 40, marginTop: 2 },
  linkText: { color: color.inkSoft, fontWeight: "700", fontSize: 12 },
  ai: { minHeight: 46, borderRadius: 999, backgroundColor: color.ink, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, marginTop: 6 },
  aiText: { color: color.paper, fontSize: 13.5, fontWeight: "800" },
  aiNote: { fontSize: 10.5, lineHeight: 15, color: color.inkFaint, textAlign: "center", marginTop: 8 },
  thead: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end", gap: 8 },
  countRow: { flexDirection: "row", alignItems: "baseline", gap: 4, marginTop: 6 },
  countNumber: { fontSize: 22, lineHeight: 24, fontWeight: "800", color: color.ink, ...type.mono },
  countSmall: { fontSize: 12, fontWeight: "700", color: color.inkSoft },
  allLink: { fontSize: 10.5, lineHeight: 14, color: color.inkFaint, fontWeight: "600" },
  filters: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 12 },
  filter: { flexDirection: "row", alignItems: "center", gap: 5, paddingVertical: 7, paddingHorizontal: 12, borderRadius: 999, backgroundColor: color.sunken },

  filterOn: { backgroundColor: color.ink },
  filterText: { fontSize: 11, lineHeight: 15, fontWeight: "700", color: color.inkSoft },
  filterTextOn: { color: color.paper },
  swatch: { width: 7, height: 7, borderRadius: 2 },
  divider: { height: 1, backgroundColor: color.line, marginTop: 14, marginBottom: 2 },
  selbar: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 12, paddingVertical: 7, paddingHorizontal: 10, borderRadius: 8, backgroundColor: color.sunken },
  selText: { fontSize: 11, lineHeight: 15, color: color.inkSoft },
  selStrong: { color: color.ink, fontWeight: "800", ...type.mono },
  row: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10, minHeight: 40 },
  rowLine: { borderTopWidth: 1, borderTopColor: color.line },
  rowHit: { backgroundColor: color.highlight, marginHorizontal: -8, paddingHorizontal: 8, borderRadius: 8, borderTopColor: "transparent" },
  rowDim: { opacity: 0.3 },
  rowTime: { width: 38, fontSize: 11, color: color.inkFaint, ...type.mono },
  rowSwatch: { width: 8, height: 8 },
  rowTitle: { flex: 1, minWidth: 0, fontSize: 12.5, lineHeight: 18, color: color.ink, fontWeight: "600" },
  rowMeta: { flexShrink: 0, maxWidth: "42%", fontSize: 11, color: color.inkSoft, ...type.mono },
  empty: { fontSize: 12, lineHeight: 19, color: color.inkSoft, paddingVertical: 12 },
  more: { alignItems: "center", paddingTop: 10, borderTopWidth: 1, borderTopColor: color.line },
});
