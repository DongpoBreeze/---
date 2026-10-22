import { Platform, type TextStyle, type ViewStyle } from "react-native";

// v0.10d "Daily Protocol": warm paper in light mode, graphite paper in dark mode.
export const lightColor = {
  paper: "#F8F7F5",
  surface: "#FFFFFF",
  raised: "#FFFFFF",
  sunken: "#F0EFE8",
  softSurface: "#FAFAF8",
  ink: "#1A1A1A",
  inkSoft: "#5F5E5A",
  inkFaint: "#6F6E69",
  selection: "#1A1A1A2E",
  empty: "#E8E7E0",
  placeholder: "#858480",
  line: "#E8E7E0",
  lineStrong: "#D9D7D0",
  accent: "#1A1A1A",
  accentTint: "#F0EFE8",
  pine: "#1A1A1A",
  pineTint: "#F0EFE8",
  meal: "#E8A547",
  mealText: "#956118",
  mealTint: "#FBEFD9",
  mealBorder: "#F2DDB5",
  training: "#4A998A",
  trainingText: "#347567",
  trainingTint: "#E3F1EE",
  sleep: "#4854B8",
  sleepText: "#4854B8",
  sleepTint: "#E8EAF6",
  sleepBorder: "#D7DBF1",
  danger: "#C8372C",
  dangerTint: "#FFF0EC",
  now: "#D9583C",
  navBg: "rgba(255,255,255,0.94)",
  slot: "rgba(232,165,71,0.08)",
  slotPast: "rgba(232,165,71,0.14)",
  highlight: "rgba(0,0,0,0.035)",
  onInk: "#FFFFFF",
  onMeal: "#1A1408",
  onTraining: "#08251F",
  onSleep: "#FFFFFF",
  video: "#000000",
};

export type ThemeColors = typeof lightColor;

export const darkColor: ThemeColors = {
  paper: "#111317",
  surface: "#1A1D22",
  raised: "#23272E",
  sunken: "#23272E",
  softSurface: "#1F2228",
  ink: "#F2EFE8",
  inkSoft: "#A9A69E",
  inkFaint: "#8A877F",
  selection: "#F2EFE83D",
  empty: "#2A2E35",
  placeholder: "#8A877F",
  line: "#2A2E35",
  lineStrong: "#3A3F48",
  accent: "#F2EFE8",
  accentTint: "#23272E",
  pine: "#F2EFE8",
  pineTint: "#23272E",
  meal: "#E8A547",
  mealText: "#F0BC6E",
  mealTint: "#2B251D",
  mealBorder: "#5A4528",
  training: "#5BBFA9",
  trainingText: "#7FD3C0",
  trainingTint: "#1A2829",
  sleep: "#8E98EC",
  sleepText: "#A9B1F2",
  sleepTint: "#202331",
  sleepBorder: "#434A7A",
  danger: "#FF9387",
  dangerTint: "#3B2324",
  now: "#F07A5E",
  navBg: "rgba(26,29,34,0.92)",
  slot: "rgba(255,255,255,0.04)",
  slotPast: "rgba(255,255,255,0.07)",
  highlight: "rgba(255,255,255,0.04)",
  onInk: "#17191C",
  onMeal: "#1A1408",
  onTraining: "#0B231E",
  onSleep: "#151833",
  video: "#000000",
};

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 48 };
export const radius = { input: 12, block: 16, pill: 999 };

const numeric: TextStyle = { fontVariant: ["tabular-nums"] };
const monoFamily = Platform.select({ ios: "Menlo", android: "monospace", default: '"SF Mono", Consolas, monospace' });

function createType(color: ThemeColors) {
  return {
    display: { fontSize: 26, lineHeight: 32, fontWeight: "800", color: color.ink, letterSpacing: -0.4 } as TextStyle,
    title: { fontSize: 22, lineHeight: 28, fontWeight: "800", color: color.ink } as TextStyle,
    heading: { fontSize: 16, lineHeight: 22, fontWeight: "800", color: color.ink } as TextStyle,
    body: { fontSize: 15, lineHeight: 24, color: color.ink } as TextStyle,
    bodySoft: { fontSize: 14, lineHeight: 22, color: color.inkSoft } as TextStyle,
    small: { fontSize: 12.5, lineHeight: 19, color: color.inkSoft } as TextStyle,
    label: { fontSize: 14, lineHeight: 20, fontWeight: "700", color: color.ink } as TextStyle,
    reading: { fontSize: 30, lineHeight: 34, fontWeight: "800", color: color.ink, fontFamily: monoFamily, ...numeric } as TextStyle,
    cap: { fontSize: 10, lineHeight: 14, fontWeight: "800", letterSpacing: 1.2, color: color.inkFaint } as TextStyle,
    mono: { fontFamily: monoFamily, ...numeric } as TextStyle,
    numeric,
  };
}

function createTheme(color: ThemeColors, dark: boolean) {
  return {
    color,
    dark,
    type: createType(color),
    shadow: {
      card: (Platform.OS === "web"
        ? { boxShadow: dark ? "none" : "0 2px 8px rgba(0,0,0,0.04)" }
        : dark
          ? { elevation: 0 }
          : {
              elevation: 1,
              shadowColor: "#000000",
              shadowOpacity: 0.04,
              shadowRadius: 8,
              shadowOffset: { width: 0, height: 2 },
            }) as ViewStyle,
    },
    moduleTone: {
      meal: { name: "饮食", hue: color.meal, text: color.mealText, tint: color.mealTint, onHue: color.onMeal, icon: "restaurant-outline" as const },
      training: { name: "训练", hue: color.training, text: color.trainingText, tint: color.trainingTint, onHue: color.onTraining, icon: "barbell-outline" as const },
      sleep: { name: "睡眠", hue: color.sleep, text: color.sleepText, tint: color.sleepTint, onHue: color.onSleep, icon: "moon-outline" as const },
    },
  };
}

export type ThemeTokens = ReturnType<typeof createTheme>;
export type ModuleKind = keyof ThemeTokens["moduleTone"];
export const lightTheme: ThemeTokens = createTheme(lightColor, false);
export const darkTheme: ThemeTokens = createTheme(darkColor, true);
export const themes = { light: lightTheme, dark: darkTheme };

// Compatibility for static consumers; rendered UI uses the provider hooks.
export const { color, type, shadow, moduleTone } = lightTheme;
