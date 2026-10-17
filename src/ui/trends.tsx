import React, { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import type { AppData } from "../types";
import { localDate, mealCalories } from "../domain";
import { Note } from "./components";
import { rangeLabel, recordDate, sleepHours } from "./format";
import { color, mono, moduleTone, radius, space, type, type ModuleKind } from "./theme";

export function Trends({ data, contentStyle }: { data: AppData; contentStyle: StyleProp<ViewStyle> }) {
  const [days, setDays] = useState<7 | 30>(7);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

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

  const activeDay = selectedDate && dates.includes(selectedDate) ? selectedDate : null;
  const dayMeals = activeDay ? data.meals.filter((r) => recordDate(r) === activeDay) : [];
  const dayTrainings = activeDay ? data.trainings.filter((r) => recordDate(r) === activeDay) : [];
  const daySleeps = activeDay ? data.sleeps.filter((r) => recordDate(r) === activeDay) : [];

  return (
    <ScrollView contentContainerStyle={contentStyle} showsVerticalScrollIndicator={false}>
      <Text style={type.caption}>BIOMETRIC TRENDS</Text>
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

      <Coverage
        dates={dates}
        meals={meals}
        training={training}
        sleep={sleep}
        selectedDate={activeDay}
        onSelectDate={(d) => setSelectedDate(activeDay === d ? null : d)}
      />

      {activeDay && (
        <View style={st.dayDetailCard}>
          <View style={st.dayDetailHead}>
            <Text style={type.heading}>{activeDay} 当日记录详情</Text>
            <Pressable accessibilityRole="button" onPress={() => setSelectedDate(null)}>
              <Text style={st.closeDetail}>收起</Text>
            </Pressable>
          </View>
          <Text style={st.dayDetailLine}>
            饮食：{dayMeals.length ? dayMeals.map((m) => `${m.mealType} ${m.foodName}${mealCalories(m) ? ` (${rangeLabel(mealCalories(m), " kcal")})` : ""}`).join("；") : "未记录"}
          </Text>
          <Text style={st.dayDetailLine}>
            训练：{dayTrainings.length ? dayTrainings.map((t) => `${t.exercise} (${t.mode === "cardio" ? `${t.durationMinutes ?? 0} 分钟` : `${t.sets.length} 组`})`).join("；") : "未记录"}
          </Text>
          <Text style={st.dayDetailLine}>
            睡眠：{daySleeps.length ? daySleeps.map((s) => `${sleepHours(s)?.toFixed(1) ?? "未知"} 小时 · 质量 ${s.quality}/5`).join("；") : "未记录"}
          </Text>
        </View>
      )}

      {sleepInRange < 3 && (
        <Note
          text={`睡眠基础趋势至少需要 3 条有效记录；当前区间已有 ${sleepInRange} 条。`}
          tone={color.sleepText}
          tint={color.sleepTint}
        />
      )}

      <Trend
        kind="meal"
        title="饮食记录"
        dates={dates}
        values={dates.map((d) => meals.get(d) ?? null)}
        unit="餐"
        selectedDate={activeDay}
        onSelectDate={(d) => setSelectedDate(activeDay === d ? null : d)}
      />
      <Trend
        kind="training"
        title="训练记录"
        dates={dates}
        values={dates.map((d) => training.get(d) ?? null)}
        unit="次"
        selectedDate={activeDay}
        onSelectDate={(d) => setSelectedDate(activeDay === d ? null : d)}
      />
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
          selectedDate={activeDay}
          onSelectDate={(d) => setSelectedDate(activeDay === d ? null : d)}
        />
      )}
    </ScrollView>
  );
}

