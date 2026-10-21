/** `value` if it is a finite number from `min` to `max`, else a `RangeError` naming it. */
export function atLeast(value: number, name: string, min: number, max = Infinity): number {
  if (!(value >= min && value <= max && Number.isFinite(value))) {
    const range = max === Infinity ? `${min} or more` : `from ${min} to ${max}`;
    throw new RangeError(`${name} must be a number, ${range}`);
  }
  return value;
}

/** The number in an environment variable, or undefined when it is unset or blank. */
export function fromEnv(raw: string | undefined, name: string, min: number, max = Infinity): number | undefined {
  const value = raw?.trim();
  return value ? atLeast(Number(value), name, min, max) : undefined;
}

/** The longest delay a timer accepts (about 24 days): Node cuts a longer one to 1 ms, and a browser wraps it. */
export const MAX_TIMER_MS = 2 ** 31 - 1;
