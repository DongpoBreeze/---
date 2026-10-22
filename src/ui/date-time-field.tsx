import React, { useEffect, useRef, useState } from "react";
import {
  Keyboard,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Field } from "./components";
import { parseDateTime } from "./format";
import { radius, space, type ThemeTokens } from "./theme";
import { useTheme, useThemedStyles } from "./theme-provider";

type DateTimeParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

type CalendarMonth = Pick<DateTimeParts, "year" | "month">;

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];
const OPTION_HEIGHT = 44;
const pad = (value: number) => String(value).padStart(2, "0");

function dateParts(date: Date): DateTimeParts {
  return {
    year: date.getFullYear(),
    month: date.getMonth(),
    day: date.getDate(),
    hour: date.getHours(),
    minute: date.getMinutes(),
  };
}

function initialParts(value: string, suggestedValue?: string): DateTimeParts {
  for (const candidate of [value, suggestedValue]) {
    if (!candidate) continue;
    try {
      return dateParts(new Date(parseDateTime(candidate)));
    } catch {
      // An incomplete manual entry should still open a usable picker.
    }
  }
  return dateParts(new Date());
}

function dateKey({ year, month, day }: Pick<DateTimeParts, "year" | "month" | "day">) {
  return `${String(year).padStart(4, "0")}-${pad(month + 1)}-${pad(day)}`;
}

function dateTimeText(parts: DateTimeParts) {
  return `${dateKey(parts)} ${pad(parts.hour)}:${pad(parts.minute)}`;
}

function calendarDays({ year, month }: CalendarMonth): Array<number | null> {
  // setFullYear also handles years 0000–0099, which the Date constructor remaps.
  const date = new Date(0);
  date.setHours(12, 0, 0, 0);
  date.setFullYear(year, month, 1);
  const weekday = date.getDay();
  date.setFullYear(year, month + 1, 0);
  const dayCount = date.getDate();
  return Array.from({ length: 42 }, (_, index) => {
    const day = index - weekday + 1;
    return day > 0 && day <= dayCount ? day : null;
  });
}

function adjacentMonth({ year, month }: CalendarMonth, offset: number): CalendarMonth {
  const index = year * 12 + month + offset;
  return { year: Math.floor(index / 12), month: ((index % 12) + 12) % 12 };
}

