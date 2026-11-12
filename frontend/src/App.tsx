import { useEffect, type ReactElement } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useI18n, setLanguage, detectLanguage } from './i18n';
import { useSession, restoreSession } from './lib/session';
import { PersonLayout, AdminLayout } from './components/Layout';
import { Loading } from './components/ui';
import { Welcome, EcoIdCallback, Privacy } from './pages/Public';
import { Now } from './pages/Now';
import { Convert } from './pages/Convert';
import { Schedules } from './pages/Schedules';
import { Zones } from './pages/Zones';
import { Settings, Support } from './pages/Account';
import { AdminLogin } from './pages/admin/Login';
import { AdminClock, AdminOrgs, AdminKeys, AdminWebhooks, AdminSchedules, AdminUsers, AdminActivity } from './pages/admin/Admin';

function Gate({ kind, children }: { kind: 'person' | 'admin'; children: ReactElement }) {
  const s = useSession(); const loc = useLocation();
  if (s.restoring) return <div className="lockwrap"><Loading /></div>;
  if (!s.access) return kind === 'admin' ? <Navigate to="/admin/login" replace /> : <Welcome returnTo={loc.pathname + loc.search} />;
  if (!s.info) return <div className="lockwrap"><Loading /></div>;
  if (s.info.kind !== kind) return <Navigate to={s.info.kind === 'admin' ? '/admin' : '/'} replace />;
  return children;
}

export function App() {
  useI18n(); const s = useSession();
  useEffect(() => {
    void setLanguage(detectLanguage(localStorage.getItem('ecotime_lang')));
    void restoreSession();
    const on = () => { void restoreSession(); };
    window.addEventListener('online', on); return () => window.removeEventListener('online', on);
  }, []);
  useEffect(() => { const l = s.info?.preferredLanguage; if (l && !localStorage.getItem('ecotime_lang')) void setLanguage(l); }, [s.info?.preferredLanguage]);
  return <BrowserRouter>
    <Routes>
      <Route path="/auth/ecoid/callback" element={<EcoIdCallback />} />
      <Route path="/admin/login" element={<AdminLogin />} />
      <Route path="/privacy" element={<Privacy />} />
      <Route element={<Gate kind="admin"><AdminLayout /></Gate>}>
        <Route path="/admin" element={<AdminClock />} />
        <Route path="/admin/organizations" element={<AdminOrgs />} />
        <Route path="/admin/keys" element={<AdminKeys />} />
        <Route path="/admin/webhooks" element={<AdminWebhooks />} />
        <Route path="/admin/schedules" element={<AdminSchedules />} />
        <Route path="/admin/users" element={<AdminUsers />} />
        <Route path="/admin/activity" element={<AdminActivity />} />
      </Route>
      <Route element={<Gate kind="person"><PersonLayout /></Gate>}>
        <Route path="/" element={<Now />} />
        <Route path="/convert" element={<Convert />} />
        <Route path="/schedules" element={<Schedules />} />
        <Route path="/zones" element={<Zones />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/support" element={<Support />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  </BrowserRouter>;
}
