import React from "react";
import { Pressable, ScrollView, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { AppData, Goal } from "../types";
import type { AiSettings } from "../ai-provider";
import { s as base, type IconName } from "./components";
import { color, radius, space, type } from "./theme";

const goalLabels: Record<Goal, string> = {
  health: "保持健康",
  "fat-loss": "减脂",
  "muscle-gain": "增肌",
};

function Setting({ icon, title, detail, onPress, danger = false, last = false }: {
  icon: IconName;
  title: string;
  detail: string;
  onPress: () => void;
  danger?: boolean;
  last?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [st.setting, !last && st.settingLine, pressed && base.pressed]}
    >
      <View style={[st.settingIcon, danger && { backgroundColor: color.dangerTint }]}>
        <Ionicons name={icon} size={19} color={danger ? color.danger : color.ink} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[type.label, danger && { color: color.danger }]}>{title}</Text>
        <Text style={type.small}>{detail}</Text>
      </View>
      <Ionicons name="chevron-forward" size={17} color={color.inkFaint} />
    </Pressable>
  );
}

export function Me({
  data,
  contentStyle,
  onProfile,
  onAiSettings,
  aiSettings,
  aiSettingsReady,
  onImport,
  onExport,
  onMarkdown,
  onDelete,
}: {
  data: AppData;
  contentStyle: StyleProp<ViewStyle>;
  onProfile: () => void;
  onAiSettings: () => void;
  aiSettings: AiSettings | null;
  aiSettingsReady: boolean;
  onImport: () => void;
  onExport: () => void;
  onMarkdown: () => void;
  onDelete: () => void;
}) {
  const p = data.profile;
  const total = data.meals.length + data.trainings.length + data.sleeps.length;
  return (
    <ScrollView contentContainerStyle={contentStyle} showsVerticalScrollIndicator={false}>
      <Text style={st.title}>我的</Text>
      <Text style={st.intro}>目标和资料只影响后续建议，不会改写已有记录。</Text>
      <Pressable
        accessibilityRole="button"
        onPress={onProfile}
        style={({ pressed }) => [st.profile, pressed && base.pressed]}
      >
        <Text style={st.profileLabel}>当前目标</Text>
        <Text style={st.profileGoal}>{p.goal ? goalLabels[p.goal] : "尚未设置目标"}</Text>
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
        <View style={st.profileEdit}>
          <Text style={st.profileEditText}>修改目标与资料</Text>
          <Ionicons name="chevron-forward" size={16} color={color.pine} />
        </View>
      </Pressable>
      <Text style={st.group}>AI</Text>
      <View style={st.panel}>
        <Setting
          icon="sparkles-outline"
          title="AI 服务设置"
          detail={aiSettingsReady ? aiSettings ? `${aiSettings.model} · ${aiSettings.reasoningEffort || "默认强度"}` : "尚未配置" : "读取中"}
          onPress={onAiSettings}
          last
        />
      </View>
      <Text style={st.group}>数据 · 本机共 {total} 条记录</Text>
      <View style={st.panel}>
        <Setting icon="download-outline" title="导出完整备份" detail="记录、媒体和每日摘要" onPress={onExport} />
        <Setting icon="document-text-outline" title="导出今日 Markdown" detail="本地摘要的可读文件" onPress={onMarkdown} />
        <Setting icon="cloud-upload-outline" title="恢复备份" detail="取消选择不会改变当前数据" onPress={onImport} last />
      </View>
      <View style={st.panel}>
        <Setting icon="trash-outline" title="删除本机数据" detail="App 外的备份不会被撤回" onPress={onDelete} danger last />
      </View>
      <View style={st.privacy}>
        <Ionicons name="lock-closed" size={16} color={color.inkSoft} />
        <Text style={st.privacyText}>核心记录在本机保存。发送给 AI 前会单独询问同意。</Text>
      </View>
    </ScrollView>
  );
}

const st = StyleSheet.create({
  title: { ...type.display },
  intro: { ...type.bodySoft, marginTop: space.xs, marginBottom: space.lg },
  profile: { backgroundColor: color.pineTint, borderRadius: radius.block, padding: space.lg, borderWidth: 1, borderColor: "#24594A" },
  profileLabel: { color: color.pine, fontSize: 13, fontWeight: "700" },
  profileGoal: { color: color.ink, fontSize: 26, lineHeight: 32, fontWeight: "800", marginTop: 2 },
  stats: { flexDirection: "row", gap: space.sm, marginTop: space.lg },
  stat: { flex: 1, backgroundColor: color.paper, borderRadius: radius.input, padding: 10 },
  statLabel: { color: color.inkSoft, fontSize: 12 },
  statValue: { color: color.ink, fontSize: 20, fontWeight: "800", marginTop: 2, ...type.numeric },
  statUnit: { color: color.inkFaint, fontSize: 11 },
  profileEdit: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: space.md, minHeight: 28 },
  profileEditText: { color: color.pine, fontSize: 14, fontWeight: "700" },
  group: { ...type.small, fontWeight: "700", color: color.inkSoft, marginTop: space.xl, marginBottom: space.sm },
  panel: { backgroundColor: color.surface, borderRadius: radius.block, paddingHorizontal: space.md, marginBottom: space.sm },
  setting: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: 64 },
  settingLine: { borderBottomWidth: StyleSheet.hairlineWidth, borderColor: color.lineStrong },
  settingIcon: { width: 36, height: 36, borderRadius: 18, backgroundColor: color.sunken, alignItems: "center", justifyContent: "center" },
  privacy: { flexDirection: "row", alignItems: "center", gap: space.sm, marginTop: space.lg, paddingHorizontal: space.xs },
  privacyText: { ...type.small, flex: 1 },
});
