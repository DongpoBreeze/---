import { Alert, Platform } from "react-native";
import { localDate, recordLocalDate, sleepStats } from "../domain";
import type { MealRecord, SleepRecord, TrainingRecord } from "../types";

export const today = () => localDate();

export const errorText = (e: unknown) =>
  e instanceof Error ? e.message : "操作失败，请稍后重试。";

export function confirmAction(
  title: string,
  message: string,
  action: string,
  onConfirm: () => void,
  destructive = false,
) {
  if (Platform.OS === "web") {
    if (window.confirm(`${title}\n\n${message}`)) onConfirm();
    return;
  }
  Alert.alert(title, message, [
    { text: "取消", style: "cancel" },
    {
      text: action,
      style: destructive ? "destructive" : "default",
      onPress: onConfirm,
    },
  ]);
}

export function notify(title: string, message: string) {
  if (Platform.OS === "web") window.alert(`${title}\n\n${message}`);
  else Alert.alert(title, message);
}

export const localDateTime = (value?: string) => {
  if (!value) return "";
  const d = new Date(value);
  return Number.isFinite(d.getTime())
    ? `${localDate(d)} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
    : "";
};

export function parseDateTime(value: string) {
  const normalized = value.trim().replace("T", " ");
  if (!/^\d{4}-\d{2}-\d{2} ([01]\d|2[0-3]):[0-5]\d$/.test(normalized))
    throw new Error("时间格式应为 YYYY-MM-DD HH:mm");
  const date = new Date(normalized.replace(" ", "T") + ":00");
  if (
    !Number.isFinite(date.getTime()) ||
    localDateTime(date.toISOString()) !== normalized
  )
    throw new Error("时间不存在，请检查日期和时间");
  return date.toISOString();
}

export function timeLabel(value: string) {
  const d = new Date(value);
  return Number.isFinite(d.getTime())
    ? d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
    : "时间未知";
}

export function dateLabel(value: string) {
  const d = new Date(value);
  return Number.isFinite(d.getTime())
    ? d.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })
    : "日期未知";
}

export function rangeLabel(
  value: { min: number; max: number } | null | undefined,
  unit = "",
) {
  if (!value) return "未知";
  const format = (amount: number) => Number.isInteger(amount) ? String(amount) : String(Number(amount.toFixed(2)));
  return `${value.min === value.max ? format(value.min) : `${format(value.min)}～${format(value.max)}`}${unit}`;
}

export function sleepHours(record: SleepRecord) {
  try {
    const value = sleepStats(record);
    return value.asleepMinutes === null ? null : value.asleepMinutes / 60;
  } catch {
    return null;
  }
}

export const recordDate = (record: MealRecord | TrainingRecord | SleepRecord) =>
  recordLocalDate(record);

/** Minutes since local midnight of `date` (may be negative or > 1440). */
export function minutesInto(date: string, iso: string) {
  const start = new Date(`${date}T00:00:00`).getTime();
  return (Date.parse(iso) - start) / 60000;
}
