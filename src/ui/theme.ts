import { Platform, type TextStyle } from "react-native";

// Health Compass v0.8 — "night compass". A dark instrument panel: deep
// blue-black deck, warm amber needle as the brand accent, and three luminous
// channels — coral (meal), jade (training), periwinkle (sleep).
export const color = {
  paper: "#0C1118",
  surface: "#131B25",
  raised: "#1B2531",
  sunken: "#080C11",
  ink: "#EDEAE2",
  inkSoft: "#9AA5B2",
  inkFaint: "#5C6774",
  line: "#222D3B",
  lineStrong: "#35424F",
  grid: "#1A2430",
  accent: "#E8A33D",
  accentTint: "#2B2210",
  pine: "#E8A33D", // alias for accent (backward compat)
  pineTint: "#2B2210", // alias for accentTint (backward compat)
  meal: "#E0654F",
  mealText: "#F08A76",
  mealTint: "#2B1713",
  mealLine: "#4E2A22",
  training: "#3FA97C",
  trainingText: "#63C69B",
  trainingTint: "#10231B",
  trainingLine: "#1F4434",
  sleep: "#6E8FE0",
  sleepText: "#93ACEC",
  sleepTint: "#151D31",
  sleepLine: "#2A3858",
  danger: "#E05C4F",
  dangerTint: "#2C1512",
  onInk: "#0C1118",
  video: "#000000",
};

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 48 };
export const radius = { input: 10, block: 14, pill: 999 };

export const mono = Platform.select({
  ios: "Menlo",
  android: "monospace",
  default: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
});

const numeric: TextStyle = { fontVariant: ["tabular-nums"], fontFamily: mono };

export const type = {
  display: { fontSize: 32, lineHeight: 38, fontWeight: "800", color: color.ink, letterSpacing: -0.5 } as TextStyle,
  title: { fontSize: 20, lineHeight: 26, fontWeight: "700", color: color.ink } as TextStyle,
  heading: { fontSize: 16, lineHeight: 22, fontWeight: "700", color: color.ink } as TextStyle,
  body: { fontSize: 15, lineHeight: 23, color: color.ink } as TextStyle,
  bodySoft: { fontSize: 15, lineHeight: 23, color: color.inkSoft } as TextStyle,
  small: { fontSize: 13, lineHeight: 19, color: color.inkSoft } as TextStyle,
  label: { fontSize: 14, lineHeight: 20, fontWeight: "600", color: color.ink } as TextStyle,
  caption: { fontSize: 11, lineHeight: 14, fontWeight: "700", letterSpacing: 1.6, color: color.inkFaint, fontFamily: mono } as TextStyle,
  reading: { fontSize: 32, lineHeight: 36, fontWeight: "700", color: color.ink, ...numeric } as TextStyle,
  numeric,
};

export const moduleTone = {
  meal: { name: "饮食", hue: color.meal, text: color.mealText, tint: color.mealTint, line: color.mealLine, icon: "restaurant-outline" as const },
  training: { name: "训练", hue: color.training, text: color.trainingText, tint: color.trainingTint, line: color.trainingLine, icon: "barbell-outline" as const },
  sleep: { name: "睡眠", hue: color.sleep, text: color.sleepText, tint: color.sleepTint, line: color.sleepLine, icon: "moon-outline" as const },
};

export type ModuleKind = keyof typeof moduleTone;
