import { useState } from 'react';
import { t, useI18n } from '../i18n';
import { api } from '../lib/api';
import { deviceZone, fmtIn } from '../lib/time';
import { useAction, Page, ErrorText, Badge } from '../components/ui';
import { ZoneInput } from '../components/ZoneInput';

// Two directions (§7.3): an instant shown in a zone, and a local wall time resolved to an instant with the DST rules applied openly.
export function Convert() {
  useI18n();
  const [mode, setMode] = useState<'local' | 'instant'>('local');
  const [local, setLocal] = useState({ date: new Date().toISOString().slice(0, 10), time: '09:00', zone: deviceZone(), gap: 'shift_forward', overlap: 'first' });
  const [inst, setInst] = useState({ value: new Date().toISOString().slice(0, 16), from: 'UTC', zone: deviceZone() });
  const [res, setRes] = useState<any>(null); const a = useAction();
  const run = (e: React.FormEvent) => { e.preventDefault(); setRes(null); void a.run(async () => {
    if (mode === 'local') setRes({ mode, ...(await api('POST', '/time/convert', { localDateTime: `${local.date}T${local.time}:00`, timeZone: local.zone, dstGapPolicy: local.gap, dstOverlapPolicy: local.overlap })) });
    else {
      // the instant is first read as a wall time in the "from" zone, then shown in the target zone
      const first = inst.from === 'UTC' ? { instants: [`${inst.value}:00.000Z`] } : await api<any>('POST', '/time/convert', { localDateTime: `${inst.value}:00`, timeZone: inst.from });
      setRes({ mode, from: first, ...(await api('POST', '/time/convert', { instant: first.instants[0], timeZone: inst.zone })) });
    }
  }); };
  return <Page title={t('nav.convert')}>
    <div className="seg" role="group" aria-label={t('convert.mode')}>
      <button type="button" className={mode === 'local' ? 'is-active' : ''} aria-pressed={mode === 'local'} onClick={() => { setMode('local'); setRes(null); }}>{t('convert.localToInstant')}</button>
      <button type="button" className={mode === 'instant' ? 'is-active' : ''} aria-pressed={mode === 'instant'} onClick={() => { setMode('instant'); setRes(null); }}>{t('convert.betweenZones')}</button>
    </div>
    <form className="panel stack form" onSubmit={run}>
      {mode === 'local' ? <>
        <p className="note">{t('convert.localText')}</p>
        <div className="grid3">
          <label>{t('convert.date')}<input type="date" required value={local.date} onChange={(e) => setLocal({ ...local, date: e.target.value })} /></label>
          <label>{t('convert.time')}<input type="time" required value={local.time} onChange={(e) => setLocal({ ...local, time: e.target.value })} /></label>
          <ZoneInput label={t('convert.zone')} value={local.zone} onChange={(v) => setLocal({ ...local, zone: v })} />
        </div>
        <div className="grid2">
          <label>{t('dst.gap')}<select value={local.gap} onChange={(e) => setLocal({ ...local, gap: e.target.value })}><option value="shift_forward">{t('dst.gap.shift_forward')}</option><option value="skip">{t('dst.gap.skip')}</option></select></label>
          <label>{t('dst.overlap')}<select value={local.overlap} onChange={(e) => setLocal({ ...local, overlap: e.target.value })}><option value="first">{t('dst.overlap.first')}</option><option value="second">{t('dst.overlap.second')}</option></select></label>
        </div>
      </> : <>
        <p className="note">{t('convert.instantText')}</p>
        <div className="grid3">
          <label>{t('convert.dateTime')}<input type="datetime-local" required value={inst.value} onChange={(e) => setInst({ ...inst, value: e.target.value })} /></label>
          <ZoneInput label={t('convert.from')} value={inst.from} onChange={(v) => setInst({ ...inst, from: v })} />
          <ZoneInput label={t('convert.to')} value={inst.zone} onChange={(v) => setInst({ ...inst, zone: v })} />
        </div>
      </>}
      <ErrorText text={a.err} />
      <button className="btn" disabled={a.busy}>{t('convert.go')}</button>
    </form>
    {res?.mode === 'local' ? <section className="panel stack-sm" aria-live="polite">
      <div className="row"><h2>{t('convert.result')}</h2><Badge kind={res.resolution}>{t(`resolution.${res.resolution}`)}</Badge></div>
      <p>{t(`resolution.${res.resolution}.text`)}</p>
      {res.instants.length ? <div className="result-box"><span className="result-box__big mono">{res.instants[0]}</span>
        <span>{fmtIn(res.instants[0], res.timeZone, { dateStyle: 'full', timeStyle: 'long' })}</span>
        <span className="note">{t('convert.yourDevice')}: {fmtIn(res.instants[0], deviceZone(), { dateStyle: 'medium', timeStyle: 'long' })}</span></div>
        : <div className="state state--empty"><strong>{t('resolution.skipped')}</strong><span>{t('resolution.skippedText')}</span></div>}
      {res.policyApplied ? <p className="note">{t('convert.policyApplied')}: {t(res.resolution === 'nonexistent' ? `dst.gap.${res.policyApplied}` : `dst.overlap.${res.policyApplied}`)}</p> : null}
      {res.candidates ? <p className="note">{t('convert.candidates')}: <span className="mono">{res.candidates.join(' · ')}</span></p> : null}
      <p className="note">{t('convert.ruleset', { v: res.rulesetVersion })}</p>
    </section> : null}
    {res?.mode === 'instant' ? <section className="panel stack-sm" aria-live="polite">
      <h2>{t('convert.result')}</h2>
      {res.from.resolution && res.from.resolution !== 'unique' ? <p className="note"><Badge kind={res.from.resolution}>{t(`resolution.${res.from.resolution}`)}</Badge> {t(`resolution.${res.from.resolution}.text`)}</p> : null}
      <div className="result-box"><span className="result-box__big mono">{res.localDateTime.replace('T', ' ')}</span>
        <span>{res.timeZone} · UTC{res.utcOffset} · {res.abbreviation}{res.isDst ? ` · ${t('convert.dst')}` : ''}</span>
        <span className="note mono">{res.instant}</span></div>
      <p className="note">{t('convert.ruleset', { v: res.rulesetVersion })}</p>
    </section> : null}
  </Page>;
}
