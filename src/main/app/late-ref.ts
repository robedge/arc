/**
 * A slot for a service that is constructed after the one holding the reference, for the few real
 * construction cycles (A needs B's callbacks, B needs A). Reading it before it is bound throws
 * instead of silently doing nothing, so a wiring mistake shows up at once.
 */
export class LateRef<T> {
  private value: T | undefined

  constructor(private readonly name: string) {}

  bind(value: T): void {
    if (this.value !== undefined) throw new Error(`${this.name} is already bound`)
    this.value = value
  }

  get(): T {
    if (this.value === undefined) throw new Error(`${this.name} was used before it was built`)
    return this.value
  }
}
