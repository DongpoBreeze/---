import React, { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { AppData } from "../types";
import { mealCalories, summaryMarkdown } from "../domain";
import { MarkdownText, SummaryVersions, s as base } from "./components";
import { dateLabel, rangeLabel, recordDate, sleepHours, timeLabel, today } from "./format";
import { color, moduleTone, radius, space, type } from "./theme";
import type { Kind } from "./app-types";

/** One data card: module color, primary reading, secondary text. */
function DataCard({ kind, label, value, unit, sublabel, empty }: { kind: Kind; label: string; value: string; unit?: string; sublabel: string; empty?: boolean }) {
  const tone = moduleTone[kind];
  const unknown = empty || value === "未知" || value === "—";
  return (
    <View style={[st.card, { backgroundColor: unknown ? color.surface : tone.tint, borderColor: unknown ? color.line : tone.hue }]}>
      <View style={st.cardHead}>
        <Ionicons name={tone.icon} size={20} color={unknown ? color.inkFaint : tone.hue} />
        <Text style={[st.cardLabel, { color: unknown ? color.inkFaint : tone.text }]}>{label}</Text>
      </View>
      <Text style={[st.cardValue, { color: unknown ? color.inkFaint : tone.text }]} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
      {unit && !unknown && <Text style={[st.cardUnit, { color: tone.text }]}>{unit}</Text>}
      <Text style={[st.cardSub, { color: unknown ? color.inkFaint : color.inkSoft }]} numberOfLines={1}>{sublabel}</Text>
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
  const nowDate = new Date();
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
    .slice(0, 8);
  const preview = summary
    .split("\n")
    .filter((line) => line.trim() && !line.startsWith("#") && !line.startsWith("-"))
    .join(" ")
    .slice(0, 200);
  const kcalValue = known.length ? rangeLabel(total) : "未知";
  const mealSub = !meals.length ? "暂无饮食" : known.length === meals.length ? `${meals.length} 餐均已估算` : `${meals.length - known.length} 餐未估算`;
  const workSets = trainings.reduce((n, r) => n + r.sets.filter((x) => !x.isWarmup).length, 0);
  const trainingSub = !trainings.length ? "暂无训练" : `${trainings.length} 次 · ${workSets} 个工作组`;
  const sleepSub = !sleeps.length ? "暂无睡眠" : "非设备测量";
  return (
    <ScrollView contentContainerStyle={contentStyle} showsVerticalScrollIndicator={false}>
      <View style={st.head}>
        <View style={{ flex: 1 }}>
          <Text style={st.weekday}>{nowDate.toLocaleDateString("zh-CN", { weekday: "long" })}</Text>
          <Text style={st.date}>{nowDate.toLocaleDateString("zh-CN", { month: "long", day: "numeric" })}</Text>
        </View>
        <Pressable
          accessibilityRole="button"
          onPress={onProfile}
          style={st.avatar}
          accessibilityLabel="打开我的资料"
        >
          <Ionicons name="person-outline" size={22} color={color.ink} />
        </Pressable>
      </View>
      <Text style={st.intro}>已有 {days} 个日期留下记录</Text>
      <View style={st.cards}>
        <DataCard kind="meal" label="已估算摄入" value={kcalValue} unit="kcal" sublabel={mealSub} empty={!meals.length} />
        <DataCard kind="training" label="训练" value={trainings.length ? `${trainings.length}` : "—"} unit="次" sublabel={trainingSub} empty={!trainings.length} />
        <DataCard kind="sleep" label="估算睡眠" value={sleepValue} unit="小时" sublabel={sleepSub} empty={!sleeps.length} />
      </View>
      <View style={st.actions}>
        <Pressable
          accessibilityRole="button"
          onPress={() => onOpen("meal")}
          style={({ pressed }) => [st.primary, pressed && base.pressed]}
        >
          <Ionicons name="camera" size={24} color={color.onInk} />
          <Text style={st.primaryText}>记饮食</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={() => onOpen("training")}
          style={({ pressed }) => [st.secondary, { borderColor: moduleTone.training.hue }, pressed && base.pressed]}
        >
          <Ionicons name="barbell-outline" size={22} color={moduleTone.training.hue} />
          <Text style={[st.secondaryText, { color: moduleTone.training.text }]}>记训练</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={() => onOpen("sleep")}
          style={({ pressed }) => [st.secondary, { borderColor: moduleTone.sleep.hue }, pressed && base.pressed]}
        >
          <Ionicons name="moon-outline" size={22} color={moduleTone.sleep.hue} />
          <Text style={[st.secondaryText, { color: moduleTone.sleep.text }]}>记睡眠</Text>
        </Pressable>
      </View>
      <Text style={st.hint}>拍照或直接写下吃了什么</Text>
      <View style={st.panel}>
        <View style={st.panelHead}>
          <Text style={st.panelTitle}>今日摘要</Text>
          <Text style={st.panelMeta}>根据已保存记录</Text>
        </View>
        <Text style={st.summary}>{preview}</Text>
        <Pressable style={st.link} accessibilityRole="button" onPress={() => setShowLocal(!showLocal)}>
          <Ionicons name={showLocal ? "chevron-up" : "document-text-outline"} size={18} color={color.accent} />
          <Text style={st.linkText}>{showLocal ? "收起摘要" : "查看完整摘要"}</Text>
        </Pressable>
        {showLocal && <MarkdownText value={summary} />}
        <SummaryVersions summaries={data.summaries.filter((r) => r.date === date && r.source === "ai")} />
        <Pressable
          accessibilityRole="button"
          style={({ pressed }) => [st.ai, pressed && base.pressed]}
          onPress={onAi}
        >
          <Ionicons name="sparkles" size={19} color={color.accent} />
          <Text style={st.aiText}>请求 AI 综合分析</Text>
        </Pressable>
        <Text style={st.aiNote}>发送前会询问，记录只在你同意后离开本机。</Text>
      </View>
      <Text style={st.sectionTitle}>今日记录</Text>
      {recent.length ? (
        <View style={st.list}>
          {recent.map((r) => (
            <Pressable
              accessibilityRole="button"
              key={`${r.kind}-${r.id}`}
              onPress={() => onEdit(r.kind, r.id)}
              style={({ pressed }) => [st.row, pressed && base.pressed]}
            >
              <View style={[st.rowDot, { backgroundColor: moduleTone[r.kind].hue }]} />
              <View style={st.rowBody}>
                <Text style={st.rowTitle} numberOfLines={1}>{r.title}</Text>
                <Text style={st.rowDetail} numberOfLines={1}>{r.detail}</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={color.inkFaint} style={{ alignSelf: "center" }} />
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
  weekday: { ...type.small, color: color.accent, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.6 },
  date: { ...type.display, marginTop: 2 },
  avatar: {
    width: 48, height: 48, borderRadius: 24, backgroundColor: color.surface,
    alignItems: "center", justifyContent: "center", borderWidth: 2, borderColor: color.line,
  },
  intro: { ...type.small, color: color.inkFaint, marginTop: space.sm },
  cards: { flexDirection: "row", gap: space.sm, marginTop: space.lg },
  card: {
    flex: 1, minWidth: 0, borderRadius: radius.block, padding: space.md,
    borderWidth: 1.5,
  },
  cardHead: { flexDirection: "row", alignItems: "center", gap: 6 },
  cardLabel: { ...type.small, fontWeight: "700", flex: 1 },
  cardValue: { fontSize: 28, lineHeight: 32, fontWeight: "800", marginTop: space.xs, ...type.numeric },
  cardUnit: { fontSize: 13, fontWeight: "700", marginTop: -4 },
  cardSub: { fontSize: 11, lineHeight: 15, marginTop: 2 },
  actions: { flexDirection: "row", gap: space.sm, marginTop: space.xl },
  primary: {
    flex: 1.5, minHeight: 60, borderRadius: radius.pill, backgroundColor: color.meal,
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.sm,
  },
  primaryText: { fontSize: 18, fontWeight: "800", color: color.onInk },
  secondary: {
    flex: 1, minHeight: 60, borderRadius: radius.pill, borderWidth: 2, backgroundColor: color.paper,
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
  },
  secondaryText: { fontSize: 15, fontWeight: "700" },
  hint: { ...type.small, color: color.inkFaint, textAlign: "center", marginTop: space.sm },
  panel: { marginTop: space.xl, backgroundColor: color.raised, borderRadius: radius.block, padding: space.lg },
  panelHead: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", marginBottom: space.sm },
  panelTitle: { ...type.title },
  panelMeta: { ...type.small, color: color.inkFaint },
  summary: { ...type.body, color: color.inkSoft },
  link: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 44 },
  linkText: { color: color.accent, fontWeight: "700", fontSize: 15 },
  ai: {
    marginTop: space.md, minHeight: 54, borderRadius: radius.pill, backgroundColor: color.accentTint,
    borderWidth: 2, borderColor: color.accent,
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.sm,
  },
  aiText: { color: color.accent, fontSize: 16, fontWeight: "800" },
  aiNote: { ...type.small, color: color.inkFaint, textAlign: "center", marginTop: space.sm },
  sectionTitle: { ...type.title, marginTop: space.xxl, marginBottom: space.md },
  list: { backgroundColor: color.surface, borderRadius: radius.block, paddingHorizontal: space.md, paddingVertical: space.xs },
  row: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: 62, borderBottomWidth: 1, borderBottomColor: color.line },
  rowDot: { width: 10, height: 10, borderRadius: 5 },
  rowBody: { flex: 1, justifyContent: "center" },
  rowTitle: { ...type.label, fontSize: 15 },
  rowDetail: { ...type.small, marginTop: 2 },
  empty: { alignItems: "center", gap: 6, paddingVertical: space.xxl, backgroundColor: color.surface, borderRadius: radius.block, paddingHorizontal: space.lg },
});
