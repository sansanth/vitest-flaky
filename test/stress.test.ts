import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { after, soon } from '../fixtures/app';
import { installStress, type TestingLibraryConfig } from '../src/index';

// The delays timers are actually given, recorded under the wrapping installStress adds.
let given: (number | undefined)[] = [];
const realSetTimeout = globalThis.setTimeout;
const undo: (() => void)[] = [];

beforeEach(() => {
  // These tests say when stress mode is on; a run started by the command itself must not decide for them.
  vi.stubEnv('VITEST_FLAKY', '');
  vi.stubEnv('VITEST_FLAKY_SEED', undefined);
  given = [];
  globalThis.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
    given.push(delay);
    return realSetTimeout(handler as () => void, delay, ...args);
  }) as typeof setTimeout;
});

afterEach(() => {
  undo.splice(0).forEach((restore) => restore());
  globalThis.setTimeout = realSetTimeout;
  vi.unstubAllEnvs();
});

const delaysFor = (seed: number, count: number) => {
  given = [];
  const restore = installStress({ enabled: true, seed });
  for (let i = 0; i < count; i++) clearTimeout(after(3000, () => {}));
  restore();
  return [...given];
};

describe('installStress', () => {
  it('does nothing unless asked', () => {
    undo.push(installStress());
    clearTimeout(after(3000, () => {}));

    expect(given).toEqual([3000]);
  });

  it("fires the app's timeouts after between all of their delay and a thirtieth of it", () => {
    const delays = delaysFor(42, 50);

    expect(delays.every((delay) => delay! >= 100 && delay! <= 3000)).toBe(true);
    expect(delays.some((delay) => delay! < 1000)).toBe(true);
  });

  it('gives the same delays for the same seed, so a failure replays', () => {
    expect(delaysFor(7, 10)).toEqual(delaysFor(7, 10));
    expect(delaysFor(7, 10)).not.toEqual(delaysFor(8, 10));
  });

  it("leaves a test's own timeouts, a zero delay and no delay alone", () => {
    undo.push(installStress({ enabled: true, seed: 3 }));
    clearTimeout(setTimeout(() => {}, 3000));
    clearTimeout(after(0, () => {}));
    clearTimeout(soon(() => {}));

    expect(given).toEqual([3000, 0, undefined]);
  });

  it('stays off where there is no process, as in browser mode', () => {
    vi.stubGlobal('process', undefined);
    const restore = installStress();
    vi.unstubAllGlobals();
    restore();
    clearTimeout(after(3000, () => {}));

    expect(given).toEqual([3000]);
  });

  it('takes the slowdown it is given', () => {
    undo.push(installStress({ enabled: true, maxSlowdown: 1 }));
    clearTimeout(after(3000, () => {}));

    expect(given).toEqual([3000]);
  });

  it('turns on and takes its seed from the environment', () => {
    vi.stubEnv('VITEST_FLAKY', '1');
    vi.stubEnv('VITEST_FLAKY_SEED', '7');
    const restore = installStress();
    clearTimeout(after(3000, () => {}));
    restore();
    const fromEnv = given[0];

    expect(fromEnv).toBe(delaysFor(7, 1)[0]);
  });

  it.each(['0', 'false', 'FALSE', 'off', ' No ', ''])('stays off when VITEST_FLAKY is %j', (value) => {
    vi.stubEnv('VITEST_FLAKY', value);
    undo.push(installStress());
    clearTimeout(after(3000, () => {}));

    expect(given).toEqual([3000]);
  });

  it('gives unrelated delays to neighbouring seeds', () => {
    const first = delaysFor(1, 8);
    const second = delaysFor(2, 8);

    expect(second.filter((delay, i) => delay === first[i])).toHaveLength(0);
  });

  it('keeps what Node attaches to setTimeout, so promisify still works', async () => {
    globalThis.setTimeout = realSetTimeout;
    undo.push(installStress({ enabled: true, seed: 3 }));

    await expect(promisify(setTimeout)(5, 'done')).resolves.toBe('done');
  });

  it('leaves every timer alone when the package was loaded with no stack to read', async () => {
    const limit = Error.stackTraceLimit;
    vi.resetModules();
    Error.stackTraceLimit = 0;
    const blind = await import('../src/index');
    Error.stackTraceLimit = limit;
    undo.push(blind.installStress({ enabled: true, seed: 3 }));
    clearTimeout(setTimeout(() => {}, 3000));
    clearTimeout(after(3000, () => {}));

    expect(given).toEqual([3000, 3000]);
  });

  it.each([NaN, 1.5])('refuses a seed of %s', (seed) => {
    expect(() => installStress({ enabled: true, seed })).toThrow(RangeError);
  });

  it('leaves a timer alone when its caller cannot be read from the stack', () => {
    const limit = Error.stackTraceLimit;
    undo.push(installStress({ enabled: true, seed: 3 }));
    Error.stackTraceLimit = 0;
    try {
      clearTimeout(after(3000, () => {}));
    } finally {
      Error.stackTraceLimit = limit;
    }

    expect(given).toEqual([3000]);
  });

  it.each([0, 0.5, NaN])('refuses a maxSlowdown of %s, which would not shorten anything', (maxSlowdown) => {
    expect(() => installStress({ enabled: true, maxSlowdown })).toThrow(RangeError);
  });

  it('does not put back a Testing Library wrapper that something else set since', () => {
    let current = async (callback: () => Promise<unknown>) => callback();
    const library: TestingLibraryConfig = {
      getConfig: () => ({ asyncWrapper: current }),
      configure: ({ asyncWrapper }) => void (current = asyncWrapper as typeof current),
    };
    const restore = installStress({ enabled: true, seed: 3, testingLibrary: library });
    const other = async (callback: () => Promise<unknown>) => callback();
    current = other;
    restore();

    expect(current).toBe(other);
  });

  it('does not put back a timer that something else replaced since', () => {
    const restore = installStress({ enabled: true, seed: 3 });
    const replacement = (() => 0) as unknown as typeof setTimeout;
    globalThis.setTimeout = replacement;
    restore();

    expect(globalThis.setTimeout).toBe(replacement);
  });

  it('makes a test resume late after each wait, and puts the wrapper back when undone', async () => {
    const original = vi.fn(async (callback: () => Promise<unknown>) => callback());
    let current = original;
    const library: TestingLibraryConfig = {
      getConfig: () => ({ asyncWrapper: current }),
      configure: ({ asyncWrapper }) => void (current = asyncWrapper as typeof original),
    };

    const restore = installStress({ enabled: true, seed: 5, testingLibrary: library, maxResumeDelayMs: 50 });
    expect(current).not.toBe(original);
    const resumed = await current(async () => 'found');

    expect(resumed).toBe('found');
    expect(original).toHaveBeenCalledOnce();
    expect(given.some((delay) => delay! >= 0 && delay! < 50)).toBe(true);
    restore();
    expect(current).toBe(original);
  });
});
