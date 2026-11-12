import { getLanguage } from '../i18n';
const loc = () => { try { return new Intl.Locale(getLanguage()).toString(); } catch { return 'en'; } };
export const fmtDate = (v?: string | null) => { if (!v) return '—'; const d = new Date(v.length === 10 ? `${v}T00:00:00Z` : v); return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(loc(), { year: 'numeric', month: 'short', day: 'numeric', timeZone: v.length === 10 ? 'UTC' : undefined }); };
export const fmtDateTime = (v?: string | null) => { if (!v) return '—'; const d = new Date(v); return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString(loc(), { dateStyle: 'medium', timeStyle: 'short' }); };
export const today = () => new Date().toISOString().slice(0, 10);
export const fmtNum = (n: number) => new Intl.NumberFormat(loc()).format(n);
