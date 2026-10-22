import React from "react";
import { ScrollView, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { AppData, Goal } from "../types";
import { recordLocalDate } from "../domain";
import { space, type ThemeTokens } from "./theme";
import { useTheme, useThemedStyles } from "./theme-provider";
import { PressScale, Reveal } from "./motion";
import { ProfileHealthPanel } from "./profile-health";
import { profileAgeReference } from "../profile-health";
import type { Kind } from "./app-types";

const goalLabels: Record<Goal, string> = {
  health: "保持健康",
  "fat-loss": "减脂",
  "muscle-gain": "增肌",
};

function latestDate(records: Parameters<typeof recordLocalDate>[0][]) {
  let latest = "";
  for (const record of records) {
    const date = recordLocalDate(record);
    if (date > latest) latest = date;
  }
  return latest;
}

export function Me({
  data,
  contentStyle,
  onProfile,
  onRecords,
}: {
  data: AppData;
  contentStyle: StyleProp<ViewStyle>;
  onProfile: () => void;
  onRecords: () => void;
}) {
  const { color, moduleTone } = useTheme();
  const st = useThemedStyles(createStyles);
  const p = data.profile;
  const total = data.meals.length + data.trainings.length + data.sleeps.length;
  const latest = latestDate([...data.meals, ...data.trainings, ...data.sleeps]);
  const modules: Array<[Kind, number]> = [
    ["meal", data.meals.length],
    ["training", data.trainings.length],
    ["sleep", data.sleeps.length],
  ];
  const templateCount = data.workoutTemplates?.length ?? 0;
  return (
    <ScrollView contentContainerStyle={[contentStyle, st.screen]} showsVerticalScrollIndicator={false}>
      <Reveal index={0}>
        <View style={st.capRow}>
          <Text style={st.cap}>PROFILE · 本机</Text>
          <Text style={st.pill}>{total} 条记录</Text>
        </View>
        <Text style={st.title}>我的</Text>
        <Text style={st.intro}>目标和资料只影响后续建议，不会改写已有记录。</Text>
      </Reveal>
      <Reveal index={1}>
      <PressScale
        accessibilityRole="button"
        onPress={onProfile}
        scaleTo={0.98}
        style={st.profile}
      >
        <View style={st.profileTop}>
          <View style={st.profileAvatar}>
            <Ionicons name="person" size={22} color={color.onTraining} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={st.cap}>GOAL · 当前目标</Text>
            <Text style={st.profileGoal}>{p.goal ? goalLabels[p.goal] : "尚未设置目标"}</Text>
          </View>
        </View>
        <Text testID="profile-demographics" style={st.demographics}>
          {`性别：${p.sex === "male" ? "男" : p.sex === "female" ? "女" : "未填写"} · 年龄：${p.ageYears === undefined ? "未填写" : `${p.ageYears} 岁`}`}
        </Text>
        <Text testID="profile-age-group" style={st.ageGroup}>
          {`年龄分组：${profileAgeReference(p.ageYears).label}`}
        </Text>
        <View style={st.stats}>
          {[
            ["身高", p.heightCm ? `${p.heightCm}` : "—", "cm"],
            ["体重", p.weightKg ? `${p.weightKg}` : "—", "kg"],
            ["热量目标", p.calorieTarget ? `${p.calorieTarget}` : "—", "kcal/日"],
          ].map(([label, value, unit]) => (
            <View key={label} style={st.stat}>
              <Text style={st.statLabel}>{label}</Text>
              <Text style={st.statValue}>{value}</Text>
              <Text style={st.statUnit}>{value === "—" ? "未填写" : unit}</Text>
            </View>
          ))}
        </View>
        <Text style={st.targetSource}>{p.calorieTargetSource === "recommended" ? "热量目标 · 自动起始建议" : p.calorieTarget ? "热量目标 · 手动填写" : p.calorieTargetSource === "manual" ? "热量目标 · 手动留空" : "热量目标 · 尚未填写"}</Text>
        <View style={st.profileEdit}>
          <Text style={st.profileEditText}>修改目标与资料</Text>
          <Ionicons name="chevron-forward" size={14} color={color.inkSoft} />
        </View>
      </PressScale>
      </Reveal>
      <Reveal index={2}>
        <ProfileHealthPanel profile={p} />
      </Reveal>
      <Reveal index={3} style={st.section}>
        <Text style={st.group}>RECORDS · 我的记录</Text>
        <PressScale
          accessibilityRole="button"
          accessibilityLabel="全部记录"
          accessibilityHint="按日期查看、编辑或删除所有记录"
          onPress={onRecords}
          scaleTo={0.98}
          style={st.records}
        >
          <View style={st.recordTiles}>
            {modules.map(([kind, count]) => {
              const tone = moduleTone[kind];
              return (
                <View key={kind} style={[st.recordTile, { backgroundColor: tone.tint }]}>
                  <Ionicons name={tone.icon} size={16} color={tone.text} />
                  <Text style={[st.recordCount, { color: tone.text }]}>{count}</Text>
                  <Text style={st.recordLabel}>{tone.name}</Text>
                </View>
              );
            })}
          </View>
          <View style={st.recordsFoot}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={st.recordsTitle}>全部记录</Text>
              <Text style={st.recordsDetail} numberOfLines={1}>
                {total ? `共 ${total} 条 · 最近 ${latest}${templateCount ? ` · ${templateCount} 个训练模板` : ""}` : "还没有记录，从今天页开始记一笔"}
              </Text>
            </View>
            <View style={st.recordsGo}>
              <Ionicons name="arrow-forward" size={16} color={color.paper} />
            </View>
          </View>
        </PressScale>
      </Reveal>
      <View style={st.privacy}>
        <Ionicons name="lock-closed" size={14} color={color.inkFaint} />
        <Text style={st.privacyText}>资料与记录只保存在本机。外观、AI 与备份在“设置”中管理。</Text>
      </View>
    </ScrollView>
  );
}

function createStyles({ color, type, shadow }: ThemeTokens) {
  return StyleSheet.create({
  screen: { gap: 14 },
  section: { gap: 10 },
  capRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  cap: { ...type.cap },
  pill: { fontSize: 10, lineHeight: 14, fontWeight: "700", color: color.inkSoft, backgroundColor: color.sunken, paddingVertical: 2, paddingHorizontal: 8, borderRadius: 999, overflow: "hidden" },
  title: { ...type.display, fontSize: 28, lineHeight: 34, marginTop: 6 },
  intro: { fontSize: 12.5, lineHeight: 19, color: color.inkSoft, marginTop: space.xs },
  profile: { backgroundColor: color.surface, borderRadius: 20, padding: 18, borderWidth: 1, borderColor: color.line, borderTopWidth: 4, borderTopColor: color.training, ...shadow.card },
  profileTop: { flexDirection: "row", alignItems: "center", gap: 12 },
  profileAvatar: { width: 48, height: 48, borderRadius: 24, backgroundColor: color.training, alignItems: "center", justifyContent: "center" },
  profileGoal: { color: color.ink, fontSize: 24, lineHeight: 30, fontWeight: "800", letterSpacing: -0.3, marginTop: 2 },
  demographics: { color: color.inkSoft, fontSize: 12, lineHeight: 19, marginTop: space.sm },
  ageGroup: { color: color.inkFaint, fontSize: 11, lineHeight: 17, marginTop: 2 },
  stats: { flexDirection: "row", gap: space.sm, marginTop: 14 },
  stat: { flex: 1, minWidth: 0, backgroundColor: color.sunken, borderRadius: 14, paddingVertical: 12, paddingHorizontal: 12 },
  statLabel: { color: color.inkSoft, fontSize: 10.5, lineHeight: 14, fontWeight: "700" },
  statValue: { color: color.ink, fontSize: 18, lineHeight: 24, fontWeight: "800", marginTop: 4, ...type.mono },
  statUnit: { color: color.inkFaint, fontSize: 10, lineHeight: 13 },
  targetSource: { color: color.inkFaint, fontSize: 11, lineHeight: 17, marginTop: space.sm },
  profileEdit: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 12, paddingTop: 10, minHeight: 28, borderTopWidth: 1, borderTopColor: color.line },
  profileEditText: { color: color.inkSoft, fontSize: 12.5, fontWeight: "700", flex: 1 },
  group: { ...type.cap, marginTop: 8, paddingHorizontal: 2 },
  records: { backgroundColor: color.surface, borderRadius: 20, padding: 14, borderWidth: 1, borderColor: color.line, ...shadow.card },
  recordTiles: { flexDirection: "row", gap: space.sm },
  recordTile: { flex: 1, minWidth: 0, borderRadius: 14, paddingVertical: 12, paddingHorizontal: 12, gap: 2 },
  recordCount: { fontSize: 22, lineHeight: 28, fontWeight: "800", marginTop: 4, ...type.mono },
  recordLabel: { color: color.inkSoft, fontSize: 11, lineHeight: 15, fontWeight: "700" },
  recordsFoot: { flexDirection: "row", alignItems: "center", gap: space.md, marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: color.line },
  recordsTitle: { ...type.label },
  recordsDetail: { ...type.small, marginTop: 1 },
  recordsGo: { width: 34, height: 34, borderRadius: 17, backgroundColor: color.ink, alignItems: "center", justifyContent: "center" },
  privacy: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, marginTop: space.sm, paddingHorizontal: space.xs },
  privacyText: { fontSize: 11, lineHeight: 16, color: color.inkFaint, textAlign: "center", flexShrink: 1 },
  });
}
