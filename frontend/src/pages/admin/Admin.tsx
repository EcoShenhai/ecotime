import { useState } from 'react';
import { t, useI18n } from '../../i18n';
import { api } from '../../lib/api';
import { fmtDate, fmtDateTime } from '../../lib/format';
import { fmtMs } from '../../lib/time';
import { useLoad, useAction, Loading, ErrorText, Badge, Empty, Page } from '../../components/ui';
import { toast } from '../../components/Toast';
import { HealthPanel } from '../Now';

const SCOPES = ['time:read', 'time:convert', 'schedules:read', 'schedules:write'];
const useOrgs = () => useLoad(() => api<any[]>('GET', '/admin/organizations'), []);
const OrgSelect = ({ value, onChange, list }: { value: string; onChange: (v: string) => void; list: any[] | null }) =>
  <label>{t('orgs.org')}<select required value={value} onChange={(e) => onChange(e.target.value)}><option value="">{t('common.choose')}</option>
    {(list || []).filter((o) => o.status === 'active').map((o) => <option key={o.id} value={o.id}>{o.name}{o.kind === 'personal' ? ` (${t('orgKind.personal')})` : ''}</option>)}</select></label>;

function SecretOnce({ label, value, onDone }: { label: string; value: string; onDone: () => void }) {
  return <div className="panel stack-sm keyonce" role="status"><strong>{label}</strong><code className="secret">{value}</code>
    <div className="row"><button className="btn btn--small" onClick={async () => { try { await navigator.clipboard.writeText(value); toast(t('common.copied')); } catch { /* copy by hand */ } }}>{t('common.copy')}</button>
      <button className="link" onClick={onDone}>{t('clients.done')}</button></div></div>;
}

