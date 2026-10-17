import { Platform, type TextStyle } from "react-native";

// Health Compass v0.7 — "chart recorder". Pale graph paper, navy recorder ink,
// and three pen channels: recorder red (meal), field green (training),
// chart blue (sleep). The 24-hour tape replaces the circular dial.
export const color = {
  paper: "#F2F4F1",
  surface: "#FBFCFA",
  raised: "#FFFFFF",
  sunken: "#E6EAE5",
  ink: "#17202B",
  inkSoft: "#4A5563",
  inkFaint: "#7C8692",
  line: "#DCE2DC",
  lineStrong: "#B9C3BB",
  grid: "#E3E8E2",
  accent: "#17202B",
  accentTint: "#E4E8EC",
  pine: "#17202B", // alias for accent (backward compat)
  pineTint: "#E4E8EC", // alias for accentTint (backward compat)
  meal: "#C8372D",
  mealText: "#A82C23",
  mealTint: "#F7E4E1",
  mealLine: "#E8B4AE",
  training: "#1E7A4F",
  trainingText: "#17653F",
  trainingTint: "#DFEFE6",
  trainingLine: "#A8D2BB",
  sleep: "#2D4FB3",
  sleepText: "#24439C",
  sleepTint: "#E2E8F7",
  sleepLine: "#B0C0EA",
  danger: "#B42318",
  dangerTint: "#FBE3E0",
  onInk: "#FFFFFF",
  video: "#000000",
};

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 48 };
export const radius = { input: 8, block: 10, pill: 999 };

export const mono = Platform.select({
  ios: "Menlo",
  android: "monospace",
  default: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
});

const numeric: TextStyle = { fontVariant: ["tabular-nums"], fontFamily: mono };

export const type = {
  display: { fontSize: 30, lineHeight: 36, fontWeight: "800", color: color.ink, letterSpacing: -0.4 } as TextStyle,
  title: { fontSize: 20, lineHeight: 26, fontWeight: "700", color: color.ink } as TextStyle,
  heading: { fontSize: 16, lineHeight: 22, fontWeight: "700", color: color.ink } as TextStyle,
  body: { fontSize: 15, lineHeight: 23, color: color.ink } as TextStyle,
  bodySoft: { fontSize: 15, lineHeight: 23, color: color.inkSoft } as TextStyle,
  small: { fontSize: 13, lineHeight: 19, color: color.inkSoft } as TextStyle,
  label: { fontSize: 14, lineHeight: 20, fontWeight: "600", color: color.ink } as TextStyle,
  caption: { fontSize: 11, lineHeight: 14, fontWeight: "700", letterSpacing: 1, color: color.inkFaint, fontFamily: mono } as TextStyle,
  reading: { fontSize: 32, lineHeight: 36, fontWeight: "700", color: color.ink, ...numeric } as TextStyle,
  numeric,
};

export const moduleTone = {
  meal: { name: "饮食", hue: color.meal, text: color.mealText, tint: color.mealTint, line: color.mealLine, icon: "restaurant-outline" as const },
  training: { name: "训练", hue: color.training, text: color.trainingText, tint: color.trainingTint, line: color.trainingLine, icon: "barbell-outline" as const },
  sleep: { name: "睡眠", hue: color.sleep, text: color.sleepText, tint: color.sleepTint, line: color.sleepLine, icon: "moon-outline" as const },
};

export type ModuleKind = keyof typeof moduleTone;
