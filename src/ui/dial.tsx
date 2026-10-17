import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { color, moduleTone, type } from "./theme";
import type { Kind } from "./app-types";

export type DialMark = { kind: Kind; start: number; end?: number };

const SLOTS = 96; // 15-minute segments around the face

/**
 * A 24-hour clock face drawn from plain Views (no SVG dependency).
 * Midnight sits at the top; each segment lights in the colour of the module
 * recorded in that quarter hour. Point events (meals) light one segment.
 */
export function Dial({ size, marks, now, children }: {
  size: number;
  marks: DialMark[];
  now: number;
  children?: React.ReactNode;
}) {
  const slot = (minute: number) => Math.floor(Math.min(1439, Math.max(0, minute)) / 15);
  const fill: Array<Kind | null> = Array(SLOTS).fill(null);
  // Paint long spans first so point events stay visible on top.
  const order: Kind[] = ["sleep", "training", "meal"];
  order.forEach((kind) => {
    marks.filter((m) => m.kind === kind).forEach((m) => {
      const a = slot(m.start);
      const b = m.end === undefined ? a : slot(Math.max(m.start, m.end - 1));
      if (m.end !== undefined && m.end <= 0) return;
      if (m.start >= 1440) return;
      for (let i = a; i <= b; i++) fill[i] = kind;
    });
  });
  const r = size / 2;
  const seg = Math.max(3, size * 0.022);
  const len = size * 0.09;
  const nowSlot = slot(now);
  return (
    <View style={{ width: size, height: size }}>
      {fill.map((kind, i) => {
        const angle = (i / SLOTS) * 360;
        const lit = kind !== null;
        return (
          <View
            key={i}
            style={[
              st.seg,
              {
                width: seg,
                height: lit ? len : len * 0.55,
                left: r - seg / 2,
                top: lit ? 0 : len * 0.225,
                borderRadius: seg / 2,
                backgroundColor: lit ? moduleTone[kind!].hue : i % 4 === 0 ? color.lineStrong : color.line,
                transformOrigin: `${seg / 2}px ${lit ? r : r - len * 0.225}px`,
                transform: [{ rotate: `${angle}deg` }],
              },
            ]}
          />
        );
      })}
      <View
        style={[
          st.needle,
          {
            left: r - 1.5,
            top: len + 6,
            height: r - len - 6 - size * 0.27,
            transformOrigin: `1.5px ${r - len - 6}px`,
            transform: [{ rotate: `${(nowSlot / SLOTS) * 360}deg` }],
          },
        ]}
      />
      {[["0", 0], ["6", 90], ["12", 180], ["18", 270]].map(([label, deg]) => {
        const rad = ((Number(deg) - 90) * Math.PI) / 180;
        const d = r - len - 16;
        return (
          <Text
            key={label}
            style={[st.hour, { left: r + Math.cos(rad) * d - 12, top: r + Math.sin(rad) * d - 9 }]}
          >
            {label}
          </Text>
        );
      })}
      <View style={[StyleSheet.absoluteFill, st.center]} pointerEvents="box-none">
        {children}
      </View>
    </View>
  );
}

const st = StyleSheet.create({
  seg: { position: "absolute" },
  needle: { position: "absolute", width: 3, borderRadius: 2, backgroundColor: color.pine },
  hour: { position: "absolute", width: 24, textAlign: "center", fontSize: 11, color: color.inkFaint, ...type.numeric },
  center: { alignItems: "center", justifyContent: "center" },
});
