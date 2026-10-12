import { describe, expect, it } from 'vitest';
import { main, vitestBin, type CliDeps } from '../src/cli';

function deps(statuses: number[], env: NodeJS.ProcessEnv = {}) {
  const runs: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const lines: string[] = [];
  const errors: string[] = [];
  const d: CliDeps = {
    run: (args, runEnv) => (runs.push({ args, env: runEnv }), { status: statuses.shift() ?? 0 }),
    log: (line) => lines.push(line),
    error: (line) => errors.push(line),
    env,
    random: () => 0.5,
  };
  return { d, runs, lines, errors };
}

describe('the command', () => {
  it('runs three shuffled rounds by default, each on its own seed in stress mode', () => {
    const { d, runs, lines } = deps([]);

    expect(main([], d)).toBe(0);

    expect(runs.map((run) => run.args)).toEqual([
      ['run', '--sequence.shuffle', '--sequence.seed=500001'],
      ['run', '--sequence.shuffle', '--sequence.seed=500002'],
      ['run', '--sequence.shuffle', '--sequence.seed=500003'],
    ]);
    expect(runs[1]!.env).toMatchObject({ VITEST_FLAKY: '1', VITEST_FLAKY_SEED: '500002' });
    expect(lines.at(-1)).toContain('3 rounds passed (seeds 500001–500003)');
  });

  it('says "1 round" for a single round', () => {
    const { d, lines } = deps([]);

    main(['1'], d);

    expect(lines.at(-1)).toBe('\n1 round passed (seed 500001)');
  });

  it('takes a round count and passes the rest to vitest', () => {
    const { d, runs } = deps([]);

    main(['2', 'test/inbox.test.tsx', '--bail=1'], d);

    expect(runs).toHaveLength(2);
    expect(runs[0]!.args.slice(3)).toEqual(['test/inbox.test.tsx', '--bail=1']);
  });

  it('passes a first argument that is not a number to vitest', () => {
    const { d, runs } = deps([]);

    main(['test/inbox.test.tsx'], d);

    expect(runs).toHaveLength(3);
    expect(runs[0]!.args.at(-1)).toBe('test/inbox.test.tsx');
  });

  it('starts from VITEST_FLAKY_SEED, and stops on a failure with the command that replays it', () => {
    const { d, runs, errors } = deps([0, 1], { VITEST_FLAKY_SEED: '41' });

    expect(main(['5'], d)).toBe(1);

    expect(runs).toHaveLength(2);
    expect(errors[0]).toContain('VITEST_FLAKY=1 VITEST_FLAKY_SEED=42 npx vitest run --sequence.shuffle --sequence.seed=42');
  });

  it('quotes the arguments it prints, so pasting the command runs the same tests', () => {
    const { d, errors } = deps([1]);

    main(['1', '-t', 'saves draft', "it's"], d);

    expect(errors[0]).toContain(`-t 'saves draft' 'it'\\''s'`);
  });

  it.each(['0', '-1', '1.5', 'abc'])('refuses a VITEST_FLAKY_SEED of %s', (seed) => {
    const { d, runs, errors } = deps([], { VITEST_FLAKY_SEED: seed });

    expect(main([], d)).toBe(2);

    expect(runs).toHaveLength(0);
    expect(errors[0]).toContain('VITEST_FLAKY_SEED');
  });

  it('refuses a seed of its own, since each round has one', () => {
    const { d, runs, errors } = deps([]);

    expect(main(['2', '--sequence.seed=5'], d)).toBe(2);

    expect(runs).toHaveLength(0);
    expect(errors[0]).toContain('--sequence.seed');
  });

  it('refuses seeds that would run past 32 bits', () => {
    const { d, runs } = deps([], { VITEST_FLAKY_SEED: '4294967295' });

    expect(main(['2'], d)).toBe(2);
    expect(runs).toHaveLength(0);
  });

  it('says the run was stopped, not that a seed failed, when vitest is killed', () => {
    const { d, errors } = deps([]);
    d.run = () => ({ status: null, signal: 'SIGINT' });

    expect(main(['1'], d)).toBe(1);

    expect(errors[0]).toContain('stopped by SIGINT');
    expect(errors[0]).not.toContain('Replay');
  });

  it('refuses a round count of 0 instead of passing without running anything', () => {
    const { d, runs, errors } = deps([]);

    expect(main(['0'], d)).toBe(2);

    expect(runs).toHaveLength(0);
    expect(errors[0]).toContain('at least 1');
  });

  it('says so when vitest could not be started, and names no seed', () => {
    const { d, errors } = deps([]);
    d.run = () => ({ status: null, error: new Error('spawn ENOENT') });

    expect(main(['1'], d)).toBe(1);

    expect(errors[0]).toContain('could not run vitest: spawn ENOENT');
    expect(errors[0]).not.toContain('seed');
  });

  it('fails with 1 when vitest could not run at all', () => {
    const { d } = deps([]);
    d.run = () => ({ status: null });

    expect(main(['1'], d)).toBe(1);
  });

  it("finds the project's own vitest", () => {
    expect(vitestBin(process.cwd())).toMatch(/node_modules[\\/]vitest[\\/]vitest\.mjs$/);
  });
});
