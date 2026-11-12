import { useEffect, useState } from 'react';
import { t, useI18n, LANGUAGES, setLanguage, getLanguage } from '../i18n';
import { api } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import { session, signOut } from '../lib/session';
import { SUPPORT_EMAIL } from '../lib/config';
import { deviceZone } from '../lib/time';
import { useLoad, useAction, Page, Loading, ErrorText, Empty } from '../components/ui';
import { ZoneInput } from '../components/ZoneInput';
import { toast } from '../components/Toast';

export function Settings() {
  useI18n(); const a = useAction(); const z = useAction();
  const me = useLoad(() => api<any>('GET', '/me'), []);
  const [zone, setZone] = useState('');
  useEffect(() => { if (me.data) setZone(me.data.preferredTimeZone || ''); }, [me.data]);
  return <Page title={t('nav.settings')}>
    <section className="panel stack-sm">
      <h2>{t('settings.language')}</h2><p className="note">{t('settings.languageText')}</p>
      <select aria-label={t('settings.language')} value={getLanguage()} disabled={a.busy} onChange={(e) => { const v = e.target.value; void a.run(async () => {
        await api('PATCH', '/me', { preferredLanguage: v }); localStorage.setItem('ecotime_lang', v); await setLanguage(v); session.setInfo({ preferredLanguage: v }); toast(t('common.saved')); }); }}>
        {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}</select>
      <ErrorText text={a.err} />
    </section>
    <form className="panel stack-sm form" onSubmit={(e) => { e.preventDefault(); void z.run(async () => { await api('PATCH', '/me', { preferredTimeZone: zone || null }); me.reload(); toast(t('common.saved')); }); }}>
      <h2>{t('settings.zone')}</h2><p className="note">{t('settings.zoneText', { zone: deviceZone() })}</p>
      {!me.data ? <Loading /> : <ZoneInput label={t('convert.zone')} value={zone} onChange={setZone} required={false} />}
      <ErrorText text={z.err} />
      <div className="row"><button className="btn" disabled={z.busy}>{t('common.save')}</button>
        <button type="button" className="btn btn--ghost" disabled={z.busy} onClick={() => setZone(deviceZone())}>{t('settings.useDevice')}</button></div>
    </form>
    <section className="panel stack-sm"><h2>{t('settings.account')}</h2><p className="note">{t('settings.ecoidText')}</p>
      {me.data?.organizations?.length ? <p className="note">{t('settings.orgs')}: {me.data.organizations.map((o: any) => (o.kind === 'personal' ? t('schedules.personal') : o.name)).join(', ')}</p> : null}
      <button className="btn btn--ghost" onClick={() => { void signOut(); }}>{t('account.signOut')}</button></section>
  </Page>;
}

export function Support() {
  useI18n();
  const inbox = useLoad(() => api<any[]>('GET', '/support/tickets'), []);
  const [f, setF] = useState({ subject: '', body: '', email: '' }); const a = useAction(); const [sent, setSent] = useState<any>(null);
  return <Page title={t('nav.support')}>
    <form className="panel stack form" onSubmit={(e) => { e.preventDefault(); void a.run(async () => { const r = await api('POST', '/support/tickets', { ...f, email: f.email || null }); setSent(r); setF({ subject: '', body: '', email: f.email }); inbox.reload(); }); }}>
      <p className="note">{t('support.text', { email: SUPPORT_EMAIL })}</p>
      <label>{t('support.subject')}<input required maxLength={200} value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} /></label>
      <label>{t('support.message')}<textarea required rows={4} maxLength={8000} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></label>
      <label>{t('support.email')}<input type="email" maxLength={320} value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
      <ErrorText text={a.err} />
      {sent ? <p className="ok" role="status">{t('support.sent', { ref: sent.ticketRef })} {!sent.emailDelivered ? <a href={sent.mailto}>{t('support.mailto')}</a> : null}</p> : null}
      <button className="btn" disabled={a.busy}>{t('support.send')}</button>
    </form>
    <h2>{t('support.mine')}</h2>
    {!inbox.data ? <Loading /> : !inbox.data.length ? <Empty text={t('support.none')} /> :
      <ul className="list">{inbox.data.map((x) => <li key={x.ticketRef} className="list__item"><span>{x.subject}</span><span className="note">{x.ticketRef} · {fmtDateTime(x.createdAt)}</span></li>)}</ul>}
  </Page>;
}
