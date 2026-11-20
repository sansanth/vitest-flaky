import { atLeast, fromEnv, MAX_TIMER_MS } from './limit.js';

type Kind = TimerInfo['kind'];
type Name = Kind | 'clearTimeout' | 'clearInterval';
type Fn = (this: unknown, ...args: unknown[]) => unknown;
type TimerScope = Record<Name, Fn>;

/**
 * Stack frames from these paths belong to tests, test tooling or the test environment: their timers are left alone.
 * jsdom and happy-dom are here because they run `requestAnimationFrame` on an interval of their own.
 */
export const DEFAULT_EXEMPT =
  /[\\/](?:test|tests|__tests__|test-utils|test-helpers|vitest|@vitest|@testing-library|jsdom|happy-dom)[\\/]|\.(?:test|spec)\.[cm]?[jt]sx?\b/;

const OFF = ['', '0', 'false', 'off', 'no'];

/** A timer as an `exempt` function sees it. */
export interface TimerInfo {
  kind: 'setTimeout' | 'setInterval';
  delay: number | undefined;
  /** The first frame outside vitest-flaky, as `exempt` patterns see it: project root removed, forward slashes. */
  caller: string;
  /** Every frame outside vitest-flaky, nearest first, in the same form. */
  stack: readonly string[];
}

/**
 * One pattern, a list, or a function that returns true for a timer that is not the app's. Each replaces the default:
 * to add to it, start the list with `DEFAULT_EXEMPT` or call `isDefaultExempt` from the function.
 */
export type Exempt = RegExp | readonly RegExp[] | ((timer: TimerInfo) => boolean);

/** Whether `DEFAULT_EXEMPT` leaves the timer alone, for an `exempt` function that adds to the default. */
export function isDefaultExempt(timer: TimerInfo): boolean {
  return DEFAULT_EXEMPT.test(timer.caller);
}

// Read when needed, not at import: Vitest's browser mode has no `process`.
const proc = () => (globalThis as { process?: { env: Record<string, string | undefined>; cwd(): string } }).process;
const envVar = (name: string) => proc()?.env[name];

// jsdom's window and Node's global can hold separate timer functions; both are wrapped.
function scopes(): TimerScope[] {
  const all = new Set<object>([globalThis]);
  if (typeof window !== 'undefined') all.add(window);
  return [...all] as TimerScope[];
}

// This file's own frames are skipped by name, so a wrapper or a bundler that adds a frame cannot shift the caller. The
// name is read from a frame of this file rather than assumed, so it holds in any checkout directory. Frames are the
// lines that end in `line:column`, in V8's format (`at fn (file:1:2)`) and in Firefox's and Safari's (`fn@file:1:2`).
const frameFile = (frame: string) => /[\s(@]([^\s()@]+):\d+:\d+\)?\s*$/.exec(frame)?.[1];
// A tool that sets `Error.prepareStackTrace` can make `stack` something other than a string.
const lines = (stack: unknown) => (typeof stack === 'string' ? stack.split('\n') : []);
// Undefined if there was no stack to read at import, as when `Error.stackTraceLimit` is 0: then no caller is named.
const OWN_FILE = lines(new Error().stack).map(frameFile).find(Boolean);
const outside = (line: string) => {
  const file = frameFile(line);
  return file !== undefined && file !== OWN_FILE;
};

/**
 * The first frame of `stack` outside this file: whoever called the timer.
 * @internal
 */
export function callerOf(stack: unknown): string {
  return (OWN_FILE && lines(stack).find(outside)) || '';
}

// Matched without the project's own directory, so an app checked out under a folder named `test` is still the app.
// Both sides use forward slashes, which is how Windows paths come out of a stack as often as not. A timer whose caller
// cannot be read is left alone: shortening a test's own wait is worse than missing one of the app's.
const slashes = (path: string) => path.replaceAll('\\', '/');
// The last working directory that could be read, so one deleted mid-run does not change what counts as the app's. Empty
// where there is no `process`, as in a browser, where paths are not stripped. Undefined if it was never readable.
let knownRoot: string | undefined;
function projectRoot(): string | undefined {
  const p = proc();
  if (typeof p?.cwd !== 'function') return '';
  try {
    knownRoot = slashes(p.cwd());
  } catch {
    // The working directory was deleted: the app's timer must not throw for that.
  }
  return knownRoot;
}

