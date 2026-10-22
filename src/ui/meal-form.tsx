import React, { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import * as ImagePicker from "expo-image-picker";
import { Ionicons } from "@expo/vector-icons";
import type { MealRecord, NutrientRanges, Profile } from "../types";
import { persistMedia } from "../storage";
import { getAiSettingsVersion, isAiConfigured } from "../ai";
import { applyEstimatedMealQuantities, buildMealReviewAnalysis, createEmptyMealReviewRow, createMealReviewRows, mealReviewConfirmationMessage, mergeReviewedQuantities, updateMealReviewRow, type MealReviewRow } from "../meal-review";
import { estimateMealPortion, hasIncompleteMealRecognition } from "../meal-portion-reference";
import { MAX_MEAL_PHOTOS, mealBeforePhotoUris } from "../meal-photos";
import { hasMealIdentityConflict, resolveStoredNutritionReference } from "../../shared/nutrition.mjs";
import { nutritionFieldsFromAnalysis, nutritionFieldsFromMeal, parseMealNutritionFields } from "../meal-nutrition-fields";
import { createMealAnalysisDraft, photoAnalysisSnapshot, prepareMealAnalysisForSave, restoreMealFormDraft, type MealAnalysisDraft } from "../meal-analysis-draft";
import { type FormSession, useFormDraft, useFormSession } from "./useFormDraft";
import { Banner, Choice, DraftStatus, Field, MediaPreview, Note, Sheet, SmallButton, useBaseStyles } from "./components";
import { MealAnalysisList } from "./meal-analysis";
import { MealReviewPage } from "./meal-review";
import { AnalysisWaitTime } from "./analysis-wait-time";
import { confirmAction, errorText, localDateTime, notify, parseDateTime, today } from "./format";
import { radius, space, type ThemeTokens } from "./theme";
import { useTheme, useThemedStyles } from "./theme-provider";
import type { DraftKey, MealDraft, PhotoAnalysisResult, PhotoAnalysisSnapshot, SaveNutritionCorrection } from "./app-types";

type MealState = {
  occurredAt: string;
  mealType: MealRecord["mealType"];
  foodName: string;
  foodNameSource?: 'analysis' | 'user';
  portion: string;
  note: string;
  imageUri?: string;
  beforeImageUris?: string[];
  afterImageUri?: string;
  remaining: string;
  calories: string;
  protein: string;
  carbs: string;
  fat: string;
  analysisDraft: MealAnalysisDraft;
};
const mealState = (initial?: MealRecord): MealState => ({
  occurredAt:
    localDateTime(initial?.occurredAt) ||
    localDateTime(new Date().toISOString()),
  mealType: initial?.mealType ?? "午餐",
  foodName: initial?.foodName ?? "",
  // Keep the saved title until an explicit review confirmation replaces it.
  foodNameSource: initial?.foodNameSource ?? (initial?.foodName.trim() ? 'user' : undefined),
  portion: initial?.portion ?? "",
  note: initial?.note ?? "",
  imageUri: mealBeforePhotoUris(initial ?? {})[0],
  beforeImageUris: mealBeforePhotoUris(initial ?? {}),
  afterImageUri: initial?.afterImageUri,
  remaining: initial?.remaining ?? "",
  ...nutritionFieldsFromMeal(initial),
  analysisDraft: createMealAnalysisDraft(initial),
});
const normalizedDishName = (value: string) => value.normalize('NFKC').replace(/\s+/gu, '').toLowerCase();
const nutritionRows = [
  ['calories', '热量', 'kcal'], ['protein', '蛋白质', 'g'],
  ['carbs', '碳水', 'g'], ['fat', '脂肪', 'g'],
] as const;

function nutritionEstimateText(value: NutrientRanges[keyof NutrientRanges] | null, key: typeof nutritionRows[number][0]) {
  if (!value) return { estimate: '未知', range: '' };
  const step = key === 'calories' ? 10 : 1;
  const rounded = (amount: number) => String(Math.round(amount / step) * step);
  const estimate = rounded((value.min + value.max) / 2);
  const min = rounded(value.min);
  const max = rounded(value.max);
  return { estimate: `约 ${estimate}`, range: min === max ? '' : `${min}～${max}` };
}

export function MealForm({
  initial,
  profile = {},
  aiSettingsIssue = "",
  draftKey,
  session,
  onClose,
  onSave,
  onAnalyzePhoto,
  analyzeOnOpen = false,
  onSaveCorrection,
}: {
  initial?: MealRecord;
  profile?: Profile;
  aiSettingsIssue?: string;
  draftKey: DraftKey;
  session: FormSession;
  onClose: () => void;
  onSave: (draft: MealDraft, photoAnalysis?: PhotoAnalysisResult) => Promise<void>;
  onAnalyzePhoto: (meal: MealRecord, signal: AbortSignal) => Promise<PhotoAnalysisResult>;
  /** The saved-record entry point has already obtained consent to send. */
  analyzeOnOpen?: boolean;
  onSaveCorrection: SaveNutritionCorrection;
}) {
  const { color } = useTheme();
  const base = useBaseStyles();
  const st = useThemedStyles(createStyles);
  const draft = useFormDraft(draftKey, mealState(initial), session, {
    restore: (value) => restoreMealFormDraft(value, initial) as Partial<MealState>,
  });
  const { form, setForm } = draft;
  const beforePhotos = mealBeforePhotoUris(form);
  const photoCount = beforePhotos.length + (form.afterImageUri ? 1 : 0);
  const latestAnalysis = initial?.analyses?.filter((version) => version.sourceVersion === (initial.revision ?? 1)).at(-1);
  const hasDishCorrections = latestAnalysis?.analysis.components?.some((component) => component.nutritionReferenceStale);
  const formRef = useRef(form);
  formRef.current = form;
  const [error, setError] = useState("");
  const [nutritionEditing, setNutritionEditing] = useState(false);
  const analysisDraft = form.analysisDraft;
  const photoAnalysis = analysisDraft.confirmed ?? undefined;
  const [reviewOpen, setReviewOpen] = useState(false);
  const reviewResult = analysisDraft.review?.result;
  const reviewRows = analysisDraft.review?.rows ?? [];
  // Restoring a saved meal must not recalculate its quantities from today's
  // profile. A fresh AI result or an explicit reference edit starts a new estimate.
  const reviewNote = analysisDraft.review?.note ?? "";
  // Track the main note at review entry so both unconfirmed review edits and
  // subsequent main-form edits survive switching between the two pages.
  const [reviewError, setReviewError] = useState("");
  const reviewStatus = analysisDraft.review?.status ?? "";
  const [photoStatus, setPhotoStatus] = useState("");
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoStartedAt, setPhotoStartedAt] = useState<number | null>(null);
  const photoController = useRef<AbortController | undefined>(undefined);
  const photoGeneration = useRef(0);
  const startedOnOpen = useRef(false);
  const updateAnalysisDraft = (patch: Partial<MealAnalysisDraft>) => {
    const next = { ...formRef.current, analysisDraft: { ...formRef.current.analysisDraft, ...patch } };
    formRef.current = next;
    setForm(next);
  };
  const updateReviewDraft = (patch: Partial<NonNullable<MealAnalysisDraft['review']>>) => {
    const review = formRef.current.analysisDraft.review;
    if (review) updateAnalysisDraft({ review: { ...review, ...patch } });
  };
  const currentRows = () => formRef.current.analysisDraft.review?.rows ?? [];
  const setPreserveQuantities = (value: boolean) => updateAnalysisDraft({ preserveEstimatedQuantities: value });
  const setReviewNote = (note: string) => updateReviewDraft({ note, pending: true });
  const setReviewStatus = (status: string) => updateReviewDraft({ status });
  const setReviewResult = (result: PhotoAnalysisSnapshot) => {
    const previous = formRef.current.analysisDraft.review;
    updateAnalysisDraft({ review: { result: photoAnalysisSnapshot(result), rows: previous?.rows ?? [],
      note: previous?.note ?? formRef.current.note, mainNote: previous?.mainNote ?? formRef.current.note,
      status: previous?.status ?? '', pending: true } });
  };
  const cancelPhotoRequest = () => {
    photoGeneration.current += 1;
    photoController.current?.abort();
    photoController.current = undefined;
    setPhotoBusy(false);
    setPhotoStartedAt(null);
  };
  const lifecycle = useFormSession(session, {
    onClose,
    beforeClose: async () => {
      cancelPhotoRequest();
      await draft.persist();
    },
    onError: (e) => setError(errorText(e)),
  });
  useEffect(() => () => {
    photoGeneration.current += 1;
    photoController.current?.abort();
  }, []);
  const setRows = (rows: MealReviewRow[]) => {
    updateReviewDraft({ rows, pending: true });
  };
  const returnToMeal = () => {
    if (photoController.current) {
      cancelPhotoRequest();
      setReviewStatus("复核已取消，修改内容已保留。");
    }
    setReviewOpen(false);
  };
  useEffect(() => {
    if (!reviewOpen) return;
    const previous = session.requestClose;
    session.requestClose = returnToMeal;
    return () => { if (session.requestClose === returnToMeal) session.requestClose = previous; };
  }, [reviewOpen, session]);
  const appendPhotoSnapshot = (result: PhotoAnalysisSnapshot) => {
    // Equal content can come from separate AI requests or an explicit user
    // confirmation. Preserve each event and its provenance independently.
    updateAnalysisDraft({ history: [...formRef.current.analysisDraft.history, photoAnalysisSnapshot(result)] });
  };
  const resetPhotoResult = () => {
    updateAnalysisDraft({ preserveEstimatedQuantities: false, confirmed: null, review: null });
    setReviewOpen(false);
  };
  const update = (patch: Partial<MealState>) => {
    if (lifecycle.isIdle()) {
      if (Object.keys(patch).some((key) => ["imageUri", "beforeImageUris", "afterImageUri", "foodName", "portion", "remaining", "note", "mealType", "occurredAt"].includes(key))) {
        cancelPhotoRequest();
        if ("imageUri" in patch || "beforeImageUris" in patch || "afterImageUri" in patch) {
          resetPhotoResult();
          setPhotoStatus("");
        } else if (photoBusy) setPhotoStatus("表单已修改，已取消正在进行的识别。");
      }
      setForm((current) => {
        const next = { ...current, ...patch,
          ...("foodName" in patch ? { foodNameSource: 'user' as const } : {}) };
        formRef.current = next;
        return next;
      });
    }
  };
  const estimatedRows = (analysis: ReturnType<typeof buildMealReviewAnalysis>, rows: MealReviewRow[]) =>
    formRef.current.analysisDraft.preserveEstimatedQuantities ? rows
      : applyEstimatedMealQuantities(profile, formRef.current.mealType, analysis, rows);
  const confirmReviewedAnalysis = (analysis: ReturnType<typeof buildMealReviewAnalysis>, note: string) => {
    if (!formRef.current.analysisDraft.preserveEstimatedQuantities
      && analysis.components?.some((component) => component.userQuantity?.origin === 'estimated')) {
      const reference = estimateMealPortion(profile, formRef.current.mealType, analysis);
      if (reference.status === 'ready') {
        const prefix = '食用量参考：';
        const range = (value: { min: number; max: number } | null) => value ? `${value.min}～${value.max}` : '未知';
        const detail = `${prefix}每日 ${range(reference.dailyCalories)} kcal，${formRef.current.mealType} ${range(reference.mealCalories)} kcal；`
          + `整餐参考 ${range(reference.totalGrams)} g，各菜参考 ${range(reference.dishes[0]?.grams ?? null)} g，默认采用各菜区间中点整数克。`
          + reference.assumptions.join('');
        const assumptions = (analysis.assumptions ?? []).filter((item) => !item.startsWith(prefix));
        // Keep both the leading estimate disclosure and the trailing subtotal
        // disclosure when the model already used the full assumption budget.
        const retained = assumptions.length > 79 ? [assumptions[0], ...assumptions.slice(-78)] : assumptions;
        analysis = { ...analysis, assumptions: [...retained, detail.slice(0, 1000)] };
      }
    }
    const result: PhotoAnalysisResult = {
      model: "local/meal-review", createdAt: new Date().toISOString(), analysis,
    };
    appendPhotoSnapshot(result);
    // Confirmation is the user's explicit instruction to apply the edited dishes,
    // including to older records whose previous title had no ownership marker.
    const next = { ...formRef.current, foodName: analysis.foodName, foodNameSource: 'analysis' as const,
      note, ...nutritionFieldsFromAnalysis(analysis), analysisDraft: {
        ...formRef.current.analysisDraft, confirmed: result, preserveEstimatedQuantities: true,
        review: { result, rows: createMealReviewRows(analysis), note, mainNote: note,
          status: mealReviewConfirmationMessage(analysis), pending: false },
      } };
    formRef.current = next;
    setForm(next);
    setReviewError("");
    setPhotoStatus(mealReviewConfirmationMessage(analysis));
    setReviewOpen(false);
  };
  const requestPhotoAnalysis = async (
    reviewedInput?: ReturnType<typeof buildMealReviewAnalysis>,
    confirmAfterReview = false,
  ) => {
    if (!draft.loaded || draft.readFailed || !lifecycle.isIdle() || photoController.current) return;
    const snapshot = formRef.current;
    const photoUris = mealBeforePhotoUris(snapshot);
    if (!photoUris.length && !snapshot.afterImageUri && !initial) {
      if (reviewedInput) setReviewError("请填写修改后菜品的每 100 g 营养，或添加餐前照片后让 AI 更新营养参考。");
      return;
    }
    if (aiSettingsIssue) {
      if (reviewedInput) setReviewError(aiSettingsIssue);
      else setPhotoStatus(`${aiSettingsIssue}照片已保存。`);
      return;
    }
    if (!isAiConfigured()) {
      if (reviewedInput) setReviewError("请先连接 AI 服务以更新菜品营养，或自行填写每 100 g 四项营养后确认。");
      else setPhotoStatus("请先在“我的 → AI 服务设置”中连接 AI；照片已保存。");
      return;
    }
    const previousAnalysis = reviewedInput ?? snapshot.analysisDraft.confirmed?.analysis ?? latestAnalysis?.analysis;
    const previousRows = reviewedInput ? currentRows() : undefined;
    const preserveSavedQuantities = !reviewedInput && Boolean(previousAnalysis?.components?.length);
    const confirmedNote = reviewedInput ? reviewNote.trim() : snapshot.note.trim();
    const generation = ++photoGeneration.current;
    const settingsVersion = getAiSettingsVersion();
    const controller = new AbortController();
    photoController.current = controller;
    setPhotoStartedAt(Date.now());
    setPhotoBusy(true);
    setReviewError("");
    if (reviewedInput) setReviewStatus(confirmAfterReview ? "正在更新修改后菜品的营养，完成后填入…" : "正在按修改内容复核菜品与营养…");
    else setPhotoStatus("正在让 AI 识别餐前照片…");
    const meal: MealRecord = {
      id: `draft-${session.id}`, type: "meal", createdAt: new Date().toISOString(),
      occurredAt: new Date().toISOString(), mealType: snapshot.mealType,
      foodName: reviewedInput?.foodName ?? snapshot.foodName.trim(), portion: snapshot.portion.trim(), note: reviewedInput ? reviewNote.trim() : snapshot.note.trim(),
      imageUri: photoUris[0], beforeImageUris: photoUris, afterImageUri: snapshot.afterImageUri, remaining: snapshot.remaining.trim() || undefined,
      source: "photo", estimateStatus: "unknown",
      ...(previousAnalysis ? { revision: 1, analyses: [{
        id: `review-${generation}`, sourceVersion: 1, createdAt: new Date().toISOString(), model: "local/meal-review",
        analysis: reviewedInput ? { ...reviewedInput, components: reviewedInput.components?.map((component) => ({ ...component, nutritionReferenceStale: true })) } : previousAnalysis,
      }] } : {}),
    };
    try {
      const result = await onAnalyzePhoto(meal, controller.signal);
      if (!lifecycle.isIdle() || controller.signal.aborted || generation !== photoGeneration.current) return;
      if (settingsVersion !== getAiSettingsVersion()) throw new Error("AI 设置已变更，请重新发起识别。");
      appendPhotoSnapshot(result);
      const next = previousAnalysis ? { ...result, analysis: mergeReviewedQuantities(result.analysis, previousAnalysis) } : result;
      if (confirmAfterReview && reviewedInput) {
        // A targeted refresh for a renamed dish must not discard nutrition that
        // the user has explicitly entered for another, uniquely matched dish.
        next.analysis = { ...next.analysis, components: next.analysis.components?.map((component) => {
          const name = normalizedDishName(component.label);
          const previous = reviewedInput.components?.filter((item) => normalizedDishName(item.label) === name) ?? [];
          const unique = next.analysis.components?.filter((item) => normalizedDishName(item.label) === name).length === 1;
          const saved = previous.length === 1 && unique ? previous[0] : undefined;
          if (!saved || saved.userNutritionPer100g === undefined
            || (saved.nutritionReferenceStale && saved.userNutritionPer100g === null)) return component;
          return { ...component, userNutritionPer100g: saved.userNutritionPer100g };
        }) };
      }
      let freshRows = createMealReviewRows(next.analysis, previousRows);
      if (confirmAfterReview && previousRows) {
        freshRows = freshRows.map((row) => {
          const name = normalizedDishName(row.label);
          const previous = previousRows.filter((item) => normalizedDishName(item.label) === name);
          if (previous.length !== 1 || freshRows.filter((item) => normalizedDishName(item.label) === name).length !== 1) return row;
          const edited = previous[0];
          // A gram value or an explicit exclusion survives a refreshed cooking
          // description. Household counts still require the core measure match.
          if (!edited.quantityEdited || (edited.quantity.trim() && edited.quantityUnit !== 'g')) return row;
          return { ...row, quantity: edited.quantity, quantityUnit: 'g' as const,
            quantityOrigin: 'user' as const, quantityEdited: true };
        });
      }
      setPreserveQuantities(preserveSavedQuantities);
      const rows = estimatedRows(next.analysis, freshRows);
      setReviewResult(next);
      setRows(rows);
      if (!reviewedInput) {
        setReviewNote(snapshot.note);
        updateReviewDraft({ mainNote: snapshot.note });
      }
      if (confirmAfterReview && reviewedInput) {
        const names = (analysis: ReturnType<typeof buildMealReviewAnalysis>) =>
          (analysis.components ?? []).map((component) => normalizedDishName(component.label)).sort();
        const sameDishes = JSON.stringify(names(reviewedInput)) === JSON.stringify(names(next.analysis));
        const analysis = buildMealReviewAnalysis(next.analysis, rows);
        const unknownNutrition = new Set((analysis.coverage?.unknownNutritionLabels ?? []).map(normalizedDishName));
        const missingNutrition = unknownNutrition.size > 0
          || analysis.components?.some((component) => resolveStoredNutritionReference(component) === null);
        const identityUnconfirmed = analysis.components?.some(hasMealIdentityConflict)
          || (analysis.unresolved ?? []).some((item) => /重复|身份(?:待确认|不明|不确定|不清|冲突|无法确认)|(?:菜品|食材|菜名|种类).*(?:无法识别|无法确认|无法辨认|待确认|不明|不确定|冲突|疑似|看不清)|无法(?:识别|辨认).*(?:菜品|食材)|duplicate|identity|(?:dish|food|ingredient).*(?:ambiguous|conflict|uncertain)/iu.test(item));
        const incompleteRecognition = hasIncompleteMealRecognition(analysis);
        if (sameDishes && !missingNutrition && !identityUnconfirmed && !incompleteRecognition) {
          confirmReviewedAnalysis(analysis, confirmedNote);
          return;
        }
        setReviewStatus(!sameDishes ? "AI 复核后的菜品有变化，请核对后确认。"
          : identityUnconfirmed ? "AI 复核后仍有菜品身份待确认，请核对。"
            : incompleteRecognition ? "AI 复核后仍有菜品遗漏，请核对。" : "修改后的菜品营养仍待补充，请核对。");
        if (missingNutrition) setReviewError("部分菜品仍缺少营养参考，请补充每 100 g 营养，未知项不会按零计算。");
        else if (identityUnconfirmed) setReviewError("菜品身份仍有不确定项，请核对名称和做法后再确认，原表格尚未更新。");
        else if (incompleteRecognition) setReviewError("本餐菜品仍有遗漏或记录不完整，请补全后再确认，原表格尚未更新。");
      } else setReviewStatus(reviewedInput ? "AI 复核完成，请核对。" : "照片识别完成，请核对。");
      setPhotoStatus("识别结果待确认。");
      setReviewOpen(true);
    } catch (e) {
      if (lifecycle.isIdle() && !controller.signal.aborted && generation === photoGeneration.current) {
        if (reviewedInput) {
          setReviewStatus("AI 复核未完成，修改内容已保留。");
          setReviewError(errorText(e));
        } else setPhotoStatus(`照片识别失败：${errorText(e)}；照片和输入已保留。`);
      }
    } finally {
      if (photoController.current === controller) {
        photoController.current = undefined;
        if (lifecycle.isActive()) {
          setPhotoBusy(false);
          setPhotoStartedAt(null);
        }
      }
    }
  };
  const reviewWithAi = () => {
    if (!reviewResult || !lifecycle.isIdle() || photoController.current) return;
    try {
      const analysis = buildMealReviewAnalysis(reviewResult.analysis, currentRows());
      appendPhotoSnapshot({ model: "local/meal-review", createdAt: new Date().toISOString(), analysis });
      void requestPhotoAnalysis(analysis);
    } catch (e) { setReviewError(errorText(e)); }
  };
  const acceptReview = () => {
    if (!reviewResult || !lifecycle.isIdle() || photoController.current) return;
    try {
      const rows = estimatedRows(reviewResult.analysis, currentRows());
      const analysis = buildMealReviewAnalysis(reviewResult.analysis, rows);
      if (analysis.components?.some((component) => component.nutritionReferenceStale && component.userNutritionPer100g == null)) {
        appendPhotoSnapshot({ model: "local/meal-review", createdAt: new Date().toISOString(), analysis });
        void requestPhotoAnalysis(analysis, true);
        return;
      }
      confirmReviewedAnalysis(analysis, reviewNote.trim());
    } catch (e) { setReviewError(errorText(e)); }
  };
  const editConfirmed = () => {
    const result = formRef.current.analysisDraft.confirmed ?? latestAnalysis;
    if (!result) return;
    setPreserveQuantities(true);
    setReviewResult(result);
    setRows(estimatedRows(result.analysis, createMealReviewRows(result.analysis)));
    setReviewNote(formRef.current.note);
    updateReviewDraft({ mainNote: formRef.current.note });
    setReviewError("");
    setReviewStatus("核对后确认填入，也可修改后让 AI 复核。");
    setReviewOpen(true);
  };
  const openReview = () => {
    if (reviewResult) {
      setRows(estimatedRows(reviewResult.analysis, currentRows()));
      if (formRef.current.note !== formRef.current.analysisDraft.review?.mainNote) setReviewNote(formRef.current.note);
      updateReviewDraft({ mainNote: formRef.current.note });
      setReviewError("");
      setReviewOpen(true);
    } else editConfirmed();
  };
  const saveCorrection: SaveNutritionCorrection = async (mealId, revision, baseAnalysisId, analysis) => {
    await onSaveCorrection(mealId, revision, baseAnalysisId, analysis);
    if (!lifecycle.isActive()) return;
    cancelPhotoRequest();
    resetPhotoResult();
    setPreserveQuantities(true);
    setPhotoStatus("");
    // Refresh only after the user explicitly saves a local correction.
    // Background AI versions must never overwrite the open form's inputs.
    setForm((current) => {
      const next = { ...current, ...nutritionFieldsFromAnalysis(analysis) };
      formRef.current = next;
      return next;
    });
    setError("");
  };
  const analyzeSavedMeal = () => {
    if (initial && lifecycle.isIdle()) confirmPhotoAnalysis();
  };
  const confirmPhotoAnalysis = () => {
    if (!draft.loaded || draft.readFailed || !lifecycle.isIdle() || photoController.current
      || (!initial && !mealBeforePhotoUris(formRef.current).length)) return;
    if (aiSettingsIssue || !isAiConfigured()) {
      void requestPhotoAnalysis();
      return;
    }
    const generation = photoGeneration.current;
    const settingsVersion = getAiSettingsVersion();
    confirmAction(
      mealBeforePhotoUris(formRef.current).length ? "分析餐前照片？" : "分析这餐？",
      "本次照片和必要餐食信息将发送到你选择的 AI 服务，用于识别菜品、估算每 100 g 营养，以及在修改菜品后更新营养参考。已有食用量仅按相同菜品和做法保留，确认保存后才更新本餐。服务可能收费，数据按供应商政策处理。",
      "同意并分析",
      () => {
        if (generation === photoGeneration.current && settingsVersion === getAiSettingsVersion())
          void requestPhotoAnalysis();
      },
    );
  };
  useEffect(() => {
    if (!analyzeOnOpen || !draft.loaded || draft.readFailed || startedOnOpen.current) return;
    startedOnOpen.current = true;
    void requestPhotoAnalysis();
  }, [analyzeOnOpen, draft.loaded, draft.readFailed]);
  const pick = async (camera: boolean) => {
    if (!draft.loaded) return;
    const available = MAX_MEAL_PHOTOS - mealBeforePhotoUris(formRef.current).length - (formRef.current.afterImageUri ? 1 : 0);
    if (available <= 0) {
      setError(`每餐最多保存 ${MAX_MEAL_PHOTOS} 张照片。`);
      return;
    }
    if (!lifecycle.beginMedia()) return;
    setError("");
    if (photoController.current) {
      cancelPhotoRequest();
      setPhotoStatus("照片分析已取消，已有照片和输入已保留。");
    }
    let shouldAnalyze = false;
    try {
      const permission = camera
        ? await ImagePicker.requestCameraPermissionsAsync()
        : await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!lifecycle.isActive()) return;
      if (!permission.granted)
        throw new Error(
          camera
            ? "没有相机权限，也可以从相册选择或手动记录。"
            : "没有照片权限，也可以跳过照片。",
        );
      const result = camera
        ? await ImagePicker.launchCameraAsync({
            mediaTypes: ImagePicker.MediaTypeOptions.Images,
            quality: 1,
            allowsEditing: false,
          })
        : await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ImagePicker.MediaTypeOptions.Images,
            quality: 1,
            allowsEditing: false,
            allowsMultipleSelection: available > 1,
            selectionLimit: available,
          });
      if (!lifecycle.isActive()) return;
      if (!result.canceled && result.assets[0]) {
        if (result.assets.length > available)
          throw new Error(`本餐还可添加 ${available} 张照片，请重新选择。`);
        const added: string[] = [];
        for (const asset of result.assets) {
          added.push(await persistMedia(asset.uri, "image"));
          if (!lifecycle.isActive()) return;
        }
        if (!lifecycle.isActive()) return;
        cancelPhotoRequest();
        resetPhotoResult();
        setPhotoStatus("");
        setForm((current) => {
          const photoUris = [...new Set([...mealBeforePhotoUris(current), ...added])];
          const next = { ...current, imageUri: photoUris[0], beforeImageUris: photoUris };
          formRef.current = next;
          return next;
        });
        await draft.persist();
        shouldAnalyze = true;
      }
    } catch (e) {
      if (lifecycle.isActive()) setError(errorText(e));
    } finally {
      lifecycle.endOperation();
    }
    if (shouldAnalyze) confirmPhotoAnalysis();
  };
  const submit = async () => {
    if (!draft.loaded || !lifecycle.beginSave()) return;
    cancelPhotoRequest();
    setError("");
    try {
      const snapshot = formRef.current;
      const photoUris = mealBeforePhotoUris(snapshot);
      if (!snapshot.foodName.trim() && !photoUris.length)
        throw new Error("请填写食物名称；没有照片也可以手动记录。");
      const occurredAt = parseDateTime(snapshot.occurredAt);
      // A saved current analysis is copied into the new input revision; old
      // analysis IDs must never be reused by the new snapshot.
      const { result: finalAnalysis, estimate } = prepareMealAnalysisForSave(snapshot.analysisDraft, snapshot, initial);
      await draft.persist();
      if (!lifecycle.isActive()) return;
      await onSave({
        occurredAt,
        mealType: snapshot.mealType,
        foodName: snapshot.foodName.trim() || "未命名餐食",
        foodNameSource: snapshot.foodNameSource === 'analysis' ? 'analysis' : 'user',
        portion: snapshot.portion.trim(),
        note: snapshot.note.trim(),
        imageUri: photoUris[0],
        beforeImageUris: photoUris,
        afterImageUri: snapshot.afterImageUri,
        remaining: snapshot.remaining.trim() || undefined,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        source: photoUris.length ? "photo" : "manual",
        estimate,
        estimateStatus: estimate ? "estimated" : "unknown",
      }, finalAnalysis);
      if (!lifecycle.isActive()) return;
      await draft
        .finish()
        .catch((e) => {
          if (lifecycle.isActive())
            notify("记录已保存", `草稿清理失败：${errorText(e)}`);
        });
      if (lifecycle.isActive()) onClose();
    } catch (e) {
      if (lifecycle.isActive()) setError(errorText(e));
    } finally {
      lifecycle.endOperation();
    }
  };
  let reviewPreview = null;
  if (reviewResult) {
    try { reviewPreview = buildMealReviewAnalysis(reviewResult.analysis, reviewRows); } catch { /* Incomplete numeric drafts stay editable. */ }
  }
  const portionReference = estimateMealPortion(profile, form.mealType, reviewPreview);
  const confirmedAnalysis = photoAnalysis?.analysis ?? latestAnalysis?.analysis;
  const showNutritionSummary = Boolean(confirmedAnalysis?.components?.length) && !nutritionEditing;
  let nutritionRanges: NutrientRanges | null = null;
  let nutritionIncomplete = false;
  try { nutritionRanges = parseMealNutritionFields(form); }
  catch { nutritionIncomplete = true; }
  const recordDateText = form.occurredAt.slice(0, 10);
  const isTodayRecord = recordDateText === today();
  const visiblePhotoStatus = photoStatus || (analysisDraft.review?.pending ? "识别结果待确认。"
    : photoAnalysis ? mealReviewConfirmationMessage(photoAnalysis.analysis) : "");
  if (reviewOpen && reviewResult) return <MealReviewPage
    rows={reviewRows} note={reviewNote} status={reviewStatus} error={reviewError} busy={photoBusy}
    startedAt={photoStartedAt} preview={reviewPreview}
    portionReference={portionReference}
    preservePortions={analysisDraft.preserveEstimatedQuantities}
    onChange={(id, patch) => { if (!photoBusy) {
      setReviewError("");
      const current = currentRows().find((row) => row.id === id);
      if (current && ((patch.label !== undefined && patch.label.trim() !== current.label.trim())
        || (patch.cookingMethod !== undefined && patch.cookingMethod.trim() !== current.cookingMethod.trim())
        || patch.nutrients !== undefined)) setPreserveQuantities(false);
      setRows(estimatedRows(reviewResult.analysis, currentRows().map((row) => row.id === id ? updateMealReviewRow(row, patch) : row)));
    } }}
    onNote={setReviewNote} onAdd={() => {
      setPreserveQuantities(false);
      setRows(estimatedRows(reviewResult.analysis, [...currentRows(), createEmptyMealReviewRow()]));
    }}
    onRemove={(id) => {
      setPreserveQuantities(false);
      setRows(estimatedRows(reviewResult.analysis, currentRows().filter((row) => row.id !== id)));
    }}
    onBack={returnToMeal} onReview={reviewWithAi} onConfirm={acceptReview}
    onCancel={() => { cancelPhotoRequest(); setReviewStatus("复核已取消，修改内容已保留。"); }}
    onClearError={() => setReviewError("")}
  />;
  return (
    <Sheet
      title={initial ? "编辑饮食" : "记录饮食"}
      tone="meal"
      onClose={lifecycle.requestClose}
      onSave={() => {
        void submit();
      }}
      saving={lifecycle.saving}
      closing={lifecycle.closing}
      disabled={lifecycle.busy || !draft.loaded || draft.readFailed}
    >
      <>
        <DraftStatus saved={draft.saved} error={draft.draftError} />
        {draft.readFailed && <SmallButton icon="refresh-outline" label="重试读取餐食草稿" onPress={draft.retryLoad} />}
        {Boolean(error) && (
          <Banner text={error} danger onClose={() => setError("")} />
        )}
        {beforePhotos.length ? (
          <View testID="meal-before-photos">
            {beforePhotos.map((uri, index) => <MediaPreview
              key={uri}
              uri={uri}
              label={beforePhotos.length === 1 ? "餐前照片" : `餐前照片 ${index + 1}`}
              onRemove={() => {
                const remaining = mealBeforePhotoUris(formRef.current).filter((photo) => photo !== uri);
                update({ imageUri: remaining[0], beforeImageUris: remaining });
              }}
            />)}
          </View>
        ) : (
          <View style={st.capture}>
            <View style={st.captureIcon}>
              <Ionicons name="camera-outline" size={28} color={color.mealText} />
            </View>
            <Text style={st.captureTitle}>先拍下这一餐</Text>
            <Text style={st.captureText}>照片只保存在本机，分析前会单独询问。没有照片也能直接填写。</Text>
            <View style={st.captureRow}>
              <Pressable
                accessibilityRole="button"
                disabled={!draft.loaded || !lifecycle.isIdle()}
                style={({ pressed }) => [st.captureMain, pressed && base.pressed]}
                onPress={() => {
                  void pick(true);
                }}
              >
                <Ionicons name="camera" size={18} color={color.onMeal} />
                <Text style={st.captureMainText}>拍照</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={!draft.loaded || !lifecycle.isIdle()}
                style={({ pressed }) => [st.captureAlt, pressed && base.pressed]}
                onPress={() => {
                  void pick(false);
                }}
              >
                <Ionicons name="images-outline" size={18} color={color.mealText} />
                <Text style={st.captureAltText}>选择照片</Text>
              </Pressable>
            </View>
          </View>
        )}
        {beforePhotos.length > 0 && (
          <View style={st.photoTools}>
            <SmallButton icon="sparkles-outline" label="重新识别照片" disabled={photoBusy || !lifecycle.isIdle()}
              onPress={confirmPhotoAnalysis} />
            {reviewResult && <SmallButton icon="reader-outline" label="查看识别结果" disabled={photoBusy}
              onPress={openReview} />}
            <SmallButton
              icon="images-outline"
              label="添加餐前照片"
              disabled={!draft.loaded || !lifecycle.isIdle() || photoCount >= MAX_MEAL_PHOTOS}
              onPress={() => { void pick(false); }}
            />
          </View>
        )}
        {beforePhotos.length > 0 && <Text style={st.photoText}>
          {photoCount >= MAX_MEAL_PHOTOS
            ? `已达到每餐 ${MAX_MEAL_PHOTOS} 张照片上限`
            : `可从不同角度添加餐前照片，每餐最多 ${MAX_MEAL_PHOTOS} 张。`}
        </Text>}
        {Boolean(form.afterImageUri) && (
          <MediaPreview
            uri={form.afterImageUri!}
            label="餐后照片"
            onRemove={() => update({ afterImageUri: undefined })}
          />
        )}
        {(Boolean(visiblePhotoStatus) || photoBusy || photoAnalysis) && (
          <View style={st.photoPanel}>
            {Boolean(visiblePhotoStatus) && (
              <View style={st.photoStatusRow}>
                {photoBusy && <View style={st.pulse} />}
                <Text accessibilityRole="alert" style={st.photoStatus}>{visiblePhotoStatus}</Text>
              </View>
            )}
            {photoBusy && photoStartedAt !== null && <Text style={st.photoText}><AnalysisWaitTime startedAt={photoStartedAt} /></Text>}
            {photoBusy && <SmallButton icon="close-circle-outline" label="取消照片分析" onPress={() => {
              cancelPhotoRequest();
              setPhotoStatus("照片分析已取消，照片和输入已保留。");
            }} />}
          </View>
        )}
        <Choice
          label="餐次"
          tone="meal"
          value={form.mealType}
          choices={(
            ["早餐", "午餐", "晚餐", "加餐"] as MealRecord["mealType"][]
          ).map((value) => [value, value])}
          onChange={(value) => update({ mealType: value })}
        />
        <Field
          label="食物名称"
          value={form.foodName}
          onChangeText={(value) => update({ foodName: value })}
          placeholder="例如：鸡胸肉和米饭"
        />
        <Field
          label="发生时间（YYYY-MM-DD HH:mm）"
          value={form.occurredAt}
          onChangeText={(value) => update({ occurredAt: value })}
          placeholder="2026-10-10 12:30"
        />
        {recordDateText.length === 10 && !isTodayRecord && <View testID="meal-date-scope-hint" style={st.dateHintRow}>
          <Text style={st.dateHintText}>记录日期为 {recordDateText}；保存后会出现在“记录”页，不计入今天（{today()}）的首页汇总。</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="把记录时间改为现在" onPress={() => update({ occurredAt: localDateTime(new Date().toISOString()) })}
            style={({ pressed }) => [st.dateHintAction, pressed && base.pressed]}>
            <Text style={st.dateHintActionText}>改为现在</Text>
          </Pressable>
        </View>}
        <View style={st.manual}>
          <View testID="meal-nutrition-header" style={st.nutritionHeader}>
            <Text style={st.nutritionTitle}>营养值（可选）</Text>
            <View style={st.nutritionActions}>
              {Boolean(confirmedAnalysis?.components?.length) && <Pressable
                testID="meal-edit-portions" accessibilityRole="button" accessibilityLabel="修改本餐食用量"
                disabled={photoBusy || !lifecycle.isIdle()}
                accessibilityState={{ disabled: photoBusy || !lifecycle.isIdle() }}
                onPress={openReview}
                style={({ pressed }) => [st.nutritionAction, pressed && base.pressed, (photoBusy || !lifecycle.isIdle()) && base.dim]}
              >
                <Ionicons name="create-outline" size={16} color={color.mealText} />
                <Text style={st.nutritionActionText}>修改本餐食用量</Text>
              </Pressable>}
              {Boolean(confirmedAnalysis?.components?.length) && <Pressable
                testID="meal-edit-nutrients" accessibilityRole="button"
                accessibilityLabel={nutritionEditing ? '完成修改营养值' : '修改营养值'}
                onPress={() => setNutritionEditing((value) => !value)}
                style={({ pressed }) => [st.nutritionAction, pressed && base.pressed]}
              >
                <Ionicons name={nutritionEditing ? "checkmark-outline" : "create-outline"} size={16} color={color.mealText} />
                <Text style={st.nutritionActionText}>{nutritionEditing ? "完成" : "修改营养值"}</Text>
              </Pressable>}
            </View>
          </View>
          {showNutritionSummary ? <>
            <Text style={st.nutritionHelp}>按当前菜品营养参考和食用量估算；范围反映营养参考的不确定性。</Text>
            {nutritionIncomplete && <Text style={st.nutritionIncomplete}>四项营养尚未填完整，请点击“修改营养值”补齐或全部清空。</Text>}
            <View testID="meal-nutrition-summary" style={st.nutritionSummary}>
              {nutritionRows.map(([key, label, unit]) => {
                const display = nutritionEstimateText(nutritionRanges?.[key] ?? null, key);
                return <View key={key} testID={`meal-nutrition-${key}`} style={st.nutritionSummaryItem}>
                  <Text style={st.nutritionSummaryLabel}>{label}</Text>
                  <Text style={st.nutritionSummaryValue}>{display.estimate}<Text style={st.nutritionSummaryUnit}> {unit}</Text></Text>
                  {display.range ? <Text style={st.nutritionSummaryRange}>估算范围 {display.range} {unit}</Text>
                    : <Text style={st.nutritionSummaryRange}>{display.estimate === '未知' ? '未填写' : '范围未展开'}</Text>}
                </View>;
              })}
            </View>
          </> : <>
            <Text style={st.nutritionHelp}>填写数值或区间（如 450～550）；全部留空表示未知。</Text>
            <View style={st.two}>
              <Field label="热量 kcal" value={form.calories} onChangeText={(value) => update({ calories: value })} placeholder="例如 500 或 450～550" />
              <Field label="蛋白质 g" value={form.protein} onChangeText={(value) => update({ protein: value })} placeholder="例如 20 或 18～22" />
            </View>
            <View style={st.two}>
              <Field label="碳水 g" value={form.carbs} onChangeText={(value) => update({ carbs: value })} placeholder="例如 60 或 55～65" />
              <Field label="脂肪 g" value={form.fat} onChangeText={(value) => update({ fat: value })} placeholder="例如 15 或 12～18" />
            </View>
          </>}
        </View>
        <Field
          label="备注（可选）"
          value={form.note}
          onChangeText={(value) => update({ note: value })}
          placeholder="补充你知道的信息"
          multiline
        />
        {initial && !photoAnalysis && <MealAnalysisList meal={initial} onSaveCorrection={saveCorrection} />}
        {!beforePhotos.length && reviewResult && <SmallButton icon="reader-outline" label="查看识别结果" disabled={photoBusy}
          onPress={openReview} />}
        {initial && latestAnalysis?.analysis.components?.length && !photoAnalysis
          ? <SmallButton icon="create-outline" label="修改识别结果" onPress={editConfirmed} /> : null}
        {initial && (
          <SmallButton
            icon="sparkles-outline"
            label={hasDishCorrections ? "重新分析已修正菜品" : "分析已保存的这餐"}
            onPress={analyzeSavedMeal}
          />
        )}
        {!initial && <Note icon="lock-closed-outline" text="无法估算时保留“未知”，不会补写数值。AI 结果与原始输入分开保存。" tone={color.inkSoft} tint={color.sunken} />}
      </>
    </Sheet>
  );
}

