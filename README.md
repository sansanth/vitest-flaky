# vitest-flaky

Find your flaky Vitest tests on your laptop instead of one CI run in fifty.

A UI test that passes locally and fails on CI is nearly always a race: background work (a poll, a toast closing, a
dialog handing focus back, a debounced save) lands after the assertion on a fast machine and before it on a loaded CI
runner. This package makes your laptop behave like that runner, on most runs instead of a few:

- every timeout your app (or a library it uses) sets fires early, after anything from all of its delay down to a
  thirtieth of it;
- after every `findBy` and `waitFor`, the test resumes up to 100 ms late, so whatever the app queued meanwhile runs
  before the next step;
- test files and tests run in a shuffled order;
- each run has a seed, and a failure prints the command that replays it exactly.

It also holds your app's intervals, so a poll can never fire between two steps of a test that did not ask for it.

```sh
npm install --save-dev vitest-flaky
```

It works with Vitest 2 to 5 and needs Node 20 or later (Vitest 5 itself needs 22).

## Use it

In your Vitest setup file:

```ts
import { configure, getConfig } from '@testing-library/react'; // or /dom, /vue, /svelte
import { holdBackgroundIntervals, installStress } from 'vitest-flaky';

holdBackgroundIntervals();
installStress({ testingLibrary: { configure, getConfig } });
```

`installStress` does nothing until you ask for it. `holdBackgroundIntervals` always applies, in normal runs too: an app
interval never fires there unless a test uses fake timers. Run the suite in stress mode:

```sh
npx vitest-flaky          # three rounds, each shuffled, each on a new seed
npx vitest-flaky 10       # ten rounds
npx vitest-flaky 5 test/inbox.test.tsx --bail=1   # anything after the count goes to vitest
```

Each round prints its number and seed before it runs, and a run that passes ends with the seeds it covered:

```
round 1 of 3, seed 482911
...
3 rounds passed (seeds 482911–482913)
```

A failing round stops and prints how to replay it:

```
failed on seed 482913. Replay it with:
  VITEST_FLAKY=1 VITEST_FLAKY_SEED=482913 npx vitest run --sequence.shuffle --sequence.seed=482913
```

A flaky test is then a test you can fix, not one you retry.

To try one harsher run without editing the setup file, set the limits on the command line:

```sh
npx vitest-flaky 1 --slowdown=60 --max-resume=250
```

`--slowdown` is `maxSlowdown` and `--max-resume` is `maxResumeDelayMs`. They set the `VITEST_FLAKY_SLOWDOWN` and
`VITEST_FLAKY_MAX_RESUME` variables, which `installStress` reads, and the replay command includes them.

## How it tells your app's timers from your tests'

Each timer's caller is read from the stack. A caller whose path, taken from the project directory down, matches
`DEFAULT_EXEMPT` is test code and keeps its timers as they are: anything under `test/`, `tests/`, `__tests__/`,
`test-utils/` or `test-helpers/`, files named `*.test.*` or `*.spec.*`, Vitest and Testing Library themselves, and jsdom
and happy-dom, which run `requestAnimationFrame` on an interval of their own. Everything else, your app and the
libraries it uses, is the app. Pass `exempt` to draw the line elsewhere. It takes one pattern, which replaces the
default, or a list that matches if any of it does. A list replaces the default as well, so one that should add to it
starts with `DEFAULT_EXEMPT`: `exempt: [DEFAULT_EXEMPT, /my-helpers/]`. An empty list is refused.

A test about a poll uses fake timers (`vi.useFakeTimers()`), which replace `setInterval` with one that fires as the test
moves the clock, so a held interval still works there.

## API

### `holdBackgroundIntervals(options?)`

Every interval the app sets is registered and cleared as usual but never fires on real time. Returns a function that
undoes it.

| Option | Default | |
|---|---|---|
| `exempt` | `DEFAULT_EXEMPT` | Timers set from frames matching this are left alone. A pattern, or a list of them. |

### `installStress(options?)`

Returns a function that undoes it.

| Option | Default | |
|---|---|---|
| `enabled` | on when `VITEST_FLAKY` is set to something other than blank, `0`, `false`, `off` or `no` | |
| `seed` | `VITEST_FLAKY_SEED`, or `1` | The same seed gives the same delays, in the same order. |
| `maxSlowdown` | `VITEST_FLAKY_SLOWDOWN`, or `30` | A timeout fires after between all of its delay and `1 / maxSlowdown` of it, log-uniform, so a mild slowdown comes up as often as a severe one. |
| `maxResumeDelayMs` | `VITEST_FLAKY_MAX_RESUME`, or `100` | How late a test may resume after a `findBy` or `waitFor`, up to 2147483647. |
| `testingLibrary` | | `{ configure, getConfig }` from your Testing Library package. Without it the late resume is left out; the timers are still shortened. |
| `exempt` | `DEFAULT_EXEMPT` | As above, a pattern or a list. |

