'use client';

import type { DashboardDto, KpiDto } from '@innpilot/contracts';
import { useQuery } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { BucketBadge } from '@/components/aging';
import { Figure, ReportFootnote } from '@/components/report-filter';
import { Card, EmptyState, PageError, PageSkeleton, StatusBadge, TextField } from '@/components/ui';
import { api } from '@/lib/api';
import { formatAmount } from '@/lib/finance';

const isZero = (v: string) => !/[1-9]/.test(v);

/**
 * The owner dashboard (slice 5.5). Shows only what the API returned for this user; financial cards and panels are
 * absent for roles without financial reports. No figure is computed here: each comes from the report it links to.
 */
export function Dashboard({ propertyId }: { propertyId: string }) {
  const t = useTranslations('dashboard');
  const [period, setPeriod] = useState<{ from: string; to: string } | null>(null);
  const valid = !period || (!!period.from && !!period.to && period.from <= period.to);
  const dash = useQuery({
    queryKey: ['dashboard', propertyId, period?.from, period?.to],
    queryFn: () =>
      api.get<DashboardDto>(
        `/dashboard?propertyId=${propertyId}${period ? `&from=${period.from}&to=${period.to}` : ''}`,
      ),
    enabled: valid,
  });

  if (dash.isPending) return <PageSkeleton />;
  if (dash.isError) return <PageError error={dash.error} onRetry={() => void dash.refetch()} />;
  const d = dash.data;
  const today = d.kpis.filter((k) => k.scope === 'today');
  const money = d.kpis.filter((k) => k.scope !== 'today');

  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="today">
        <h2 id="today" className="mb-2 text-sm font-semibold uppercase text-muted">
          {t('today', { date: d.businessDate })}
        </h2>
        <KpiGrid kpis={today} currency={d.currencyCode} />
      </section>

      {d.financial && (
        <section aria-labelledby="period">
          <div className="mb-2 flex flex-wrap items-end justify-between gap-3">
            <h2 id="period" className="text-sm font-semibold uppercase text-muted">
              {t('period', { from: d.from, to: d.to })}
            </h2>
            <div className="no-print grid w-full grid-cols-2 gap-2 sm:w-auto">
              <TextField
                label={t('from')}
                type="date"
                value={period?.from ?? d.from}
                onChange={(e) => setPeriod({ from: e.target.value, to: period?.to ?? d.to })}
              />
              <TextField
                label={t('to')}
                type="date"
                value={period?.to ?? d.to}
                onChange={(e) => setPeriod({ from: period?.from ?? d.from, to: e.target.value })}
                error={valid ? undefined : t('rangeError')}
              />
            </div>
          </div>
          <KpiGrid
            kpis={money}
            currency={d.currencyCode}
            comparison={t('versus', { from: d.comparisonFrom, to: d.comparisonTo })}
          />
        </section>
      )}

      <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
        <MovementsPanel d={d} />
        <div className="flex flex-col gap-4">
          <Panel title={t('roomsToClean', { count: d.operations.roomsToClean.length })} href="/housekeeping">
            {d.operations.roomsToClean.length === 0 ? (
              <p className="text-sm text-muted">{t('allClean')}</p>
            ) : (
              <ul className="flex flex-wrap gap-2">
                {d.operations.roomsToClean.map((r) => (
                  <li key={r.roomId}>
                    <StatusBadge tone={r.state === 'dirty' ? 'warning' : 'neutral'}>
                      {r.roomNumber} · {t(`hk_${r.state}`)}
                    </StatusBadge>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <CashierPanel d={d} />
        </div>
      </div>

      {d.finance && <FinancePanel d={d} finance={d.finance} />}

      <ReportFootnote
        currencyCode={d.currencyCode}
        timezone={d.timezone}
        generatedAt={d.generatedAt}
        note={t('footnote')}
      />
    </div>
  );
}

function KpiGrid({ kpis, currency, comparison }: { kpis: KpiDto[]; currency: string; comparison?: string }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {kpis.map((k) => (
        <KpiCard key={k.key} kpi={k} currency={currency} comparisonLabel={comparison} />
      ))}
    </div>
  );
}

function KpiCard({
  kpi,
  currency,
  comparisonLabel,
}: {
  kpi: KpiDto;
  currency: string;
  comparisonLabel?: string;
}) {
  const t = useTranslations('dashboard');
  const show = (v: string) =>
    kpi.kind === 'money' ? formatAmount(v, currency) : kpi.kind === 'percent' ? `${v}%` : v;
  return (
    <Link
      href={kpi.href}
      className="group block rounded-lg border border-line bg-white p-3 hover:border-navy-700/40 focus-visible:outline-2 sm:p-4"
    >
      <p className="text-xs font-medium text-muted">{t(`kpi_${kpi.key}`)}</p>
      <p className="tabular mt-1 text-lg font-semibold text-ink sm:text-xl">{show(kpi.value)}</p>
      {kpi.comparison !== null && (
        <p className="tabular text-xs text-muted" title={comparisonLabel}>
          {t('previous', { value: show(kpi.comparison) })}
        </p>
      )}
      <p className="mt-1 line-clamp-2 text-xs text-muted" title={kpi.definition}>
        {kpi.definition}
      </p>
    </Link>
  );
}

function Panel({ title, href, children }: { title: string; href?: string; children: ReactNode }) {
  const t = useTranslations('dashboard');
  return (
    <Card>
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold text-navy-800">{title}</h2>
        {href && (
          <Link href={href} className="text-sm underline decoration-line underline-offset-2">
            {t('open')}
          </Link>
        )}
      </div>
      {children}
    </Card>
  );
}

function MovementsPanel({ d }: { d: DashboardDto }) {
  const t = useTranslations('dashboard');
  const tRes = useTranslations('reservations');
  const list = (rows: DashboardDto['operations']['arrivals'], empty: string) =>
    rows.length === 0 ? (
      <p className="text-sm text-muted">{empty}</p>
    ) : (
      <ul className="divide-y divide-line text-sm">
        {rows.map((m) => (
          <li
            key={`${m.reservationId}-${m.roomNumber ?? ''}`}
            className="flex items-baseline justify-between gap-3 py-2"
          >
            <Link
              href={`/reservations/${m.reservationId}`}
              className="min-w-0 underline decoration-line underline-offset-2"
            >
              {m.guestName}
              <span className="block text-xs text-muted no-underline">
                {m.bookingReference} · {m.roomNumber ? t('room', { room: m.roomNumber }) : t('noRoom')}
              </span>
            </Link>
            <span className="text-xs text-muted">{tRes(`statuses.${m.status}`)}</span>
          </li>
        ))}
      </ul>
    );
  return (
    <Panel title={t('movements')} href="/reports/arrivals-departures">
      {d.operations.unassignedArrivals > 0 && (
        <p className="mb-2">
          <StatusBadge tone="warning">
            {t('unassigned', { count: d.operations.unassignedArrivals })}
          </StatusBadge>
        </p>
      )}
      <h3 className="text-xs font-semibold uppercase text-muted">
        {t('arrivals', { count: d.operations.arrivals.length })}
      </h3>
      {list(d.operations.arrivals, t('noArrivals'))}
      <h3 className="mt-3 text-xs font-semibold uppercase text-muted">
        {t('departures', { count: d.operations.departures.length })}
      </h3>
      {list(d.operations.departures, t('noDepartures'))}
    </Panel>
  );
}

function CashierPanel({ d }: { d: DashboardDto }) {
  const t = useTranslations('dashboard');
  const c = d.operations.cashier;
  const f = (v: string) => formatAmount(v, d.currencyCode);
  return (
    <Panel title={t('cashier')} href="/reports/cashier-closings">
      <dl className="grid grid-cols-2 gap-3">
        <Figure label={t('openShifts')} value={String(c.openShifts)} />
        <Figure
          label={t('awaitingApproval')}
          value={String(c.awaitingApproval)}
          strong={c.awaitingApproval > 0}
        />
      </dl>
      {c.closings.length > 0 && (
        <ul className="mt-3 divide-y divide-line text-sm">
          {c.closings.map((x) => (
            <li key={x.shiftId} className="flex flex-wrap items-baseline justify-between gap-x-3 py-2">
              <span>
                {x.cashierName} · {x.cashAccountName}
                <span className="block text-xs text-muted">
                  {t('expectedCounted', { expected: f(x.expected), counted: f(x.counted) })}
                </span>
              </span>
              <span className={`tabular ${isZero(x.variance) ? 'text-muted' : 'font-semibold'}`}>
                {f(x.variance)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function FinancePanel({ d, finance }: { d: DashboardDto; finance: NonNullable<DashboardDto['finance']> }) {
  const t = useTranslations('dashboard');
  const tCash = useTranslations('cash');
  const format = useFormatter();
  const f = (v: string) => formatAmount(v, d.currencyCode);
  return (
    <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
      <Panel title={t('cashByAccount', { date: d.to })} href="/reports/cashbook">
        <ul className="divide-y divide-line text-sm">
          {finance.cashAccounts.map((a) => (
            <li key={a.cashAccountId} className="flex items-baseline justify-between gap-3 py-2">
              <Link
                href={`/finance/cash/${a.cashAccountId}`}
                className="underline decoration-line underline-offset-2"
              >
                {a.name}
                <span className="block text-xs text-muted no-underline">{tCash(`kinds.${a.kind}`)}</span>
              </Link>
              <span className="tabular font-medium">{f(a.balance)}</span>
            </li>
          ))}
        </ul>
        <dl className="mt-3 grid grid-cols-2 gap-3 border-t border-line pt-3">
          <Figure label={t('todayReceipts')} value={f(finance.todayReceipts)} />
          <Figure label={t('todayPayments')} value={f(finance.todayPayments)} />
        </dl>
      </Panel>
      <div className="flex flex-col gap-4">
        <Panel title={t('toDo')}>
          <ul className="flex flex-col gap-2 text-sm">
            <li className="flex justify-between gap-3">
              <Link href="/expenses" className="underline decoration-line underline-offset-2">
                {t('pendingExpenses')}
              </Link>
              <span className="tabular font-medium">{format.number(finance.pendingExpenseApprovals)}</span>
            </li>
            <li className="flex justify-between gap-3">
              <Link href="/finance/journals" className="underline decoration-line underline-offset-2">
                {t('draftJournals')}
              </Link>
              <span className="tabular font-medium">{format.number(finance.draftJournals)}</span>
            </li>
          </ul>
        </Panel>
        <Panel title={t('balances')} href="/reports/receivables">
          {finance.unresolvedBalances.length === 0 ? (
            <EmptyState message={t('noBalances')} />
          ) : (
            <ul className="divide-y divide-line text-sm">
              {finance.unresolvedBalances.map((b) => (
                <li
                  key={`${b.reservationId}-${b.balance}`}
                  className="flex flex-wrap items-center justify-between gap-2 py-2"
                >
                  <Link
                    href={`/reservations/${b.reservationId}`}
                    className="underline decoration-line underline-offset-2"
                  >
                    {b.guestName}
                    <span className="block text-xs text-muted no-underline">{b.bookingReference}</span>
                  </Link>
                  <span className="flex items-center gap-2">
                    <BucketBadge bucket={b.bucket} days={0} />
                    <span className="tabular font-medium">{f(b.balance)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}
