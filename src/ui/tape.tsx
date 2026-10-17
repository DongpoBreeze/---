import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { color, mono, moduleTone, space, type } from "./theme";
import type { Kind } from "./app-types";

export type TapeMark = { kind: Kind; start: number; end?: number };

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const ORDER: Kind[] = ["sleep", "meal", "training"];

function hourHits(marks: TapeMark[], hour: number): Kind[] {
  const hStart = hour * 60;
  const hEnd = hStart + 60;
  const active = new Set<Kind>();
  for (const m of marks) {
    if (m.end !== undefined && m.end > m.start) {
      if (m.start < hEnd && m.end > hStart) active.add(m.kind);
    } else if (m.start >= hStart && m.start < hEnd) {
      active.add(m.kind);
    }
  }
  return ORDER.filter((k) => active.has(k));
}

/**
 * v0.8 Signature Element: 24-Slot Hourly Barcode Matrix.
 * Quantizes the 24-hour day into 24 crisp vertical protocol columns (00..23).
 * Active hours light up in module signal colors; multi-module hours stack vertically.
 */
export function Tape({ marks, now }: { marks: TapeMark[]; now: number }) {
  const nowHour = Math.min(23, Math.max(0, Math.floor(now / 60)));
  const activeHours = HOURS.filter((h) => hourHits(marks, h).length > 0).length;

  return (
    <View style={st.wrap}>
      <View style={st.matrix}>
        {HOURS.map((h) => {
          const hits = hourHits(marks, h);
          const isNow = h === nowHour;
          const isPast = h < nowHour;
          return (
            <View key={h} style={st.col}>
              <View style={[st.nowCap, isNow && st.nowCapActive]} />
              <View
                style={[
                  st.slot,
                  isPast && st.slotPast,
                  isNow && st.slotNow,
                ]}
              >
                {hits.length > 0 ? (
                  hits.map((k) => (
                    <View
                      key={k}
                      style={[
                        st.segment,
                        { backgroundColor: moduleTone[k].hue },
                      ]}
                    />
                  ))
                ) : (
                  <View style={[st.emptyTick, isPast && st.emptyTickPast]} />
                )}
              </View>
            </View>
          );
        })}
      </View>

      <View style={st.axis}>
        {[0, 6, 12, 18, 23].map((h) => (
          <Text key={h} style={st.hour}>
            {String(h).padStart(2, "0")}:00
          </Text>
        ))}
      </View>

      <View style={st.legendRow}>
        <View style={st.legendGroup}>
          {ORDER.map((k) => (
            <View key={k} style={st.legendItem}>
              <View style={[st.legendSwatch, { backgroundColor: moduleTone[k].hue }]} />
              <Text style={st.legendText}>{moduleTone[k].name}</Text>
            </View>
          ))}
        </View>
        <Text style={st.coverageText}>活跃时段 {activeHours}/24H</Text>
      </View>
    </View>
  );
}

const st = StyleSheet.create({
  wrap: { gap: space.xs },
  matrix: {
    flexDirection: "row",
    alignItems: "stretch",
    gap: 3,
    height: 60,
    paddingTop: 2,
  },
  col: {
    flex: 1,
    alignItems: "center",
    gap: 3,
  },
  nowCap: {
    width: "100%",
    height: 3,
    borderRadius: 1.5,
    backgroundColor: "transparent",
  },
  nowCapActive: {
    backgroundColor: color.ink,
  },
  slot: {
    flex: 1,
    width: "100%",
    borderRadius: 3,
    backgroundColor: color.grid,
    overflow: "hidden",
    justifyContent: "center",
    gap: 1.5,
  },
  slotPast: {
    backgroundColor: color.sunken,
  },
  slotNow: {
    borderWidth: 1,
    borderColor: color.ink,
  },
  segment: {
    flex: 1,
    width: "100%",
  },
  emptyTick: {
    width: 2,
    height: "100%",
    alignSelf: "center",
    backgroundColor: color.line,
    opacity: 0.5,
  },
  emptyTickPast: {
    backgroundColor: color.lineStrong,
    opacity: 0.65,
  },
  axis: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingTop: 2,
  },
  hour: {
    fontSize: 10,
    color: color.inkFaint,
    fontFamily: mono,
    ...type.numeric,
  },
  legendRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: space.xs,
  },
  legendGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
  },
  legendItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  legendSwatch: {
    width: 8,
    height: 8,
    borderRadius: 2,
  },
  legendText: {
    fontSize: 11,
    fontWeight: "700",
    color: color.inkSoft,
  },
  coverageText: {
    fontSize: 11,
    color: color.inkFaint,
    fontFamily: mono,
    ...type.numeric,
  },
});
