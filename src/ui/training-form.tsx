import React, { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import * as ImagePicker from "expo-image-picker";
import { Ionicons } from "@expo/vector-icons";
import type { ExerciseSet, ExerciseTemplate, TrainingRecord } from "../types";
import { persistMedia } from "../storage";
import { trainingAdvice } from "../domain";
import { type FormSession, useFormDraft, useFormSession } from "./useFormDraft";
import { Banner, Choice, DraftStatus, Field, Note, Sheet, SmallButton, VideoAttachment, useBaseStyles } from "./components";
import { errorText, localDateTime, notify, parseDateTime } from "./format";
import { radius, space, type ThemeTokens } from "./theme";
import { useTheme, useThemedStyles } from "./theme-provider";
import type { DraftKey, TrainingDraft } from "./app-types";

type TrainingState = {
  occurredAt: string;
  mode: "strength" | "cardio";
  exercise: string;
  duration: string;
  sets: Array<{
    reps: string;
    weight: string;
    unit: "kg" | "lb";
    warmup: boolean;
  }>;
  note: string;
  pain: TrainingRecord["pain"];
  controlled: TrainingRecord["controlled"];
  rir: TrainingRecord["rir"];
  targetSets: string;
  targetMin: string;
  targetMax: string;
  increment: string;
  basis: "total" | "per-hand" | "bodyweight";
  // An empty string persists an explicit removal when a draft is serialized.
  videoUri: string;
};
const builtInExerciseNames = ["深蹲", "卧推", "硬拉", "肩推", "划船", "引体向上", "弓步蹲", "腿举"];
const trainingState = (initial?: TrainingRecord): TrainingState => ({
  occurredAt:
    localDateTime(initial?.occurredAt) ||
    localDateTime(new Date().toISOString()),
  mode: initial?.mode ?? "strength",
  exercise: initial?.exercise ?? "",
  duration:
    initial?.durationMinutes === undefined
      ? ""
      : String(initial.durationMinutes),
  sets: initial?.sets?.length
    ? initial.sets.map((set) => ({
        reps: String(set.reps),
        weight: String(set.weight),
        unit: set.unit,
        warmup: Boolean(set.isWarmup),
      }))
    : [{ reps: "", weight: "", unit: "kg", warmup: false }],
  note: initial?.note ?? "",
  pain: initial?.pain ?? "unknown",
  controlled: initial?.controlled ?? "unknown",
  rir: initial?.rir ?? "unknown",
  targetSets:
    initial?.targetSets === undefined ? "" : String(initial.targetSets),
  targetMin: initial?.targetMin === undefined ? "" : String(initial.targetMin),
  targetMax: initial?.targetMax === undefined ? "" : String(initial.targetMax),
  increment: initial?.increment === undefined ? "" : String(initial.increment),
  basis: initial?.weightBasis ?? "total",
  videoUri: initial?.videoUri ?? "",
});
export function TrainingForm({
  initial,
  draftKey,
  session,
  history,
  exerciseTemplates,
  onClose,
  onSave,
  onSaveTemplate,
}: {
  initial?: TrainingRecord;
  draftKey: DraftKey;
  session: FormSession;
  history: TrainingRecord[];
  exerciseTemplates: ExerciseTemplate[];
  onClose: () => void;
  onSave: (draft: TrainingDraft) => Promise<void>;
  onSaveTemplate: (template: Omit<ExerciseTemplate, "id">) => Promise<void>;
}) {
  const { color, type, scheme } = useTheme();
  const base = useBaseStyles();
  const st = useThemedStyles(createStyles);
  const formDraft = useFormDraft(draftKey, trainingState(initial), session);
  const { form, setForm } = formDraft;
  const [error, setError] = useState("");
  const [templateMenuOpen, setTemplateMenuOpen] = useState(false);
  const [customExerciseActive, setCustomExerciseActive] = useState(() => Boolean(
    initial?.exercise && !builtInExerciseNames.includes(initial.exercise)
      && !exerciseTemplates.some((template) => template.name === initial.exercise),
  ));
  const [templateMessage, setTemplateMessage] = useState("");
  const lifecycle = useFormSession(session, {
    onClose,
    beforeClose: formDraft.persist,
    onError: (e) => setError(errorText(e)),
  });
  const update = (patch: Partial<TrainingState>) => {
    if (lifecycle.isIdle()) setForm((current) => ({ ...current, ...patch }));
  };
  const templateNames = [...new Set([...exerciseTemplates.map((item) => item.name), ...builtInExerciseNames])];
  const showCustomExercise = customExerciseActive || Boolean(
    form.exercise && !templateNames.includes(form.exercise),
  );
  const selectExerciseTemplate = (name: string) => {
    const saved = exerciseTemplates.find((template) => template.name === name);
    const setCount = saved?.setCount ?? 3;
    update({
      exercise: name,
      sets: Array.from({ length: setCount }, () => ({ reps: "", weight: "", unit: saved?.weightUnit ?? form.sets[0]?.unit ?? "kg", warmup: false })),
      basis: saved?.weightBasis ?? form.basis,
      targetSets: saved?.targetSets === undefined ? "" : String(saved.targetSets),
      targetMin: saved?.targetMin === undefined ? "" : String(saved.targetMin),
      targetMax: saved?.targetMax === undefined ? "" : String(saved.targetMax),
      increment: saved?.increment === undefined ? "" : String(saved.increment),
    });
    setCustomExerciseActive(false);
    setTemplateMenuOpen(false);
    setTemplateMessage("");
  };
  const saveTemplate = async () => {
    const name = form.exercise.trim();
    if (!name || !lifecycle.beginMedia()) return;
    setError("");
    setTemplateMessage("");
    try {
      const targetValues = [form.targetSets, form.targetMin, form.targetMax, form.increment];
      const hasTargets = targetValues.every((value) => value.trim());
      await onSaveTemplate({
        name,
        setCount: Math.max(1, form.sets.length),
        weightUnit: form.sets[0]?.unit ?? "kg",
        weightBasis: form.basis,
        ...(hasTargets ? {
          targetSets: Number(form.targetSets),
          targetMin: Number(form.targetMin),
          targetMax: Number(form.targetMax),
          increment: Number(form.increment),
        } : {}),
      });
      if (lifecycle.isActive()) setTemplateMessage(`已保存“${name}”模板`);
    } catch (e) {
      if (lifecycle.isActive()) setError(errorText(e));
    } finally {
      lifecycle.endOperation();
    }
  };
  const updateSet = (
    index: number,
    patch: Partial<TrainingState["sets"][number]>,
  ) => {
    if (!lifecycle.isIdle()) return;
    setForm((current) => ({
      ...current,
      sets: current.sets.map((set, item) =>
        item === index ? { ...set, ...patch } : set,
      ),
    }));
  };
  const chooseVideo = async () => {
    if (!lifecycle.beginMedia()) return;
    setError("");
    try {
      const permission =
        await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!lifecycle.isActive()) return;
      if (!permission.granted)
        throw new Error("没有媒体库权限，也可以跳过视频附件。");
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Videos,
        allowsEditing: false,
      });
      if (!lifecycle.isActive()) return;
      if (!result.canceled && result.assets[0]) {
        const uri = await persistMedia(result.assets[0].uri, "video");
        if (!lifecycle.isActive()) return;
        setForm((current) => ({ ...current, videoUri: uri }));
        await formDraft.persist();
      }
    } catch (e) {
      if (lifecycle.isActive()) setError(errorText(e));
    } finally {
      lifecycle.endOperation();
    }
  };
  const submit = async () => {
    if (!formDraft.loaded || !lifecycle.beginSave()) return;
    setError("");
    try {
      const occurredAt = parseDateTime(form.occurredAt);
      if (!form.exercise.trim()) throw new Error("请填写运动类型或动作名称。");
      let draft: TrainingDraft;
      if (form.mode === "cardio") {
        const duration = Number(form.duration);
        if (!Number.isFinite(duration) || duration <= 0)
          throw new Error("有氧或其他运动需要填写大于 0 的时长。");
        draft = {
          occurredAt,
          mode: "cardio",
          exercise: form.exercise.trim(),
          durationMinutes: duration,
          sets: [],
          note: form.note.trim(),
          pain: "unknown",
          controlled: "unknown",
          rir: "unknown",
          videoUri: form.videoUri || undefined,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        };
      } else {
        const sets: ExerciseSet[] = form.sets.map((set, index) => {
          if (
            !set.reps.trim() ||
            (form.basis !== "bodyweight" && !set.weight.trim())
          )
            throw new Error(`请填写第 ${index + 1} 组的实际次数和重量。`);
          const reps = Number(set.reps);
          const weight = form.basis === "bodyweight" ? 0 : Number(set.weight);
          if (
            !Number.isFinite(reps) ||
            reps < 1 ||
            !Number.isInteger(reps) ||
            !Number.isFinite(weight) ||
            weight < 0
          )
            throw new Error(`第 ${index + 1} 组的次数和重量需要填写有效数字。`);
          return { reps, weight, unit: set.unit, isWarmup: set.warmup };
        });
        if (!sets.some((set) => !set.isWarmup))
          throw new Error("请至少填写一组工作组。");
        const values = [
          form.targetSets,
          form.targetMin,
          form.targetMax,
          form.increment,
        ];
        const has = values.some((value) => value.trim());
        if (has && values.some((value) => !value.trim()))
          throw new Error("目标组数、次数区间和最小加重请完整填写。");
        const nums = has ? values.map(Number) : [];
        if (nums.some((value) => !Number.isFinite(value) || value <= 0))
          throw new Error("训练目标必须是大于 0 的数字。");
        if (nums.slice(0, 3).some((value) => !Number.isInteger(value)))
          throw new Error("目标组数和目标次数需要是整数。");
        if (has && nums[1] > nums[2])
          throw new Error("目标次数下限不能大于上限。");
        draft = {
          occurredAt,
          mode: "strength",
          exercise: form.exercise.trim(),
          sets,
          note: form.note.trim(),
          pain: form.pain,
          controlled: form.controlled,
          rir: form.rir,
          targetSets: has ? nums[0] : undefined,
          targetMin: has ? nums[1] : undefined,
          targetMax: has ? nums[2] : undefined,
          increment: has ? nums[3] : undefined,
          weightBasis: form.basis,
          videoUri: form.videoUri || undefined,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        };
      }
      await formDraft.persist();
      if (!lifecycle.isActive()) return;
      await onSave(draft);
      if (!lifecycle.isActive()) return;
      await formDraft
        .finish()
        .catch((e) => {
          if (lifecycle.isActive())
            notify("记录已保存", `草稿清理失败：${errorText(e)}`);
        });
      if (lifecycle.isActive()) onClose();
    } catch (e) {
      if (lifecycle.isActive()) setError(errorText(e));
    } finally {
      lifecycle.endOperation();
    }
  };
  const advice =
    initial && form.mode === "strength" ? trainingAdvice(initial, history) : "";
  return (
    <Sheet
      title={initial ? "编辑训练" : "记录训练"}
      tone="training"
      onClose={lifecycle.requestClose}
      onSave={() => {
        void submit();
      }}
      saving={lifecycle.saving}
      closing={lifecycle.closing}
      disabled={lifecycle.busy || !formDraft.loaded}
    >
      <>
        <DraftStatus saved={formDraft.saved} error={formDraft.draftError} />
        {Boolean(error) && (
          <Banner text={error} danger onClose={() => setError("")} />
        )}
        <Choice
          label="运动类型"
          tone="training"
          value={form.mode}
          choices={[
            ["strength", "力量"],
            ["cardio", "有氧 / 其他"],
          ]}
          onChange={(value) => update({ mode: value })}
        />
        {form.mode === "cardio" && (
          <Field
            label="运动类型"
            value={form.exercise}
            onChangeText={(value) => update({ exercise: value })}
            placeholder="例如：快走"
          />
        )}
        <Field
          label="发生时间（YYYY-MM-DD HH:mm）"
          value={form.occurredAt}
          onChangeText={(value) => update({ occurredAt: value })}
          placeholder="2026-10-10 18:30"
        />
        {form.mode === "cardio" ? (
          <>
            <Field
              label="时长（分钟）"
              value={form.duration}
              onChangeText={(value) => update({ duration: value })}
              keyboardType="numeric"
            />
            <Field
              label="备注（可选）"
              value={form.note}
              onChangeText={(value) => update({ note: value })}
              placeholder="例如：轻松强度"
              multiline
            />
          </>
        ) : (
          <>
            <View style={st.ledger}>
              <View style={st.ledgerHead}>
                <View style={st.ledgerHeadingCopy}>
                  <Text style={st.ledgerTitle}>本次训练完成</Text>
                  <Text style={st.ledgerFormula}>次数 × 重量 × 组数</Text>
                </View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="选择动作模板"
                  accessibilityState={{ expanded: templateMenuOpen }}
                  disabled={lifecycle.busy || lifecycle.saving || lifecycle.closing}
                  onPress={() => setTemplateMenuOpen((open) => !open)}
                  style={({ pressed }) => [st.templateSelect, pressed && base.pressed]}
                >
                  <View style={st.templateSelectCopy}>
                    <Text style={st.templateSelectLabel}>动作名</Text>
                    <Text style={st.templateSelectValue} numberOfLines={1}>{form.exercise || "选择模板"}</Text>
                  </View>
                  <Ionicons name={templateMenuOpen ? "chevron-up" : "chevron-down"} size={16} color={color.trainingText} />
                </Pressable>
              </View>
              {templateMenuOpen && (
                <View style={st.templateMenu}>
                  <Text style={st.templateMenuLabel}>选择动作模板</Text>
                  <View style={st.templateOptions}>
                    {templateNames.map((name) => (
                      <Pressable
                        key={name}
                        accessibilityRole="button"
                        accessibilityState={{ selected: form.exercise === name }}
                        onPress={() => selectExerciseTemplate(name)}
                        style={[st.templateOption, form.exercise === name && st.templateOptionOn]}
                      >
                        <Text style={[st.templateOptionText, form.exercise === name && st.templateOptionTextOn]} numberOfLines={1}>{name}</Text>
                      </Pressable>
                    ))}
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => {
                        update({ exercise: "" });
                        setCustomExerciseActive(true);
                        setTemplateMenuOpen(false);
                        setTemplateMessage("");
                      }}
                      style={st.templateOption}
                    >
                      <Text style={st.templateOptionText}>自定义动作</Text>
                    </Pressable>
                  </View>
                </View>
              )}
              {showCustomExercise && (
                <Field
                  label="自定义动作名称"
                  value={form.exercise}
                  onChangeText={(value) => update({ exercise: value })}
                  placeholder="输入动作名称"
                />
              )}
              <View style={st.ledgerCols}>
                <Text style={st.ledgerColText}>次数</Text>
                <Text style={st.ledgerColText}>{form.basis === "bodyweight" ? "自重" : `重量 ${form.sets[0]?.unit ?? "kg"}`}</Text>
              </View>
              {form.sets.map((set, index) => (
                <View key={`set-${index}`} style={[st.setRow, set.warmup && st.setRowWarm]}>
                  <Text style={[st.setNumber, set.warmup && st.setNumberWarm]}>{set.warmup ? "热" : index + 1}</Text>
                  <TextInput
                    style={st.setInput}
                    value={set.reps}
                    accessibilityLabel={`第${index + 1}组次数`}
                    onChangeText={(value) => updateSet(index, { reps: value })}
                    placeholder="次数"
                    placeholderTextColor={color.inkFaint}
                    keyboardAppearance={scheme}
                    keyboardType="numeric"
                  />
                  <Text style={st.times}>×</Text>
                  <TextInput
                    style={[st.setInput, form.basis === "bodyweight" && st.setInputOff]}
                    value={set.weight}
                    accessibilityLabel={`第${index + 1}组重量`}
                    editable={form.basis !== "bodyweight"}
                    onChangeText={(value) => updateSet(index, { weight: value })}
                    placeholder={form.basis === "bodyweight" ? "自重" : `重量 ${set.unit}`}
                    placeholderTextColor={color.inkFaint}
                    keyboardAppearance={scheme}
                    keyboardType="numeric"
                  />
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ selected: set.warmup }}
                    onPress={() => updateSet(index, { warmup: !set.warmup })}
                    style={[st.warmup, set.warmup && st.warmupOn]}
                  >
                    <Text style={[st.warmupText, set.warmup && st.warmupTextOn]}>热身</Text>
                  </Pressable>
                  {form.sets.length > 1 && (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`删除第${index + 1}组`}
                      style={st.removeSet}
                      onPress={() =>
                        update({
                          sets: form.sets.filter((_, item) => item !== index),
                        })
                      }
                    >
                      <Ionicons name="remove-circle-outline" size={22} color={color.inkFaint} />
                    </Pressable>
                  )}
                </View>
              ))}
              <Pressable
                accessibilityRole="button"
                style={({ pressed }) => [st.addSet, pressed && base.pressed]}
                onPress={() =>
                  update({
                    sets: [
                      ...form.sets,
                      { reps: "", weight: form.sets.at(-1)?.weight ?? "", unit: form.sets[0]?.unit ?? "kg", warmup: false },
                    ],
                  })
                }
              >
                <Ionicons name="add" size={18} color={color.trainingText} />
                <Text style={st.addSetText}>添加一组</Text>
              </Pressable>
            </View>
            <View style={st.two}>
              <View style={{ flex: 1 }}>
                <Choice
                  label="重量单位"
                  tone="training"
                  value={form.sets[0]?.unit ?? "kg"}
                  choices={[
                    ["kg", "公斤"],
                    ["lb", "磅"],
                  ]}
                  onChange={(value) =>
                    update({
                      sets: form.sets.map((set) => ({ ...set, unit: value })),
                    })
                  }
                />
              </View>
            </View>
            <Field
              label="备注（可选）"
              value={form.note}
              onChangeText={(value) => update({ note: value })}
              placeholder="记录实际感受"
              multiline
            />
            {Boolean(advice) && (
              <Note icon="trending-up-outline" text={advice} tone={color.trainingText} tint={color.trainingTint} />
            )}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="保存为模板"
              disabled={!form.exercise.trim() || lifecycle.busy || lifecycle.saving || lifecycle.closing}
              onPress={() => { void saveTemplate(); }}
              style={({ pressed }) => [st.saveTemplate, (!form.exercise.trim() || lifecycle.busy) && st.saveTemplateOff, pressed && base.pressed]}
            >
              <Ionicons name="bookmark-outline" size={17} color={color.trainingText} />
              <Text style={st.saveTemplateText}>保存为模板</Text>
            </Pressable>
            {Boolean(templateMessage) && <Text style={st.templateMessage}>{templateMessage}</Text>}
          </>
        )}
        <View style={st.attachment}>
          <View style={st.attachIcon}>
            <Ionicons name="videocam-outline" size={19} color={color.trainingText} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={type.label}>
              {form.videoUri ? "已添加训练视频" : "训练视频（可选）"}
            </Text>
            <Text style={type.small}>
              {form.videoUri ? "视频保存在本机" : "不会上传进行动作分析"}
            </Text>
          </View>
          {form.videoUri ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="移除训练视频"
              onPress={() => update({ videoUri: "" })}
              style={st.removeSet}
            >
              <Ionicons name="close-circle-outline" size={22} color={color.danger} />
            </Pressable>
          ) : (
            <Pressable accessibilityRole="button" onPress={chooseVideo} style={st.attachAdd}>
              <Text style={st.attachAddText}>添加</Text>
            </Pressable>
          )}
        </View>
        {Boolean(form.videoUri) && <VideoAttachment uri={form.videoUri} />}
      </>
    </Sheet>
  );
}

