import React, { useState } from "react";
import { Image, Pressable, ScrollView, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { AppData } from "../types";
import { mealCalories } from "../domain";
import { SummaryVersions, useBaseStyles } from "./components";
import { rangeLabel, recordDate, sleepHours, timeLabel } from "./format";
import { radius, space, type ThemeTokens } from "./theme";
import { useTheme, useThemedStyles } from "./theme-provider";
import type { Kind } from "./app-types";

type Entry = { kind: Kind; id: string; title: string; detail: string; at: string; date: string; imageUri?: string };
type Filter = "all" | Kind;

function dayHeading(date: string) {
  const d = new Date(`${date}T00:00:00`);
  if (!Number.isFinite(d.getTime())) return date;
  const label = d.toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "short" });
  const todayKey = new Date();
  todayKey.setHours(0, 0, 0, 0);
  const diff = Math.round((todayKey.getTime() - d.getTime()) / 86400000);
  return diff === 0 ? `今天 · ${label}` : diff === 1 ? `昨天 · ${label}` : label;
}

export function Records({
  data,
  contentStyle,
  onEdit,
  onDelete,
  onAi,
}: {
  data: AppData;
  contentStyle: StyleProp<ViewStyle>;
  onEdit: (kind: Kind, id: string) => void;
  onDelete: (kind: Kind, id: string) => void;
  onAi: (id: string) => void;
}) {
  const { color, type, moduleTone } = useTheme();
  const base = useBaseStyles();
  const st = useThemedStyles(createStyles);
  const [filter, setFilter] = useState<Filter>("all");
  const entries: Entry[] = [
    ...data.meals.map((r) => ({
      kind: "meal" as Kind, id: r.id, title: r.foodName, at: r.occurredAt, date: recordDate(r), imageUri: r.imageUri,
      detail: `${r.mealType} · ${timeLabel(r.occurredAt)} · ${mealCalories(r) ? `约 ${rangeLabel(mealCalories(r), " kcal")}` : "摄入未知"}`,
    })),
    ...data.trainings.map((r) => ({
      kind: "training" as Kind, id: r.id, title: r.exercise, at: r.occurredAt, date: recordDate(r),
      detail: `${timeLabel(r.occurredAt)} · ${r.mode === "cardio" ? r.durationMinutes === undefined ? "时长未知" : `${r.durationMinutes} 分钟` : `${r.sets.filter((x) => !x.isWarmup).length} 工作组`}`,
    })),
    ...data.sleeps.map((r) => ({
      kind: "sleep" as Kind, id: r.id, at: r.wokeAt, date: recordDate(r),
      title: sleepHours(r) === null ? "时长未知" : `${sleepHours(r)!.toFixed(1)} 小时估算睡眠`,
      detail: `质量 ${r.quality === undefined ? "未填写" : `${r.quality}/5`} · ${r.awakeMinutes === null ? "清醒未知" : `清醒 ${r.awakeMinutes} 分钟`}`,
    })),
  ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const counts = { all: entries.length, meal: data.meals.length, training: data.trainings.length, sleep: data.sleeps.length };
  const visible = entries.filter((e) => filter === "all" || e.kind === filter);
  const groups: Array<[string, Entry[]]> = [];
  visible.forEach((e) => {
    const last = groups.at(-1);
    if (last && last[0] === e.date) last[1].push(e);
    else groups.push([e.date, [e]]);
  });
  const filters: Array<[Filter, string]> = [["all", "全部"], ["meal", "饮食"], ["training", "训练"], ["sleep", "睡眠"]];
  return (
    <ScrollView contentContainerStyle={[contentStyle, st.screen]} showsVerticalScrollIndicator={false}>
      <View>
        <View style={st.capRow}>
          <Text style={st.cap}>ARCHIVE · 全部记录</Text>
          <Text style={st.pill}>{counts.all} 条</Text>
        </View>
        <Text style={st.title}>记录</Text>
        <Text style={st.intro}>每条记录都可以打开、修改或删除。估算和 AI 结果与原始输入分开保存。</Text>
      </View>
      <View style={st.filters} accessibilityRole="tablist">
        {filters.map(([key, label]) => {
          const on = filter === key;
          return (
            <Pressable
              key={key}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              accessibilityLabel={`筛选${label}`}
              onPress={() => setFilter(key)}
              style={({ pressed }) => [st.filter, on && st.filterOn, pressed && base.pressed]}
            >
              {key !== "all" && <View style={[st.filterDot, { backgroundColor: moduleTone[key].hue }]} />}
              <Text style={[st.filterText, on && st.filterTextOn]}>{label}</Text>
              <Text style={[st.filterCount, on && st.filterTextOn]}>{counts[key]}</Text>
            </Pressable>
          );
        })}
      </View>
      {groups.length ? groups.map(([date, items]) => (
        <View key={date} style={st.card}>
          <View style={st.groupHead}>
            <Text style={st.groupTitle}>{dayHeading(date)}</Text>
            <Text style={st.groupCount}>{items.length} 条</Text>
          </View>
          {items.map((r, index) => {
            const tone = moduleTone[r.kind];
            return (
              <View key={`${r.kind}-${r.id}`} style={[st.row, index > 0 && st.rowLine]}>
                <Pressable
                  accessibilityRole="button"
                  style={({ pressed }) => [st.rowMain, pressed && base.pressed]}
                  onPress={() => onEdit(r.kind, r.id)}
                >
                  {r.imageUri ? (
                    <Image source={{ uri: r.imageUri }} style={st.thumb} />
                  ) : (
                    <View style={[st.icon, { backgroundColor: tone.tint }]}>
                      <Ionicons name={tone.icon} size={17} color={tone.text} />
                    </View>
                  )}
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <View style={st.rowTitleLine}>
                      <View style={[st.swatch, { backgroundColor: tone.hue }]} />
                      <Text style={st.rowTitle} numberOfLines={1}>{r.title}</Text>
                    </View>
                    <Text style={st.rowDetail} numberOfLines={1}>{r.detail}</Text>
                  </View>
                </Pressable>
                {r.kind === "meal" && (
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => onAi(r.id)}
                    style={({ pressed }) => [st.action, pressed && base.pressed]}
                    accessibilityLabel="请求饮食分析"
                  >
                    <Ionicons name="sparkles-outline" size={17} color={color.inkSoft} />
                  </Pressable>
                )}
                <Pressable
                  accessibilityRole="button"
                  onPress={() => onDelete(r.kind, r.id)}
                  style={({ pressed }) => [st.action, pressed && base.pressed]}
                  accessibilityLabel="删除记录"
                >
                  <Ionicons name="trash-outline" size={17} color={color.inkFaint} />
                </Pressable>
              </View>
            );
          })}
        </View>
      )) : (
        <View style={[st.card, st.empty]}>
          <Text style={st.emptyGlyph}>✦</Text>
          <Text style={type.heading}>暂无记录</Text>
          <Text style={[type.bodySoft, { textAlign: "center" }]}>
            {filter === "all" ? "在“今天”页记下第一餐、一次训练或一晚睡眠。" : `还没有${moduleTone[filter].name}记录。`}
          </Text>
        </View>
      )}
      <View style={st.card}>
        <Text style={st.cap}>AI SYNTHESIS · 历史摘要</Text>
        <Text style={st.sectionTitle}>每日摘要</Text>
        <SummaryVersions summaries={data.summaries} />
      </View>
    </ScrollView>
  );
}

