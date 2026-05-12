import { useCallback, useEffect, useState } from 'react';
import {
  PROVIDER_IDS,
  getAllApiKeys,
  hasAnyKey,
  onApiKeysChanged,
  setApiKey,
} from '../lib/apiKey.js';

/**
 * Reactive view of localStorage-stored provider keys. Re-renders any
 * component subscribed to it when keys are written via setKey().
 *
 * Returns: { keys, hasAny, setKey, refresh }
 */
export function useApiKey() {
  const [keys, setKeys] = useState(() => getAllApiKeys());
  const [anyKey, setAnyKey] = useState(() => hasAnyKey());

  const refresh = useCallback(() => {
    setKeys(getAllApiKeys());
    setAnyKey(hasAnyKey());
  }, []);

  const setKey = useCallback(
    (provider, value) => {
      if (!PROVIDER_IDS.includes(provider)) return;
      setApiKey(provider, value);
      refresh();
    },
    [refresh]
  );

  // React to changes from this tab (other ApiKeyEditor instances) AND
  // from other tabs/windows. The custom event covers the same-tab case
  // because the native `storage` event does not fire for the tab that
  // wrote.
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key && e.key.startsWith('demokit:apiKey:')) refresh();
    };
    window.addEventListener('storage', onStorage);
    const offCustom = onApiKeysChanged(refresh);
    return () => {
      window.removeEventListener('storage', onStorage);
      offCustom();
    };
  }, [refresh]);

  return { keys, hasAny: anyKey, setKey, refresh };
}
