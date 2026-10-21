import { describe, expect, it, vi } from 'vitest';
import { main, vitestBin, type CliDeps } from '../src/cli';

function deps(statuses: number[], env: NodeJS.ProcessEnv = {}, reports: Record<string, unknown> = {}, signal?: string, after = 0) {
  const runs: { args: string[]; env: NodeJS.ProcessEnv; toStderr: boolean }[] = [];
  const lines: string[] = [];
  const errors: string[] = [];
  const d: CliDeps = {
    run: async (args, runEnv, toStderr) => (runs.push({ args, env: runEnv, toStderr }), { status: statuses.shift() ?? 0 }),
    interrupted: () => (runs.length >= after ? signal : undefined),
    log: (line) => lines.push(line),
    error: (line) => errors.push(line),
    env,
    random: () => 0.5,
    reportPath: (round) => `/tmp/round-${round}.json`,
    readReport: (path) => reports[path],
  };
  return { d, runs, lines, errors };
}

describe('the command', () => {
  it('runs three shuffled rounds by default, each on its own seed in stress mode', async () => {
    const { d, runs, lines } = deps([]);

    expect(await main([], d)).toBe(0);

    expect(runs.map((run) => run.args)).toEqual([
      ['run', '--sequence.shuffle', '--sequence.seed=500001'],
      ['run', '--sequence.shuffle', '--sequence.seed=500002'],
      ['run', '--sequence.shuffle', '--sequence.seed=500003'],
    ]);
    expect(runs[1]!.env).toMatchObject({ VITEST_FLAKY: '1', VITEST_FLAKY_SEED: '500002' });
    expect(lines.at(-1)).toContain('3 rounds passed (seeds 500001–500003)');
  });

  it('prints each round and its seed before it runs, and the seeds that passed at the end', async () => {
    const { d, lines } = deps([], { VITEST_FLAKY_SEED: '10' });

    await main(['2'], d);

    expect(lines).toEqual(['\nround 1 of 2, seed 10', '\nround 2 of 2, seed 11', '\n2 rounds passed (seeds 10–11)']);
  });

  it('says "1 round" for a single round', async () => {
    const { d, lines } = deps([]);

    await main(['1'], d);

    expect(lines.at(-1)).toBe('\n1 round passed (seed 500001)');
  });

  it('takes a round count and passes the rest to vitest', async () => {
    const { d, runs } = deps([]);

    await main(['2', 'test/inbox.test.tsx', '--bail=1'], d);

    expect(runs).toHaveLength(2);
    expect(runs[0]!.args.slice(3)).toEqual(['test/inbox.test.tsx', '--bail=1']);
  });

  it('passes a first argument that is not a number to vitest', async () => {
    const { d, runs } = deps([]);

    await main(['test/inbox.test.tsx'], d);

    expect(runs).toHaveLength(3);
    expect(runs[0]!.args.at(-1)).toBe('test/inbox.test.tsx');
  });

  it('starts from VITEST_FLAKY_SEED, and stops on a failure with the command that replays it', async () => {
    const { d, runs, errors } = deps([0, 1], { VITEST_FLAKY_SEED: '41' });

    expect(await main(['5'], d)).toBe(1);

    expect(runs).toHaveLength(2);
    expect(errors[0]).toContain('VITEST_FLAKY=1 VITEST_FLAKY_SEED=42 npx vitest run --sequence.shuffle --sequence.seed=42');
  });

  it('quotes the arguments it prints, so pasting the command runs the same tests', async () => {
    const { d, errors } = deps([1]);

    await main(['1', '-t', 'saves draft', "it's"], d);

    expect(errors[0]).toContain(`-t 'saves draft' 'it'\\''s'`);
  });

  it('takes a blank VITEST_FLAKY_SEED as absent', async () => {
    const { d, runs } = deps([], { VITEST_FLAKY_SEED: ' ' });

    expect(await main(['1'], d)).toBe(0);
    expect(runs[0]!.env.VITEST_FLAKY_SEED).toBe('500001');
  });

  it.each(['0', '-1', '1.5', 'abc'])('refuses a VITEST_FLAKY_SEED of %s', async (seed) => {
    const { d, runs, errors } = deps([], { VITEST_FLAKY_SEED: seed });

    expect(await main([], d)).toBe(2);

    expect(runs).toHaveLength(0);
    expect(errors[0]).toContain('VITEST_FLAKY_SEED');
  });

  it('refuses a seed of its own, since each round has one', async () => {
    const { d, runs, errors } = deps([]);

    expect(await main(['2', '--sequence.seed=5'], d)).toBe(2);

    expect(runs).toHaveLength(0);
    expect(errors[0]).toContain('--sequence.seed');
  });

  it('runs from the largest seed for one round', async () => {
    const { d, runs } = deps([], { VITEST_FLAKY_SEED: '4294967295' });

    expect(await main(['1'], d)).toBe(0);
    expect(runs[0]!.env.VITEST_FLAKY_SEED).toBe('4294967295');
  });

  it('refuses seeds that would run past 32 bits, from a given seed or a random one', async () => {
    const given = deps([], { VITEST_FLAKY_SEED: '4294967295' });
    expect(await main(['2'], given.d)).toBe(2);
    expect(given.runs).toHaveLength(0);

    const random = deps([]);
    expect(await main(['99999999999'], random.d)).toBe(2);
    expect(await main(['9'.repeat(400)], random.d)).toBe(2);
    expect(random.runs).toHaveLength(0);
    expect(random.errors[0]).toContain('4294967296');
  });

  it('says the run was stopped, not that a seed failed, when vitest is killed by the signal this command was sent', async () => {
    const { d, errors, runs } = deps([], {}, {}, 'SIGINT', 1);
    d.run = async () => (runs.push({ args: [], env: {}, toStderr: false }), { status: null, signal: 'SIGINT' });

    expect(await main(['2'], d)).toBe(130);

    expect(errors[0]).toContain('vitest was stopped by SIGINT on seed');
    expect(errors[0]).not.toContain('Replay');
  });

  it('reports a vitest that was killed on its own, as by the out-of-memory killer, as a failed seed', async () => {
    const { d, errors } = deps([]);
    d.run = async () => ({ status: null, signal: 'SIGKILL' });

    expect(await main(['2'], d)).toBe(137);

    expect(errors[0]).toContain('failed on seed 500001. Replay it with');
  });

  it('refuses a round count of 0 instead of passing without running anything', async () => {
    const { d, runs, errors } = deps([]);

    expect(await main(['0'], d)).toBe(2);

    expect(runs).toHaveLength(0);
    expect(errors[0]).toContain('at least 1');
  });

  it('says so when vitest could not be started, and names no seed', async () => {
    const { d, errors } = deps([]);
    d.run = async () => ({ status: null, error: new Error('spawn ENOENT') });

    expect(await main(['1'], d)).toBe(1);

    expect(errors[0]).toContain('could not run vitest: spawn ENOENT');
    expect(errors[0]).not.toContain('seed');
  });

  it('fails with 1 when vitest could not run at all', async () => {
    const { d } = deps([]);
    d.run = async () => ({ status: null });

    expect(await main(['1'], d)).toBe(1);
  });
});

