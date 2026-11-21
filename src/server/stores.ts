import type { ConfigStore, Store, StoredConfig, TraceSink } from "./types.ts";

/** In-process store with expiry. Fine for one Node process; use KV or a Durable Object on Workers. */
export function memoryStore(): Store {
  const m = new Map<string, { v: unknown; until: number }>();
  return {
    async get(k) {
      const e = m.get(k);
      if (!e) return undefined;
      if (e.until && e.until < Date.now()) {
        m.delete(k);
        return undefined;
      }
      return e.v;
    },
    async put(k, v, ttl) {
      m.set(k, { v, until: ttl ? Date.now() + ttl * 1000 : 0 });
    },
    async delete(k) {
      m.delete(k);
    },
  };
}

/** Keeps trace lines in memory, for tests and local runs. */
export function memorySink(): TraceSink & { lines: Map<string, unknown[]> } {
  const lines = new Map<string, unknown[]>();
  const sink = async (session: string, ls: unknown[]) => {
    lines.set(session, [...(lines.get(session) ?? []), ...ls]);
  };
  return Object.assign(sink, { lines });
}

/**
 * The user's settings kept in a Store under one key, with no expiry. The default: a dot
 * with no ConfigStore of its own keeps its settings wherever its Store keeps things.
 */
export function storeConfig(store: Store, key = "config"): ConfigStore {
  return {
    async load() {
      return (await store.get(key)) as StoredConfig | undefined;
    },
    async save(config) {
      await store.put(key, config);
    },
  };
}

/** Settings in memory, for tests and local runs. */
export function memoryConfig(): ConfigStore {
  return storeConfig(memoryStore());
}
