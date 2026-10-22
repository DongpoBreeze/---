import React, { createContext, useContext, useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Appearance, AppState, Platform, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { StatusBar } from "expo-status-bar";
import * as SystemUI from "expo-system-ui";
import { APPEARANCE_KEY, resolveAppearanceScheme, type AppearanceMode, type AppearanceScheme } from "../appearance";
import { createAppearanceStore, type AppearanceStorage } from "../appearance-store";
import { themes, type ThemeTokens } from "./theme";

type ThemeContextValue = ThemeTokens & {
  mode: AppearanceMode;
  scheme: AppearanceScheme;
  ready: boolean;
  saving: boolean;
  error: string;
  setMode: (mode: AppearanceMode) => Promise<void>;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

function appearanceStorage(): AppearanceStorage {
  if (Platform.OS === "web") {
    const read = () => window.localStorage.getItem(APPEARANCE_KEY);
    return {
      read: async () => read(),
      readSync: read,
      write: async (value) => { window.localStorage.setItem(APPEARANCE_KEY, value); },
    };
  }
  return {
    read: () => AsyncStorage.getItem(APPEARANCE_KEY),
    write: (value) => AsyncStorage.setItem(APPEARANCE_KEY, value),
  };
}

function systemScheme(): AppearanceScheme {
  return Appearance.getColorScheme() === "dark" ? "dark" : "light";
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [store] = useState(() => createAppearanceStore(appearanceStorage()));
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [system, setSystem] = useState(systemScheme);
  const scheme = resolveAppearanceScheme(state.mode, system);
  const tokens = themes[scheme];

  useEffect(() => { void store.load(); }, [store]);
  useEffect(() => {
    // Keep Appearance as the actual system source. Calling setColorScheme here
    // would also override its events, so returning to "system" could use stale data.
    const appearance = Appearance.addChangeListener(({ colorScheme }) => {
      setSystem(colorScheme === "dark" ? "dark" : "light");
    });
    const active = AppState.addEventListener("change", (status) => {
      if (status === "active") setSystem(systemScheme());
    });
    setSystem(systemScheme());
    return () => { appearance.remove(); active.remove(); };
  }, []);

  useLayoutEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return;
    document.documentElement.style.colorScheme = scheme;
    document.documentElement.style.backgroundColor = tokens.color.paper;
    document.body.style.colorScheme = scheme;
    document.body.style.backgroundColor = tokens.color.paper;
  }, [scheme, tokens]);

  useEffect(() => {
    if (Platform.OS === "web" || !state.ready) return;
    // A failed platform background update must not roll back the saved preference.
    void SystemUI.setBackgroundColorAsync(tokens.color.paper).catch(() => undefined);
  }, [state.ready, tokens]);

  const value = useMemo<ThemeContextValue>(() => ({
    ...tokens, ...state, scheme, setMode: store.setMode,
  }), [tokens, state, scheme, store]);

  return (
    <ThemeContext.Provider value={value}>
      <StatusBar style={scheme === "dark" ? "light" : "dark"} />
      {/* Mount app state once hydration is complete, then keep it mounted on every theme change. */}
      {state.ready ? children : <View style={{ flex: 1, backgroundColor: tokens.color.paper }} />}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("ThemeProvider is required for themed UI.");
  return value;
}

export function useThemedStyles<T>(factory: (theme: ThemeTokens) => T): T {
  const { scheme } = useTheme();
  const tokens = themes[scheme];
  return useMemo(() => factory(tokens), [factory, tokens]);
}
