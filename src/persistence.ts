/**
 * Durable storage for the last good key set and snapshot, so a restart during an IdP outage
 * resumes from them (RFC §5.4, §6.5). The backend implements this over its own Postgres.
 */
export interface Persistence {
  load(key: string): Promise<string | null>
  save(key: string, value: string): Promise<void>
}

/** Non-durable storage for tests and for services that accept a cold start after restarts. */
export function memoryPersistence(): Persistence {
  const values = new Map<string, string>()
  return {
    load: async (key) => values.get(key) ?? null,
    save: async (key, value) => {
      values.set(key, value)
    },
  }
}
