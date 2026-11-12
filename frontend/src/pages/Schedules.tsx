import { useMemo, useState } from 'react';
import { t, useI18n } from '../i18n';
import { api } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import { deviceZone, fmtIn } from '../lib/time';
import { useLoad, useAction, Page, Loading, ErrorText, Badge, Empty } from '../components/ui';
import { ZoneInput } from '../components/ZoneInput';
import { toast } from '../components/Toast';

const DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
type Form = { name: string; scheduleType: 'once' | 'recurring'; timeZone: string; startDate: string; localTime: string; freq: string; days: string[]; interval: number; rule: string;
  dstGapPolicy: string; dstOverlapPolicy: string; actionType: string; webhookEndpointId: string; emailTo: string; message: string; organizationId: string };
const ruleOf = (f: Form) => {
  if (f.scheduleType === 'once') return null;
  if (f.freq === 'CUSTOM') return f.rule.trim();
  const parts = [`FREQ=${f.freq}`]; if (f.interval > 1) parts.push(`INTERVAL=${f.interval}`);
  if (f.freq === 'WEEKLY' && f.days.length) parts.push(`BYDAY=${DAYS.filter((d) => f.days.includes(d)).join(',')}`);
  return parts.join(';');
};
const intentOf = (f: Form) => ({ name: f.name || 'Preview', scheduleType: f.scheduleType, timeZone: f.timeZone, startDate: f.startDate, localTime: f.localTime, recurrenceRule: ruleOf(f), dstGapPolicy: f.dstGapPolicy, dstOverlapPolicy: f.dstOverlapPolicy });
const newKey = () => `ui-${crypto.randomUUID()}`;

function Occurrences({ list, zone }: { list: any[]; zone: string }) {
  return <ol className="occ">{list.map((o, i) => <li key={i} className={o.skipped ? 'occ--skipped' : ''}>
    <span className="mono">{o.local.replace('T', ' ')} {zone}</span>
    <span>{o.skipped ? t('resolution.skipped') : <>{fmtIn(o.instant, deviceZone(), { dateStyle: 'medium', timeStyle: 'long' })}</>}
      {o.resolution !== 'unique' ? <> <Badge kind={o.resolution}>{t(`resolution.${o.resolution}`)}</Badge></> : null}</span></li>)}</ol>;
}

