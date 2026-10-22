/** Ends an exhaustive `switch`: a new union member makes the call a compile error. */
export function assertNever(value: never): never {
  throw new Error(`Unhandled case: ${String(value)}`)
}
