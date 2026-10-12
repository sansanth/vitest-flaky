# Contributing

The package is two small files in `src/`. Read `README.md` and `src/index.ts` first.

## Check your change

```sh
npm ci
npm run check   # typecheck, lint, tests with coverage (95% or more), build, smoke test of the built package
```

The tests run on real timers for a few tens of milliseconds each. `fixtures/app.ts` stands in for application code: it
sits outside `test/`, so its timers count as the app's.

## Style

- Comments say why, not what.
- Tests are sentences: `it('never fires an interval the app sets, and still lets it be cleared')`.
- Update `README.md` and `CHANGELOG.md` when behaviour or an option changes.
