import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { after, soon } from '../fixtures/app';
import { DEFAULT_EXEMPT, installStress, type TestingLibraryConfig } from '../src/index';

// The delays timers are actually given, recorded under the wrapping installStress adds.
let given: (number | undefined)[] = [];
const realSetTimeout = globalThis.setTimeout;
const undo: (() => void)[] = [];

beforeEach(() => {
  // These tests say when stress mode is on; a run started by the command itself must not decide for them.
  vi.stubEnv('VITEST_FLAKY', '');
  vi.stubEnv('VITEST_FLAKY_SEED', undefined);
  vi.stubEnv('VITEST_FLAKY_SLOWDOWN', undefined);
  vi.stubEnv('VITEST_FLAKY_MAX_RESUME', undefined);
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
  vi.unstubAllEnvs();
});

// A stand-in for Testing Library's config: `current` is the asyncWrapper in force.
const fakeLibrary = () => {
  const state = { current: async (callback: () => Promise<unknown>) => callback() };
  const library: TestingLibraryConfig = {
    getConfig: () => ({ asyncWrapper: state.current }),
    configure: ({ asyncWrapper }) => void (state.current = asyncWrapper as typeof state.current),
  };
  return { state, library };
};

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

  it('takes a list of patterns for what is not the app, which can add to the default', () => {
    undo.push(installStress({ enabled: true, seed: 3, exempt: [DEFAULT_EXEMPT, /[\\/]fixtures[\\/]/] }));
    clearTimeout(after(3000, () => {}));

    expect(given).toEqual([3000]);
  });

  it('takes the slowdown from the environment, and an option wins over it', () => {
    vi.stubEnv('VITEST_FLAKY_SLOWDOWN', '1');
    undo.push(installStress({ enabled: true, seed: 3 }));
    for (let i = 0; i < 10; i++) clearTimeout(after(3000, () => {}));
    expect(given).toEqual(Array(10).fill(3000));

    undo.splice(0).forEach((restore) => restore());
    given = [];
    undo.push(installStress({ enabled: true, seed: 3, maxSlowdown: 30 }));
    for (let i = 0; i < 10; i++) clearTimeout(after(3000, () => {}));
    expect(given.some((delay) => delay! < 3000)).toBe(true);
  });

  it('takes the late resume from the environment', async () => {
    vi.stubEnv('VITEST_FLAKY_MAX_RESUME', '0');
    const { state, library } = fakeLibrary();
    undo.push(installStress({ enabled: true, seed: 5, testingLibrary: library }));
    for (let i = 0; i < 5; i++) await state.current(async () => 'found');

    expect(given).toEqual(Array(5).fill(0));
  });

  it.each([-1, NaN, Infinity, 2 ** 31])('refuses a maxResumeDelayMs of %s', (maxResumeDelayMs) => {
    expect(() => installStress({ enabled: true, maxResumeDelayMs })).toThrow(RangeError);
  });

  it('refuses a slowdown from the environment that would not shorten anything', () => {
    vi.stubEnv('VITEST_FLAKY_SLOWDOWN', 'fast');

    expect(() => installStress({ enabled: true })).toThrow(RangeError);
  });

  it('checks the options and the variables only when stress is on, and names where a bad value came from', () => {
    vi.stubEnv('VITEST_FLAKY_SLOWDOWN', 'fast');
    expect(() => installStress({ enabled: false, exempt: [], maxSlowdown: 0, maxResumeDelayMs: -1 })).not.toThrow();
    expect(() => installStress({ enabled: true })).toThrow(/VITEST_FLAKY_SLOWDOWN must be/);
    expect(() => installStress({ enabled: true, maxSlowdown: 0 })).toThrow(/^maxSlowdown must be/);

    vi.stubEnv('VITEST_FLAKY_SLOWDOWN', undefined);
    vi.stubEnv('VITEST_FLAKY_MAX_RESUME', '-5');
    expect(() => installStress({ enabled: true })).toThrow(/VITEST_FLAKY_MAX_RESUME must be/);
  });

  it('refuses an empty list of patterns, which would leave every timer the app\'s', () => {
    expect(() => installStress({ enabled: true, exempt: [] })).toThrow(RangeError);
  });

  it('leaves a pattern the caller shares as it was', () => {
    const shared = /[\\/]fixtures[\\/]/g;
    shared.lastIndex = 7;
    undo.push(installStress({ enabled: true, seed: 3, exempt: [shared] }));
    clearTimeout(after(3000, () => {}));

    expect(shared.lastIndex).toBe(7);
  });

  it('gives the same answer for every timer when a pattern has the g flag', () => {
    undo.push(installStress({ enabled: true, seed: 3, exempt: [/[\\/]fixtures[\\/]/g] }));
    for (let i = 0; i < 4; i++) clearTimeout(after(3000, () => {}));

    expect(given).toEqual([3000, 3000, 3000, 3000]);
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

  it.each(['', ' '])('takes a blank VITEST_FLAKY_SEED (%j) as seed 1, for the timers and the late resumes', async (value) => {
    const run = async (seed: number | undefined) => {
      const { state, library } = fakeLibrary();
      given = [];
      const restore = installStress({ enabled: true, seed, testingLibrary: library, maxResumeDelayMs: 40 });
      clearTimeout(after(3000, () => {}));
      for (let i = 0; i < 4; i++) await state.current(async () => 'found');
      restore();
      return [...given];
    };
    vi.stubEnv('VITEST_FLAKY_SEED', value);
    const blank = await run(undefined);

    expect(blank).toEqual(await run(1));
  });

  it.each(['1.5', 'abc'])('refuses a VITEST_FLAKY_SEED of %j', (value) => {
    vi.stubEnv('VITEST_FLAKY_SEED', value);

    expect(() => installStress({ enabled: true })).toThrow(/seed must be a whole number/);
  });

  it.each(['0', 'false', 'FALSE', 'off', ' No ', ''])('stays off when VITEST_FLAKY is %j', (value) => {
    vi.stubEnv('VITEST_FLAKY', value);
    undo.push(installStress());
    clearTimeout(after(3000, () => {}));

    expect(given).toEqual([3000]);
  });

  it('shortens a delay of exactly what a timer can wait, but not one more', () => {
    globalThis.setTimeout = ((_: TimerHandler, delay?: number) => (given.push(delay), 0)) as unknown as typeof setTimeout;
    undo.push(installStress({ enabled: true, seed: 3 }));
    after(2 ** 31 - 1, () => {});
    after(2 ** 31, () => {});

    expect(given[0]).toBeLessThan(2 ** 31 - 1);
    expect(given[1]).toBe(2 ** 31);
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
    let blind: typeof import('../src/index');
    try {
      blind = await import('../src/index');
    } finally {
      Error.stackTraceLimit = limit;
    }
    undo.push(blind.installStress({ enabled: true, seed: 3 }));
    clearTimeout(setTimeout(() => {}, 3000));
    clearTimeout(after(3000, () => {}));

    expect(given).toEqual([3000, 3000]);
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

  it.each([0, 0.5, NaN, Infinity])('refuses a maxSlowdown of %s, which would not shorten anything', (maxSlowdown) => {
    expect(() => installStress({ enabled: true, maxSlowdown })).toThrow(RangeError);
  });

  it('does not put back a Testing Library wrapper that something else set since', () => {
    const { state, library } = fakeLibrary();
    const restore = installStress({ enabled: true, seed: 3, testingLibrary: library });
    const other = async (callback: () => Promise<unknown>) => callback();
    state.current = other;
    restore();

    expect(state.current).toBe(other);
  });

  it('does not put back a timer that something else replaced since', () => {
    const restore = installStress({ enabled: true, seed: 3 });
    const replacement = (() => 0) as unknown as typeof setTimeout;
    globalThis.setTimeout = replacement;
    restore();

    expect(globalThis.setTimeout).toBe(replacement);
  });

  it('stops shortening after its undo even when fake timers sit on top, which cannot be unwound', () => {
    // Nothing is exempt, so the layer below, which is in this file, would be shortened if the undo did not stop it.
    const restore = installStress({ enabled: true, seed: 3, exempt: /^$/ });
    const stressed = globalThis.setTimeout;
    globalThis.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) =>
      stressed(handler, delay, ...args)) as typeof setTimeout;
    restore();
    given = [];
    clearTimeout(after(3000, () => {}));

    expect(given).toEqual([3000]);
  });

  it('leaves timers alone, and says so once, when the working directory was never readable', async () => {
    vi.resetModules();
    vi.spyOn(process, 'cwd').mockImplementation(() => {
      throw new Error('ENOENT: uv_cwd');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fresh = await import('../src/index');
    undo.push(fresh.installStress({ enabled: true, seed: 3, exempt: /^$/ }));

    expect(() => clearTimeout(after(100000, () => {}))).not.toThrow();
    expect(given[0]).toBe(100000);
    undo.push(fresh.holdBackgroundIntervals());
    expect(warn).toHaveBeenCalledOnce();
  });

  it('treats a process with no cwd, as in a bundle, like no process: timers are not left alone', async () => {
    vi.resetModules();
    const real = globalThis.process;
    vi.stubGlobal('process', { env: {} });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let fresh: typeof import('../src/index');
    try {
      fresh = await import('../src/index');
      undo.push(fresh.installStress({ enabled: true, seed: 3, exempt: /^$/ }));
      clearTimeout(after(100000, () => {}));
    } finally {
      vi.stubGlobal('process', real);
    }

    expect(given[0]).toBeLessThan(100000);
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps telling the app from the tests when the working directory goes after the install', () => {
    // A pattern the project's own directory matches: it only stays the app's if the directory is still stripped.
    const project = new RegExp(process.cwd().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    undo.push(installStress({ enabled: true, seed: 3, exempt: project }));
    vi.spyOn(process, 'cwd').mockImplementation(() => {
      throw new Error('ENOENT: uv_cwd');
    });

    clearTimeout(after(100000, () => {}));
    expect(given[0]).toBeLessThan(100000);
  });

  it('does not stack a wrapper on one that was undone under something else', () => {
    globalThis.setTimeout = ((_: TimerHandler, delay?: number) => (given.push(delay), 0)) as unknown as typeof setTimeout;
    const base = globalThis.setTimeout;
    const restore = installStress({ enabled: true, seed: 3 });
    const layer = globalThis.setTimeout;
    globalThis.setTimeout = ((handler: TimerHandler, delay?: number) => layer(handler, delay)) as typeof setTimeout;
    restore();
    globalThis.setTimeout = layer;

    undo.push(installStress({ enabled: true, seed: 3 }));
    undo.splice(0).forEach((r) => r());

    // The second install went around the dead layer, so its undo leaves the timer as it was before either.
    expect(globalThis.setTimeout).toBe(base);
  });

  it('does nothing when an undo is called twice', () => {
    const base = globalThis.setTimeout;
    const first = installStress({ enabled: true, seed: 3 });
    first();
    const second = installStress({ enabled: true, seed: 3 });
    const wrapped = globalThis.setTimeout;
    first();

    expect(globalThis.setTimeout).toBe(wrapped);
    second();
    expect(globalThis.setTimeout).toBe(base);
  });

  it('puts the timer back whichever order two installs are undone in', () => {
    const base = globalThis.setTimeout;
    const first = installStress({ enabled: true, seed: 3 });
    const second = installStress({ enabled: true, seed: 4 });
    first();
    second();

    expect(globalThis.setTimeout).toBe(base);
  });

  it.each([['helpers'], [[/ok/, 'no']], [[null]], [{ test: () => true, flags: 'g' }], [null]])('refuses an exempt of %j', (exempt) => {
    expect(() => installStress({ enabled: true, exempt: exempt as never })).toThrow(TypeError);
  });

  it('takes a RegExp from another realm', () => {
    undo.push(installStress({ enabled: true, seed: 3, exempt: runInNewContext('/^$/') as RegExp }));
    clearTimeout(after(100000, () => {}));

    expect(given[0]).toBeLessThan(100000);
  });

  it('leaves a negative delay alone', () => {
    globalThis.setTimeout = ((_: TimerHandler, delay?: number) => (given.push(delay), 0)) as unknown as typeof setTimeout;
    undo.push(installStress({ enabled: true, seed: 3, exempt: /^$/ }));
    after(-5, () => {});

    expect(given).toEqual([-5]);
  });

  it('stops delaying a test after its undo even when something else wrapped the config since', async () => {
    const { state, library } = fakeLibrary();
    const restore = installStress({ enabled: true, seed: 5, testingLibrary: library, maxResumeDelayMs: 50 });
    const ours = state.current;
    state.current = (callback) => ours(callback);
    restore();
    given = [];
    await state.current(async () => 'found');

    expect(given).toEqual([]);
  });

  it.each([1.5, NaN])('refuses a seed of %s', (seed) => {
    expect(() => installStress({ enabled: true, seed })).toThrow(RangeError);
  });

  it('makes a test resume late after each wait, and puts the wrapper back when undone', async () => {
    const { state, library } = fakeLibrary();
    const original = vi.fn(state.current);
    state.current = original;

    const restore = installStress({ enabled: true, seed: 5, testingLibrary: library, maxResumeDelayMs: 50 });
    expect(state.current).not.toBe(original);
    const resumed = await state.current(async () => 'found');

    expect(resumed).toBe('found');
    expect(original).toHaveBeenCalledOnce();
    expect(given.some((delay) => delay! >= 0 && delay! < 50)).toBe(true);
    restore();
    expect(state.current).toBe(original);
  });
});
