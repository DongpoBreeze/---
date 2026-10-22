import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Animated,
  AppState,
  Easing,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type ViewStyle,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import {
  emptyData,
  type AppData,
  type DailySummary,
  type ExerciseTemplate,
  type MealAnalysis,
  type MealRecord,
  type Profile,
  type SleepRecord,
  type TrainingRecord,
} from "./src/types";
import {
  clearData,
  consumeStorageWarning,
  exportBackup,
  exportDailyMarkdown,
  importBackup,
  loadData,
  saveData,
} from "./src/storage";
import { recordLocalDate, refreshSummaries, removeRecord, uid } from "./src/domain";
import {
  analyzeMeal, analyzeSummary, clearAiSettings, getAiSettingsVersion, isAiConfigured,
  loadAiSettings, saveAiSettings,
} from "./src/ai";
import { AI_REQUEST_TIMEOUT_MS, type AiSettings } from "./src/ai-provider";
import { getAiSettings, onAiSettingsChanged } from "./src/ai-settings";
import { appendNutritionCorrection } from "./src/nutrition-correction";
import type { FormSession } from "./src/ui/useFormDraft";
import type { Kind, MealDraft, ModalKind, PhotoAnalysisResult, SleepDraft, Tab, TrainingDraft } from "./src/ui/app-types";
import { confirmAction, errorText, notify, today } from "./src/ui/format";
import { space, type ThemeTokens } from "./src/ui/theme";
import { ThemeProvider, useTheme, useThemedStyles } from "./src/ui/theme-provider";
import { Banner, SmallButton } from "./src/ui/components";
import { AnalysisWaitTime } from "./src/ui/analysis-wait-time";
import { Today } from "./src/ui/today";
import { Records } from "./src/ui/records";
import { Trends } from "./src/ui/trends";
import { Me } from "./src/ui/me";
import { MealForm } from "./src/ui/meal-form";
import { TrainingForm } from "./src/ui/training-form";
import { SleepForm } from "./src/ui/sleep-form";
import { AiSettingsForm, ProfileForm } from "./src/ui/settings-forms";

export default function App() {
  return (
    <ThemeProvider>
      <SafeAreaProvider>
        <AppShell />
      </SafeAreaProvider>
    </ThemeProvider>
  );
}

