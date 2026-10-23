'use client';

import type { GuestSummaryDto } from '@innpilot/contracts';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { EmptyState, PageError, PageHeader, PageSkeleton, PermissionDenied } from '@/components/ui';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';

export default function GuestsPage() {
  const t = useTranslations('guests');
  const { can } = useSession();
  const allowed = can('guest.read');
  const [input, setInput] = useState('');
  const [search, setSearch] = useState('');
  useEffect(() => {
    const id = setTimeout(() => setSearch(input.trim()), 300);
    return () => clearTimeout(id);
  }, [input]);

  const guests = useQuery({
    queryKey: ['guests', search],
    queryFn: () => api.get<GuestSummaryDto[]>(`/guests?search=${encodeURIComponent(search)}`),
    enabled: allowed,
    placeholderData: keepPreviousData,
  });

  if (!allowed) return <PermissionDenied />;

  return (
    <>
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          can('guest.write') && (
            <Link
              href="/guests/new"
              className="inline-flex min-h-10 items-center rounded-md bg-teal-600 px-4 text-sm font-medium text-white hover:bg-teal-700"
            >
              {t('newGuest')}
            </Link>
          )
        }
      />
      <label className="mb-4 block">
        <span className="sr-only">{t('searchLabel')}</span>
        <input
          type="search"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={t('searchPlaceholder')}
          autoFocus
          className="min-h-11 w-full rounded-md border border-line bg-white px-3 text-sm"
        />
      </label>
      {!search && <h2 className="mb-2 text-sm font-medium text-muted">{t('recent')}</h2>}
      {guests.isPending ? (
        <PageSkeleton />
      ) : guests.isError ? (
        <PageError error={guests.error} onRetry={() => void guests.refetch()} />
      ) : guests.data.length === 0 ? (
        <EmptyState message={search ? t('noResults', { search }) : t('empty')} />
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line bg-white">
          {guests.data.map((g) => (
            <li key={g.id}>
              <Link href={`/guests/${g.id}`} className="block px-4 py-3 hover:bg-canvas">
                <p className="font-medium text-ink">{g.fullName}</p>
                <p className="text-sm text-muted">
                  {[g.phone, g.email, g.city, g.nationality].filter(Boolean).join(' · ')}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
