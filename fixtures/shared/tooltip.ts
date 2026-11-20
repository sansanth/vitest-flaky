import { later } from './later';

export const hideTooltip = (done: () => void) => later(3000, done);
