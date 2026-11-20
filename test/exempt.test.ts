import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { after, every } from '../fixtures/app';
import { closeToast } from '../fixtures/shared/toast';
import { hideTooltip } from '../fixtures/shared/tooltip';
import {
  clearAppTimersAtEnd,
  holdBackgroundIntervals,
  installStress,
  isDefaultExempt,
  timerInfo,
  type TimerInfo,
} from '../src/index';

let given: (number | undefined)[] = [];
const realSetTimeout = globalThis.setTimeout;
const undo: (() => void)[] = [];
const sleep = (ms: number) => new Promise((resolve) => realSetTimeout(resolve, ms));

beforeEach(() => {
  given = [];
  globalThis.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
    given.push(delay);
    return realSetTimeout(handler as () => void, delay, ...args);
  }) as typeof setTimeout;
});

afterEach(() => {
  undo.splice(0).forEach((restore) => restore());
  vi.restoreAllMocks();
  globalThis.setTimeout = realSetTimeout;
});

const frame = (path: string) => `    at f (${path}:1:1)`;
// The stacks an exempt function was shown, by `record`, which exempts nothing.
const stacks: (readonly string[])[] = [];
function record(t: TimerInfo) {
  stacks.push(t.stack);
  return false;
}

const timer = (caller: string): TimerInfo => ({ kind: 'setTimeout', delay: 10, caller, stack: [caller] });

describe('exempt as a function', () => {
  it('tells apart two components that set their timers through one helper, by a frame above it', () => {
    const exempt = (t: TimerInfo) => isDefaultExempt(t) || t.stack.some((f) => /fixtures\/shared\/toast\.ts/.test(f));
    undo.push(installStress({ enabled: true, seed: 3, exempt }));
    clearTimeout(closeToast(() => {}));
    clearTimeout(hideTooltip(() => {}));

    expect(given[0]).toBe(3000);
    expect(given[1]).toBeLessThan(3000);
  });

  it('is shown the kind, the delay, the caller and the frames above it, without the project directory', () => {
    const seen: TimerInfo[] = [];
    undo.push(installStress({ enabled: true, seed: 3, exempt: (t) => (seen.push(t), true) }));
    clearTimeout(closeToast(() => {}));

    const [toast] = seen;
    expect(toast).toMatchObject({ kind: 'setTimeout', delay: 3000 });
    expect(toast!.caller).toMatch(/fixtures\/shared\/later\.ts/);
    expect(toast!.stack[0]).toBe(toast!.caller);
    expect(toast!.stack[1]).toMatch(/fixtures\/shared\/toast\.ts/);
    expect(toast!.stack.join('\n')).not.toContain(process.cwd());
    expect(toast!.stack.join('\n')).not.toMatch(/src[\\/]index\.ts/);
    expect(Object.isFrozen(toast)).toBe(true);
    expect(Object.isFrozen(toast!.stack)).toBe(true);
  });

  it('is given to holdBackgroundIntervals as well, which holds what it does not exempt', async () => {
    undo.push(holdBackgroundIntervals({ exempt: (t) => t.kind === 'setInterval' && t.delay === 5 }));
    let exempt = 0;
    let held = 0;
    const ids = [every(5, () => exempt++), every(6, () => held++)];

    await sleep(60);
    ids.forEach((id) => clearInterval(id));

    expect(exempt).toBeGreaterThan(0);
    expect(held).toBe(0);
  });

  it('leaves the timer alone when the function throws, and warns once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const exempt = () => {
      throw new Error('oops');
    };
    undo.push(installStress({ enabled: true, seed: 3, exempt }));
    undo.push(holdBackgroundIntervals({ exempt }));
    clearTimeout(after(3000, () => {}));
    clearTimeout(after(3000, () => {}));
    let ticks = 0;
    const id = every(5, () => ticks++);
    await sleep(60);
    clearInterval(id);

    expect(given).toEqual([3000, 3000]);
    expect(ticks).toBeGreaterThan(0);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0])).toContain('oops');
  });

  it('is not asked about a timer whose caller cannot be read', () => {
    const exempt = vi.fn(() => false);
    undo.push(installStress({ enabled: true, seed: 3, exempt }));
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 0;
    try {
      clearTimeout(after(3000, () => {}));
    } finally {
      Error.stackTraceLimit = limit;
    }

    expect(given).toEqual([3000]);
    expect(exempt).not.toHaveBeenCalled();
  });

  const stress = () => installStress({ enabled: true, seed: 3, exempt: record });
  const clear = () => clearAppTimersAtEnd({ afterAll: () => {}, exempt: record });
  it.each([
    ['stress first', () => [stress(), clear()]],
    ['stress last', () => [clear(), stress()]],
  ])('reads the stack once, in the outermost wrapper, so the frame above a helper fits a short stack (%s)', (_, install) => {
    stacks.length = 0;
    undo.push(...install());
    const limit = Error.stackTraceLimit;
    // Three frames are this package's, which leaves the helper and the component that called it.
    Error.stackTraceLimit = 5;
    try {
      clearTimeout(closeToast(() => {}));
    } finally {
      Error.stackTraceLimit = limit;
    }

    expect(stacks).toHaveLength(2);
    expect(stacks[0]).toBe(stacks[1]);
    expect(stacks[0]![1]).toMatch(/fixtures\/shared\/toast\.ts/);
  });

  it('leaves alone a timer the function sets itself, rather than asking it again without end', () => {
    const exempt = vi.fn((t: TimerInfo) => {
      clearTimeout(after(500, () => {}));
      return t.delay === 500;
    });
    undo.push(installStress({ enabled: true, seed: 3, exempt }));
    clearTimeout(after(3000, () => {}));

    expect(exempt).toHaveBeenCalledOnce();
    expect(given[0]).toBe(500);
    expect(given[1]).toBeLessThan(3000);
  });

  it("refuses an exempt that is not a RegExp, a list of them or a function, and says what it takes", () => {
    expect(() => installStress({ enabled: true, exempt: 'toast' as never })).toThrow(
      'exempt must be a RegExp, a list of them, or a function',
    );
  });
});

