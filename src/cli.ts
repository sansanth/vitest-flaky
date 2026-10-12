#!/usr/bin/env node
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface CliDeps {
  run(args: string[], env: NodeJS.ProcessEnv): Pick<SpawnSyncReturns<Buffer>, 'status' | 'error'> & { signal?: string | null };
  log(line: string): void;
  error(line: string): void;
  env: NodeJS.ProcessEnv;
  random(): number;
}

const quote = (arg: string) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`);

/**
 * `vitest-flaky [rounds] [vitest arguments]`: runs the suite `rounds` times (3 by default) under `installStress`,
 * shuffled, with a new seed each round. A failure prints the command that replays it. Returns the exit code.
 */
export function main(argv: string[], deps: CliDeps): number {
  const rounds = /^\d+$/.test(argv[0] ?? '') ? Number(argv[0]) : 3;
  const passThrough = /^\d+$/.test(argv[0] ?? '') ? argv.slice(1) : argv;
  if (rounds < 1) {
    deps.error('the number of rounds must be at least 1');
    return 2;
  }
  if (passThrough.some((arg) => arg.startsWith('--sequence.seed'))) {
    deps.error('the command sets --sequence.seed itself, one seed per round');
    return 2;
  }
  // installStress keeps 32 bits of a seed, so seeds past that would repeat earlier ones.
  const given = deps.env.VITEST_FLAKY_SEED;
  if (given && !(Number.isSafeInteger(Number(given)) && Number(given) >= 1 && Number(given) + rounds - 1 < 2 ** 32)) {
    deps.error('VITEST_FLAKY_SEED must be a whole number from 1, and no round may reach 4294967296');
    return 2;
  }
  // From 1: seed 0 is the same as seed 1 to installStress, which would make two rounds identical.
  const first = Number(given) || 1 + Math.floor(deps.random() * 1e6);

  for (let round = 0; round < rounds; round++) {
    const seed = first + round;
    const args = ['run', '--sequence.shuffle', `--sequence.seed=${seed}`, ...passThrough];
    deps.log(`\nround ${round + 1} of ${rounds}, seed ${seed}`);
    const result = deps.run(args, { ...deps.env, VITEST_FLAKY: '1', VITEST_FLAKY_SEED: String(seed) });
    if (result.error) {
      deps.error(`\ncould not run vitest: ${result.error.message}`);
      return 1;
    }
    if (result.signal) {
      deps.error(`\nvitest was stopped by ${result.signal} on seed ${seed}`);
      return 1;
    }
    if (result.status !== 0) {
      const replay = `VITEST_FLAKY=1 VITEST_FLAKY_SEED=${seed} npx vitest ${args.map(quote).join(' ')}`;
      deps.error(`\nfailed on seed ${seed}. Replay it with:\n  ${replay}`);
      return result.status ?? 1;
    }
  }
  const seeds = rounds === 1 ? `seed ${first}` : `seeds ${first}–${first + rounds - 1}`;
  deps.log(`\n${rounds} ${rounds === 1 ? 'round' : 'rounds'} passed (${seeds})`);
  return 0;
}

/** The project's own vitest, run with this Node: no shell, so the same on every platform. */
export function vitestBin(cwd: string): string {
  const manifest = createRequire(join(cwd, 'package.json')).resolve('vitest/package.json');
  const { bin } = JSON.parse(readFileSync(manifest, 'utf8')) as { bin: { vitest: string } };
  return join(dirname(manifest), bin.vitest);
}

/* v8 ignore start -- the process entry point, exercised by `npm run smoke` */
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let bin = '';
  try {
    bin = vitestBin(process.cwd());
  } catch {
    console.error(`could not find vitest from ${process.cwd()}: install it in the project first`);
    process.exit(1);
  }
  process.exitCode = main(process.argv.slice(2), {
    run: (args, env) => spawnSync(process.execPath, [bin, ...args], { stdio: 'inherit', env }),
    log: (line) => console.log(line),
    error: (line) => console.error(line),
    env: process.env,
    random: Math.random,
  });
}
/* v8 ignore stop */
