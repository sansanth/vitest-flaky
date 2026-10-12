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

// The longest delay a timer accepts (about 24 days): a held interval is set for it, so clearInterval still works.
const NEVER_MS = 2 ** 31 - 1;

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
const frames = (stack: unknown) => (typeof stack === 'string' ? stack.split('\n') : []).filter((line) => frameFile(line));
// Undefined if there was no stack to read at import, as when `Error.stackTraceLimit` is 0: then no caller is named.
const OWN_FILE = frameFile(String(frames(new Error().stack)[0]));

/**
 * The first frame of `stack` outside this file: whoever called the timer.
 * @internal
 */
export function callerOf(stack: unknown): string {
  return OWN_FILE ? (frames(stack).find((frame) => frameFile(frame) !== OWN_FILE) ?? '') : '';
}

// Matched without the project's own directory, so an app checked out under a folder named `test` is still the app.
// Both sides use forward slashes, which is how Windows paths come out of a stack as often as not. A timer whose caller
// cannot be read is left alone: shortening a test's own wait is worse than missing one of the app's.
const slashes = (path: string) => path.replaceAll('\\', '/');
function setByApp(exempt: RegExp): boolean {
  const caller = slashes(callerOf(new Error().stack));
  const root = slashes(proc()?.cwd() ?? '');
  return caller !== '' && !exempt.test(root.length > 1 ? caller.replace(root, '') : caller);
}

function wrap(name: keyof TimerScope, delayFor: (delay: number | undefined) => number | undefined): () => void {
  const restores = scopes().map((scope) => {
    const original = scope[name];
    // The original's own properties come along, such as the symbol `util.promisify` looks for on Node's timers.
    const wrapper = Object.assign(function (this: unknown, handler: TimerHandler, delay?: number, ...args: unknown[]) {
      return original.call(this, handler, delayFor(delay), ...args);
    }, original);
    scope[name] = wrapper;
    // Another wrapper installed since, such as fake timers, is not ours to remove.
    return () => void (scope[name] === wrapper && (scope[name] = original));
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
  exempt?: RegExp;
}

/**
 * Every interval the app sets is registered and cleared as usual but never fires on real time, so a poll cannot run
 * between two steps of a test. A test about a poll uses fake timers, which replace `setInterval` with one that fires as
 * the test moves the clock. Intervals set by tests and test tooling run as usual. Returns a function that undoes it.
 */
export function holdBackgroundIntervals(options: HoldOptions = {}): () => void {
  const exempt = options.exempt ?? DEFAULT_EXEMPT;
  return wrap('setInterval', (delay) => (setByApp(exempt) ? NEVER_MS : delay));
}

/** What `installStress` needs from Testing Library: pass `configure` and `getConfig` from the package your tests use. */
export interface TestingLibraryConfig {
  configure(config: { asyncWrapper: (callback: () => Promise<unknown>) => Promise<unknown> }): void;
  getConfig(): { asyncWrapper: (callback: () => Promise<unknown>) => Promise<unknown> };
}

export interface StressOptions {
  /** Default: on when the `VITEST_FLAKY` environment variable is set. */
  enabled?: boolean;
  /** Replays a run: the same seed gives the same delays. Default `VITEST_FLAKY_SEED`, or 1. */
  seed?: number;
  /** A timeout the app sets fires after between all of its delay and this fraction of it. Default 30. */
  maxSlowdown?: number;
  /** After every `findBy`/`waitFor` the test resumes up to this late. Needs `testingLibrary`. Default 100. */
  maxResumeDelayMs?: number;
  /** Without it, the late resume is left out. */
  testingLibrary?: TestingLibraryConfig;
  exempt?: RegExp;
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
 * Off unless `enabled` or `VITEST_FLAKY` says otherwise. Returns a function that undoes it.
 */
export function installStress(options: StressOptions = {}): () => void {
  if (!(options.enabled ?? !OFF.includes((envVar('VITEST_FLAKY') ?? '').trim().toLowerCase()))) return () => {};
  const exempt = options.exempt ?? DEFAULT_EXEMPT;
  const maxSlowdown = options.maxSlowdown ?? 30;
  if (!(maxSlowdown >= 1)) throw new RangeError('maxSlowdown must be 1 or more');
  const maxResumeDelayMs = options.maxResumeDelayMs ?? 100;
  // A fixed seed replays a failure: timers are set in the same order run to run, so the same delays come out. The late
  // resumes draw from a stream of their own: when a `waitFor` settles depends on the clock and would shift the rest.
  const seed = options.seed ?? Number(envVar('VITEST_FLAKY_SEED') ?? 1);
  if (!Number.isInteger(seed)) throw new RangeError('seed must be a whole number');
  const random = randomFrom(seed);
  const randomResume = randomFrom(seed ^ 0x9e3779b9);

  // Taken before the wrapping below, so the late resume is not itself shortened.
  const realSetTimeout = globalThis.setTimeout;
  let restoreWrapper = () => {};
  const library = options.testingLibrary;
  if (library) {
    const { asyncWrapper } = library.getConfig();
    library.configure({
      asyncWrapper: (callback) =>
        asyncWrapper(async () => {
          const result = await callback();
          await new Promise((resolve) => realSetTimeout(resolve, Math.floor(randomResume() * maxResumeDelayMs)));
          return result;
        }),
    });
    const ours = library.getConfig().asyncWrapper;
    restoreWrapper = () => {
      if (library.getConfig().asyncWrapper === ours) library.configure({ asyncWrapper });
    };
  }

  // Log-uniform, so a mild slowdown comes up as often as a severe one.
  const restoreTimers = wrap('setTimeout', (delay) =>
    delay && delay > 0 && setByApp(exempt) ? Math.floor(delay * maxSlowdown ** -random()) : delay,
  );
  return () => {
    restoreTimers();
    restoreWrapper();
  };
}
