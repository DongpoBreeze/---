import React, { useEffect, useRef, useState } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { Goal, Profile } from "../types";
import { discoverModel, discoverModels } from "../ai";
import { isValidReasoningEffort, normalizeConnection, type AiConnection, type AiModel, type AiSettings } from "../ai-provider";
import { type FormSession, useFormSession } from "./useFormDraft";
import { Banner, Choice, Field, Legend, Note, Sheet, SmallButton, useBaseStyles } from "./components";
import { confirmAction, errorText } from "./format";
import { radius, space, type ThemeTokens } from "./theme";
import { useTheme, useThemedStyles } from "./theme-provider";

export function AiSettingsForm({ initial, loadError, session, onClose, onSave, onDelete }: {
  initial: AiSettings | null;
  loadError?: string;
  session: FormSession;
  onClose: () => void;
  onSave: (settings: AiSettings) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const { color, type, scheme } = useTheme();
  const base = useBaseStyles();
  const st = useThemedStyles(createStyles);
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "https://api.bblabu.ai/v1");
  const [apiKey, setApiKey] = useState(initial?.apiKey ?? "");
  const [protocol, setProtocol] = useState<AiConnection["protocol"]>(initial?.protocol ?? "responses");
  const [model, setModel] = useState(initial?.model ?? "");
  const [effort, setEffort] = useState(initial?.reasoningEffort ?? "");
  const [customMode, setCustomMode] = useState(false);
  const [models, setModels] = useState<AiModel[]>([]);
  const [selected, setSelected] = useState<AiModel | null>(null);
  const [search, setSearch] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [query, setQuery] = useState<"models" | "detail" | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const queryRef = useRef<{ version: number; controller?: AbortController }>({ version: 0 });
  const cancelQuery = () => {
    queryRef.current.controller?.abort();
    queryRef.current = { version: queryRef.current.version + 1 };
    setQuery(null);
  };
  const lifecycle = useFormSession(session, {
    onClose: () => { cancelQuery(); onClose(); },
    onError: (e) => setError(errorText(e)),
  });
  useEffect(() => () => {
    queryRef.current.controller?.abort();
    queryRef.current.version += 1;
  }, []);
  const resetModel = () => {
    setSelected(null); setModel(""); setEffort(""); setCustomMode(false);
  };
  const changed = (apply: () => void) => {
    if (!lifecycle.isIdle()) return;
    cancelQuery(); apply(); setModels([]); resetModel(); setError("");
    setStatus("连接已更改，已清除模型和推理强度，请重新获取模型列表。");
  };
  const discover = async (candidate?: AiModel) => {
    if (!lifecycle.isIdle()) return;
    cancelQuery();
    const controller = new AbortController();
    const version = queryRef.current.version;
    queryRef.current.controller = controller;
    const active = () => session.isActive() && version === queryRef.current.version && !controller.signal.aborted;
    setQuery(candidate ? "detail" : "models"); setError(""); setStatus("");
    const switchingModel = Boolean(candidate && candidate.id !== model);
    if (switchingModel) resetModel();
    if (!candidate) setModels([]);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 20000);
    try {
      const connection = normalizeConnection({ baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), protocol });
      if (candidate) {
        const detail = candidate.reasoningSource === "upstream" ? candidate : await discoverModel(connection, candidate, controller.signal);
        if (!active()) return;
        setSelected(detail); setModel(detail.id);
        const resetNotice = switchingModel && model ? "模型已更改，推理强度已重置。" : "";
        setStatus(resetNotice + (detail.reasoningSource === "upstream" ? "已获取推理强度" : "上游未提供推理强度，可使用服务默认或自定义填写。"));
      } else {
        const list = await discoverModels(connection, controller.signal);
        if (!active()) return;
        setModels(list);
        const currentModel = list.find((item) => item.id === model);
        if (model && !currentModel) {
          resetModel();
          setStatus("原模型不在最新列表中，请重新选择模型和推理强度。");
        } else {
          if (currentModel) setSelected(currentModel);
          setStatus(list.length ? `已获取 ${list.length} 个模型${currentModel ? "，保留当前模型与推理强度。" : ""}` : "上游未返回可选模型。");
        }
      }
    } catch {
      if (session.isActive() && version === queryRef.current.version) {
        setError(timedOut ? "获取超时，请检查服务地址和网络。" : "获取失败，请检查 HTTPS 地址、Key 和接口权限。");
      }
    } finally {
      clearTimeout(timer);
      if (session.isActive() && version === queryRef.current.version) {
        queryRef.current.controller = undefined; setQuery(null);
      }
    }
  };
  const submit = async (remove = false) => {
    if (!remove && !isValidReasoningEffort(effort)) return;
    if (!lifecycle.beginSave()) return;
    cancelQuery(); setError("");
    try {
      if (remove) await onDelete();
      else await onSave({ ...normalizeConnection({ baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), protocol }), model, reasoningEffort: effort });
      if (lifecycle.isActive()) onClose();
    } catch (e) {
      if (lifecycle.isActive()) setError(`${remove ? "删除" : "保存"} AI 配置失败：${errorText(e)}`);
    } finally { lifecycle.endOperation(); }
  };
  const visibleModels = models.filter((item) => `${item.id} ${item.label}`.toLowerCase().includes(search.toLowerCase()));
  // Old settings persist only the raw value. Until metadata confirms it as an
  // upstream choice, restore a nonempty value in the custom input unchanged.
  const isCustom = customMode || Boolean(effort && !selected?.reasoningEfforts.includes(effort));
  const validEffort = isValidReasoningEffort(effort);
  return (
    <Sheet title="AI 服务设置" onClose={lifecycle.requestClose}
      onSave={() => void submit()} saving={lifecycle.saving} closing={lifecycle.closing}
      disabled={!model || !baseUrl.trim() || !apiKey.trim() || query !== null || !validEffort}>
      {Boolean(error) && <Banner text={error} danger onClose={() => setError("")} />}
      {Boolean(loadError) && <Note icon="alert-circle-outline" text="已保存的 AI 配置读取失败，原存储仍保留。重新填写并保存会替换 AI 配置，也可仅删除 AI 配置后重设；身高体重和健康记录会保留。" />}
      <Note icon="shield-checkmark-outline" text={`照片与记录发送至所选服务，API 费用由该服务收取。Key 不包含在健康数据备份中。${Platform.OS === "web" ? "\n配置保存在此浏览器的本机存储，刷新或重开同一地址可恢复。" : ""}`} />
      <View style={st.step}>
        <Text style={st.stepNo}>1</Text>
        <Text style={st.stepTitle}>连接服务</Text>
      </View>
      <View style={base.field}>
        <Text style={base.fieldLabel}>API 地址</Text>
        <TextInput accessibilityLabel="API 地址" style={base.input} value={baseUrl}
          onChangeText={(value) => changed(() => setBaseUrl(value))} placeholder="https://api.example.com/v1"
          placeholderTextColor={color.inkFaint}
          keyboardAppearance={scheme}
          keyboardType="url" autoCapitalize="none" autoCorrect={false} editable={lifecycle.isIdle()} />
      </View>
      <View style={base.field}>
        <Text style={base.fieldLabel}>API Key</Text>
        <View style={st.keyRow}>
          <TextInput accessibilityLabel="API Key" style={[base.input, { flex: 1, minWidth: 0 }]} value={apiKey}
            keyboardAppearance={scheme}
            onChangeText={(value) => changed(() => setApiKey(value))} secureTextEntry={!showKey}
            autoCapitalize="none" autoCorrect={false} autoComplete="off" editable={lifecycle.isIdle()} />
          <Pressable accessibilityRole="button" accessibilityLabel={showKey ? "隐藏 Key" : "显示 Key"}
            style={st.eye} onPress={() => setShowKey(!showKey)}>
            <Ionicons name={showKey ? "eye-off-outline" : "eye-outline"} size={22} color={color.inkSoft} />
          </Pressable>
        </View>
      </View>
      <Choice label="接口协议" value={protocol}
        choices={[["responses", "Responses"], ["chat_completions", "Chat Completions"]]}
        onChange={(value) => changed(() => setProtocol(value))} />
      <View style={st.step}>
        <Text style={st.stepNo}>2</Text>
        <Text style={st.stepTitle}>选择模型</Text>
      </View>
      <SmallButton icon={query ? "close-outline" : "refresh-outline"} label={query ? "取消获取" : "获取模型列表"}
        onPress={() => query ? cancelQuery() : void discover()} disabled={!lifecycle.isIdle()} />
      {Boolean(status) && <Text accessibilityRole="alert" style={st.status}>{status}</Text>}
      {Boolean(query) && <Text style={st.status}>正在获取{query === "models" ? "模型列表" : "模型能力"}…</Text>}
      {models.length > 0 && <>
        <Field label="筛选模型" value={search} onChangeText={setSearch} />
        <Text style={base.fieldLabel}>模型</Text>
        <ScrollView nestedScrollEnabled style={st.list}>
          {visibleModels.map((item) => <Pressable key={item.id} accessibilityRole="radio" accessibilityLabel={`模型 ${item.id}`}
            aria-checked={model === item.id}
            accessibilityState={{ checked: model === item.id, disabled: !lifecycle.isIdle() }} disabled={!lifecycle.isIdle()}
            onPress={() => void discover(item)} style={[st.option, model === item.id && st.optionOn]}>
            <Ionicons name={model === item.id ? "radio-button-on" : "radio-button-off"} size={20} color={model === item.id ? color.pine : color.inkFaint} />
            <View style={{ flex: 1, minWidth: 0 }}><Text style={st.optionText}>{item.id}</Text>
              {item.label !== item.id && <Text style={type.small}>{item.label}</Text>}</View>
          </Pressable>)}
          {!visibleModels.length && <Text style={st.status}>没有匹配模型</Text>}
        </ScrollView>
      </>}
      {Boolean(model) && <View style={{ marginTop: space.md }}>
        <Text style={base.fieldLabel}>已选模型</Text><Text style={[st.optionText, st.chosen]}>{model}</Text>
        <View style={st.step}>
          <Text style={st.stepNo}>3</Text>
          <Text style={st.stepTitle}>推理强度</Text>
        </View>
        {!selected && <Text style={st.status}>{initial?.reasoningEffort || "服务默认"}（已保存；能力尚未刷新）</Text>}
        {selected?.reasoningSource === "upstream" && <Text style={st.status}>下列强度来自上游模型信息，也可自定义填写。</Text>}
        <View style={[st.list, st.effortList]}>{["", ...(selected?.reasoningEfforts ?? [])].map((item) => {
          const checked = !isCustom && effort === item;
          return <Pressable key={item} accessibilityRole="radio" aria-checked={checked}
            accessibilityLabel={`推理强度 ${item || "服务默认"}`} accessibilityState={{ checked, disabled: !lifecycle.isIdle() }}
            disabled={!lifecycle.isIdle()}
            onPress={() => { if (lifecycle.isIdle()) { setEffort(item); setCustomMode(false); } }} style={[st.option, checked && st.optionOn]}>
            <Ionicons name={checked ? "radio-button-on" : "radio-button-off"} size={20} color={checked ? color.pine : color.inkFaint} />
            <Text style={st.optionText}>{item || "服务默认"}</Text>
          </Pressable>;
        })}
          <Pressable accessibilityRole="radio" accessibilityLabel="推理强度 自定义" aria-checked={isCustom}
            accessibilityState={{ checked: isCustom, disabled: !lifecycle.isIdle() }} disabled={!lifecycle.isIdle()}
            onPress={() => { if (lifecycle.isIdle()) setCustomMode(true); }} style={[st.option, isCustom && st.optionOn]}>
            <Ionicons name={isCustom ? "radio-button-on" : "radio-button-off"} size={20} color={isCustom ? color.pine : color.inkFaint} />
            <Text style={st.optionText}>自定义</Text>
          </Pressable>
        </View>
        {isCustom && <View style={base.field}>
          <Text style={base.fieldLabel}>自定义推理强度</Text>
          <TextInput accessibilityLabel="自定义推理强度" style={[base.input, !validEffort && st.invalidInput]} value={effort}
            keyboardAppearance={scheme}
            onChangeText={(value) => { if (lifecycle.isIdle()) { setEffort(value); setCustomMode(true); } }}
            placeholder="填写服务商支持的值；留空使用默认" placeholderTextColor={color.inkFaint}
            autoCapitalize="none" autoCorrect={false} spellCheck={false} editable={lifecycle.isIdle()} />
          <Text style={st.effortHelp}>按服务商文档填写，原样发送；支持情况以服务商为准。留空使用服务默认，不发送强度参数。最多 64 位，仅支持英文字母、数字和 . _ -。</Text>
          {!validEffort && <Text accessibilityRole="alert" style={st.effortError}>推理强度最多 64 位，只能包含英文字母、数字、.、_ 或 -，请修改后保存。</Text>}
        </View>}
      </View>}
      {Boolean(initial || loadError) && <View style={{ marginTop: space.xl }}><SmallButton icon="trash-outline" label="删除 AI 配置" danger
        disabled={!lifecycle.isIdle()} onPress={() => confirmAction("删除 AI 配置？", "清除本机保存的地址、Key 和模型选择，健康记录仍保留。", "删除", () => void submit(true), true)} /></View>}
    </Sheet>
  );
}

