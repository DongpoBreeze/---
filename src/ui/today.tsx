import React, { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { AppData, MealRecord, NutrientRange } from "../types";
import { mealCalories, summaryMarkdown } from "../domain";
import { MarkdownText, RecordThumb, SummaryVersions, s as base } from "./components";
import { Tape, type TapeMark as Mark } from "./tape";
import { dateLabel, minutesInto, nutritionRangeLabel, rangeLabel, recordDate, sleepHours, timeLabel, today } from "./format";
import { color, mono, moduleTone, radius, sans, space, type } from "./theme";
import type { Kind } from "./app-types";

function mealMacro(meal: MealRecord, key: "protein" | "carbs" | "fat"): NutrientRange | null {
  if (meal.estimate && meal.estimateStatus === "estimated") {
    const val = meal.estimate[key];
    return { min: val, max: val };
  }
  const analysis = meal.analyses?.at(-1);
  if (
    analysis &&
    analysis.sourceVersion === (meal.revision ?? 1) &&
    (analysis.analysis.status === "estimated" ||
      (analysis.analysis.status === "approximate" && (analysis.analysis.coverage?.counted ?? 0) > 0))
  ) {
    return analysis.analysis[key];
  }
  return null;
}

function sumRanges(items: Array<NutrientRange | null>): NutrientRange | null {
  const valid = items.filter((x): x is NutrientRange => x !== null);
  if (!valid.length) return null;
  return valid.reduce((acc, r) => ({ min: acc.min + r.min, max: acc.max + r.max }), { min: 0, max: 0 });
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
  const [showLocal, setShowLocal] = useState(false);
  const date = today();
  const meals = data.meals.filter((r) => recordDate(r) === date);
  const trainings = data.trainings.filter((r) => recordDate(r) === date);
  const sleeps = data.sleeps.filter((r) => recordDate(r) === date);

  const knownCalories = meals.map(mealCalories).filter((v): v is NutrientRange => v !== null);
  const totalCalories = sumRanges(knownCalories);
  const totalProtein = sumRanges(meals.map((m) => mealMacro(m, "protein")));
  const totalCarbs = sumRanges(meals.map((m) => mealMacro(m, "carbs")));
  const totalFat = sumRanges(meals.map((m) => mealMacro(m, "fat")));

  const days = new Set([
    ...data.meals.map(recordDate),
    ...data.trainings.map(recordDate),
    ...data.sleeps.map(recordDate),
  ]).size;

  const localSummary =
    data.summaries.find((r) => r.date === date && r.source !== "ai")?.markdown ??
    summaryMarkdown(data, date);
  const aiSummaries = data.summaries
    .filter((r) => r.date === date && r.source === "ai")
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const latestAi = aiSummaries[0];

  const count = meals.length + trainings.length + sleeps.length;
  const marks: Mark[] = [
    ...sleeps.map((r) => ({ kind: "sleep" as Kind, start: minutesInto(date, r.fellAsleepAt), end: minutesInto(date, r.wokeAt) })),
    ...meals.map((r) => ({ kind: "meal" as Kind, start: minutesInto(date, r.occurredAt) })),
    ...trainings.map((r) => {
      const start = minutesInto(date, r.occurredAt);
      return { kind: "training" as Kind, start, end: r.mode === "cardio" && r.durationMinutes ? start + r.durationMinutes : undefined };
    }),
  ];

  const nowDate = new Date();
  const now = nowDate.getHours() * 60 + nowDate.getMinutes();

  const latestSleep = sleeps[0];
  const sleepHrs = latestSleep ? sleepHours(latestSleep) : null;
  const sleepValue = sleepHrs !== null ? `${sleepHrs.toFixed(1)}` : "未记录";

  const recent: Array<{ kind: Kind; id: string; title: string; detail: string; at: string; imageUri?: string }> = [
    ...meals.map((r) => ({
      kind: "meal" as Kind,
      id: r.id,
      title: `${r.mealType} · ${r.foodName}`,
      detail: `${timeLabel(r.occurredAt)} · ${mealCalories(r) ? `约 ${rangeLabel(mealCalories(r), " kcal")}` : "摄入未知"}`,
      at: r.occurredAt,
      imageUri: r.imageUri,
    })),
    ...trainings.map((r) => ({
      kind: "training" as Kind,
      id: r.id,
      title: r.exercise,
      detail: `${r.mode === "cardio" ? `${r.durationMinutes ?? 0} 分钟有氧` : `${r.sets.filter((x) => !x.isWarmup).length} 工作组`} · ${timeLabel(r.occurredAt)}`,
      at: r.occurredAt,
    })),
    ...sleeps.map((r) => ({
      kind: "sleep" as Kind,
      id: r.id,
      title: "睡眠记录",
      detail: `${sleepHours(r) === null ? "时长未知" : `${sleepHours(r)!.toFixed(1)} 小时`} · 质量 ${r.quality}/5 · ${dateLabel(r.wokeAt)}`,
      at: r.wokeAt,
    })),
  ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  const previewSource = latestAi && latestAi.status === "current" ? latestAi.markdown : localSummary;
  const preview = previewSource
    .split("\n")
    .filter((line) => line.trim() && !line.startsWith("#") && !line.startsWith("-"))
    .join(" ")
    .slice(0, 180);

  const kcalValue = totalCalories ? nutritionRangeLabel(totalCalories, "calories") : "未知";
  const incompleteMeals = meals.filter((meal) => {
    const latest = meal.analyses?.at(-1);
    return (
      latest?.sourceVersion === (meal.revision ?? 1) &&
      ["user-quantity-v2", "ai-per100g-v3"].includes(latest.analysis.nutritionSource?.method ?? "") &&
      latest.analysis.nutritionSource?.coverage === "incomplete"
    );
  }).length;
  const unknownMeals = meals.length - knownCalories.length;

  const workSets = trainings.reduce((n, r) => n + r.sets.filter((x) => !x.isWarmup).length, 0);
  const cardioMins = trainings.reduce((n, r) => n + (r.mode === "cardio" ? r.durationMinutes ?? 0 : 0), 0);

  const summarySourceLabel = latestAi ? "AI 生成" : "本地估算";
  const summaryNeedsUpdate = latestAi ? latestAi.status === "stale" : count > 0;
  const summaryStatusLabel = latestAi
    ? latestAi.status === "stale"
      ? "有新记录 · 需重新分析"
      : "已是最新"
    : count > 0
      ? "尚未请求 AI 分析"
      : "等待今日记录";

  return (
    <ScrollView contentContainerStyle={contentStyle} showsVerticalScrollIndicator={false}>
      {/* Top Protocol Header */}
      <View style={st.head}>
        <View style={{ flex: 1 }}>
          <View style={st.protocolRow}>
            <Text style={type.caption}>DAILY PROTOCOL</Text>
            <View style={st.streakBadge}>
              <Text style={st.streakBadgeText}>已记 {days} 天</Text>
            </View>
          </View>
          <Text style={st.date}>
            {nowDate.toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long" })}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          onPress={onProfile}
          style={st.avatar}
          accessibilityLabel="打开我的资料"
        >
          <Ionicons name="person-outline" size={18} color={color.ink} />
        </Pressable>
      </View>

      {/* Signature 24-Slot Barcode Rhythm Matrix */}
      <View
        style={st.matrixCard}
        accessible
        accessibilityLabel={`今日节律矩阵：已记下 ${count} 条，饮食 ${meals.length} 餐，训练 ${trainings.length} 次，睡眠 ${sleeps.length} 段`}
      >
        <View style={st.matrixHead}>
          <View>
            <Text style={type.caption}>24H RHYTHM MATRIX</Text>
            <Text style={st.matrixSub}>24格节律矩阵 · 实时映射三项生理记录</Text>
          </View>
          <View style={st.nowPill}>
            <View style={st.nowDot} />
            <Text style={st.nowText}>NOW {timeLabel(nowDate.toISOString())}</Text>
          </View>
        </View>
        <Tape marks={marks} now={now} />
        <View style={st.matrixFoot}>
          <View style={st.matrixCountRow}>
            <Text style={st.matrixCount}>{count}</Text>
            <Text style={st.matrixCountUnit}>条今日记录</Text>
          </View>
          <Text style={st.matrixHint}>
            {count ? `饮食 ${meals.length} · 训练 ${trainings.length} · 睡眠 ${sleeps.length}` : "从下方入口记录今天第一笔数据"}
          </Text>
        </View>
      </View>

      {/* Primary Quick Entry Bar */}
      <View style={st.actions}>
        <Pressable
          accessibilityRole="button"
          onPress={() => onOpen("meal")}
          style={({ pressed }) => [st.capture, pressed && base.pressed]}
        >
          <Ionicons name="camera-outline" size={20} color={color.onInk} />
          <Text style={st.captureTitle}>记饮食</Text>
        </Pressable>
        {(["training", "sleep"] as const).map((kind) => (
          <Pressable
            key={kind}
            accessibilityRole="button"
            onPress={() => onOpen(kind)}
            style={({ pressed }) => [
              st.sideAction,
              { borderColor: moduleTone[kind].line, backgroundColor: color.surface },
              pressed && base.pressed,
            ]}
          >
            <View style={[st.sideDot, { backgroundColor: moduleTone[kind].hue }]} />
            <Ionicons name={moduleTone[kind].icon} size={18} color={color.ink} />
            <Text style={st.sideText}>{kind === "training" ? "记训练" : "记睡眠"}</Text>
          </Pressable>
        ))}
      </View>

      {/* 01 / Today Nutrition Ledger Card */}
      <View style={st.ledgerCard}>
        <View style={st.cardTopBar}>
          <View style={st.cardTagRow}>
            <View style={[st.moduleChip, { backgroundColor: color.meal }]} />
            <Text style={type.caption}>01 / NUTRITION · 今日饮食汇总</Text>
          </View>
          <Text style={st.mealCountBadge}>已记 {meals.length} 餐</Text>
        </View>

        <View style={st.nutritionMain}>
          <View style={{ flex: 1 }}>
            <Text style={st.metricLabel}>总热量范围</Text>
            <View style={st.kcalRow}>
              <Text style={[st.kcalValue, !totalCalories && st.emptyMetricText]}>
                {kcalValue}
              </Text>
              {totalCalories && <Text style={st.kcalUnit}>kcal</Text>}
            </View>
            {data.profile.calorieTarget ? (
              <Text style={st.targetHint}>目标 {data.profile.calorieTarget} kcal/日</Text>
            ) : null}
          </View>
          <View style={st.coverageBox}>
            <Text style={st.coverageLine}>
              有营养估算 <Text style={st.coverageNum}>{knownCalories.length}</Text> 餐
            </Text>
            <Text style={st.coverageLine}>
              信息不足 <Text style={[st.coverageNum, (unknownMeals > 0 || incompleteMeals > 0) && { color: color.mealText }]}>{Math.max(unknownMeals, incompleteMeals)}</Text> 餐
            </Text>
          </View>
        </View>

        <View style={st.macroGrid}>
          {(
            [
              ["蛋白质 P", totalProtein, "protein"],
              ["碳水 C", totalCarbs, "carbs"],
              ["脂肪 F", totalFat, "fat"],
            ] as const
          ).map(([label, range, key]) => (
            <View key={label} style={st.macroCell}>
              <Text style={st.macroLabel}>{label}</Text>
              <Text style={[st.macroValue, !range && { color: color.inkFaint }]}>
                {range ? nutritionRangeLabel(range, key, " g") : "—"}
              </Text>
            </View>
          ))}
        </View>
      </View>

      {/* 02 / Training & 03 / Sleep Dual Cards */}
      <View style={st.dualRow}>
        <View style={st.halfCard}>
          <View style={st.cardTagRow}>
            <View style={[st.moduleChip, { backgroundColor: color.training }]} />
            <Text style={type.caption}>02 / 今日训练</Text>
          </View>
          <View style={st.halfReadingRow}>
            <Text style={[st.halfValue, !trainings.length && st.emptyMetricText]}>
              {trainings.length ? `${trainings.length}` : "未记录"}
            </Text>
            {trainings.length > 0 && <Text style={st.halfUnit}>个动作</Text>}
          </View>
          <Text style={st.halfNote} numberOfLines={2}>
            {!trainings.length
              ? "今日尚未记录力量或有氧训练"
              : `${workSets ? `${workSets} 个工作组` : ""}${workSets && cardioMins ? " · " : ""}${cardioMins ? `${cardioMins} 分钟有氧` : ""}` || "已完成训练记录"}
          </Text>
        </View>

        <View style={st.halfCard}>
          <View style={st.cardTagRow}>
            <View style={[st.moduleChip, { backgroundColor: color.sleep }]} />
            <Text style={type.caption}>03 / 今日睡眠</Text>
          </View>
          <View style={st.halfReadingRow}>
            <Text style={[st.halfValue, !sleeps.length && st.emptyMetricText]}>
              {sleeps.length ? sleepValue : "未记录"}
            </Text>
            {sleeps.length > 0 && sleepHrs !== null && <Text style={st.halfUnit}>小时</Text>}
          </View>
          {latestSleep ? (
            <View style={st.qualityRow}>
              <Text style={st.halfNote}>质量 {latestSleep.quality}/5 分</Text>
              <View style={st.qualityBars}>
                {[1, 2, 3, 4, 5].map((q) => (
                  <View
                    key={q}
                    style={[
                      st.qualityBar,
                      q <= latestSleep.quality && { backgroundColor: color.sleep },
                    ]}
                  />
                ))}
              </View>
            </View>
          ) : (
            <Text style={st.halfNote}>记录昨晚入睡与醒来时间</Text>
          )}
        </View>
      </View>

      {/* AI Summary Panel */}
      <View style={st.panel}>
        <View style={st.panelTop}>
          <View>
            <Text style={type.caption}>AI SYNTHESIS</Text>
            <Text style={st.panelTitle}>今日健康总结</Text>
          </View>
          <View style={st.statusBadges}>
            <View style={[st.badge, latestAi ? st.badgeAi : st.badgeLocal]}>
              <Text style={[st.badgeText, latestAi && { color: color.onInk }]}>{summarySourceLabel}</Text>
            </View>
            <View style={[st.badge, summaryNeedsUpdate ? st.badgeWarn : st.badgeOk]}>
              <Text style={[st.badgeText, summaryNeedsUpdate ? { color: color.warn } : { color: color.trainingText }]}>
                {summaryStatusLabel}
              </Text>
            </View>
          </View>
        </View>

        <Text style={st.summary}>{preview}</Text>

        <Pressable style={st.link} accessibilityRole="button" onPress={() => setShowLocal(!showLocal)}>
          <Ionicons name={showLocal ? "chevron-up" : "document-text-outline"} size={16} color={color.ink} />
          <Text style={st.linkText}>{showLocal ? "收起摘要" : "查看完整摘要"}</Text>
        </Pressable>
        {showLocal && <MarkdownText value={localSummary} />}

        <SummaryVersions summaries={aiSummaries} />

        <Pressable
          accessibilityRole="button"
          style={({ pressed }) => [st.aiBtn, pressed && base.pressed]}
          onPress={onAi}
        >
          <Ionicons name="sparkles" size={16} color={color.onInk} />
          <Text style={st.aiBtnText}>请求 AI 综合分析</Text>
        </Pressable>
        <Text style={st.aiNote}>本地优先存储 · 发送给 AI 前会单独征求你的同意</Text>
      </View>

      {/* Today's Saved Records List */}
      <View style={st.listHead}>
        <Text style={st.sectionTitle}>今日记录列表</Text>
        <Text style={type.caption}>{recent.length} ENTRIES</Text>
      </View>
      {recent.length ? (
        <View style={st.timeline}>
          {recent.map((r, i) => {
            const tone = moduleTone[r.kind];
            return (
              <Pressable
                accessibilityRole="button"
                key={`${r.kind}-${r.id}`}
                onPress={() => onEdit(r.kind, r.id)}
                style={({ pressed }) => [
                  st.row,
                  i < recent.length - 1 && st.rowBorder,
                  pressed && base.pressed,
                ]}
              >
                <View style={[st.rowBar, { backgroundColor: tone.hue }]} />
                <RecordThumb uri={r.imageUri} kind={r.kind} size={36} />
                <View style={st.rowBody}>
                  <Text style={type.label} numberOfLines={1}>{r.title}</Text>
                  <Text style={st.rowDetail} numberOfLines={1}>{r.detail}</Text>
                </View>
                <Ionicons name="chevron-forward" size={16} color={color.inkFaint} />
              </Pressable>
            );
          })}
        </View>
      ) : (
        <View style={st.empty}>
          <Text style={type.heading}>今天还没有保存记录</Text>
          <Text style={[type.bodySoft, { textAlign: "center" }]}>点击上方「记饮食 / 记训练 / 记睡眠」添加第一条本地记录。</Text>
        </View>
      )}
    </ScrollView>
  );
}

const st = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "flex-start", gap: space.md },
  protocolRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
  streakBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
    backgroundColor: color.sunken,
  },
  streakBadgeText: { fontSize: 11, fontWeight: "700", color: color.inkSoft, fontFamily: mono },
  date: { ...type.display, marginTop: 4 },
  avatar: {
    width: 42,
    height: 42,
    borderRadius: radius.block,
    backgroundColor: color.surface,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: color.lineStrong,
  },
  matrixCard: {
    marginTop: space.lg,
    backgroundColor: color.surface,
    borderRadius: radius.block,
    borderWidth: 1,
    borderColor: color.line,
    padding: space.md,
    gap: space.md,
  },
  matrixHead: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
  },
  matrixSub: { fontSize: 12, color: color.inkSoft, marginTop: 2 },
  nowPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
    backgroundColor: color.sunken,
  },
  nowDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: color.meal },
  nowText: { fontSize: 11, fontWeight: "700", color: color.ink, fontFamily: mono },
  matrixFoot: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    borderTopWidth: 1,
    borderColor: color.line,
    paddingTop: space.sm,
  },
  matrixCountRow: { flexDirection: "row", alignItems: "baseline", gap: 6 },
  matrixCount: { fontSize: 28, lineHeight: 32, fontWeight: "800", color: color.ink, ...type.numeric },
  matrixCountUnit: { fontSize: 13, fontWeight: "700", color: color.inkSoft },
  matrixHint: { fontSize: 12, color: color.inkFaint, fontFamily: mono },

  actions: { flexDirection: "row", gap: space.sm, marginTop: space.md },
  capture: {
    flex: 1.3,
    minHeight: 52,
    borderRadius: radius.block,
    backgroundColor: color.ink,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.sm,
  },
  captureTitle: { fontSize: 15, fontWeight: "800", color: color.onInk },
  sideAction: {
    flex: 1,
    minHeight: 52,
    borderRadius: radius.block,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  sideDot: { width: 6, height: 6, borderRadius: 3 },
  sideText: { fontSize: 14, fontWeight: "700", color: color.ink },

  ledgerCard: {
    marginTop: space.md,
    backgroundColor: color.surface,
    borderRadius: radius.block,
    borderWidth: 1,
    borderColor: color.line,
    padding: space.md,
    gap: space.md,
  },
  cardTopBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  cardTagRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  moduleChip: { width: 8, height: 8, borderRadius: 2 },
  mealCountBadge: {
    fontSize: 12,
    fontWeight: "700",
    color: color.mealText,
    backgroundColor: color.mealTint,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
    fontFamily: mono,
  },
  nutritionMain: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
    gap: space.md,
  },
  metricLabel: { fontSize: 12, color: color.inkSoft },
  kcalRow: { flexDirection: "row", alignItems: "baseline", gap: 6, marginTop: 2 },
  kcalValue: { fontSize: 28, lineHeight: 34, fontWeight: "800", color: color.ink, ...type.numeric },
  emptyMetricText: { fontSize: 20, lineHeight: 26, fontWeight: "700", color: color.inkFaint, fontFamily: sans },
  kcalUnit: { fontSize: 13, fontWeight: "700", color: color.inkSoft, fontFamily: mono },
  targetHint: { fontSize: 11, color: color.inkFaint, marginTop: 2, fontFamily: mono },
  coverageBox: {
    alignItems: "flex-end",
    gap: 2,
    backgroundColor: color.paper,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radius.input,
  },
  coverageLine: { fontSize: 12, color: color.inkSoft },
  coverageNum: { fontWeight: "800", color: color.ink, fontFamily: mono },
  macroGrid: {
    flexDirection: "row",
    gap: space.sm,
    borderTopWidth: 1,
    borderColor: color.line,
    paddingTop: space.sm,
  },
  macroCell: {
    flex: 1,
    backgroundColor: color.paper,
    borderRadius: radius.input,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  macroLabel: { fontSize: 11, fontWeight: "700", color: color.inkSoft },
  macroValue: { fontSize: 14, fontWeight: "800", color: color.ink, marginTop: 2, ...type.numeric },

  dualRow: { flexDirection: "row", gap: space.sm, marginTop: space.sm },
  halfCard: {
    flex: 1,
    minWidth: 0,
    backgroundColor: color.surface,
    borderRadius: radius.block,
    borderWidth: 1,
    borderColor: color.line,
    padding: space.md,
    justifyContent: "space-between",
    gap: space.xs,
  },
  halfReadingRow: { flexDirection: "row", alignItems: "baseline", gap: 4, marginTop: 4 },
  halfValue: { fontSize: 26, lineHeight: 32, fontWeight: "800", color: color.ink, ...type.numeric },
  halfUnit: { fontSize: 12, fontWeight: "700", color: color.inkSoft },
  halfNote: { fontSize: 12, lineHeight: 17, color: color.inkSoft },
  qualityRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 6 },
  qualityBars: { flexDirection: "row", gap: 3 },
  qualityBar: { width: 10, height: 6, borderRadius: 1.5, backgroundColor: color.sunken },

  panel: {
    marginTop: space.lg,
    backgroundColor: color.surface,
    borderRadius: radius.block,
    borderWidth: 1,
    borderColor: color.line,
    padding: space.lg,
  },
  panelTop: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: space.sm,
    marginBottom: space.sm,
  },
  panelTitle: { ...type.title, marginTop: 2 },
  statusBadges: { flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: 6 },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 4 },
  badgeAi: { backgroundColor: color.ink },
  badgeLocal: { backgroundColor: color.sunken },
  badgeWarn: { backgroundColor: color.warnTint },
  badgeOk: { backgroundColor: color.trainingTint },
  badgeText: { fontSize: 11, fontWeight: "700", color: color.inkSoft },
  summary: { ...type.bodySoft, marginTop: space.xs },
  link: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 40, marginTop: 4 },
  linkText: { color: color.ink, fontWeight: "800", fontSize: 13 },
  aiBtn: {
    marginTop: space.md,
    minHeight: 48,
    borderRadius: radius.block,
    backgroundColor: color.ink,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.sm,
  },
  aiBtnText: { color: color.onInk, fontSize: 14, fontWeight: "800" },
  aiNote: { ...type.small, color: color.inkFaint, textAlign: "center", marginTop: space.sm },

  listHead: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    marginTop: space.xl,
    marginBottom: space.sm,
  },
  sectionTitle: { ...type.title },
  timeline: {
    backgroundColor: color.surface,
    borderRadius: radius.block,
    borderWidth: 1,
    borderColor: color.line,
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    minHeight: 62,
    paddingRight: space.md,
  },
  rowBorder: {
    borderBottomWidth: 1,
    borderColor: color.line,
  },
  rowBar: { width: 4, alignSelf: "stretch" },
  rowIcon: {
    width: 36,
    height: 36,
    borderRadius: radius.input,
    alignItems: "center",
    justifyContent: "center",
  },
  rowBody: { flex: 1, paddingVertical: 10 },
  rowDetail: { fontSize: 12, color: color.inkSoft, marginTop: 2, ...type.numeric },
  empty: {
    alignItems: "center",
    gap: 4,
    paddingVertical: space.xl,
    paddingHorizontal: space.lg,
    backgroundColor: color.surface,
    borderRadius: radius.block,
    borderWidth: 1,
    borderColor: color.line,
  },
});
