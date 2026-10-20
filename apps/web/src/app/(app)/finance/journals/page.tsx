'use client';

import type { JournalListDto } from '@innpilot/contracts';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState } from 'react';
import {
  Button,
  EmptyState,
  PageError,
  PageHeader,
  PageSkeleton,
  PermissionDenied,
  StatusBadge,
} from '@/components/ui';
import { api } from '@/lib/api';
import { formatAmount, STATUS_TONE } from '@/lib/finance';
import { useSession } from '@/lib/session';

const PAGE = 50;
const FILTERS = ['all', 'draft', 'posted', 'reversed'] as const;

export default function JournalsPage() {
  const t = useTranslations('finance');
  const tCommon = useTranslations('common');
  const { canTenant } = useSession();
  const allowed = canTenant('journal.read');
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('all');

  const journals = useInfiniteQuery({
    queryKey: ['finance', 'journals', filter],
    queryFn: ({ pageParam }) =>
      api.get<JournalListDto>(
        `/finance/journal-entries?limit=${PAGE}&offset=${pageParam}${filter === 'all' ? '' : `&status=${filter}`}`,
      ),
    initialPageParam: 0,
    getNextPageParam: (last, all) => {
      const loaded = all.reduce((n, p) => n + p.items.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
    enabled: allowed,
  });

  if (!allowed) return <PermissionDenied />;
  const rows = journals.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <>
      <PageHeader
        title={t('journalsTitle')}
        subtitle={t('journalsSubtitle')}
        actions={
          canTenant('journal.post') && (
            <Link
              href="/finance/journals/new"
              className="inline-flex min-h-10 items-center rounded-md bg-teal-600 px-4 text-sm font-medium text-white hover:bg-teal-700"
            >
              {t('newJournal')}
            </Link>
          )
        }
      />
      <div role="tablist" aria-label={t('statusFilter')} className="mb-4 flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f}
            role="tab"
            type="button"
            aria-selected={filter === f}
            onClick={() => setFilter(f)}
            className={`min-h-9 rounded-full border px-3 text-sm ${
              filter === f ? 'border-teal-600 bg-teal-50 text-teal-700' : 'border-line bg-white text-ink'
            }`}
          >
            {t(`filters.${f}`)}
          </button>
        ))}
      </div>
      {journals.isPending ? (
        <PageSkeleton />
      ) : journals.isError ? (
        <PageError error={journals.error} onRetry={() => void journals.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState message={t('noJournals')} />
      ) : (
        <>
          <ul className="divide-y divide-line rounded-lg border border-line bg-white">
            {rows.map((j) => (
              <li key={j.id}>
                <Link
                  href={`/finance/journals/${j.id}`}
                  className="grid gap-1 px-4 py-3 text-sm hover:bg-canvas sm:grid-cols-[7rem_7rem_1fr_9rem_6rem] sm:items-center"
                >
                  <span className="tabular font-medium text-ink">
                    {j.journalNumber ? t('journalNo', { n: j.journalNumber }) : t('draftLabel')}
                  </span>
                  <span className="tabular text-muted">{j.accountingDate}</span>
                  <span className="truncate text-ink">{j.narration}</span>
                  <span className="tabular sm:text-right">{formatAmount(j.totalDebit, j.currencyCode)}</span>
                  <span className="sm:text-right">
                    <StatusBadge tone={STATUS_TONE[j.status]}>{t(`statuses.${j.status}`)}</StatusBadge>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {journals.hasNextPage && (
            <div className="mt-4 flex justify-center">
              <Button
                variant="secondary"
                busy={journals.isFetchingNextPage}
                onClick={() => void journals.fetchNextPage()}
              >
                {journals.isFetchingNextPage ? tCommon('loading') : tCommon('loadMore')}
              </Button>
            </div>
          )}
        </>
      )}
    </>
  );
}
