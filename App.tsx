import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AppState,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import type {
  AppData,
  DailySummary,
  MealAnalysis,
  MealRecord,
  Profile,
  SleepRecord,
  TrainingRecord,
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
import { refreshSummaries, removeRecord, uid } from "./src/domain";
import {
  analyzeMeal, analyzeSummary, clearAiSettings, getAiSettingsVersion, isAiConfigured,
  loadAiSettings, saveAiSettings,
} from "./src/ai";
import type { AiSettings } from "./src/ai-provider";
import { appendNutritionCorrection } from "./src/nutrition-correction";
import type { FormSession } from "./src/ui/useFormDraft";
import type { Kind, MealDraft, ModalKind, PhotoAnalysisResult, SleepDraft, Tab, TrainingDraft } from "./src/ui/app-types";
import { confirmAction, errorText, notify, today } from "./src/ui/format";
import { color, space, type } from "./src/ui/theme";
import { Banner, SmallButton } from "./src/ui/components";
import { Today } from "./src/ui/today";
import { Records } from "./src/ui/records";
import { Trends } from "./src/ui/trends";
import { Me } from "./src/ui/me";
import { MealForm } from "./src/ui/meal-form";
import { TrainingForm } from "./src/ui/training-form";
import { SleepForm } from "./src/ui/sleep-form";
import { AiSettingsForm, ProfileForm } from "./src/ui/settings-forms";

const blankData = (): AppData => ({
  version: 1,
  profile: {},
  meals: [],
  trainings: [],
  sleeps: [],
  summaries: [],
  sourceVersion: 0,
});

export default function App() {
  return (
    <SafeAreaProvider>
      <AppShell />
    </SafeAreaProvider>
  );
}

function AppShell() {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [data, setData] = useState<AppData>(blankData);
  const dataRef = useRef(data);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState<Tab>("today");
  const [modal, setModal] = useState<ModalKind>(null);
  const [formSession, setFormSession] = useState<FormSession | null>(null);
  const sessionRef = useRef<FormSession | null>(null);
  const sessionId = useRef(0);
  const [editId, setEditId] = useState<string>();
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [storageWarning, setStorageWarning] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiSettings, setAiSettings] = useState<AiSettings | null>(null);
  const [aiSettingsReady, setAiSettingsReady] = useState(false);
  const aiController = useRef<AbortController | undefined>(undefined);
  const epoch = useRef(0);
  const lastDate = useRef(today());
  const [readFailure, setReadFailure] = useState(false);
  const contentStyle = useMemo(
    () => [
      styles.content,
      { maxWidth: Math.min(width, 760), paddingBottom: 104 + insets.bottom },
    ],
    [width, insets.bottom],
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
    loadAiSettings()
      .then((settings) => { if (live) setAiSettings(settings); })
      .catch((e) => { if (live) setError(`读取 AI 设置失败：${errorText(e)}`); })
      .finally(() => { if (live) setAiSettingsReady(true); });
    return () => { live = false; };
  }, []);
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
        id: uid(), model: "local/usda-user-quantity-v2",
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
    setError("");
  };
  const close = (session: FormSession) => {
    if (sessionRef.current === session) dismissForm();
  };
  const open = (kind: Exclude<ModalKind, null>, id?: string) => {
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
    await commit((current) => {
      requireSession(session);
      if (!id) {
        const item: MealRecord = {
          ...draft,
          id: uid(),
          type: "meal",
          createdAt: new Date().toISOString(),
          revision: 1,
          analyses: photoAnalysis ? [{ id: uid(), ...photoAnalysis, sourceVersion: 1 }] : undefined,
        };
        return { ...current, meals: [item, ...current.meals] };
      }
      const old = current.meals.find((item) => item.id === id);
      if (!old) throw new Error("这条饮食记录已不存在");
      const snapshot = { ...old, revisions: undefined } as Omit<
        MealRecord,
        "revisions"
      >;
      const item: MealRecord = {
        ...old,
        ...draft,
        id,
        type: "meal",
        createdAt: old.createdAt,
        revision: (old.revision ?? 1) + 1,
        updatedAt: new Date().toISOString(),
        revisions: [...(old.revisions ?? []), snapshot],
        analyses: photoAnalysis
          ? [...(old.analyses ?? []), { id: uid(), ...photoAnalysis, sourceVersion: (old.revision ?? 1) + 1 }]
          : old.analyses,
      };
      return {
        ...current,
        meals: current.meals.map((value) => (value.id === id ? item : value)),
      };
    });
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
    await commit((current) => {
      requireSession(session);
      return { ...current, profile };
    });
  };
  const saveProviderSettings = async (settings: AiSettings, session: FormSession) => {
    requireSession(session);
    aiController.current?.abort();
    await saveAiSettings(settings);
    if (sessionRef.current === session) setAiSettings(settings);
  };

  const analyzePhotoForMeal = async (
    meal: MealRecord,
    signal: AbortSignal,
  ): Promise<PhotoAnalysisResult> => {
    if (signal.aborted) throw new Error("分析已取消，照片已保留。");
    if (aiController.current) throw new Error("已有分析正在进行，请等待或取消当前请求。");
    if (!isAiConfigured()) throw new Error("请先在“我的 → AI 服务设置”中连接 AI。");
    const controller = new AbortController();
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
      return result;
    } finally {
      signal.removeEventListener("abort", abort);
      if (aiController.current === controller) aiController.current = undefined;
      setAiBusy(false);
    }
  };
  const deleteProviderSettings = async (session: FormSession) => {
    requireSession(session);
    aiController.current?.abort();
    await clearAiSettings();
    if (sessionRef.current === session) setAiSettings(null);
  };

  const runSummary = async () => {
    if (aiController.current) return;
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
    const slow = setTimeout(
      () => setMessage("分析已等待 30 秒，你可以取消；记录不会受影响。"),
      30000,
    );
    const timeout = setTimeout(() => controller.abort(), 60000);
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
      clearTimeout(slow);
      clearTimeout(timeout);
      aiController.current = undefined;
      setAiBusy(false);
    }
  };
  const askSummary = () => {
    if (aiBusy) {
      aiController.current?.abort();
      return;
    }
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
    if (!isAiConfigured()) {
      setMessage("AI 尚未配置。饮食记录已保留，可以继续手动补充营养。");
      return;
    }
    confirmAction(
      "发送这餐进行分析？",
      `本次将餐前/餐后照片、食物名称、份量、备注和必要资料直接发送至 ${aiSettings ? new URL(aiSettings.baseUrl).hostname : "所选服务"}，由该服务按其政策处理和计费。`,
      "同意并分析",
      () => {
        void performMeal(meal);
      },
    );
  };
  const performMeal = async (meal: MealRecord) => {
    if (aiController.current) return;
    const version = dataRef.current.sourceVersion;
    const requestEpoch = epoch.current;
    const settingsVersion = getAiSettingsVersion();
    const controller = new AbortController();
    aiController.current = controller;
    setAiBusy(true);
    setMessage("正在分析这餐；原始记录不会被覆盖。");
    const slow = setTimeout(
      () => setMessage("分析已等待 30 秒，你可以取消；记录不会受影响。"),
      30000,
    );
    const timeout = setTimeout(() => controller.abort(), 60000);
    try {
      const result = await analyzeMeal(
        meal,
        dataRef.current.profile,
        controller.signal,
        uid(),
      );
      await commit((current) => {
        if (
          controller.signal.aborted ||
          requestEpoch !== epoch.current ||
          settingsVersion !== getAiSettingsVersion() ||
          current.sourceVersion !== version ||
          !current.meals.some(
            (item) =>
              item.id === meal.id &&
              (item.revision ?? 1) === (meal.revision ?? 1),
          )
        )
          throw new Error("记录在分析期间发生变化，请重新发起分析。");
        return {
          ...current,
          meals: current.meals.map((item) =>
            item.id === meal.id
              ? {
                  ...item,
                  analyses: [
                    ...(item.analyses ?? []),
                    {
                      id: uid(),
                      model: result.model,
                      createdAt: result.createdAt,
                      sourceVersion: item.revision ?? 1,
                      analysis: result.analysis,
                    },
                  ],
                }
              : item,
          ),
        };
      });
      setMessage("这餐的分析已保存为独立版本。");
    } catch (e) {
      if (requestEpoch === epoch.current) setMessage(errorText(e));
    } finally {
      clearTimeout(slow);
      clearTimeout(timeout);
      aiController.current = undefined;
      setAiBusy(false);
    }
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
          await clearData();
          const next = blankData();
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
      <StatusBar style="light" />
      {Boolean(error) && (
        <Banner text={error} danger onClose={() => setError("")} />
      )}
      {Boolean(message) && (
        <Banner
          text={message}
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
      {tab === "today" && (
        <Today
          data={data}
          contentStyle={contentStyle}
          onOpen={open}
          onEdit={open}
          onAi={askSummary}
          onProfile={() => open("profile")}
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
          onAiSettings={() => { if (aiSettingsReady) open("ai-settings"); }}
          aiSettings={aiSettings}
          aiSettingsReady={aiSettingsReady}
          onImport={importData}
          onExport={exportData}
          onMarkdown={exportMarkdown}
          onDelete={deleteAll}
        />
      )}
      <View style={[styles.navWrap, { paddingBottom: Math.max(insets.bottom, space.md) }]} pointerEvents="box-none">
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
        {modal === "meal" && formSession && (
          <MealForm
            key={formSession.id}
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
            onAnalyze={
              editId
                ? () => {
                    if (!formSession.isActive()) return;
                    close(formSession);
                    void runMeal(editId);
                  }
                : undefined
            }
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
            onClose={() => close(formSession)}
            onSave={(draft) => saveTraining(draft, formSession, editId)}
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
            onClose={() => close(formSession)}
            onSave={(settings) => saveProviderSettings(settings, formSession)}
            onDelete={() => deleteProviderSettings(formSession)}
          />
        )}
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
  const item = (
    {
      today: ["sunny", "sunny-outline", "今天"],
      records: ["list", "list-outline", "记录"],
      trends: ["stats-chart", "stats-chart-outline", "趋势"],
      me: ["person", "person-outline", "我的"],
    } as const
  )[tab];
  return (
    <Pressable
      onPress={onPress}
      style={[styles.navItem, active && styles.navItemOn]}
      accessibilityRole="tab"
      accessibilityLabel={item[2]}
      accessibilityState={{ selected: active }}
    >
      <Ionicons name={active ? item[0] : item[1]} size={20} color={active ? color.onInk : color.inkSoft} />
      <Text style={[styles.navLabel, active && styles.navActive]}>{item[2]}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.paper },
  loading: {
    flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: color.paper, padding: space.xl,
  },
  loadingText: { ...type.bodySoft },
  content: {
    width: "100%",
    alignSelf: "center",
    paddingHorizontal: space.lg + 4,
    paddingTop: space.lg,
  },
  navWrap: {
    position: "absolute", left: 0, right: 0, bottom: 0, alignItems: "center", paddingHorizontal: space.lg,
  },
  nav: {
    width: "100%", maxWidth: 440, flexDirection: "row", padding: 6, gap: 4,
    borderRadius: 999, backgroundColor: color.surface, borderWidth: 1, borderColor: color.lineStrong,
  },
  navItem: {
    flex: 1, minHeight: 50, borderRadius: 999, alignItems: "center", justifyContent: "center", gap: 2,
  },
  navItemOn: { backgroundColor: color.pine },
  navLabel: { color: color.inkSoft, fontSize: 11, fontWeight: "600" },
  navActive: { color: color.onInk, fontWeight: "800" },
});
