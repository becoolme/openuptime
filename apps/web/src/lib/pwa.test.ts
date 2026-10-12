import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyUpdate, CHECK_EVERY_MS, watchForUpdates, type Reg } from "./pwa";

type Handler = () => void;
function fakeReg(waiting = false) {
  const handlers: Record<string, Handler> = {};
  const reg = {
    waiting: waiting ? { postMessage: vi.fn() } : null,
    installing: null as null | { state: string; postMessage: () => void; addEventListener: (t: string, cb: Handler) => void },
    update: vi.fn(async () => reg),
    addEventListener: (type: string, cb: Handler) => (handlers[type] = cb),
  };
  return { reg: reg as unknown as Reg & { update: ReturnType<typeof vi.fn>; waiting: { postMessage: ReturnType<typeof vi.fn> } | null }, raw: reg, handlers };
}

beforeEach(() => {
  vi.useFakeTimers();
  const listeners: Record<string, Handler[]> = {};
  vi.stubGlobal("document", {
    visibilityState: "visible",
    addEventListener: (t: string, cb: Handler) => (listeners[t] ??= []).push(cb),
    removeEventListener: (t: string, cb: Handler) => (listeners[t] = (listeners[t] ?? []).filter((x) => x !== cb)),
    __fire: (t: string) => (listeners[t] ?? []).forEach((cb) => cb()),
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("watchForUpdates", () => {
  it("checks for a new version every 6 hours", async () => {
    const { reg } = fakeReg();
    const stop = watchForUpdates(reg, vi.fn(), () => true);
    expect(CHECK_EVERY_MS).toBe(6 * 60 * 60 * 1000);
    expect(reg.update).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS - 1);
    expect(reg.update).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(reg.update).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS);
    expect(reg.update).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS * 2);
    expect(reg.update).toHaveBeenCalledTimes(2);
  });

  it("asks right away when an update is already waiting, and again at each check while it is ignored", async () => {
    const { reg } = fakeReg(true);
    const prompt = vi.fn();
    watchForUpdates(reg, prompt, () => true);
    expect(prompt).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS);
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it("asks once a new worker finishes installing", () => {
    const { reg, raw, handlers } = fakeReg();
    const prompt = vi.fn();
    watchForUpdates(reg, prompt, () => true);
    let onState: Handler = () => {};
    const worker = { state: "installing", postMessage: () => {}, addEventListener: (_: string, cb: Handler) => (onState = cb) };
    raw.installing = worker;
    handlers.updatefound();
    onState();
    expect(prompt).not.toHaveBeenCalled();
    worker.state = "installed";
    raw.waiting = { postMessage: vi.fn() };
    onState();
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("does not call the first install an update", () => {
    const { reg } = fakeReg(true);
    const prompt = vi.fn();
    watchForUpdates(reg, prompt, () => false);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("catches up when a sleeping tab becomes visible after the interval has passed", async () => {
    let t = 1_000_000;
    const { reg } = fakeReg();
    watchForUpdates(reg, vi.fn(), () => true, () => t);
    const doc = document as unknown as { __fire: (t: string) => void };
    doc.__fire("visibilitychange");
    expect(reg.update).not.toHaveBeenCalled();
    t += CHECK_EVERY_MS + 1;
    doc.__fire("visibilitychange");
    expect(reg.update).toHaveBeenCalledTimes(1);
  });

  it("survives a failed check", async () => {
    const { reg } = fakeReg();
    reg.update.mockRejectedValue(new TypeError("offline"));
    watchForUpdates(reg, vi.fn(), () => true);
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS);
    expect(reg.update).toHaveBeenCalled();
  });
});

describe("applyUpdate", () => {
  it("tells the waiting worker to activate and reloads when it has taken over, once", () => {
    const { reg } = fakeReg(true);
    let changed: Handler = () => {};
    const sw = { addEventListener: (_: string, cb: Handler) => (changed = cb) };
    const reload = vi.fn();
    applyUpdate(reg, sw, reload);
    expect(reg.waiting!.postMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" });
    expect(reload).not.toHaveBeenCalled();
    changed();
    changed();
    vi.advanceTimersByTime(5000);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("reloads anyway when the takeover never signals", () => {
    const { reg } = fakeReg(true);
    const reload = vi.fn();
    applyUpdate(reg, { addEventListener: () => {} }, reload);
    vi.advanceTimersByTime(4000);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("just reloads when nothing is waiting", () => {
    const { reg } = fakeReg(false);
    const reload = vi.fn();
    applyUpdate(reg, { addEventListener: () => {} }, reload);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
