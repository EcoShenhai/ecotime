import { useEffect, useMemo, useState } from 'react';
import { t, useI18n } from '../i18n';
import { api } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import { loadZones, deviceZone } from '../lib/time';
import { useLoad, Page, Loading, ErrorText, Badge, Empty } from '../components/ui';

// IANA zones by territory: a country with several zones lists them all, and the person chooses (§12.5).
export function Zones() {
  useI18n();
  const terr = useLoad(() => api<any[]>('GET', '/territories'), []);
  const ver = useLoad(() => api<any>('GET', '/time-zones/version'), []);
  const [all, setAll] = useState<{ id: string; currentOffset: string }[] | null>(null); const [err, setErr] = useState('');
  useEffect(() => { loadZones().then(setAll).catch(() => setErr(t('error.generic'))); }, []);
  const [q, setQ] = useState(''); const [territory, setTerritory] = useState(''); const [sel, setSel] = useState(deviceZone());
  const info = useLoad(() => api<any>('GET', `/time-zones/${sel.split('/').map(encodeURIComponent).join('/')}`), [sel]);
  const shown = useMemo(() => {
    let z = all || [];
    if (territory) { const tz = new Set<string>((terr.data || []).find((x) => x.code === territory)?.timeZones || []); z = z.filter((x) => tz.has(x.id)); }
    if (q) { const s = q.toLowerCase().replace(/\s+/g, '_'); z = z.filter((x) => x.id.toLowerCase().includes(s) || `utc${x.currentOffset}`.includes(s)); }
    return z.slice(0, 200);
  }, [all, q, territory, terr.data]);
  return <Page title={t('nav.zones')}>
    <p className="note">{t('zones.text')}{ver.data ? ` ${t('convert.ruleset', { v: ver.data.runtime })}` : ''}</p>
    <div className="grid2">
      <label>{t('zones.search')}<input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nairobi" /></label>
      <label>{t('zones.territory')}<select value={territory} onChange={(e) => setTerritory(e.target.value)}><option value="">{t('zones.allTerritories')}</option>
        {(terr.data || []).map((x) => <option key={x.code} value={x.code}>{x.name} ({x.timeZones.length})</option>)}</select></label>
    </div>
    <ErrorText text={err || info.err} />
    {info.data ? <section className="panel stack-sm" aria-live="polite">
      <div className="row row--between"><h2 className="mono">{info.data.id}</h2><span>UTC{info.data.currentOffset} · {info.data.abbreviation}</span></div>
      <p>{info.data.observesDst ? t('zones.dst') : t('zones.noDst')}</p>
      {info.data.nextTransitions.length ? <ul className="list">{info.data.nextTransitions.map((x: any) => <li key={x.at} className="list__item"><span>{fmtDateTime(x.at)}</span><span className="mono">UTC{x.fromOffset} → UTC{x.toOffset}</span></li>)}</ul> : null}
    </section> : null}
    {!all ? <Loading /> : !shown.length ? <Empty text={t('zones.none')} /> :
      <div className="tablewrap"><table className="table"><thead><tr><th>{t('zones.zone')}</th><th>{t('zones.offset')}</th><th></th></tr></thead>
        <tbody>{shown.map((z) => <tr key={z.id}><td className="mono">{z.id}</td><td className="mono">UTC{z.currentOffset}</td>
          <td>{z.id === sel ? <Badge kind="info">{t('zones.shown')}</Badge> : <button className="link" onClick={() => setSel(z.id)}>{t('zones.details')}</button>}</td></tr>)}</tbody></table></div>}
  </Page>;
}
