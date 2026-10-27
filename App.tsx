import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Animated,
  BackHandler,
  Easing,
  Modal,
  Platform,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type ViewStyle,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import {
  type DailySummary,
  type MealAnalysis,
  type MealRecord,
  type Profile,
  type WorkoutTemplate,
} from "./src/types";
import { exportBackup, exportDailyMarkdown } from "./src/storage";
import { recordLocalDate, removeRecord, uid } from "./src/domain";
import { useAppData } from "./src/ui/useAppData";
import { aiServiceHost, useAiSettings } from "./src/ui/useAiSettings";
import { upsertMeal, upsertSleep, upsertTraining, upsertWorkoutTemplate } from "./src/record-updates";
import { analyzeMeal, analyzeSummary, getAiSettingsVersion, isAiConfigured } from "./src/ai";
import { type AiSettings } from "./src/ai-provider";
import { appendNutritionCorrection } from "./src/nutrition-correction";
import type { FormSession } from "./src/ui/useFormDraft";
import type { Kind, MealDraft, ModalKind, PhotoAnalysisResult, SleepDraft, Tab, TrainingDraft } from "./src/ui/app-types";
import { confirmAction, errorText, notify, today } from "./src/ui/format";
import { space, type ThemeTokens } from "./src/ui/theme";
import { ThemeProvider, useTheme, useThemedStyles } from "./src/ui/theme-provider";
import { Banner, SmallButton } from "./src/ui/components";
import { TABS, TabBar, tabLabel } from "./src/ui/tab-bar";
import { AnalysisWaitTime } from "./src/ui/analysis-wait-time";
import { Today } from "./src/ui/today";
import { Records } from "./src/ui/records";
import { Trends } from "./src/ui/trends";
import { Me } from "./src/ui/me";
import { Settings } from "./src/ui/settings-page";
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
  const [error, setError] = useState("");
  const {
    data, dataRef, ready, readFailure, storageWarning, setStorageWarning, takeWarning,
    commit, importFromBackup, clearAll, reload,
  } = useAppData(setError);
  const [tab, setTabState] = useState<Tab>("today");
  // Records is a sub-page pushed over a tab (normally 我的); the tab bar keeps the tab it came from.
  const [recordsOpen, setRecordsOpen] = useState(false);
  const setTab = useCallback((next: Tab) => {
    setRecordsOpen(false);
    setTabState(next);
  }, []);
  const openRecords = useCallback(() => setRecordsOpen(true), []);
  const closeRecords = useCallback(() => setRecordsOpen(false), []);
  useEffect(() => {
    if (!recordsOpen || Platform.OS !== "android") return;
    // Hardware back pops the records sub-page before it leaves the app; open sheets handle their own back.
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      setRecordsOpen(false);
      return true;
    });
    return () => sub.remove();
  }, [recordsOpen]);
  const enter = useRef(new Animated.Value(1)).current;
  const firstTab = useRef(true);
  const tabIndex = TABS.indexOf(tab);
  const lastTabIndex = useRef(tabIndex);
  const lastRecordsOpen = useRef(recordsOpen);
  const [tabDirection, setTabDirection] = useState(1);
  useEffect(() => {
    if (firstTab.current) { firstTab.current = false; return; }
    // Every page remounts at its scroll top. Tabs slide in from the side the user moved towards;
    // the records sub-page pushes in from the right and pops back to the left.
    if (lastRecordsOpen.current !== recordsOpen) setTabDirection(recordsOpen ? 1 : -1);
    else setTabDirection(tabIndex >= lastTabIndex.current ? 1 : -1);
    lastTabIndex.current = tabIndex;
    lastRecordsOpen.current = recordsOpen;
    enter.setValue(0);
    const animation = Animated.timing(enter, {
      toValue: 1,
      duration: 280,
      easing: Easing.bezier(0.2, 0.8, 0.2, 1),
      useNativeDriver: Platform.OS !== "web",
    });
    animation.start();
    return () => animation.stop();
  }, [tab, tabIndex, recordsOpen, enter]);
  const [modal, setModal] = useState<ModalKind>(null);
  const [formSession, setFormSession] = useState<FormSession | null>(null);
  const sessionRef = useRef<FormSession | null>(null);
  const sessionId = useRef(0);
  const [editId, setEditId] = useState<string>();
  const [mealAnalysisOnOpen, setMealAnalysisOnOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiStartedAt, setAiStartedAt] = useState<number | null>(null);
  const ai = useAiSettings();
  const aiSettings = ai.settings;
  const aiSettingsIssue = ai.issue;
  const aiController = useRef<AbortController | undefined>(undefined);
  const epoch = useRef(0);
  const contentStyle = useMemo(
    () => [
      styles.content,
      { maxWidth: Math.min(width, tab === "today" && !recordsOpen ? 430 : 760), paddingBottom: 110 + insets.bottom },
    ],
    [width, insets.bottom, tab, recordsOpen, styles.content],
  );
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
    takeWarning();
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
      mealDraftKey: kind === "meal" && !id ? `meal-new-${uid()}` : undefined,
      trainingDraftKey: kind === "training" && !id ? `training-new-${uid()}` : undefined,
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
      return upsertMeal(current, draft, id, photoAnalysis);
    });
    const saved = id ? next.meals.find((item) => item.id === id) : next.meals[0];
    if (saved) {
      const date = recordLocalDate(saved);
      if (date !== today()) {
        openRecords();
        setMessage(`已保存到全部记录：${saved.foodName}（${date}）。首页汇总当前显示今天 ${today()} 的数据。`);
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
      return upsertTraining(current, draft, id);
    });
  };
  const saveWorkoutTemplate = async (
    template: Omit<WorkoutTemplate, "id">,
    session: FormSession,
  ) => {
    await commit((current) => {
      requireSession(session);
      return upsertWorkoutTemplate(current, template);
    }, false);
  };
  const saveSleep = async (
    draft: SleepDraft,
    session: FormSession,
    id?: string,
  ) => {
    await commit((current) => {
      requireSession(session);
      return upsertSleep(current, draft, id);
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
    await ai.save(settings);
    if (sessionRef.current === session) {
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
    if (!isAiConfigured()) throw new Error("请先在“设置 → AI 服务设置”中连接 AI。");
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
    await ai.clear();
    if (sessionRef.current === session) {
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
      `本次将今日记录、目标和必要资料直接发送至 ${aiServiceHost(aiSettings)}，由该服务按其政策处理和计费。`,
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
      `本次将餐前/餐后照片、食物名称、份量、备注和必要资料直接发送至 ${aiServiceHost(aiSettings)}，由该服务按其政策处理和计费。`,
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
      if (!(await importFromBackup())) return;
      // Open forms and in-flight requests refer to the replaced data.
      epoch.current += 1;
      dismissForm();
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
        void clearAll(ai.clear)
          .then(() => setMessage(""))
          .catch((e) => setError(`删除失败：${errorText(e)}`));
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
            setError("");
            reload();
          }}
        />
      </SafeAreaView>
    );
  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      {Boolean(appearanceError) && (tab !== "settings" || recordsOpen) && (
        <Banner text={appearanceError} danger action="外观设置"
          onAction={() => setTab("settings")} onClose={() => setTab("settings")} />
      )}
      {Boolean(error) && (
        <Banner text={error} danger onClose={() => setError("")} />
      )}
      {ai.errorVisible && (
        <Banner text={ai.error} danger action="重试读取 AI 设置" onAction={ai.retry} onClose={ai.dismissError} />
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
        // This fade contains overlapping elevated cards and their own Reveal fades.
        needsOffscreenAlphaCompositing={Platform.OS === "android"}
        style={[styles.page, {
          opacity: enter,
          transform: [{ translateX: enter.interpolate({ inputRange: [0, 1], outputRange: [tabDirection * 24, 0] }) }],
        }]}
      >
      {recordsOpen ? (
        <Records
          data={data}
          contentStyle={contentStyle}
          onEdit={open}
          onDelete={deleteOne}
          onAi={runMeal}
          onBack={closeRecords}
          backLabel={tabLabel(tab)}
        />
      ) : <>
      {tab === "today" && (
        <Today
          data={data}
          contentStyle={contentStyle}
          onOpen={open}
          onEdit={open}
          onAi={askSummary}
          onProfile={() => open("profile")}
          onAllRecords={openRecords}
        />
      )}
      {tab === "trends" && <Trends data={data} contentStyle={contentStyle} />}
      {tab === "me" && (
        <Me
          data={data}
          contentStyle={contentStyle}
          onProfile={() => open("profile")}
          onRecords={openRecords}
        />
      )}
      {tab === "settings" && (
        <Settings
          data={data}
          contentStyle={contentStyle}
          onAiSettings={() => {
            if (!ai.ready) return;
            if (ai.error) ai.retry();
            else open("ai-settings");
          }}
          onAiReconfigure={() => { if (ai.ready) open("ai-settings"); }}
          aiSettings={aiSettings}
          aiSettingsReady={ai.ready}
          aiSettingsError={ai.error}
          onImport={importData}
          onExport={exportData}
          onMarkdown={exportMarkdown}
          onDelete={deleteAll}
        />
      )}
      </>}
      </Animated.View>
      <View style={[styles.fade, { height: 110 + insets.bottom }]} pointerEvents="none" />
      <TabBar tab={tab} bottom={18 + insets.bottom} onChange={setTab} />
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
            // New meal drafts use a unique key so they stay fresh across app restarts.
            draftKey={editId ? `meal-${editId}` : formSession.mealDraftKey!}
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
            draftKey={editId ? `training-${editId}` : formSession.trainingDraftKey!}
            history={data.trainings}
            workoutTemplates={data.workoutTemplates ?? []}
            exerciseTemplates={data.exerciseTemplates ?? []}
            onClose={() => close(formSession)}
            onSave={(draft) => saveTraining(draft, formSession, editId)}
            onSaveTemplate={(template) => saveWorkoutTemplate(template, formSession)}
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
            loadError={ai.error}
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


function createStyles({ color, type }: ThemeTokens) {
  return StyleSheet.create({
  // Clip the tab slide-in offset so the page never scrolls sideways mid-transition.
  root: { flex: 1, backgroundColor: color.paper, overflow: "hidden" },
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
  });
}
