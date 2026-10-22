import React from "react";
import { Pressable, ScrollView, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { AppData, Goal } from "../types";
import type { AiSettings } from "../ai-provider";
import type { AppearanceMode } from "../appearance";
import { SmallButton, useBaseStyles, type IconName } from "./components";
import { radius, space, type ThemeTokens } from "./theme";
import { useTheme, useThemedStyles } from "./theme-provider";
import { ProfileHealthPanel } from "./profile-health";
import { profileAgeReference } from "../profile-health";

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
  const { color, type } = useTheme();
  const st = useThemedStyles(createStyles);
  const base = useBaseStyles();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [st.setting, !last && st.settingLine, pressed && base.pressed]}
    >
      <View style={[st.settingIcon, danger && { backgroundColor: color.dangerTint }]}>
        <Ionicons name={icon} size={17} color={danger ? color.danger : color.ink} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[type.label, danger && { color: color.danger }]}>{title}</Text>
        <Text style={type.small}>{detail}</Text>
      </View>
      <Ionicons name="chevron-forward" size={17} color={color.inkFaint} />
    </Pressable>
  );
}

const appearanceOptions: Array<{ mode: AppearanceMode; label: string; detail: string; icon: IconName }> = [
  { mode: "system", label: "跟随系统", detail: "随设备设置自动切换", icon: "phone-portrait-outline" },
  { mode: "light", label: "浅色模式", detail: "始终使用浅色外观", icon: "sunny-outline" },
  { mode: "dark", label: "暗色模式", detail: "始终使用暗色外观", icon: "moon-outline" },
];

function AppearanceSettings() {
  const { color, type, mode, scheme, ready, saving, error, setMode } = useTheme();
  const st = useThemedStyles(createStyles);
  const base = useBaseStyles();
  const disabled = saving || !ready;
  return (
    <View>
      <View style={st.panel} accessibilityRole="radiogroup" accessibilityLabel="外观模式">
        {appearanceOptions.map((option, index) => {
          const selected = mode === option.mode;
          return (
            <Pressable
              key={option.mode}
              accessibilityRole="radio"
              accessibilityLabel={option.label}
              aria-checked={selected}
              aria-disabled={disabled}
              accessibilityHint={option.detail}
              accessibilityState={{ checked: selected, disabled }}
              disabled={disabled}
              onPress={() => { void setMode(option.mode).catch(() => undefined); }}
              style={({ pressed }) => [st.appearanceOption, index < appearanceOptions.length - 1 && st.settingLine,
                selected && st.appearanceSelected, pressed && base.pressed]}
            >
              <View style={st.settingIcon}>
                <Ionicons name={option.icon} size={17} color={color.ink} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={type.label}>{option.label}</Text>
                <Text style={type.small}>{option.detail}</Text>
              </View>
              <View style={[st.radio, selected && st.radioSelected]}>
                {selected && <View style={st.radioDot} />}
              </View>
            </Pressable>
          );
        })}
      </View>
      <Text style={st.appearanceStatus} accessibilityLiveRegion="polite">
        {saving ? "正在保存外观设置…" : `当前外观：${scheme === "dark" ? "暗色模式" : "浅色模式"}${mode === "system" ? " · 跟随系统" : ""}。`}
      </Text>
      {error ? <Text style={st.appearanceError} accessibilityRole="alert" accessibilityLiveRegion="polite">{error}</Text>
        : <Text style={st.appearanceHint}>切换立即生效，自动保存在本机。</Text>}
    </View>
  );
}

export function Me({
  data,
  contentStyle,
  onProfile,
  onAiSettings,
  onAiReconfigure,
  aiSettings,
  aiSettingsReady,
  aiSettingsError,
  onImport,
  onExport,
  onMarkdown,
  onDelete,
}: {
  data: AppData;
  contentStyle: StyleProp<ViewStyle>;
  onProfile: () => void;
  onAiSettings: () => void;
  onAiReconfigure?: () => void;
  aiSettings: AiSettings | null;
  aiSettingsReady: boolean;
  aiSettingsError?: string;
  onImport: () => void;
  onExport: () => void;
  onMarkdown: () => void;
  onDelete: () => void;
}) {
  const { color } = useTheme();
  const st = useThemedStyles(createStyles);
  const base = useBaseStyles();
  const p = data.profile;
  const total = data.meals.length + data.trainings.length + data.sleeps.length;
  return (
    <ScrollView contentContainerStyle={[contentStyle, st.screen]} showsVerticalScrollIndicator={false}>
      <View>
        <View style={st.capRow}>
          <Text style={st.cap}>PROFILE · 本机</Text>
          <Text style={st.pill}>{total} 条记录</Text>
        </View>
        <Text style={st.title}>我的</Text>
        <Text style={st.intro}>目标和资料只影响后续建议，不会改写已有记录。</Text>
      </View>
      <Pressable
        accessibilityRole="button"
        onPress={onProfile}
        style={({ pressed }) => [st.profile, pressed && base.pressed]}
      >
        <Text style={st.cap}>GOAL · 当前目标</Text>
        <Text style={st.profileGoal}>{p.goal ? goalLabels[p.goal] : "尚未设置目标"}</Text>
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
      </Pressable>
      <ProfileHealthPanel profile={p} />
      <Text style={st.group}>APPEARANCE · 外观</Text>
      <AppearanceSettings />
      <Text style={st.group}>AI · 服务</Text>
      <View style={st.panel}>
        <Setting
          icon="sparkles-outline"
          title="AI 服务设置"
          detail={!aiSettingsReady ? "读取中" : aiSettingsError ? "读取失败，点此重试" : aiSettings ? `${aiSettings.model} · ${aiSettings.reasoningEffort || "默认强度"}` : "尚未配置"}
          onPress={onAiSettings}
          last
        />
      </View>
      {Boolean(aiSettingsError) && onAiReconfigure && (
        <View>
          <SmallButton icon="create-outline" label="重新配置 AI 服务" disabled={!aiSettingsReady} onPress={onAiReconfigure} />
        </View>
      )}
      <Text style={st.group}>DATA · 本机共 {total} 条记录</Text>
      <View style={st.panel}>
        <Setting icon="download-outline" title="导出完整备份" detail="记录、媒体和每日摘要" onPress={onExport} />
        <Setting icon="document-text-outline" title="导出今日 Markdown" detail="本地摘要的可读文件" onPress={onMarkdown} />
        <Setting icon="cloud-upload-outline" title="恢复备份" detail="取消选择不会改变当前数据" onPress={onImport} last />
      </View>
      <View style={st.panel}>
        <Setting icon="trash-outline" title="删除本机数据" detail="App 外的备份不会被撤回" onPress={onDelete} danger last />
      </View>
      <View style={st.privacy}>
        <Ionicons name="lock-closed" size={14} color={color.inkFaint} />
        <Text style={st.privacyText}>核心记录在本机保存。发送给 AI 前会单独询问同意。</Text>
      </View>
    </ScrollView>
  );
}

