# Changelog

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-12

### Added

- `holdBackgroundIntervals()`: intervals the app sets never fire on real time; tests' own intervals run as usual.
- `installStress()`: the app's timeouts fire early and tests resume late after `findBy`/`waitFor`, seeded so a failure
  replays. Off unless `enabled` is true or `VITEST_FLAKY` is set (not to `0`, `false`, `off` or `no`).
- `vitest-flaky [rounds] [vitest arguments]`: runs the suite in stress mode, shuffled, a new seed each round, and
  prints the command that replays a failure.

[Unreleased]: https://github.com/sansanth/vitest-flaky/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/sansanth/vitest-flaky/releases/tag/v0.1.0
