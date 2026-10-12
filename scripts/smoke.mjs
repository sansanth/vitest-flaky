// The built package as a user gets it: the exports load, install and undo cleanly, and the command finds vitest.
import { execFileSync } from 'node:child_process';
import { holdBackgroundIntervals, installStress } from '../dist/index.js';

const realSetInterval = globalThis.setInterval;
const realSetTimeout = globalThis.setTimeout;
holdBackgroundIntervals()();
installStress({ enabled: true, seed: 1 })();
if (globalThis.setInterval !== realSetInterval || globalThis.setTimeout !== realSetTimeout) {
  throw new Error('smoke: undoing did not put the timers back');
}

await import('../dist/cli.js');

// Vitest 5 does not run on Node 20, which the package supports, so there the command is only loaded.
if (Number(process.versions.node.split('.')[0]) < 22) {
  console.log('smoke: ok (command not run on Node ' + process.versions.node + ')');
  process.exit(0);
}

const out = execFileSync(process.execPath, ['dist/cli.js', '1', '--root', 'fixtures/smoke'], { encoding: 'utf8' });
if (!/round 1 of 1, seed \d+/.test(out) || !/1 round passed \(seed \d+\)/.test(out)) throw new Error(`smoke: unexpected output\n${out}`);
console.log('smoke: ok');
