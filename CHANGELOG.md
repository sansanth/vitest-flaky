# Changelog

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-10-21

### Added

- `--json` marks a failed round with no failed test in `failed` as `unexplained: true`, with a `reason`: `no-report`,
  `unreadable-report`, `unrecognised-report` or `no-failed-tests`.

### Changed

- `exempt: null` used to mean the default and now throws a `TypeError`. Leave `exempt` out for the default. A blank
  `VITEST_FLAKY_SEED` counts as unset.
- If the working directory cannot be read, `installStress` and `holdBackgroundIntervals` warn and leave timers alone.

### Fixed

- `installStress` no longer shortens a delay above 2147483647, which Node turns into 1 ms.
- An undo function stops its effect even when something else was installed over it, and works in either order.
- A timer the app sets no longer throws when the working directory was deleted.
- `--reporter=verbose,json` counts as a json reporter, so `--json` does not add a second.
- `--output-file` is refused under `--json` like `--outputFile`.
- `--slowdown 1e3` is read like `--slowdown=1e3`. What follows a `--` is left to vitest, so a `--sequence.seed` there is
  no longer refused.

## [0.2.0] - 2026-10-12

### Added

- `vitest-flaky --slowdown=N --max-resume=MS` sets `maxSlowdown` and `maxResumeDelayMs` for one run. `installStress`
  reads them from `VITEST_FLAKY_SLOWDOWN` and `VITEST_FLAKY_MAX_RESUME` when the option is not given.
- `vitest-flaky --json` prints the seeds that ran and the tests that failed as JSON. Progress and vitest's own output go
  to stderr. It replaces the reporters in your vitest config for the run.
- `exempt` takes a list, so `[DEFAULT_EXEMPT, /my-helpers/]` adds to the default.

### Changed

- Ctrl-C, SIGTERM and SIGHUP now stop the run: vitest is told, no further round starts, and the command exits with 128
  plus the signal's number. A round vitest ends that way is no longer reported as a failed seed.
- `installStress` and `holdBackgroundIntervals` throw a `RangeError` for an empty `exempt` list, and `installStress` for
  a `maxResumeDelayMs` below 0 or above 2147483647 (a timer cannot wait longer) or a `maxSlowdown` that is infinite.

### Fixed

- A `g` or `y` flag on an `exempt` pattern no longer changes the answer from one timer to the next.

## [0.1.0] - 2026-10-12

### Added

- `holdBackgroundIntervals()`: intervals the app sets never fire on real time; tests' own intervals run as usual.
- `installStress()`: the app's timeouts fire early and tests resume late after `findBy`/`waitFor`, seeded so a failure
  replays. Off unless `enabled` is true or `VITEST_FLAKY` is set (not to `0`, `false`, `off` or `no`).
- `vitest-flaky [rounds] [vitest arguments]`: runs the suite in stress mode, shuffled, a new seed each round, and
  prints the command that replays a failure.

[Unreleased]: https://github.com/sansanth/vitest-flaky/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/sansanth/vitest-flaky/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/sansanth/vitest-flaky/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/sansanth/vitest-flaky/releases/tag/v0.1.0
