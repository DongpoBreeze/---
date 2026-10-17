import { Platform, type TextStyle } from "react-native";

// Health Compass v0.8 — "Biometric Protocol & Rhythm Matrix".
// Swiss clinical/habit ledger aesthetic: studio limestone canvas (#F4F5F7),
// pure alabaster cards (#FFFFFF), stark carbon ink (#0D1117), and three
// high-contrast signal channels: vermilion (meal), emerald (training), cobalt (sleep).
export const color = {
  paper: "#F4F5F7",
  surface: "#FFFFFF",
  raised: "#FFFFFF",
  sunken: "#EAECEF",
  ink: "#0D1117",
  inkSoft: "#4B5563",
  inkFaint: "#8B95A5",
  line: "#E2E6ED",
  lineStrong: "#C8D0DC",
  grid: "#EDF0F4",
  accent: "#0D1117",
  accentTint: "#EAECEF",
  pine: "#0D1117", // primary interactive ink alias
  pineTint: "#EAECEF",
  meal: "#D94E34",
  mealText: "#B83B24",
  mealTint: "#FDF0ED",
  mealLine: "#F5C6BC",
  training: "#0E9F6E",
  trainingText: "#097A54",
  trainingTint: "#ECFDF5",
  trainingLine: "#A7F3D0",
  sleep: "#2563EB",
  sleepText: "#1D4ED8",
  sleepTint: "#EFF6FF",
  sleepLine: "#BFDBFE",
  warn: "#D97706",
  warnTint: "#FEF3C7",
  danger: "#DC2626",
  dangerTint: "#FEF2F2",
  onInk: "#FFFFFF",
  video: "#0D1117",
};

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 48 };
export const radius = { input: 6, block: 10, pill: 999 };

export const sans = Platform.select({
  ios: "System",
  android: "sans-serif",
  default:
    '-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Noto Sans SC", system-ui, sans-serif',
});

export const mono = Platform.select({
  ios: "Menlo",
  android: "monospace",
  default:
    '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Noto Sans SC", monospace',
});

const numeric: TextStyle = { fontVariant: ["tabular-nums"], fontFamily: mono };

export const type = {
  display: { fontSize: 30, lineHeight: 36, fontWeight: "800", color: color.ink, letterSpacing: -0.6, fontFamily: sans } as TextStyle,
  title: { fontSize: 19, lineHeight: 25, fontWeight: "800", color: color.ink, letterSpacing: -0.2, fontFamily: sans } as TextStyle,
  heading: { fontSize: 15, lineHeight: 21, fontWeight: "700", color: color.ink, fontFamily: sans } as TextStyle,
  body: { fontSize: 15, lineHeight: 22, color: color.ink, fontFamily: sans } as TextStyle,
  bodySoft: { fontSize: 14, lineHeight: 21, color: color.inkSoft, fontFamily: sans } as TextStyle,
  small: { fontSize: 12, lineHeight: 18, color: color.inkSoft, fontFamily: sans } as TextStyle,
  label: { fontSize: 14, lineHeight: 20, fontWeight: "700", color: color.ink, fontFamily: sans } as TextStyle,
  caption: { fontSize: 11, lineHeight: 14, fontWeight: "700", letterSpacing: 1.2, color: color.inkFaint, fontFamily: mono } as TextStyle,
  reading: { fontSize: 30, lineHeight: 34, fontWeight: "800", color: color.ink, ...numeric } as TextStyle,
  numeric,
};

export const moduleTone = {
  meal: { name: "饮食", code: "01 / NUTR", hue: color.meal, text: color.mealText, tint: color.mealTint, line: color.mealLine, icon: "restaurant-outline" as const },
  training: { name: "训练", code: "02 / TRNG", hue: color.training, text: color.trainingText, tint: color.trainingTint, line: color.trainingLine, icon: "barbell-outline" as const },
  sleep: { name: "睡眠", code: "03 / REST", hue: color.sleep, text: color.sleepText, tint: color.sleepTint, line: color.sleepLine, icon: "moon-outline" as const },
};

export type ModuleKind = keyof typeof moduleTone;
