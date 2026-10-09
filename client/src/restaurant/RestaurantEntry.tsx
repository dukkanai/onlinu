import { lazy, Suspense, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { getApiKey, setAuth, clearAuth } from '../lib/auth';
import { LocaleProvider, LanguagePicker, useLocale } from './i18n';
import { adminRestaurant } from './api';
import type { Catalog } from './types';

const Storefront = lazy(() => import('./Storefront').then(m => ({ default: m.Storefront })));
const AdminRestaurant = lazy(() => import('./AdminRestaurant').then(m => ({ default: m.AdminRestaurant })));
const CourierDashboard = lazy(() => import('./CourierDashboard').then(m => ({ default: m.CourierDashboard })));
const PaymentReturn = lazy(() => import('./PaymentReturn').then(m => ({ default: m.PaymentReturn })));

function RestaurantAuth({ children }: { children: ReactNode }) {
  const { t } = useLocale();
  const [ready, setReady] = useState(false);
  const [checking, setChecking] = useState(true);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    if (!getApiKey()) { setChecking(false); return; }
    adminRestaurant<Catalog>('/catalog').then(() => { if (active) setReady(true); }).catch(() => {}).finally(() => { if (active) setChecking(false); });
    return () => { active = false; };
  }, []);
  async function login(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(false);
    try {
      const response = await fetch('/api/restaurant/catalog', { headers: { 'X-API-Key': key }, cache: 'no-store', redirect: 'error' });
      if (!response.ok) throw new Error('login');
      setAuth(window.location.origin, key); setKey(''); setReady(true);
    } catch { setError(true); } finally { setBusy(false); }
  }
  if (checking) return <p role="status" className="p-8 text-center">{t('common.loading')}</p>;
  if (ready) return <>
    <div className="restaurant-admin-session flex justify-end gap-3 border-b bg-white px-5 py-2 text-sm text-slate-700 print:hidden">
      <button type="button" onClick={() => { clearAuth(); setReady(false); }}>{t('admin.logout')}</button>
    </div>
    {children}
  </>;
  return <main className="flex min-h-screen items-center justify-center bg-stone-50 p-5 text-slate-900">
    <form onSubmit={login} className="w-full max-w-md space-y-5 rounded-3xl border border-stone-200 bg-white p-8 shadow-sm">
      <LanguagePicker />
      <h1 className="text-2xl font-bold">{t('admin.signIn')}</h1>
      <p className="text-sm leading-7 text-slate-600">{t('admin.keyHint')}</p>
      <label className="block space-y-2"><span>{t('admin.apiKey')}</span>
        <input className="block w-full rounded-xl border border-stone-300 p-3" dir="ltr" type="password" autoComplete="current-password" value={key} onChange={e => setKey(e.target.value)} required />
      </label>
      {error && <p role="alert" className="text-red-700">{t('admin.loginFailed')}</p>}
      <button className="w-full rounded-xl bg-teal-800 p-3 font-semibold text-white disabled:opacity-50" disabled={busy || !key.trim()}>{busy ? t('common.loading') : t('account.login')}</button>
      <a href="/" className="block text-center text-teal-800 underline">{t('admin.storefront')}</a>
    </form>
  </main>;
}

function EntryRoutes() {
  const { t } = useLocale();
  const path = window.location.pathname;
  return <Suspense fallback={<p role="status" className="p-8 text-center">{t('common.loading')}</p>}>
    {path === '/courier' ? <CourierDashboard /> : path === '/payment-return' ? <PaymentReturn /> : path === '/admin' ? <RestaurantAuth><AdminRestaurant /></RestaurantAuth> : <Storefront />}
  </Suspense>;
}

export function RestaurantEntry() { return <LocaleProvider><EntryRoutes /></LocaleProvider>; }