/** Day-by-module barcode matrix: tap any day column to inspect that date's records. */
function Coverage({
  dates,
  meals,
  training,
  sleep,
  selectedDate,
  onSelectDate,
}: {
  dates: string[];
  meals: Map<string, number>;
  training: Map<string, number>;
  sleep: Map<string, number[]>;
  selectedDate: string | null;
  onSelectDate: (d: string) => void;
}) {
  const rows: Array<[ModuleKind, (d: string) => boolean]> = [
    ["meal", (d) => meals.has(d)],
    ["training", (d) => training.has(d)],
    ["sleep", (d) => sleep.has(d)],
  ];
  return (
    <View style={st.coverage}>
      <View style={st.covHead}>
        <Text style={st.blockTitle}>记录覆盖矩阵</Text>
        <Text style={type.caption}>点击任意日期列查看详情</Text>
      </View>
      {rows.map(([kind, has]) => {
        const hit = dates.filter(has).length;
        return (
          <View key={kind} style={st.covRow} accessible accessibilityLabel={`${moduleTone[kind].name}：${hit}/${dates.length} 天有记录`}>
            <Text style={st.covLabel}>{moduleTone[kind].name}</Text>
            <View style={st.covCells}>
              {dates.map((d) => (
                <Pressable
                  key={d}
                  onPress={() => onSelectDate(d)}
                  style={[
                    st.cell,
                    has(d) && { backgroundColor: moduleTone[kind].hue },
                    selectedDate === d && st.cellSelected,
                  ]}
                />
              ))}
            </View>
            <Text style={st.covCount}>{hit}/{dates.length}</Text>
          </View>
        );
      })}
    </View>
  );
}

function Trend({
  kind,
  title,
  dates,
  values,
  unit,
  selectedDate,
  onSelectDate,
}: {
  kind: ModuleKind;
  title: string;
  dates: string[];
  values: Array<number | null>;
  unit: string;
  selectedDate: string | null;
  onSelectDate: (d: string) => void;
}) {
  const known = values.filter((v): v is number => v !== null);
  const max = Math.max(...known, 1);
  const min = known.length ? Math.min(...known) : null;
  const avg = known.length ? known.reduce((s, x) => s + x, 0) / known.length : null;
  const fmt = (v: number | null) => (v === null ? "—" : Number.isInteger(v) ? String(v) : v.toFixed(1));
  const tone = moduleTone[kind];
  const dense = dates.length > 14;
  return (
    <View style={st.trend}>
      <View style={st.trendHead}>
        <View style={st.trendTitleRow}>
          <View style={[st.dot, { backgroundColor: tone.hue }]} />
          <Text style={type.heading}>{title}</Text>
        </View>
        <Text style={type.small}>有效 {known.length}/{dates.length} 天</Text>
      </View>

      <View style={st.statsStrip}>
        <View style={st.statChip}>
          <Text style={st.statLabel}>平均 AVG</Text>
          <Text style={st.statVal}>{fmt(avg)} {avg !== null ? unit : ""}</Text>
        </View>
        <View style={st.statChip}>
          <Text style={st.statLabel}>最高 MAX</Text>
          <Text style={st.statVal}>{fmt(known.length ? max : null)} {known.length ? unit : ""}</Text>
        </View>
        <View style={st.statChip}>
          <Text style={st.statLabel}>最低 MIN</Text>
          <Text style={st.statVal}>{fmt(min)} {min !== null ? unit : ""}</Text>
        </View>
      </View>

      <View style={st.bars}>
        {values.map((value, index) => {
          const d = dates[index];
          const isSel = selectedDate === d;
          return (
            <Pressable
              key={d}
              onPress={() => onSelectDate(d)}
              style={[st.barColumn, isSel && st.barColumnSel]}
              accessibilityLabel={`${d} ${title}：${value === null ? "未记录" : `${value.toFixed(1)} ${unit}`}`}
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
                  <View style={[st.barFill, { height: `${Math.max(8, (value / max) * 100)}%`, backgroundColor: tone.hue }]} />
                )}
              </View>
              {(!dense || index % 5 === 0 || index === dates.length - 1) ? (
                <Text style={[st.barDate, isSel && { color: color.ink, fontWeight: "800" }]}>
                  {dense ? d.slice(8) : d.slice(5)}
                </Text>
              ) : (
                <Text style={st.barDate}> </Text>
              )}
            </Pressable>
          );
        })}
      </View>
      <Text style={st.trendUnit}>{unit} · 空白日期保留为空槽，点击柱体可查看当日记录</Text>
    </View>
  );
}

