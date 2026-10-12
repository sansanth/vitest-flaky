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
  /** The parsed file at `path`, or undefined if vitest left none. */
  readReport(path: string): unknown;
}

export interface Failure {
  /** Relative to the directory the command ran in, with forward slashes. */
  file: string;
  /** The tests of this file that failed. */
  tests: string[];
  /** An error of the file itself, in a hook or an import, when vitest gave one. */
  error?: string;
}

const quote = (arg: string) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`);

interface JsonReport {
  testResults?: {
    name: string;
    status: string;
    message?: string;
    assertionResults?: { fullName: string; status: string }[];
  }[];
}

function failures(report: unknown): Failure[] {
  return ((report as JsonReport | undefined)?.testResults ?? []).flatMap((file) => {
    const tests = (file.assertionResults ?? []).filter((test) => test.status === 'failed').map((test) => test.fullName);
    if (tests.length === 0 && file.status !== 'failed') return [];
    const path = relative(process.cwd(), file.name).split(sep).join('/');
    return [{ file: path, tests, ...(file.message && { error: file.message }) }];
  });
}

// The exit code a shell reports for a process that a signal ended.
function signalCode(name: string): number {
  const number = constants.signals[name as NodeJS.Signals];
  return number ? 128 + number : 1;
}

const OPTION = /^--(slowdown|max-resume)(?:=(.*))?$/s;

/**
 * `vitest-flaky [rounds] [options] [vitest arguments]`: runs the suite `rounds` times (3 by default) under
 * `installStress`, shuffled, with a new seed each round. A failure prints the command that replays it. Returns the exit
 * code.
 */
export async function main(argv: string[], deps: CliDeps): Promise<number> {
  const flags: Record<string, string> = {};
  const passThrough: string[] = [];
  let count: number | undefined;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const option = OPTION.exec(arg);
    if (arg === '--json') json = true;
    // In `--slowdown 60` the next argument is the value only if it is a number, so a file filter is not taken for one.
    else if (option) flags[option[1]!] = option[2] ?? (/^\d+(?:\.\d+)?$/.test(argv[i + 1] ?? '') ? argv[++i]! : '');
    else if (count === undefined && passThrough.length === 0 && /^\d+$/.test(arg)) count = Number(arg);
    else passThrough.push(arg);
  }
  const rounds = count ?? 3;

  const progress = json ? deps.error : deps.log;
  const results: { seed: number; exitCode: number | null; signal?: string; ok: boolean; failed: Failure[] }[] = [];
  const summary = (code: number, extra: object = {}) => {
    const seeds = results.map((r) => r.seed);
    if (json) deps.log(JSON.stringify({ ok: code === 0, rounds, seeds, results, ...extra }, null, 2));
    return code;
  };
  const refuse = (message: string) => {
    deps.error(message);
    return summary(2, { error: message });
  };

  if (rounds < 1) return refuse('the number of rounds must be at least 1');
  if (passThrough.some((arg) => arg.startsWith('--sequence.seed'))) {
    return refuse('the command sets --sequence.seed itself, one seed per round');
  }
  // A bare --outputFile is the json reporter's too; one for another reporter (--outputFile.junit) is not in the way.
  if (json && passThrough.some((arg) => /^--outputFile(?:=|\.json\b|$)/.test(arg))) {
    return refuse('--json gives the json reporter an output file of its own: drop --outputFile and --outputFile.json');
  }
  const given = deps.env.VITEST_FLAKY_SEED;
  if (given && !(Number.isSafeInteger(Number(given)) && Number(given) >= 1)) {
    return refuse('VITEST_FLAKY_SEED must be a whole number from 1');
  }
  // From 1: seed 0 is the same as seed 1 to installStress, which would make two rounds identical.
  const first = Number(given) || 1 + Math.floor(deps.random() * 1e6);
  // installStress keeps 32 bits of a seed, so seeds past that would repeat earlier ones.
  if (!(first + rounds - 1 < 2 ** 32)) {
    return refuse(`${rounds} rounds from seed ${first} would reach 4294967296: use fewer rounds or a lower seed`);
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
  const named = passThrough.flatMap((arg, i) =>
    arg === '--reporter' ? [passThrough[i + 1]] : arg.startsWith('--reporter=') ? arg.slice(11).split(',') : [],
  );
  const reporters = [
    ...(passThrough.some((arg) => arg.startsWith('--reporter')) ? [] : ['--reporter=default']),
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
    results.push({
      seed,
      exitCode: result.status,
      ...(result.signal && { signal: result.signal }),
      ok: code === 0,
      failed: json && code !== 0 ? failures(deps.readReport(report)) : [],
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
  // still up.
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
        } catch {
          return undefined;
        }
      },
    });
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}
/* v8 ignore stop */
