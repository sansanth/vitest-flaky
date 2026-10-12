// The built package as a user gets it: the exports load, install and undo cleanly, and the command finds vitest.
import { execFileSync, spawnSync } from 'node:child_process';
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

// --json: stdout is only the summary, and a failing round is read back from vitest's own json reporter.
const json = (root) =>
  spawnSync(process.execPath, ['dist/cli.js', '1', '--json', '--root', root], { encoding: 'utf8' });
const passed = json('fixtures/smoke');
if (passed.status !== 0 || JSON.parse(passed.stdout).ok !== true) {
  throw new Error(`smoke: --json on a passing run\n${passed.stdout}${passed.stderr}`);
}
const failed = json('fixtures/failing');
const report = JSON.parse(failed.stdout);
if (failed.status !== 1 || report.ok !== false || !report.results[0].failed[0]?.tests.includes('fails')) {
  throw new Error(`smoke: --json on a failing run\n${failed.stdout}${failed.stderr}`);
}
console.log('smoke: ok');
