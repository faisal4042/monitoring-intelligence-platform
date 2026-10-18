export const splitQueryTerms = (text: string) => text.split(/[،,]/).map(term => term.trim()).filter(Boolean);

/** Invalidated on every edit/unmount, even before the next debounced request starts. */
export function latestEstimate() {
  let generation = 0;
  return {
    invalidate: () => { generation += 1; },
    async run<T>(request: () => Promise<T>, accept: (value: T) => void, reject: () => void) {
      const current = ++generation;
      try { const value = await request(); if (current === generation) accept(value); }
      catch { if (current === generation) reject(); }
    },
  };
}
