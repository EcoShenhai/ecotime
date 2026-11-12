// Continue with EcoID: authorization code + PKCE S256 (same flow as the other B2X apps). The EcoID access token
// is used once, to open an EcoTime session; the account is matched by the EcoID subject, never by email.
import { ECOID_CLIENT_ID, ECOID_ORIGIN, SCOPES } from './config';
import { session, type Pair } from './session';
import { api } from './api';
import { getLanguage } from '../i18n';

const b64url = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const rand = (n: number) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const redirectUri = () => `${window.location.origin}/auth/ecoid/callback`;

export async function signIn(returnTo = '/') {
  const verifier = rand(48); const state = rand(16);
  sessionStorage.setItem('ecoid_pkce_verifier', verifier); sessionStorage.setItem('ecoid_state', state);
  sessionStorage.setItem('ecoid_return', returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/');
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const qs = new URLSearchParams({ client_id: ECOID_CLIENT_ID, redirect_uri: redirectUri(), response_type: 'code', scope: SCOPES, state,
    code_challenge: challenge, code_challenge_method: 'S256', ui_locales: getLanguage(), nonce: rand(8) });
  window.location.assign(`${ECOID_ORIGIN}/authorize?${qs.toString()}`);
}

export async function completeSignIn(params: URLSearchParams): Promise<string> {
  const expected = sessionStorage.getItem('ecoid_state'); const verifier = sessionStorage.getItem('ecoid_pkce_verifier');
  const returnTo = sessionStorage.getItem('ecoid_return') || '/';
  ['ecoid_state', 'ecoid_pkce_verifier', 'ecoid_return'].forEach((k) => sessionStorage.removeItem(k));
  if (params.get('error')) throw new Error(params.get('error') === 'access_denied' ? 'cancelled' : 'ecoid_error');
  const code = params.get('code'); const state = params.get('state');
  if (!code || !state || !expected || state !== expected || !verifier) throw new Error('state_mismatch');
  const r = await fetch(`${ECOID_ORIGIN}/api/v1/oidc/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: ECOID_CLIENT_ID, redirect_uri: redirectUri(), code_verifier: verifier }).toString() });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error('token_exchange_failed');
  await exchange(j.access_token);
  return returnTo;
}

export async function exchange(ecoidToken: string) {
  const pair = await api<Pair>('POST', '/auth/ecoid/exchange', { ecoidToken, language: getLanguage() }, { auth: false });
  await session.set(pair);
}
