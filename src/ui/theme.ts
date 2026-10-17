import type { TextStyle } from "react-native";

// Health Compass v0.6 — "deep night gauge refined". Six-level deep surfaces
// (05070C→2A3447) with precise luminous module hues: amber #F59E42 (meal),
// cyan-teal #4ECDC4 (training), periwinkle #A78BFA (sleep).
// 24-hour dial returns as the core metaphor.
export const color = {
  paper: "#05070C",
  surface: "#0F131C",
  raised: "#161D2B",
  sunken: "#0A0D14",
  ink: "#E8EBF0",
  inkSoft: "#B4BAC5",
  inkFaint: "#6B7280",
  line: "#1A202E",
  lineStrong: "#2D3648",
  accent: "#4ECDC4",
  accentTint: "#1A2E2C",
  pine: "#4ECDC4", // alias for accent (backward compat)
  pineTint: "#1A2E2C", // alias for accentTint (backward compat)
  meal: "#E8A547",
  mealText: "#E8A547",
  mealTint: "#2A1F0F",
  training: "#4A998A",
  trainingText: "#4A998A",
  trainingTint: "#1A2E2C",
  sleep: "#8B9FED",
  sleepText: "#8B9FED",
  sleepTint: "#1E2238",
  danger: "#F87171",
  dangerTint: "#3A1F1F",
  onInk: "#FFFFFF",
  video: "#000000",
};

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 48 };
export const radius = { input: 12, block: 16, pill: 999 };

const numeric: TextStyle = { fontVariant: ["tabular-nums"] };

export const type = {
  display: { fontSize: 32, lineHeight: 38, fontWeight: "800", color: color.ink, letterSpacing: -0.6 } as TextStyle,
  title: { fontSize: 22, lineHeight: 28, fontWeight: "700", color: color.ink } as TextStyle,
  heading: { fontSize: 17, lineHeight: 24, fontWeight: "700", color: color.ink } as TextStyle,
  body: { fontSize: 15, lineHeight: 24, color: color.ink } as TextStyle,
  bodySoft: { fontSize: 15, lineHeight: 24, color: color.inkSoft } as TextStyle,
  small: { fontSize: 13, lineHeight: 19, color: color.inkSoft } as TextStyle,
  label: { fontSize: 14, lineHeight: 20, fontWeight: "600", color: color.ink } as TextStyle,
  reading: { fontSize: 36, lineHeight: 40, fontWeight: "800", color: color.ink, ...numeric } as TextStyle,
  numeric,
};

export const moduleTone = {
  meal: { name: "饮食", hue: color.meal, text: color.mealText, tint: color.mealTint, icon: "restaurant-outline" as const },
  training: { name: "训练", hue: color.training, text: color.trainingText, tint: color.trainingTint, icon: "barbell-outline" as const },
  sleep: { name: "睡眠", hue: color.sleep, text: color.sleepText, tint: color.sleepTint, icon: "moon-outline" as const },
};

export type ModuleKind = keyof typeof moduleTone;