const st = StyleSheet.create({
  title: { ...type.display, marginTop: 2 },
  intro: { ...type.bodySoft, marginTop: space.xs, marginBottom: space.lg },
  segment: {
    flexDirection: "row",
    alignSelf: "flex-start",
    backgroundColor: color.sunken,
    borderRadius: radius.input,
    padding: 3,
    marginBottom: space.lg,
  },
  segmentItem: { minHeight: 36, paddingHorizontal: 18, borderRadius: radius.input - 2, justifyContent: "center" },
  segmentOn: { backgroundColor: color.ink },
  segmentText: { color: color.inkSoft, fontSize: 13, fontWeight: "700" },
  segmentTextOn: { color: color.onInk },
  coverage: {
    backgroundColor: color.surface,
    borderRadius: radius.block,
    borderWidth: 1,
    borderColor: color.line,
    padding: space.lg,
    marginBottom: space.md,
  },
  covHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", marginBottom: space.md },
  blockTitle: { ...type.heading },
  covRow: { flexDirection: "row", alignItems: "center", gap: space.md, marginBottom: space.sm },
  covLabel: { width: 32, ...type.small, color: color.ink, fontWeight: "700" },
  covCells: { flex: 1, flexDirection: "row", gap: 2 },
  cell: { flex: 1, height: 22, borderRadius: 2, backgroundColor: color.sunken },
  cellSelected: { borderWidth: 1.5, borderColor: color.ink },
  covCount: { width: 42, textAlign: "right", ...type.small, ...type.numeric },

  dayDetailCard: {
    backgroundColor: color.surface,
    borderRadius: radius.block,
    borderWidth: 1.5,
    borderColor: color.ink,
    padding: space.md,
    marginBottom: space.md,
    gap: 6,
  },
  dayDetailHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  closeDetail: { fontSize: 12, fontWeight: "700", color: color.inkSoft },
  dayDetailLine: { fontSize: 13, lineHeight: 19, color: color.inkSoft },

  trend: {
    backgroundColor: color.surface,
    borderRadius: radius.block,
    borderWidth: 1,
    borderColor: color.line,
    padding: space.lg,
    marginBottom: space.md,
  },
  trendHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: space.sm },
  trendTitleRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
  dot: { width: 8, height: 8, borderRadius: 2 },
  statsStrip: {
    flexDirection: "row",
    gap: space.sm,
    marginBottom: space.md,
  },
  statChip: {
    flex: 1,
    backgroundColor: color.paper,
    borderRadius: radius.input,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  statLabel: { fontSize: 10, fontWeight: "700", color: color.inkFaint, fontFamily: mono },
  statVal: { fontSize: 13, fontWeight: "800", color: color.ink, marginTop: 2, ...type.numeric },
  bars: { flexDirection: "row", alignItems: "flex-end", gap: 2 },
  barColumn: { flex: 1, alignItems: "center", minWidth: 0, paddingVertical: 2, borderRadius: 3 },
  barColumnSel: { backgroundColor: color.paper },
  barValue: { fontSize: 11, color: color.ink, minHeight: 15, ...type.numeric },
  barSlot: { width: "72%", maxWidth: 22, height: 88, justifyContent: "flex-end" },
  barEmpty: { height: 4, borderRadius: 2, backgroundColor: color.sunken },
  barFill: { width: "100%", borderRadius: 3 },
  barDate: { fontSize: 10, color: color.inkFaint, marginTop: 6, ...type.numeric },
  trendUnit: { ...type.small, color: color.inkFaint, marginTop: space.md },
});
