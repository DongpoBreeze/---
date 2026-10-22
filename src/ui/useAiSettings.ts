import { useCallback, useEffect, useState } from "react";
import { clearAiSettings, loadAiSettings, saveAiSettings } from "../ai";
import type { AiSettings } from "../ai-provider";
import { getAiSettings, onAiSettingsChanged } from "../ai-settings";
import { errorText } from "./format";

/** Locally stored AI connection settings, with load/retry state for the settings banner. */
export function useAiSettings() {
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [errorDismissed, setErrorDismissed] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setReady(false);
    const unsubscribe = onAiSettingsChanged(() => { if (live) setSettings(getAiSettings()); });
    loadAiSettings()
      .then((loaded) => { if (live) { setSettings(loaded); setError(""); } })
      .catch((e) => {
        if (!live) return;
        setError(`读取 AI 设置失败：${errorText(e)} 原配置未清除。`);
        setErrorDismissed(false);
      })
      .finally(() => { if (live) setReady(true); });
    return () => { live = false; unsubscribe(); };
  }, [loadAttempt]);

  /** Why AI requests can't start right now, or "" when they can. */
  const issue = !ready
    ? "正在读取本机 AI 配置，请稍后重试。"
    : error ? "AI 配置读取失败，请在“设置 → AI 服务设置”中重试读取。" : "";

  return {
    settings, ready, error, issue,
    errorVisible: Boolean(error) && !errorDismissed,
    dismissError: useCallback(() => setErrorDismissed(true), []),
    /** Retries only after the previous attempt finished. */
    retry: useCallback(() => { if (ready) setLoadAttempt((attempt) => attempt + 1); }, [ready]),
    save: useCallback(async (next: AiSettings) => {
      await saveAiSettings(next);
      setSettings(getAiSettings());
      setError("");
    }, []),
    clear: useCallback(async () => {
      await clearAiSettings();
      setSettings(null);
      setError("");
    }, []),
  };
}

/** Host name shown in consent prompts; falls back when the stored address is not a valid URL. */
export function aiServiceHost(settings: AiSettings | null): string {
  if (!settings) return "所选服务";
  try { return new URL(settings.baseUrl).hostname; } catch { return "所选服务"; }
}
