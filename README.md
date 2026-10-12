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

A failing round stops and prints how to replay it:

```
failed on seed 482913. Replay it with:
  VITEST_FLAKY=1 VITEST_FLAKY_SEED=482913 npx vitest run --sequence.shuffle --sequence.seed=482913
```

A flaky test is then a test you can fix, not one you retry.

## How it tells your app's timers from your tests'

Each timer's caller is read from the stack. A caller whose path, taken from the project directory down, matches
`DEFAULT_EXEMPT` is test code and keeps its timers as they are: anything under `test/`, `tests/`, `__tests__/`,
`test-utils/` or `test-helpers/`, files named `*.test.*` or `*.spec.*`, Vitest and Testing Library themselves, and jsdom
and happy-dom, which run `requestAnimationFrame` on an interval of their own. Everything else, your app and the
libraries it uses, is the app. Pass `exempt` to draw the line elsewhere.

A test about a poll uses fake timers (`vi.useFakeTimers()`), which replace `setInterval` with one that fires as the test
moves the clock, so a held interval still works there.

## API

### `holdBackgroundIntervals(options?)`

Every interval the app sets is registered and cleared as usual but never fires on real time. Returns a function that
undoes it.

| Option | Default | |
|---|---|---|
| `exempt` | `DEFAULT_EXEMPT` | Timers set from frames matching this are left alone. |

### `installStress(options?)`

Returns a function that undoes it.

| Option | Default | |
|---|---|---|
| `enabled` | on when `VITEST_FLAKY` is set, and not to `0`, `false`, `off` or `no` | |
| `seed` | `VITEST_FLAKY_SEED`, or `1` | The same seed gives the same delays, in the same order. |
| `maxSlowdown` | `30` | A timeout fires after between all of its delay and `1 / maxSlowdown` of it, log-uniform, so a mild slowdown comes up as often as a severe one. |
| `maxResumeDelayMs` | `100` | How late a test may resume after a `findBy` or `waitFor`. |
| `testingLibrary` | | `{ configure, getConfig }` from your Testing Library package. Without it the late resume is left out; the timers are still shortened. |
| `exempt` | `DEFAULT_EXEMPT` | As above. |

### `vitest-flaky [rounds] [vitest arguments]`

Runs `vitest run --sequence.shuffle --sequence.seed=<seed>` `rounds` times (3 by default, at least 1) with
`VITEST_FLAKY=1`, a new seed each round, starting from `VITEST_FLAKY_SEED` when it is set. It runs your project's own
vitest. The exit code is the failing round's.

## Limits

- A timer's caller is found by its file path, so code that schedules timers through a helper in your test folder counts
  as test code.
- The order timers are set in must be the same from run to run for a seed to replay exactly; a test that depends on real
  wall-clock time can still differ.
- A test that asserts something has not happened yet (a debounced save has not fired, a toast is still showing) fails
  under stress even though the app is right: the test assumes a timing. It is a real finding, not a false alarm, but
  expect it among the first failures. Wait for the state you mean instead.
- The command only turns stress on for the run. If your setup file does not call `installStress`, the rounds are
  shuffled but no timer is touched, and they pass.
- The replay command it prints is for a POSIX shell. On Windows, set the two variables first, then run `npx vitest ...`.
- It speeds up what the app waits for; it does not slow down the app itself. A race that needs the app to be slow (a
  long render) is out of its reach.

## License

MIT
