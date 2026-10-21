import React from "react";
import { StyleSheet, Text, View } from "react-native";
import type { Kind } from "./app-types";
import type { ThemeTokens } from "./theme";
import { useTheme, useThemedStyles } from "./theme-provider";

export type RhythmMark = { kind: Kind; start: number; end?: number };

function intersectsHour(mark: RhythmMark, hour: number) {
  if (!Number.isFinite(mark.start)) return false;
  const start = hour * 60;
  const end = start + 60;
  if (mark.end !== undefined && Number.isFinite(mark.end) && mark.end > mark.start) {
    return mark.start < end && mark.end > start;
  }
  return mark.start >= start && mark.start < end;
}

/** One column per local hour; overlapping record types share the same column. */
export function RhythmMatrix({ marks, now }: { marks: RhythmMark[]; now: number }) {
  const { moduleTone, scheme } = useTheme();
  const st = useThemedStyles(createStyles);
  const currentHour = Math.floor(now / 60);
  const clock = `${String(currentHour).padStart(2, "0")}:${String(Math.floor(now % 60)).padStart(2, "0")}`;
  return (
    <View testID="rhythm-matrix">
      <View style={st.bars}>
        {Array.from({ length: 24 }, (_, hour) => {
          const records = marks.filter((mark) => intersectsHour(mark, hour));
          const kinds = (["sleep", "meal", "training"] as const).filter((kind) => records.some((mark) => mark.kind === kind));
          const current = hour === currentHour;
          const height = records.length ? Math.min(60, 32 + records.length * 8) : current ? 51 : 12;
          return (
            <View key={hour} style={st.slot}>
              <View
                testID={`rhythm-hour-${hour}`}
                accessible
                accessibilityLabel={`${String(hour).padStart(2, "0")}:00～${String(hour + 1).padStart(2, "0")}:00：${kinds.length ? kinds.map((kind) => moduleTone[kind].name).join("、") : "未记录"}${current ? "，当前小时" : ""}`}
                style={[st.bar, { height }, Boolean(kinds.length) && { backgroundColor: "transparent" }]}
              >
                {kinds.map((kind) => <View key={kind} style={[st.mark, { backgroundColor: `${moduleTone[kind].hue}${scheme === "dark" ? "99" : "40"}` }]} />)}
                {current && <View style={st.current} pointerEvents="none" />}
              </View>
            </View>
          );
        })}
      </View>
      <View style={st.timeLabels}>
        {["00:00", "06:00", "12:00", "18:00", "23:00"].map((label) => <Text key={label} style={st.time}>{label}</Text>)}
      </View>
      <View style={st.legend}>
        {(["sleep", "meal", "training"] as const).map((kind) => (
          <View key={kind} style={st.legendItem}>
            <View style={[st.dot, { backgroundColor: scheme === "dark" ? moduleTone[kind].hue : `${moduleTone[kind].hue}99` }]} />
            <Text style={st.legendText}>{moduleTone[kind].name}</Text>
          </View>
        ))}
        <View style={st.now}>
          <View style={st.nowDot} />
          <Text testID="rhythm-now" style={st.nowText}>NOW {clock}</Text>
        </View>
      </View>
    </View>
  );
}

const createStyles = ({ color, type }: ThemeTokens) => StyleSheet.create({
  bars: { height: 64, flexDirection: "row", alignItems: "flex-end", gap: 4, marginBottom: 12 },
  slot: { flex: 1, minWidth: 0, justifyContent: "flex-end" },
  bar: { width: "100%", borderRadius: 2, backgroundColor: color.empty },
  mark: { flex: 1, borderRadius: 2 },
  current: { position: "absolute", top: -4, bottom: -4, left: -4, right: -4, borderWidth: 2, borderColor: color.ink, borderRadius: 6 },
  timeLabels: { flexDirection: "row", justifyContent: "space-between", marginBottom: 12 },
  time: { fontSize: 11, color: color.inkFaint, ...type.numeric },
  legend: { flexDirection: "row", alignItems: "center", gap: 12 },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 4 },
  dot: { width: 8, height: 8, borderRadius: 2 },
  legendText: { fontSize: 12, color: color.ink },
  now: { flexDirection: "row", alignItems: "center", gap: 4, marginLeft: "auto" },
  nowDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: color.danger },
  nowText: { fontSize: 12, color: color.danger, ...type.numeric },
});
