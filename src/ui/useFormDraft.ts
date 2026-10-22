import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { clearDraft, loadDraft, saveDraft } from "../storage";

export type FormSession = {
  id: number;
  epoch: number;
  isActive: () => boolean;
  requestClose?: () => void;
};

export function useFormSession(
  session: FormSession,
  callbacks: {
    onClose: () => void;
    onError: (error: unknown) => void;
    beforeClose?: () => Promise<unknown>;
  },
) {
  type Operation = "save" | "close" | "media" | null;
  const [operation, setOperation] = useState<Operation>(null);
  const running = useRef<Operation>(null);
  const mounted = useRef(true);
  const latest = useRef(callbacks);
  latest.current = callbacks;
  const isActive = useCallback(
    () => mounted.current && session.isActive(),
    [session],
  );
  const isIdle = useCallback(
    () => isActive() && running.current === null,
    [isActive],
  );
  const begin = useCallback(
    (next: Exclude<Operation, null>) => {
      if (!isIdle()) return false;
      running.current = next;
      setOperation(next);
      return true;
    },
    [isIdle],
  );
  const endOperation = useCallback(() => {
    running.current = null;
    if (isActive()) setOperation(null);
  }, [isActive]);
  const requestClose = useCallback(() => {
    if (!begin("close")) return;
    void (async () => {
      try {
        if (latest.current.beforeClose) await latest.current.beforeClose();
        if (isActive()) latest.current.onClose();
      } catch (error) {
        if (isActive()) latest.current.onError(error);
      } finally {
        endOperation();
      }
    })();
  }, [begin, endOperation, isActive]);

  useEffect(() => {
    mounted.current = true;
    session.requestClose = requestClose;
    return () => {
      mounted.current = false;
      if (session.requestClose === requestClose) session.requestClose = undefined;
    };
  }, [requestClose, session]);

  return {
    saving: operation === "save",
    closing: operation === "close",
    busy: operation === "media",
    beginSave: () => begin("save"),
    beginMedia: () => begin("media"),
    endOperation,
    isActive,
    isIdle,
    requestClose,
  };
}

function compatibleDraft(reference: unknown, value: unknown): boolean {
  if (reference === undefined)
    return value === undefined || typeof value === "string";
  if (Array.isArray(reference))
    return (
      Array.isArray(value) &&
      value.length <= 120 &&
      value.every((entry) => compatibleDraft(reference[0], entry))
    );
  if (reference && typeof reference === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return false;
    return Object.entries(reference).every(
      ([key, entry]) =>
        !(key in value) ||
        // JSON draft restoration reinstates explicit media removals as own
        // undefined aliases. Other fields retain their existing type checks.
        ((key === "imageUri" || key === "afterImageUri") && Object.hasOwn(value, key) && (value as Record<string, unknown>)[key] === undefined) ||
        compatibleDraft(entry, (value as Record<string, unknown>)[key]),
    );
  }
  return typeof reference === typeof value;
}

export function useFormDraft<T extends object>(
  key: string,
  initial: T,
  session?: FormSession,
  options?: { restore: (value: unknown) => Partial<T> },
) {
  const [form, setFormState] = useState(initial);
  const [loaded, setLoaded] = useState(false);
  const [draftError, setDraftError] = useState("");
  const [saved, setSaved] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const readFailed = useRef(false);
  const restore = useRef(options?.restore);
  restore.current = options?.restore;
  const current = useRef(form);
  const active = useRef(true);
  const stopped = useRef(false);
  const edited = useRef(new Set<keyof T>());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const hydration = useRef<Promise<void>>(Promise.resolve());
  current.current = form;
  const isActive = useCallback(
    () => active.current && (!session || session.isActive()),
    [session],
  );
  const setForm = useCallback<Dispatch<SetStateAction<T>>>(
    (update) => {
      if (!isActive() || stopped.current) return;
      const previous = current.current;
      const next =
        typeof update === "function"
          ? (update as (value: T) => T)(previous)
          : update;
      for (const field of Object.keys(next) as (keyof T)[])
        if (!Object.is(previous[field], next[field])) edited.current.add(field);
      current.current = next;
      setFormState(next);
    },
    [isActive],
  );

  const persist = useCallback(async () => {
    if (!isActive() || stopped.current) return false;
    await hydration.current;
    if (!isActive() || stopped.current) return false;
    if (readFailed.current) throw new Error("草稿读取失败，未覆盖原草稿；请先重试读取。");
    const value = current.current;
    const pending = queue.current.then(async () => {
      if (!isActive() || stopped.current) return false;
      await saveDraft(key, value);
      return isActive() && !stopped.current;
    });
    queue.current = pending.catch(() => undefined);
    try {
      const written = await pending;
      if (!written || !isActive() || stopped.current) return false;
      setSaved(true);
      setDraftError("");
      return true;
    } catch (error) {
      if (!isActive() || stopped.current) return false;
      setSaved(false);
      setDraftError(
        `草稿保存失败：${error instanceof Error ? error.message : "请重试"}`,
      );
      throw error;
    }
  }, [isActive, key]);

  useEffect(() => {
    let live = true;
    active.current = true;
    stopped.current = false;
    hydration.current = loadDraft<unknown>(key)
      .then((draft) => {
        if (!live || !isActive()) return;
        if (draft !== null && restore.current) draft = restore.current(draft);
        else if (draft !== null && !compatibleDraft(initial, draft))
          throw new Error("草稿字段不兼容，当前表单保留原始记录内容");
        if (draft) {
          const next = { ...current.current };
          for (const field of Object.keys(draft) as (keyof T)[])
            if (!edited.current.has(field)) next[field] = (draft as T)[field];
          current.current = next;
          setFormState(next);
        }
        readFailed.current = false;
        setDraftError("");
        setLoaded(true);
      })
      .catch((error) => {
        if (live && isActive()) {
          readFailed.current = true;
          setDraftError(
            `读取草稿失败：${error instanceof Error ? error.message : "请重试"}`,
          );
          setLoaded(true);
        }
      });
    return () => {
      live = false;
      active.current = false;
      stopped.current = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [isActive, key, loadAttempt]);

  useEffect(() => {
    if (!loaded || !isActive() || stopped.current || readFailed.current) return;
    setSaved(false);
    timer.current = setTimeout(() => {
      void persist().catch(() => undefined);
    }, 350);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [form, isActive, loaded, persist]);

  const finish = useCallback(async () => {
    if (!isActive()) return false;
    if (readFailed.current) throw new Error("草稿读取失败，未清除原草稿。");
    stopped.current = true;
    if (timer.current) clearTimeout(timer.current);
    await queue.current;
    if (!isActive()) return false;
    await clearDraft(key);
    return isActive();
  }, [isActive, key]);

  const saveBeforeClose = useCallback(
    async (close: () => void) => {
      if (timer.current) clearTimeout(timer.current);
      if ((await persist()) && isActive()) close();
    },
    [isActive, persist],
  );

  return {
    form,
    setForm,
    loaded,
    draftError,
    saved,
    readFailed: readFailed.current,
    retryLoad: () => { setLoaded(false); setLoadAttempt((value) => value + 1); },
    persist,
    finish,
    saveBeforeClose,
  };
}
