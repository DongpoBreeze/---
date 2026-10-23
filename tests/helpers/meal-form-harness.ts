import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import * as review from '../../src/meal-review';
import * as portions from '../../src/meal-portion-reference';
import * as reviewRefresh from '../../src/meal-review-refresh';
import * as photos from '../../src/meal-photos';
import * as nutritionFields from '../../src/meal-nutrition-fields';
import * as analysisDraft from '../../src/meal-analysis-draft';
import * as sharedNutrition from '../../shared/nutrition.mjs';
import { validateFormDrafts } from '../../src/backup';
import type { MealRecord, Profile } from '../../src/types';
import type { FormSession } from '../../src/ui/useFormDraft';
import type { MealDraft, PhotoAnalysisResult } from '../../src/ui/app-types';

const compile = (path: string) => ts.transpileModule(readFileSync(resolve(process.cwd(), path), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, jsx: ts.JsxEmit.React },
}).outputText;
const formCode = compile('src/ui/meal-form.tsx');
const hookCode = compile('src/ui/useFormDraft.ts');
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

type Node = { type: string; props: Record<string, any> };
type Options = {
  initial?: MealRecord;
  profile?: Profile;
  drafts?: Map<string, unknown>;
  draftKey?: string;
  analyzeOnOpen?: boolean;
  analyze?: (meal: MealRecord, signal: AbortSignal) => Promise<PhotoAnalysisResult>;
  load?: () => Promise<unknown>;
  settingsVersion?: () => number;
};

