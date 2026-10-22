import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { Kind } from "./app-types";
import type { ThemeTokens } from "./theme";
import { useTheme, useThemedStyles } from "./theme-provider";

export type RhythmMark = { kind: Kind; start: number; end?: number };

const ORDER = ["sleep", "meal", "training"] as const;

export function intersectsHour(mark: RhythmMark, hour: number) {
  if (!Number.isFinite(mark.start)) return false;
  const start = hour * 60;
  const end = start + 60;
  if (mark.end !== undefined && Number.isFinite(mark.end) && mark.end > mark.start) {
    return mark.start < end && mark.end > start;
  }
  return mark.start >= start && mark.start < end;
}

/** Kinds recorded in each local hour, in display order. */
export function hourKinds(marks: RhythmMark[]) {
  return Array.from({ length: 24 }, (_, hour) => {
    const records = marks.filter((mark) => intersectsHour(mark, hour));
    return ORDER.filter((kind) => records.some((mark) => mark.kind === kind));
  });
}

const pad = (value: number) => String(value).padStart(2, "0");

/** One column per local hour; overlapping record types stack inside the same column. */
export function RhythmMatrix({ marks, now, compact = false, selectedHour = null, onSelectHour }: {
  marks: RhythmMark[];
  now: number;
  compact?: boolean;
  selectedHour?: number | null;
  onSelectHour?: (hour: number | null) => void;
}) {
  const { moduleTone, color } = useTheme();
  const st = useThemedStyles(createStyles);
  const currentHour = Math.floor(now / 60);
  const clock = `${pad(currentHour)}:${pad(Math.floor(now % 60))}`;
  const perHour = hourKinds(marks);
  return (
    <View testID="rhythm-matrix" style={compact && st.compactWrap}>
      <View style={[st.matrix, { height: compact ? 40 : 64 }]}>
        {perHour.map((kinds, hour) => {
          const current = hour === currentHour;
          const selected = selectedHour === hour;
          const dimmed = selectedHour !== null && !selected;
          const label = `${pad(hour)}:00～${pad(hour + 1)}:00：${kinds.length ? kinds.map((kind) => moduleTone[kind].name).join("、") : "未记录"}${current ? "，当前小时" : ""}`;
          const body = (
            <>
              <View style={[st.slot, hour < currentHour && st.past, hour > currentHour && st.future]}>
                {kinds.map((kind) => <View key={kind} style={[st.seg, { backgroundColor: moduleTone[kind].hue }]} />)}
              </View>
              {current && <View pointerEvents="none" style={[st.ring, { borderColor: color.now }]} />}
              {current && <View pointerEvents="none" style={st.triangle} />}
              {selected && <View pointerEvents="none" style={[st.ring, { borderColor: color.ink }]} />}
            </>
          );
          const colStyle = [st.col, dimmed && st.dimmed];
          return onSelectHour ? (
            <Pressable
              key={hour}
              testID={`rhythm-hour-${hour}`}
              accessibilityRole="button"
              accessibilityLabel={label}
              accessibilityState={{ selected }}
              hitSlop={{ top: 8, bottom: 8 }}
              onPress={() => onSelectHour(selected ? null : hour)}
              style={colStyle}
            >
              {body}
            </Pressable>
          ) : (
            <View key={hour} testID={`rhythm-hour-${hour}`} accessible accessibilityLabel={label} style={colStyle}>{body}</View>
          );
        })}
      </View>
      <View style={st.axis}>
        {["00", "06", "12", "18", "23"].map((label) => <Text key={label} style={st.axisText}>{label}</Text>)}
      </View>
      <Text testID="rhythm-now" style={st.srOnly}>NOW {clock}</Text>
    </View>
  );
}

const createStyles = ({ color, type }: ThemeTokens) => StyleSheet.create({
  compactWrap: { marginTop: 16 },
  matrix: { flexDirection: "row", gap: 3 },
  col: { flex: 1, minWidth: 0, position: "relative" },
  dimmed: { opacity: 0.28 },
  slot: { flex: 1, borderRadius: 3, backgroundColor: color.slot, overflow: "hidden", gap: 1.5 },
  past: { backgroundColor: color.slotPast },
  future: { opacity: 0.45 },
  seg: { flex: 1, opacity: 0.55 },
  ring: { position: "absolute", top: -1.5, bottom: -1.5, left: -1.5, right: -1.5, borderWidth: 1.5, borderRadius: 4.5 },
  triangle: {
    position: "absolute", top: -9, left: "50%", marginLeft: -4, width: 0, height: 0,
    borderLeftWidth: 4, borderRightWidth: 4, borderTopWidth: 5,
    borderLeftColor: "transparent", borderRightColor: "transparent", borderTopColor: color.now,
  },
  axis: { flexDirection: "row", justifyContent: "space-between", marginTop: 6 },
  axisText: { fontSize: 9.5, lineHeight: 12, color: color.inkFaint, ...type.mono },
  srOnly: { position: "absolute", width: 1, height: 1, overflow: "hidden", opacity: 0 },
});
