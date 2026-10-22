const QUERY = '(prefers-reduced-motion: reduce)'

function createMotion() {
  let reduced = $state(false)

  function apply(value: boolean): void {
    reduced = value
    if (value) document.documentElement.setAttribute('data-motion', 'reduced')
    else document.documentElement.removeAttribute('data-motion')
  }

  return {
    get reduced(): boolean {
      return reduced
    },
    /** Mirror the OS reduced-motion preference; returns a function that stops listening. */
    start(): () => void {
      if (typeof window.matchMedia !== 'function') return () => {}
      const query = window.matchMedia(QUERY)
      apply(query.matches)
      const onchange = (event: MediaQueryListEvent): void => apply(event.matches)
      query.addEventListener('change', onchange)
      return () => query.removeEventListener('change', onchange)
    }
  }
}

export const motion = createMotion()
