// Same-origin API client. Pages never call fetch directly.
import { accessToken, refresh, session } from './session';
import { t, has } from '../i18n';

export class ApiError extends Error { constructor(public status: number, public code: string, message: string) { super(message); } }

export async function api<T = any>(method: string, path: string, body?: unknown, { auth = true, headers: extra = {} as Record<string, string> } = {}, retried = false): Promise<T> {
  const headers: Record<string, string> = { ...extra };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth) { const tok = await accessToken(); if (tok) headers.Authorization = `Bearer ${tok}`; }
  let r: Response;
  try { r = await fetch(`/api/v1${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined }); }
  catch { throw new ApiError(0, 'OFFLINE', 'offline'); }
  if (r.status === 401 && auth && !retried && session.signedIn && (await refresh())) return api<T>(method, path, body, { auth, headers: extra }, true);
  const text = await r.text(); let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!r.ok) throw new ApiError(r.status, json?.error?.code || 'ERROR', json?.error?.message || r.statusText);
  return json as T;
}

// A message for any error: the translated text for its code when there is one, else the server's own words.
export function errText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'INVALID_INPUT') return `${t('error.INVALID_INPUT')} ${e.message}`;
    if (has(`error.${e.code}`)) return t(`error.${e.code}`);
    return e.message || t('error.generic');
  }
  if (e instanceof Error && e.message && !/fetch|network|undefined|null/i.test(e.message)) return e.message;
  return t('error.generic');
}
