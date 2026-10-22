import React, { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import * as ImagePicker from "expo-image-picker";
import { Ionicons } from "@expo/vector-icons";
import type { ExerciseSet, ExerciseTemplate, TrainingExercise, TrainingRecord, WorkoutTemplate } from "../types";
import { persistMedia } from "../storage";
import { trainingAdvice, trainingExercises } from "../domain";
import { compatibleDraft, type FormSession, useFormDraft, useFormSession } from "./useFormDraft";
import { Banner, Choice, DraftStatus, Field, Note, Sheet, VideoAttachment, useBaseStyles } from "./components";
import { errorText, localDateTime, notify, parseDateTime } from "./format";
import { radius, space, type ThemeTokens } from "./theme";
import { useTheme, useThemedStyles } from "./theme-provider";
import { animateLayout } from "./motion";
import { DateTimeField } from "./date-time-field";
import type { DraftKey, TrainingDraft } from "./app-types";

// `id` is a render key only; it is never copied into the saved record.
type SetState = { id: string; reps: string; weight: string; unit: "kg" | "lb"; warmup: boolean };
type BlockState = { id: string; name: string; sets: SetState[] };
type TrainingState = {
  occurredAt: string;
  mode: "strength" | "cardio";
  // Cardio: the activity name. Strength: the optional session name (e.g. 推日).
  exercise: string;
  duration: string;
  blocks: BlockState[];
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
const MAX_SETS = 30;
const MAX_EXERCISES = 20;
const DEFAULT_SETS = 3;
const builtInExerciseNames = ["深蹲", "卧推", "硬拉", "肩推", "划船", "引体向上", "弓步蹲", "腿举"];
let rowSeq = 0;
const rowId = () => `row-${++rowSeq}`;
const emptySet = (unit: SetState["unit"] = "kg"): SetState => ({ id: rowId(), reps: "", weight: "", unit, warmup: false });
const emptyBlock = (unit: SetState["unit"] = "kg", name = "", count = DEFAULT_SETS): BlockState =>
  ({ id: rowId(), name, sets: Array.from({ length: count }, () => emptySet(unit)) });
const toSetState = (set: ExerciseSet): SetState =>
  ({ id: rowId(), reps: String(set.reps), weight: String(set.weight), unit: set.unit, warmup: Boolean(set.isWarmup) });
const sessionTitle = (initial: TrainingRecord, exercises: TrainingExercise[]) => {
  // Titles derived from exercise names are not shown as a separate session name.
  const derived = exercises.map((item) => item.name).join("、");
  return initial.exercise === derived || initial.exercise === exercises[0]?.name ? "" : initial.exercise;
};
const trainingState = (initial?: TrainingRecord): TrainingState => {
  const strength = initial && initial.mode !== "cardio";
  const exercises = strength ? trainingExercises(initial) : [];
  return {
    occurredAt:
      localDateTime(initial?.occurredAt) ||
      localDateTime(new Date().toISOString()),
    mode: initial?.mode ?? "strength",
    exercise: !initial ? "" : strength ? sessionTitle(initial, exercises) : initial.exercise,
    duration:
      initial?.durationMinutes === undefined
        ? ""
        : String(initial.durationMinutes),
    blocks: exercises.length
      ? exercises.map((item) => ({
          id: rowId(),
          name: item.name,
          sets: item.sets.length ? item.sets.map(toSetState) : [emptySet()],
        }))
      : [emptyBlock()],
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
  };
};

/** Upgrades drafts saved by the single-exercise form (exercise + sets) to the session shape. */
export function restoreTrainingDraft(value: unknown, reference: TrainingState): Partial<TrainingState> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("草稿字段不兼容，当前表单保留原始记录内容");
  const { sets, ...rest } = value as Record<string, unknown>;
  const draft: Record<string, unknown> = { ...rest };
  if (!("blocks" in draft) && Array.isArray(sets)) {
    const cardio = draft.mode === "cardio";
    if (!cardio) {
      // The old form stored the exercise name where the session name now lives.
      const name = typeof draft.exercise === "string" ? draft.exercise : reference.blocks[0]?.name ?? "";
      draft.blocks = [{ name, sets: sets.length ? sets : [emptySet()] }];
      if ("exercise" in draft) draft.exercise = "";
    }
  }
  if (!compatibleDraft(reference, draft))
    throw new Error("草稿字段不兼容，当前表单保留原始记录内容");
  // Drafts saved before rows carried ids get fresh ones.
  if (Array.isArray(draft.blocks))
    draft.blocks = (draft.blocks as Array<Partial<BlockState>>).map((block) => ({
      ...block,
      id: rowId(),
      sets: (block.sets ?? []).map((set) => ({ ...set, id: rowId() })),
    }));
  return draft as Partial<TrainingState>;
}

const round = (value: number) => Math.round(value * 10) / 10;
function sessionTotals(blocks: BlockState[]) {
  const work = blocks.flatMap((block) => block.sets.filter((set) => !set.warmup));
  const reps = work.reduce((sum, set) => sum + (Number(set.reps) || 0), 0);
  const volume = { kg: 0, lb: 0 };
  for (const set of work) volume[set.unit] += (Number(set.reps) || 0) * (Number(set.weight) || 0);
  const volumeText = (["kg", "lb"] as const).filter((unit) => volume[unit]).map((unit) => `${round(volume[unit])} ${unit}`).join(" + ");
  return { sets: work.length, reps, volumeText };
}

export function TrainingForm({
  initial,
  draftKey,
  session,
  history,
  workoutTemplates,
  exerciseTemplates,
  onClose,
  onSave,
  onSaveTemplate,
}: {
  initial?: TrainingRecord;
  draftKey: DraftKey;
  session: FormSession;
  history: TrainingRecord[];
  workoutTemplates: WorkoutTemplate[];
  /** Legacy single-exercise templates; their names stay available as quick picks. */
  exerciseTemplates: ExerciseTemplate[];
  onClose: () => void;
  onSave: (draft: TrainingDraft) => Promise<void>;
  onSaveTemplate: (template: Omit<WorkoutTemplate, "id">) => Promise<void>;
}) {
  const { color, type, scheme } = useTheme();
  const base = useBaseStyles();
  const st = useThemedStyles(createStyles);
  const initialState = trainingState(initial);
  const formDraft = useFormDraft(draftKey, initialState, session, {
    restore: (value) => restoreTrainingDraft(value, initialState),
  });
  const { form, setForm } = formDraft;
  const [error, setError] = useState("");
  const [templateMenuOpen, setTemplateMenuOpen] = useState(false);
  const [templateMessage, setTemplateMessage] = useState("");
  const [pickerOpen, setPickerOpen] = useState<number | null>(null);
  const [detailOpen, setDetailOpen] = useState<number | null>(null);
  const lifecycle = useFormSession(session, {
    onClose,
    beforeClose: formDraft.persist,
    onError: (e) => setError(errorText(e)),
  });
  const locked = lifecycle.busy || lifecycle.saving || lifecycle.closing;
  const update = (patch: Partial<TrainingState>) => {
    if (lifecycle.isIdle()) setForm((current) => ({ ...current, ...patch }));
  };
  const updateBlock = (index: number, change: (block: BlockState) => BlockState) => {
    if (!lifecycle.isIdle()) return;
    setForm((current) => ({
      ...current,
      blocks: current.blocks.map((block, item) => item === index ? change(block) : block),
    }));
  };
  const updateSet = (index: number, setIndex: number, patch: Partial<SetState>) =>
    updateBlock(index, (block) => ({ ...block, sets: block.sets.map((set, item) => item === setIndex ? { ...set, ...patch } : set) }));
  const setSetCount = (index: number, count: number) => {
    const block = form.blocks[index];
    const next = Math.max(1, Math.min(MAX_SETS, count));
    if (!block || next === block.sets.length) return;
    animateLayout();
    const last = block.sets.at(-1) ?? emptySet();
    updateBlock(index, (current) => ({
      ...current,
      sets: next < current.sets.length
        ? current.sets.slice(0, next)
        : [...current.sets, ...Array.from({ length: next - current.sets.length }, () => ({ ...last, id: rowId(), warmup: false }))],
    }));
  };
  const addBlock = () => {
    if (form.blocks.length >= MAX_EXERCISES) return;
    animateLayout();
    const unit = form.blocks.at(-1)?.sets[0]?.unit ?? "kg";
    update({ blocks: [...form.blocks, emptyBlock(unit)] });
    setPickerOpen(form.blocks.length);
    setDetailOpen(null);
  };
  const removeBlock = (index: number) => {
    if (form.blocks.length <= 1) return;
    animateLayout();
    update({ blocks: form.blocks.filter((_, item) => item !== index) });
    setPickerOpen(null);
    setDetailOpen(null);
  };
  const exerciseNames = [...new Set([
    ...workoutTemplates.flatMap((template) => template.exercises.map((item) => item.name)),
    ...exerciseTemplates.map((item) => item.name),
    ...builtInExerciseNames,
  ])];
  // The most recent strength performance per exercise name, shown as a hint.
  const lastByName = new Map<string, ExerciseSet[]>();
  [...history]
    .filter((record) => record.id !== initial?.id && record.mode !== "cardio")
    .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt))
    .forEach((record) => trainingExercises(record).forEach((item) => {
      const work = item.sets.filter((set) => !set.isWarmup);
      if (work.length) lastByName.set(item.name.trim(), work);
    }));
  const lastText = (name: string) => {
    const sets = lastByName.get(name.trim());
    if (!sets?.length) return "";
    const first = sets[0];
    const same = sets.every((set) => set.reps === first.reps && set.weight === first.weight);
    return same
      ? `上次 ${sets.length}×${first.reps}${first.weight ? ` · ${first.weight} ${first.unit}` : ""}`
      : `上次 ${sets.length} 组 · ${sets.map((set) => set.reps).join("/")} 次`;
  };
  const title = form.exercise.trim();
  const isSavedTemplate = workoutTemplates.some((template) => template.name.trim() === title);
  const totals = sessionTotals(form.blocks);
  const namedCount = form.blocks.filter((block) => block.name.trim()).length;
  const totalText = totals.reps
    ? `${form.blocks.length} 个动作 · ${totals.sets} 组 · ${totals.reps} 次${totals.volumeText ? ` · ${totals.volumeText}` : ""}`
    : `${form.blocks.length} 个动作 · ${totals.sets} 组 · 待填写`;
  const applyTemplate = (template: WorkoutTemplate) => {
    animateLayout();
    update({
      exercise: template.name,
      blocks: template.exercises.map((item) => emptyBlock(item.weightUnit, item.name, item.setCount)),
      basis: template.exercises[0]?.weightBasis ?? form.basis,
      targetSets: "", targetMin: "", targetMax: "", increment: "",
    });
    setTemplateMenuOpen(false);
    setPickerOpen(null);
    setDetailOpen(null);
    setTemplateMessage(`已带出“${template.name}”的 ${template.exercises.length} 个动作`);
  };
  const startBlank = () => {
    animateLayout();
    update({ exercise: "", blocks: [emptyBlock(form.blocks[0]?.sets[0]?.unit ?? "kg")], targetSets: "", targetMin: "", targetMax: "", increment: "" });
    setTemplateMenuOpen(false);
    setPickerOpen(0);
    setDetailOpen(null);
    setTemplateMessage("");
  };
  const saveTemplate = async () => {
    setError("");
    setTemplateMessage("");
    if (!title) { setError("请先填写训练名称，再保存为模板。"); return; }
    const missing = form.blocks.findIndex((block) => !block.name.trim());
    if (missing >= 0) { setError(`请先填写第 ${missing + 1} 个动作的名称。`); return; }
    if (!lifecycle.beginMedia()) return;
    try {
      await onSaveTemplate({
        name: title,
        exercises: form.blocks.map((block) => ({
          name: block.name.trim(),
          setCount: Math.max(1, block.sets.length),
          weightUnit: block.sets[0]?.unit ?? "kg",
          weightBasis: form.basis,
        })),
      });
      if (lifecycle.isActive()) setTemplateMessage(`已保存“${title}”模板 · ${form.blocks.length} 个动作`);
    } catch (e) {
      if (lifecycle.isActive()) setError(errorText(e));
    } finally {
      lifecycle.endOperation();
    }
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
      let draft: TrainingDraft;
      if (form.mode === "cardio") {
        if (!form.exercise.trim()) throw new Error("请填写运动类型或动作名称。");
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
        if (!form.blocks.length) throw new Error("请至少添加一个动作。");
        const exercises: TrainingExercise[] = form.blocks.map((block, blockIndex) => {
          const name = block.name.trim();
          if (!name) throw new Error(`请填写第 ${blockIndex + 1} 个动作的名称。`);
          const sets = block.sets.map((set, index) => {
            if (!set.reps.trim() || (form.basis !== "bodyweight" && !set.weight.trim()))
              throw new Error(`请填写${name}第 ${index + 1} 组的实际次数和重量。`);
            const reps = Number(set.reps);
            const weight = form.basis === "bodyweight" ? 0 : Number(set.weight);
            if (!Number.isFinite(reps) || reps < 1 || !Number.isInteger(reps) || !Number.isFinite(weight) || weight < 0)
              throw new Error(`${name}第 ${index + 1} 组的次数和重量需要填写有效数字。`);
            return { reps, weight, unit: set.unit, isWarmup: set.warmup };
          });
          return { name, sets };
        });
        const sets = exercises.flatMap((item) => item.sets);
        if (!sets.some((set) => !set.isWarmup))
          throw new Error("请至少填写一组工作组。");
        const single = exercises.length === 1;
        // Progression targets only apply to a single-exercise session.
        const values = single ? [form.targetSets, form.targetMin, form.targetMax, form.increment] : [];
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
        const exercise = form.exercise.trim() || exercises.map((item) => item.name).join("、");
        draft = {
          occurredAt,
          mode: "strength",
          exercise,
          sets,
          // A one-exercise session named after its exercise keeps the legacy shape.
          exercises: single && exercise === exercises[0].name ? undefined : exercises,
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
    initial?.targetSets && form.mode === "strength" ? trainingAdvice(initial, history) : "";
  const renderBlock = (block: BlockState, index: number) => {
    const n = index + 1;
    const tag = `动作${n}`;
    const unit = block.sets[0]?.unit ?? "kg";
    const uniform = block.sets.every((set) => set.reps === block.sets[0]?.reps && set.weight === block.sets[0]?.weight);
    const work = block.sets.filter((set) => !set.warmup);
    const reps = work.reduce((sum, set) => sum + (Number(set.reps) || 0), 0);
    const picking = pickerOpen === index;
    const detail = detailOpen === index;
    const hint = lastText(block.name);
    const setAll = (patch: Partial<SetState>) =>
      updateBlock(index, (current) => ({ ...current, sets: current.sets.map((set) => ({ ...set, ...patch })) }));
    return (
      <View key={block.id} style={st.block}>
        <View style={st.blockHead}>
          <Text style={st.blockIndex}>{n}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`选择${tag}`}
            accessibilityState={{ expanded: picking }}
            disabled={locked}
            onPress={() => { animateLayout(); setPickerOpen(picking ? null : index); }}
            style={({ pressed }) => [st.blockName, pressed && base.pressed]}
          >
            <Text style={[st.blockNameText, !block.name && st.blockNameEmpty]} numberOfLines={1}>
              {block.name || "选择动作"}
            </Text>
            <Ionicons name={picking ? "chevron-up" : "chevron-down"} size={16} color={color.trainingText} />
          </Pressable>
          <Text style={st.blockSummary} numberOfLines={1}>
            {reps && uniform ? `${work.length}×${block.sets[0]?.reps}` : `${block.sets.length} 组`}
          </Text>
          {form.blocks.length > 1 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`删除${tag}`}
              disabled={locked}
              onPress={() => removeBlock(index)}
              hitSlop={6}
              style={({ pressed }) => [st.blockRemove, pressed && base.pressed]}
            >
              <Ionicons name="trash-outline" size={16} color={color.inkFaint} />
            </Pressable>
          ) : null}
        </View>
        {picking && (
          <View style={st.picker}>
            <View style={st.chips}>
              {exerciseNames.map((name) => {
                const on = block.name === name;
                return (
                  <Pressable
                    key={name}
                    accessibilityRole="button"
                    accessibilityLabel={name}
                    accessibilityState={{ selected: on }}
                    onPress={() => {
                      animateLayout();
                      updateBlock(index, (current) => ({ ...current, name }));
                      setPickerOpen(null);
                    }}
                    style={[st.chip, on && st.chipOn]}
                  >
                    <Text style={[st.chipText, on && st.chipTextOn]} numberOfLines={1}>{name}</Text>
                  </Pressable>
                );
              })}
            </View>
            <TextInput
              style={st.customInput}
              value={block.name}
              accessibilityLabel={`${tag} 名称`}
              onChangeText={(value) => updateBlock(index, (current) => ({ ...current, name: value }))}
              placeholder="或输入自定义动作名称"
              placeholderTextColor={color.inkFaint}
              keyboardAppearance={scheme}
              onSubmitEditing={() => setPickerOpen(null)}
            />
          </View>
        )}
        <View style={st.quickRow}>
          <View style={st.quickCell}>
            <View style={st.quickLabelRow}><Text style={st.quickLabel}>组数</Text></View>
            <View style={st.stepper}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${tag} 减少一组`}
                disabled={block.sets.length <= 1}
                onPress={() => setSetCount(index, block.sets.length - 1)}
                hitSlop={6}
                style={({ pressed }) => [st.stepButton, block.sets.length <= 1 && st.off, pressed && base.pressed]}
              >
                <Ionicons name="remove" size={16} color={color.trainingText} />
              </Pressable>
              <Text style={st.stepValue} accessibilityLabel={`${tag} 共 ${block.sets.length} 组`}>{block.sets.length}</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${tag} 增加一组`}
                disabled={block.sets.length >= MAX_SETS}
                onPress={() => setSetCount(index, block.sets.length + 1)}
                hitSlop={6}
                style={({ pressed }) => [st.stepButton, block.sets.length >= MAX_SETS && st.off, pressed && base.pressed]}
              >
                <Ionicons name="add" size={16} color={color.trainingText} />
              </Pressable>
            </View>
          </View>
          <Text style={st.quickTimes}>×</Text>
          <View style={st.quickCell}>
            <View style={st.quickLabelRow}><Text style={st.quickLabel}>每组次数</Text></View>
            <TextInput
              style={[st.quickInput, !uniform && st.quickInputMixed]}
              value={uniform ? block.sets[0]?.reps ?? "" : ""}
              accessibilityLabel={`${tag} 每组次数`}
              onChangeText={(value) => setAll({ reps: value })}
              placeholder={uniform ? "10" : "各组不同"}
              placeholderTextColor={color.inkFaint}
              keyboardAppearance={scheme}
              keyboardType="numeric"
            />
          </View>
          <Text style={st.quickTimes}>×</Text>
          <View style={st.quickCell}>
            <View style={st.quickLabelRow}>
              <Text style={st.quickLabel}>重量</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${tag} 重量单位：${unit === "kg" ? "公斤" : "磅"}，点按切换`}
                onPress={() => setAll({ unit: unit === "kg" ? "lb" : "kg" })}
                hitSlop={8}
                style={st.unitToggle}
              >
                <Text style={st.unitToggleText}>{unit}</Text>
                <Ionicons name="swap-horizontal" size={10} color={color.trainingText} />
              </Pressable>
            </View>
            <TextInput
              style={[st.quickInput, !uniform && st.quickInputMixed]}
              value={uniform ? block.sets[0]?.weight ?? "" : ""}
              accessibilityLabel={`${tag} 每组重量`}
              onChangeText={(value) => setAll({ weight: value })}
              placeholder={uniform ? "20" : "各组不同"}
              placeholderTextColor={color.inkFaint}
              keyboardAppearance={scheme}
              keyboardType="numeric"
            />
          </View>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${tag} 各组详情`}
          accessibilityState={{ expanded: detail }}
          onPress={() => { animateLayout(); setDetailOpen(detail ? null : index); }}
          style={({ pressed }) => [st.detailToggle, pressed && base.pressed]}
        >
          <Text style={st.detailHint} numberOfLines={1}>
            {hint || (uniform ? "每组相同 · 点开可分别调整" : `已分别填写 ${block.sets.length} 组`)}
          </Text>
          <Text style={st.detailTitle}>{detail ? "收起" : "各组详情"}</Text>
          <Ionicons name={detail ? "chevron-up" : "chevron-forward"} size={14} color={color.inkFaint} />
        </Pressable>
        {detail && (
          <View style={st.detailList}>
            {block.sets.map((set, setIndex) => (
              <View key={set.id} style={st.setRow}>
                <Text style={st.setNumber}>{setIndex + 1}</Text>
                <TextInput
                  style={st.setInput}
                  value={set.reps}
                  accessibilityLabel={`${tag} 第${setIndex + 1}组次数`}
                  onChangeText={(value) => updateSet(index, setIndex, { reps: value })}
                  placeholder="次数"
                  placeholderTextColor={color.inkFaint}
                  keyboardAppearance={scheme}
                  keyboardType="numeric"
                />
                <Text style={st.times}>×</Text>
                <TextInput
                  style={st.setInput}
                  value={set.weight}
                  accessibilityLabel={`${tag} 第${setIndex + 1}组重量`}
                  onChangeText={(value) => updateSet(index, setIndex, { weight: value })}
                  placeholder={`重量 ${set.unit}`}
                  placeholderTextColor={color.inkFaint}
                  keyboardAppearance={scheme}
                  keyboardType="numeric"
                />
                <Text style={st.setUnit}>{set.unit}</Text>
                {block.sets.length > 1 ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`${tag} 删除第${setIndex + 1}组`}
                    style={st.removeSet}
                    onPress={() => {
                      animateLayout();
                      updateBlock(index, (current) => ({ ...current, sets: current.sets.filter((_, item) => item !== setIndex) }));
                    }}
                  >
                    <Ionicons name="close" size={16} color={color.inkFaint} />
                  </Pressable>
                ) : <View style={st.removeSet} />}
              </View>
            ))}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${tag} 添加一组`}
              style={({ pressed }) => [st.addSet, block.sets.length >= MAX_SETS && st.off, pressed && base.pressed]}
              disabled={block.sets.length >= MAX_SETS}
              onPress={() => setSetCount(index, block.sets.length + 1)}
            >
              <Ionicons name="add" size={16} color={color.trainingText} />
              <Text style={st.addSetText}>添加一组</Text>
            </Pressable>
          </View>
        )}
      </View>
    );
  };
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
            label="运动名称"
            value={form.exercise}
            onChangeText={(value) => update({ exercise: value })}
            placeholder="例如：快走"
          />
        )}
        <DateTimeField
          label="训练时间"
          pickerLabel="选择训练时间"
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
                <Text style={st.ledgerCap}>本次训练</Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="选择训练模板"
                  accessibilityState={{ expanded: templateMenuOpen }}
                  disabled={locked}
                  onPress={() => { animateLayout(); setTemplateMenuOpen((open) => !open); }}
                  style={({ pressed }) => [st.templateButton, pressed && base.pressed]}
                >
                  <Ionicons name="albums-outline" size={14} color={color.trainingText} />
                  <Text style={st.templateButtonText}>
                    {workoutTemplates.length ? `模板 · ${workoutTemplates.length}` : "模板"}
                  </Text>
                  <Ionicons name={templateMenuOpen ? "chevron-up" : "chevron-down"} size={14} color={color.trainingText} />
                </Pressable>
              </View>
              {templateMenuOpen && (
                <View style={st.templateMenu}>
                  {workoutTemplates.length ? workoutTemplates.map((template) => {
                    const on = template.name.trim() === title;
                    return (
                      <Pressable
                        key={template.id}
                        accessibilityRole="button"
                        accessibilityLabel={`使用模板 ${template.name}`}
                        accessibilityState={{ selected: on }}
                        onPress={() => applyTemplate(template)}
                        style={({ pressed }) => [st.templateRow, on && st.templateRowOn, pressed && base.pressed]}
                      >
                        <View style={st.templateCount}>
                          <Text style={st.templateCountValue}>{template.exercises.length}</Text>
                          <Text style={st.templateCountUnit}>动作</Text>
                        </View>
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <Text style={st.templateName} numberOfLines={1}>{template.name}</Text>
                          <Text style={st.templateExercises} numberOfLines={1}>
                            {template.exercises.map((item) => `${item.name} ${item.setCount}组`).join(" · ")}
                          </Text>
                        </View>
                        <Ionicons name={on ? "checkmark-circle" : "arrow-forward"} size={18} color={color.trainingText} />
                      </Pressable>
                    );
                  }) : (
                    <Text style={st.templateEmpty}>还没有训练模板。填好训练名称和动作后点“存为模板”，下次一键带出全部动作。</Text>
                  )}
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="空白训练"
                    onPress={startBlank}
                    style={({ pressed }) => [st.templateBlank, pressed && base.pressed]}
                  >
                    <Ionicons name="add" size={14} color={color.inkSoft} />
                    <Text style={st.templateBlankText}>空白训练</Text>
                  </Pressable>
                </View>
              )}
              <View style={st.titleRow}>
                <View style={st.titleField}>
                  <Text style={st.titleLabel}>训练名称</Text>
                  <TextInput
                    style={st.titleInput}
                    value={form.exercise}
                    accessibilityLabel="训练名称"
                    onChangeText={(value) => { update({ exercise: value }); setTemplateMessage(""); }}
                    placeholder={namedCount ? form.blocks.map((block) => block.name.trim()).filter(Boolean).join("、") : "例如：推日 / 下肢日"}
                    placeholderTextColor={color.inkFaint}
                    keyboardAppearance={scheme}
                  />
                </View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="保存为模板"
                  disabled={locked}
                  onPress={() => { void saveTemplate(); }}
                  style={({ pressed }) => [st.saveTemplate, (!title || !namedCount) && st.saveTemplateDim, pressed && base.pressed]}
                >
                  <Ionicons name={isSavedTemplate ? "bookmark" : "bookmark-outline"} size={17} color={color.trainingText} />
                  <Text style={st.saveTemplateText}>{isSavedTemplate ? "更新模板" : "存为模板"}</Text>
                </Pressable>
              </View>
              {Boolean(templateMessage) && <Text style={st.templateMessage}>{templateMessage}</Text>}
              <View style={st.blocks}>
                {form.blocks.map(renderBlock)}
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="添加动作"
                disabled={locked || form.blocks.length >= MAX_EXERCISES}
                onPress={addBlock}
                style={({ pressed }) => [st.addBlock, form.blocks.length >= MAX_EXERCISES && st.off, pressed && base.pressed]}
              >
                <Ionicons name="add-circle-outline" size={18} color={color.trainingText} />
                <Text style={st.addBlockText}>添加动作</Text>
              </Pressable>
              <View style={st.totalRow}>
                <Text style={st.totalLabel}>合计</Text>
                <Text style={st.totalValue} numberOfLines={1}>{totalText}</Text>
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

const createStyles = ({ color, type, shadow }: ThemeTokens) => StyleSheet.create({
  ledger: {
    backgroundColor: color.surface, borderRadius: 20, padding: space.lg, marginBottom: space.lg,
    borderWidth: 1, borderColor: color.line, borderTopWidth: 4, borderTopColor: color.training, ...shadow.card,
  },
  ledgerHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm, marginBottom: space.md },
  ledgerCap: { ...type.heading },
  off: { opacity: 0.35 },
  templateButton: {
    flexDirection: "row", alignItems: "center", gap: 5, minHeight: 32, paddingHorizontal: 12,
    borderRadius: radius.pill, backgroundColor: color.trainingTint,
  },
  templateButtonText: { fontSize: 12.5, fontWeight: "800", color: color.trainingText },
  templateMenu: { marginBottom: space.md, padding: 6, gap: 4, borderRadius: 16, backgroundColor: color.paper, borderWidth: 1, borderColor: color.line },
  templateRow: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: 58, paddingHorizontal: 10, borderRadius: 12, backgroundColor: color.surface },
  templateRowOn: { borderWidth: 1, borderColor: color.training },
  templateCount: { width: 40, height: 40, borderRadius: 12, backgroundColor: color.training, alignItems: "center", justifyContent: "center" },
  templateCountValue: { fontSize: 16, lineHeight: 18, fontWeight: "800", color: color.onTraining, ...type.mono },
  templateCountUnit: { fontSize: 9, lineHeight: 11, fontWeight: "700", color: color.onTraining },
  templateName: { fontSize: 14.5, lineHeight: 20, fontWeight: "800", color: color.ink },
  templateExercises: { fontSize: 11.5, lineHeight: 16, color: color.inkSoft, marginTop: 1 },
  templateEmpty: { fontSize: 12, lineHeight: 18, color: color.inkSoft, padding: 10 },
  templateBlank: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 4, minHeight: 40,
    borderRadius: 12, borderWidth: 1, borderStyle: "dashed", borderColor: color.lineStrong,
  },
  templateBlankText: { fontSize: 13, fontWeight: "700", color: color.inkSoft },
  titleRow: { flexDirection: "row", alignItems: "stretch", gap: space.sm },
  titleField: { flex: 1, minWidth: 0, minHeight: 58, justifyContent: "center", paddingHorizontal: 14, paddingVertical: 6, borderRadius: 14, backgroundColor: color.trainingTint },
  titleLabel: { fontSize: 11, lineHeight: 14, fontWeight: "800", color: color.trainingText, letterSpacing: 0.6 },
  titleInput: { fontSize: 18, lineHeight: 24, minHeight: 28, padding: 0, fontWeight: "800", color: color.ink },
  saveTemplate: {
    width: 72, alignItems: "center", justifyContent: "center", gap: 3, borderRadius: 14,
    borderWidth: 1, borderColor: color.training, backgroundColor: color.surface,
  },
  saveTemplateDim: { opacity: 0.5 },
  saveTemplateText: { fontSize: 11, fontWeight: "800", color: color.trainingText },
  templateMessage: { fontSize: 12, lineHeight: 17, color: color.trainingText, marginTop: 6, paddingHorizontal: 2 },
  blocks: { gap: space.sm, marginTop: space.md },
  block: { borderRadius: 16, borderWidth: 1, borderColor: color.line, backgroundColor: color.paper, padding: 12 },
  blockHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  blockIndex: {
    width: 24, height: 24, borderRadius: 12, backgroundColor: color.training, color: color.onTraining,
    textAlign: "center", lineHeight: 24, fontWeight: "800", fontSize: 12, overflow: "hidden", ...type.mono,
  },
  blockName: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 4, minHeight: 36 },
  blockNameText: { flexShrink: 1, fontSize: 16.5, lineHeight: 22, fontWeight: "800", color: color.ink },
  blockNameEmpty: { color: color.inkFaint, fontWeight: "700" },
  blockSummary: { fontSize: 12, color: color.inkSoft, fontWeight: "700", ...type.mono },
  blockRemove: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center", backgroundColor: color.sunken },
  picker: { marginTop: space.sm, gap: space.sm },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chip: {
    maxWidth: "100%", minHeight: 34, justifyContent: "center", paddingHorizontal: 12,
    borderRadius: radius.pill, borderWidth: 1, borderColor: color.line, backgroundColor: color.surface,
  },
  chipOn: { backgroundColor: color.training, borderColor: color.training },
  chipText: { fontSize: 13, color: color.inkSoft, fontWeight: "700" },
  chipTextOn: { color: color.onTraining, fontWeight: "800" },
  customInput: {
    minHeight: 42, borderRadius: 10, backgroundColor: color.surface, borderWidth: 1, borderColor: color.line,
    paddingHorizontal: 12, fontSize: 14, color: color.ink,
  },
  quickRow: { flexDirection: "row", alignItems: "flex-end", gap: 6, marginTop: space.md },
  quickCell: { flex: 1, minWidth: 0 },
  quickLabelRow: { height: 18, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 4, marginBottom: 5 },
  quickLabel: { fontSize: 11.5, lineHeight: 16, fontWeight: "700", color: color.inkSoft },
  quickTimes: { color: color.inkFaint, fontSize: 15, lineHeight: 46, fontWeight: "700" },
  quickInput: {
    minHeight: 46, minWidth: 0, borderRadius: 12, backgroundColor: color.sunken, paddingHorizontal: 8,
    fontSize: 20, fontWeight: "800", color: color.ink, textAlign: "center", ...type.mono,
  },
  quickInputMixed: { fontSize: 13, fontWeight: "700" },
  stepper: {
    minHeight: 46, flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    borderRadius: 12, backgroundColor: color.sunken, paddingHorizontal: 4,
  },
  stepButton: { width: 28, height: 28, borderRadius: 14, alignItems: "center", justifyContent: "center", backgroundColor: color.surface },
  stepValue: { fontSize: 20, fontWeight: "800", color: color.ink, ...type.mono },
  unitToggle: {
    flexDirection: "row", alignItems: "center", gap: 2, paddingHorizontal: 6, paddingVertical: 1,
    borderRadius: radius.pill, backgroundColor: color.trainingTint,
  },
  unitToggleText: { fontSize: 11, lineHeight: 15, fontWeight: "800", color: color.trainingText, ...type.mono },
  detailToggle: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 36, marginTop: space.sm },
  detailHint: { flex: 1, minWidth: 0, fontSize: 11.5, lineHeight: 16, color: color.inkFaint, ...type.mono },
  detailTitle: { fontSize: 12.5, lineHeight: 17, fontWeight: "800", color: color.inkSoft },
  detailList: { marginTop: 4, gap: 6 },
  setRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  setNumber: {
    width: 24, height: 24, borderRadius: 12, backgroundColor: color.trainingTint, color: color.trainingText,
    textAlign: "center", lineHeight: 24, fontWeight: "800", fontSize: 11, overflow: "hidden", ...type.mono,
  },
  setInput: {
    flex: 1, minWidth: 0, minHeight: 42, borderRadius: 10, backgroundColor: color.sunken,
    paddingHorizontal: 10, fontSize: 16, fontWeight: "700", color: color.ink, textAlign: "center", ...type.mono,
  },
  times: { color: color.inkFaint, fontSize: 14 },
  setUnit: { width: 20, fontSize: 11, color: color.inkFaint, ...type.mono },
  removeSet: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
  addSet: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 4, minHeight: 40, marginTop: 2,
    borderRadius: 10, borderWidth: 1, borderStyle: "dashed", borderColor: color.training,
  },
  addSetText: { color: color.trainingText, fontSize: 13, fontWeight: "800" },
  addBlock: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, minHeight: 48, marginTop: space.sm,
    borderRadius: 14, borderWidth: 1.5, borderStyle: "dashed", borderColor: color.training, backgroundColor: color.trainingTint,
  },
  addBlockText: { color: color.trainingText, fontSize: 14, fontWeight: "800" },
  totalRow: {
    flexDirection: "row", alignItems: "center", gap: space.sm, marginTop: space.md, paddingTop: space.md,
    borderTopWidth: 1, borderColor: color.line,
  },
  totalLabel: { ...type.cap, color: color.trainingText },
  totalValue: { flex: 1, minWidth: 0, textAlign: "right", fontSize: 13.5, fontWeight: "800", color: color.ink, ...type.mono },
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
