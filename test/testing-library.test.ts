// @vitest-environment jsdom
import { configure, getConfig, waitFor } from '@testing-library/dom';
import { expect, it } from 'vitest';
import { after } from '../fixtures/app';
import { holdBackgroundIntervals, installStress } from '../src/index';

it("works with Testing Library's own configure and getConfig, and with jsdom's window", async () => {
  const before = getConfig().asyncWrapper;
  const unhold = holdBackgroundIntervals();
  const restore = installStress({ enabled: true, seed: 11, testingLibrary: { configure, getConfig } });
  let done = false;
  after(3000, () => (done = true));

  await waitFor(() => expect(done).toBe(true), { timeout: 3500 });
  // jsdom runs animation frames on an interval of its own, which is the environment's, not the app's.
  await new Promise((resolve) => requestAnimationFrame(resolve));

  restore();
  unhold();
  expect(getConfig().asyncWrapper).toBe(before);
});