/** Runs the production form and its real draft/session hooks without Expo or a browser. */
export function mealFormHarness(options: Options = {}) {
  const values = options.drafts ?? new Map<string, unknown>();
  const writes: unknown[] = [];
  const saved: Array<{ meal: MealDraft; analysis?: PhotoAnalysisResult }> = [];
  const requests: Array<{ meal: MealRecord; signal: AbortSignal }> = [];
  const slots: any[] = [];
  let cursor = 0;
  let dirty = true;
  let mounted = true;
  let tree: Node;
  let pendingEffects: Array<() => void> = [];
  let closed = false;
  const same = (left: unknown[] | undefined, right: unknown[] | undefined) => left !== undefined && right !== undefined
    && left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
  const react = {
    createElement: (type: string, props: Record<string, any> | null, ...children: unknown[]) => ({ type, props: { ...props, children } }),
    Fragment: 'Fragment',
    useState: (initial: unknown) => {
      const index = cursor++;
      if (!slots[index]) slots[index] = { value: typeof initial === 'function' ? initial() : initial };
      return [slots[index].value, (update: any) => {
        const next = typeof update === 'function' ? update(slots[index].value) : update;
        if (!Object.is(next, slots[index].value)) { slots[index].value = next; dirty = true; }
      }];
    },
    useRef: (value: unknown) => {
      const index = cursor++;
      if (!slots[index]) slots[index] = { current: value };
      return slots[index];
    },
    useCallback: (callback: unknown, dependencies: unknown[]) => {
      const index = cursor++;
      if (!slots[index] || !same(slots[index].dependencies, dependencies)) slots[index] = { callback, dependencies };
      return slots[index].callback;
    },
    useEffect: (effect: () => (() => void) | void, dependencies?: unknown[]) => {
      const index = cursor++;
      const previous = slots[index];
      if (!previous || !same(previous.dependencies, dependencies)) {
        slots[index] = { dependencies, cleanup: previous?.cleanup };
        pendingEffects.push(() => {
          previous?.cleanup?.();
          slots[index].cleanup = effect();
        });
      }
    },
  };
  const execute = (code: string, dependencies: Record<string, unknown>) => {
    const module = { exports: {} };
    new Function('require', 'module', 'exports', code)((id: string) => {
      if (!(id in dependencies)) throw new Error(`Unexpected form dependency: ${id}`);
      return dependencies[id];
    }, module, module.exports);
    return module.exports as any;
  };
  const storage = {
    loadDraft: async (key: string) => options.load ? options.load() : photos.normalizeMealPhotoDraft(values.has(key) ? copy(values.get(key)) : null),
    saveDraft: async (key: string, value: unknown) => {
      const safe = validateFormDrafts({ [key]: value });
      values.set(key, safe[key]); writes.push(copy(safe[key]));
    },
    clearDraft: async (key: string) => { values.delete(key); },
    persistMedia: async (uri: string) => uri,
  };
  const hooks = execute(hookCode, { react, '../storage': storage });
  const components = Object.fromEntries(['Banner', 'Choice', 'DraftStatus', 'Field', 'MediaPreview', 'Note', 'Sheet', 'SmallButton'].map((name) => [name, name]));
  const color = new Proxy({}, { get: () => '#000000' });
  const tokens = { color, type: new Proxy({}, { get: () => ({}) }) };
  const formModule = execute(formCode, {
    react, 'react-native': { Pressable: 'Pressable', Text: 'Text', View: 'View', StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 } },
    'expo-image-picker': {}, '@expo/vector-icons': { Ionicons: 'Ionicons' }, '../storage': storage,
    '../ai': { getAiSettingsVersion: () => options.settingsVersion?.() ?? 1, isAiConfigured: () => true },
    '../meal-review': review, '../meal-portion-reference': portions, '../meal-review-refresh': reviewRefresh, '../meal-photos': photos,
    '../../shared/nutrition.mjs': sharedNutrition, '../meal-nutrition-fields': nutritionFields,
    '../meal-analysis-draft': analysisDraft, './useFormDraft': hooks,
    './components': { ...components, useBaseStyles: () => ({}) },
    './meal-analysis': { MealAnalysisList: 'MealAnalysisList' }, './meal-review': { MealReviewPage: 'MealReviewPage' },
    './analysis-wait-time': { AnalysisWaitTime: 'AnalysisWaitTime' },
    './format': {
      confirmAction: (_title: string, _message: string, _action: string, callback: () => void) => callback(),
      errorText: (error: unknown) => error instanceof Error ? error.message : String(error), notify: () => {},
      localDateTime: (value: string | undefined) => value ? value.replace('T', ' ').slice(0, 16) : '',
      today: () => '2026-10-21',
      parseDateTime: (value: string) => new Date(value.replace(' ', 'T') + ':00Z').toISOString(),
    },
    './theme': { radius: {}, space: {} },
    './theme-provider': { useTheme: () => tokens, useThemedStyles: (create: (value: unknown) => unknown) => create(tokens) },
  });
  const session: FormSession = { id: 1, epoch: 0, isActive: () => mounted };
  const unmount = () => {
    mounted = false;
    for (const slot of slots) slot?.cleanup?.();
  };
  const render = () => {
    cursor = 0; dirty = false; pendingEffects = [];
    tree = formModule.MealForm({
      initial: options.initial, profile: options.profile ?? {}, draftKey: options.draftKey ?? (options.initial ? `meal-${options.initial.id}` : 'meal-new'),
      session, analyzeOnOpen: options.analyzeOnOpen ?? false,
      onClose: () => { closed = true; unmount(); },
      onSave: async (meal: MealDraft, analysis?: PhotoAnalysisResult) => { saved.push(copy({ meal, analysis })); },
      onSaveCorrection: async () => {},
      onAnalyzePhoto: async (meal: MealRecord, signal: AbortSignal) => {
        requests.push({ meal: copy(meal), signal });
        if (!options.analyze) throw new Error('No mocked analysis configured');
        return options.analyze(meal, signal);
      },
    });
    for (const effect of pendingEffects) effect();
  };
  const flush = async () => {
    for (let iteration = 0; iteration < 12; iteration += 1) {
      if (dirty && mounted) render();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  };
  const nodes = () => {
    const result: Node[] = [];
    const visit = (node: any) => {
      if (Array.isArray(node)) node.forEach(visit);
      else if (node && typeof node === 'object' && 'type' in node) { result.push(node); visit(node.props.children); }
    };
    visit(tree);
    return result;
  };
  const get = (type: string, predicate: (props: Record<string, any>) => boolean = () => true) => {
    const node = nodes().find((node) => node.type === type && predicate(node.props));
    if (!node) throw new Error(`Missing ${type} in production meal form`);
    return node.props;
  };
  return {
    flush, unmount, get, nodes, values, writes, saved, requests, session,
    closed: () => closed,
    review: () => get('MealReviewPage'), sheet: () => get('Sheet'),
    field: (label: string) => get('Field', (props) => props.label === label),
    button: (label: string) => get('SmallButton', (props) => props.label === label),
    act: async (action: () => unknown) => { await action(); await flush(); },
  };
}