function Create({ onCreated }: { onCreated: () => void }) {
  const orgs = useLoad(() => api<any[]>('GET', '/organizations/mine'), []);
  const hooks = useLoad(() => api<any[]>('GET', '/webhooks'), []);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const blank: Form = { name: '', scheduleType: 'recurring', timeZone: deviceZone(), startDate: tomorrow, localTime: '09:00', freq: 'WEEKLY', days: ['MO'], interval: 1, rule: '',
    dstGapPolicy: 'shift_forward', dstOverlapPolicy: 'first', actionType: 'record', webhookEndpointId: '', emailTo: '', message: '', organizationId: '' };
  const [f, setF] = useState<Form>(blank); const [key, setKey] = useState(newKey); const [pv, setPv] = useState<any>(null);
  const a = useAction(); const p = useAction();
  const set = (x: Partial<Form>) => { setF({ ...f, ...x }); setPv(null); setKey(newKey()); };
  const orgId = f.organizationId || orgs.data?.[0]?.id || '';
  const orgHooks = (hooks.data || []).filter((h) => h.organizationId === orgId && h.status === 'active');
  return <form className="panel stack form" onSubmit={(e) => { e.preventDefault(); void a.run(async () => {
    const body: any = { ...intentOf(f), name: f.name, actionType: f.actionType, organizationId: orgId || undefined,
      ...(f.actionType === 'webhook' ? { webhookEndpointId: f.webhookEndpointId } : {}), ...(f.actionType === 'email' ? { emailTo: f.emailTo } : {}), ...(f.message ? { payload: { message: f.message } } : {}) };
    await api('POST', '/schedules', body, { headers: { 'Idempotency-Key': key } });   // a double click or retry creates it once
    toast(t('schedules.created')); setF(blank); setPv(null); setKey(newKey()); onCreated();
  }); }}>
    <h2>{t('schedules.new')}</h2><p className="note">{t('schedules.newText')}</p>
    <div className="grid3">
      <label>{t('schedules.name')}<input required maxLength={160} value={f.name} onChange={(e) => set({ name: e.target.value })} /></label>
      <label>{t('schedules.type')}<select value={f.scheduleType} onChange={(e) => set({ scheduleType: e.target.value as Form['scheduleType'] })}><option value="once">{t('schedules.once')}</option><option value="recurring">{t('schedules.recurring')}</option></select></label>
      {orgs.data && orgs.data.length > 1 ? <label>{t('schedules.org')}<select value={orgId} onChange={(e) => set({ organizationId: e.target.value })}>{orgs.data.map((o) => <option key={o.id} value={o.id}>{o.kind === 'personal' ? t('schedules.personal') : o.name}</option>)}</select></label> : null}
    </div>
    <div className="grid3">
      <ZoneInput label={t('convert.zone')} value={f.timeZone} onChange={(v) => set({ timeZone: v })} />
      <label>{f.scheduleType === 'once' ? t('convert.date') : t('schedules.startDate')}<input type="date" required value={f.startDate} onChange={(e) => set({ startDate: e.target.value })} /></label>
      <label>{t('schedules.localTime')}<input type="time" required value={f.localTime} onChange={(e) => set({ localTime: e.target.value })} /></label>
    </div>
    {f.scheduleType === 'recurring' ? <div className="grid3">
      <label>{t('schedules.repeat')}<select value={f.freq} onChange={(e) => set({ freq: e.target.value })}>{['HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY', 'CUSTOM'].map((x) => <option key={x} value={x}>{t(`freq.${x}`)}</option>)}</select></label>
      {f.freq !== 'CUSTOM' ? <label>{t('schedules.every')}<input type="number" min={1} max={366} value={f.interval} onChange={(e) => set({ interval: Math.max(1, Number(e.target.value) || 1) })} /></label>
        : <label>{t('schedules.rule')}<input required className="mono" placeholder="FREQ=MONTHLY;BYDAY=1MO" value={f.rule} onChange={(e) => set({ rule: e.target.value.toUpperCase() })} /></label>}
      {f.freq === 'WEEKLY' ? <fieldset><legend>{t('schedules.days')}</legend><div className="row">{DAYS.map((d) => <label key={d} className="check"><input type="checkbox" checked={f.days.includes(d)}
        onChange={(e) => set({ days: e.target.checked ? [...f.days, d] : f.days.filter((x) => x !== d) })} />{t(`day.${d}`)}</label>)}</div></fieldset> : null}
    </div> : null}
    <div className="grid2">
      <label>{t('dst.gap')}<select value={f.dstGapPolicy} onChange={(e) => set({ dstGapPolicy: e.target.value })}><option value="shift_forward">{t('dst.gap.shift_forward')}</option><option value="skip">{t('dst.gap.skip')}</option></select></label>
      <label>{t('dst.overlap')}<select value={f.dstOverlapPolicy} onChange={(e) => set({ dstOverlapPolicy: e.target.value })}><option value="first">{t('dst.overlap.first')}</option><option value="second">{t('dst.overlap.second')}</option></select></label>
    </div>
    <div className="grid3">
      <label>{t('schedules.action')}<select value={f.actionType} onChange={(e) => set({ actionType: e.target.value })}><option value="record">{t('action.record')}</option><option value="email">{t('action.email')}</option>
        <option value="webhook" disabled={!orgHooks.length}>{t('action.webhook')}</option></select></label>
      {f.actionType === 'email' ? <label>{t('schedules.emailTo')}<input type="email" required maxLength={320} value={f.emailTo} onChange={(e) => set({ emailTo: e.target.value })} /></label> : null}
      {f.actionType === 'webhook' ? <label>{t('schedules.endpoint')}<select required value={f.webhookEndpointId} onChange={(e) => set({ webhookEndpointId: e.target.value })}><option value="">{t('common.choose')}</option>
        {orgHooks.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}</select></label> : null}
      <label>{t('schedules.message')}<input maxLength={500} value={f.message} onChange={(e) => set({ message: e.target.value })} /></label>
    </div>
    <p className="note">{t(`action.${f.actionType}.text`)}</p>
    <ErrorText text={p.err || a.err} />
    <div className="row">
      <button type="button" className="btn btn--ghost" disabled={p.busy} onClick={() => p.run(async () => setPv(await api('POST', '/schedules/preview', { ...intentOf(f), count: 8 })))}>{t('schedules.preview')}</button>
      <button className="btn" disabled={a.busy}>{t('schedules.create')}</button>
    </div>
    {pv ? <div className="stack-sm" aria-live="polite"><h3>{t('schedules.nextRuns')}</h3><Occurrences list={pv.occurrences} zone={pv.timeZone} /><p className="note">{t('convert.ruleset', { v: pv.rulesetVersion })}</p></div> : null}
  </form>;
}

