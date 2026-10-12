// Stands in for application code: it lives outside test/, so its timers count as the app's.
export const every = (ms: number, tick: () => void) => setInterval(tick, ms);
export const after = (ms: number, done: () => void) => setTimeout(done, ms);
export const soon = (done: () => void) => setTimeout(done);