const createStyles = ({ color, type, shadow }: ThemeTokens) => StyleSheet.create({
  screen: { gap: 12 },
  capRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  cap: { ...type.cap },
  pill: { fontSize: 10, lineHeight: 14, fontWeight: "700", color: color.inkSoft, backgroundColor: color.sunken, paddingVertical: 2, paddingHorizontal: 8, borderRadius: 999, overflow: "hidden" },
  title: { ...type.display, marginTop: 4 },
  intro: { fontSize: 12.5, lineHeight: 19, color: color.inkSoft, marginTop: space.xs },
  filters: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  filter: {
    flexDirection: "row", alignItems: "center", gap: 5, minHeight: 34, paddingHorizontal: 12,
    borderRadius: radius.pill, backgroundColor: color.sunken,
  },
  filterOn: { backgroundColor: color.ink },
  filterDot: { width: 7, height: 7, borderRadius: 2 },
  filterText: { fontSize: 12.5, fontWeight: "700", color: color.inkSoft },
  filterTextOn: { color: color.paper },
  filterCount: { fontSize: 11, color: color.inkFaint, ...type.mono },
  card: { backgroundColor: color.surface, borderRadius: 16, padding: 16, borderWidth: 1, borderColor: color.line, ...shadow.card },
  groupHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 },
  groupTitle: { fontSize: 13, lineHeight: 18, fontWeight: "800", color: color.ink },
  groupCount: { fontSize: 10.5, color: color.inkFaint, ...type.mono },
  row: { flexDirection: "row", alignItems: "center", marginHorizontal: -6 },
  rowLine: { borderTopWidth: 1, borderTopColor: color.line },
  rowMain: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: space.md, minHeight: 60, paddingHorizontal: 6 },
  rowTitleLine: { flexDirection: "row", alignItems: "center", gap: 6 },
  swatch: { width: 7, height: 7, borderRadius: 2 },
  rowTitle: { flex: 1, minWidth: 0, fontSize: 13.5, lineHeight: 19, fontWeight: "700", color: color.ink },
  rowDetail: { fontSize: 11, lineHeight: 16, color: color.inkSoft, marginTop: 2, ...type.mono },
  thumb: { width: 40, height: 40, borderRadius: 10, backgroundColor: color.sunken },
  icon: { width: 40, height: 40, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  action: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  empty: { alignItems: "center", gap: 4, paddingVertical: space.xl },
  emptyGlyph: { fontSize: 16, color: color.meal, marginBottom: 4 },
  sectionTitle: { ...type.heading, marginTop: 6, marginBottom: 4 },
});