describe('the round count', () => {
  it('can follow the options', async () => {
    const { d, runs } = deps([]);

    await main(['--json', '--slowdown=60', '--max-resume', '5', '4', 'test/a.test.ts'], d);

    expect(runs).toHaveLength(4);
    expect(runs[0]!.args).toContain('test/a.test.ts');
    expect(runs[0]!.args).not.toContain('4');
  });

  it('is the first number only, and only before an argument for vitest', async () => {
    const later = deps([]);
    await main(['test/a.test.ts', '5'], later.d);
    expect(later.runs).toHaveLength(3);
    expect(later.runs[0]!.args.slice(3)).toEqual(['test/a.test.ts', '5']);

    const second = deps([]);
    await main(['2', '5'], second.d);
    expect(second.runs).toHaveLength(2);
    expect(second.runs[0]!.args.slice(3)).toEqual(['5']);
  });
});

describe('the options', () => {
  it('after a -- are for vitest', async () => {
    const { d, runs } = deps([]);

    await main(['2', '--', '--slowdown=5', '--json', '7'], d);

    expect(runs).toHaveLength(2);
    expect(runs[0]!.args.slice(3)).toEqual(['--', '--slowdown=5', '--json', '7']);
    expect(runs[0]!.env.VITEST_FLAKY_SLOWDOWN).toBeUndefined();
    expect(runs[0]!.toStderr).toBe(false);
  });

  it('take a value after a space that Number reads, as after an =', async () => {
    const hex = deps([]);
    await main(['1', '--slowdown', '0x10'], hex.d);
    expect(hex.runs[0]!.env.VITEST_FLAKY_SLOWDOWN).toBe('16');

    const signed = deps([]);
    await main(['1', '--slowdown', '+5'], signed.d);
    expect(signed.runs[0]!.env.VITEST_FLAKY_SLOWDOWN).toBe('5');
  });

  it('take an exponent in the next argument as well as after an =', async () => {
    const { d, runs } = deps([]);

    await main(['1', '--slowdown', '1e3'], d);

    expect(runs[0]!.env.VITEST_FLAKY_SLOWDOWN).toBe('1000');

    const signed = deps([]);
    await main(['1', '--max-resume', '1e+2'], signed.d);
    expect(signed.runs[0]!.env.VITEST_FLAKY_MAX_RESUME).toBe('100');
  });

  it('refuse a bare flag at the end, not fall back to the variable', async () => {
    const { d, runs } = deps([], { VITEST_FLAKY_SLOWDOWN: '9' });

    expect(await main(['1', '--slowdown'], d)).toBe(2);
    expect(runs).toHaveLength(0);
  });
});

