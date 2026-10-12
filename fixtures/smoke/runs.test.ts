import { expect, it } from 'vitest';

it('runs under the command in stress mode', () => {
  expect(process.env.VITEST_FLAKY).toBe('1');
  expect(Number(process.env.VITEST_FLAKY_SEED)).toBeGreaterThan(0);
});
