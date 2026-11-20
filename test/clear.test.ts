import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { after, afterInWindow, every, everyInWindow } from '../fixtures/app';
import { clearAppTimersAtEnd, holdBackgroundIntervals, installStress } from '../src/index';

const real = {
  setTimeout: globalThis.setTimeout,
  setInterval: globalThis.setInterval,
  clearTimeout: globalThis.clearTimeout,
  clearInterval: globalThis.clearInterval,
};
const sleep = (ms: number) => new Promise((resolve) => real.setTimeout(resolve, ms));
const undo: (() => void)[] = [];
// Stands in for Vitest's afterAll: `end` runs what it was given, as the end of the file would.
let atEnd: (() => void)[];
const afterAll = (fn: () => void) => void atEnd.push(fn);
const end = () => atEnd.forEach((fn) => fn());
// Every id the timers below the wrapper were asked to clear.
let clearedIds: unknown[];
const reported = (warn: { mock: { calls: unknown[][] } }) => warn.mock.calls.map((call) => String(call[0]));

beforeEach(() => {
  atEnd = [];
  clearedIds = [];
  globalThis.clearTimeout = ((id: Parameters<typeof clearTimeout>[0]) => {
    clearedIds.push(id);
    real.clearTimeout(id);
  }) as typeof clearTimeout;
});