/**
 * The timer as `exempt` sees it, or undefined when it has no caller to judge it by. `stack` is left empty unless
 * `withStack`: only a function reads it.
 * @internal
 */
export function timerInfo(
  kind: Kind,
  delay: number | undefined,
  stack: unknown,
  withStack: boolean,
): TimerInfo | undefined {
  const root = projectRoot();
  // Without the project's directory, a path under a folder named `test` would read as the tests', so the timer is left
  // alone, as one with no caller is.
  if (root === undefined || !OWN_FILE) return undefined;
  const strip = (frame: string) => (root.length > 1 ? slashes(frame).replace(root, '') : slashes(frame));
  const frames = withStack ? lines(stack).filter(outside) : [lines(stack).find(outside)].filter((f) => f !== undefined);
  if (frames.length === 0) return undefined;
  const stripped = Object.freeze(frames.map(strip));
  return Object.freeze({ kind, delay, caller: stripped[0]!, stack: withStack ? stripped : Object.freeze([]) });
}

// One timer can pass through several wrappers of this file: `installStress` and `clearAppTimersAtEnd` both wrap
// `setTimeout`, in whichever order they were called. The outermost takes the stack, and the delay as the app gave it;
// the ones inside, which see the same handler, judge the timer from those. The stack is taken in the outermost wrapper
// so that as few of `Error.stackTraceLimit`'s frames as possible are this file's. It is only formatted when read.
interface Call {
  kind: Kind;
  handler: unknown;
  delay: number | undefined;
  error: Error;
  /** Null when the timer has no caller to judge it by. */
  info?: TimerInfo | null;
}
let active: Call | undefined;

function within<T>(kind: Kind, handler: unknown, delay: number | undefined, run: (call: Call) => T): T {
  if (active?.kind === kind && active.handler === handler) return run(active);
  const outer = active;
  active = { kind, handler, delay, error: new Error() };
  try {
    return run(active);
  } finally {
    active = outer;
  }
}

// A pattern needs the caller only, a function the whole stack; a whole stack does for both.
function info(call: Call, withStack: boolean): TimerInfo | undefined {
  if (call.info === undefined || (withStack && call.info?.stack.length === 0)) {
    call.info = timerInfo(call.kind, call.delay, call.error.stack, withStack) ?? null;
  }
  return call.info ?? undefined;
}

// A predicate that threw has said so once; the timers it was asked about are left alone.
const reported = new WeakSet<object>();
// Set while an `exempt` function runs. A timer it sets itself, as through a logger, is left alone rather than judged by
// it again, which would never end.
let judging = false;

/** What the timer of `call` counts as for `exempt`: its info if it is the app's, else undefined. */
function judge(exempt: Exempt | undefined): (call: Call) => TimerInfo | undefined {
  if (typeof exempt === 'function') {
    return (call) => {
      const timer = judging ? undefined : info(call, true);
      if (!timer) return undefined;
      judging = true;
      try {
        return exempt(timer) ? undefined : timer;
      } catch (error) {
        // A bug in the predicate must never shorten a test's own wait.
        if (!reported.has(exempt)) {
          reported.add(exempt);
          const message = 'vitest-flaky: the exempt function threw, so the timers it is asked about are left alone:';
          console.warn(message, error);
        }
        return undefined;
      } finally {
        judging = false;
      }
    };
  }
  const all = [exempt === undefined ? DEFAULT_EXEMPT : exempt].flat();
  if (!all.every((p) => Object.prototype.toString.call(p) === '[object RegExp]')) {
    throw new TypeError('exempt must be a RegExp, a list of them, or a function');
  }
  if (all.length === 0) throw new RangeError('exempt must hold at least one pattern');
  // The g and y flags make `test` remember where it matched last, so the answer would change from one timer to the
  // next. Copies, as the caller's pattern may be shared.
  const patterns = all.map((p) => (/[gy]/.test(p.flags) ? new RegExp(p.source, p.flags.replace(/[gy]/g, '')) : p));
  return (call) => {
    const timer = info(call, false);
    return timer && !patterns.some((pattern) => pattern.test(timer.caller)) ? timer : undefined;
  };
}

