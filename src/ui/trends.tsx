import React, { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import type { AppData } from "../types";
import { localDate } from "../domain";
import { Note } from "./components";
import { recordDate, sleepHours } from "./format";
import { color, moduleTone, radius, space, type, type ModuleKind } from "./theme";

export function Trends({ data, contentStyle }: { data: AppData; contentStyle: StyleProp<ViewStyle> }) {
  const [days, setDays] = useState<7 | 30>(7);
  const dates = useMemo(
    () =>
      Array.from({ length: days }, (_, index) => {
        const d = new Date();
        d.setHours(0, 0, 0, 0);
        d.setDate(d.getDate() - (days - 1 - index));
        return localDate(d);
      }),
    [days],
  );
  const count = (records: Array<Parameters<typeof recordDate>[0]>) => {
    const map = new Map<string, number>();
    records.forEach((r) => map.set(recordDate(r), (map.get(recordDate(r)) ?? 0) + 1));
    return map;
  };
  const meals = count(data.meals);
  const training = count(data.trainings);
  const sleep = new Map<string, number[]>();
  data.sleeps.forEach((r) => {
    const value = sleepHours(r);
    if (value !== null) sleep.set(recordDate(r), [...(sleep.get(recordDate(r)) ?? []), value]);
  });
  const sleepInRange = data.sleeps.filter((r) => dates.includes(recordDate(r))).length;
  return (
    <ScrollView contentContainerStyle={contentStyle} showsVerticalScrollIndicator={false}>
      <Text style={st.title}>趋势</Text>
      <Text style={st.intro}>按实际日期展示，空白日期保留为空，不把未记录当成零。</Text>
      <View style={st.segment}>
        {([7, 30] as const).map((n) => (
          <Pressable
            key={n}
            accessibilityRole="button"
            accessibilityState={{ selected: days === n }}
            onPress={() => setDays(n)}
            style={[st.segmentItem, days === n && st.segmentOn]}
          >
            <Text style={[st.segmentText, days === n && st.segmentTextOn]}>近 {n} 日</Text>
          </Pressable>
        ))}
      </View>
      <Coverage dates={dates} meals={meals} training={training} sleep={sleep} />
      {sleepInRange < 3 && (
        <Note
          text={`睡眠基础趋势至少需要 3 条有效记录；当前区间已有 ${sleepInRange} 条。`}
          tone={color.sleepText}
          tint={color.sleepTint}
        />
      )}
      <Trend kind="meal" title="饮食记录" dates={dates} values={dates.map((d) => meals.get(d) ?? null)} unit="餐" />
      <Trend kind="training" title="训练记录" dates={dates} values={dates.map((d) => training.get(d) ?? null)} unit="次" />
      {sleepInRange >= 3 && (
        <Trend
          kind="sleep"
          title="估算睡眠（每日平均）"
          dates={dates}
          values={dates.map((d) => {
            const v = sleep.get(d);
            return v?.length ? v.reduce((sum, x) => sum + x, 0) / v.length : null;
          })}
          unit="小时"
        />
      )}
    </ScrollView>
  );
}

/** Day-by-module grid: a filled cell means that module has a record that day. */
function Coverage({ dates, meals, training, sleep }: {
  dates: string[];
  meals: Map<string, number>;
  training: Map<string, number>;
  sleep: Map<string, number[]>;
}) {
  const rows: Array<[ModuleKind, (d: string) => boolean]> = [
    ["meal", (d) => meals.has(d)],
    ["training", (d) => training.has(d)],
    ["sleep", (d) => sleep.has(d)],
  ];
  return (
    <View style={st.coverage}>
      <Text style={st.blockTitle}>记录覆盖</Text>
      {rows.map(([kind, has]) => {
        const hit = dates.filter(has).length;
        return (
          <View key={kind} style={st.covRow} accessible accessibilityLabel={`${moduleTone[kind].name}：${hit}/${dates.length} 天有记录`}>
            <Text style={st.covLabel}>{moduleTone[kind].name}</Text>
            <View style={st.covCells}>
              {dates.map((d) => (
                <View key={d} style={[st.cell, has(d) && { backgroundColor: moduleTone[kind].hue }]} />
              ))}
            </View>
            <Text style={st.covCount}>{hit}/{dates.length}</Text>
          </View>
        );
      })}
    </View>
  );
}

function Trend({ kind, title, dates, values, unit }: {
  kind: ModuleKind;
  title: string;
  dates: string[];
  values: Array<number | null>;
  unit: string;
}) {
  const known = values.filter((v): v is number => v !== null);
  const max = Math.max(...known, 1);
  const tone = moduleTone[kind];
  const dense = dates.length > 14;
  return (
    <View style={st.trend}>
      <View style={st.trendHead}>
        <View style={st.trendTitleRow}>
          <View style={[st.dot, { backgroundColor: tone.hue }]} />
          <Text style={type.heading}>{title}</Text>
        </View>
        <Text style={type.small}>有值 {known.length}/{dates.length} 天</Text>
      </View>
      <View style={st.bars}>
        {values.map((value, index) => (
          <View
            key={dates[index]}
            style={st.barColumn}
            accessibilityLabel={`${dates[index]} ${title}：${value === null ? "未记录" : `${value.toFixed(1)} ${unit}`}`}
          >
            {!dense && (
              <Text style={st.barValue}>
                {value === null ? "" : Number.isInteger(value) ? value : value.toFixed(1)}
              </Text>
            )}
            <View style={st.barSlot}>
              {value === null ? (
                <View style={st.barEmpty} />
              ) : (
                <View style={[st.barFill, { height: `${Math.max(6, (value / max) * 100)}%`, backgroundColor: tone.hue }]} />
              )}
            </View>
            {(!dense || index % 5 === 0 || index === dates.length - 1) ? (
              <Text style={st.barDate}>{dense ? dates[index].slice(8) : dates[index].slice(5)}</Text>
            ) : <Text style={st.barDate}> </Text>}
          </View>
        ))}
      </View>
      <Text style={st.trendUnit}>{unit} · 每日实际记录，空槽表示未记录</Text>
    </View>
  );
}

const st = StyleSheet.create({
  title: { ...type.display },
  intro: { ...type.bodySoft, marginTop: space.xs, marginBottom: space.lg },
  segment: { flexDirection: "row", alignSelf: "flex-start", backgroundColor: color.surface, borderRadius: radius.pill, padding: 3, marginBottom: space.lg },
  segmentItem: { minHeight: 38, paddingHorizontal: 18, borderRadius: radius.pill, justifyContent: "center" },
  segmentOn: { backgroundColor: color.pine },
  segmentText: { color: color.inkSoft, fontSize: 14, fontWeight: "700" },
  segmentTextOn: { color: color.onInk },
  coverage: { backgroundColor: color.surface, borderRadius: radius.block, padding: space.lg, marginBottom: space.lg },
  blockTitle: { ...type.heading, marginBottom: space.md },
  covRow: { flexDirection: "row", alignItems: "center", gap: space.md, marginBottom: space.sm },
  covLabel: { width: 32, ...type.small, color: color.ink, fontWeight: "700" },
  covCells: { flex: 1, flexDirection: "row", gap: 2 },
  cell: { flex: 1, height: 18, borderRadius: 3, backgroundColor: color.sunken },
  covCount: { width: 40, textAlign: "right", ...type.small, ...type.numeric },
  trend: { backgroundColor: color.surface, borderRadius: radius.block, padding: space.lg, marginBottom: space.lg },
  trendHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: space.md },
  trendTitleRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
  dot: { width: 10, height: 10, borderRadius: 5 },
  bars: { flexDirection: "row", alignItems: "flex-end", gap: 2 },
  barColumn: { flex: 1, alignItems: "center", minWidth: 0 },
  barValue: { fontSize: 11, color: color.ink, minHeight: 15, ...type.numeric },
  barSlot: { width: "70%", maxWidth: 22, height: 88, justifyContent: "flex-end" },
  barEmpty: { height: 4, borderRadius: 2, backgroundColor: color.sunken },
  barFill: { width: "100%", borderRadius: 4 },
  barDate: { fontSize: 10, color: color.inkFaint, marginTop: 6, ...type.numeric },
  trendUnit: { ...type.small, color: color.inkFaint, marginTop: space.md },
});
