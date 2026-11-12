// EcoTime session. The backend issues its own short access token and a rotating refresh token after EcoID
// (people) or password + Authenticator code (the administrator). The access token lives in memory only; the
// refresh token lives in this tab's sessionStorage, so closing the tab ends the session on this device.
import { useSyncExternalStore } from 'react';

export type Kind = 'person' | 'admin';
export type Info = { kind: Kind; userId?: string; displayName?: string | null; preferredLanguage?: string; email?: string };
type S = { access: string | null; exp: number; info: Info | null; restoring: boolean };
let s: S = { access: null, exp: 0, info: null, restoring: true };
const ls = new Set<() => void>(); const emit = () => ls.forEach((l) => l());
const RT = 'ecotime_refresh';

export type Pair = { accessToken: string; refreshToken: string; expiresIn: number; kind: Kind };

export const session = {
  subscribe(f: () => void) { ls.add(f); return () => { ls.delete(f); }; },
  get state() { return s; },
  get signedIn() { return !!s.access; },
  async set(p: Pair) {
    sessionStorage.setItem(RT, p.refreshToken);
    s = { ...s, access: p.accessToken, exp: Date.now() + p.expiresIn * 1000, restoring: false };
    await loadInfo(); emit();
  },
  clear() { s = { access: null, exp: 0, info: null, restoring: false }; sessionStorage.removeItem(RT); emit(); },
  setInfo(info: Partial<Info>) { if (s.info) { s = { ...s, info: { ...s.info, ...info } }; emit(); } },
};

async function loadInfo() {
  try {
    const r = await fetch('/api/v1/session', { headers: { Authorization: `Bearer ${s.access}` } });
    if (r.ok) s = { ...s, info: await r.json() };
  } catch { /* the next request will try again */ }
}

let refreshing: Promise<boolean> | null = null;
export function refresh(): Promise<boolean> {
  if (!refreshing) refreshing = (async () => {
    const rt = sessionStorage.getItem(RT); if (!rt) return false;
    try {
      const r = await fetch('/api/v1/auth/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: rt }) });
      if (r.status === 401) { session.clear(); return false; }
      if (!r.ok) return false;
      await session.set(await r.json()); return true;
    } catch { return false; }
  })().finally(() => { refreshing = null; });
  return refreshing;
}

export async function accessToken(): Promise<string | null> {
  if (s.access && s.exp - Date.now() > 20000) return s.access;
  return (await refresh()) ? s.access : null;
}

// On start (and when the device comes back online) try to continue an existing session.
export async function restoreSession() {
  if (!s.access && sessionStorage.getItem(RT)) await refresh();
  if (s.restoring) { s = { ...s, restoring: false }; emit(); }
}

export async function signOut() {
  const rt = sessionStorage.getItem(RT);
  session.clear();
  if (rt) { try { await fetch('/api/v1/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: rt }) }); } catch { /* offline */ } }
}

export function useSession() { useSyncExternalStore(session.subscribe, () => s); return s; }
