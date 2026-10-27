import React, { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import type { SleepRecord } from "../types";
import { sleepStats } from "../domain";
import { buildSleepTimeline, sleepLocalTimeLabel } from "../sleep-time";
import { type FormSession, useFormDraft, useFormSession } from "./useFormDraft";
import { Banner, Choice, DraftStatus, Field, Sheet } from "./components";
import { errorText, localDateTime, notify, parseDateTime } from "./format";
import { radius, space, type ThemeTokens } from "./theme";
import { useThemedStyles } from "./theme-provider";
import type { DraftKey, SleepDraft } from "./app-types";
import { DateTimeField } from "./date-time-field";
import { SleepTimeline } from "./sleep-timeline";

type SleepState = {
  fell: string;
  woke: string;
  awake: string;
  quality: string;
  note: string;
};
const sleepState = (initial?: SleepRecord): SleepState => ({
  fell: localDateTime(initial?.fellAsleepAt) || "",
  woke: localDateTime(initial?.wokeAt) || "",
  awake:
    initial?.awakeMinutes === null || initial?.awakeMinutes === undefined
      ? ""
      : String(initial.awakeMinutes),
  quality: initial?.quality ? String(initial.quality) : "",
  note: initial?.note ?? "",
});
export function SleepForm({
  initial,
  draftKey,
  session,
  onClose,
  onSave,
}: {
  initial?: SleepRecord;
  draftKey: DraftKey;
  session: FormSession;
  onClose: () => void;
  onSave: (draft: SleepDraft) => Promise<void>;
}) {
  const st = useThemedStyles(createStyles);
  const draft = useFormDraft(draftKey, sleepState(initial), session);
  const { form, setForm } = draft;
  const [error, setError] = useState("");
  const [timelineReference] = useState(() => new Date());
  const lifecycle = useFormSession(session, {
    onClose,
    beforeClose: draft.persist,
    onError: (e) => setError(errorText(e)),
  });
  const update = (patch: Partial<SleepState>) => {
    if (lifecycle.isIdle()) setForm((current) => ({ ...current, ...patch }));
  };
  const submit = async () => {
    if (!draft.loaded || !lifecycle.beginSave()) return;
    setError("");
    try {
      const fell = parseDateTime(form.fell);
      const woke = parseDateTime(form.woke);
      const interval = (Date.parse(woke) - Date.parse(fell)) / 60000;
      if (interval <= 0 || interval > 1440)
        throw new Error("入睡到起床的时间区间应大于 0 且不超过 24 小时。");
      const awake = form.awake.trim() ? Number(form.awake) : null;
      if (awake !== null && (!Number.isFinite(awake) || awake < 0))
        throw new Error("清醒时长必须是大于等于 0 的分钟数。");
      const quality = form.quality.trim() ? Number(form.quality) : undefined;
      if (quality !== undefined && ![1, 2, 3, 4, 5].includes(quality))
        throw new Error("主观睡眠质量需要选择 1 到 5 分。");
      sleepStats({ fellAsleepAt: fell, wokeAt: woke, awakeMinutes: awake });
      await draft.persist();
      if (!lifecycle.isActive()) return;
      await onSave({
        fellAsleepAt: fell,
        wokeAt: woke,
        occurredAt: woke,
        awakeMinutes: awake,
        quality: quality as SleepRecord["quality"],
        note: form.note.trim(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      if (!lifecycle.isActive()) return;
      await draft
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
  const timeline = buildSleepTimeline(form.fell, form.woke, timelineReference);
  const duration = timeline.durationMinutes === null ? "待填写" : `${(timeline.durationMinutes / 60).toFixed(1)} 小时`;
  const disabled = !draft.loaded || lifecycle.saving || lifecycle.closing;
  return (
    <Sheet
      title={initial ? "编辑睡眠" : "记录睡眠"}
      tone="sleep"
      onClose={lifecycle.requestClose}
      onSave={() => {
        void submit();
      }}
      saving={lifecycle.saving}
      closing={lifecycle.closing}
      disabled={!draft.loaded}
    >
      <>
        <DraftStatus saved={draft.saved} error={draft.draftError} />
        {Boolean(error) && (
          <Banner text={error} danger onClose={() => setError("")} />
        )}
        <View style={st.night}>
          <Text style={st.nightLabel}>记录的睡眠时间区间</Text>
          <Text testID="sleep-duration" style={st.nightValue}>{duration}</Text>
          <SleepTimeline model={timeline} disabled={disabled} onChange={update} />
          <Text style={st.nightNote}>{timeline.hasFell && timeline.hasWoke && timeline.durationMinutes === null
            ? "当前时间区间无效，请在下方修改入睡或起床日期与时间。"
            : "拖动两端滑块选择入睡和起床时间，每次 5 分钟；也可点击下方“选择”。按记录时间估算睡眠，填写清醒时长后会扣除。"}</Text>
        </View>
        <DateTimeField
          label="入睡（YYYY-MM-DD HH:mm）"
          pickerLabel="选择入睡时间"
          value={form.fell}
          onChangeText={(value) => update({ fell: value })}
          placeholder="2026-10-09 23:30"
          suggestedValue={sleepLocalTimeLabel(timeline.fellAt)}
          disabled={disabled}
        />
        <DateTimeField
          label="起床（YYYY-MM-DD HH:mm）"
          pickerLabel="选择起床时间"
          value={form.woke}
          onChangeText={(value) => update({ woke: value })}
          placeholder="2026-10-10 07:00"
          suggestedValue={sleepLocalTimeLabel(timeline.wokeAt)}
          disabled={disabled}
        />
        <Field
          label="清醒时长（分钟，可明确填 0）"
          value={form.awake}
          onChangeText={(value) => update({ awake: value })}
          placeholder="未知就留空"
          keyboardType="numeric"
        />
        <Choice
          label="主观质量（可选）"
          tone="sleep"
          value={form.quality}
          choices={[
            ["1", "1 分"],
            ["2", "2 分"],
            ["3", "3 分"],
            ["4", "4 分"],
            ["5", "5 分"],
          ]}
          onChange={(value) => update({ quality: value })}
        />
        <Field
          label="备注（可选）"
          value={form.note}
          onChangeText={(value) => update({ note: value })}
          placeholder="例如：夜间醒来"
          multiline
        />
      </>
    </Sheet>
  );
}

const createStyles = ({ color, type }: ThemeTokens) => StyleSheet.create({
  night: {
    backgroundColor: color.sleepTint, borderRadius: radius.block, padding: space.lg, marginBottom: space.xl, borderWidth: 1, borderColor: color.sleepBorder, borderTopWidth: 3, borderTopColor: color.sleep,
  },
  nightLabel: { ...type.cap, color: color.sleepText },
  nightValue: { color: color.ink, fontSize: 32, lineHeight: 38, fontWeight: "800", marginTop: 4, ...type.mono },
  nightNote: { color: color.inkSoft, fontSize: 12, lineHeight: 18, marginTop: space.md },
});
