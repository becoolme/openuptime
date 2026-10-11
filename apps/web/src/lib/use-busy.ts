import { useCallback, useState } from "react";

/** Tracks a pending async action: `run(fn)` flips `busy` for the duration and always resets it. */
export function useBusy() {
  const [busy, setBusy] = useState(false);
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    try { return await fn(); } finally { setBusy(false); }
  }, []);
  return [busy, run] as const;
}
