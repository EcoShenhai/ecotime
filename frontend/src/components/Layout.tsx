import { Component, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { t, useI18n } from '../i18n';
import { useSession, signOut } from '../lib/session';
import { ToastHost } from './Toast';
import { useOnline } from '../lib/online';

// Each page sits inside an error boundary: one broken view never blanks the whole console.
export class Boundary extends Component<{ children: ReactNode; resetKey: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidUpdate(prev: { resetKey: string }) { if (prev.resetKey !== this.props.resetKey && this.state.failed) this.setState({ failed: false }); }
  render() { return this.state.failed ? <div className="state state--error" role="alert"><strong>{t('error.pageTitle')}</strong><span>{t('error.page')}</span></div> : this.props.children; }
}

function Shell({ items, who, tag }: { items: [string, string][]; who: string; tag?: string }) {
  useI18n(); const loc = useLocation(); const online = useOnline();
  return <div className="shell">
    <a className="skip" href="#main">{t('nav.skip')}</a>
    <header className="topbar">
      <span className="brand"><img src="/icon.svg" alt="" width="28" height="28" /><span>{t('app.name')}</span>{tag ? <span className="brand__tag">{tag}</span> : null}</span>
      <nav className="topnav" aria-label={t('nav.label')}>{items.map(([to, key]) => <NavLink key={to} to={to} end={to === '/' || to === '/admin'} className={({ isActive }) => `topnav__item${isActive ? ' is-active' : ''}`}>{t(key)}</NavLink>)}</nav>
      <span className="row"><span className="note who">{who}</span><button className="btn btn--small btn--ghost" onClick={() => { void signOut(); }}>{t('account.signOut')}</button></span>
    </header>
    {!online ? <div className="offline" role="status">{t('offline.banner')}</div> : null}
    <main id="main" className="main" tabIndex={-1}><Boundary resetKey={loc.pathname}><Outlet /></Boundary></main>
    <footer className="foot"><NavLink to="/privacy">{t('nav.privacy')}</NavLink> · {t('app.footer')}</footer>
    <ToastHost />
  </div>;
}
export function PersonLayout() {
  const s = useSession();
  return <Shell who={s.info?.displayName || ''} items={[['/', 'nav.now'], ['/convert', 'nav.convert'], ['/schedules', 'nav.schedules'], ['/zones', 'nav.zones'], ['/settings', 'nav.settings'], ['/support', 'nav.support']]} />;
}
export function AdminLayout() {
  const s = useSession();
  return <Shell who={s.info?.email || ''} tag={t('admin.label')} items={[['/admin', 'admin.nav.clock'], ['/admin/organizations', 'admin.nav.orgs'], ['/admin/keys', 'admin.nav.keys'],
    ['/admin/webhooks', 'admin.nav.webhooks'], ['/admin/schedules', 'admin.nav.schedules'], ['/admin/users', 'admin.nav.users'], ['/admin/activity', 'admin.nav.activity']]} />;
}
