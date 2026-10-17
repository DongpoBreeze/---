import React, { useState } from "react";
import { Image, Pressable, ScrollView, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { AppData } from "../types";
import { mealCalories } from "../domain";
import { RecordThumb, SummaryVersions, s as base } from "./components";
import { rangeLabel, recordDate, sleepHours, timeLabel } from "./format";
import { color, moduleTone, radius, space, type } from "./theme";
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
  const [filter, setFilter] = useState<Filter>("all");
  const entries: Entry[] = [
    ...data.meals.map((r) => ({
      kind: "meal" as Kind, id: r.id, title: r.foodName, at: r.occurredAt, date: recordDate(r), imageUri: r.imageUri,
      detail: `${r.mealType} · ${timeLabel(r.occurredAt)} · ${mealCalories(r) ? `约 ${rangeLabel(mealCalories(r), " kcal")}` : "摄入未知"}`,
    })),
    ...data.trainings.map((r) => ({
      kind: "training" as Kind, id: r.id, title: r.exercise, at: r.occurredAt, date: recordDate(r),
      detail: `${timeLabel(r.occurredAt)} · ${r.mode === "cardio" ? `${r.durationMinutes ?? 0} 分钟` : `${r.sets.filter((x) => !x.isWarmup).length} 工作组`}`,
    })),
    ...data.sleeps.map((r) => ({
      kind: "sleep" as Kind, id: r.id, at: r.wokeAt, date: recordDate(r),
      title: sleepHours(r) === null ? "时长未知" : `${sleepHours(r)!.toFixed(1)} 小时估算睡眠`,
      detail: `质量 ${r.quality}/5 · ${r.awakeMinutes === null ? "清醒未知" : `清醒 ${r.awakeMinutes} 分钟`}`,
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
    <ScrollView contentContainerStyle={contentStyle} showsVerticalScrollIndicator={false}>
      <Text style={type.caption}>ARCHIVE LEDGER</Text>
      <Text style={st.title}>记录</Text>
      <Text style={st.intro}>每条记录都可以打开、修改或删除。估算和 AI 结果与原始输入分开保存。</Text>
      <View style={st.filters} accessibilityRole="tablist">
        {filters.map(([key, label]) => {
          const on = filter === key;
          const hue = key === "all" ? color.pine : moduleTone[key].hue;
          const activeBg = key === "all" ? color.sunken : moduleTone[key].tint;
          return (
            <Pressable
              key={key}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              accessibilityLabel={`筛选${label}`}
              onPress={() => setFilter(key)}
              style={[st.filter, on && { backgroundColor: activeBg, borderColor: hue, borderWidth: 1.5 }]}
            >
              {key !== "all" && <View style={[st.filterDot, { backgroundColor: hue }]} />}
              <Text style={[st.filterText, on && { color: color.ink }]}>{label}</Text>
              <Text style={[st.filterCount, on && { color: color.inkSoft }]}>{counts[key]}</Text>
            </Pressable>
          );
        })}
      </View>
      {groups.length ? groups.map(([date, items]) => (
        <View key={date} style={st.group}>
          <Text style={st.groupTitle}>{dayHeading(date)}</Text>
          {items.map((r) => {
            const tone = moduleTone[r.kind];
            return (
              <View key={`${r.kind}-${r.id}`} style={st.row}>
                <Pressable
                  accessibilityRole="button"
                  style={({ pressed }) => [st.rowMain, pressed && base.pressed]}
                  onPress={() => onEdit(r.kind, r.id)}
                >
                  <View style={[st.spine, { backgroundColor: tone.hue }]} />
                  <RecordThumb uri={r.imageUri} kind={r.kind} size={38} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={type.label} numberOfLines={1}>{r.title}</Text>
                    <Text style={type.small} numberOfLines={1}>{r.detail}</Text>
                  </View>
                </Pressable>
                {r.kind === "meal" && (
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => onAi(r.id)}
                    style={st.action}
                    accessibilityLabel="请求饮食分析"
                  >
                    <Ionicons name="sparkles-outline" size={18} color={color.pine} />
                  </Pressable>
                )}
                <Pressable
                  accessibilityRole="button"
                  onPress={() => onDelete(r.kind, r.id)}
                  style={st.action}
                  accessibilityLabel="删除记录"
                >
                  <Ionicons name="trash-outline" size={18} color={color.inkFaint} />
                </Pressable>
              </View>
            );
          })}
        </View>
      )) : (
        <View style={st.empty}>
          <Text style={type.heading}>暂无记录</Text>
          <Text style={[type.bodySoft, { textAlign: "center" }]}>
            {filter === "all" ? "在“今天”页记下第一餐、一次训练或一晚睡眠。" : `还没有${moduleTone[filter].name}记录。`}
          </Text>
        </View>
      )}
      <View style={st.summaries}>
        <Text style={st.sectionTitle}>每日摘要</Text>
        <SummaryVersions summaries={data.summaries} />
      </View>
    </ScrollView>
  );
}

const st = StyleSheet.create({
  title: { ...type.display },
  intro: { ...type.bodySoft, marginTop: space.xs, marginBottom: space.lg },
  filters: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, marginBottom: space.lg },
  filter: {
    flexDirection: "row", alignItems: "center", gap: 5, minHeight: 40, paddingHorizontal: 12,
    borderRadius: radius.pill, borderWidth: 1, borderColor: color.lineStrong, backgroundColor: color.surface,
  },
  filterDot: { width: 8, height: 8, borderRadius: 4 },
  filterText: { fontSize: 14, fontWeight: "700", color: color.ink },
  filterCount: { fontSize: 12, color: color.inkFaint, ...type.numeric },
  group: { marginBottom: space.xl },
  groupTitle: { ...type.small, fontWeight: "700", color: color.inkSoft, marginBottom: space.sm },
  row: {
    flexDirection: "row", alignItems: "center", backgroundColor: color.surface, borderRadius: radius.block,
    borderWidth: 1, borderColor: color.line, marginBottom: space.sm, paddingRight: 4, overflow: "hidden",
  },
  rowMain: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: space.md, minHeight: 64, paddingRight: space.sm },
  spine: { width: 4, alignSelf: "stretch" },
  thumb: { width: 44, height: 44, borderRadius: radius.input, backgroundColor: color.sunken },
  icon: { width: 44, height: 44, borderRadius: radius.input, alignItems: "center", justifyContent: "center" },
  action: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  empty: { alignItems: "center", gap: 4, paddingVertical: space.xl, paddingHorizontal: space.lg, backgroundColor: color.surface, borderRadius: radius.block },
  summaries: { marginTop: space.lg },
  sectionTitle: { ...type.title, marginBottom: space.sm },
});