describe('a signal to the command', () => {
  it('stops the run before the next round, with the signal\'s exit code', async () => {
    const { d, runs, errors, lines } = deps([], { VITEST_FLAKY_SEED: '9' }, {}, 'SIGTERM', 1);

    expect(await main(['3', '--json'], d)).toBe(143);

    expect(runs).toHaveLength(1);
    expect(errors.at(-1)).toBe('\nstopped by SIGTERM before round 2 of 3');
    expect(JSON.parse(lines[0]!)).toMatchObject({ ok: false, seeds: [9], error: 'stopped by SIGTERM before round 2 of 3' });
  });

  it('stops the run that has not started a round', async () => {
    const { d, runs } = deps([], {}, {}, 'SIGINT');

    expect(await main(['3'], d)).toBe(130);
    expect(runs).toHaveLength(0);
  });

  it('leaves the result of the last round as it is, since nothing is left to stop', async () => {
    const passed = deps([], {}, {}, 'SIGINT', 1);
    expect(await main(['1'], passed.d)).toBe(0);
    expect(passed.runs).toHaveLength(1);
  });

  it('is what ended a round that failed after it, whatever code vitest gave', async () => {
    const { d, errors } = deps([1], {}, {}, 'SIGHUP', 1);

    expect(await main(['2'], d)).toBe(129);

    expect(errors).toEqual(['\nvitest was stopped by SIGHUP on seed 500001']);
  });
});

describe('a round that exits with 130 or 143', () => {
  it.each([[130, 'SIGINT'], [143, 'SIGTERM']])('is stopped when the command was sent the signal (%i)', async (status, signal) => {
    const { d, errors } = deps([status], {}, {}, signal, 1);

    expect(await main(['3'], d)).toBe(status);

    expect(errors).toEqual([`\nvitest was stopped by ${signal} on seed 500001`]);
  });

  it.each([130, 143])('is a failed seed when the command was sent nothing, as a test that calls process.exit(%i)', async (status) => {
    const { d, errors } = deps([status]);

    expect(await main(['3'], d)).toBe(status);

    expect(errors[0]).toContain('failed on seed 500001. Replay it with');
  });
});

