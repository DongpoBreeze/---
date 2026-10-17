import React, { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import * as ImagePicker from "expo-image-picker";
import { Ionicons } from "@expo/vector-icons";
import type { ExerciseSet, TrainingRecord } from "../types";
import { persistMedia } from "../storage";
import { trainingAdvice } from "../domain";
import { type FormSession, useFormDraft, useFormSession } from "./useFormDraft";
import { Banner, Choice, DraftStatus, Field, Legend, Note, Sheet, SmallButton, VideoAttachment, s as base } from "./components";
import { errorText, localDateTime, notify, parseDateTime } from "./format";
import { color, radius, space, type } from "./theme";
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
  videoUri?: string;
};
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
  videoUri: initial?.videoUri,
});
export function TrainingForm({
  initial,
  draftKey,
  session,
  history,
  onClose,
  onSave,
}: {
  initial?: TrainingRecord;
  draftKey: DraftKey;
  session: FormSession;
  history: TrainingRecord[];
  onClose: () => void;
  onSave: (draft: TrainingDraft) => Promise<void>;
}) {
  const formDraft = useFormDraft(draftKey, trainingState(initial), session);
  const { form, setForm } = formDraft;
  const [error, setError] = useState("");
  const lifecycle = useFormSession(session, {
    onClose,
    beforeClose: formDraft.persist,
    onError: (e) => setError(errorText(e)),
  });
  const update = (patch: Partial<TrainingState>) => {
    if (lifecycle.isIdle()) setForm((current) => ({ ...current, ...patch }));
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
          videoUri: form.videoUri,
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
          videoUri: form.videoUri,
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
        <Field
          label={form.mode === "cardio" ? "运动类型" : "动作名称"}
          value={form.exercise}
          onChangeText={(value) => update({ exercise: value })}
          placeholder={form.mode === "cardio" ? "例如：快走" : "例如：深蹲"}
        />
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
                <Text style={st.ledgerTitle}>每组实际完成</Text>
                <Text style={st.ledgerCols}>次数　　重量 {form.basis === "bodyweight" ? "" : form.sets[0]?.unit ?? "kg"}</Text>
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
            <Choice
              label="重量口径"
              tone="training"
              value={form.basis}
              choices={[
                ["total", "总重量"],
                ["per-hand", "每只哑铃"],
                ["bodyweight", "自重"],
              ]}
              onChange={(value) => update({ basis: value })}
            />
            <View style={st.block}>
              <Legend text="进阶目标（可选）" hint="四项填齐后，才会和上一次同动作记录比较。" />
              <View style={st.two}>
                <Field
                  label="目标组数"
                  value={form.targetSets}
                  onChangeText={(value) => update({ targetSets: value })}
                  keyboardType="numeric"
                />
                <Field
                  label="最小加重"
                  value={form.increment}
                  onChangeText={(value) => update({ increment: value })}
                  keyboardType="numeric"
                />
              </View>
              <View style={st.two}>
                <Field
                  label="最低次数"
                  value={form.targetMin}
                  onChangeText={(value) => update({ targetMin: value })}
                  keyboardType="numeric"
                />
                <Field
                  label="最高次数"
                  value={form.targetMax}
                  onChangeText={(value) => update({ targetMax: value })}
                  keyboardType="numeric"
                />
              </View>
            </View>
            <View style={st.block}>
              <Legend text="本次感受" hint="跳过也能保存，但不会生成加重建议。" />
              <Choice
                label="疼痛"
                tone="training"
                value={form.pain}
                choices={[
                  ["yes", "有"],
                  ["no", "无"],
                  ["unknown", "未填写"],
                ]}
                onChange={(value) => update({ pain: value })}
              />
              <Choice
                label="动作可控"
                tone="training"
                value={form.controlled}
                choices={[
                  ["yes", "是"],
                  ["no", "否"],
                  ["unknown", "未填写"],
                ]}
                onChange={(value) => update({ controlled: value })}
              />
              <Choice
                label="最少剩余次数"
                tone="training"
                value={form.rir}
                choices={[
                  ["0", "0"],
                  ["1", "1"],
                  ["2", "2"],
                  ["3", "3"],
                  ["4+", "4+"],
                  ["unknown", "未填写"],
                ]}
                onChange={(value) => update({ rir: value })}
              />
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
              onPress={() => update({ videoUri: undefined })}
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
        {Boolean(form.videoUri) && <VideoAttachment uri={form.videoUri!} />}
      </>
    </Sheet>
  );
}

const st = StyleSheet.create({
  two: { flexDirection: "row", gap: space.md },
  ledger: {
    backgroundColor: color.surface, borderRadius: radius.block, padding: space.md, marginBottom: space.lg,
    borderWidth: StyleSheet.hairlineWidth, borderColor: color.lineStrong,
  },
  ledgerHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", marginBottom: space.sm, paddingHorizontal: 4 },
  ledgerTitle: { ...type.heading },
  ledgerCols: { ...type.small, color: color.inkFaint },
  setRow: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 4 },
  setRowWarm: { opacity: 0.8 },
  setNumber: {
    width: 30, height: 30, borderRadius: 15, backgroundColor: color.training, color: color.onInk,
    textAlign: "center", lineHeight: 30, fontWeight: "800", fontSize: 13, overflow: "hidden",
  },
  setNumberWarm: { backgroundColor: color.trainingTint, color: color.trainingText },
  setInput: {
    flex: 1, minWidth: 0, minHeight: 44, borderRadius: radius.input, backgroundColor: color.paper,
    paddingHorizontal: 12, fontSize: 17, fontWeight: "700", color: color.ink, textAlign: "center", ...type.numeric,
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
    paddingTop: space.sm, marginBottom: space.sm, borderTopWidth: StyleSheet.hairlineWidth, borderColor: color.lineStrong,
  },
  attachment: {
    flexDirection: "row", alignItems: "center", gap: space.md, padding: space.md, marginTop: space.sm,
    backgroundColor: color.surface, borderRadius: radius.block,
  },
  attachIcon: {
    width: 40, height: 40, borderRadius: 20, backgroundColor: color.trainingTint, alignItems: "center", justifyContent: "center",
  },
  attachAdd: { minHeight: 36, paddingHorizontal: 16, borderRadius: radius.pill, backgroundColor: color.training, justifyContent: "center" },
  attachAddText: { color: color.onInk, fontWeight: "800", fontSize: 13 },
});
