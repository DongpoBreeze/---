import React from "react";
import { Pressable, ScrollView, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { AppData } from "../types";
import type { AiSettings } from "../ai-provider";
import type { AppearanceMode } from "../appearance";
import { SmallButton, useBaseStyles, type IconName } from "./components";
import { space, type ThemeTokens } from "./theme";
import { useTheme, useThemedStyles } from "./theme-provider";
import { Reveal } from "./motion";

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

export function Settings({
  data,
  contentStyle,
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
  const total = data.meals.length + data.trainings.length + data.sleeps.length;
  return (
    <ScrollView contentContainerStyle={[contentStyle, st.screen]} showsVerticalScrollIndicator={false}>
      <Reveal index={0}>
        <Text style={st.cap}>SETTINGS · 本机</Text>
        <Text style={st.title}>设置</Text>
        <Text style={st.intro}>外观、AI 服务与数据管理。所有设置只保存在这台设备上。</Text>
      </Reveal>
      <Reveal index={1} style={st.section}>
        <Text style={st.group}>APPEARANCE · 外观</Text>
        <AppearanceSettings />
      </Reveal>
      <Reveal index={2} style={st.section}>
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
      </Reveal>
      <Reveal index={3} style={st.section}>
        <Text style={st.group}>DATA · 本机共 {total} 条记录</Text>
        <View style={st.panel}>
          <Setting icon="download-outline" title="导出完整备份" detail="记录、媒体和每日摘要" onPress={onExport} />
          <Setting icon="document-text-outline" title="导出今日 Markdown" detail="本地摘要的可读文件" onPress={onMarkdown} />
          <Setting icon="cloud-upload-outline" title="恢复备份" detail="取消选择不会改变当前数据" onPress={onImport} last />
        </View>
        <View style={st.panel}>
          <Setting icon="trash-outline" title="删除本机数据" detail="App 外的备份不会被撤回" onPress={onDelete} danger last />
        </View>
      </Reveal>
      <View style={st.privacy}>
        <Ionicons name="lock-closed" size={14} color={color.inkFaint} />
        <Text style={st.privacyText}>核心记录在本机保存。发送给 AI 前会单独询问同意。</Text>
      </View>
    </ScrollView>
  );
}

function createStyles({ color, type, shadow }: ThemeTokens) {
  return StyleSheet.create({
  screen: { gap: 14 },
  section: { gap: 10 },
  cap: { ...type.cap },
  title: { ...type.display, fontSize: 28, lineHeight: 34, marginTop: 6 },
  intro: { fontSize: 12.5, lineHeight: 19, color: color.inkSoft, marginTop: space.xs },
  group: { ...type.cap, marginTop: 8, paddingHorizontal: 2 },
  panel: { backgroundColor: color.surface, borderRadius: 20, paddingHorizontal: 14, borderWidth: 1, borderColor: color.line, ...shadow.card },
  setting: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: 60 },
  settingLine: { borderBottomWidth: 1, borderColor: color.line },
  settingIcon: { width: 36, height: 36, borderRadius: 12, backgroundColor: color.sunken, alignItems: "center", justifyContent: "center" },
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