// Clock and time sources: what the host clock is doing, where it gets time from, and the tz rulesets in use (§8, §9).
export function AdminClock() {
  useI18n();
  const st = useLoad(() => api<any>('GET', '/sources/status'), []);
  const obs = useLoad(() => api<any[]>('GET', '/admin/clock/observations?hours=24'), []);
  const rs = useLoad(() => api<any[]>('GET', '/admin/rulesets'), []);
  const a = useAction();
  const [f, setF] = useState({ hostLabel: '', operator: '', tier: 2, authenticated: false, notes: '' });
  return <Page title={t('admin.nav.clock')} actions={<button className="btn btn--small btn--ghost" onClick={() => { st.reload(); obs.reload(); }}>{t('common.refresh')}</button>}>
    {st.err ? <ErrorText text={st.err} /> : !st.data ? <Loading /> : <>
      <HealthPanel h={st.data.clockHealth} rulesets={st.data.rulesets} />
      {st.data.clockHealth.diversity === 'single_source' ? <div className="state state--unavailable"><strong>{t('sources.singleTitle')}</strong><span>{t('sources.singleText')}</span></div> : null}
      <section className="stack-sm"><h2>{t('sources.title')}</h2><p className="note">{t('sources.text')}</p>
        <div className="tablewrap"><table className="table"><thead><tr><th>{t('sources.host')}</th><th>{t('sources.operator')}</th><th>{t('sources.tier')}</th><th>{t('sources.auth')}</th><th>{t('data.status')}</th><th></th></tr></thead>
          <tbody>{st.data.sources.map((s: any) => <tr key={s.id}><td className="mono">{s.hostLabel}{s.notes ? <div className="note">{s.notes}</div> : null}</td><td>{s.operator}</td><td>{s.tier}</td><td>{s.authenticated ? t('common.yes') : t('common.no')}</td>
            <td><Badge kind={s.active ? 'active' : 'cancelled'}>{s.active ? t('sources.active') : t('sources.inactive')}</Badge></td>
            <td>{s.active ? <button className="link" disabled={a.busy} onClick={() => a.run(async () => { await api('POST', `/admin/sources/${s.id}/deactivate`); st.reload(); })}>{t('sources.deactivate')}</button> : null}</td></tr>)}</tbody></table></div>
        <form className="panel stack-sm form" onSubmit={(e) => { e.preventDefault(); void a.run(async () => { await api('POST', '/admin/sources', { ...f, notes: f.notes || null }); setF({ ...f, hostLabel: '', operator: '', notes: '' }); st.reload(); toast(t('common.saved')); }); }}>
          <h3>{t('sources.add')}</h3><p className="note">{t('sources.addText')}</p>
          <div className="grid3">
            <label>{t('sources.host')}<input required maxLength={160} value={f.hostLabel} onChange={(e) => setF({ ...f, hostLabel: e.target.value })} placeholder="time.cloudflare.com" /></label>
            <label>{t('sources.operator')}<input required maxLength={160} value={f.operator} onChange={(e) => setF({ ...f, operator: e.target.value })} /></label>
            <label>{t('sources.tier')}<input type="number" min={1} max={4} value={f.tier} onChange={(e) => setF({ ...f, tier: Number(e.target.value) })} /></label>
          </div>
          <label className="check"><input type="checkbox" checked={f.authenticated} onChange={(e) => setF({ ...f, authenticated: e.target.checked })} />{t('sources.authLabel')}</label>
          <label>{t('sources.notes')}<input maxLength={500} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></label>
          <ErrorText text={a.err} /><button className="btn" disabled={a.busy}>{t('common.save')}</button>
        </form>
      </section>
      <section className="stack-sm"><h2>{t('events.title')}</h2>
        {!st.data.events.length ? <Empty text={t('events.none')} /> : <div className="tablewrap"><table className="table"><thead><tr><th>{t('audit.when')}</th><th>{t('events.kind')}</th><th>{t('events.change')}</th><th>{t('events.detail')}</th></tr></thead>
          <tbody>{st.data.events.map((e: any) => <tr key={e.id}><td>{fmtDateTime(e.occurredAt)}</td><td>{t(`event.${e.kind}`)}</td><td>{e.fromState || e.toState ? `${e.fromState || '—'} → ${e.toState || '—'}` : '—'}</td>
            <td className="note">{e.detail ? Object.entries(e.detail).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ') : ''}</td></tr>)}</tbody></table></div>}
      </section>
    </>}
    <section className="stack-sm"><h2>{t('obs.title')}</h2><p className="note">{t('obs.text')}</p>
      {!obs.data ? <Loading /> : !obs.data.length ? <Empty text={t('obs.none')} /> : <div className="tablewrap"><table className="table"><thead><tr><th>{t('audit.when')}</th><th>{t('exec.status')}</th><th>{t('health.offset')}</th><th>{t('health.rootDistance')}</th><th>{t('health.source')}</th></tr></thead>
        <tbody>{obs.data.slice(0, 100).map((o, i) => <tr key={i}><td>{fmtDateTime(o.observedAt)}</td><td><Badge kind={o.state}>{t(`clock.${o.state}`)}</Badge></td><td>{fmtMs(o.offsetUs != null ? o.offsetUs / 1000 : null)}</td>
          <td>{fmtMs(o.rootDistanceUs != null ? o.rootDistanceUs / 1000 : null)}</td><td className="mono">{o.server || '—'}{o.stratum != null ? ` · ${o.stratum}` : ''}</td></tr>)}</tbody></table></div>}
    </section>
    <section className="stack-sm"><h2>{t('rulesets.title')}</h2><p className="note">{t('rulesets.text')}</p>
      {!rs.data ? <Loading /> : !rs.data.length ? <Empty text={t('rulesets.none')} /> : <div className="tablewrap"><table className="table"><thead><tr><th>{t('audit.when')}</th><th>{t('health.runtime')}</th><th>{t('health.os')}</th><th>{t('rulesets.recomputed')}</th></tr></thead>
        <tbody>{rs.data.map((r, i) => <tr key={i}><td>{fmtDateTime(r.deployedAt)}</td><td className="mono">{r.runtimeVersion}</td><td className="mono">{r.osVersion || '—'}</td><td>{r.recomputedSchedules ?? 0}</td></tr>)}</tbody></table></div>}
    </section>
  </Page>;
}

export function AdminOrgs() {
  useI18n();
  const list = useOrgs(); const a = useAction();
  const [f, setF] = useState({ name: '', kind: 'app', maxSchedules: 500 });
  return <Page title={t('admin.nav.orgs')}>
    <form className="panel stack form" onSubmit={(e) => { e.preventDefault(); void a.run(async () => { await api('POST', '/admin/organizations', f); setF({ ...f, name: '' }); list.reload(); toast(t('common.saved')); }); }}>
      <h2>{t('orgs.add')}</h2><p className="note">{t('orgs.text')}</p>
      <div className="grid3">
        <label>{t('orgs.name')}<input required maxLength={120} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="EcoOffice" /></label>
        <label>{t('orgs.kind')}<select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="app">{t('orgKind.app')}</option><option value="team">{t('orgKind.team')}</option></select></label>
        <label>{t('orgs.limit')}<input type="number" min={1} max={100000} value={f.maxSchedules} onChange={(e) => setF({ ...f, maxSchedules: Number(e.target.value) })} /></label>
      </div>
      <ErrorText text={a.err} /><button className="btn" disabled={a.busy}>{t('orgs.create')}</button>
    </form>
    {!list.data ? <Loading /> : !list.data.length ? <Empty text={t('orgs.none')} /> : <div className="tablewrap"><table className="table"><thead><tr><th>{t('orgs.name')}</th><th>{t('orgs.kind')}</th><th>{t('orgs.members')}</th><th>{t('nav.schedules')}</th><th>{t('admin.nav.keys')}</th><th>{t('data.status')}</th><th></th></tr></thead>
      <tbody>{list.data.map((o) => <tr key={o.id}><td>{o.name}<div className="note">{fmtDate(o.createdAt)}</div></td><td>{t(`orgKind.${o.kind}`)}</td><td>{o.members}</td><td>{o.schedules} / {o.maxSchedules}</td><td>{o.apiClients}</td>
        <td><Badge kind={o.status}>{t(`orgStatus.${o.status}`)}</Badge></td>
        <td className="row"><button className="link" disabled={a.busy} onClick={() => { const v = window.prompt(t('orgs.limitPrompt'), String(o.maxSchedules)); const n = Number(v); if (v && Number.isInteger(n) && n > 0) void a.run(async () => { await api('PATCH', `/admin/organizations/${o.id}`, { maxSchedules: n }); list.reload(); }); }}>{t('orgs.changeLimit')}</button>
          <button className={`link${o.status === 'active' ? ' link--danger' : ''}`} disabled={a.busy} onClick={() => a.run(async () => { await api('PATCH', `/admin/organizations/${o.id}`, { status: o.status === 'active' ? 'suspended' : 'active' }); list.reload(); })}>{o.status === 'active' ? t('orgs.suspend') : t('orgs.reactivate')}</button></td></tr>)}</tbody></table></div>}
  </Page>;
}

export function AdminKeys() {
  useI18n();
  const orgs = useOrgs(); const list = useLoad(() => api<any[]>('GET', '/admin/api-clients'), []); const a = useAction();
  const [f, setF] = useState({ organizationId: '', name: '', appCode: '', scopes: ['time:read', 'time:convert'] as string[], expiresInDays: '' }); const [key, setKey] = useState<string | null>(null);
  return <Page title={t('admin.nav.keys')}>
    <form className="panel stack form" onSubmit={(e) => { e.preventDefault(); void a.run(async () => {
      const r = await api<any>('POST', '/admin/api-clients', { organizationId: f.organizationId, name: f.name, appCode: f.appCode, scopes: f.scopes, expiresInDays: f.expiresInDays ? Number(f.expiresInDays) : null });
      setKey(r.apiKey); setF({ ...f, name: '', appCode: '' }); list.reload(); }); }}>
      <h2>{t('clients.add')}</h2><p className="note">{t('clients.text')}</p>
      <div className="grid2">
        <OrgSelect value={f.organizationId} onChange={(v) => setF({ ...f, organizationId: v })} list={orgs.data} />
        <label>{t('clients.name')}<input required maxLength={120} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="EcoOffice calendar" /></label>
        <label>{t('clients.appCode')}<input required pattern="[A-Z0-9_]{2,40}" value={f.appCode} onChange={(e) => setF({ ...f, appCode: e.target.value.toUpperCase() })} placeholder="ECOOFFICE" /></label>
        <label>{t('clients.expires')}<input type="number" min={1} max={3650} value={f.expiresInDays} onChange={(e) => setF({ ...f, expiresInDays: e.target.value })} placeholder={t('clients.never')} /></label>
      </div>
      <fieldset><legend>{t('clients.scopes')}</legend><div className="row">{SCOPES.map((s) => <label key={s} className="check"><input type="checkbox" checked={f.scopes.includes(s)} onChange={(e) => setF({ ...f, scopes: e.target.checked ? [...f.scopes, s] : f.scopes.filter((x) => x !== s) })} /><code>{s}</code></label>)}</div></fieldset>
      <ErrorText text={a.err} />
      <button className="btn" disabled={a.busy || !f.scopes.length}>{t('clients.create')}</button>
    </form>
    {key ? <SecretOnce label={t('clients.keyOnce')} value={key} onDone={() => setKey(null)} /> : null}
    {!list.data ? <Loading /> : !list.data.length ? <Empty text={t('clients.none')} /> : <div className="tablewrap"><table className="table"><thead><tr><th>{t('clients.name')}</th><th>{t('orgs.org')}</th><th>{t('clients.scopes')}</th><th>{t('clients.lastUsed')}</th><th>{t('data.status')}</th><th></th></tr></thead>
      <tbody>{list.data.map((c) => <tr key={c.id}><td>{c.name}<div className="note mono">{c.appCode} · etk_{c.keyPrefix || '—'}_…</div></td><td>{c.organizationName}</td><td className="mono">{c.scopes.join(' ')}</td><td>{fmtDateTime(c.lastUsedAt)}</td>
        <td><Badge kind={c.status}>{t(`clientStatus.${c.status}`)}</Badge></td>
        <td className="row">{c.status === 'active' ? <><button className="link" disabled={a.busy} onClick={() => a.run(async () => { const r = await api<any>('POST', `/admin/api-clients/${c.id}/rotate`); setKey(r.apiKey); list.reload(); })}>{t('clients.rotate')}</button>
          <button className="link link--danger" disabled={a.busy} onClick={() => { if (window.confirm(t('clients.revokeConfirm', { name: c.name }))) void a.run(async () => { await api('POST', `/admin/api-clients/${c.id}/revoke`); list.reload(); }); }}>{t('clients.revoke')}</button></> : null}</td></tr>)}</tbody></table></div>}
  </Page>;
}

export function AdminWebhooks() {
  useI18n();
  const orgs = useOrgs(); const list = useLoad(() => api<any[]>('GET', '/webhooks'), []); const a = useAction();
  const [f, setF] = useState({ organizationId: '', name: '', url: '' }); const [secret, setSecret] = useState<string | null>(null);
  return <Page title={t('admin.nav.webhooks')}>
    <form className="panel stack form" onSubmit={(e) => { e.preventDefault(); void a.run(async () => { const r = await api<any>('POST', '/admin/webhooks', f); setSecret(r.secret); setF({ ...f, name: '', url: '' }); list.reload(); }); }}>
      <h2>{t('webhooks.add')}</h2><p className="note">{t('webhooks.text')}</p>
      <div className="grid3">
        <OrgSelect value={f.organizationId} onChange={(v) => setF({ ...f, organizationId: v })} list={orgs.data} />
        <label>{t('webhooks.name')}<input required maxLength={120} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <label>{t('webhooks.url')}<input type="url" required maxLength={500} pattern="https://.*" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} placeholder="https://office.eshcloud.com/hooks/ecotime" /></label>
      </div>
      <ErrorText text={a.err} /><button className="btn" disabled={a.busy}>{t('webhooks.create')}</button>
    </form>
    {secret ? <SecretOnce label={t('webhooks.secretOnce')} value={secret} onDone={() => setSecret(null)} /> : null}
    <details className="panel"><summary>{t('webhooks.verifyTitle')}</summary><p className="note">{t('webhooks.verifyText')}</p>
      <pre className="briefing mono">{'X-EcoTime-Signature: t=<unix>,v1=<hex>\nv1 = HMAC_SHA256(secret, "<t>.<raw body>")\nX-EcoTime-Idempotency-Key: <same for every attempt of one occurrence>'}</pre></details>
    {!list.data ? <Loading /> : !list.data.length ? <Empty text={t('webhooks.none')} /> : <div className="tablewrap"><table className="table"><thead><tr><th>{t('webhooks.name')}</th><th>{t('orgs.org')}</th><th>{t('webhooks.url')}</th><th>{t('data.status')}</th><th></th></tr></thead>
      <tbody>{list.data.map((w) => <tr key={w.id}><td>{w.name}<div className="note">{fmtDate(w.createdAt)}</div></td><td>{w.organizationName}</td><td className="mono">{w.url}</td><td><Badge kind={w.status}>{t(`whStatus.${w.status}`)}</Badge></td>
        <td>{w.status === 'active' ? <button className="link link--danger" disabled={a.busy} onClick={() => { if (window.confirm(t('webhooks.disableConfirm', { name: w.name }))) void a.run(async () => { await api('POST', `/admin/webhooks/${w.id}/disable`); list.reload(); }); }}>{t('webhooks.disable')}</button> : null}</td></tr>)}</tbody></table></div>}
  </Page>;
}

export function AdminSchedules() {
  useI18n();
  const list = useLoad(() => api<any[]>('GET', '/admin/schedules'), []);
  const rows = list.data || [];
  const late = rows.filter((s) => s.avgLatenessMs != null && s.avgLatenessMs > 60000).length;
  return <Page title={t('admin.nav.schedules')} actions={<button className="btn btn--small btn--ghost" onClick={list.reload}>{t('common.refresh')}</button>}>
    <p className="note">{t('adminSchedules.text')}</p>
    {list.data ? <div className="stats">
      <div className="stat"><span className="stat__value">{rows.filter((s) => s.status === 'active').length}</span><span className="stat__label">{t('sstatus.active')}</span></div>
      <div className="stat"><span className="stat__value">{rows.filter((s) => s.status === 'paused').length}</span><span className="stat__label">{t('sstatus.paused')}</span></div>
      <div className={`stat${rows.some((s) => s.lastResult === 'failed') ? ' stat--danger' : ''}`}><span className="stat__value">{rows.filter((s) => s.lastResult === 'failed').length}</span><span className="stat__label">{t('adminSchedules.lastFailed')}</span></div>
      <div className={`stat${late ? ' stat--warn' : ''}`}><span className="stat__value">{late}</span><span className="stat__label">{t('adminSchedules.late')}</span></div>
    </div> : null}
    {!list.data ? <Loading /> : !rows.length ? <Empty text={t('schedules.none')} /> : <div className="tablewrap"><table className="table"><thead><tr><th>{t('schedules.name')}</th><th>{t('orgs.org')}</th><th>{t('schedules.intent')}</th><th>{t('schedules.next')}</th><th>{t('exec.lateness')}</th><th>{t('schedules.last')}</th><th>{t('exec.status')}</th></tr></thead>
      <tbody>{rows.map((s) => <tr key={s.id}><td>{s.name}<div className="note">{t(`action.${s.actionType}`)}</div></td><td>{s.organizationName}</td><td>{s.localTime} · {s.timeZone}<div className="note mono">{s.recurrenceRule || t('schedules.once')}</div></td>
        <td>{fmtDateTime(s.nextRunAt)}</td><td>{s.avgLatenessMs != null ? `${Math.round(s.avgLatenessMs / 100) / 10} s` : '—'}</td>
        <td>{s.lastResult ? <Badge kind={s.lastResult}>{t(`exec.${s.lastResult}`)}</Badge> : '—'}</td><td><Badge kind={s.status}>{t(`sstatus.${s.status}`)}</Badge></td></tr>)}</tbody></table></div>}
  </Page>;
}

export function AdminUsers() {
  useI18n();
  const list = useLoad(() => api<any[]>('GET', '/admin/users'), []); const a = useAction();
  return <Page title={t('admin.nav.users')}>
    <p className="note">{t('users.text')}</p><ErrorText text={a.err} />
    {!list.data ? <Loading /> : !list.data.length ? <Empty text={t('users.none')} /> : <div className="tablewrap"><table className="table"><thead><tr><th>{t('users.name')}</th><th>{t('settings.language')}</th><th>{t('settings.zone')}</th><th>{t('settings.orgs')}</th><th>{t('users.lastSeen')}</th><th>{t('data.status')}</th><th></th></tr></thead>
      <tbody>{list.data.map((u) => <tr key={u.id}><td>{u.displayName || t('users.unnamed')}<div className="note">{fmtDate(u.createdAt)}</div></td><td>{u.preferredLanguage}</td><td className="mono">{u.preferredTimeZone || '—'}</td><td>{u.organizations || '—'}</td><td>{fmtDateTime(u.lastSeenAt)}</td>
        <td><Badge kind={u.status}>{t(`userStatus.${u.status}`)}</Badge></td>
        <td><button className="link" disabled={a.busy} onClick={() => a.run(async () => { await api('PATCH', `/admin/users/${u.id}`, { status: u.status === 'active' ? 'disabled' : 'active' }); list.reload(); })}>{u.status === 'active' ? t('users.disable') : t('users.enable')}</button></td></tr>)}</tbody></table></div>}
  </Page>;
}

export function AdminActivity() {
  useI18n();
  const audit = useLoad(() => api<any[]>('GET', '/audit/events?limit=200'), []);
  return <Page title={t('admin.nav.activity')}>
    <p className="note">{t('activity.text')}</p>
    {!audit.data ? <Loading /> : !audit.data.length ? <Empty text={t('activity.none')} /> : <div className="tablewrap"><table className="table"><thead><tr><th>{t('audit.when')}</th><th>{t('audit.who')}</th><th>{t('audit.action')}</th><th>{t('audit.subject')}</th></tr></thead>
      <tbody>{audit.data.map((r) => <tr key={r.id}><td>{fmtDateTime(r.at)}</td><td>{r.actorName || r.actorKind}</td><td><code>{r.action}</code></td><td>{r.subjectKind ? `${r.subjectKind} ${String(r.subjectId || '').slice(0, 8)}` : '—'}</td></tr>)}</tbody></table></div>}
  </Page>;
}
