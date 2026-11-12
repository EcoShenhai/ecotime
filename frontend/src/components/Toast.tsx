import { useEffect, useState } from 'react';
let push: ((m: string) => void) | null = null;
export function toast(message: string) { push?.(message); }
export function ToastHost() {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { push = (m) => { setMsg(m); window.setTimeout(() => setMsg((x) => (x === m ? null : x)), 2500); }; return () => { push = null; }; }, []);
  return <div className="toast" role="status" aria-live="polite">{msg}</div>;
}
