import React, { useEffect, useRef } from "react";
import {
  AccessibilityInfo,
  Animated,
  Easing,
  LayoutAnimation,
  Platform,
  Pressable,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from "react-native";

// Native drivers are unavailable on web; react-native-web falls back to JS timing.
const native = Platform.OS !== "web";
let reduceMotion = false;
void AccessibilityInfo.isReduceMotionEnabled?.()
  .then((value) => { reduceMotion = value; })
  .catch(() => undefined);

export const motion = {
  fast: 160,
  base: 240,
  slow: 360,
  stagger: 55,
  ease: Easing.bezier(0.2, 0.8, 0.2, 1),
};

/** Animates the next layout pass (expand/collapse, list insert/remove). */
export function animateLayout(duration = motion.base) {
  if (!native || reduceMotion) return;
  LayoutAnimation.configureNext({
    duration,
    create: { type: "easeInEaseOut", property: "opacity" },
    update: { type: "easeInEaseOut" },
    delete: { type: "easeInEaseOut", property: "opacity" },
  });
}

/** Fades and lifts content in once on mount; `index` staggers siblings. */
export function Reveal({ index = 0, distance = 14, style, children }: {
  index?: number;
  distance?: number;
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
}) {
  const value = useRef(new Animated.Value(reduceMotion ? 1 : 0)).current;
  useEffect(() => {
    if (reduceMotion) return;
    const animation = Animated.timing(value, {
      toValue: 1,
      duration: motion.slow,
      delay: Math.min(index, 8) * motion.stagger,
      easing: motion.ease,
      useNativeDriver: native,
    });
    animation.start();
    return () => animation.stop();
  }, [index, value]);
  return (
    <Animated.View
      // Fade the card, its contents and its elevation shadow as one group on Android.
      // Per-child alpha exposes the shadow beneath the translucent card surface.
      needsOffscreenAlphaCompositing={Platform.OS === "android"}
      style={[style, {
        opacity: value,
        transform: [{ translateY: value.interpolate({ inputRange: [0, 1], outputRange: [distance, 0] }) }],
      }]}
    >
      {children}
    </Animated.View>
  );
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/** Pressable with a short spring scale on touch, used for cards and primary actions. */
export function PressScale({ style, children, scaleTo = 0.97, ...props }: Omit<PressableProps, "style" | "children"> & {
  style?: StyleProp<ViewStyle>;
  scaleTo?: number;
  children: React.ReactNode;
}) {
  const scale = useRef(new Animated.Value(1)).current;
  const to = (toValue: number) => Animated.spring(scale, {
    toValue, useNativeDriver: native, speed: 40, bounciness: toValue === 1 ? 6 : 0,
  }).start();
  return (
    <AnimatedPressable
      {...props}
      onPressIn={(event) => { if (!reduceMotion) to(scaleTo); props.onPressIn?.(event); }}
      onPressOut={(event) => { to(1); props.onPressOut?.(event); }}
      style={[style, { transform: [{ scale }] }]}
    >
      {children}
    </AnimatedPressable>
  );
}

/** Tweens a JS-driven value towards `target`; starts at `from` so bars and meters grow in on mount. */
export function useTween(target: number, { duration = motion.slow * 2, delay = 0, from = 0 } = {}) {
  const value = useRef(new Animated.Value(reduceMotion ? target : from)).current;
  useEffect(() => {
    if (reduceMotion) { value.setValue(target); return; }
    const animation = Animated.timing(value, { toValue: target, duration, delay, easing: motion.ease, useNativeDriver: false });
    animation.start();
    return () => animation.stop();
  }, [target, duration, delay, value]);
  return value;
}

/** Springs a native-driven value to `target` (sliding indicators, toggles). */
export function useSpring(target: number) {
  const value = useRef(new Animated.Value(target)).current;
  useEffect(() => {
    if (reduceMotion) { value.setValue(target); return; }
    const animation = Animated.spring(value, { toValue: target, useNativeDriver: native, speed: 18, bounciness: 5 });
    animation.start();
    return () => animation.stop();
  }, [target, value]);
  return value;
}
