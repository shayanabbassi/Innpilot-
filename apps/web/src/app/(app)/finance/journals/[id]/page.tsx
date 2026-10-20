'use client';

import type { JournalEntryDto } from '@innpilot/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { JournalForm } from '@/components/journal-form';
import {
  Alert,
  ApiErrorAlert,
  Button,
  Card,
  Dialog,
  PageError,
  PageHeader,
  PageSkeleton,
  PermissionDenied,
  StatusBadge,
  TextField,
} from '@/components/ui';
import { api } from '@/lib/api';
import { formatAmount, STATUS_TONE } from '@/lib/finance';
import { useSession } from '@/lib/session';

export default function JournalPage() {
  const t = useTranslations('finance');
  const tCommon = useTranslations('common');
  const format = useFormatter();
  const { id } = useParams<{ id: string }>();
  const search = useSearchParams();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { canTenant, me } = useSession();
  const allowed = canTenant('journal.read');

  const entry = useQuery({
    queryKey: ['finance', 'journal', id],
    queryFn: () => api.get<JournalEntryDto>(`/finance/journal-entries/${id}`),
    enabled: allowed,
  });
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<'post' | 'delete' | 'reverse' | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [postKey, setPostKey] = useState(() => crypto.randomUUID());
  const [reverseKey, setReverseKey] = useState(() => crypto.randomUUID());
  const [reversing, setReversing] = useState(false);
  const [reason, setReason] = useState('');
  const [deleting, setDeleting] = useState(false);

  if (!allowed) return <PermissionDenied />;
  if (entry.isPending) return <PageSkeleton />;
  if (entry.isError) return <PageError error={entry.error} onRetry={() => void entry.refetch()} />;
  const j = entry.data;
  const isManual = j.sourceType === 'manual';
  const canPost = canTenant('journal.post') && isManual;
  const property = me.properties.find((p) => p.id === j.propertyId);

  const run = async (kind: 'post' | 'delete' | 'reverse', fn: () => Promise<string | null>) => {
    setError(null);
    setBusy(kind);
    try {
      const next = await fn();
      await queryClient.invalidateQueries({ queryKey: ['finance'] });
      if (next) router.push(next);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  };

  const post = () =>
    run('post', async () => {
      await api.postWith(`/finance/journal-entries/${j.id}/post`, {}, { 'idempotency-key': postKey });
      setPostKey(crypto.randomUUID());
      router.replace(`/finance/journals/${j.id}`);
      return null;
    });
  const remove = () =>
    run('delete', async () => {
      await api.del(`/finance/journal-entries/${j.id}`);
      return '/finance/journals';
    });
  const reverse = () =>
    run('reverse', async () => {
      const reversal = await api.postWith<JournalEntryDto>(
        `/finance/journal-entries/${j.id}/reverse`,
        { reason: reason.trim() },
        { 'idempotency-key': reverseKey },
      );
      setReverseKey(crypto.randomUUID());
      setReversing(false);
      setReason('');
      return `/finance/journals/${reversal.id}`;
    });

  if (editing && j.status === 'draft') {
    return (
      <>
        <PageHeader title={t('editDraft')} />
        <JournalForm draft={j} onSaved={() => setEditing(false)} />
      </>
    );
  }

  return (
    <>
      <Link href="/finance/journals" className="mb-2 inline-block text-sm text-teal-700 underline">
        {t('allJournals')}
      </Link>
      <PageHeader
        title={j.journalNumber ? t('journalNo', { n: j.journalNumber }) : t('draftLabel')}
        subtitle={j.narration}
        actions={<StatusBadge tone={STATUS_TONE[j.status]}>{t(`statuses.${j.status}`)}</StatusBadge>}
      />
      <div className="flex flex-col gap-4">
        {search.get('postFailed') && j.status === 'draft' && <Alert tone="warning">{t('postFailed')}</Alert>}
        {error !== null && <ApiErrorAlert error={error} />}
        {j.reversesEntryId && (
          <Alert tone="info">
            <Link href={`/finance/journals/${j.reversesEntryId}`} className="underline">
              {t('reversesNote', { n: j.reversesNumber ?? '' })}
            </Link>
          </Alert>
        )}
        {j.reversedById && (
          <Alert tone="info">
            <Link href={`/finance/journals/${j.reversedById}`} className="underline">
              {t('reversedByNote', { n: j.reversedByNumber ?? '' })}
            </Link>
          </Alert>
        )}

        <Card>
          <dl className="grid gap-3 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-muted">{t('accountingDate')}</dt>
              <dd className="tabular">{j.accountingDate}</dd>
            </div>
            <div>
              <dt className="text-muted">{t('property')}</dt>
              <dd>{property?.name ?? tCommon('none')}</dd>
            </div>
            <div>
              <dt className="text-muted">{t('reference')}</dt>
              <dd>{j.reference ?? tCommon('none')}</dd>
            </div>
            <div>
              <dt className="text-muted">{t('source')}</dt>
              <dd>{t(`sources.${j.sourceType}` as never)}</dd>
            </div>
            <div>
              <dt className="text-muted">{t('createdBy')}</dt>
              <dd>
                {j.createdByName ?? tCommon('none')} ·{' '}
                {format.dateTime(new Date(j.createdAt), { dateStyle: 'medium', timeStyle: 'short' })}
              </dd>
            </div>
            {j.postedAt && (
              <div>
                <dt className="text-muted">{t('postedBy')}</dt>
                <dd>
                  {j.postedByName ?? tCommon('none')} ·{' '}
                  {format.dateTime(new Date(j.postedAt), { dateStyle: 'medium', timeStyle: 'short' })}
                </dd>
              </div>
            )}
          </dl>
        </Card>

        <Card title={t('lines')}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[32rem] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-muted">
                  <th className="py-2 pr-3 font-medium">{t('account')}</th>
                  <th className="py-2 pr-3 text-right font-medium">{t('debit')}</th>
                  <th className="py-2 text-right font-medium">{t('credit')}</th>
                </tr>
              </thead>
              <tbody>
                {j.lines.map((l) => (
                  <tr key={l.id} className="border-b border-line/60 align-top">
                    <td className="py-2 pr-3">
                      <span className="tabular font-medium">{l.accountCode}</span> {l.accountName}
                      {l.description && <p className="text-xs text-muted">{l.description}</p>}
                    </td>
                    <td className="tabular py-2 pr-3 text-right">
                      {/[1-9]/.test(l.debit) ? formatAmount(l.debit, j.currencyCode) : ''}
                    </td>
                    <td className="tabular py-2 text-right">
                      {/[1-9]/.test(l.credit) ? formatAmount(l.credit, j.currencyCode) : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
              {j.status !== 'draft' && (
                <tfoot>
                  <tr className="font-semibold">
                    <td className="py-2 pr-3">{t('total')}</td>
                    <td className="tabular py-2 pr-3 text-right">
                      {formatAmount(j.totalDebit, j.currencyCode)}
                    </td>
                    <td className="tabular py-2 text-right">{formatAmount(j.totalCredit, j.currencyCode)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </Card>

        {j.status === 'draft' && canPost && (
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              variant="danger"
              busy={busy === 'delete'}
              disabled={busy !== null}
              onClick={() => setDeleting(true)}
            >
              {t('deleteDraft')}
            </Button>
            <Button
              variant="secondary"
              disabled={busy !== null}
              onClick={() => {
                setError(null);
                setEditing(true);
              }}
            >
              {t('editDraft')}
            </Button>
            <Button busy={busy === 'post'} disabled={busy !== null} onClick={() => void post()}>
              {busy === 'post' ? t('posting') : t('post')}
            </Button>
          </div>
        )}
        {j.status === 'posted' && isManual && canTenant('journal.reverse') && (
          <div className="flex justify-end">
            <Button variant="secondary" onClick={() => setReversing(true)}>
              {t('reverse')}
            </Button>
          </div>
        )}
        {j.status === 'posted' && !isManual && j.sourceType !== 'reversal' && (
          <p className="text-sm text-muted">{t('notManualNote')}</p>
        )}
      </div>

      <Dialog
        open={reversing}
        onClose={() => setReversing(false)}
        title={t('reverseTitle', { n: j.journalNumber ?? '' })}
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted">{t('reverseExplain')}</p>
          <TextField
            label={t('reason')}
            value={reason}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setReversing(false)}>
              {tCommon('cancel')}
            </Button>
            <Button
              busy={busy === 'reverse'}
              disabled={reason.trim().length < 3}
              onClick={() => void reverse()}
            >
              {t('reverse')}
            </Button>
          </div>
        </div>
      </Dialog>
      <Dialog open={deleting} onClose={() => setDeleting(false)} title={t('deleteDraftTitle')}>
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted">{t('deleteDraftExplain')}</p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setDeleting(false)}>
              {tCommon('cancel')}
            </Button>
            <Button variant="danger" busy={busy === 'delete'} onClick={() => void remove()}>
              {t('deleteDraft')}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
