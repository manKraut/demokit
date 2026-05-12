import { useEffect, useState } from 'react';
import { fetchMeta } from '../lib/api.js';

/**
 * One-shot fetch of GET /api/meta. Returns { meta, loading, error }.
 * Meta is small and immutable per server boot, so we cache it once and
 * don't re-fetch on every mount.
 */
let cachedMeta = null;

export function useMeta() {
  const [meta, setMeta] = useState(cachedMeta);
  const [loading, setLoading] = useState(!cachedMeta);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (cachedMeta) return;
    let cancelled = false;
    fetchMeta()
      .then((m) => {
        cachedMeta = m;
        if (!cancelled) {
          setMeta(m);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { meta, loading, error };
}