// Wrappers that were undone while something else sat on top of them, with what each wraps. They only pass calls on, so
// the next wrapper goes around what they wrap instead of stacking one more layer on them.
const undone = new WeakMap<object, Fn>();
const pastDead = (fn: Fn) => {
  for (let dead = undone.get(fn); dead; dead = undone.get(fn)) fn = dead;
  return fn;
};
let warned = false;

/** Puts `around(original)` in place of each of `names` in every scope, and returns the undo. */
function wrap(names: readonly Name[], around: (original: Fn, name: Name, scope: TimerScope) => Fn): () => void {
  if (projectRoot() === undefined && !warned) {
    warned = true;
    console.warn('vitest-flaky: the working directory cannot be read, so timers are left alone');
  }
  const restores = scopes().flatMap((scope) =>
    names.map((name) => {
      const original = pastDead(scope[name]);
      const inner = around(original, name, scope);
      let on = true;
      let done = false;
      // The original's own properties come along, such as the symbol `util.promisify` looks for on Node's timers.
      const wrapper = Object.assign(function (this: unknown, ...args: unknown[]) {
        return (on ? inner : original).apply(this, args);
      }, original);
      scope[name] = wrapper;
      return () => {
        if (done) return;
        done = true;
        on = false;
        // Another wrapper installed since, such as fake timers, is not ours to remove: it keeps calling ours, which
        // then passes the call straight on.
        if (scope[name] === wrapper) {
          // Past any wrapper below that was undone while this one sat on top of it.
          scope[name] = pastDead(original);
        } else undone.set(wrapper, original);
      };
    }),
  );
  return () => restores.forEach((restore) => restore());
}

/** Wraps `kind` so that each timer's delay is `delayFor` it. */
function wrapDelay(kind: Kind, delayFor: (delay: number | undefined, call: Call) => number | undefined): () => void {
  return wrap([kind], (original) =>
    function (this: unknown, handler: unknown, delay?: unknown, ...args: unknown[]) {
      return within(kind, handler, delay as number | undefined, (call) =>
        original.call(this, handler, delayFor(delay as number | undefined, call), ...args),
      );
    },
  );
}

