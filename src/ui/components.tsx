import React, { useState } from "react";
import {
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { VideoView, useVideoPlayer } from "expo-video";
import type { DailySummary } from "../types";
import { color, moduleTone, radius, space, type, type ModuleKind } from "./theme";
import { localDateTime } from "./format";

export type IconName = keyof typeof Ionicons.glyphMap;

export function Banner({
  text,
  danger = false,
  onClose,
  action,
  onAction,
}: {
  text: string;
  danger?: boolean;
  onClose: () => void;
  action?: string;
  onAction?: () => void;
}) {
  const tone = danger ? color.danger : color.pine;
  return (
    <View style={[s.banner, danger && s.bannerDanger]}>
      <Ionicons
        name={danger ? "alert-circle" : "information-circle"}
        size={18}
        color={tone}
      />
      <Text style={[s.bannerText, danger && { color: color.danger }]}>{text}</Text>
      {action && onAction ? (
        <Pressable accessibilityRole="button" onPress={onAction} hitSlop={8}>
          <Text style={[s.bannerAction, { color: tone }]}>{action}</Text>
        </Pressable>
      ) : (
        <Pressable
          accessibilityRole="button"
          onPress={onClose}
          accessibilityLabel="关闭提示"
          hitSlop={8}
        >
          <Ionicons name="close" size={18} color={tone} />
        </Pressable>
      )}
    </View>
  );
}

/** Full-height form sheet. `tone` tints the top edge so the module is obvious. */
export function Sheet({
  title,
  tone,
  children,
  onClose,
  onSave,
  disabled = false,
  saving = false,
  closing = false,
}: {
  title: string;
  tone?: ModuleKind;
  children: React.ReactNode;
  onClose: () => void;
  onSave: () => void;
  disabled?: boolean;
  saving?: boolean;
  closing?: boolean;
}) {
  const off = disabled || saving || closing;
  return (
    <KeyboardAvoidingView
      style={s.sheet}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={[s.sheetEdge, { backgroundColor: tone ? moduleTone[tone].hue : color.pine }]} />
      <View style={s.sheetHeader}>
        <Pressable
          accessibilityRole="button"
          onPress={onClose}
          disabled={saving || closing}
          accessibilityLabel="关闭"
          style={s.sheetIcon}
        >
          <Ionicons name="close" size={24} color={color.ink} />
        </Pressable>
        <Text style={s.sheetTitle} numberOfLines={1}>{title}</Text>
        <Pressable
          accessibilityRole="button"
          onPress={onSave}
          disabled={off}
          style={[s.saveButton, off && s.saveButtonOff]}
        >
          <Text style={[s.saveText, off && s.saveTextOff]}>
            {saving ? "保存中" : "保存"}
          </Text>
        </Pressable>
      </View>
      <ScrollView
        contentContainerStyle={s.form}
        keyboardShouldPersistTaps="handled"
      >
        {children}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

export function Field({
  label,
  value,
  onChangeText,
  placeholder,
  keyboardType = "default",
  multiline = false,
  disabled = false,
  style,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  keyboardType?: "default" | "numeric";
  multiline?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <View style={[s.field, style]}>
      <Text style={s.fieldLabel}>{label}</Text>
      <TextInput
        style={[s.input, multiline && s.multiline, focused && s.inputFocused, disabled && s.inputDisabled]}
        value={value}
        accessibilityLabel={label}
        onChangeText={onChangeText}
        editable={!disabled}
        placeholder={placeholder}
        placeholderTextColor={color.inkFaint}
        keyboardType={keyboardType}
        multiline={multiline}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
      />
    </View>
  );
}
/** Segmented choice. Joined track when options fit, wrapping chips otherwise. */
export function Choice<T extends string>({
  label,
  value,
  choices,
  onChange,
  tone,
}: {
  label: string;
  value: T;
  choices: Array<[T, string]>;
  onChange: (value: T) => void;
  tone?: ModuleKind;
}) {
  const active = tone ? moduleTone[tone].hue : color.pine;
  const activeText = tone ? moduleTone[tone].text : color.pine;
  const joined = choices.length <= 4;
  return (
    <View style={s.choice}>
      <Text style={s.fieldLabel}>{label}</Text>
      <View style={joined ? s.track : s.chips}>
        {choices.map(([key, text]) => {
          const on = value === key;
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              key={key}
              onPress={() => onChange(key)}
              style={[
                joined ? s.trackItem : s.chip,
                on && (joined ? s.trackItemOn : { backgroundColor: active, borderColor: active }),
              ]}
            >
              <Text
                style={[
                  s.chipText,
                  on && (joined ? { color: activeText, fontWeight: "800" } : { color: color.onInk, fontWeight: "700" }),
                ]}
                numberOfLines={1}
              >
                {text}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export function SmallButton({
  icon,
  label,
  onPress,
  disabled = false,
  danger = false,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  const tone = danger ? color.danger : color.pine;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [s.smallButton, pressed && s.pressed, disabled && s.dim]}
      onPress={onPress}
      disabled={disabled}
    >
      <Ionicons name={icon} size={17} color={tone} />
      <Text style={[s.smallButtonText, { color: tone }]}>{label}</Text>
    </Pressable>
  );
}

export function PrimaryButton({
  icon,
  label,
  onPress,
  tone,
  disabled = false,
}: {
  icon?: IconName;
  label: string;
  onPress: () => void;
  tone?: string;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [s.primary, { backgroundColor: tone ?? color.pine }, pressed && s.pressed, disabled && s.dim]}
    >
      {icon && <Ionicons name={icon} size={19} color={color.onInk} />}
      <Text style={s.primaryText}>{label}</Text>
    </Pressable>
  );
}

export function CheckRow({ checked, label, onPress, disabled = false }: {
  checked: boolean;
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable accessibilityRole="checkbox" accessibilityState={{ checked }}
      accessibilityLabel={label} style={s.checkRow} onPress={onPress} disabled={disabled}>
      <View style={[s.checkBox, checked && s.checkBoxOn]}>
        {checked && <Ionicons name="checkmark" size={16} color={color.onInk} />}
      </View>
      <Text style={s.checkText}>{label}</Text>
    </Pressable>
  );
}

/** Group heading inside forms; optional hint sits beneath. */
export function Legend({ text, hint }: { text: string; hint?: string }) {
  return (
    <View style={s.legendBox}>
      <Text style={s.legend}>{text}</Text>
      {hint ? <Text style={s.helper}>{hint}</Text> : null}
    </View>
  );
}

export function Note({ icon = "information-circle-outline", text, tone = color.pine, tint = color.pineTint }: {
  icon?: IconName;
  text: string;
  tone?: string;
  tint?: string;
}) {
  return (
    <View style={[s.note, { backgroundColor: tint }]}>
      <Ionicons name={icon} size={18} color={tone} />
      <Text style={[s.noteText, { color: tone }]}>{text}</Text>
    </View>
  );
}
export function RecordThumb({
  uri,
  kind,
  size = 38,
}: {
  uri?: string;
  kind: ModuleKind;
  size?: number;
}) {
  const [failed, setFailed] = useState(false);
  const tone = moduleTone[kind];
  if (uri && !failed) {
    return (
      <Image
        source={{ uri }}
        style={{ width: size, height: size, borderRadius: radius.input, backgroundColor: tone.tint }}
        resizeMode="cover"
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: radius.input,
        backgroundColor: tone.tint,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Ionicons name={tone.icon} size={18} color={tone.text} />
    </View>
  );
}

export function MediaPreview({
  uri,
  label,
  onRemove,
}: {
  uri: string;
  label: string;
  onRemove: () => void;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <View style={s.media}>
      {!failed ? (
        <Image
          source={{ uri }}
          style={s.preview}
          resizeMode="cover"
          accessibilityLabel={label}
          onError={() => setFailed(true)}
        />
      ) : (
        <View style={[s.preview, s.previewFallback]} accessibilityLabel={label}>
          <Ionicons name="image-outline" size={32} color={color.mealText} />
          <Text style={s.mediaDetail}>照片已保存（当前环境暂无法渲染该格式预览）</Text>
        </View>
      )}
      <View style={s.mediaCaption}>
        <View style={{ flex: 1 }}>
          <Text style={s.mediaTitle}>{label}</Text>
          <Text style={s.mediaDetail}>原始照片已复制到本机</Text>
        </View>
        <Pressable
          accessibilityRole="button"
          onPress={onRemove}
          accessibilityLabel={`移除${label}`}
          style={s.mediaRemove}
        >
          <Ionicons name="close" size={18} color={color.ink} />
        </Pressable>
      </View>
    </View>
  );
}

export function DraftStatus({ saved, error }: { saved: boolean; error: string }) {
  return (
    <View style={s.draft}>
      <View style={[s.draftDot, { backgroundColor: error ? color.danger : saved ? color.pine : color.meal }]} />
      <Text style={[s.draftText, Boolean(error) && { color: color.danger }]}>
        {error || (saved ? "草稿已保存" : "草稿保存中")}
      </Text>
    </View>
  );
}

export function VideoAttachment({ uri }: { uri: string }) {
  const player = useVideoPlayer(uri);
  return (
    <VideoView
      player={player}
      style={s.video}
      nativeControls
      contentFit="contain"
      fullscreenOptions={{ enable: true }}
    />
  );
}

export function MarkdownText({ value }: { value: string }) {
  return (
    <View style={s.markdown}>
      {value
        .split("\n")
        .filter((line) => line.trim())
        .map((line, index) => (
          <Text
            key={index}
            selectable
            style={line.startsWith("#") ? s.markdownHeading : s.markdownLine}
          >
            {line.replace(/^#{1,6}\s*/, "").replace(/^[-*]\s+/, "· ")}
          </Text>
        ))}
    </View>
  );
}

export function SummaryVersions({ summaries }: { summaries: DailySummary[] }) {
  const [selected, setSelected] = useState<string>();
  return (
    <View>
      {summaries
        .slice()
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .map((item) => {
          const stale = item.status === "stale";
          return (
            <View key={item.id} style={s.version}>
              <Pressable
                accessibilityRole="button"
                style={s.versionHead}
                onPress={() => setSelected(selected === item.id ? undefined : item.id)}
              >
                <View style={[s.versionMark, { backgroundColor: stale ? color.lineStrong : item.source === "ai" ? color.pine : color.inkFaint }]} />
                <View style={{ flex: 1 }}>
                  <Text style={s.versionTitle}>
                    {item.source === "ai" ? "AI 总结" : "本地摘要"} · {item.date} ·{" "}
                    {stale ? "待更新" : "已保存"}
                  </Text>
                  <Text style={s.versionDetail}>
                    {localDateTime(item.createdAt)}
                    {item.source === "ai"
                      ? ` · ${item.sourceRecordIds?.length ?? 0} 条来源记录`
                      : ""}
                  </Text>
                </View>
                <Ionicons name={selected === item.id ? "chevron-up" : "chevron-down"} size={16} color={color.inkFaint} />
              </Pressable>
              {selected === item.id && (
                <View style={s.versionBody}>
                  <Text style={s.helper}>
                    {item.source === "ai"
                      ? `分析来源：${item.model ?? "未标注"}${stale ? "；记录或资料已修改，此版本仅供历史回看。" : ""}`
                      : "来源：本地记录与规则"}
                  </Text>
                  <MarkdownText value={item.markdown} />
                </View>
              )}
            </View>
          );
        })}
    </View>
  );
}
export const s = StyleSheet.create({
  pressed: { opacity: 0.72 },
  dim: { opacity: 0.45 },
  banner: {
    marginHorizontal: space.lg, marginTop: space.sm, paddingVertical: 10, paddingHorizontal: space.md,
    flexDirection: "row", alignItems: "center", gap: space.sm,
    backgroundColor: color.pineTint, borderRadius: radius.input,
  },
  bannerDanger: { backgroundColor: color.dangerTint },
  bannerText: { flex: 1, color: color.pine, fontSize: 13, lineHeight: 19 },
  bannerAction: { fontSize: 13, fontWeight: "800" },
  sheet: { flex: 1, backgroundColor: color.paper },
  sheetEdge: { height: 4 },
  sheetHeader: {
    minHeight: 60, paddingHorizontal: space.sm, flexDirection: "row", alignItems: "center", gap: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth, borderColor: color.lineStrong, backgroundColor: color.paper,
  },
  sheetIcon: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  sheetTitle: { ...type.title, flex: 1 },
  saveButton: {
    minHeight: 38, paddingHorizontal: 18, marginRight: space.sm, borderRadius: radius.pill,
    backgroundColor: color.pine, alignItems: "center", justifyContent: "center",
  },
  saveButtonOff: { backgroundColor: color.sunken },
  saveText: { color: color.onInk, fontSize: 14, fontWeight: "800" },
  saveTextOff: { color: color.inkFaint },
  form: {
    width: "100%", maxWidth: 680, alignSelf: "center",
    paddingHorizontal: space.lg + 4, paddingTop: space.lg, paddingBottom: space.xxxl,
  },
  field: { flex: 1, marginBottom: space.lg },
  fieldLabel: { ...type.label, marginBottom: space.sm },
  input: {
    minHeight: 48, paddingHorizontal: 14, paddingVertical: 12,
    backgroundColor: color.surface, borderWidth: 1, borderColor: color.line, borderRadius: radius.input,
    fontSize: 16, color: color.ink,
  },
  inputFocused: { borderColor: color.pine, borderWidth: 1.5 },
  inputDisabled: { backgroundColor: color.paper, color: color.inkFaint },
  multiline: { minHeight: 88, textAlignVertical: "top" },
  choice: { marginBottom: space.lg },
  track: {
    flexDirection: "row", backgroundColor: color.sunken, borderRadius: radius.input, padding: 3,
  },
  trackItem: {
    flex: 1, minHeight: 40, borderRadius: radius.input - 3, alignItems: "center", justifyContent: "center", paddingHorizontal: 6,
  },
  trackItemOn: {
    backgroundColor: color.raised,
    ...Platform.select({
      web: { boxShadow: "0 1px 2px rgba(23,32,43,0.14)" } as object,
      default: { elevation: 1, shadowColor: color.ink, shadowOpacity: 0.12, shadowRadius: 2, shadowOffset: { width: 0, height: 1 } },
    }),
  },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  chip: {
    minHeight: 40, paddingHorizontal: 14, borderRadius: radius.pill, justifyContent: "center",
    backgroundColor: color.surface, borderWidth: 1, borderColor: color.line,
  },
  chipText: { color: color.inkSoft, fontSize: 14, fontWeight: "600" },
  smallButton: {
    minHeight: 44, paddingHorizontal: 14, borderRadius: radius.pill,
    backgroundColor: color.surface, borderWidth: 1, borderColor: color.line,
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, marginBottom: space.md,
  },
  smallButtonText: { fontSize: 14, fontWeight: "700" },
  primary: {
    minHeight: 54, borderRadius: radius.block, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.sm, paddingHorizontal: space.lg,
  },
  primaryText: { color: color.onInk, fontSize: 16, fontWeight: "800" },
  checkRow: { flexDirection: "row", alignItems: "center", paddingVertical: 10, gap: space.md, minHeight: 44 },
  checkBox: {
    width: 22, height: 22, borderRadius: 6, borderWidth: 1.5, borderColor: color.lineStrong,
    alignItems: "center", justifyContent: "center", backgroundColor: color.surface,
  },
  checkBoxOn: { backgroundColor: color.pine, borderColor: color.pine },
  checkText: { flex: 1, ...type.body },
  legendBox: { marginTop: space.md, marginBottom: space.md },
  legend: { ...type.heading },
  helper: { ...type.small, marginTop: 2, marginBottom: space.sm },
  note: { flexDirection: "row", gap: space.sm, padding: space.md, borderRadius: radius.input, marginBottom: space.lg },
  noteText: { flex: 1, fontSize: 13, lineHeight: 19 },
  media: { marginBottom: space.md, borderRadius: radius.block, overflow: "hidden", backgroundColor: color.surface, borderWidth: 1, borderColor: color.line },
  preview: { width: "100%", aspectRatio: 4 / 3, maxHeight: 360 },
  previewFallback: { backgroundColor: color.mealTint, alignItems: "center", justifyContent: "center", gap: space.xs, padding: space.lg },
  mediaCaption: {
    flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.md, paddingVertical: 10,
  },
  mediaTitle: { color: color.ink, fontSize: 14, fontWeight: "700" },
  mediaDetail: { color: color.inkSoft, fontSize: 12, marginTop: 2 },
  mediaRemove: {
    width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center", backgroundColor: color.raised,
  },
  draft: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: space.md },
  draftDot: { width: 6, height: 6, borderRadius: 3 },
  draftText: { color: color.inkFaint, fontSize: 12 },
  video: { width: "100%", aspectRatio: 16 / 9, marginTop: space.md, borderRadius: radius.block, backgroundColor: color.video },
  markdown: { paddingVertical: space.sm },
  markdownHeading: { ...type.heading, fontSize: 15, marginTop: space.md, marginBottom: 6 },
  markdownLine: { ...type.bodySoft, marginBottom: 4 },
  version: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: color.lineStrong },
  versionHead: { flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: space.md, minHeight: 52 },
  versionMark: { width: 4, alignSelf: "stretch", borderRadius: 2 },
  versionTitle: { ...type.label },
  versionDetail: { ...type.small, marginTop: 2 },
  versionBody: { paddingLeft: space.lg, paddingBottom: space.md },
});