function TimeColumn({
  label,
  value,
  count,
  onChange,
}: {
  label: "小时" | "分钟";
  value: number;
  count: number;
  onChange: (value: number) => void;
}) {
  const styles = useThemedStyles(createStyles);
  const scroll = useRef<ScrollView>(null);
  const revealSelection = () => {
    scroll.current?.scrollTo({
      y: Math.max(0, value - 1) * OPTION_HEIGHT,
      animated: false,
    });
  };

  return (
    <View style={styles.timeColumn}>
      <Text style={styles.sectionLabel}>{label}</Text>
      <ScrollView
        ref={scroll}
        style={styles.timeOptions}
        nestedScrollEnabled
        showsVerticalScrollIndicator
        keyboardShouldPersistTaps="handled"
        onLayout={revealSelection}
        onContentSizeChange={revealSelection}
      >
        {Array.from({ length: count }, (_, option) => (
          <Pressable
            key={option}
            accessibilityRole="button"
            accessibilityLabel={`${label} ${pad(option)}`}
            accessibilityState={{ selected: option === value }}
            onPress={() => onChange(option)}
            style={({ pressed }) => [
              styles.timeOption,
              option === value && styles.selected,
              pressed && styles.pressed,
            ]}
          >
            <Text style={[styles.optionText, option === value && styles.selectedText]}>
              {pad(option)}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

/** A manual field with a separate, confirmable local date/time selection. */
export function DateTimeField({
  label,
  pickerLabel,
  value,
  onChangeText,
  placeholder,
  suggestedValue,
  disabled = false,
}: {
  label: string;
  pickerLabel: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  suggestedValue?: string;
  disabled?: boolean;
}) {
  const { color } = useTheme();
  const styles = useThemedStyles(createStyles);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(() => initialParts(value, suggestedValue));
  const [month, setMonth] = useState<CalendarMonth>(draft);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const openPicker = () => {
    if (disabled) return;
    Keyboard.dismiss();
    // Read current props on every opening; parent updates never reset an open draft.
    const next = initialParts(value, suggestedValue);
    setDraft(next);
    setMonth({ year: next.year, month: next.month });
    setOpen(true);
  };

  const closePicker = () => setOpen(false);
  const confirmPicker = () => {
    if (disabled) return;
    setOpen(false);
    onChangeText(dateTimeText(draft));
  };

  const days = calendarDays(month);
  const today = dateKey(dateParts(new Date()));

  return (
    <>
      <Field
        label={label}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        disabled={disabled}
        labelAccessory={(
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={pickerLabel}
            accessibilityState={{ disabled }}
            disabled={disabled}
            onPress={openPicker}
            hitSlop={4}
            style={({ pressed }) => [
              styles.openButton,
              pressed && styles.pressed,
              disabled && styles.disabled,
            ]}
          >
            <Ionicons name="calendar-outline" size={16} color={color.sleepText} />
            <Text style={styles.openText}>选择</Text>
          </Pressable>
        )}
      />

      {open && !disabled && (
        <Modal
          visible
          transparent
          animationType="fade"
          presentationStyle="overFullScreen"
          onRequestClose={closePicker}
        >
          <SafeAreaView style={styles.overlay}>
            <View
              testID="date-time-picker"
              accessibilityViewIsModal
              style={styles.dialog}
            >
              <View style={styles.header}>
                <Text style={styles.title}>{pickerLabel}</Text>
              </View>

              <ScrollView
                style={styles.body}
                contentContainerStyle={styles.bodyContent}
                keyboardShouldPersistTaps="handled"
                nestedScrollEnabled
              >
                <View style={styles.preview}>
                  <Text style={styles.sectionLabel}>已选时间</Text>
                  <Text accessibilityLiveRegion="polite" style={styles.previewValue}>
                    {dateTimeText(draft)}
                  </Text>
                </View>

                <View style={styles.monthHeader}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="上个月"
                    disabled={month.year === 0 && month.month === 0}
                    onPress={() => setMonth((current) => adjacentMonth(current, -1))}
                    style={({ pressed }) => [styles.monthButton, pressed && styles.pressed]}
                  >
                    <Ionicons name="chevron-back" size={20} color={color.ink} />
                  </Pressable>
                  <Text style={styles.monthTitle}>
                    {String(month.year).padStart(4, "0")}年 {month.month + 1}月
                  </Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="下个月"
                    disabled={month.year === 9999 && month.month === 11}
                    onPress={() => setMonth((current) => adjacentMonth(current, 1))}
                    style={({ pressed }) => [styles.monthButton, pressed && styles.pressed]}
                  >
                    <Ionicons name="chevron-forward" size={20} color={color.ink} />
                  </Pressable>
                </View>

                <View style={styles.weekRow}>
                  {WEEKDAYS.map((day) => <Text key={day} style={styles.weekday}>{day}</Text>)}
                </View>
                {Array.from({ length: 6 }, (_, week) => (
                  <View key={week} style={styles.weekRow}>
                    {days.slice(week * 7, week * 7 + 7).map((day, weekday) => {
                      if (day === null) return <View key={weekday} style={styles.daySlot} />;
                      const key = dateKey({ ...month, day });
                      const selected = key === dateKey(draft);
                      return (
                        <View key={weekday} style={styles.daySlot}>
                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={`选择日期 ${key}`}
                            accessibilityState={{ selected }}
                            onPress={() => setDraft((current) => ({ ...current, ...month, day }))}
                            style={({ pressed }) => [
                              styles.dayButton,
                              key === today && styles.today,
                              selected && styles.selected,
                              pressed && styles.pressed,
                            ]}
                          >
                            <Text style={[styles.dayText, selected && styles.selectedText]}>{day}</Text>
                          </Pressable>
                        </View>
                      );
                    })}
                  </View>
                ))}

                <View style={styles.timeRow}>
                  <TimeColumn
                    label="小时"
                    value={draft.hour}
                    count={24}
                    onChange={(hour) => setDraft((current) => ({ ...current, hour }))}
                  />
                  <TimeColumn
                    label="分钟"
                    value={draft.minute}
                    count={60}
                    onChange={(minute) => setDraft((current) => ({ ...current, minute }))}
                  />
                </View>
              </ScrollView>

              <View style={styles.footer}>
                <Pressable
                  accessibilityRole="button"
                  onPress={closePicker}
                  style={({ pressed }) => [styles.cancelButton, pressed && styles.pressed]}
                >
                  <Text style={styles.cancelText}>取消</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  onPress={confirmPicker}
                  style={({ pressed }) => [styles.confirmButton, pressed && styles.pressed]}
                >
                  <Text style={styles.confirmText}>确定时间</Text>
                </Pressable>
              </View>
            </View>
          </SafeAreaView>
        </Modal>
      )}
    </>
  );
}

function createStyles({ color, type, shadow }: ThemeTokens) {
  return StyleSheet.create({
    openButton: {
      minHeight: 36,
      paddingHorizontal: space.md,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 5,
      borderWidth: 1,
      borderColor: color.sleepBorder,
      borderRadius: radius.pill,
      backgroundColor: color.sleepTint,
    },
    openText: { color: color.sleepText, fontSize: 13, fontWeight: "700" },
    pressed: { opacity: 0.7 },
    disabled: { opacity: 0.45 },
    overlay: {
      flex: 1,
      padding: space.lg,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: "rgba(0, 0, 0, 0.48)",
    },
    dialog: {
      width: "100%",
      maxWidth: 480,
      maxHeight: "100%",
      flexShrink: 1,
      borderRadius: radius.block,
      borderWidth: 1,
      borderColor: color.line,
      backgroundColor: color.surface,
      overflow: "hidden",
      ...shadow.card,
    },
    header: { padding: space.lg, borderBottomWidth: 1, borderColor: color.line },
    title: { ...type.heading },
    body: { flexGrow: 0, flexShrink: 1, minHeight: 0 },
    bodyContent: { padding: space.lg },
    sectionLabel: { ...type.small, marginBottom: space.xs },
    preview: {
      padding: space.md,
      borderRadius: radius.input,
      backgroundColor: color.sleepTint,
      marginBottom: space.sm,
    },
    previewValue: { color: color.sleepText, fontSize: 21, lineHeight: 28, fontWeight: "800", ...type.mono },
    monthHeader: { flexDirection: "row", alignItems: "center", marginBottom: space.xs },
    monthButton: { width: 44, height: 44, justifyContent: "center", alignItems: "center" },
    monthTitle: { ...type.heading, flex: 1, minWidth: 0, textAlign: "center", ...type.numeric },
    weekRow: { flexDirection: "row" },
    weekday: { ...type.small, flex: 1, minWidth: 0, textAlign: "center", paddingVertical: space.xs },
    daySlot: { flex: 1, minWidth: 0, height: 44, padding: 2 },
    dayButton: {
      flex: 1,
      minWidth: 0,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: radius.input - 3,
      borderWidth: 1,
      borderColor: "transparent",
    },
    dayText: { color: color.ink, fontSize: 15, fontWeight: "500", ...type.numeric },
    today: { borderColor: color.sleep },
    selected: { backgroundColor: color.sleep, borderColor: color.sleep },
    selectedText: { color: color.onSleep, fontWeight: "800" },
    timeRow: { flexDirection: "row", gap: space.md, marginTop: space.md },
    timeColumn: { flex: 1, minWidth: 0 },
    timeOptions: {
      height: OPTION_HEIGHT * 4,
      borderWidth: 1,
      borderColor: color.line,
      borderRadius: radius.input,
      backgroundColor: color.paper,
    },
    timeOption: { height: OPTION_HEIGHT, alignItems: "center", justifyContent: "center" },
    optionText: { color: color.ink, fontSize: 18, lineHeight: 24, ...type.mono },
    footer: {
      flexDirection: "row",
      gap: space.sm,
      padding: space.lg,
      borderTopWidth: 1,
      borderColor: color.line,
    },
    cancelButton: {
      flex: 1,
      minWidth: 0,
      minHeight: 46,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: radius.pill,
      borderWidth: 1,
      borderColor: color.lineStrong,
      backgroundColor: "transparent",
    },
    cancelText: { ...type.label },
    confirmButton: {
      flex: 1,
      minWidth: 0,
      minHeight: 46,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: radius.pill,
      backgroundColor: color.sleep,
    },
    confirmText: { color: color.onSleep, fontSize: 14, fontWeight: "800" },
  });
}
