#!/usr/bin/env node
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { constants, tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atLeast, fromEnv, MAX_TIMER_MS } from './limit.js';

export interface CliDeps {
  /** `toStderr` sends vitest's own output to stderr, so stdout holds only the `--json` summary. */
  run(
    args: string[],
    env: NodeJS.ProcessEnv,
    toStderr: boolean,
  ): Promise<{ status: number | null; error?: Error; signal?: string | null }>;
  /** The signal this process was sent, if any. */
  interrupted(): string | undefined;
  log(line: string): void;
  error(line: string): void;
  env: NodeJS.ProcessEnv;
  random(): number;
  /** Where vitest's JSON reporter writes a round's results. */
  reportPath(round: number): string;
  /** The parsed file at `path`, or undefined if vitest left none. Throws if there is one that cannot be read or parsed. */
  readReport(path: string): unknown;
}

interface Failure {
  /** Relative to the directory the command ran in, with forward slashes. */
  file: string;
  /** The tests of this file that failed. */
  tests: string[];
  /** An error of the file itself, in a hook or an import, when vitest gave one. */
  error?: string;
}

const quote = (arg: string) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`);

interface FileResult {
  name: string;
  status: string;
  message?: string;
  assertionResults?: { fullName: string; status: string }[];
}
interface JsonReport {
  testResults?: FileResult[];
}

// installStress keeps 32 bits of a seed, so seeds from here on would repeat earlier ones.
const SEED_LIMIT = 2 ** 32;

type Reason = 'no-report' | 'unreadable-report' | 'unrecognised-report' | 'no-failed-tests';

const posix = (path: string) => path.split(sep).join('/');
const relativeToCwd = (path: string) => {
  try {
    return posix(relative(process.cwd(), path));
  } catch {
    // The working directory was deleted during the run: the path as vitest gave it will do.
    return posix(path);
  }
};

const isFile = (file: FileResult | null): file is FileResult => typeof file?.name === 'string';

interface Outcome {
  failed: Failure[];
  /** Why `failed` is empty, when it is. */
  reason: Reason;
  /** What went wrong reading the report, if that is why. */
  error?: string;
}

/**
 * The failed files of the report `read` returns, or why there are none to give. What is not the shape vitest writes is
 * left out, a file that failed still listed with the tests that could be read; and if that leaves no failure, the report
 * is called unrecognised, as it may have held some.
 */
function explain(read: () => unknown): Outcome {
  let report: unknown;
  try {
    report = read();
  } catch (error) {
    return { failed: [], reason: 'unreadable-report', error: error instanceof Error ? error.message : String(error) };
  }
  if (report === undefined) return { failed: [], reason: 'no-report' };
  const files = (report as JsonReport | null)?.testResults;
  if (!Array.isArray(files)) return { failed: [], reason: 'unrecognised-report' };
  const named = files.filter(isFile);
  const failed = named.flatMap((file) => {
    const results = Array.isArray(file.assertionResults) ? file.assertionResults : [];
    const tests = results.filter((test) => test?.status === 'failed' && typeof test.fullName === 'string').map((test) => test.fullName);
    if (tests.length === 0 && file.status !== 'failed') return [];
    return [{ file: relativeToCwd(file.name), tests, ...(file.message && { error: file.message }) }];
  });
  return { failed, reason: named.length === files.length ? 'no-failed-tests' : 'unrecognised-report' };
}

// The exit code a shell reports for a process that a signal ended.
function signalCode(name: string): number {
  const number = constants.signals[name as NodeJS.Signals];
  return number ? 128 + number : 1;
}

// What `Number` reads as one, so the value after a space is the same as after an `=`.
const isNumber = (arg = '') => arg.trim() !== '' && Number.isFinite(Number(arg));
const OPTION = /^--(slowdown|max-resume)(?:=(.*))?$/s;

/**
 * `vitest-flaky [rounds] [options] [vitest arguments]`: runs the suite `rounds` times (3 by default) under
 * `installStress`, shuffled, with a new seed each round. A failure prints the command that replays it. Returns the exit
 * code.
 */
export async function main(argv: string[], deps: CliDeps): Promise<number> {
  const flags: Record<string, string> = {};
  const own: string[] = [];
  let rest: string[] = [];
  let count: number | undefined;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    // Everything from a `--` on is for vitest, which ignores it, and is not read as this command's options.
    if (arg === '--') {
      rest = argv.slice(i);
      break;
    }
    const option = OPTION.exec(arg);
    if (arg === '--json') json = true;
    // In `--slowdown 60` the next argument is the value only if it is a number, so a file filter is not taken for one.
    else if (option) flags[option[1]!] = option[2] ?? (isNumber(argv[i + 1]) ? argv[++i]! : '');
    else if (count === undefined && own.length === 0 && /^\d+$/.test(arg)) count = Number(arg);
    else own.push(arg);
  }
  const passThrough = [...own, ...rest];
  // No count past this can run, and a larger one would be Infinity, which JSON prints as null.
  const rounds = Math.min(count ?? 3, SEED_LIMIT);
  // What a refusal reports: the count as given, unless it is too large for a number.
  const asked = count !== undefined && Number.isFinite(count) ? count : rounds;

  const progress = json ? deps.error : deps.log;
  const results: {
    seed: number;
    exitCode: number | null;
    signal?: string;
    ok: boolean;
    failed: Failure[];
    unexplained?: true;
    reason?: Reason;
  }[] = [];
  const summary = (code: number, extra: object = {}) => {
    const seeds = results.map((r) => r.seed);
    if (json) deps.log(JSON.stringify({ ok: code === 0, rounds, seeds, results, ...extra }, null, 2));
    return code;
  };
  const refuse = (message: string) => {
    deps.error(message);
    return summary(2, { error: message, rounds: asked });
  };

  if (rounds < 1) return refuse('the number of rounds must be at least 1');
  if (count !== undefined && count >= SEED_LIMIT) return refuse(`the number of rounds must be below ${SEED_LIMIT}`);
  if (own.some((arg) => arg.startsWith('--sequence.seed'))) {
    return refuse('the command sets --sequence.seed itself, one seed per round');
  }
  // A bare --outputFile is the json reporter's too; one for another reporter (--outputFile.junit) is not in the way.
  const outputFile = /^--(?:outputFile|output-file)(?:=|\.json(?:=|$)|$)/;
  const taken = json ? own.find((arg) => outputFile.test(arg)) : undefined;
  if (taken) return refuse(`--json gives the json reporter an output file of its own: drop ${taken.split('=')[0]}`);
  const given = deps.env.VITEST_FLAKY_SEED?.trim();
  if (given && !(Number.isSafeInteger(Number(given)) && Number(given) >= 1)) {
    return refuse('VITEST_FLAKY_SEED must be a whole number from 1');
  }
  // From 1: seed 0 gives the same timer delays as seed 1 in installStress, which would make two rounds alike.
  const first = Number(given) || 1 + Math.floor(deps.random() * 1e6);
  // installStress keeps 32 bits of a seed, so seeds past that would repeat earlier ones.
  if (!(first + rounds - 1 < SEED_LIMIT)) {
    return refuse(`${rounds} rounds from seed ${first} would reach ${SEED_LIMIT}: use fewer rounds or a lower seed`);
  }
  // The flag wins over the variable, as a flag is for one run. A flag with no value is a mistake, not an absent flag; a
  // variable that is blank is absent, as it is to installStress.
  const setting = (name: string, variable: string, min: number, max?: number) => {
    const fromFlag = flags[name];
    if (fromFlag === undefined) return fromEnv(deps.env[variable], variable, min, max);
    return atLeast(fromFlag.trim() === '' ? NaN : Number(fromFlag), `--${name}`, min, max);
  };
  let slowdown: number | undefined;
  let maxResume: number | undefined;
  try {
    slowdown = setting('slowdown', 'VITEST_FLAKY_SLOWDOWN', 1);
    maxResume = setting('max-resume', 'VITEST_FLAKY_MAX_RESUME', 0, MAX_TIMER_MS);
  } catch (error) {
    return refuse((error as RangeError).message);
  }
  const tuning: Record<string, string> = {};
  if (slowdown !== undefined) tuning.VITEST_FLAKY_SLOWDOWN = String(slowdown);
  if (maxResume !== undefined) tuning.VITEST_FLAKY_MAX_RESUME = String(maxResume);

  // Under --json vitest also gets its json reporter, writing to a file of ours. `--reporter=json` alone would replace
  // the default reporter, so that stays unless the user chose reporters. These go ahead of the user's arguments, as
  // vitest ignores whatever follows a `--`.
  const named = own.flatMap((arg, i) =>
    arg === '--reporter' ? (own[i + 1] ?? '').split(',') : arg.startsWith('--reporter=') ? arg.slice(11).split(',') : [],
  );
  const reporters = [
    ...(own.some((arg) => arg.startsWith('--reporter')) ? [] : ['--reporter=default']),
    ...(named.includes('json') ? [] : ['--reporter=json']),
  ];

  for (let round = 0; round < rounds; round++) {
    const seed = first + round;
    const interrupted = deps.interrupted();
    if (interrupted) {
      const message = `stopped by ${interrupted} before round ${round + 1} of ${rounds}`;
      deps.error(`\n${message}`);
      return summary(signalCode(interrupted), { error: message });
    }
    const base = ['run', '--sequence.shuffle', `--sequence.seed=${seed}`];
    const args = [...base, ...passThrough];
    const report = json ? deps.reportPath(round + 1) : '';
    const runArgs = json ? [...base, ...reporters, `--outputFile.json=${report}`, ...passThrough] : args;
    progress(`\nround ${round + 1} of ${rounds}, seed ${seed}`);
    const env = { ...deps.env, ...tuning, VITEST_FLAKY: '1', VITEST_FLAKY_SEED: String(seed) };
    const result = await deps.run(runArgs, env, json);
    const code = result.status ?? (result.signal ? signalCode(result.signal) : 1);
    // A signal this command was sent ended the round, or made it fail some other way on the way down.
    const stopped = code !== 0 ? deps.interrupted() : undefined;
    const reported = json && code !== 0 && !result.error;
    const outcome = reported ? explain(() => deps.readReport(report)) : undefined;
    const failed = outcome?.failed ?? [];
    // A report that cannot be read is no better than none: `unexplained` says so, and this says why. A round that was
    // stopped may have left half a file, which is not worth a note on top of the one about the signal.
    if (outcome?.error && !stopped) deps.error(`could not read vitest's report: ${outcome.error}`);
    results.push({
      seed,
      exitCode: result.status,
      ...(result.signal && { signal: result.signal }),
      ok: code === 0,
      failed,
      // A round can fail with no failed test: an unhandled error, a coverage threshold, or a report that was not read.
      ...(outcome && !failed.length && !stopped && { unexplained: true, reason: outcome.reason }),
    });
    if (result.error) {
      const message = `could not run vitest: ${result.error.message}`;
      deps.error(`\n${message}`);
      return summary(1, { error: message });
    }
    if (stopped) {
      const message = `vitest was stopped by ${stopped} on seed ${seed}`;
      deps.error(`\n${message}`);
      return summary(signalCode(stopped), { error: message });
    }
    if (code !== 0) {
      const set = Object.entries(tuning).map(([name, value]) => `${name}=${value}`);
      const vars = ['VITEST_FLAKY=1', `VITEST_FLAKY_SEED=${seed}`, ...set].join(' ');
      const replay = `${vars} npx vitest ${args.map(quote).join(' ')}`;
      deps.error(`\nfailed on seed ${seed}. Replay it with:\n  ${replay}`);
      return summary(code, { replay });
    }
  }
  const seeds = rounds === 1 ? `seed ${first}` : `seeds ${first}–${first + rounds - 1}`;
  progress(`\n${rounds} ${rounds === 1 ? 'round' : 'rounds'} passed (${seeds})`);
  return summary(0);
}