function Detail({ id, onChange }: { id: string; onChange: () => void }) {
  const s = useLoad(() => api<any>('GET', `/schedules/${id}`), [id]);
  const ex = useLoad(() => api<any[]>(`GET`, `/schedules/${id}/executions`), [id]);
  const a = useAction();
  if (!s.data) return <Loading />;
  const j = s.data;
  const act = (fn: () => Promise<unknown>) => a.run(async () => { await fn(); s.reload(); ex.reload(); onChange(); });
  return <section className="panel stack-sm" aria-labelledby="sd-h">
    <div className="row row--between"><h2 id="sd-h">{j.name}</h2><Badge kind={j.status}>{t(`sstatus.${j.status}`)}</Badge></div>
    <dl className="facts">
      <div><dt>{t('schedules.intent')}</dt><dd>{j.localTime} {j.timeZone}</dd></div>
      <div><dt>{t('schedules.rule')}</dt><dd className="mono">{j.recurrenceRule || t('schedules.once')}</dd></div>
      <div><dt>{t('schedules.next')}</dt><dd>{j.nextRunAt ? fmtIn(j.nextRunAt, j.timeZone, { dateStyle: 'medium', timeStyle: 'long' }) : '—'}</dd></div>
      <div><dt>{t('schedules.action')}</dt><dd>{t(`action.${j.actionType}`)}{j.emailTo ? ` · ${j.emailTo}` : ''}</dd></div>
      <div><dt>{t('dst.policies')}</dt><dd>{t(`dst.gap.${j.dstGapPolicy}`)}; {t(`dst.overlap.${j.dstOverlapPolicy}`)}</dd></div>
      <div><dt>{t('health.rulesets')}</dt><dd>{j.rulesetVersion || '—'}</dd></div>
    </dl>
    {j.upcoming?.length ? <><h3>{t('schedules.nextRuns')}</h3><Occurrences list={j.upcoming} zone={j.timeZone} /></> : null}
    <ErrorText text={a.err} />
    <div className="row">
      {j.status === 'active' ? <button className="btn btn--small btn--ghost" disabled={a.busy} onClick={() => act(() => api('PATCH', `/schedules/${id}`, { status: 'paused', version: j.version }))}>{t('schedules.pause')}</button> : null}
      {j.status === 'paused' ? <button className="btn btn--small" disabled={a.busy} onClick={() => act(() => api('PATCH', `/schedules/${id}`, { status: 'active', version: j.version }))}>{t('schedules.resume')}</button> : null}
      {['active', 'paused'].includes(j.status) ? <button className="btn btn--small btn--ghost link--danger" disabled={a.busy} onClick={() => { if (window.confirm(t('schedules.cancelConfirm', { name: j.name }))) void act(() => api('DELETE', `/schedules/${id}`)); }}>{t('schedules.cancel')}</button> : null}
    </div>
    <h3>{t('schedules.history')}</h3>
    {!ex.data ? <Loading /> : !ex.data.length ? <Empty text={t('schedules.noRuns')} /> : <div className="tablewrap"><table className="table"><thead><tr><th>{t('exec.for')}</th><th>{t('exec.status')}</th><th>{t('exec.attempt')}</th><th>{t('exec.lateness')}</th><th>{t('exec.result')}</th></tr></thead>
      <tbody>{ex.data.map((e) => <tr key={e.id}><td>{fmtIn(e.scheduledFor, j.timeZone, { dateStyle: 'medium', timeStyle: 'short' })}</td><td><Badge kind={e.status}>{t(`exec.${e.status}`)}</Badge></td><td>{e.attempt}</td>
        <td>{e.latenessMs != null ? `${Math.round(e.latenessMs / 100) / 10} s` : '—'}</td><td className="mono">{e.resultCode || '—'}</td></tr>)}</tbody></table></div>}
  </section>;
}

export function Schedules() {
  useI18n();
  const [status, setStatus] = useState(''); const [open, setOpen] = useState<string | null>(null); const [creating, setCreating] = useState(false);
  const list = useLoad(() => api<any[]>('GET', `/schedules${status ? `?status=${status}` : ''}`), [status]);
  const rows = useMemo(() => list.data || [], [list.data]);
  return <Page title={t('nav.schedules')} actions={<button className="btn btn--small" onClick={() => setCreating((x) => !x)}>{creating ? t('common.close') : t('schedules.new')}</button>}>
    {creating ? <Create onCreated={() => { setCreating(false); list.reload(); }} /> : null}
    <label className="inline">{t('schedules.filter')}<select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">{t('schedules.all')}</option>
      {['active', 'paused', 'completed', 'failed'].map((s) => <option key={s} value={s}>{t(`sstatus.${s}`)}</option>)}</select></label>
    {list.err ? <ErrorText text={list.err} /> : !list.data ? <Loading /> : !rows.length ? <Empty text={t('schedules.none')} /> :
      <div className="tablewrap"><table className="table"><thead><tr><th>{t('schedules.name')}</th><th>{t('schedules.intent')}</th><th>{t('schedules.next')}</th><th>{t('schedules.last')}</th><th>{t('exec.status')}</th></tr></thead>
        <tbody>{rows.map((s) => <tr key={s.id}><td><button className="link" aria-expanded={open === s.id} onClick={() => setOpen(open === s.id ? null : s.id)}>{s.name}</button><div className="note">{s.organizationName}</div></td>
          <td>{s.localTime} · {s.timeZone}<div className="note mono">{s.recurrenceRule || t('schedules.once')}</div></td>
          <td>{s.nextRunAt ? fmtIn(s.nextRunAt, s.timeZone, { dateStyle: 'medium', timeStyle: 'short' }) : '—'}</td>
          <td>{s.lastRunAt ? fmtDateTime(s.lastRunAt) : '—'}{s.lastResult ? <> <Badge kind={s.lastResult}>{t(`exec.${s.lastResult}`)}</Badge></> : null}</td>
          <td><Badge kind={s.status}>{t(`sstatus.${s.status}`)}</Badge></td></tr>)}</tbody></table></div>}
    {open ? <Detail id={open} onChange={list.reload} /> : null}
  </Page>;
}