describe('--slowdown and --max-resume', () => {
  it('set the harshness of every round, and are not passed on to vitest', async () => {
    const { d, runs } = deps([]);

    await main(['2', '--slowdown=60', 'test/a.test.ts', '--max-resume=250'], d);

    expect(runs.map((run) => run.args.slice(3))).toEqual([['test/a.test.ts'], ['test/a.test.ts']]);
    expect(runs[1]!.env).toMatchObject({ VITEST_FLAKY_SLOWDOWN: '60', VITEST_FLAKY_MAX_RESUME: '250' });
  });

  it('leave the settings alone when not given', async () => {
    const { d, runs } = deps([]);

    await main(['1'], d);

    expect(runs[0]!.env).not.toHaveProperty('VITEST_FLAKY_SLOWDOWN');
    expect(runs[0]!.env).not.toHaveProperty('VITEST_FLAKY_MAX_RESUME');
  });

  it.each(['', '  '])('are not set by a variable that is %j, as installStress reads it', async (blank) => {
    const { d, runs } = deps([], { VITEST_FLAKY_SLOWDOWN: blank, VITEST_FLAKY_MAX_RESUME: blank });

    expect(await main(['1'], d)).toBe(0);

    expect(runs[0]!.env.VITEST_FLAKY_SLOWDOWN).toBe(blank);
    expect(runs[0]!.args).toHaveLength(3);
  });

  it('can come from the environment, and a flag wins over it', async () => {
    const { d, runs } = deps([], { VITEST_FLAKY_SLOWDOWN: '10', VITEST_FLAKY_MAX_RESUME: '5' });

    await main(['1', '--slowdown=60'], d);

    expect(runs[0]!.env).toMatchObject({ VITEST_FLAKY_SLOWDOWN: '60', VITEST_FLAKY_MAX_RESUME: '5' });
  });

  it('are part of the command that replays a failure', async () => {
    const { d, errors } = deps([1]);

    await main(['1', '--slowdown=60', '--max-resume=0'], d);

    expect(errors[0]).toContain('VITEST_FLAKY=1 VITEST_FLAKY_SEED=500001 VITEST_FLAKY_SLOWDOWN=60 VITEST_FLAKY_MAX_RESUME=0 npx vitest run');
  });

  it.each([
    [['--slowdown=0.5'], '--slowdown'],
    [['--slowdown='], '--slowdown'],
    [['--slowdown=fast'], '--slowdown'],
    [['--slowdown'], '--slowdown'],
    [['--max-resume=-1'], '--max-resume'],
    [['--max-resume='], '--max-resume'],
    [['--max-resume=Infinity'], '--max-resume'],
    [['--slowdown', '9'.repeat(400)], '--slowdown'],
    [['--slowdown', '--json', '5'], '--slowdown'],
    [['--max-resume=2147483648'], '--max-resume'],
    [['--slowdown', '2fa.test.ts'], '--slowdown'],
  ])('refuse %j', async (argv, named) => {
    const { d, runs, errors } = deps([]);

    expect(await main(['1', ...argv], d)).toBe(2);

    expect(runs).toHaveLength(0);
    expect(errors[0]).toContain(named);
  });

  it('read the same numbers installStress does', async () => {
    const { d, runs } = deps([]);

    await main(['1', '--slowdown=0x10', '--max-resume=1e3'], d);

    expect(runs[0]!.env).toMatchObject({ VITEST_FLAKY_SLOWDOWN: '16', VITEST_FLAKY_MAX_RESUME: '1000' });
  });

  it('take the longest delay a timer allows, and no more', async () => {
    const { d, runs } = deps([]);

    await main(['1', '--max-resume=2147483647'], d);

    expect(runs[0]!.env.VITEST_FLAKY_MAX_RESUME).toBe('2147483647');
  });

  it('do not take the next flag for a value, and still see it', async () => {
    const { d, runs, lines } = deps([]);

    expect(await main(['--slowdown', '--json', '5'], d)).toBe(2);

    expect(runs).toHaveLength(0);
    expect(JSON.parse(lines[0]!).error).toContain('--slowdown');
  });

  it('refuse a flag with no value even when the variable has one, instead of falling back to it', async () => {
    const { d, runs } = deps([], { VITEST_FLAKY_SLOWDOWN: '60' });

    expect(await main(['1', '--slowdown='], d)).toBe(2);
    expect(runs).toHaveLength(0);
  });

  it('take the value as the next argument too', async () => {
    const { d, runs } = deps([]);

    await main(['1', '--slowdown', '60', '--max-resume', '250', 'test/a.test.ts'], d);

    expect(runs[0]!.args.slice(3)).toEqual(['test/a.test.ts']);
    expect(runs[0]!.env).toMatchObject({ VITEST_FLAKY_SLOWDOWN: '60', VITEST_FLAKY_MAX_RESUME: '250' });
  });

  it('name the variable when a bad value came from the environment', async () => {
    const { d, runs, errors } = deps([], { VITEST_FLAKY_MAX_RESUME: 'late' });

    expect(await main(['1'], d)).toBe(2);

    expect(runs).toHaveLength(0);
    expect(errors[0]).toContain('VITEST_FLAKY_MAX_RESUME');
  });
});

