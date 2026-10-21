import { afterEach, describe, expect, it, vi } from 'vitest';
import { after, every } from '../fixtures/app';
import { callerOf, DEFAULT_EXEMPT, holdBackgroundIntervals } from '../src/index';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const undo: (() => void)[] = [];

afterEach(() => {
  undo.splice(0).forEach((restore) => restore());
  vi.restoreAllMocks();
});

describe('holdBackgroundIntervals', () => {
  it("never fires an interval the app sets, and still lets it be cleared", async () => {
    undo.push(holdBackgroundIntervals());
    let ticks = 0;
    const id = every(5, () => ticks++);

    await sleep(60);
    clearInterval(id);

    expect(ticks).toBe(0);
  });

  it("leaves a test's own intervals alone", async () => {
    undo.push(holdBackgroundIntervals());
    let ticks = 0;
    const id = setInterval(() => ticks++, 5);

    await sleep(60);
    clearInterval(id);

    expect(ticks).toBeGreaterThan(0);
  });

  it('takes its own idea of what is not the app', async () => {
    undo.push(holdBackgroundIntervals({ exempt: /[\\/]fixtures[\\/]/ }));
    let ticks = 0;
    const id = every(5, () => ticks++);

    await sleep(60);
    clearInterval(id);

    expect(ticks).toBeGreaterThan(0);
  });

  it('takes a list of patterns, which can add to the default', async () => {
    undo.push(holdBackgroundIntervals({ exempt: [DEFAULT_EXEMPT, /[\\/]fixtures[\\/]/] }));
    let own = 0;
    let helper = 0;
    const ownId = setInterval(() => own++, 5);
    const helperId = every(5, () => helper++);

    await sleep(60);
    clearInterval(ownId);
    clearInterval(helperId);

    expect(own).toBeGreaterThan(0);
    expect(helper).toBeGreaterThan(0);
  });

  it('refuses an empty list', () => {
    expect(() => holdBackgroundIntervals({ exempt: [] })).toThrow(RangeError);
  });

  it('holds an interval that matches none of the patterns in a list', async () => {
    undo.push(holdBackgroundIntervals({ exempt: [DEFAULT_EXEMPT, /[\\/]nowhere[\\/]/] }));
    let ticks = 0;
    const id = every(5, () => ticks++);

    await sleep(60);
    clearInterval(id);

    expect(ticks).toBe(0);
  });

  it('is undone by the function it returns', async () => {
    holdBackgroundIntervals()();
    let ticks = 0;
    const id = every(5, () => ticks++);

    await sleep(60);
    clearInterval(id);

    expect(ticks).toBeGreaterThan(0);
  });

  it('measures the caller from the project directory, so an app under a folder named test is still the app', async () => {
    const root = `${process.cwd()}/fixtures`;
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    undo.push(holdBackgroundIntervals({ exempt: /[\\/]fixtures[\\/]/ }));
    let ticks = 0;
    const id = every(5, () => ticks++);

    await sleep(60);
    clearInterval(id);

    expect(ticks).toBe(0);
  });

  it('still holds the app\'s intervals where there is no process, as in browser mode', async () => {
    vi.stubGlobal('process', undefined);
    // Nothing is exempt: without a working directory to cut off, a checkout under a `test` folder would be.
    undo.push(holdBackgroundIntervals({ exempt: /^$/ }));
    let ticks = 0;
    const id = every(5, () => ticks++);
    vi.unstubAllGlobals();

    await sleep(60);
    clearInterval(id);

    expect(ticks).toBe(0);
  });

  it('refuses an exempt that is not a RegExp', () => {
    expect(() => holdBackgroundIntervals({ exempt: 'helpers' as never })).toThrow(TypeError);
  });

  it('does not touch timeouts', async () => {
    undo.push(holdBackgroundIntervals());
    let done = false;
    after(5, () => (done = true));

    await sleep(60);

    expect(done).toBe(true);
  });
});

describe('callerOf', () => {
  it('names the first frame outside the package, whatever the directory it is in', () => {
    expect(callerOf(new Error().stack)).toContain('hold.test.ts');
    expect(callerOf(undefined)).toBe('');
  });

  it('reads the stack formats of Firefox and Safari, which have no header line', () => {
    const stack = 'wait@http://localhost/src/poller.ts:3:10\nsetup@http://localhost/src/main.ts:9:1';

    expect(callerOf(stack)).toBe('wait@http://localhost/src/poller.ts:3:10');
  });

  it.each([
    ['/work/test/inbox.test.tsx', true],
    ['/work/src/__tests__/inbox.tsx', true],
    ['/work/src/test-utils/render.tsx', true],
    ['/work/src/inbox.spec.ts', true],
    ['/work/node_modules/@testing-library/dom/dist/wait-for.js', true],
    ['/work/node_modules/vitest/dist/index.js', true],
    ['/work/node_modules/jsdom/lib/jsdom/browser/Window.js', true],
    ['/work/node_modules/happy-dom/lib/window/BrowserWindow.js', true],
    ['/work/src/inbox.tsx', false],
    ['/work/node_modules/react-dom/cjs/react-dom.development.js', false],
  ])('counts %s as test code: %s', (path, exempt) => {
    expect(DEFAULT_EXEMPT.test(`    at f (${path}:1:1)`)).toBe(exempt);
  });
});
