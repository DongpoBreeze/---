import React, { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import type { AppData } from "../types";
import { localDate } from "../domain";
import { Note } from "./components";
import { recordDate, sleepHours } from "./format";
import { radius, space, type ModuleKind, type ThemeTokens } from "./theme";
import { useTheme, useThemedStyles } from "./theme-provider";

export function Trends({ data, contentStyle }: { data: AppData; contentStyle: StyleProp<ViewStyle> }) {
  const { color } = useTheme();
  const st = useThemedStyles(createStyles);
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
    <ScrollView contentContainerStyle={[contentStyle, st.screen]} showsVerticalScrollIndicator={false}>
      <View>
        <View style={st.capRow}>
          <Text style={st.cap}>PATTERNS · 近期节律</Text>
          <Text style={st.pill}>近 {days} 日</Text>
        </View>
        <Text style={st.title}>趋势</Text>
        <Text style={st.intro}>按实际日期展示，空白日期保留为空，不把未记录当成零。</Text>
      </View>
      <View style={st.segment}>
        {([7, 30] as const).map((n) => (
          <Pressable
            key={n}
            accessibilityRole="button"
            accessibilityState={{ selected: days === n }}
            onPress={() => setDays(n)}
            style={({ pressed }) => [st.segmentItem, days === n && st.segmentOn, pressed && { opacity: 0.72 }]}
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
      <Trend kind="meal" index="01" title="饮食记录" dates={dates} values={dates.map((d) => meals.get(d) ?? null)} unit="餐" />
      <Trend kind="training" index="02" title="训练记录" dates={dates} values={dates.map((d) => training.get(d) ?? null)} unit="次" />
      {sleepInRange >= 3 && (
        <Trend
          kind="sleep"
          index="03"
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
  const { moduleTone } = useTheme();
  const st = useThemedStyles(createStyles);
  const rows: Array<[ModuleKind, (d: string) => boolean]> = [
    ["meal", (d) => meals.has(d)],
    ["training", (d) => training.has(d)],
    ["sleep", (d) => sleep.has(d)],
  ];
  return (
    <View style={st.coverage}>
      <Text style={st.cap}>COVERAGE · 覆盖</Text>
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

function Trend({ kind, index: no, title, dates, values, unit }: {
  kind: ModuleKind;
  index: string;
  title: string;
  dates: string[];
  values: Array<number | null>;
  unit: string;
}) {
  const { moduleTone } = useTheme();
  const st = useThemedStyles(createStyles);
  const known = values.filter((v): v is number => v !== null);
  const max = Math.max(...known, 1);
  const tone = moduleTone[kind];
  const dense = dates.length > 14;
  return (
    <View style={st.trend}>
      <View style={st.trendHead}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={st.trendTitleRow}>
            <View style={[st.dot, { backgroundColor: tone.hue }]} />
            <Text style={st.cap}>{no} / {tone.name}</Text>
          </View>
          <Text style={st.trendTitle}>{title}</Text>
        </View>
        <Text style={st.pill}>有值 {known.length}/{dates.length} 天</Text>
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

const createStyles = ({ color, type, shadow }: ThemeTokens) => StyleSheet.create({
  screen: { gap: 12 },
  capRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  cap: { ...type.cap },
  pill: { fontSize: 10, lineHeight: 14, fontWeight: "700", color: color.inkSoft, backgroundColor: color.sunken, paddingVertical: 2, paddingHorizontal: 8, borderRadius: 999, overflow: "hidden" },
  title: { ...type.display, marginTop: 4 },
  intro: { fontSize: 12.5, lineHeight: 19, color: color.inkSoft, marginTop: space.xs },
  segment: { flexDirection: "row", alignSelf: "flex-start", backgroundColor: color.sunken, borderRadius: radius.pill, padding: 3 },
  segmentItem: { minHeight: 32, paddingHorizontal: 16, borderRadius: radius.pill, justifyContent: "center" },
  segmentOn: { backgroundColor: color.ink },
  segmentText: { color: color.inkSoft, fontSize: 12.5, fontWeight: "700" },
  segmentTextOn: { color: color.paper },
  coverage: { backgroundColor: color.surface, borderRadius: 16, padding: 16, borderWidth: 1, borderColor: color.line, ...shadow.card },
  blockTitle: { ...type.heading, marginTop: 4, marginBottom: space.md },
  covRow: { flexDirection: "row", alignItems: "center", gap: space.md, marginBottom: space.sm },
  covLabel: { width: 32, fontSize: 11.5, lineHeight: 16, color: color.ink, fontWeight: "700" },
  covCells: { flex: 1, minWidth: 0, flexDirection: "row", gap: 2 },
  cell: { flex: 1, height: 16, borderRadius: 3, backgroundColor: color.sunken },
  covCount: { width: 40, textAlign: "right", fontSize: 11, color: color.inkSoft, ...type.mono },
  trend: { backgroundColor: color.surface, borderRadius: 16, padding: 16, borderWidth: 1, borderColor: color.line, ...shadow.card },
  trendHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: space.sm, marginBottom: space.md },
  trendTitleRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  trendTitle: { ...type.heading, marginTop: 4 },
  dot: { width: 8, height: 8, borderRadius: 2 },
  bars: { flexDirection: "row", alignItems: "flex-end", gap: 2 },
  barColumn: { flex: 1, alignItems: "center", minWidth: 0 },
  barValue: { fontSize: 10.5, color: color.ink, minHeight: 15, ...type.mono },
  barSlot: { width: "70%", maxWidth: 22, height: 88, justifyContent: "flex-end" },
  barEmpty: { height: 4, borderRadius: 2, backgroundColor: color.sunken },
  barFill: { width: "100%", borderRadius: 4, opacity: 0.85 },
  barDate: { fontSize: 9.5, color: color.inkFaint, marginTop: 6, ...type.mono },
  trendUnit: { fontSize: 10.5, lineHeight: 15, color: color.inkFaint, marginTop: space.md },
});
