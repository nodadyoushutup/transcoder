import { useEffect, useState } from 'react';
import { getBackendBase, subscribeBackendBase } from '../lib/backend.js';

export function useBackendBase() {
  const [backendBase, setBackendBase] = useState(() => getBackendBase());

  useEffect(() => {
    return subscribeBackendBase((nextBase) => {
      setBackendBase(nextBase);
    });
  }, []);

  return backendBase;
}

export default useBackendBase;
