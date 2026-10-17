import type { TextStyle } from "react-native";

// Health Compass v0.5 — "daytime topography". A warm ivory environment where
// data layers rise from base terrain: meal = terracotta, training = bronze-green,
// sleep = amber-gold. Elevation, not color saturation, carries hierarchy.
// `ink` is the dark text; `onInk` is light text used on strong fills.
export const color = {
  paper: "#FBF9F6",
  surface: "#F5F2ED",
  raised: "#EAE5DD",
  sunken: "#F0EBE3",
  ink: "#2A2420",
  inkSoft: "#6B6258",
  inkFaint: "#9D9488",
  line: "#E0DAD0",
  lineStrong: "#D0C8BA",
  accent: "#5A8A6F",
  accentTint: "#EBF3EE",
  pine: "#5A8A6F", // alias for accent (backward compat)
  pineTint: "#EBF3EE", // alias for accentTint (backward compat)
  meal: "#C8593E",
  mealText: "#A8422A",
  mealTint: "#F9EBE7",
  training: "#5A8A6F",
  trainingText: "#3D6B51",
  trainingTint: "#E8F0EC",
  sleep: "#E09C3E",
  sleepText: "#B57A28",
  sleepTint: "#FCF4E8",
  danger: "#D94F3E",
  dangerTint: "#FCEBE8",
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

export type ModuleKind = "meal" | "training" | "sleep";
export const moduleTone: Record<ModuleKind, { hue: string; text: string; tint: string; icon: "restaurant-outline" | "barbell-outline" | "moon-outline"; name: string }> = {
  meal: { hue: color.meal, text: color.mealText, tint: color.mealTint, icon: "restaurant-outline", name: "饮食" },
  training: { hue: color.training, text: color.trainingText, tint: color.trainingTint, icon: "barbell-outline", name: "训练" },
  sleep: { hue: color.sleep, text: color.sleepText, tint: color.sleepTint, icon: "moon-outline", name: "睡眠" },
};
