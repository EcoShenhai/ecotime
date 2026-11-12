import { useEffect, useId, useState } from 'react';
import { t } from '../i18n';
import { loadZones } from '../lib/time';

// IANA zone picker: a text field with suggestions. Fixed offsets such as +03:00 are not zones and the server refuses them.
export function ZoneInput({ label, value, onChange, required = true }: { label: string; value: string; onChange: (v: string) => void; required?: boolean }) {
  const id = useId(); const [list, setList] = useState<{ id: string; currentOffset: string }[]>([]);
  useEffect(() => { loadZones().then(setList).catch(() => setList([])); }, []);
  const known = !value || list.length === 0 || list.some((z) => z.id === value) || value === 'UTC';
  return <label>{label}
    <input list={id} required={required} value={value} spellCheck={false} autoComplete="off" placeholder="Africa/Nairobi" onChange={(e) => onChange(e.target.value.trim())} aria-invalid={!known} />
    <datalist id={id}>{list.map((z) => <option key={z.id} value={z.id}>{`UTC${z.currentOffset}`}</option>)}</datalist>
    {!known ? <span className="note error">{t('zone.unknown')}</span> : null}
  </label>;
}
