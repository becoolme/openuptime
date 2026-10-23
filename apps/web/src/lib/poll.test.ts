import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pollWhileVisible } from "./poll";

let state: "visible" | "hidden";
let listeners: (() => void)[];
const setVisibility = (v: "visible" | "hidden") => {
  state = v;
  [...listeners].forEach((l) => l());
};

describe("pollWhileVisible", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    state = "visible";
    listeners = [];
    vi.stubGlobal("document", {
      get visibilityState() { return state; },
      addEventListener: (_: string, l: () => void) => listeners.push(l),
      removeEventListener: (_: string, l: () => void) => { listeners = listeners.filter((x) => x !== l); },
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("polls on the interval while visible", () => {
    const fn = vi.fn();
    const stop = pollWhileVisible(fn, 1000);
    vi.advanceTimersByTime(3000);
    expect(fn).toHaveBeenCalledTimes(3);
    stop();
  });

  it("makes no requests while hidden and fetches once on return", () => {
    const fn = vi.fn();
    const stop = pollWhileVisible(fn, 1000);
    setVisibility("hidden");
    vi.advanceTimersByTime(5000);
    expect(fn).not.toHaveBeenCalled();
    setVisibility("visible");
    expect(fn).toHaveBeenCalledTimes(1);
    setVisibility("visible");
    expect(fn).toHaveBeenCalledTimes(1);
    stop();
  });

  it("stops polling and listening after stop()", () => {
    const fn = vi.fn();
    pollWhileVisible(fn, 1000)();
    expect(listeners).toHaveLength(0);
    vi.advanceTimersByTime(3000);
    expect(fn).not.toHaveBeenCalled();
  });
});
