import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { t, useI18n } from '../i18n';
import { api, errText } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import { measureSkew, deviceZone, fmtIn, fmtMs, type Skew, type ClockHealth } from '../lib/time';
import { useLoad, Page, Loading, Badge, Empty, ErrorText } from '../components/ui';

// The clock health shown is what the server measured, with its reason; nothing is claimed that was not measured (§7.2).
export function HealthPanel({ h, rulesets }: { h: ClockHealth; rulesets?: { runtime: string; os: string | null; agree: boolean | null } }) {
  useI18n();
  return <section className={`panel health health--${h.status}`} aria-labelledby="health-h">
    <div className="row row--between"><h2 id="health-h">{t('health.title')}</h2><Badge kind={h.status}>{t(`clock.${h.status}`)}</Badge></div>
    <p>{t(`clock.${h.status}.text`)}</p>
    {h.reason ? <p className="note">{t('health.reason')}: {h.reason}</p> : null}
    <dl className="facts">
      <div><dt>{t('health.offset')}</dt><dd>{fmtMs(h.offsetMs)}</dd></div>
      <div><dt>{t('health.rootDistance')}</dt><dd>{fmtMs(h.rootDistanceMs)}</dd></div>
      <div><dt>{t('health.source')}</dt><dd>{h.server || '—'}{h.stratum != null ? ` · ${t('health.stratum', { n: h.stratum })}` : ''}</dd></div>
      <div><dt>{t('health.checked')}</dt><dd>{h.lastCheckedAt ? `${fmtDateTime(h.lastCheckedAt)} (${t('health.ageS', { n: h.observationAgeSeconds ?? '—' })})` : '—'}</dd></div>
      <div><dt>{t('health.daemon')}</dt><dd>{h.daemon || '—'}</dd></div>
      {h.diversity ? <div><dt>{t('health.diversity')}</dt><dd>{t(`diversity.${h.diversity}`)}</dd></div> : null}
      {rulesets ? <div><dt>{t('health.rulesets')}</dt><dd>{t('health.runtime')} {rulesets.runtime} · {t('health.os')} {rulesets.os || '—'} {rulesets.agree === false ? <Badge kind="mismatch">{t('health.mismatch')}</Badge> : rulesets.agree ? <Badge kind="agree">{t('health.agree')}</Badge> : null}</dd></div> : null}
    </dl>
    {rulesets?.agree === false ? <p className="note">{t('health.mismatchText')}</p> : null}
  </section>;
}

export function Now() {
  useI18n();
  const me = useLoad(() => api<any>('GET', '/me'), []);
  const rs = useLoad(() => api<any>('GET', '/time/health'), []);
  const upcoming = useLoad(() => api<any[]>('GET', '/schedules?status=active'), []);
  const [skew, setSkew] = useState<Skew | null>(null); const [err, setErr] = useState('');
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    let live = true;
    const go = () => measureSkew().then((s) => { if (live) { setSkew(s); setErr(''); } }).catch((e) => { if (live) setErr(errText(e)); });
    void go(); const m = window.setInterval(go, 60000); const tick = window.setInterval(() => setNow(Date.now()), 250);
    return () => { live = false; window.clearInterval(m); window.clearInterval(tick); };
  }, []);
  const zone = me.data?.preferredTimeZone || deviceZone();
  const serverNow = now + (skew?.skewMs ?? 0);
  const skewTone = skew ? (Math.abs(skew.skewMs) <= Math.max(500, skew.uncertaintyMs) ? 'ok' : Math.abs(skew.skewMs) <= 5000 ? 'warn' : 'danger') : null;
  return <Page title={t('nav.now')}>
    <section className="panel clock" aria-live="off">
      <span className="note">{t('now.serverTimeIn', { zone })}</span>
      <span className="clock__time">{skew ? fmtIn(serverNow, zone, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—'}</span>
      <span className="clock__date">{skew ? fmtIn(serverNow, zone, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZoneName: 'shortOffset' }) : ''}</span>
      <span className="note mono">UTC {skew ? new Date(serverNow).toISOString().slice(0, 19).replace('T', ' ') : '—'}</span>
      {!me.data?.preferredTimeZone ? <p className="note">{t('now.deviceZoneUsed')} <Link to="/settings">{t('now.setZone')}</Link></p> : null}
    </section>
    <ErrorText text={err} />
    {skew ? <section className={`panel stack-sm`} aria-labelledby="skew-h">
      <h2 id="skew-h">{t('skew.title')}</h2>
      <p className={skewTone === 'ok' ? 'ok' : skewTone === 'warn' ? '' : 'error'}>{Math.abs(skew.skewMs) <= skew.uncertaintyMs ? t('skew.same', { u: skew.uncertaintyMs })
        : skew.skewMs > 0 ? t('skew.behind', { ms: skew.skewMs, u: skew.uncertaintyMs }) : t('skew.ahead', { ms: -skew.skewMs, u: skew.uncertaintyMs })}</p>
      <p className="note">{t('skew.text')}</p>
    </section> : !err ? <Loading /> : null}
    {skew ? <HealthPanel h={skew.health} rulesets={rs.data?.rulesets} /> : null}
    <section className="stack-sm"><div className="row row--between"><h2>{t('now.upcoming')}</h2><Link to="/schedules">{t('now.allSchedules')}</Link></div>
      {!upcoming.data ? <Loading /> : !upcoming.data.length ? <Empty text={t('schedules.none')} /> :
        <ul className="list">{upcoming.data.filter((s) => s.nextRunAt).sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt)).slice(0, 5).map((s) => <li key={s.id} className="list__item">
          <span className="stack-xs"><strong>{s.name}</strong><span className="note">{s.timeZone} · {s.localTime}</span></span>
          <span className="stack-xs"><span>{fmtIn(s.nextRunAt, zone, { dateStyle: 'medium', timeStyle: 'short' })}</span>{s.timeZone !== zone ? <span className="note">{fmtIn(s.nextRunAt, s.timeZone, { dateStyle: 'medium', timeStyle: 'long' })}</span> : null}</span></li>)}</ul>}
    </section>
  </Page>;
}