describe('isDefaultExempt', () => {
  it.each([
    ['/work/node_modules/@testing-library/dom/dist/wait-for.js', true],
    ['/work/src/inbox.test.ts', true],
    ['/work/src/inbox.ts', false],
  ])('counts a timer called from %s as test code: %s', (path, exempt) => {
    expect(isDefaultExempt(timer(frame(path)))).toBe(exempt);
  });

  it("is replaced by a function, which then decides for a test's own timers too", () => {
    undo.push(installStress({ enabled: true, seed: 3, exempt: () => false }));
    clearTimeout(setTimeout(() => {}, 3000));

    expect(given[0]).toBeLessThan(3000);
  });

  it('can be added to from a function', () => {
    undo.push(installStress({ enabled: true, seed: 3, exempt: (t) => isDefaultExempt(t) || /fixtures\/app/.test(t.caller) }));
    clearTimeout(setTimeout(() => {}, 3000));
    clearTimeout(after(3000, () => {}));
    clearTimeout(closeToast(() => {}));

    expect(given).toEqual([3000, 3000, expect.any(Number)]);
    expect(given[2]).toBeLessThan(3000);
  });
});

describe("Base UI's toast", () => {
  // The stack the toast's close timer was set with: @base-ui/react 1.9.0, React 19.3, Vitest 5.1 under jsdom, at
  // Vitest's own `Error.stackTraceLimit` of 10. The checkout directory is replaced with /work/app, and the frame of the
  // wrapper that recorded it is left out, as vitest-flaky's own frames are.
  const stack = readFileSync(new URL('../fixtures/base-ui-toast.stack', import.meta.url), 'utf8');

  it('is named by the frame above useTimeout, which a function can exempt on its own', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/work/app');
    const toast = timerInfo('setTimeout', 4000, stack, true)!;

    expect(toast.caller).toMatch(/@base-ui\/utils\/useTimeout/);
    expect(toast.stack[1]).toMatch(/@base-ui\/react\/toast\//);
    expect(isDefaultExempt(toast)).toBe(false);
    expect(isDefaultExempt(toast) || toast.stack.some((f) => /@base-ui\/react\/.*toast/.test(f))).toBe(true);
  });

  it('gives a pattern only the useTimeout frame, which every Base UI timer shares', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/work/app');
    const toast = timerInfo('setTimeout', 4000, stack, false)!;

    expect(toast.caller).toBe('    at Timeout.start (file:///node_modules/@base-ui/utils/useTimeout.mjs:17:22)');
    expect(toast.stack).toEqual([]);
  });
});
