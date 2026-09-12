/**
 * Determinism primitives. The engine takes its clock, its pseudo-random source,
 * and its id counters from here so that the same command sequence always
 * produces byte-identical state — which is what makes the demo rehearsable.
 */

export interface Clock {
  now(): string;
}

/**
 * Advances a fixed amount on every read, starting from `startIso`. Two runs of
 * the same command sequence therefore produce identical timestamps.
 */
export const createFixedClock = (startIso: string, stepSeconds = 30): Clock => {
  let reads = 0;
  const start = Date.parse(startIso);
  if (Number.isNaN(start)) throw new Error(`createFixedClock: invalid ISO time "${startIso}"`);
  return {
    now(): string {
      const at = new Date(start + reads * stepSeconds * 1_000);
      reads += 1;
      return at.toISOString();
    }
  };
};

export const systemClock: Clock = { now: () => new Date().toISOString() };

export interface Rng {
  /** Next float in [0, 1). */
  next(): number;
  /** Next integer in [0, maxExclusive). */
  int(maxExclusive: number): number;
  /** Deterministic choice from a non-empty list. */
  pick<T>(items: readonly T[]): T;
}

/** mulberry32 — small, fast, and identical across platforms for a given seed. */
export const createRng = (seed: number): Rng => {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  return {
    next,
    int: (maxExclusive) => (maxExclusive <= 0 ? 0 : Math.floor(next() * maxExclusive)),
    pick<T>(items: readonly T[]): T {
      const chosen = items[Math.floor(next() * items.length)];
      if (chosen === undefined) throw new Error('Rng.pick: empty list');
      return chosen;
    }
  };
};

export const DEFAULT_SEED = 20_260_718;
export const DEFAULT_START_TIME = '2026-07-18T18:40:00-04:00';
