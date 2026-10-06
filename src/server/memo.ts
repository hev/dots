// Remembers what a slow outside call (gog, buffer, bosshogg) said for a while,
// and lets identical calls already in flight share one answer: the voice model
// often asks the same thing twice while the first is still out. Failures are
// never kept.

export function memo<A extends unknown[], R>(fn: (...a: A) => Promise<R>, ttlMs: number, o: { key?: (...a: A) => string | null; log?: (key: string, ms: number, hit: boolean) => void } = {}) {
  const done = new Map<string, { at: number; value: R }>();
  const flying = new Map<string, Promise<R>>();
  const call = (...a: A): Promise<R> => {
    const k = o.key ? o.key(...a) : JSON.stringify(a);
    if (k === null) return fn(...a);
    const hit = done.get(k);
    if (hit && Date.now() - hit.at < ttlMs) {
      o.log?.(k, 0, true);
      return Promise.resolve(hit.value);
    }
    let p = flying.get(k);
    if (!p) {
      const t0 = Date.now();
      p = fn(...a)
        .then((value) => (done.set(k, { at: Date.now(), value }), o.log?.(k, Date.now() - t0, false), value))
        .finally(() => flying.delete(k));
      flying.set(k, p);
    }
    return p;
  };
  return Object.assign(call, { clear: () => done.clear() });
}