const createStyles = ({ color, type }: ThemeTokens) => StyleSheet.create({
  two: { flexDirection: "row", gap: space.md },
  ledger: {
    backgroundColor: color.surface, borderRadius: radius.block, padding: space.md, marginBottom: space.lg,
    borderWidth: 1, borderColor: color.line,
  },
  ledgerHead: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: space.sm, marginBottom: space.sm, paddingHorizontal: 4 },
  ledgerHeadingCopy: { flex: 1, minWidth: 120 },
  ledgerTitle: { ...type.heading },
  ledgerFormula: { fontSize: 11, lineHeight: 16, color: color.inkFaint, marginTop: 2, ...type.mono },
  templateSelect: { maxWidth: "55%", minWidth: 112, minHeight: 44, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 6, paddingHorizontal: 10, borderRadius: radius.input, backgroundColor: color.trainingTint },
  templateSelectCopy: { minWidth: 0, flex: 1 },
  templateSelectLabel: { fontSize: 10, lineHeight: 13, color: color.trainingText, fontWeight: "700" },
  templateSelectValue: { fontSize: 13, lineHeight: 18, color: color.trainingText, fontWeight: "800" },
  templateMenu: { padding: space.sm, marginBottom: space.sm, borderRadius: radius.input, backgroundColor: color.paper, borderWidth: 1, borderColor: color.line },
  templateMenuLabel: { fontSize: 12, color: color.inkFaint, fontWeight: "700", marginBottom: 8 },
  templateOptions: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  templateOption: { maxWidth: "100%", minHeight: 36, justifyContent: "center", paddingHorizontal: 10, borderRadius: radius.pill, borderWidth: 1, borderColor: color.line, backgroundColor: color.surface },
  templateOptionOn: { backgroundColor: color.trainingTint, borderColor: color.training },
  templateOptionText: { fontSize: 12, color: color.inkSoft, fontWeight: "600" },
  templateOptionTextOn: { color: color.trainingText, fontWeight: "800" },
  ledgerCols: { flexDirection: "row", justifyContent: "space-around", marginBottom: 2, paddingLeft: 36, paddingRight: 72 },
  ledgerColText: { flex: 1, textAlign: "center", ...type.small, color: color.inkFaint },
  setRow: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 4 },
  setRowWarm: { opacity: 0.8 },
  setNumber: {
    width: 30, height: 30, borderRadius: 15, backgroundColor: color.training, color: color.onTraining,
    textAlign: "center", lineHeight: 30, fontWeight: "800", fontSize: 13, overflow: "hidden",
  },
  setNumberWarm: { backgroundColor: color.trainingTint, color: color.trainingText },
  setInput: {
    flex: 1, minWidth: 0, minHeight: 44, borderRadius: 10, backgroundColor: color.sunken,
    paddingHorizontal: 12, fontSize: 17, fontWeight: "700", color: color.ink, textAlign: "center", ...type.mono,
  },
  setInputOff: { color: color.inkFaint },
  times: { color: color.inkFaint, fontSize: 14 },
  warmup: {
    minHeight: 36, justifyContent: "center", paddingHorizontal: 10, borderRadius: radius.pill,
    borderWidth: 1, borderColor: color.line,
  },
  warmupOn: { backgroundColor: color.trainingTint, borderColor: color.trainingTint },
  warmupText: { color: color.inkSoft, fontSize: 12 },
  warmupTextOn: { color: color.trainingText, fontWeight: "800" },
  removeSet: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  addSet: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 4, minHeight: 44, marginTop: space.sm,
    borderRadius: radius.input, borderWidth: 1, borderStyle: "dashed", borderColor: color.training,
  },
  addSetText: { color: color.trainingText, fontSize: 14, fontWeight: "800" },
  block: {
    paddingTop: space.sm, marginBottom: space.sm, borderTopWidth: 1, borderColor: color.line,
  },
  saveTemplate: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, minHeight: 44, marginBottom: space.md, borderRadius: radius.input, borderWidth: 1, borderColor: color.training, backgroundColor: color.trainingTint },
  saveTemplateOff: { opacity: 0.45 },
  saveTemplateText: { fontSize: 14, fontWeight: "800", color: color.trainingText },
  templateMessage: { fontSize: 12, lineHeight: 17, color: color.trainingText, textAlign: "center", marginBottom: space.sm },
  attachment: {
    flexDirection: "row", alignItems: "center", gap: space.md, padding: space.md, marginTop: space.sm,
    backgroundColor: color.surface, borderRadius: radius.block, borderWidth: 1, borderColor: color.line,
  },
  attachIcon: {
    width: 40, height: 40, borderRadius: 20, backgroundColor: color.trainingTint, alignItems: "center", justifyContent: "center",
  },
  attachAdd: { minHeight: 36, paddingHorizontal: 16, borderRadius: radius.pill, backgroundColor: color.training, justifyContent: "center" },
  attachAddText: { color: color.onTraining, fontWeight: "800", fontSize: 13 },
});