function createStyles({ color, type, shadow }: ThemeTokens) {
  return StyleSheet.create({
  screen: { gap: 12 },
  capRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  cap: { ...type.cap },
  pill: { fontSize: 10, lineHeight: 14, fontWeight: "700", color: color.inkSoft, backgroundColor: color.sunken, paddingVertical: 2, paddingHorizontal: 8, borderRadius: 999, overflow: "hidden" },
  title: { ...type.display, marginTop: 4 },
  intro: { fontSize: 12.5, lineHeight: 19, color: color.inkSoft, marginTop: space.xs },
  profile: { backgroundColor: color.surface, borderRadius: 16, padding: 16, borderWidth: 1, borderColor: color.line, ...shadow.card },
  profileGoal: { color: color.ink, fontSize: 24, lineHeight: 30, fontWeight: "800", letterSpacing: -0.3, marginTop: 6 },
  demographics: { color: color.inkSoft, fontSize: 12, lineHeight: 19, marginTop: space.sm },
  ageGroup: { color: color.inkFaint, fontSize: 11, lineHeight: 17, marginTop: 2 },
  stats: { flexDirection: "row", gap: space.sm, marginTop: 14 },
  stat: { flex: 1, minWidth: 0, backgroundColor: color.sunken, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 10 },
  statLabel: { color: color.inkSoft, fontSize: 10.5, lineHeight: 14, fontWeight: "700" },
  statValue: { color: color.ink, fontSize: 18, lineHeight: 24, fontWeight: "800", marginTop: 4, ...type.mono },
  statUnit: { color: color.inkFaint, fontSize: 10, lineHeight: 13 },
  targetSource: { color: color.inkFaint, fontSize: 11, lineHeight: 17, marginTop: space.sm },
  profileEdit: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 12, paddingTop: 10, minHeight: 28, borderTopWidth: 1, borderTopColor: color.line },
  profileEditText: { color: color.inkSoft, fontSize: 12.5, fontWeight: "700", flex: 1 },
  group: { ...type.cap, marginTop: 10, marginBottom: -4, paddingHorizontal: 2 },
  panel: { backgroundColor: color.surface, borderRadius: 16, paddingHorizontal: 14, borderWidth: 1, borderColor: color.line, ...shadow.card },
  setting: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: 60 },
  settingLine: { borderBottomWidth: 1, borderColor: color.line },
  settingIcon: { width: 34, height: 34, borderRadius: 10, backgroundColor: color.sunken, alignItems: "center", justifyContent: "center" },
  appearanceOption: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: 68, paddingVertical: space.sm, paddingHorizontal: 6, marginHorizontal: -6 },
  appearanceSelected: { backgroundColor: color.highlight, borderRadius: 10, borderColor: "transparent" },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 1.5, borderColor: color.inkFaint, alignItems: "center", justifyContent: "center", marginLeft: space.xs },
  radioSelected: { borderColor: color.ink, backgroundColor: color.ink },
  radioDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: color.paper },
  appearanceStatus: { ...type.small, fontSize: 11.5, marginTop: space.sm, paddingHorizontal: space.xs },
  appearanceHint: { ...type.small, fontSize: 11.5, color: color.inkFaint, marginTop: 2, paddingHorizontal: space.xs },
  appearanceError: { ...type.small, color: color.danger, marginTop: space.xs, paddingHorizontal: space.xs },
  privacy: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, marginTop: space.sm, paddingHorizontal: space.xs },
  privacyText: { fontSize: 11, lineHeight: 16, color: color.inkFaint, textAlign: "center", flexShrink: 1 },
  });
}