afterEach(() => {
  undo.splice(0).forEach((restore) => restore());
  Object.assign(globalThis, real);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('clearAppTimersAtEnd', () => {
  it('clears a timeout the app left pending when the file ends, so it never runs', async () => {
    undo.push(clearAppTimersAtEnd({ afterAll }));
    const done = vi.fn();
    const id = after(30, done);

    end();
    await sleep(60);

    expect(done).not.toHaveBeenCalled();
    expect(clearedIds).toEqual([id]);
  });

  it('clears an interval the app left running', async () => {
    undo.push(clearAppTimersAtEnd({ afterAll }));
    let ticks = 0;
    every(5, () => ticks++);
    await sleep(30);

    end();
    const before = ticks;
    await sleep(30);

    expect(before).toBeGreaterThan(0);
    expect(ticks).toBe(before);
  });

  it('does not clear again a timeout that fired, and forgets one the app cleared, by either function', async () => {
    undo.push(clearAppTimersAtEnd({ afterAll }));
    const fired = vi.fn();
    after(5, fired);
    const viaTimeout = after(1000, () => {});
    const viaInterval = after(1000, () => {});
    clearTimeout(viaTimeout);
    clearInterval(viaInterval);
    await sleep(30);
    clearedIds = [];

    end();

    expect(fired).toHaveBeenCalledOnce();
    expect(clearedIds).toEqual([]);
  });

  it('leaves out of the report a timer Node ended some other way: by its number, close() or using', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    undo.push(clearAppTimersAtEnd({ afterAll, report: true }));
    real.clearTimeout(Number(after(1000, () => {})));
    after(1000, () => {}).close();
    after(1000, () => {})[Symbol.dispose]();

    end();

    expect(warn).not.toHaveBeenCalled();
  });

  it('clears a timeout that fired and was started again with refresh()', async () => {
    undo.push(clearAppTimersAtEnd({ afterAll }));
    const done = vi.fn();
    const id = after(5, done);
    await sleep(30);
    id.refresh();

    end();
    await sleep(30);

    expect(done).toHaveBeenCalledOnce();
  });

  it('does not record a timeout whose handler ran before its id came back', () => {
    globalThis.setTimeout = ((handler: () => void) => (handler(), 7)) as unknown as typeof setTimeout;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    undo.push(clearAppTimersAtEnd({ afterAll, report: true }));
    const done = vi.fn();

    expect(after(1000, done)).toBe(7);
    end();

    expect(done).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();
  });

  it('passes the handler its arguments and this, as the timer would', async () => {
    // Nothing is exempt, so this file's own timer is recorded, and its handler wrapped.
    undo.push(clearAppTimersAtEnd({ afterAll, exempt: () => false }));
    const done = vi.fn(function (this: unknown, ..._: unknown[]) {
      return this;
    });
    const id = setTimeout(done, 1, 'a', 'b');
    await sleep(20);

    expect(done).toHaveBeenCalledWith('a', 'b');
    expect(done.mock.results[0]!.value).toBe(id);
  });

  it("leaves a test's own timers alone", async () => {
    undo.push(clearAppTimersAtEnd({ afterAll }));
    const own = vi.fn();
    setTimeout(own, 20);

    end();
    await sleep(60);

    expect(own).toHaveBeenCalledOnce();
  });

  it("leaves alone a timer an exempt function says is not the app's", async () => {
    undo.push(clearAppTimersAtEnd({ afterAll, exempt: (t) => t.delay === 25 }));
    const exempt = vi.fn();
    const other = vi.fn();
    after(25, exempt);
    after(20, other);

    end();
    await sleep(60);

    expect(exempt).toHaveBeenCalledOnce();
    expect(other).not.toHaveBeenCalled();
  });

  it('names the callers of what it cleared when asked to report', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    undo.push(clearAppTimersAtEnd({ afterAll, report: true }));
    after(1000, () => {});
    every(500, () => {});

    end();

    expect(warn).toHaveBeenCalledOnce();
    const [message] = reported(warn);
    expect(message).toMatch(/cleared 2 timer\(s\)/);
    expect(message).toMatch(/setTimeout, 1000 ms, from .*fixtures\/app\.ts/);
    expect(message).toMatch(/setInterval, 500 ms, from .*fixtures\/app\.ts/);
  });

  it('says nothing when there was nothing to clear, or when not asked to report', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    undo.push(clearAppTimersAtEnd({ afterAll, report: true }));
    end();
    undo.splice(0).forEach((restore) => restore());
    atEnd = [];
    undo.push(clearAppTimersAtEnd({ afterAll }));
    after(1000, () => {});
    end();

    expect(warn).not.toHaveBeenCalled();
  });

  it('records nothing while fake timers are on: their clock owns those timers', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    undo.push(clearAppTimersAtEnd({ afterAll, report: true }));
    vi.useFakeTimers();
    const done = vi.fn();
    after(1000, done);

    end();
    vi.advanceTimersByTime(1000);

    expect(warn).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalledOnce();
  });

  it('clears through the timers below it even when fake timers were left on at the end', async () => {
    undo.push(clearAppTimersAtEnd({ afterAll }));
    const done = vi.fn();
    after(30, done);
    // So that the fake clearTimeout cannot clear the real timer itself.
    vi.useFakeTimers({ shouldClearNativeTimers: false });

    end();
    vi.useRealTimers();
    await sleep(60);

    expect(done).not.toHaveBeenCalled();
  });

  it.each([
    ['stress first', () => [installStress({ enabled: true, seed: 3 }), clearAppTimersAtEnd({ afterAll, report: true })]],
    ['stress last', () => [clearAppTimersAtEnd({ afterAll, report: true }), installStress({ enabled: true, seed: 3 })]],
    ['twice', () => [clearAppTimersAtEnd({ afterAll, report: true }), clearAppTimersAtEnd({ afterAll, report: true })]],
  ])('records a timer once, with the delay the app gave, whatever else wraps it (%s)', (_, install) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    undo.push(...install());
    after(3000, () => {});

    end();

    expect(reported(warn)).toEqual([expect.stringMatching(/cleared 1 timer\(s\)[^]*setTimeout, 3000 ms/)]);
  });

  it('records a held interval, and clears it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    undo.push(holdBackgroundIntervals(), clearAppTimersAtEnd({ afterAll, report: true }));
    every(5, () => {});

    end();

    expect(reported(warn)).toEqual([expect.stringMatching(/cleared 1 timer\(s\)[^]*setInterval, 5 ms/)]);
  });

  it("clears each timer through the scope that set it, and records once a window's timer built on Node's", () => {
    // A window whose timers hand out numbers and run on Node's, as jsdom's do outside Vitest's own environment.
    const ids = new Map<number, ReturnType<typeof setTimeout>>();
    let next = 1;
    const windowCleared: number[] = [];
    const win = {
      setTimeout: (handler: TimerHandler, delay?: number) => {
        ids.set(next, globalThis.setTimeout(typeof handler === 'function' ? (handler as () => void) : () => {}, delay));
        return next++;
      },
      setInterval: (handler: () => void, delay?: number) => {
        ids.set(next, globalThis.setInterval(handler, delay));
        return next++;
      },
      // Straight to Node's, so a record the global scope might hold is not removed on the way.
      clearTimeout: (id: number) => (windowCleared.push(id), real.clearTimeout(ids.get(id))),
      clearInterval: (id: number) => (windowCleared.push(id), real.clearInterval(ids.get(id))),
    };
    vi.stubGlobal('window', win);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    undo.push(clearAppTimersAtEnd({ afterAll, report: true }));
    const timeout = afterInWindow(1000, () => {});
    const interval = everyInWindow(1000, () => {});
    afterInWindow(1000, 'void 0');

    end();

    expect(windowCleared).toEqual([timeout, interval]);
    expect(clearedIds).toEqual([]);
    expect(reported(warn)).toEqual([expect.stringMatching(/cleared 2 timer\(s\)/)]);
    ids.forEach((id) => real.clearTimeout(id));
  });

  it('is undone by the function it returns, which puts all four functions back', () => {
    const before = { ...real, clearTimeout: globalThis.clearTimeout };
    const restore = clearAppTimersAtEnd({ afterAll });
    expect(globalThis.setTimeout).not.toBe(before.setTimeout);
    const id = after(1000, () => {});

    restore();
    end();
    real.clearTimeout(id);

    expect(globalThis.setTimeout).toBe(before.setTimeout);
    expect(globalThis.setInterval).toBe(before.setInterval);
    expect(globalThis.clearTimeout).toBe(before.clearTimeout);
    expect(globalThis.clearInterval).toBe(before.clearInterval);
    expect(clearedIds).toEqual([]);
  });

  it('leaves in place a clearTimeout installed over it since, which then passes straight through', () => {
    const below = globalThis.clearTimeout;
    const restore = clearAppTimersAtEnd({ afterAll });
    const ours = globalThis.clearTimeout;
    const over = ((id: Parameters<typeof clearTimeout>[0]) => ours(id)) as typeof clearTimeout;
    globalThis.clearTimeout = over;
    const id = after(1000, () => {});

    restore();
    clearTimeout(id);

    expect(globalThis.clearTimeout).toBe(over);
    expect(clearedIds).toEqual([id]);
    globalThis.clearTimeout = below;
  });

  it('refuses to start without an afterAll to clear in', () => {
    expect(() => clearAppTimersAtEnd({} as never)).toThrow(TypeError);
    expect(() => clearAppTimersAtEnd(undefined as never)).toThrow(/afterAll/);
  });
});