// mulberry32: neighbouring seeds, which the command hands out round by round, give unrelated sequences.
function randomFrom(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

export interface HoldOptions {
  /** Timers whose caller matches this, or for which it returns true, are not the app's. Default `DEFAULT_EXEMPT`. */
  exempt?: Exempt;
}

/**
 * Every interval the app sets is registered and cleared as usual but never fires on real time, so a poll cannot run
 * between two steps of a test. A test about a poll uses fake timers, which replace `setInterval` with one that fires as
 * the test moves the clock. Intervals set by tests and test tooling run as usual. Returns a function that undoes it.
 */
export function holdBackgroundIntervals(options: HoldOptions = {}): () => void {
  const byApp = judge(options.exempt);
  return wrapDelay('setInterval', (delay, call) => (byApp(call) ? MAX_TIMER_MS : delay));
}

/** What `installStress` needs from Testing Library: pass `configure` and `getConfig` from the package your tests use. */
export interface TestingLibraryConfig {
  configure(config: { asyncWrapper: (callback: () => Promise<unknown>) => Promise<unknown> }): void;
  getConfig(): { asyncWrapper: (callback: () => Promise<unknown>) => Promise<unknown> };
}

export interface StressOptions {
  /** Default: on when `VITEST_FLAKY` is set to something other than blank, `0`, `false`, `off` or `no`. */
  enabled?: boolean;
  /** Replays a run: the same seed gives the same delays. Default `VITEST_FLAKY_SEED`, or 1. */
  seed?: number;
  /**
   * A timeout the app sets fires after between all of its delay and `1 / maxSlowdown` of it. Default
   * `VITEST_FLAKY_SLOWDOWN`, or 30.
   */
  maxSlowdown?: number;
  /**
   * After every `findBy`/`waitFor` the test resumes up to this late, at most 2147483647. Needs `testingLibrary`.
   * Default `VITEST_FLAKY_MAX_RESUME`, or 100.
   */
  maxResumeDelayMs?: number;
  /** Without it, the late resume is left out. */
  testingLibrary?: TestingLibraryConfig;
  exempt?: Exempt;
}

/**
 * A slow CI runner in miniature, to find the races left in a suite before CI does:
 *
 * - every timeout the app or a library sets fires after a random share of its delay, from all of it down to
 *   `1 / maxSlowdown`, as if the test ran that much slower than the timers expect. A test's own timers, and Testing
 *   Library's, keep their delay: a test's wait or `waitFor`'s ceiling is not what is under test;
 * - after every `findBy`/`waitFor` the test resumes up to `maxResumeDelayMs` late, as on a busy runner, so whatever the
 *   app queued meanwhile runs before the next step.
 *
 * Off unless `enabled` or `VITEST_FLAKY` says otherwise. Returns a function that undoes it. `exempt` throws a
 * `TypeError` unless it is a RegExp, a list of them, or a function.
 */
export function installStress(options: StressOptions = {}): () => void {
  if (!(options.enabled ?? !OFF.includes((envVar('VITEST_FLAKY') ?? '').trim().toLowerCase()))) return () => {};
  const byApp = judge(options.exempt);
  const maxSlowdown =
    options.maxSlowdown === undefined
      ? (fromEnv(envVar('VITEST_FLAKY_SLOWDOWN'), 'VITEST_FLAKY_SLOWDOWN', 1) ?? 30)
      : atLeast(options.maxSlowdown, 'maxSlowdown', 1);
  const maxResumeDelayMs =
    options.maxResumeDelayMs === undefined
      ? (fromEnv(envVar('VITEST_FLAKY_MAX_RESUME'), 'VITEST_FLAKY_MAX_RESUME', 0, MAX_TIMER_MS) ?? 100)
      : atLeast(options.maxResumeDelayMs, 'maxResumeDelayMs', 0, MAX_TIMER_MS);
  // A fixed seed replays a failure: timers are set in the same order run to run, so the same delays come out. The late
  // resumes draw from a stream of their own: when a `waitFor` settles depends on the clock and would shift the rest.
  const seed = options.seed ?? Number(envVar('VITEST_FLAKY_SEED')?.trim() || 1);
  if (!Number.isInteger(seed)) throw new RangeError('seed must be a whole number');
  const random = randomFrom(seed);
  const randomResume = randomFrom(seed ^ 0x9e3779b9);

  // Taken before the wrapping below, so the late resume is not itself shortened.
  const realSetTimeout = globalThis.setTimeout;
  let restoreWrapper = () => {};
  const library = options.testingLibrary;
  if (library) {
    const { asyncWrapper } = library.getConfig();
    let on = true;
    library.configure({
      asyncWrapper: (callback) =>
        asyncWrapper(async () => {
          const result = await callback();
          if (on) {
            await new Promise((resolve) => realSetTimeout(resolve, Math.floor(randomResume() * maxResumeDelayMs)));
          }
          return result;
        }),
    });
    const ours = library.getConfig().asyncWrapper;
    restoreWrapper = () => {
      on = false;
      if (library.getConfig().asyncWrapper === ours) library.configure({ asyncWrapper });
    };
  }

  // Log-uniform, so a mild slowdown comes up as often as a severe one.
  const restoreTimers = wrapDelay('setTimeout', (delay, call) =>
    delay && delay > 0 && delay <= MAX_TIMER_MS && byApp(call)
      ? Math.floor(delay * maxSlowdown ** -random())
      : delay,
  );
  return () => {
    restoreTimers();
    restoreWrapper();
  };
}

export interface ClearOptions {
  /** Vitest's `afterAll`, passed in so the package does not import vitest (as `testingLibrary` is passed in). */
  afterAll: (fn: () => void) => void;
  exempt?: Exempt;
  /** Default false: list the callers of the timers it cleared with `console.warn`. */
  report?: boolean;
}

// Set while a wrapper of `clearAppTimersAtEnd` hands a timer on, so that a wrapper further in, as when jsdom's timers
// call Node's or the setup file ran twice, does not record the same timer again.
let handing = false;

// Node marks a timer done when it fires, is cleared by any route (its number, `close()`, `using`) or is not refreshed.
const finished = (id: unknown) => (id as { _destroyed?: unknown } | null)?._destroyed === true;

/**
 * Records every timeout and interval the app sets, and clears the ones still pending when the test file ends, so a
 * library's leftover timer cannot fire after the environment is torn down. Call it from a setup file, which Vitest
 * runs for each test file. A timer set while fake timers are on is theirs and is not recorded. Returns a function that
 * undoes it.
 */
export function clearAppTimersAtEnd(options: ClearOptions): () => void {
  if (typeof options?.afterAll !== 'function') {
    throw new TypeError("afterAll must be a function: pass Vitest's afterAll");
  }
  const byApp = judge(options.exempt);
  // Per scope, as Node's ids are objects and jsdom's are numbers, and a timer is cleared through the scope that set it,
  // with what was there before this wrapper, so fake timers left on by the last test cannot swallow it.
  const scopesSeen = new Map<TimerScope, { pending: Map<unknown, TimerInfo>; clear: Partial<Record<Kind, Fn>> }>();
  const of = (scope: TimerScope) => {
    let entry = scopesSeen.get(scope);
    if (!entry) scopesSeen.set(scope, (entry = { pending: new Map(), clear: {} }));
    return entry;
  };

  options.afterAll(() => {
    const cleared: TimerInfo[] = [];
    for (const [scope, { pending, clear }] of scopesSeen) {
      for (const [id, timer] of pending) {
        if (finished(id)) continue;
        pastDead(clear[timer.kind]!).call(scope, id);
        cleared.push(timer);
      }
      pending.clear();
    }
    if (options.report && cleared.length > 0) {
      const list = cleared.map((t) => `\n  ${t.kind}, ${t.delay ?? 0} ms, from ${t.caller.trim().replace(/^at /, '')}`);
      const count = `${cleared.length} timer(s)`;
      console.warn(`vitest-flaky: cleared ${count} the app left pending when the file ended:${list.join('')}`);
    }
  });

  const undo = wrap(['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'], (original, name, scope) => {
    const { pending, clear } = of(scope);
    if (name === 'clearTimeout' || name === 'clearInterval') {
      clear[name === 'clearTimeout' ? 'setTimeout' : 'setInterval'] = original;
      // Either one clears either kind of timer, in Node and in browsers.
      return function (this: unknown, id: unknown, ...args: unknown[]) {
        pending.delete(id);
        return original.call(this, id, ...args);
      };
    }
    return function (this: unknown, handler: unknown, delay?: unknown, ...args: unknown[]) {
      const pass = (fn: unknown) => {
        const was = handing;
        handing = true;
        try {
          return original.call(this, fn, delay, ...args);
        } finally {
          handing = was;
        }
      };
      if (handing) return pass(handler);
      return within(name, handler, delay as number | undefined, (call) => {
        const timer = byApp(call);
        // A timeout with a string to run cannot say when it fired: it is not recorded, as it cannot be told apart from
        // one that has.
        if (!timer || (name === 'setTimeout' && typeof handler !== 'function')) return pass(handler);
        if (name === 'setInterval') {
          const id = pass(handler);
          pending.set(id, timer);
          return id;
        }
        // Declared ahead of the handler, which a stand-in for the timer below might run before this has its id.
        let id: unknown = undefined;
        let fired = false;
        const fn = function (this: unknown, ...a: unknown[]) {
          fired = true;
          pending.delete(id);
          return (handler as Fn).apply(this, a);
        };
        // A wrapper further in knows the timer by the handler it is given.
        call.handler = fn;
        id = pass(fn);
        if (fired) return id;
        pending.set(id, timer);
        // Node's `refresh()` starts a timeout again, after it fired too.
        const refresh = (id as { refresh?: unknown } | null)?.refresh;
        if (typeof refresh === 'function') {
          Object.defineProperty(id, 'refresh', {
            configurable: true,
            writable: true,
            value: function (this: unknown) {
              pending.set(id, timer);
              return refresh.call(this);
            },
          });
        }
        return id;
      });
    };
  });
  return () => {
    undo();
    for (const { pending } of scopesSeen.values()) pending.clear();
  };
}
