import { atLeast, fromEnv, MAX_TIMER_MS } from './limit.js';

type Timer = (handler: TimerHandler, delay?: number, ...args: unknown[]) => unknown;
interface TimerScope {
  setTimeout: Timer;
  setInterval: Timer;
}

/**
 * Stack frames from these paths belong to tests, test tooling or the test environment: their timers are left alone.
 * jsdom and happy-dom are here because they run `requestAnimationFrame` on an interval of their own.
 */
export const DEFAULT_EXEMPT =
  /[\\/](?:test|tests|__tests__|test-utils|test-helpers|vitest|@vitest|@testing-library|jsdom|happy-dom)[\\/]|\.(?:test|spec)\.[cm]?[jt]sx?\b/;

const OFF = ['', '0', 'false', 'off', 'no'];

/** One pattern or a list. Either replaces the default, so to add to it start the list with `DEFAULT_EXEMPT`. */
export type Exempt = RegExp | readonly RegExp[];

function patterns(exempt: Exempt | undefined): RegExp[] {
  const all = [exempt === undefined ? DEFAULT_EXEMPT : exempt].flat();
  if (!all.every((p) => Object.prototype.toString.call(p) === '[object RegExp]')) {
    throw new TypeError('exempt must be a RegExp or a list of them');
  }
  if (all.length === 0) throw new RangeError('exempt must hold at least one pattern');
  // The g and y flags make `test` remember where it matched last, so the answer would change from one timer to the
  // next. Copies, as the caller's pattern may be shared.
  return all.map((p) => (/[gy]/.test(p.flags) ? new RegExp(p.source, p.flags.replace(/[gy]/g, '')) : p));
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

/**
 * The first frame of `stack` outside this file: whoever called the timer.
 * @internal
 */
export function callerOf(stack: unknown): string {
  if (!OWN_FILE) return '';
  for (const line of lines(stack)) {
    const file = frameFile(line);
    if (file && file !== OWN_FILE) return line;
  }
  return '';
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

function setByApp(exempt: RegExp[]): boolean {
  const caller = slashes(callerOf(new Error().stack));
  const root = projectRoot();
  // Without the project's directory, a path under a folder named `test` would read as the tests', so the timer is left
  // alone, as one with no caller is.
  if (root === undefined) return false;
  const path = root.length > 1 ? caller.replace(root, '') : caller;
  return caller !== '' && !exempt.some((pattern) => pattern.test(path));
}

// Wrappers that were undone while something else sat on top of them, with what each wraps. They only pass calls on, so
// the next wrapper goes around what they wrap instead of stacking one more layer on them.
const undone = new WeakMap<object, Timer>();
const pastDead = (timer: Timer) => {
  for (let dead = undone.get(timer); dead; dead = undone.get(timer)) timer = dead;
  return timer;
};
let warned = false;

function wrap(name: keyof TimerScope, delayFor: (delay: number | undefined) => number | undefined): () => void {
  if (projectRoot() === undefined && !warned) {
    warned = true;
    console.warn('vitest-flaky: the working directory cannot be read, so timers are left alone');
  }
  const restores = scopes().map((scope) => {
    const original = pastDead(scope[name]);
    let on = true;
    let done = false;
    // The original's own properties come along, such as the symbol `util.promisify` looks for on Node's timers.
    const wrapper = Object.assign(function (this: unknown, handler: TimerHandler, delay?: number, ...args: unknown[]) {
      return original.call(this, handler, on ? delayFor(delay) : delay, ...args);
    }, original);
    scope[name] = wrapper;
    return () => {
      if (done) return;
      done = true;
      on = false;
      // Another wrapper installed since, such as fake timers, is not ours to remove: it keeps calling ours, which then
      // leaves the delay as it is.
      if (scope[name] === wrapper) {
        // Past any wrapper below that was undone while this one sat on top of it.
        scope[name] = pastDead(original);
      } else undone.set(wrapper, original);
    };
  });
  return () => restores.forEach((restore) => restore());
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
  /** Timers set from frames matching this are not the app's. Default `DEFAULT_EXEMPT`. */
  exempt?: Exempt;
}

/**
 * Every interval the app sets is registered and cleared as usual but never fires on real time, so a poll cannot run
 * between two steps of a test. A test about a poll uses fake timers, which replace `setInterval` with one that fires as
 * the test moves the clock. Intervals set by tests and test tooling run as usual. Returns a function that undoes it.
 */
export function holdBackgroundIntervals(options: HoldOptions = {}): () => void {
  const exempt = patterns(options.exempt);
  return wrap('setInterval', (delay) => (setByApp(exempt) ? MAX_TIMER_MS : delay));
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
 * `TypeError` unless it is a RegExp or a list of them.
 */
export function installStress(options: StressOptions = {}): () => void {
  if (!(options.enabled ?? !OFF.includes((envVar('VITEST_FLAKY') ?? '').trim().toLowerCase()))) return () => {};
  const exempt = patterns(options.exempt);
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
  const restoreTimers = wrap('setTimeout', (delay) =>
    delay && delay > 0 && delay <= MAX_TIMER_MS && setByApp(exempt)
      ? Math.floor(delay * maxSlowdown ** -random())
      : delay,
  );
  return () => {
    restoreTimers();
    restoreWrapper();
  };
}