function AppShell() {
  const { type, scheme, error: appearanceError } = useTheme();
  const styles = useThemedStyles(createStyles);
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [data, setData] = useState<AppData>(emptyData);
  const dataRef = useRef(data);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState<Tab>("today");
  const enter = useRef(new Animated.Value(1)).current;
  const firstTab = useRef(true);
  useEffect(() => {
    if (firstTab.current) { firstTab.current = false; return; }
    // Every tab remounts at its scroll top; ease it in so switching reads as one motion.
    enter.setValue(0);
    const animation = Animated.timing(enter, {
      toValue: 1,
      duration: 220,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: Platform.OS !== "web",
    });
    animation.start();
    return () => animation.stop();
  }, [tab, enter]);
  const [modal, setModal] = useState<ModalKind>(null);
  const [formSession, setFormSession] = useState<FormSession | null>(null);
  const sessionRef = useRef<FormSession | null>(null);
  const sessionId = useRef(0);
  const [editId, setEditId] = useState<string>();
  const [mealAnalysisOnOpen, setMealAnalysisOnOpen] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [storageWarning, setStorageWarning] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiStartedAt, setAiStartedAt] = useState<number | null>(null);
  const [aiSettings, setAiSettings] = useState<AiSettings | null>(null);
  const [aiSettingsReady, setAiSettingsReady] = useState(false);
  const [aiSettingsError, setAiSettingsError] = useState("");
  const [aiSettingsErrorDismissed, setAiSettingsErrorDismissed] = useState(false);
  const [aiSettingsLoadAttempt, setAiSettingsLoadAttempt] = useState(0);
  const aiController = useRef<AbortController | undefined>(undefined);
  const epoch = useRef(0);
  const lastDate = useRef(today());
  const [readFailure, setReadFailure] = useState(false);
  const aiSettingsIssue = !aiSettingsReady
    ? "正在读取本机 AI 配置，请稍后重试。"
    : aiSettingsError ? "AI 配置读取失败，请在“我的 → AI 服务设置”中重试读取。" : "";
  const contentStyle = useMemo(
    () => [
      styles.content,
      { maxWidth: Math.min(width, tab === "today" ? 430 : 760), paddingBottom: 110 + insets.bottom },
    ],
    [width, insets.bottom, tab, styles.content],
  );
  useEffect(() => {
    let live = true;
    loadData()
      .then(async (loaded) => {
        if (!live) return;
        const next = refreshSummaries(loaded);
        dataRef.current = next;
        setData(next);
        try {
          await saveData(next);
        } catch (e) {
          if (live) setError(`本地摘要暂未写入：${errorText(e)}`);
        }
        const warning = consumeStorageWarning();
        if (warning) setStorageWarning(warning);
        setReady(true);
      })
      .catch((e) => {
        if (live) {
          setError(`读取本机数据失败：${errorText(e)}`);
          setReadFailure(true);
          setReady(true);
        }
      });
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    let live = true;
    setAiSettingsReady(false);
    const unsubscribe = onAiSettingsChanged(() => {
      if (live) setAiSettings(getAiSettings());
    });
    loadAiSettings()
      .then((settings) => {
        if (live) { setAiSettings(settings); setAiSettingsError(""); }
      })
      .catch((e) => {
        if (live) {
          setAiSettingsError(`读取 AI 设置失败：${errorText(e)} 原配置未清除。`);
          setAiSettingsErrorDismissed(false);
        }
      })
      .finally(() => { if (live) setAiSettingsReady(true); });
    return () => { live = false; unsubscribe(); };
  }, [aiSettingsLoadAttempt]);
  const commit = useCallback(
    async (change: (current: AppData) => AppData, bump = true) => {
      const task = queue.current.then(async () => {
        const current = dataRef.current;
        let next = change(current);
        if (bump) next = { ...next, sourceVersion: current.sourceVersion + 1 };
        next = refreshSummaries(next);
        await saveData(next);
        dataRef.current = next;
        setData(next);
        const warning = consumeStorageWarning();
        if (warning) setStorageWarning(warning);
        return next;
      });
      queue.current = task.catch(() => undefined);
      return task;
    },
    [],
  );
  useEffect(() => {
    if (!ready || readFailure) return;
    const refresh = () => {
      const date = today();
      if (date !== lastDate.current) {
        lastDate.current = date;
        void commit((current) => current, false).catch((e) =>
          setError(`摘要更新失败：${errorText(e)}`),
        );
      }
    };
    const timer = setInterval(refresh, 60000);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") refresh();
    });
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, [commit, readFailure, ready]);
  useEffect(
    () => () => {
      aiController.current?.abort();
      sessionRef.current = null;
    },
    [],
  );
  const saveNutritionCorrection = async (
    session: FormSession,
    mealId: string,
    revision: number,
    baseAnalysisId: string,
    analysis: MealAnalysis,
  ) => {
    await commit((current) => {
      requireSession(session);
      const meal = current.meals.find((item) => item.id === mealId);
      const corrected = appendNutritionCorrection(meal, revision, baseAnalysisId, {
        id: uid(), model: analysis.nutritionSource?.method === "ai-per100g-v3"
          ? "local/ai-per100g-v3" : analysis.nutritionSource?.method === "reference-quantity-v1"
            ? "local/reference-quantity-v1" : "local/usda-user-quantity-v2",
        createdAt: new Date().toISOString(), sourceVersion: revision, analysis,
      });
      return {
        ...current,
        meals: current.meals.map((item) => item.id === mealId ? corrected : item),
      };
    });
  };
  const dismissForm = () => {
    sessionRef.current = null;
    setFormSession(null);
    const warning = consumeStorageWarning();
    if (warning) setStorageWarning(warning);
    setModal(null);
    setEditId(undefined);
    setMealAnalysisOnOpen(false);
    setError("");
  };
  const close = (session: FormSession) => {
    if (sessionRef.current === session) dismissForm();
  };
  const open = (kind: Exclude<ModalKind, null>, id?: string, analyze = false) => {
    const session: FormSession = {
      id: ++sessionId.current,
      epoch: epoch.current,
      isActive: () =>
        sessionRef.current === session && session.epoch === epoch.current,
    };
    sessionRef.current = session;
    setFormSession(session);
    setError("");
    setEditId(id);
    setMealAnalysisOnOpen(kind === "meal" && analyze);
    setModal(kind);
  };
  const requireSession = (session: FormSession) => {
    if (!session.isActive() || session.epoch !== epoch.current)
      throw new Error("这个表单已关闭或本机数据已变更，请重新打开后保存。");
  };

  const saveMeal = async (
    draft: MealDraft,
    session: FormSession,
    id?: string,
    photoAnalysis?: PhotoAnalysisResult,
  ) => {
    const next = await commit((current) => {
      requireSession(session);
      const photoVersions = (sourceVersion: number) => {
        if (!photoAnalysis) return [];
        const { history, ...latest } = photoAnalysis;
        return [...(history ?? []), latest].map((version) => ({ id: uid(), ...version, sourceVersion }));
      };
      if (!id) {
        const item: MealRecord = {
          ...draft,
          id: uid(),
          type: "meal",
          createdAt: new Date().toISOString(),
          revision: 1,
          analyses: photoAnalysis ? photoVersions(1) : undefined,
        };
        return { ...current, meals: [item, ...current.meals] };
      }
      const old = current.meals.find((item) => item.id === id);
      if (!old) throw new Error("这条饮食记录已不存在");
      const { revisions: previousRevisions, ...snapshot } = old;
      const item: MealRecord = {
        ...old,
        ...draft,
        id,
        type: "meal",
        createdAt: old.createdAt,
        revision: (old.revision ?? 1) + 1,
        updatedAt: new Date().toISOString(),
        revisions: [...(previousRevisions ?? []), snapshot],
        analyses: photoAnalysis
          ? [...(old.analyses ?? []), ...photoVersions((old.revision ?? 1) + 1)]
          : old.analyses,
      };
      return {
        ...current,
        meals: current.meals.map((value) => (value.id === id ? item : value)),
      };
    });
    const saved = id ? next.meals.find((item) => item.id === id) : next.meals[0];
    if (saved) {
      const date = recordLocalDate(saved);
      if (date !== today()) {
        setTab("records");
        setMessage(`已保存到记录页：${saved.foodName}（${date}）。首页汇总当前显示今天 ${today()} 的数据。`);
      } else setMessage(`已保存：${saved.foodName}；今日饮食汇总已更新。`);
    }
  };
  const saveTraining = async (
    draft: TrainingDraft,
    session: FormSession,
    id?: string,
  ) => {
    await commit((current) => {
      requireSession(session);
      if (!id) {
        const item: TrainingRecord = {
          ...draft,
          id: uid(),
          type: "training",
          createdAt: new Date().toISOString(),
        };
        return { ...current, trainings: [item, ...current.trainings] };
      }
      const old = current.trainings.find((item) => item.id === id);
      if (!old) throw new Error("这条训练记录已不存在");
      const item: TrainingRecord = {
        ...old,
        ...draft,
        id,
        type: "training",
        createdAt: old.createdAt,
        updatedAt: new Date().toISOString(),
      };
      return {
        ...current,
        trainings: current.trainings.map((value) =>
          value.id === id ? item : value,
        ),
      };
    });
  };
  const saveTrainingTemplate = async (
    template: Omit<ExerciseTemplate, "id">,
    session: FormSession,
  ) => {
    await commit((current) => {
      requireSession(session);
      const templates = current.exerciseTemplates ?? [];
      const key = template.name.trim().toLocaleLowerCase();
      const index = templates.findIndex((item) => item.name.trim().toLocaleLowerCase() === key);
      const saved: ExerciseTemplate = {
        ...template,
        name: template.name.trim(),
        id: index < 0 ? uid() : templates[index].id,
      };
      const exerciseTemplates = index < 0
        ? [...templates, saved]
        : templates.map((item, itemIndex) => itemIndex === index ? saved : item);
      return { ...current, exerciseTemplates };
    }, false);
  };
  const saveSleep = async (
    draft: SleepDraft,
    session: FormSession,
    id?: string,
  ) => {
    await commit((current) => {
      requireSession(session);
      if (
        current.sleeps.some(
          (record) =>
            record.id !== id &&
            record.fellAsleepAt === draft.fellAsleepAt &&
            record.wokeAt === draft.wokeAt,
        )
      )
        throw new Error(
          "已经有相同入睡和起床时间的睡眠记录。请打开原记录修改。",
        );
      if (!id) {
        const item: SleepRecord = {
          ...draft,
          id: uid(),
          type: "sleep",
          createdAt: new Date().toISOString(),
        };
        return { ...current, sleeps: [item, ...current.sleeps] };
      }
      const old = current.sleeps.find((item) => item.id === id);
      if (!old) throw new Error("这条睡眠记录已不存在");
      const item: SleepRecord = {
        ...old,
        ...draft,
        id,
        type: "sleep",
        createdAt: old.createdAt,
        updatedAt: new Date().toISOString(),
      };
      return {
        ...current,
        sleeps: current.sleeps.map((value) => (value.id === id ? item : value)),
      };
    });
  };
  const deleteOne = (kind: Kind, id: string) =>
    confirmAction(
      "删除这条记录？",
      "关联分析和含此记录的 AI 总结也会删除。",
      "删除",
      () => {
        aiController.current?.abort();
        void commit((current) => removeRecord(current, kind, id)).catch((e) =>
          setError(`删除失败：${errorText(e)}`),
        );
      },
      true,
    );
  const saveProfile = async (profile: Profile, session: FormSession) => {
    setMessage("");
    await commit((current) => {
      requireSession(session);
      return { ...current, profile };
    });
    if (sessionRef.current === session) setMessage("目标与身高体重已保存到本机。");
  };
  const saveProviderSettings = async (settings: AiSettings, session: FormSession) => {
    requireSession(session);
    setMessage("");
    aiController.current?.abort();
    await saveAiSettings(settings);
    if (sessionRef.current === session) {
      setAiSettings(getAiSettings());
      setAiSettingsError("");
      setMessage("AI 配置已保存到本机。");
    }
  };

  const analyzePhotoForMeal = async (
    meal: MealRecord,
    signal: AbortSignal,
  ): Promise<PhotoAnalysisResult> => {
    if (signal.aborted) throw new Error("分析已取消，照片已保留。");
    if (aiController.current) throw new Error("已有分析正在进行，请等待或取消当前请求。");
    if (aiSettingsIssue) throw new Error(aiSettingsIssue);
    if (!isAiConfigured()) throw new Error("请先在“我的 → AI 服务设置”中连接 AI。");
    const controller = new AbortController();
    const requestEpoch = epoch.current;
    const settingsVersion = getAiSettingsVersion();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    aiController.current = controller;
    setAiBusy(true);
    try {
      const result = await analyzeMeal(
        meal,
        dataRef.current.profile,
        controller.signal,
        uid(),
      );
      if (signal.aborted || controller.signal.aborted || requestEpoch !== epoch.current
        || settingsVersion !== getAiSettingsVersion())
        throw new Error("餐食或 AI 设置已变更，请重新发起识别。");
      return result;
    } finally {
      signal.removeEventListener("abort", abort);
      if (aiController.current === controller) {
        aiController.current = undefined;
        setAiBusy(false);
      }
    }
  };
  const deleteProviderSettings = async (session: FormSession) => {
    requireSession(session);
    setMessage("");
    aiController.current?.abort();
    await clearAiSettings();
    if (sessionRef.current === session) {
      setAiSettings(null);
      setAiSettingsError("");
      setMessage("AI 配置已从本机删除。");
    }
  };

  const runSummary = async () => {
    if (aiController.current) return;
    if (aiSettingsIssue) { setMessage(aiSettingsIssue); return; }
    if (!isAiConfigured()) {
      setMessage("AI 尚未配置。你仍可使用本地摘要、记录、编辑、导出和恢复。");
      return;
    }
    const snapshot = dataRef.current;
    const requestEpoch = epoch.current;
    const settingsVersion = getAiSettingsVersion();
    const date = today();
    const controller = new AbortController();
    aiController.current = controller;
    setAiBusy(true);
    setMessage("正在请求分析；本地记录仍已保存。");
    setAiStartedAt(Date.now());
    const timeout = setTimeout(() => controller.abort(), AI_REQUEST_TIMEOUT_MS + 5000);
    try {
      const result = await analyzeSummary(
        snapshot,
        date,
        controller.signal,
        uid(),
      );
      const ids = result.inputSnapshot.recordVersions.map(
        (record) => record.id,
      );
      const summary: DailySummary = {
        id: uid(),
        date,
        markdown: result.markdown,
        sourceVersion: snapshot.sourceVersion,
        status: "current",
        createdAt: result.createdAt,
        source: "ai",
        model: result.model,
        sourceRecordIds: ids,
        inputSnapshot: result.inputSnapshot,
      };
      await commit((current) => {
        if (
          controller.signal.aborted ||
          requestEpoch !== epoch.current ||
          settingsVersion !== getAiSettingsVersion() ||
          current.sourceVersion !== snapshot.sourceVersion
        )
          throw new Error("记录在分析期间发生变化，请重新发起分析。");
        return { ...current, summaries: [...current.summaries, summary] };
      }, false);
      setMessage("AI 总结已保存为独立版本。");
    } catch (e) {
      if (requestEpoch === epoch.current) setMessage(errorText(e));
    } finally {
      clearTimeout(timeout);
      aiController.current = undefined;
      setAiBusy(false);
      setAiStartedAt(null);
    }
  };
  const askSummary = () => {
    if (aiBusy) {
      aiController.current?.abort();
      return;
    }
    if (aiSettingsIssue) { setMessage(aiSettingsIssue); return; }
    if (!isAiConfigured()) {
      setMessage("AI 尚未连接，已保存记录和本地摘要仍可使用。");
      return;
    }
    confirmAction(
      "发送记录进行分析？",
      `本次将今日记录、目标和必要资料直接发送至 ${aiSettings ? new URL(aiSettings.baseUrl).hostname : "所选服务"}，由该服务按其政策处理和计费。`,
      "同意并分析",
      () => {
        void runSummary();
      },
    );
  };
  const runMeal = async (id: string) => {
    if (aiBusy) {
      setMessage("已有分析正在进行，请等待或取消当前请求。");
      return;
    }
    const meal = dataRef.current.meals.find((item) => item.id === id);
    if (!meal) return;
    if (aiSettingsIssue) { setMessage(aiSettingsIssue); return; }
    if (!isAiConfigured()) {
      setMessage("AI 尚未配置。饮食记录已保留，可以继续手动补充营养。");
      return;
    }
    const requestEpoch = epoch.current;
    const settingsVersion = getAiSettingsVersion();
    confirmAction(
      "发送这餐进行分析？",
      `本次将餐前/餐后照片、食物名称、份量、备注和必要资料直接发送至 ${aiSettings ? new URL(aiSettings.baseUrl).hostname : "所选服务"}，由该服务按其政策处理和计费。`,
      "同意并分析",
      () => {
        const current = dataRef.current.meals.find((item) => item.id === id);
        if (requestEpoch !== epoch.current || settingsVersion !== getAiSettingsVersion()
          || !current || (current.revision ?? 1) !== (meal.revision ?? 1)) return;
        open("meal", id, true);
      },
    );
  };
  const importData = async () => {
    try {
      const task = queue.current.then(async () => {
        const imported = await importBackup(dataRef.current);
        if (!imported) return false;
        await saveData(imported);
        dataRef.current = imported;
        setData(imported);
        const warning = consumeStorageWarning();
        if (warning) setStorageWarning(warning);
        epoch.current += 1;
        dismissForm();
        return true;
      });
      queue.current = task.catch(() => undefined);
      const imported = await task;
      if (!imported) return;
      notify("恢复完成", "备份中的记录已载入本机。");
    } catch (e) {
      setError(`恢复失败：${errorText(e)}`);
    }
  };
  const performExport = async () => {
    try {
      await exportBackup(dataRef.current);
      notify("导出完成", "备份文件已准备好，请妥善保管。");
    } catch (e) {
      setError(`导出失败：${errorText(e)}`);
    }
  };
  const exportData = () =>
    confirmAction(
      "导出包含健康数据",
      "备份包含原始记录、照片、视频、分析、摘要和草稿。文件将下载或通过系统分享保存，请选择可信的保存位置。",
      "导出",
      () => {
        void performExport();
      },
    );
  const exportMarkdown = async () => {
    try {
      await exportDailyMarkdown(dataRef.current, today());
      notify("导出完成", "今日 Markdown 摘要已准备好。");
    } catch (e) {
      setError(`摘要导出失败：${errorText(e)}`);
    }
  };
  const deleteAll = () =>
    confirmAction(
      "删除本机数据？",
      "记录、媒体、总结、草稿和 AI 连接设置都会删除。App 外的备份不会被撤回。",
      "确认删除",
      () => {
        aiController.current?.abort();
        epoch.current += 1;
        dismissForm();
        const task = queue.current.then(async () => {
          await clearAiSettings();
          setAiSettings(null);
          setAiSettingsError("");
          await clearData();
          const next = emptyData();
          dataRef.current = next;
          setData(next);
          setMessage("");
          setStorageWarning("");
        });
        queue.current = task.catch(() => undefined);
        void task.catch((e) => setError(`删除失败：${errorText(e)}`));
      },
      true,
    );
  if (!ready)
    return (
      <View style={styles.loading}>
        <Text style={styles.loadingText}>正在读取本机记录…</Text>
      </View>
    );
  if (readFailure)
    return (
      <SafeAreaView style={styles.loading}>
        <Text style={type.title}>无法读取本机数据</Text>
        <Text style={[type.bodySoft, { marginVertical: space.md, textAlign: "center" }]}>{error}</Text>
        <SmallButton
          icon="refresh-outline"
          label="重新读取"
          onPress={() => {
            setReady(false);
            void loadData()
              .then((loaded) => {
                const next = refreshSummaries(loaded);
                dataRef.current = next;
                setData(next);
                setReadFailure(false);
                setError("");
              })
              .catch((e) => setError(errorText(e)))
              .finally(() => setReady(true));
          }}
        />
      </SafeAreaView>
    );
  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      {Boolean(appearanceError) && tab !== "me" && (
        <Banner text={appearanceError} danger action="外观设置"
          onAction={() => setTab("me")} onClose={() => setTab("me")} />
      )}
      {Boolean(error) && (
        <Banner text={error} danger onClose={() => setError("")} />
      )}
      {Boolean(aiSettingsError) && !aiSettingsErrorDismissed && (
        <Banner text={aiSettingsError} danger action="重试读取 AI 设置"
          onAction={() => { if (aiSettingsReady) setAiSettingsLoadAttempt((attempt) => attempt + 1); }}
          onClose={() => setAiSettingsErrorDismissed(true)} />
      )}
      {Boolean(message) && (
        <Banner
          text={<>{message}{aiBusy && aiStartedAt !== null && <>{"\n"}<AnalysisWaitTime startedAt={aiStartedAt} /></>}</>}
          onClose={() => setMessage("")}
          action={aiBusy ? "取消" : "关闭"}
          onAction={
            aiBusy ? () => aiController.current?.abort() : () => setMessage("")
          }
        />
      )}
      {Boolean(storageWarning) && (
        <Banner text={storageWarning} onClose={() => setStorageWarning("")} />
      )}
      <Animated.View
        style={[styles.page, {
          opacity: enter,
          transform: [{ translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) }],
        }]}
      >
      {tab === "today" && (
        <Today
          data={data}
          contentStyle={contentStyle}
          onOpen={open}
          onEdit={open}
          onAi={askSummary}
          onProfile={() => open("profile")}
          onAllRecords={() => setTab("records")}
        />
      )}
      {tab === "records" && (
        <Records
          data={data}
          contentStyle={contentStyle}
          onEdit={open}
          onDelete={deleteOne}
          onAi={runMeal}
        />
      )}
      {tab === "trends" && <Trends data={data} contentStyle={contentStyle} />}
      {tab === "me" && (
        <Me
          data={data}
          contentStyle={contentStyle}
          onProfile={() => open("profile")}
          onAiSettings={() => {
            if (!aiSettingsReady) return;
            if (aiSettingsError) setAiSettingsLoadAttempt((attempt) => attempt + 1);
            else open("ai-settings");
          }}
          onAiReconfigure={() => { if (aiSettingsReady) open("ai-settings"); }}
          aiSettings={aiSettings}
          aiSettingsReady={aiSettingsReady}
          aiSettingsError={aiSettingsError}
          onImport={importData}
          onExport={exportData}
          onMarkdown={exportMarkdown}
          onDelete={deleteAll}
        />
      )}
      </Animated.View>
      <View style={[styles.fade, { height: 110 + insets.bottom }]} pointerEvents="none" />
      <View style={[styles.navWrap, { bottom: 18 + insets.bottom }]} pointerEvents="box-none">
        <View style={styles.nav} accessibilityRole="tablist">
          {(["today", "records", "trends", "me"] as Tab[]).map((item) => (
            <NavItem
              key={item}
              tab={item}
              active={tab === item}
              onPress={() => setTab(item)}
            />
          ))}
        </View>
      </View>
      <Modal
        visible={modal !== null}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => sessionRef.current?.requestClose?.()}
      >
        {/* A modal owns a native window, so measure its insets separately from the page. */}
        <SafeAreaProvider style={styles.root}>
          <SafeAreaView style={styles.root}>
        <StatusBar style={scheme === "dark" ? "light" : "dark"} />
        {modal === "meal" && formSession && (
          <MealForm
            key={formSession.id}
            profile={data.profile}
            aiSettingsIssue={aiSettingsIssue}
            session={formSession}
            initial={
              editId ? data.meals.find((item) => item.id === editId) : undefined
            }
            draftKey={editId ? `meal-${editId}` : "meal-new"}
            onClose={() => close(formSession)}
            onSave={(draft, photoAnalysis) =>
              saveMeal(draft, formSession, editId, photoAnalysis)
            }
            onAnalyzePhoto={analyzePhotoForMeal}
            onSaveCorrection={(mealId, revision, baseId, analysis) =>
              saveNutritionCorrection(formSession, mealId, revision, baseId, analysis)}
            analyzeOnOpen={mealAnalysisOnOpen}
          />
        )}
        {modal === "training" && formSession && (
          <TrainingForm
            key={formSession.id}
            session={formSession}
            initial={
              editId
                ? data.trainings.find((item) => item.id === editId)
                : undefined
            }
            draftKey={editId ? `training-${editId}` : "training-new"}
            history={data.trainings}
            exerciseTemplates={data.exerciseTemplates ?? []}
            onClose={() => close(formSession)}
            onSave={(draft) => saveTraining(draft, formSession, editId)}
            onSaveTemplate={(template) => saveTrainingTemplate(template, formSession)}
          />
        )}
        {modal === "sleep" && formSession && (
          <SleepForm
            key={formSession.id}
            session={formSession}
            initial={
              editId
                ? data.sleeps.find((item) => item.id === editId)
                : undefined
            }
            draftKey={editId ? `sleep-${editId}` : "sleep-new"}
            onClose={() => close(formSession)}
            onSave={(draft) => saveSleep(draft, formSession, editId)}
          />
        )}
        {modal === "profile" && formSession && (
          <ProfileForm
            key={formSession.id}
            session={formSession}
            initial={data.profile}
            onClose={() => close(formSession)}
            onSave={(profile) => saveProfile(profile, formSession)}
          />
        )}
        {modal === "ai-settings" && formSession && (
          <AiSettingsForm
            key={formSession.id}
            session={formSession}
            initial={aiSettings}
            loadError={aiSettingsError}
            onClose={() => close(formSession)}
            onSave={(settings) => saveProviderSettings(settings, formSession)}
            onDelete={() => deleteProviderSettings(formSession)}
          />
        )}
          </SafeAreaView>
        </SafeAreaProvider>
      </Modal>
    </SafeAreaView>
  );
}


