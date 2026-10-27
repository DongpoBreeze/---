import React, { useEffect, useState } from "react";
import { Text } from "react-native";
import { DAILY_SUMMARY_TIMEOUT_MS } from "../ai-provider";

export function AnalysisWaitTime({ startedAt, timeoutMs = DAILY_SUMMARY_TIMEOUT_MS, limitLabel = "总时限" }: { startedAt: number; timeoutMs?: number; limitLabel?: string }) {
  const elapsed = () => Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const [seconds, setSeconds] = useState(elapsed);
  useEffect(() => {
    // Derive from the clock so background throttling does not lose elapsed time.
    const refresh = () => setSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    refresh();
    const timer = setInterval(refresh, 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  return <Text testID="analysis-wait-time">已等待 {seconds} 秒 · {limitLabel} {timeoutMs / 1000} 秒</Text>;
}