/** The project's own vitest, run with this Node: no shell, so the same on every platform. */
export function vitestBin(cwd: string): string {
  const manifest = createRequire(join(cwd, 'package.json')).resolve('vitest/package.json');
  const { bin } = JSON.parse(readFileSync(manifest, 'utf8')) as { bin: { vitest: string } };
  return join(dirname(manifest), bin.vitest);
}

/* v8 ignore start -- the process entry point, exercised by `npm run smoke` */
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // A missing vitest is reported through main, so a --json run still gets its summary.
  let bin: string | Error;
  try {
    bin = vitestBin(process.cwd());
  } catch {
    bin = new Error(`it is not installed in ${process.cwd()}; install it in the project first`);
  }
  let child: ChildProcess | undefined;
  let received: string | undefined;
  // A signal sent to this process alone does not reach vitest, so it is passed on. A terminal's Ctrl-C reaches both,
  // and a second SIGINT would cut short the shutdown vitest began on the first, so SIGINT waits to see if vitest is
  // still up. The first signal decides the exit code.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => {
      received ??= signal;
      if (signal === 'SIGINT') setTimeout(() => child?.kill(signal), 3000).unref();
      else child?.kill(signal);
    });
  }
  // Made when the first report is asked for, so a run without --json leaves nothing behind.
  let dir: string | undefined;
  try {
    process.exitCode = await main(process.argv.slice(2), {
      run: (args, env, toStderr) =>
        new Promise((resolve) => {
          if (bin instanceof Error) return resolve({ status: null, error: bin });
          child = spawn(process.execPath, [bin, ...args], {
            stdio: ['inherit', toStderr ? 2 : 'inherit', 'inherit'],
            env,
          });
          child.on('error', (error) => resolve({ status: null, error }));
          child.on('close', (status, signal) => resolve({ status, signal }));
        }),
      interrupted: () => received,
      log: (line) => console.log(line),
      error: (line) => console.error(line),
      env: process.env,
      random: Math.random,
      reportPath: (round) => join((dir ??= mkdtempSync(join(tmpdir(), 'vitest-flaky-'))), `round-${round}.json`),
      readReport: (path) => {
        try {
          return JSON.parse(readFileSync(path, 'utf8'));
        } catch (error) {
          // No report at all is a round that died before writing one; anything else is worth saying.
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
          throw error;
        }
      },
    });
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}
/* v8 ignore stop */
