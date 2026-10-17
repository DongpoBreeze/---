import React, { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import * as ImagePicker from "expo-image-picker";
import { Ionicons } from "@expo/vector-icons";
import type { MealRecord } from "../types";
import { persistMedia } from "../storage";
import { getAiSettingsVersion, isAiConfigured } from "../ai";
import { mealPhotoAutofill, mealPhotoEstimateText } from "../meal-photo-autofill";
import { type FormSession, useFormDraft, useFormSession } from "./useFormDraft";
import { Banner, Choice, DraftStatus, Field, Legend, MediaPreview, Note, Sheet, SmallButton, s as base } from "./components";
import { MealAnalysisList, MealNutritionBasis, MealNutritionReference } from "./meal-analysis";
import { confirmAction, errorText, localDateTime, notify, parseDateTime } from "./format";
import { color, radius, space, type } from "./theme";
import type { DraftKey, MealDraft, PhotoAnalysisResult, SaveNutritionCorrection } from "./app-types";

type MealState = {
  occurredAt: string;
  mealType: MealRecord["mealType"];
  foodName: string;
  portion: string;
  note: string;
  imageUri?: string;
  afterImageUri?: string;
  remaining: string;
  calories: string;
  protein: string;
  carbs: string;
  fat: string;
};
const mealState = (initial?: MealRecord): MealState => ({
  occurredAt:
    localDateTime(initial?.occurredAt) ||
    localDateTime(new Date().toISOString()),
  mealType: initial?.mealType ?? "午餐",
  foodName: initial?.foodName ?? "",
  portion: initial?.portion ?? "",
  note: initial?.note ?? "",
  imageUri: initial?.imageUri,
  afterImageUri: initial?.afterImageUri,
  remaining: initial?.remaining ?? "",
  calories: initial?.estimate ? String(initial.estimate.calories) : "",
  protein: initial?.estimate ? String(initial.estimate.protein) : "",
  carbs: initial?.estimate ? String(initial.estimate.carbs) : "",
  fat: initial?.estimate ? String(initial.estimate.fat) : "",
});

export function MealForm({
  initial,
  draftKey,
  session,
  onClose,
  onSave,
  onAnalyzePhoto,
  onAnalyze,
  onSaveCorrection,
}: {
  initial?: MealRecord;
  draftKey: DraftKey;
  session: FormSession;
  onClose: () => void;
  onSave: (draft: MealDraft, photoAnalysis?: PhotoAnalysisResult) => Promise<void>;
  onAnalyzePhoto: (meal: MealRecord, signal: AbortSignal) => Promise<PhotoAnalysisResult>;
  onAnalyze?: () => void;
  onSaveCorrection: SaveNutritionCorrection;
}) {
  const draft = useFormDraft(draftKey, mealState(initial), session);
  const { form, setForm } = draft;
  const latestAnalysis = initial?.analyses?.filter((version) => version.sourceVersion === (initial.revision ?? 1)).at(-1);
  const hasDishCorrections = latestAnalysis?.analysis.components?.some((component) => component.nutritionReferenceStale);
  const formRef = useRef(form);
  formRef.current = form;
  const [error, setError] = useState("");
  const [photoAnalysis, setPhotoAnalysis] = useState<PhotoAnalysisResult>();
  const [photoStatus, setPhotoStatus] = useState("");
  const [photoBasisOpen, setPhotoBasisOpen] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const photoController = useRef<AbortController | undefined>(undefined);
  const photoGeneration = useRef(0);
  const cancelPhotoRequest = () => {
    photoGeneration.current += 1;
    photoController.current?.abort();
    photoController.current = undefined;
    setPhotoBusy(false);
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
  const update = (patch: Partial<MealState>) => {
    if (lifecycle.isIdle()) {
      if (Object.keys(patch).some((key) => ["imageUri", "afterImageUri", "foodName", "portion", "remaining", "note", "mealType", "occurredAt"].includes(key))) {
        cancelPhotoRequest();
        setPhotoAnalysis(undefined);
        if (photoStatus) setPhotoStatus("表单已修改，请重新识别照片。");
      }
      setForm((current) => {
        const next = { ...current, ...patch };
        formRef.current = next;
        return next;
      });
    }
  };
  const requestPhotoAnalysis = async () => {
    if (!lifecycle.isIdle() || photoController.current) return;
    const snapshot = formRef.current;
    if (!snapshot.imageUri) return;
    if (!isAiConfigured()) {
      setPhotoStatus("请先在“我的 → AI 服务设置”中连接 AI；照片已保存。");
      return;
    }
    const generation = ++photoGeneration.current;
    const controller = new AbortController();
    photoController.current = controller;
    setPhotoAnalysis(undefined);
    setPhotoBusy(true);
    setPhotoStatus("正在让 AI 识别餐前照片…");
    const slow = setTimeout(() => {
      if (lifecycle.isActive() && generation === photoGeneration.current)
        setPhotoStatus("照片分析已等待 30 秒，仍在处理中。");
    }, 30000);
    const meal: MealRecord = {
      id: `draft-${session.id}`, type: "meal", createdAt: new Date().toISOString(),
      occurredAt: new Date().toISOString(), mealType: snapshot.mealType,
      foodName: snapshot.foodName.trim(), portion: snapshot.portion.trim(), note: snapshot.note.trim(),
      imageUri: snapshot.imageUri, afterImageUri: snapshot.afterImageUri, remaining: snapshot.remaining.trim() || undefined,
      source: "photo", estimateStatus: "unknown",
    };
    try {
      const result = await onAnalyzePhoto(meal, controller.signal);
      if (!lifecycle.isIdle() || controller.signal.aborted || generation !== photoGeneration.current) return;
      const autofill = mealPhotoAutofill(result.analysis);
      setForm((current) => {
        const next = {
          ...current,
          foodName: current.foodName.trim() ? current.foodName : autofill.foodName,
          portion: current.portion.trim() ? current.portion : autofill.portion,
        };
        formRef.current = next;
        return next;
      });
      setPhotoAnalysis(result);
      setPhotoStatus("照片识别完成，请核对。");
      await draft.persist();
    } catch (e) {
      if (lifecycle.isIdle() && !controller.signal.aborted && generation === photoGeneration.current)
        setPhotoStatus(`照片识别失败：${errorText(e)}；照片和输入已保留。`);
    } finally {
      clearTimeout(slow);
      if (photoController.current === controller) {
        photoController.current = undefined;
        if (lifecycle.isActive()) setPhotoBusy(false);
      }
    }
  };
  const analyzeSavedMeal = () => {
    if (!initial || !onAnalyze || !lifecycle.isIdle()) return;
    if (JSON.stringify(formRef.current) !== JSON.stringify(mealState(initial))) {
      setError("请先保存当前修改，再分析。");
      return;
    }
    onAnalyze();
  };
  const confirmPhotoAnalysis = () => {
    if (initial && onAnalyze) {
      analyzeSavedMeal();
      return;
    }
    if (!lifecycle.isIdle() || photoController.current || !formRef.current.imageUri) return;
    if (!isAiConfigured()) {
      void requestPhotoAnalysis();
      return;
    }
    const generation = photoGeneration.current;
    const settingsVersion = getAiSettingsVersion();
    confirmAction(
      "分析餐前照片？",
      "本次照片和必要餐食信息将发送到你选择的 AI 服务，用于识别菜品并估算每 100 g 可食用成品的营养范围。实际食用量由你填写。服务可能收费，数据按供应商政策处理。",
      "同意并分析",
      () => {
        if (generation === photoGeneration.current && settingsVersion === getAiSettingsVersion())
          void requestPhotoAnalysis();
      },
    );
  };
  const pick = async (camera: boolean, after = false) => {
    if (!lifecycle.beginMedia()) return;
    setError("");
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
          });
      if (!lifecycle.isActive()) return;
      if (!result.canceled && result.assets[0]) {
        const uri = await persistMedia(result.assets[0].uri, "image");
        if (!lifecycle.isActive()) return;
        cancelPhotoRequest();
        setPhotoAnalysis(undefined);
        setPhotoStatus("");
        setForm((current) => {
          const next = { ...current, [after ? "afterImageUri" : "imageUri"]: uri };
          formRef.current = next;
          return next;
        });
        await draft.persist();
        shouldAnalyze = !after;
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
      if (!form.foodName.trim() && !form.imageUri)
        throw new Error("请填写食物名称；没有照片也可以手动记录。");
      const occurredAt = parseDateTime(form.occurredAt);
      const values = [form.calories, form.protein, form.carbs, form.fat];
      let estimate: MealRecord["estimate"];
      if (values.some((value) => value.trim())) {
        if (values.some((value) => !value.trim()))
          throw new Error("手动营养值请完整填写四项。");
        const numbers = values.map(Number);
        if (numbers.some((value) => !Number.isFinite(value) || value < 0))
          throw new Error("营养值必须是大于等于 0 的数字。");
        estimate = {
          calories: numbers[0],
          protein: numbers[1],
          carbs: numbers[2],
          fat: numbers[3],
        };
      }
      await draft.persist();
      if (!lifecycle.isActive()) return;
      await onSave({
        occurredAt,
        mealType: form.mealType,
        foodName: form.foodName.trim() || "未命名餐食",
        portion: form.portion.trim(),
        note: form.note.trim(),
        imageUri: form.imageUri,
        afterImageUri: form.afterImageUri,
        remaining: form.remaining.trim() || undefined,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        source: form.imageUri ? "photo" : "manual",
        estimate,
        estimateStatus: estimate ? "estimated" : "unknown",
      }, photoAnalysis);
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
      disabled={lifecycle.busy || !draft.loaded}
    >
      <>
        <DraftStatus saved={draft.saved} error={draft.draftError} />
        {Boolean(error) && (
          <Banner text={error} danger onClose={() => setError("")} />
        )}
        {form.imageUri ? (
          <MediaPreview
            uri={form.imageUri}
            label="餐前照片"
            onRemove={() => update({ imageUri: undefined })}
          />
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
                style={({ pressed }) => [st.captureMain, pressed && base.pressed]}
                onPress={() => {
                  void pick(true);
                }}
              >
                <Ionicons name="camera" size={18} color={color.onInk} />
                <Text style={st.captureMainText}>拍照</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
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
        {Boolean(form.imageUri) && (
          <View style={st.photoTools}>
            <SmallButton icon="sparkles-outline" label="重新识别照片" disabled={photoBusy || !lifecycle.isIdle()}
              onPress={confirmPhotoAnalysis} />
            {!form.afterImageUri && (
              <SmallButton
                icon="images-outline"
                label="添加餐后照片"
                onPress={() => {
                  void pick(false, true);
                }}
              />
            )}
          </View>
        )}
        {Boolean(form.afterImageUri) && (
          <MediaPreview
            uri={form.afterImageUri!}
            label="餐后照片"
            onRemove={() => update({ afterImageUri: undefined })}
          />
        )}
        {(Boolean(photoStatus) || photoBusy || photoAnalysis) && (
          <View style={st.photoPanel}>
            {Boolean(photoStatus) && (
              <View style={st.photoStatusRow}>
                {photoBusy && <View style={st.pulse} />}
                <Text accessibilityRole="alert" style={st.photoStatus}>{photoStatus}</Text>
              </View>
            )}
            {photoBusy && <SmallButton icon="close-circle-outline" label="取消照片分析" onPress={() => {
              cancelPhotoRequest();
              setPhotoStatus("照片分析已取消，照片和输入已保留。");
            }} />}
            {photoAnalysis && <View>
              <Text style={st.photoModel}>照片分析 · {photoAnalysis.model}</Text>
              <Text style={st.photoText}>
                {photoAnalysis.analysis.components?.length
                  ? `识别到：${[...new Set(photoAnalysis.analysis.components.map((component) => component.label.trim()).filter(Boolean))].join("、")}`
                  : "尚未可靠识别出具体食材"}
              </Text>
              <Text style={st.photoText}>识别置信度：{photoAnalysis.analysis.confidence === undefined ? "未知" : `${Math.round(photoAnalysis.analysis.confidence * 100)}%`} · 实际食用量待填写</Text>
              <Text style={st.photoText}>{mealPhotoEstimateText(photoAnalysis.analysis)}</Text>
              {photoAnalysis.analysis.status === "approximate" && photoAnalysis.analysis.nutritionSource?.coverage === "incomplete" &&
                <Text style={st.photoWarn}>仅含可计算成分，未匹配或份量未知的成分未计入。</Text>}
              <Text style={st.photoText}>{photoAnalysis.analysis.advice}</Text>
              {photoAnalysis.analysis.components?.map((component, index) => <MealNutritionReference key={index} component={component} />)}
              <SmallButton icon={photoBasisOpen ? "chevron-up" : "information-circle-outline"}
                label={photoBasisOpen ? "收起估算依据" : "查看估算依据"} onPress={() => setPhotoBasisOpen(!photoBasisOpen)} />
              {photoBasisOpen && <View style={st.photoBasis}>
                {photoAnalysis.analysis.components?.map((component, index) => <MealNutritionBasis key={index} component={component} />)}
                {photoAnalysis.analysis.unresolved?.map((issue, index) => <Text key={`unresolved-${index}`} style={st.photoWarn}>待确认：{issue}</Text>)}
                {photoAnalysis.analysis.assumptions.map((line, index) => <Text key={`assumption-${index}`} style={st.photoWarn}>估算假设：{line}</Text>)}
              </View>}
            </View>}
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
        <View style={st.two}>
          <Field
            label="份量或参考物（可选）"
            value={form.portion}
            onChangeText={(value) => update({ portion: value })}
            placeholder="例如：一碗、半盒"
          />
          <Field
            label="剩余量（可选）"
            value={form.remaining}
            onChangeText={(value) => update({ remaining: value })}
            placeholder="例如：剩约四分之一"
          />
        </View>
        <Field
          label="备注（可选）"
          value={form.note}
          onChangeText={(value) => update({ note: value })}
          placeholder="补充你知道的信息"
          multiline
        />
        <View style={st.manual}>
          <Legend text="手动营养值（可选）" hint="四项都填写后才会作为手动估算保存。留空表示未知，不会记为 0。" />
          <View style={st.two}>
            <Field
              label="热量 kcal"
              value={form.calories}
              onChangeText={(value) => update({ calories: value })}
              keyboardType="numeric"
            />
            <Field
              label="蛋白质 g"
              value={form.protein}
              onChangeText={(value) => update({ protein: value })}
              keyboardType="numeric"
            />
          </View>
          <View style={st.two}>
            <Field
              label="碳水 g"
              value={form.carbs}
              onChangeText={(value) => update({ carbs: value })}
              keyboardType="numeric"
            />
            <Field
              label="脂肪 g"
              value={form.fat}
              onChangeText={(value) => update({ fat: value })}
              keyboardType="numeric"
            />
          </View>
        </View>
        {initial && <MealAnalysisList meal={initial} onSaveCorrection={onSaveCorrection} />}
        {initial && onAnalyze && (
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

const st = StyleSheet.create({
  capture: {
    backgroundColor: color.mealTint, borderRadius: radius.block, padding: space.xl, borderWidth: 1, borderColor: color.mealLine,
    alignItems: "center", marginBottom: space.xl,
  },
  captureIcon: {
    width: 56, height: 56, borderRadius: 28, backgroundColor: color.paper,
    alignItems: "center", justifyContent: "center", marginBottom: space.md,
  },
  captureTitle: { ...type.title },
  captureText: { ...type.bodySoft, textAlign: "center", marginTop: space.xs, maxWidth: 300 },
  captureRow: { flexDirection: "row", gap: space.sm, marginTop: space.lg, alignSelf: "stretch" },
  captureMain: {
    flex: 1, minHeight: 50, borderRadius: radius.pill, backgroundColor: color.meal,
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
  },
  captureMainText: { color: color.onInk, fontSize: 15, fontWeight: "800" },
  captureAlt: {
    flex: 1, minHeight: 50, borderRadius: radius.pill, backgroundColor: color.surface, borderWidth: 1, borderColor: color.meal,
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
  },
  captureAltText: { color: color.mealText, fontSize: 15, fontWeight: "800" },
  photoTools: { flexDirection: "row", flexWrap: "wrap", columnGap: space.sm },
  photoPanel: {
    borderLeftWidth: 3, borderColor: color.meal, paddingLeft: space.md, marginBottom: space.xl,
  },
  photoStatusRow: { flexDirection: "row", alignItems: "center", gap: space.sm, marginBottom: space.sm },
  pulse: { width: 8, height: 8, borderRadius: 4, backgroundColor: color.meal },
  photoStatus: { ...type.label, flex: 1 },
  photoModel: { fontSize: 12, fontWeight: "800", color: color.mealText, marginBottom: 4 },
  photoText: { ...type.bodySoft, marginBottom: 4 },
  photoWarn: { ...type.small, color: color.mealText },
  photoBasis: { backgroundColor: color.mealTint, borderRadius: radius.input, padding: space.md, marginTop: space.xs },
  photoReference: { gap: space.xs, paddingVertical: space.xs },
  two: { flexDirection: "row", gap: space.md },
  manual: {
    marginTop: space.sm, paddingTop: space.sm, borderTopWidth: StyleSheet.hairlineWidth, borderColor: color.lineStrong,
  },
});
