/** Ends an exhaustive `switch`: a new union member makes the call a compile error. */
export function assertNever(value: never): never {
  throw new Error(`Unhandled case: ${String(value)}`)
}

/**
 * Ends an exhaustive `switch` that must keep going at runtime: a new union member is still a compile
 * error, but a value outside the union (an event from a newer CLI) is ignored instead of thrown.
 */
export function ignoreUnhandled(value: never): void {
  void value
}
