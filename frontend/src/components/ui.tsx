import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { errText } from '../lib/api';
import { t } from '../i18n';

// Load data for a page; reload() fetches again, setData updates in place.
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null); const [err, setErr] = useState(''); const [n, setN] = useState(0);
  useEffect(() => {
    let live = true; setErr('');
    fn().then((d) => { if (live) setData(d); }).catch((e) => { if (live) setErr(errText(e)); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  return { data, err, reload: useCallback(() => setN((x) => x + 1), []), setData };
}

// Run an action with a busy flag and an error message.
export function useAction() {
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true); setErr('');
    try { return await fn(); } catch (e) { setErr(errText(e)); return undefined; } finally { setBusy(false); }
  }, []);
  return { busy, err, run, setErr };
}

export const Loading = () => <p className="note" role="status">{t('common.loading')}</p>;
export const ErrorText = ({ text }: { text?: string }) => (text ? <p className="error" role="alert">{text}</p> : null);
export function Page({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return <section className="stack"><div className="row row--between"><h1>{title}</h1>{actions ? <div className="row">{actions}</div> : null}</div>{children}</section>;
}
export function Badge({ kind, children }: { kind: string; children: ReactNode }) { return <span className={`badge badge--${kind}`}>{children}</span>; }
export const StatusBadge = ({ status }: { status: string }) => <Badge kind={status}>{t(`status.${status}`)}</Badge>;
export function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: string }) {
  return <div className={`stat${tone ? ` stat--${tone}` : ''}`}><span className="stat__value">{value ?? '—'}</span><span className="stat__label">{label}</span></div>;
}
export function Empty({ text }: { text: string }) { return <p className="note empty">{text}</p>; }
