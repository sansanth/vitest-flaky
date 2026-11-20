import { later } from './later';

export const closeToast = (done: () => void) => later(3000, done);
