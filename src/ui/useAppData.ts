import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { emptyData, type AppData } from "../types";
import { clearData, consumeStorageWarning, importBackup, loadData, saveData } from "../storage";
import { refreshSummaries } from "../domain";
import { errorText, today } from "./format";

/**
 * The app's single data store: loads local data, serializes every write
 * through one queue and keeps derived daily summaries current. `dataRef`
 * always holds the latest committed value for code that runs between renders.
 */
export function useAppData(onError: (message: string) => void) {
  const [data, setData] = useState<AppData>(emptyData);
  const dataRef = useRef(data);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const [ready, setReady] = useState(false);
  const [readFailure, setReadFailure] = useState(false);
  const [storageWarning, setStorageWarning] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const takeWarning = useCallback(() => {
    const warning = consumeStorageWarning();
    if (warning) setStorageWarning(warning);
  }, []);
  const apply = useCallback((next: AppData) => {
    dataRef.current = next;
    setData(next);
  }, []);
  /** Run `task` after every earlier write has settled; a failure does not block later writes. */
  const enqueue = useCallback(<T,>(task: () => Promise<T>): Promise<T> => {
    const run = queue.current.then(task);
    queue.current = run.catch(() => undefined);
    return run;
  }, []);

  useEffect(() => {
    let live = true;
    const first = loadAttempt === 0;
    setReady(false);
    loadData()
      .then(async (loaded) => {
        if (!live) return;
        const next = refreshSummaries(loaded);
        apply(next);
        setReadFailure(false);
        // Persist summaries refreshed on launch; a retry after a read failure only reloads.
        if (first) {
          try { await saveData(next); }
          catch (e) { if (live) onErrorRef.current(`本地摘要暂未写入：${errorText(e)}`); }
        }
        takeWarning();
      })
      .catch((e) => {
        if (!live) return;
        onErrorRef.current(first ? `读取本机数据失败：${errorText(e)}` : errorText(e));
        setReadFailure(true);
      })
      .finally(() => { if (live) setReady(true); });
    return () => { live = false; };
  }, [apply, loadAttempt, takeWarning]);

  const commit = useCallback(
    (change: (current: AppData) => AppData, bump = true) =>
      enqueue(async () => {
        const current = dataRef.current;
        let next = change(current);
        if (bump) next = { ...next, sourceVersion: current.sourceVersion + 1 };
        next = refreshSummaries(next);
        await saveData(next);
        apply(next);
        takeWarning();
        return next;
      }),
    [apply, enqueue, takeWarning],
  );

  // Rebuild the local daily summary once the date rolls over.
  useEffect(() => {
    if (!ready || readFailure) return;
    let lastDate = today();
    const refresh = () => {
      const date = today();
      if (date === lastDate) return;
      lastDate = date;
      void commit((current) => current, false).catch((e) => onErrorRef.current(`摘要更新失败：${errorText(e)}`));
    };
    const timer = setInterval(refresh, 60000);
    const subscription = AppState.addEventListener("change", (state) => { if (state === "active") refresh(); });
    return () => { clearInterval(timer); subscription.remove(); };
  }, [commit, readFailure, ready]);

  /** Returns false when the user cancels the file picker. */
  const importFromBackup = useCallback(
    () => enqueue(async () => {
      const imported = await importBackup(dataRef.current);
      if (!imported) return false;
      await saveData(imported);
      apply(imported);
      takeWarning();
      return true;
    }),
    [apply, enqueue, takeWarning],
  );

  const clearAll = useCallback(
    (before: () => Promise<void>) => enqueue(async () => {
      await before();
      await clearData();
      apply(emptyData());
      setStorageWarning("");
    }),
    [apply, enqueue],
  );

  return {
    data, dataRef, ready, readFailure, storageWarning, setStorageWarning, takeWarning,
    commit, importFromBackup, clearAll,
    reload: useCallback(() => setLoadAttempt((attempt) => attempt + 1), []),
  };
}