describe('--json', () => {
  const report = {
    testResults: [
      {
        name: `${process.cwd()}/test/inbox.test.tsx`,
        status: 'failed',
        assertionResults: [
          { fullName: 'inbox saves a draft', status: 'failed' },
          { fullName: 'inbox lists mail', status: 'passed' },
        ],
      },
      { name: `${process.cwd()}/test/broken.test.tsx`, status: 'failed', message: 'Cannot find module', assertionResults: [] },
      {
        name: `${process.cwd()}/test/teardown.test.tsx`,
        status: 'failed',
        message: 'afterAll threw',
        assertionResults: [{ fullName: 'teardown fails', status: 'failed' }],
      },
      { name: `${process.cwd()}/test/silent.test.tsx`, status: 'failed', message: '', assertionResults: [] },
      { name: `${process.cwd()}/test/fine.test.tsx`, status: 'passed', assertionResults: [{ fullName: 'fine', status: 'passed' }] },
    ],
  };

  it('prints only the summary to stdout, with the progress and the failure on stderr', async () => {
    const { d, runs, lines, errors } = deps([0, 1], { VITEST_FLAKY_SEED: '7' }, { '/tmp/round-2.json': report });

    expect(await main(['3', '--json'], d)).toBe(1);

    expect(runs.every((run) => run.toStderr)).toBe(true);
    expect(errors[0]).toBe('\nround 1 of 3, seed 7');
    expect(errors.at(-1)).toContain('failed on seed 8');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      ok: false,
      rounds: 3,
      seeds: [7, 8],
      results: [
        { seed: 7, exitCode: 0, ok: true, failed: [] },
        {
          seed: 8,
          exitCode: 1,
          ok: false,
          failed: [
            { file: 'test/inbox.test.tsx', tests: ['inbox saves a draft'] },
            { file: 'test/broken.test.tsx', tests: [], error: 'Cannot find module' },
            { file: 'test/teardown.test.tsx', tests: ['teardown fails'], error: 'afterAll threw' },
            { file: 'test/silent.test.tsx', tests: [] },
          ],
        },
      ],
      replay: 'VITEST_FLAKY=1 VITEST_FLAKY_SEED=8 npx vitest run --sequence.shuffle --sequence.seed=8',
    });
  });

  it('asks vitest for the report, keeping its default reporter, and leaves it out of the replay command', async () => {
    const { d, runs, errors } = deps([1]);

    await main(['1', '--json', 'test/a.test.ts'], d);

    expect(runs[0]!.args).toEqual([
      'run', '--sequence.shuffle', '--sequence.seed=500001',
      '--reporter=default', '--reporter=json', '--outputFile.json=/tmp/round-1.json',
      'test/a.test.ts',
    ]);
    expect(errors[0]).not.toContain('json');
  });

  it('marks a failed round as unexplained when the report has no list of files', async () => {
    const { d, lines } = deps([1], {}, { '/tmp/round-1.json': { testResults: {} } });

    expect(await main(['1', '--json'], d)).toBe(1);
    expect(JSON.parse(lines[0]!).results[0]).toMatchObject({ unexplained: true, reason: 'unrecognised-report' });
  });

  it('marks a failed round as unexplained when the report lists no failure, and not one that names a test', async () => {
    const quiet = deps([1], {}, { '/tmp/round-1.json': { testResults: [{ name: 'a.test.ts', status: 'passed' }] } });
    expect(await main(['1', '--json'], quiet.d)).toBe(1);
    expect(JSON.parse(quiet.lines[0]!).results[0]).toMatchObject({ failed: [], unexplained: true, reason: 'no-failed-tests' });

    const named = deps([1], {}, { '/tmp/round-1.json': { testResults: [{ name: 'a.test.ts', status: 'failed' }] } });
    await main(['1', '--json'], named.d);
    expect(JSON.parse(named.lines[0]!).results[0].unexplained).toBeUndefined();
  });

  it('says in `reason` when the report could not be read, and on stderr why', async () => {
    const { d, lines, errors } = deps([1]);
    d.readReport = () => {
      throw new Error('EACCES: permission denied');
    };

    expect(await main(['1', '--json'], d)).toBe(1);

    expect(JSON.parse(lines[0]!).results[0]).toMatchObject({ unexplained: true, reason: 'unreadable-report' });
    expect(errors).toContain("could not read vitest's report: EACCES: permission denied");
  });

  it('calls a report with a file that has no name unrecognised, not unreadable, and not empty', async () => {
    const { d, lines, errors } = deps([1], {}, { '/tmp/round-1.json': { testResults: [null, { status: 'failed' }] } });

    expect(await main(['1', '--json'], d)).toBe(1);

    expect(JSON.parse(lines[0]!).results[0]).toMatchObject({ failed: [], reason: 'unrecognised-report' });
    expect(errors.join('\n')).not.toContain('could not read');
  });

  it('lists a failed file even when one of its tests is malformed, and drops a nameless one', async () => {
    const { d, lines } = deps([1], {}, {
      '/tmp/round-1.json': {
        testResults: [
          { name: `${process.cwd()}/a.test.ts`, status: 'failed', assertionResults: [{ fullName: 'a', status: 'failed' }] },
          { name: 'b.test.ts', status: 'failed', assertionResults: [{ status: 'failed' }, null] },
          { name: 'c.test.ts', status: 'failed', assertionResults: 7 },
          null,
        ],
      },
    });

    expect(await main(['1', '--json'], d)).toBe(1);

    const [round] = JSON.parse(lines[0]!).results;
    expect(round.failed).toEqual([
      { file: 'a.test.ts', tests: ['a'] },
      { file: 'b.test.ts', tests: [] },
      { file: 'c.test.ts', tests: [] },
    ]);
    expect(round.unexplained).toBeUndefined();
  });

  it('still names the files of a report when the working directory is gone', async () => {
    const { d, lines } = deps([1], {}, {
      '/tmp/round-1.json': { testResults: [{ name: '/x/a.test.ts', status: 'failed' }] },
    });
    vi.spyOn(process, 'cwd').mockImplementation(() => {
      throw new Error('ENOENT: uv_cwd');
    });

    expect(await main(['1', '--json'], d)).toBe(1);

    const [round] = JSON.parse(lines[0]!).results;
    expect(round.failed).toEqual([{ file: '/x/a.test.ts', tests: [] }]);
    expect(round.reason).toBeUndefined();
    vi.restoreAllMocks();
  });

  it('keeps quiet about a half-written report when the round was stopped by a signal', async () => {
    const { d, errors } = deps([1], {}, {}, 'SIGINT');
    d.readReport = () => {
      throw new SyntaxError('Unexpected end of JSON input');
    };

    expect(await main(['1', '--json'], d)).toBe(130);

    expect(errors.join('\n')).not.toContain('could not read');
    expect(errors.join('\n')).toContain('stopped by SIGINT');
  });

  it('leaves an option that only starts like --outputFile.json alone', async () => {
    const { d, runs } = deps([]);

    expect(await main(['1', '--json', '--outputFile.json-x=1'], d)).toBe(0);
    expect(runs[0]!.args).toContain('--outputFile.json-x=1');
  });

  it('marks a round killed by a signal as unexplained', async () => {
    const { d, lines } = deps([]);
    d.run = async () => ({ status: null, signal: 'SIGKILL' });

    expect(await main(['1', '--json'], d)).toBe(137);

    expect(JSON.parse(lines[0]!).results[0]).toEqual({
      seed: 500001, exitCode: null, signal: 'SIGKILL', ok: false, failed: [], unexplained: true, reason: 'no-report',
    });
  });

  it('leaves what follows a -- alone', async () => {
    const { d, runs } = deps([]);

    expect(await main(['2', '--json', '--', '--reporter=json', '--outputFile=x', '--sequence.seed=3'], d)).toBe(0);

    expect(runs).toHaveLength(2);
    expect(runs[0]!.args).toEqual([
      'run', '--sequence.shuffle', '--sequence.seed=500001',
      '--reporter=default', '--reporter=json', '--outputFile.json=/tmp/round-1.json',
      '--', '--reporter=json', '--outputFile=x', '--sequence.seed=3',
    ]);
  });

  it("does not add the default reporter when the user chose their own", async () => {
    const { d, runs } = deps([]);

    await main(['1', '--json', '--reporter=verbose'], d);

    expect(runs[0]!.args.filter((arg) => arg.startsWith('--reporter'))).toEqual(['--reporter=json', '--reporter=verbose']);
  });

  it('reports a pass, and a failure with no report to read as having no tests named and a missing report', async () => {
    const passed = deps([], { VITEST_FLAKY_SEED: '5' });
    expect(await main(['2', '--json'], passed.d)).toBe(0);
    expect(JSON.parse(passed.lines[0]!)).toEqual({
      ok: true,
      rounds: 2,
      seeds: [5, 6],
      results: [
        { seed: 5, exitCode: 0, ok: true, failed: [] },
        { seed: 6, exitCode: 0, ok: true, failed: [] },
      ],
    });
    expect(passed.errors.at(-1)).toContain('2 rounds passed (seeds 5–6)');

    const failed = deps([2]);
    expect(await main(['1', '--json'], failed.d)).toBe(2);
    expect(JSON.parse(failed.lines[0]!).results).toEqual([{ seed: 500001, exitCode: 2, ok: false, failed: [], unexplained: true, reason: 'no-report' }]);
  });

  it('says why when vitest could not run or was stopped, and lists the round it happened in', async () => {
    const { d, lines, runs } = deps([], {}, {}, 'SIGINT', 1);
    d.run = async () => (runs.push({ args: [], env: {}, toStderr: false }), { status: null, signal: 'SIGINT' });

    expect(await main(['2', '--json'], d)).toBe(130);

    expect(JSON.parse(lines[0]!)).toEqual({
      ok: false,
      rounds: 2,
      seeds: [500001],
      results: [{ seed: 500001, exitCode: null, signal: 'SIGINT', ok: false, failed: [] }],
      error: 'vitest was stopped by SIGINT on seed 500001',
    });

    const unstarted = deps([]);
    unstarted.d.run = async () => ({ status: null, error: new Error('spawn ENOENT') });
    await main(['1', '--json'], unstarted.d);
    expect(JSON.parse(unstarted.lines[0]!)).toEqual({
      ok: false,
      rounds: 1,
      seeds: [500001],
      results: [{ seed: 500001, exitCode: null, ok: false, failed: [] }],
      error: 'could not run vitest: spawn ENOENT',
    });
  });

  it('puts the reporter flags ahead of the arguments for vitest, so a -- among them cannot hide them', async () => {
    const { d, runs } = deps([]);

    await main(['1', '--json', '--', 'test/foo.test.ts'], d);

    expect(runs[0]!.args).toEqual([
      'run', '--sequence.shuffle', '--sequence.seed=500001',
      '--reporter=default', '--reporter=json', '--outputFile.json=/tmp/round-1.json',
      '--', 'test/foo.test.ts',
    ]);
  });

  it('does not add a json reporter the user asked for, spelled with an = or a space', async () => {
    const equals = deps([]);
    await main(['1', '--json', '--reporter=json'], equals.d);
    expect(equals.runs[0]!.args.filter((arg) => arg.startsWith('--reporter'))).toEqual(['--reporter=json']);

    const spaced = deps([]);
    await main(['1', '--json', '--reporter', 'json', '--reporter', 'verbose'], spaced.d);
    expect(spaced.runs[0]!.args.filter((arg) => arg.startsWith('--reporter'))).toEqual(['--reporter', '--reporter']);
  });

  it('knows a json reporter named in a comma list, spelled with an = or a space', async () => {
    for (const reporter of [['--reporter=verbose,json'], ['--reporter', 'json,verbose']]) {
      const { d, runs } = deps([]);
      await main(['1', '--json', ...reporter], d);
      expect(runs[0]!.args.filter((arg) => arg === '--reporter=json')).toEqual([]);
    }
  });

  it('leaves --outputFile for another reporter alone, as that is how a junit file is kept', async () => {
    const { d, runs } = deps([]);

    expect(await main(['1', '--json', '--reporter=junit', '--outputFile.junit=out.xml'], d)).toBe(0);
    expect(runs[0]!.args).toContain('--outputFile.junit=out.xml');
  });

  it.each([
    ['--outputFile=out.json'], ['--outputFile.json=out.json'], ['--outputFile'], ['--output-file=out.json'],
    ['--output-file'], ['--output-file.json=out.json'], ['--output-file.json'],
  ])('refuses %s, which the command sets itself', async (arg) => {
    const { d, runs, errors, lines } = deps([]);

    expect(await main(['1', '--json', arg], d)).toBe(2);

    expect(runs).toHaveLength(0);
    expect(errors[0]).toContain(`drop ${arg.split('=')[0]}`);
    expect(JSON.parse(lines[0]!).ok).toBe(false);
  });

  it('refuses a number of rounds too large for a number, with a rounds that is still JSON', async () => {
    const { d, lines } = deps([]);

    expect(await main(['9'.repeat(400), '--json'], d)).toBe(2);

    expect(JSON.parse(lines[0]!)).toMatchObject({ rounds: 2 ** 32, error: 'the number of rounds must be below 4294967296' });
    const big = deps([]);
    expect(await main(['99999999999', '--json'], big.d)).toBe(2);
    expect(JSON.parse(big.lines[0]!)).toMatchObject({ rounds: 99999999999 });
    const edge = deps([]);
    expect(await main(['4294967296'], edge.d)).toBe(2);
    expect(edge.errors[0]).toBe('the number of rounds must be below 4294967296');
    const next = deps([]);
    expect(await main(['4294967295'], next.d)).toBe(2);
    expect(next.errors[0]).toContain('would reach 4294967296');
  });

  it('keeps the summary JSON when the report is not the shape vitest writes', async () => {
    for (const report of [{ testResults: {} }, { testResults: [null] }, { testResults: [{ status: 'failed' }] }]) {
      const { d, lines } = deps([1], {}, { '/tmp/round-1.json': report });

      expect(await main(['1', '--json'], d)).toBe(1);
      expect(JSON.parse(lines[0]!).results[0]).toMatchObject({ failed: [], unexplained: true });
    }
  });

  it('allows --outputFile without --json, which is vitest\'s own', async () => {
    const { d, runs } = deps([]);

    expect(await main(['1', '--outputFile=out.json'], d)).toBe(0);
    expect(runs[0]!.args).toContain('--outputFile=out.json');
  });

  it('prints a summary with the error when the arguments are refused, so a reader of stdout always gets JSON', async () => {
    const { d, lines, errors, runs } = deps([]);

    expect(await main(['0', '--json'], d)).toBe(2);

    expect(errors).toEqual(['the number of rounds must be at least 1']);
    expect(runs).toHaveLength(0);
    expect(JSON.parse(lines[0]!)).toEqual({
      ok: false,
      rounds: 0,
      seeds: [],
      results: [],
      error: 'the number of rounds must be at least 1',
    });
  });

  it('asks for no report path without --json', async () => {
    const { d } = deps([]);
    const reportPath = vi.spyOn(d, 'reportPath');

    await main(['1'], d);

    expect(reportPath).not.toHaveBeenCalled();
  });
});

describe('vitestBin', () => {
  it("finds the project's own vitest", async () => {
    expect(vitestBin(process.cwd())).toMatch(/node_modules[\\/]vitest[\\/]vitest\.mjs$/);
  });
});
