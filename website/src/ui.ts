const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/<>[]#=+-';

/**
 * Decodes text from random glyphs, left to right. The real text stays in a
 * visually hidden span so assistive tech never reads the scrambled frames.
 */
export function prepareScramble(el: HTMLElement): (() => void) | null {
  const text = el.textContent ?? '';
  if (!text.trim()) return null;
  const real = document.createElement('span');
  real.className = 'visually-hidden';
  real.textContent = text;
  const shown = document.createElement('span');
  shown.setAttribute('aria-hidden', 'true');
  shown.textContent = text;
  el.replaceChildren(real, shown);

  return () => {
    const duration = 700 + text.length * 12;
    const start = performance.now();
    const tick = (now: number): void => {
      const p = Math.min(1, (now - start) / duration);
      const settled = Math.floor(p * text.length);
      let out = text.slice(0, settled);
      for (let i = settled; i < text.length; i++) {
        const ch = text[i];
        out += ch === ' ' ? ' ' : GLYPHS[(Math.random() * GLYPHS.length) | 0];
      }
      shown.textContent = out;
      if (p < 1) requestAnimationFrame(tick);
      else shown.textContent = text;
    };
    requestAnimationFrame(tick);
  };
}

/** Reveal-on-scroll plus optional scramble, one observer for all. */
export function setupReveal(motionOk: boolean): void {
  const targets = document.querySelectorAll<HTMLElement>(
    '.section__head, .panel, .note, .chain, .bullets--plain, .story__fallback',
  );
  const scrambles = new Map<Element, () => void>();
  if (motionOk) {
    document.querySelectorAll<HTMLElement>('[data-scramble]').forEach((el) => {
      const run = prepareScramble(el);
      if (run) scrambles.set(el, run);
    });
  }
  if (!motionOk || !('IntersectionObserver' in window)) return;

  targets.forEach((el) => el.classList.add('reveal'));
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add('is-in');
        e.target.querySelectorAll('[data-scramble]').forEach((s) => {
          scrambles.get(s)?.();
          scrambles.delete(s);
        });
        io.unobserve(e.target);
      }
    },
    { rootMargin: '0px 0px -10% 0px', threshold: 0.12 },
  );
  targets.forEach((el) => io.observe(el));

  // Kickers outside revealed containers (hero, download) scramble when seen.
  const loose = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      scrambles.get(e.target)?.();
      scrambles.delete(e.target);
      loose.unobserve(e.target);
    }
  });
  scrambles.forEach((_, el) => loose.observe(el));
}

/**
 * Disclosure menu for the header on narrow screens. Closes on link tap,
 * Escape, a tap outside the header, or when the layout widens again.
 */
export function setupMenu(header: HTMLElement): void {
  const toggle = header.querySelector<HTMLButtonElement>('.nav-toggle');
  if (!toggle) return;
  const wide = window.matchMedia('(min-width: 821px)');
  const set = (open: boolean): void => {
    header.classList.toggle('is-open', open);
    toggle.setAttribute('aria-expanded', String(open));
  };
  toggle.addEventListener('click', () => set(toggle.getAttribute('aria-expanded') !== 'true'));
  header.querySelectorAll('.nav a').forEach((a) => a.addEventListener('click', () => set(false)));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && header.classList.contains('is-open')) {
      set(false);
      toggle.focus();
    }
  });
  document.addEventListener('pointerdown', (e) => {
    if (header.classList.contains('is-open') && !header.contains(e.target as Node)) set(false);
  });
  wide.addEventListener('change', () => set(false));
}

/** WAI-ARIA tabs with arrow-key, Home and End support. */
export function setupTabs(root: HTMLElement): void {
  const tabs = Array.from(root.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  const select = (tab: HTMLButtonElement, focus: boolean): void => {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      const panel = document.getElementById(t.getAttribute('aria-controls') ?? '');
      if (panel) panel.hidden = !on;
    }
    if (focus) tab.focus();
  };
  // The markup leaves every panel visible so the content reads without scripts
  // (and for crawlers); hide the unselected ones only once the tabs work.
  select(tabs.find((t) => t.getAttribute('aria-selected') === 'true') ?? tabs[0], false);
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => select(tab, false));
    tab.addEventListener('keydown', (e) => {
      let next = -1;
      if (e.key === 'ArrowRight') next = (i + 1) % tabs.length;
      else if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = tabs.length - 1;
      if (next >= 0) {
        e.preventDefault();
        select(tabs[next], true);
      }
    });
  });
}
