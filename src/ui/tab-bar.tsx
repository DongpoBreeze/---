import React, { useState } from "react";
import { Animated, Platform, Pressable, StyleSheet, Text, View, type ViewStyle } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { Tab } from "./app-types";
import type { ThemeTokens } from "./theme";
import { useTheme, useThemedStyles } from "./theme-provider";
import { useSpring } from "./motion";

export const TABS: Tab[] = ["today", "trends", "me", "settings"];
const TAB_ITEMS = {
  today: ["today", "today-outline", "今天"],
  trends: ["stats-chart", "stats-chart-outline", "趋势"],
  me: ["person", "person-outline", "我的"],
  settings: ["settings", "settings-outline", "设置"],
} as const;
export const tabLabel = (tab: Tab) => TAB_ITEMS[tab][2];
const NAV_PAD = 6;

/** Floating bottom tab bar with a sliding indicator behind the active tab. */
export function TabBar({ tab, bottom, onChange }: { tab: Tab; bottom: number; onChange: (tab: Tab) => void }) {
  const styles = useThemedStyles(createStyles);
  const [navWidth, setNavWidth] = useState(0);
  const navOffset = useSpring(TABS.indexOf(tab));
  const slot = (navWidth - NAV_PAD * 2) / TABS.length;
  return (
    <View style={[styles.navWrap, { bottom }]} pointerEvents="box-none">
      <View style={styles.nav} accessibilityRole="tablist" onLayout={(event) => setNavWidth(event.nativeEvent.layout.width)}>
        {navWidth > 0 && (
          <Animated.View
            pointerEvents="none"
            style={[styles.navIndicator, {
              width: slot,
              transform: [{ translateX: navOffset.interpolate({ inputRange: [0, 1], outputRange: [0, slot] }) }],
            }]}
          />
        )}
        {TABS.map((item) => (
          <NavItem key={item} tab={item} active={tab === item} onPress={() => onChange(item)} />
        ))}
      </View>
    </View>
  );
}

function NavItem({ tab, active, onPress }: { tab: Tab; active: boolean; onPress: () => void }) {
  const { color } = useTheme();
  const styles = useThemedStyles(createStyles);
  const [activeIcon, icon, label] = TAB_ITEMS[tab];
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.navItem, pressed && !active && { opacity: 0.6 }]}
      accessibilityRole="tab"
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
    >
      <Ionicons name={active ? activeIcon : icon} size={18} color={active ? color.paper : color.inkFaint} />
      <Text style={[styles.navLabel, active && styles.navActive]}>{label}</Text>
    </Pressable>
  );
}

function createStyles({ color }: ThemeTokens) {
  return StyleSheet.create({
    navWrap: {
      position: "absolute", left: 14, right: 14, alignItems: "center",
    },
    nav: {
      width: "100%", maxWidth: 440, height: 64, flexDirection: "row", alignItems: "center",
      padding: NAV_PAD, borderRadius: 24, backgroundColor: color.navBg, borderWidth: 1, borderColor: color.line,
      ...(Platform.OS === "web" ? { backdropFilter: "blur(12px)" } : {}),
    } as ViewStyle,
    navItem: {
      flex: 1, height: "100%", alignItems: "center", justifyContent: "center", gap: 2,
    },
    navIndicator: {
      position: "absolute", left: NAV_PAD, top: NAV_PAD, bottom: NAV_PAD, borderRadius: 18, backgroundColor: color.ink,
    },
    navLabel: { color: color.inkFaint, fontSize: 10, lineHeight: 13, fontWeight: "700" },
    navActive: { color: color.paper },
  });
}
