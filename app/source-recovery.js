// Per-runtime circuit (not a distributed availability guarantee). No stale data
// is returned: paused sources fail explicitly, preserving the original reason.
export function sourceRecovery({ clock = Date.now, maxEntries = 8 } = {}) {
  const failures = new Map();
  return {
    async run(key, operation) {
      const previous = failures.get(key);
      if (previous && previous.until > clock()) throw previous.error;
      try {
        const result = await operation();
        failures.delete(key);
        return result;
      } catch (error) {
        const count = Math.min(6, (previous?.count || 0) + 1);
        const delay =
          error.kind === "access-blocked" ? 300000 : Math.min(300000, 1000 * 2 ** count);
        if (!failures.has(key) && failures.size >= maxEntries)
          failures.delete(failures.keys().next().value);
        failures.set(key, { count, error, until: clock() + delay });
        throw error;
      }
    },
  };
}
