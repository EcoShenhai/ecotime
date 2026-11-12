import { useSyncExternalStore } from 'react';
const sub = (f: () => void) => { window.addEventListener('online', f); window.addEventListener('offline', f); return () => { window.removeEventListener('online', f); window.removeEventListener('offline', f); }; };
export const useOnline = () => useSyncExternalStore(sub, () => navigator.onLine);