function NavItem({
  tab,
  active,
  onPress,
}: {
  tab: Tab;
  active: boolean;
  onPress: () => void;
}) {
  const { color } = useTheme();
  const styles = useThemedStyles(createStyles);
  const item = (
    {
      today: ["today", "today-outline", "今天"],
      records: ["list", "list-outline", "记录"],
      trends: ["stats-chart", "stats-chart-outline", "趋势"],
      me: ["person", "person-outline", "我的"],
    } as const
  )[tab];
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.navItem, active && styles.navItemOn, pressed && !active && { opacity: 0.6 }]}
      accessibilityRole="tab"
      accessibilityLabel={item[2]}
      accessibilityState={{ selected: active }}
    >
      <Ionicons name={active ? item[0] : item[1]} size={16} color={active ? color.ink : color.inkFaint} />
      <Text style={[styles.navLabel, active && styles.navActive]}>{item[2]}</Text>
    </Pressable>
  );
}

function createStyles({ color, type }: ThemeTokens) {
  return StyleSheet.create({
  root: { flex: 1, backgroundColor: color.paper },
  page: { flex: 1 },
  loading: {
    flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: color.paper, padding: space.xl,
  },
  loadingText: { ...type.bodySoft },
  content: {
    width: "100%",
    alignSelf: "center",
    paddingHorizontal: 18,
    paddingTop: space.xl,
  },
  fade: {
    position: "absolute", left: 0, right: 0, bottom: 0,
    ...(Platform.OS === "web"
      ? { backgroundImage: `linear-gradient(to bottom, transparent, ${color.paper} 55%)` }
      : { backgroundColor: "transparent" }),
  } as ViewStyle,
  navWrap: {
    position: "absolute", left: 14, right: 14, alignItems: "center",
  },
  nav: {
    width: "100%", maxWidth: 440, height: 62, flexDirection: "row", alignItems: "center", justifyContent: "space-around",
    paddingHorizontal: 6, borderRadius: 22, backgroundColor: color.navBg, borderWidth: 1, borderColor: color.line,
    ...(Platform.OS === "web" ? { backdropFilter: "blur(12px)" } : {}),
  } as ViewStyle,
  navItem: {
    minWidth: 64, paddingVertical: 6, paddingHorizontal: 14, borderRadius: 14, alignItems: "center", justifyContent: "center", gap: 3,
  },
  navItemOn: { backgroundColor: color.sunken },
  navLabel: { color: color.inkFaint, fontSize: 10, lineHeight: 13, fontWeight: "700" },
  navActive: { color: color.ink },
  });
}
