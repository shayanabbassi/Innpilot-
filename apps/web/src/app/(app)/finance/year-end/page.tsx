'use client';

import type { YearEndPreviewDto } from '@innpilot/contracts';
import { Money } from '@innpilot/money';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState } from 'react';
import { CloseChecklist } from '@/components/close-checklist';
import {
  ApiErrorAlert,
  Button,
  Card,
  Dialog,
  PageError,
  PageHeader,
  PageSkeleton,
  PermissionDenied,
  SelectField,
  StatusBadge,
  TextField,
} from '@/components/ui';
import { api } from '@/lib/api';
import { formatAmount } from '@/lib/finance';
import { useSession } from '@/lib/session';

/** Year-end close (P4-11): the calendar year's results move to retained earnings on 31 December (D10). */
export default function YearEndPage() {
  const t = useTranslations('close');
  const tCommon = useTranslations('common');
  const format = useFormatter();
  const queryClient = useQueryClient();
  const { canTenant, property } = useSession();
  const allowed = canTenant('journal.read');
  const thisYear = Number((property?.businessDate ?? new Date().toISOString()).slice(0, 4));
  const [year, setYear] = useState(thisYear - 1);
  const key = ['finance', 'year', year];
  const preview = useQuery({
    queryKey: key,
    queryFn: () => api.get<YearEndPreviewDto>(`/finance/years/${year}`),
    enabled: allowed,
  });
  const [dialog, setDialog] = useState<'close' | 'reopen' | null>(null);
  const [reason, setReason] = useState('');
  const [idemKey, setIdemKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  if (!allowed) return <PermissionDenied />;
  const cur = property?.currencyCode ?? 'PKR';
  const when = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium' });

  const run = async () => {
    if (!dialog) return;
    setBusy(true);
    setError(null);
    try {
      const done = await api.postWith<YearEndPreviewDto>(
        `/finance/years/${year}/${dialog}`,
        reason.trim() ? { reason: reason.trim() } : {},
        { 'idempotency-key': idemKey },
      );
      setIdemKey(crypto.randomUUID());
      queryClient.setQueryData(key, done);
      await queryClient.invalidateQueries({ queryKey: ['finance'] });
      setDialog(null);
      setReason('');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const p = preview.data;
  const blockers = p?.items.filter((i) => i.severity === 'blocker').length ?? 0;
  const warnings = p?.items.filter((i) => i.severity === 'warning').length ?? 0;
  const result = p ? Money.of(p.result, cur) : null;

  return (
    <>
      <PageHeader
        title={t('yearTitle')}
        subtitle={t('yearSubtitle')}
        actions={
          <Link href="/finance/periods" className="text-sm text-teal-700 underline">
            {t('periodsLink')}
          </Link>
        }
      />
      <div className="mb-4 max-w-xs">
        <SelectField label={t('year')} value={String(year)} onChange={(e) => setYear(Number(e.target.value))}>
          {[thisYear - 2, thisYear - 1, thisYear].map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </SelectField>
      </div>
      {preview.isPending ? (
        <PageSkeleton />
      ) : preview.isError ? (
        <PageError error={preview.error} onRetry={() => void preview.refetch()} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
          <div className="flex flex-col gap-4">
            <Card>
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <StatusBadge tone={p!.status === 'closed' ? 'neutral' : 'success'}>
                  {t(`yearStatus.${p!.status}`)}
                </StatusBadge>
                <span className="text-sm text-muted">
                  {p!.startDate} – {p!.endDate}
                </span>
                <span className="ml-auto flex gap-2">
                  {p!.status === 'open' && canTenant('period.close') && (
                    <Button onClick={() => setDialog('close')} disabled={blockers > 0}>
                      {t('closeYear', { year })}
                    </Button>
                  )}
                  {p!.status === 'closed' && canTenant('fiscal_year.reopen') && (
                    <Button variant="secondary" onClick={() => setDialog('reopen')}>
                      {t('reopenYear', { year })}
                    </Button>
                  )}
                </span>
              </div>
              <p
                className={`text-base font-semibold ${result!.isNegative() ? 'text-danger' : 'text-success'}`}
              >
                {result!.isNegative()
                  ? t('loss', { amount: formatAmount(result!.negate().toString(), cur) })
                  : t('profit', { amount: formatAmount(p!.result, cur) })}
              </p>
              <p className="text-xs text-muted">
                {p!.status === 'closed' ? t('movedToRetained') : t('willMoveToRetained')}
              </p>
            </Card>
            {p!.status === 'open' && (
              <Card title={t('checksTitle')}>
                <CloseChecklist items={p!.items} />
              </Card>
            )}
            {p!.entries.map((e) => (
              <Card key={e.propertyId} title={e.propertyName}>
                <ul className="divide-y divide-line text-sm">
                  {e.lines.map((l) => (
                    <li key={l.accountCode} className="flex justify-between gap-3 py-1.5">
                      <span>
                        <span className="tabular font-medium">{l.accountCode}</span> {l.accountName}
                      </span>
                      <span className="tabular">{formatAmount(l.balance, cur)}</span>
                    </li>
                  ))}
                  <li className="flex justify-between gap-3 py-1.5 font-semibold">
                    <span>{t('propertyResult')}</span>
                    <span className="tabular">{formatAmount(e.result, cur)}</span>
                  </li>
                </ul>
              </Card>
            ))}
            {p!.entries.length === 0 && (
              <Card>
                <p className="text-sm text-muted">{t('noActivity', { year })}</p>
              </Card>
            )}
          </div>
          <Card title={t('history')}>
            {p!.history.length === 0 ? (
              <p className="text-sm text-muted">{t('noHistory')}</p>
            ) : (
              <ul className="flex flex-col gap-3 text-sm">
                {p!.history.map((h) => (
                  <li key={h.id}>
                    <p>
                      {t('closedLine', {
                        name: h.closedByName ?? '—',
                        date: when(h.closedAt),
                        amount: formatAmount(h.result, cur),
                      })}
                    </p>
                    {h.closeReason && <p className="text-xs text-muted">{h.closeReason}</p>}
                    {h.reopenedAt && (
                      <p className="text-xs text-warning">
                        {t('reopenedLine', {
                          name: h.reopenedByName ?? '—',
                          date: when(h.reopenedAt),
                          reason: h.reopenReason ?? '',
                        })}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}
      <Dialog
        open={dialog !== null}
        onClose={() => setDialog(null)}
        title={dialog === 'reopen' ? t('reopenYear', { year }) : t('closeYear', { year })}
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted">
            {dialog === 'reopen' ? t('reopenExplain', { year }) : t('closeExplain', { year })}
          </p>
          {error !== null && <ApiErrorAlert error={error} />}
          {(dialog === 'reopen' || warnings > 0) && (
            <TextField
              label={dialog === 'reopen' ? t('reopenReason') : t('acceptReason')}
              value={reason}
              maxLength={500}
              onChange={(e) => setReason(e.target.value)}
            />
          )}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setDialog(null)}>
              {tCommon('cancel')}
            </Button>
            <Button
              busy={busy}
              variant={dialog === 'reopen' ? 'danger' : 'primary'}
              disabled={(dialog === 'reopen' || warnings > 0) && reason.trim().length < 3}
              onClick={() => void run()}
            >
              {dialog === 'reopen' ? t('reopenYear', { year }) : t('closeYear', { year })}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
