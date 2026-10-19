'use client';

import type { Permission } from '@innpilot/contracts';
import { useFormatter, useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { useSession } from '@/lib/session';

interface NavItem {
  href: string;
  label:
    'overview' | 'reservations' | 'board' | 'guests' | 'rooms' | 'staff' | 'audit' | 'property' | 'account';
  /** Shown only when the user could use it. Phase 2+ sections appear here as they ship. */
  visible: (s: ReturnType<typeof useSession>) => boolean;
}

const tenant = (p: Permission) => (s: ReturnType<typeof useSession>) => s.canTenant(p);

const NAV: NavItem[] = [
  { href: '/', label: 'overview', visible: () => true },
  { href: '/reservations', label: 'reservations', visible: (s) => s.can('reservation.read') },
  { href: '/rooms', label: 'board', visible: (s) => s.can('room.read') },
  { href: '/guests', label: 'guests', visible: (s) => s.can('guest.read') },
  { href: '/settings/property', label: 'property', visible: (s) => s.can('property.read') },
  { href: '/settings/rooms', label: 'rooms', visible: (s) => s.can('room.read') },
  { href: '/staff', label: 'staff', visible: tenant('user.read') },
  { href: '/audit', label: 'audit', visible: tenant('audit.read') },
  { href: '/account', label: 'account', visible: () => true },
];

function isActive(pathname: string, href: string): boolean {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
}

export function AppShell({ children }: { children: ReactNode }) {
  const t = useTranslations('nav');
  const tApp = useTranslations('app');
  const format = useFormatter();
  const session = useSession();
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const { me, property } = session;

  const nav = (
    <nav aria-label={t('menu')} className="flex flex-col gap-1 p-3">
      {NAV.filter((item) => item.visible(session)).map((item) => {
        const active = isActive(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={() => setMenuOpen(false)}
            aria-current={active ? 'page' : undefined}
            className={`rounded-md px-3 py-2 text-sm font-medium ${
              active ? 'bg-white/15 text-white' : 'text-navy-100 hover:bg-white/10 hover:text-white'
            }`}
          >
            {t(item.label)}
          </Link>
        );
      })}
    </nav>
  );

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[15rem_1fr]">
      {/* Sidebar: fixed on desktop, slide-over on tablet and phone. */}
      <aside
        className={`no-print fixed inset-y-0 left-0 z-30 w-64 bg-navy-800 transition-transform lg:static lg:w-auto lg:translate-x-0 ${
          menuOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex h-14 items-center px-6 text-lg font-semibold text-white">{tApp('name')}</div>
        {nav}
      </aside>
      {menuOpen && (
        <button
          aria-label={t('menu')}
          className="fixed inset-0 z-20 bg-navy-900/40 lg:hidden"
          onClick={() => setMenuOpen(false)}
        />
      )}

      <div className="flex min-w-0 flex-col">
        <header className="no-print sticky top-0 z-10 flex h-14 items-center gap-3 border-b border-line bg-white px-4">
          <button
            className="rounded-md p-2 text-navy-800 hover:bg-navy-50 lg:hidden"
            aria-label={t('menu')}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
          >
            <svg
              aria-hidden
              width="20"
              height="20"
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M3 5h14M3 10h14M3 15h14" />
            </svg>
          </button>

          {me.properties.length > 1 ? (
            <label className="flex min-w-0 items-center gap-2 text-sm">
              <span className="sr-only">{t('property_label')}</span>
              <select
                value={property?.id ?? ''}
                onChange={(e) => session.setPropertyId(e.target.value)}
                className="min-h-9 max-w-48 truncate rounded-md border border-line bg-white px-2 text-sm"
              >
                {me.properties.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <span className="truncate text-sm font-medium text-navy-800">
              {property?.name ?? me.tenant.displayName}
            </span>
          )}

          {property && (
            <span className="tabular hidden rounded-full bg-teal-50 px-3 py-1 text-xs font-medium text-teal-700 sm:inline">
              {t('businessDate', {
                // Business date is a calendar date, not an instant: format it without time zone shifts.
                date: format.dateTime(new Date(`${property.businessDate}T00:00:00Z`), {
                  dateStyle: 'medium',
                  timeZone: 'UTC',
                }),
              })}
            </span>
          )}

          <div className="ml-auto flex items-center gap-3">
            <span className="hidden text-right text-sm sm:block">
              <span className="block font-medium text-ink">{me.user.fullName}</span>
              <span className="block text-xs text-muted">{me.user.email}</span>
            </span>
            <button
              onClick={() => void session.signOut()}
              className="rounded-md border border-line px-3 py-1.5 text-sm font-medium text-navy-800 hover:bg-navy-50"
            >
              {t('signOut')}
            </button>
          </div>
        </header>

        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 lg:py-8">{children}</main>
      </div>
    </div>
  );
}
