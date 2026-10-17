import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { color, mono, moduleTone, space, type } from "./theme";
import type { Kind } from "./app-types";

export type TapeMark = { kind: Kind; start: number; end?: number };

const DAY = 1440;
const CHANNELS: Kind[] = ["sleep", "meal", "training"];
const HOURS = Array.from({ length: 25 }, (_, h) => h);

const pct = (minute: number) => `${(Math.min(DAY, Math.max(0, minute)) / DAY) * 100}%` as const;

/**
 * A 24-hour strip-chart: one pen channel per module on graph paper.
 * Spans (sleep, cardio) draw as solid pen strokes; point events (meals,
 * strength sessions) draw as a tick with a pen dot.
 */
export function Tape({ marks, now }: { marks: TapeMark[]; now: number }) {
  return (
    <View style={st.wrap}>
      {CHANNELS.map((kind) => {
        const tone = moduleTone[kind];
        const own = marks.filter((m) => m.kind === kind && (m.end ?? m.start) > 0 && m.start < DAY);
        return (
          <View key={kind} style={st.channel}>
            <View style={st.label}>
              <View style={[st.pen, { backgroundColor: tone.hue }]} />
              <Text style={[st.labelText, { color: tone.text }]}>{tone.name}</Text>
            </View>
            <View style={st.track}>
              <Grid />
              <View style={[st.baseline, { backgroundColor: tone.line }]} />
              {own.map((m, i) =>
                m.end !== undefined && m.end > m.start ? (
                  <View
                    key={i}
                    style={[st.span, {
                      left: pct(m.start),
                      width: `${((Math.min(DAY, m.end) - Math.max(0, m.start)) / DAY) * 100}%`,
                      backgroundColor: tone.hue,
                    }]}
                  />
                ) : (
                  <View key={i} style={[st.tick, { left: pct(m.start) }]}>
                    <View style={[st.tickLine, { backgroundColor: tone.hue }]} />
                    <View style={[st.tickDot, { backgroundColor: tone.hue }]} />
                  </View>
                ),
              )}
              <View style={[st.now, { left: pct(now) }]} />
            </View>
          </View>
        );
      })}
      <View style={st.axis}>
        <View style={st.label} />
        <View style={st.axisTrack}>
          {[0, 6, 12, 18, 24].map((h) => (
            <Text
              key={h}
              style={[st.hour, { left: pct(h * 60) }, h === 24 && { transform: [{ translateX: -18 }] }, h > 0 && h < 24 && { transform: [{ translateX: -9 }] }]}
            >
              {String(h).padStart(2, "0")}
            </Text>
          ))}
        </View>
      </View>
    </View>
  );
}

function Grid() {
  return (
    <>
      {HOURS.map((h) => (
        <View
          key={h}
          style={[st.gridLine, { left: pct(h * 60), backgroundColor: h % 6 === 0 ? color.lineStrong : color.grid }]}
        />
      ))}
    </>
  );
}

const st = StyleSheet.create({
  wrap: { gap: 6 },
  channel: { flexDirection: "row", alignItems: "center", gap: space.sm },
  label: { width: 44, flexDirection: "row", alignItems: "center", gap: 5 },
  pen: { width: 6, height: 6, borderRadius: 3 },
  labelText: { fontSize: 12, fontWeight: "700" },
  track: { flex: 1, height: 30, position: "relative", overflow: "hidden" },
  gridLine: { position: "absolute", top: 0, bottom: 0, width: StyleSheet.hairlineWidth },
  baseline: { position: "absolute", left: 0, right: 0, top: 14.5, height: 1 },
  span: { position: "absolute", top: 11, height: 8, borderRadius: 2 },
  tick: { position: "absolute", top: 4, bottom: 4, width: 8, marginLeft: -4, alignItems: "center", justifyContent: "center" },
  tickLine: { position: "absolute", top: 0, bottom: 0, width: 2 },
  tickDot: { width: 8, height: 8, borderRadius: 4, borderWidth: 1.5, borderColor: color.surface },
  now: { position: "absolute", top: 0, bottom: 0, width: 1.5, marginLeft: -0.75, backgroundColor: color.ink },
  axis: { flexDirection: "row", gap: space.sm },
  axisTrack: { flex: 1, height: 16, position: "relative" },
  hour: { position: "absolute", top: 0, fontSize: 10, color: color.inkFaint, fontFamily: mono, ...type.numeric },
});
