import React, { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { AppData } from "../types";
import { mealCalories, summaryMarkdown } from "../domain";
import { MarkdownText, SummaryVersions, s as base } from "./components";
import { Tape, type TapeMark as Mark } from "./tape";
import { dateLabel, minutesInto, rangeLabel, recordDate, sleepHours, timeLabel, today } from "./format";
import { color, moduleTone, radius, space, type } from "./theme";
import type { Kind } from "./app-types";

/** One lit instrument: module hue, reading and a one-line note. */
function Gauge({ kind, label, value, unit, note }: { kind: Kind; label: string; value: string; unit?: string; note: string }) {
  const tone = moduleTone[kind];
  const unknown = value === "未知" || value === "—";
  return (
    <View style={st.gauge}>
      <View style={[st.gaugeLamp, { backgroundColor: unknown ? color.lineStrong : tone.hue }]} />
      <Text style={st.gaugeLabel} numberOfLines={1}>{label}</Text>
      <View style={st.gaugeReading}>
        <Text style={[st.gaugeValue, { color: unknown ? color.inkFaint : tone.text }]} numberOfLines={1} adjustsFontSizeToFit>
          {value}
        </Text>
        {!unknown && unit ? <Text style={[st.gaugeUnit, { color: tone.text }]}>{unit}</Text> : null}
      </View>
      <Text style={st.gaugeNote} numberOfLines={2}>{note}</Text>
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
  const [showLocal, setShowLocal] = useState(false);
  const date = today();
  const meals = data.meals.filter((r) => recordDate(r) === date);
  const trainings = data.trainings.filter((r) => recordDate(r) === date);
  const sleeps = data.sleeps.filter((r) => recordDate(r) === date);
  const known = meals
    .map(mealCalories)
    .filter((v): v is { min: number; max: number } => v !== null);
  const total = known.reduce(
    (sum, v) => ({ min: sum.min + v.min, max: sum.max + v.max }),
    { min: 0, max: 0 },
  );
  const days = new Set([
    ...data.meals.map(recordDate),
    ...data.trainings.map(recordDate),
    ...data.sleeps.map(recordDate),
  ]).size;
  const summary =
    data.summaries.find((r) => r.date === date && r.source !== "ai")
      ?.markdown ?? summaryMarkdown(data, date);
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
  const sleepValue = sleeps.length && sleepHours(sleeps[0]) !== null ? sleepHours(sleeps[0])!.toFixed(1) : "未知";
  const recent = [
    ...meals.map((r) => ({
      kind: "meal" as Kind,
      id: r.id,
      title: r.foodName,
      detail: `${r.mealType} · ${timeLabel(r.occurredAt)}`,
      at: r.occurredAt,
    })),
    ...trainings.map((r) => ({
      kind: "training" as Kind,
      id: r.id,
      title: r.exercise,
      detail: `${r.mode === "cardio" ? `${r.durationMinutes ?? 0} 分钟` : `${r.sets.filter((x) => !x.isWarmup).length} 工作组`} · ${timeLabel(r.occurredAt)}`,
      at: r.occurredAt,
    })),
    ...sleeps.map((r) => ({
      kind: "sleep" as Kind,
      id: r.id,
      title: "睡眠记录",
      detail: `${sleepHours(r) === null ? "时长未知" : `${sleepHours(r)!.toFixed(1)} 小时估算睡眠`} · ${dateLabel(r.wokeAt)}`,
      at: r.wokeAt,
    })),
  ]
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, 5);
  const preview = summary
    .split("\n")
    .filter((line) => line.trim() && !line.startsWith("#") && !line.startsWith("-"))
    .join(" ")
    .slice(0, 180);
  const kcalValue = known.length ? rangeLabel(total) : "未知";
  const incompleteMeals = meals.filter((meal) => {
    const latest = meal.analyses?.at(-1);
    return latest?.sourceVersion === (meal.revision ?? 1)
      && ["user-quantity-v2", "ai-per100g-v3"].includes(latest.analysis.nutritionSource?.method ?? "")
      && latest.analysis.nutritionSource?.coverage === "incomplete";
  }).length;
  const mealNote = !meals.length ? "暂无饮食" : incompleteMeals ? `${incompleteMeals} 餐数据不完整`
    : known.length === meals.length ? `${meals.length} 餐有摄入估算` : `${meals.length - known.length} 餐摄入未知`;
  const workSets = trainings.reduce((n, r) => n + r.sets.filter((x) => !x.isWarmup).length, 0);
  return (
    <ScrollView contentContainerStyle={contentStyle} showsVerticalScrollIndicator={false}>
      <View style={st.head}>
        <View style={{ flex: 1 }}>
          <View style={st.brandRow}>
            <Ionicons name="compass" size={13} color={color.accent} />
            <Text style={st.brand}>健康罗盘</Text>
          </View>
          <Text style={st.date}>{nowDate.toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long" })}</Text>
        </View>
        <Pressable
          accessibilityRole="button"
          onPress={onProfile}
          style={st.avatar}
          accessibilityLabel="打开我的资料"
        >
          <Ionicons name="person-outline" size={19} color={color.ink} />
        </Pressable>
      </View>
      <View
        style={st.chart}
        accessible
        accessibilityLabel={`今日航迹：已记下 ${count} 条，饮食 ${meals.length} 餐，训练 ${trainings.length} 次，睡眠 ${sleeps.length} 段`}
      >
        <View style={st.chartHead}>
          <Text style={type.caption}>24H 航迹</Text>
          <View style={st.nowBadge}>
            <View style={st.nowDot} />
            <Text style={st.chartNow}>{timeLabel(nowDate.toISOString())}</Text>
          </View>
        </View>
        <Tape marks={marks} now={now} />
        <View style={st.chartFoot}>
          <Text style={st.dialCount}>{count}</Text>
          <Text style={st.dialLabel}>{count ? "条今天已记下" : days ? "今天还没有记录" : "从第一条记录开始"}</Text>
        </View>
      </View>
      <View style={st.gauges}>
        <Gauge kind="meal" label="已估算摄入" value={kcalValue} unit="kcal" note={mealNote} />
        <Gauge kind="training" label="训练" value={trainings.length ? `${trainings.length}` : "—"} unit="次" note={trainings.length ? `${workSets} 个工作组` : "暂无训练"} />
        <Gauge kind="sleep" label="估算睡眠" value={sleepValue} unit="小时" note={sleeps.length ? "非设备测量" : "暂无睡眠"} />
      </View>
      <View style={st.actions}>
        <Pressable
          accessibilityRole="button"
          onPress={() => onOpen("meal")}
          style={({ pressed }) => [st.capture, pressed && base.pressed]}
        >
          <Ionicons name="camera" size={22} color={color.onInk} />
          <Text style={st.captureTitle}>记饮食</Text>
        </Pressable>
        {(["training", "sleep"] as const).map((kind) => (
          <Pressable
            key={kind}
            accessibilityRole="button"
            onPress={() => onOpen(kind)}
            style={({ pressed }) => [st.side, { backgroundColor: moduleTone[kind].tint, borderColor: moduleTone[kind].line }, pressed && base.pressed]}
          >
            <Ionicons name={moduleTone[kind].icon} size={20} color={moduleTone[kind].text} />
            <Text style={[st.sideText, { color: moduleTone[kind].text }]}>{kind === "training" ? "记训练" : "记睡眠"}</Text>
          </Pressable>
        ))}
      </View>
      <Text style={st.days}>拍照或直接写下吃了什么 · 已有 {days} 个日期留下记录</Text>
      <View style={st.panel}>
        <View style={st.panelHead}>
          <Text style={st.panelTitle}>今日摘要</Text>
          <Text style={st.panelMeta}>根据已保存记录</Text>
        </View>
        <Text style={st.summary}>{preview}</Text>
        <Pressable style={st.link} accessibilityRole="button" onPress={() => setShowLocal(!showLocal)}>
          <Ionicons name={showLocal ? "chevron-up" : "document-text-outline"} size={16} color={color.pine} />
          <Text style={st.linkText}>{showLocal ? "收起摘要" : "���看完整摘要"}</Text>
        </Pressable>
        {showLocal && <MarkdownText value={summary} />}
        <SummaryVersions summaries={data.summaries.filter((r) => r.date === date && r.source === "ai")} />
        <Pressable
          accessibilityRole="button"
          style={({ pressed }) => [st.ai, pressed && base.pressed]}
          onPress={onAi}
        >
          <Ionicons name="sparkles" size={17} color={color.pine} />
          <Text style={st.aiText}>请求 AI 综合分析</Text>
        </Pressable>
        <Text style={st.aiNote}>发送前会询问，记录只在你同意后离开本机。</Text>
      </View>
      <Text style={st.sectionTitle}>今日记录</Text>
      {recent.length ? (
        <View style={st.timeline}>
          {recent.map((r, i) => (
            <Pressable
              accessibilityRole="button"
              key={`${r.kind}-${r.id}`}
              onPress={() => onEdit(r.kind, r.id)}
              style={({ pressed }) => [st.row, pressed && base.pressed]}
            >
              <View style={st.rail}>
                <View style={[st.railDot, { backgroundColor: moduleTone[r.kind].hue }]} />
                {i < recent.length - 1 && <View style={st.railLine} />}
              </View>
              <View style={st.rowBody}>
                <Text style={type.label}>{r.title}</Text>
                <Text style={type.small}>{r.detail}</Text>
              </View>
              <Ionicons name="chevron-forward" size={17} color={color.inkFaint} style={{ alignSelf: "center" }} />
            </Pressable>
          ))}
        </View>
      ) : (
        <View style={st.empty}>
          <Text style={type.heading}>暂无记录</Text>
          <Text style={[type.bodySoft, { textAlign: "center" }]}>选择上面的入口，保存第一条本地记录。</Text>
        </View>
      )}
    </ScrollView>
  );
}

const st = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "flex-start", gap: space.md },
  weekday: { ...type.caption, color: color.inkSoft },
  date: { ...type.display, marginTop: 2 },
  avatar: {
    width: 44, height: 44, borderRadius: 22, backgroundColor: color.surface,
    alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: color.lineStrong,
  },
  chart: {
    marginTop: space.lg, backgroundColor: color.surface, borderRadius: radius.block,
    borderWidth: 1, borderColor: color.line, padding: space.md, gap: space.md,
  },
  chartHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  chartNow: { ...type.caption, color: color.ink },
  chartFoot: {
    flexDirection: "row", alignItems: "baseline", gap: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth, borderColor: color.lineStrong, paddingTop: space.sm,
  },
  dialCount: { fontSize: 34, lineHeight: 38, fontWeight: "700", color: color.ink, ...type.numeric },
  dialLabel: { ...type.small, color: color.inkSoft },
  gauges: { flexDirection: "row", gap: space.sm, marginTop: space.md },
  gauge: {
    flex: 1, minWidth: 0, backgroundColor: color.surface, borderRadius: radius.block, padding: space.md,
    borderWidth: 1, borderColor: color.line, borderTopWidth: 3,
  },
  gaugeHead: { flexDirection: "row", alignItems: "center", gap: 6 },
  gaugeDot: { width: 6, height: 6, borderRadius: 3 },
  gaugeLabel: { ...type.small, flex: 1 },
  gaugeValue: { fontSize: 24, lineHeight: 30, fontWeight: "800", marginTop: space.sm, ...type.numeric },
  gaugeNote: { fontSize: 11, lineHeight: 15, color: color.inkFaint, marginTop: 2 },
  actions: { flexDirection: "row", gap: space.sm, marginTop: space.lg },
  capture: {
    flex: 1.4, minHeight: 56, borderRadius: radius.pill, backgroundColor: color.meal,
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.sm,
  },
  captureTitle: { fontSize: 17, fontWeight: "800", color: color.onInk },
  side: {
    flex: 1, minHeight: 56, borderRadius: radius.pill, borderWidth: 1.5, backgroundColor: color.surface,
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
  },
  sideText: { fontSize: 14, fontWeight: "800" },
  days: { ...type.small, color: color.inkFaint, textAlign: "center", marginTop: space.sm },
  panel: { marginTop: space.xl, backgroundColor: color.surface, borderRadius: radius.block, padding: space.lg },
  panelHead: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", marginBottom: space.sm },
  panelTitle: { ...type.title },
  panelMeta: { ...type.small, color: color.inkFaint },
  summary: { ...type.body, color: color.inkSoft },
  link: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 44 },
  linkText: { color: color.pine, fontWeight: "800", fontSize: 14 },
  ai: {
    marginTop: space.md, minHeight: 50, borderRadius: radius.pill, backgroundColor: color.pineTint,
    borderWidth: 1, borderColor: color.pine,
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.sm,
  },
  aiText: { color: color.pine, fontSize: 15, fontWeight: "800" },
  aiNote: { ...type.small, color: color.inkFaint, textAlign: "center", marginTop: space.sm },
  sectionTitle: { ...type.title, marginTop: space.xxl, marginBottom: space.md },
  timeline: { backgroundColor: color.surface, borderRadius: radius.block, paddingHorizontal: space.md, paddingVertical: space.xs },
  row: { flexDirection: "row", alignItems: "stretch", gap: space.md, minHeight: 64 },
  rail: { width: 14, alignItems: "center", paddingTop: 22 },
  railDot: { width: 10, height: 10, borderRadius: 5 },
  railLine: { flex: 1, width: 2, backgroundColor: color.lineStrong, marginTop: 4 },
  rowBody: { flex: 1, justifyContent: "center", paddingVertical: space.md },
  empty: { alignItems: "center", gap: 4, paddingVertical: space.xl, backgroundColor: color.surface, borderRadius: radius.block },
});
