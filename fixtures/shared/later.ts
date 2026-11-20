// One timer helper that several components go through, as Base UI's go through `useTimeout`.
export const later = (ms: number, done: () => void) => setTimeout(done, ms);