const createStyles = ({ color, type }: ThemeTokens) => StyleSheet.create({
  capture: {
    backgroundColor: color.mealTint, borderRadius: radius.block, padding: space.xl, borderWidth: 1, borderColor: color.mealBorder, borderTopWidth: 3, borderTopColor: color.meal,
    alignItems: "center", marginBottom: space.xl,
  },
  captureIcon: {
    width: 52, height: 52, borderRadius: 26, backgroundColor: color.surface,
    alignItems: "center", justifyContent: "center", marginBottom: space.md,
  },
  captureTitle: { ...type.heading, fontSize: 18, lineHeight: 24 },
  captureText: { ...type.bodySoft, textAlign: "center", marginTop: space.xs, maxWidth: 300 },
  captureRow: { flexDirection: "row", gap: space.sm, marginTop: space.lg, alignSelf: "stretch" },
  captureMain: {
    flex: 1.4, minHeight: 48, borderRadius: radius.pill, backgroundColor: color.meal,
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
  },
  captureMainText: { color: color.onMeal, fontSize: 14.5, fontWeight: "800" },
  captureAlt: {
    flex: 1, minHeight: 48, borderRadius: radius.pill, backgroundColor: "transparent", borderWidth: 1.5, borderColor: color.meal,
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
  },
  captureAltText: { color: color.ink, fontSize: 14.5, fontWeight: "800" },
  photoTools: { flexDirection: "row", flexWrap: "wrap", columnGap: space.sm },
  photoPanel: {
    borderLeftWidth: 3, borderColor: color.meal, paddingLeft: space.md, marginBottom: space.xl,
  },
  photoStatusRow: { flexDirection: "row", alignItems: "center", gap: space.sm, marginBottom: space.sm },
  pulse: { width: 8, height: 8, borderRadius: 4, backgroundColor: color.meal },
  photoStatus: { ...type.label, flex: 1 },
  photoText: { ...type.bodySoft, marginBottom: 4 },
  two: { flexDirection: "row", gap: space.md },
  manual: {
    marginTop: space.sm, paddingTop: space.sm, borderTopWidth: 1, borderColor: color.line,
  },
  nutritionHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm, marginBottom: space.xs },
  nutritionActions: { flexDirection: "row", alignItems: "center", gap: space.xs, flexShrink: 0 },
  nutritionTitle: { ...type.heading, flexShrink: 1 },
  nutritionAction: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 4, minHeight: 44, flexShrink: 0 },
  nutritionActionText: { ...type.small, color: color.mealText, fontWeight: "700" },
  nutritionHelp: { ...type.small, marginBottom: space.lg },
  nutritionSummary: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, marginBottom: space.lg },
  nutritionSummaryItem: { width: "48%", minWidth: 130, flexGrow: 1, borderRadius: 10, padding: space.md, backgroundColor: color.sunken },
  nutritionSummaryLabel: { fontSize: 10.5, lineHeight: 14, fontWeight: "700", color: color.inkSoft },
  nutritionSummaryValue: { ...type.title, ...type.mono, color: color.ink, marginTop: 4 },
  nutritionSummaryUnit: { ...type.small, color: color.inkSoft },
  nutritionSummaryRange: { ...type.small, color: color.inkFaint, marginTop: 2 },
  nutritionIncomplete: { ...type.small, color: color.danger, marginBottom: space.sm },
  dateHintRow: { flexDirection: "row", alignItems: "center", gap: space.sm, marginTop: space.xs, marginBottom: space.sm },
  dateHintText: { ...type.small, color: color.mealText, flex: 1 },
  dateHintAction: { minHeight: 36, justifyContent: "center", paddingHorizontal: space.sm },
  dateHintActionText: { ...type.small, color: color.mealText, fontWeight: "700" },
});
