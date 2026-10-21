import { Platform, type TextStyle, type ViewStyle } from "react-native";

// Warm paper in light mode; distinct paper, cards and raised controls in dark mode.
export const lightColor = {
  paper: "#F8F7F5",
  surface: "#FFFFFF",
  raised: "#FFFFFF",
  sunken: "#F0EFED",
  softSurface: "#FAFAFA",
  ink: "#1A1A1A",
  inkSoft: "#666666",
  inkFaint: "#6B6B6B",
  selection: "#1A1A1A2E",
  empty: "#E8E8E8",
  placeholder: "#858585",
  line: "#E3E3E3",
  lineStrong: "#D9D7D2",
  accent: "#1A1A1A",
  accentTint: "#F0EFED",
  pine: "#1A1A1A",
  pineTint: "#F0EFED",
  meal: "#E8A547",
  mealText: "#956118",
  mealTint: "#FFF3E0",
  mealBorder: "#F5E2C2",
  training: "#4A998A",
  trainingText: "#347567",
  trainingTint: "#EDF6F3",
  sleep: "#4854B8",
  sleepText: "#4854B8",
  sleepTint: "#EFF0FA",
  sleepBorder: "#E0E3F4",
  danger: "#C8372C",
  dangerTint: "#FFF0EC",
  onInk: "#FFFFFF",
  onMeal: "#402B0C",
  onTraining: "#08251F",
  onSleep: "#FFFFFF",
  video: "#000000",
};

export type ThemeColors = typeof lightColor;

export const darkColor: ThemeColors = {
  paper: "#141619",
  surface: "#1E2126",
  raised: "#2A2E35",
  sunken: "#101215",
  softSurface: "#252930",
  ink: "#F3F2EF",
  inkSoft: "#C1C4CB",
  inkFaint: "#A3A8B2",
  selection: "#F3F2EF3D",
  empty: "#353B44",
  placeholder: "#929AA6",
  line: "#363C46",
  lineStrong: "#4A5260",
  accent: "#F3F2EF",
  accentTint: "#30353E",
  pine: "#F3F2EF",
  pineTint: "#30353E",
  meal: "#E8B465",
  mealText: "#F2C785",
  mealTint: "#362B1D",
  mealBorder: "#665032",
  training: "#7BBEAD",
  trainingText: "#96D4C4",
  trainingTint: "#20352F",
  sleep: "#AEB7FF",
  sleepText: "#BBC2FF",
  sleepTint: "#292D48",
  sleepBorder: "#535D89",
  danger: "#FF9387",
  dangerTint: "#3B2324",
  onInk: "#17191C",
  onMeal: "#32230D",
  onTraining: "#102D25",
  onSleep: "#202541",
  video: "#000000",
};

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 48 };
export const radius = { input: 12, block: 16, pill: 999 };

const numeric: TextStyle = { fontVariant: ["tabular-nums"] };

function createType(color: ThemeColors) {
  return {
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
}

function createTheme(color: ThemeColors, dark: boolean) {
  return {
    color,
    type: createType(color),
    shadow: {
      card: {
        ...Platform.select({
          web: { boxShadow: dark ? "0 2px 10px rgba(0,0,0,0.22)" : "0 2px 8px rgba(0,0,0,0.04), 0 0 1px rgba(0,0,0,0.06)" },
          default: {
            elevation: dark ? 2 : 1,
            shadowColor: "#000000",
            shadowOpacity: dark ? 0.22 : 0.04,
            shadowRadius: 8,
            shadowOffset: { width: 0, height: 2 },
          },
        }),
      } satisfies ViewStyle,
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