export function ProfileForm({
  initial,
  session,
  onClose,
  onSave,
}: {
  initial: Profile;
  session: FormSession;
  onClose: () => void;
  onSave: (profile: Profile) => Promise<void>;
}) {
  const st = useThemedStyles(createStyles);
  const [goal, setGoal] = useState<Goal | "none">(initial.goal ?? "none");
  const [height, setHeight] = useState(
    initial.heightCm === undefined ? "" : String(initial.heightCm),
  );
  const [weight, setWeight] = useState(
    initial.weightKg === undefined ? "" : String(initial.weightKg),
  );
  const [calories, setCalories] = useState(
    initial.calorieTarget === undefined ? "" : String(initial.calorieTarget),
  );
  const [error, setError] = useState("");
  const lifecycle = useFormSession(session, {
    onClose,
    onError: (e) => setError(errorText(e)),
  });
  const submit = async () => {
    if (!lifecycle.beginSave()) return;
    setError("");
    try {
      const optional = (value: string, label: string) => {
        if (!value.trim()) return undefined;
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0)
          throw new Error(`${label}需要是大于 0 的数字。`);
        return n;
      };
      await onSave({
        goal: goal === "none" ? undefined : goal,
        heightCm: optional(height, "身高"),
        weightKg: optional(weight, "体重"),
        calorieTarget: optional(calories, "热量目标"),
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
      title="目标与资料"
      onClose={lifecycle.requestClose}
      onSave={() => {
        void submit();
      }}
      saving={lifecycle.saving}
      closing={lifecycle.closing}
    >
      <>
        {Boolean(error) && (
          <Banner text={error} danger onClose={() => setError("")} />
        )}
        <Text style={st.intro}>
          资料不足时不生成精确目标；修改目标只影响后续建议。
        </Text>
        <Choice
          label="健康目标"
          value={goal}
          choices={[
            ["none", "暂不设置"],
            ["health", "保持健康"],
            ["fat-loss", "减脂"],
            ["muscle-gain", "增肌"],
          ]}
          onChange={(value) => {
            if (lifecycle.isIdle()) setGoal(value);
          }}
        />
        <Legend text="身体资料（全部可选）" />
        <Text style={st.intro}>身高体重可用于 AI 识别页的“本餐备餐参考”；填写每日热量目标后优先按该目标换算。</Text>
        <View style={st.two}>
          <Field
            label="身高（cm，可选）"
            value={height}
            onChangeText={(value) => {
              if (lifecycle.isIdle()) setHeight(value);
            }}
            placeholder="例如：170"
            keyboardType="numeric"
          />
          <Field
            label="体重（kg，可选）"
            value={weight}
            onChangeText={(value) => {
              if (lifecycle.isIdle()) setWeight(value);
            }}
            placeholder="例如：65"
            keyboardType="numeric"
          />
        </View>
        <Field
          label="每日热量目标（kcal，可选）"
          value={calories}
          onChangeText={(value) => {
            if (lifecycle.isIdle()) setCalories(value);
          }}
          placeholder="不填写则保持未知"
          keyboardType="numeric"
        />
      </>
    </Sheet>
  );
}

const createStyles = ({ color, type }: ThemeTokens) => StyleSheet.create({
  intro: { ...type.bodySoft, marginBottom: space.lg },
  two: { flexDirection: "row", gap: space.md },
  step: { flexDirection: "row", alignItems: "center", gap: space.sm, marginTop: space.md, marginBottom: space.md },
  stepNo: {
    width: 24, height: 24, borderRadius: 12, backgroundColor: color.pine, color: color.onInk,
    textAlign: "center", lineHeight: 24, fontSize: 12, fontWeight: "800", overflow: "hidden",
  },
  stepTitle: { ...type.heading },
  keyRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
  eye: { width: 48, height: 48, alignItems: "center", justifyContent: "center", borderRadius: radius.input, backgroundColor: color.surface },
  status: { ...type.bodySoft, marginBottom: space.md },
  list: {
    maxHeight: 280, borderRadius: radius.block, backgroundColor: color.surface, marginBottom: space.lg,
    borderWidth: StyleSheet.hairlineWidth, borderColor: color.lineStrong,
  },
  effortList: { maxHeight: undefined },
  effortHelp: { ...type.small, color: color.inkSoft, marginTop: space.sm },
  effortError: { ...type.small, color: color.danger, marginTop: space.sm },
  invalidInput: { borderColor: color.danger },
  option: {
    flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.md, minHeight: 50,
    borderBottomWidth: StyleSheet.hairlineWidth, borderColor: color.line,
  },
  optionOn: { backgroundColor: color.pineTint },
  optionText: { ...type.body, flexShrink: 1 },
  chosen: { fontWeight: "700", marginBottom: space.sm },
});