### `vitest-flaky [rounds] [options] [vitest arguments]`

Runs `vitest run --sequence.shuffle --sequence.seed=<seed>` `rounds` times (3 by default) with `VITEST_FLAKY=1` and a
new seed each round, starting from `VITEST_FLAKY_SEED` when it is set and not blank. It runs your project's own
vitest. The exit code is the failing round's.

| Option | |
|---|---|
| `--slowdown=N` | `maxSlowdown` for this run, 1 or more. Beats `VITEST_FLAKY_SLOWDOWN`. |
| `--max-resume=MS` | `maxResumeDelayMs` for this run, up to 2147483647. Beats `VITEST_FLAKY_MAX_RESUME`. |
| `--json` | Prints a summary to stdout. Everything else, vitest's own output included, goes to stderr. |

An option you pass to `installStress` in the setup file beats both. `--slowdown 60` works as well as `--slowdown=60`.
The round count can follow the options (`vitest-flaky --json 10`) but not an argument for vitest, where it would be a
file filter. A `--` ends the options: vitest ignores what follows it, and the command does not read it either.

Ctrl-C, SIGTERM and SIGHUP stop the run: vitest is told, no further round starts, and the command exits with 128 plus
the signal's number. A round that ends that way is reported as stopped, not as a failed seed. A terminal's Ctrl-C
reaches vitest by itself, so SIGINT is passed on only if vitest is still running three seconds later. A vitest that dies
on its own, as under the out-of-memory killer, is a failed seed with a replay command.

#### `--json`

```json
{
  "ok": false,
  "rounds": 5,
  "seeds": [482911, 482912],
  "results": [
    { "seed": 482911, "exitCode": 0, "ok": true, "failed": [] },
    {
      "seed": 482912,
      "exitCode": 1,
      "ok": false,
      "failed": [{ "file": "test/inbox.test.tsx", "tests": ["inbox saves a draft"] }]
    }
  ],
  "replay": "VITEST_FLAKY=1 VITEST_FLAKY_SEED=482912 npx vitest run --sequence.shuffle --sequence.seed=482912"
}
```

- `failed` has an entry for each file with a failed test or an error of its own, such as a hook that threw or an import
  that failed: the `file` (relative to the working directory, with forward slashes), its failed `tests`, and the
  `error` if there is one.
- `exitCode` is `null`, with the `signal`, for a round vitest was killed in.
- `unexplained` is `true` when a round vitest ran failed with an empty `failed`: it found no failed test, as with an
  unhandled error, a coverage threshold or a run with no test files, or left no usable report. `reason` says which: `no-failed-tests`,
  `no-report`, `unreadable-report` or `unrecognised-report`. Look in stderr.
- `error` takes the place of `replay` when vitest could not start or the run was stopped. Arguments the command refuses
  (exit code 2) get a summary with `error` as well, so stdout is always JSON.
- The command adds vitest's `json` reporter, and the `default` one unless you pass a `--reporter`, from the command
  line. That replaces the `reporters` and `outputFile` of your vitest config for the run: to keep a JUnit file, also
  pass `--reporter=junit`. `--outputFile`, `--output-file` and their `.json` forms are refused, as the json reporter has
  a file of its own.

## Limits

- Only `setTimeout` and `setInterval` on the global object (and `window`) are wrapped. A timer from `node:timers` or
  `node:timers/promises`, or from a reference taken before `installStress` ran, keeps its delay, and so does a timeout
  longer than 2147483647 ms.
- Call `installStress` once per test run. A second call while the first is installed wraps it, so a delay shortens
  twice. A setup file that runs for every test file in one process (`isolate: false`) does that.
- A timer's caller is found by its file path, so code that schedules timers through a helper in your test folder counts
  as test code.
- The order timers are set in must be the same from run to run for a seed to replay exactly; a test that depends on real
  wall-clock time can still differ.
- A test that asserts something has not happened yet (a debounced save has not fired, a toast is still showing) fails
  under stress even though the app is right: the test assumes a timing. It is a real finding, not a false alarm, but
  expect it among the first failures. Wait for the state you mean instead.
- The command only turns stress on for the run. If your setup file does not call `installStress`, the rounds are
  shuffled but no timer is touched, and they pass.
- It works with `--coverage` (the v8 provider; the app's timers are shortened as usual), but every round pays for the
  coverage, so ten rounds take about ten times as long as one coverage run, and each round overwrites the report.
- The replay command it prints is for a POSIX shell. On Windows, set the variables it shows first, then run
  `npx vitest ...`.
- It speeds up what the app waits for; it does not slow down the app itself. A race that needs the app to be slow (a
  long render) is out of its reach.

## License

MIT
