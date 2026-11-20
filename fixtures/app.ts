// Stands in for application code: it lives outside test/, so its timers count as the app's.
export const every = (ms: number, tick: () => void) => setInterval(tick, ms);
export const after = (ms: number, done: () => void) => setTimeout(done, ms);
export const soon = (done: () => void) => setTimeout(done);
// Through a `window` whose timers are not Node's, as in a browser.
export const afterInWindow = (ms: number, done: TimerHandler) => window.setTimeout(done, ms);
export const everyInWindow = (ms: number, tick: () => void) => window.setInterval(tick, ms);
