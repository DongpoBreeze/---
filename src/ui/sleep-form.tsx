import React, { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import type { SleepRecord } from "../types";
import { sleepStats } from "../domain";
import { type FormSession, useFormDraft, useFormSession } from "./useFormDraft";
import { Banner, Choice, DraftStatus, Field, Sheet } from "./components";
import { errorText, localDateTime, notify, parseDateTime } from "./format";
import { color, radius, space, type } from "./theme";
import type { DraftKey, SleepDraft } from "./app-types";

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
  const draft = useFormDraft(draftKey, sleepState(initial), session);
  const { form, setForm } = draft;
  const [error, setError] = useState("");
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
      const quality = Number(form.quality);
      if (![1, 2, 3, 4, 5].includes(quality))
        throw new Error("请选择主观睡眠质量。");
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
  let duration = "待填写";
  let span: { start: number; end: number } | null = null;
  try {
    const fellAt = Date.parse(parseDateTime(form.fell));
    const wokeAt = Date.parse(parseDateTime(form.woke));
    const value = (wokeAt - fellAt) / 3600000;
    if (value > 0 && value <= 24) {
      duration = `${value.toFixed(1)} 小时`;
      // Position on an 18:00 → 12:00 night axis (18 hours wide).
      const anchor = new Date(wokeAt);
      anchor.setHours(12, 0, 0, 0);
      const axisStart = anchor.getTime() - 18 * 3600000;
      const clamp = (n: number) => Math.min(1, Math.max(0, n));
      span = { start: clamp((fellAt - axisStart) / (18 * 3600000)), end: clamp((wokeAt - axisStart) / (18 * 3600000)) };
    }
  } catch {
    /* save validates */
  }
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
          <Text style={st.nightValue}>{duration}</Text>
          <View style={st.axis} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            {span && (
              <View style={[st.span, { left: `${span.start * 100}%`, width: `${Math.max(2, (span.end - span.start) * 100)}%` }]} />
            )}
          </View>
          <View style={st.ticks}>
            {["18:00", "00:00", "06:00", "12:00"].map((t) => <Text key={t} style={st.tick}>{t}</Text>)}
          </View>
          <Text style={st.nightNote}>时间区间来自你的输入；未填写清醒时长时，估算睡眠会保持未知，不会当作 0。</Text>
        </View>
        <Field
          label="入睡（YYYY-MM-DD HH:mm）"
          value={form.fell}
          onChangeText={(value) => update({ fell: value })}
          placeholder="2026-10-09 23:30"
        />
        <Field
          label="起床（YYYY-MM-DD HH:mm）"
          value={form.woke}
          onChangeText={(value) => update({ woke: value })}
          placeholder="2026-10-10 07:00"
        />
        <Field
          label="清醒时长（分钟，可明确填 0）"
          value={form.awake}
          onChangeText={(value) => update({ awake: value })}
          placeholder="未知就留空"
          keyboardType="numeric"
        />
        <Choice
          label="主观质量"
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

const st = StyleSheet.create({
  night: {
    backgroundColor: color.sleepTint, borderRadius: radius.block, padding: space.lg, marginBottom: space.xl, borderWidth: 1, borderColor: color.sleepLine,
  },
  nightLabel: { color: color.sleepText, fontSize: 13 },
  nightValue: { color: color.ink, fontSize: 32, lineHeight: 38, fontWeight: "800", marginTop: 2, ...type.numeric },
  axis: { height: 10, borderRadius: 5, backgroundColor: color.paper, marginTop: space.lg, overflow: "hidden" },
  span: { position: "absolute", top: 0, bottom: 0, borderRadius: 5, backgroundColor: color.sleep },
  ticks: { flexDirection: "row", justifyContent: "space-between", marginTop: 6 },
  tick: { color: color.inkFaint, fontSize: 11, ...type.numeric },
  nightNote: { color: color.inkSoft, fontSize: 12, lineHeight: 18, marginTop: space.md },
});
