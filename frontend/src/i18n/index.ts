// 72 languages from the shared registry (CPAMind source, Integration §4). English is bundled;
// other languages load on demand and fall back to English key by key. Right-to-left sets dir="rtl".
import { useSyncExternalStore } from 'react';
import registry from '../international/registry.json';
import en from './locales/en.json';

export type Lang = { code: string; name: string; dir?: string };
export const LANGUAGES: Lang[] = (registry as { languages: Lang[] }).languages;
const RTL = new Set(LANGUAGES.filter((l) => l.dir === 'rtl').map((l) => l.code));
const loaders = import.meta.glob<{ default: Record<string, string> }>(['./locales/*.json', '!./locales/en.json']);
type Dict = Record<string, string>;

let current = 'en';
let dict: Dict = en as Dict;
const listeners = new Set<() => void>();

export function getLanguage() { return current; }
export function isRtl(code = current) { return RTL.has(code); }

export function detectLanguage(saved?: string | null): string {
  const codes = new Set(LANGUAGES.map((l) => l.code));
  if (saved && codes.has(saved)) return saved;
  for (const n of navigator.languages || [navigator.language]) {
    const base = (n || '').toLowerCase().split('-')[0];
    if (codes.has(n)) return n;
    if (codes.has(base)) return base;
    if (base === 'nb' || base === 'nn') return 'no';
    if (base === 'tl') return 'fil';
  }
  return 'en';
}

export async function setLanguage(code: string) {
  let next: Dict = en as Dict;
  if (code !== 'en') {
    const load = loaders[`./locales/${code}.json`];
    if (load) { try { next = { ...(en as Dict), ...strip((await load()).default) }; } catch { next = en as Dict; } }
  }
  current = code; dict = next;
  document.documentElement.lang = code;
  document.documentElement.dir = isRtl(code) ? 'rtl' : 'ltr';
  listeners.forEach((l) => l());
}
function strip(d: Dict): Dict { const o: Dict = {}; for (const [k, v] of Object.entries(d)) if (!k.startsWith('_') && v) o[k] = v; return o; }

export function t(key: string, vars?: Record<string, string | number>): string {
  let s = dict[key] ?? (en as Dict)[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

export function has(key: string) { return key in dict || key in (en as Dict); }

export function useI18n() {
  useSyncExternalStore((fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; }, () => current);
  return { t, lang: current, rtl: isRtl() };
}
