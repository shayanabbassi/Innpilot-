'use client';

import type { AccountDto, JournalDraftRequest, JournalEntryDto } from '@innpilot/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Alert, ApiErrorAlert, Button, Card, SelectField, TextField } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { formatAmount, journalTotals } from '@/lib/finance';
import { useSession } from '@/lib/session';

interface LineState {
  key: string;
  accountId: string;
  debit: string;
  credit: string;
  description: string;
}

const blank = (): LineState => ({
  key: crypto.randomUUID(),
  accountId: '',
  debit: '',
  credit: '',
  description: '',
});

export const ACCOUNTS_QUERY_KEY = ['finance', 'accounts'] as const;

export function useAccounts(enabled = true) {
  return useQuery({
    queryKey: ACCOUNTS_QUERY_KEY,
    queryFn: () => api.get<AccountDto[]>('/finance/accounts'),
    enabled,
  });
}

/** New manual journal, or edit of a draft. Drafts may be saved unbalanced; posting needs a balance. */
export function JournalForm({ draft, onSaved }: { draft?: JournalEntryDto; onSaved?: () => void }) {
  const t = useTranslations('finance');
  const tCommon = useTranslations('common');
  const router = useRouter();
  const queryClient = useQueryClient();
  const { me, property } = useSession();
  const accounts = useAccounts();

  const [propertyId, setPropertyId] = useState(draft?.propertyId ?? property?.id ?? '');
  const selected = me.properties.find((p) => p.id === propertyId);
  const currency = selected?.currencyCode ?? 'PKR';
  const [date, setDate] = useState(draft?.accountingDate ?? selected?.businessDate ?? '');
  const [narration, setNarration] = useState(draft?.narration ?? '');
  const [reference, setReference] = useState(draft?.reference ?? '');
  const [lines, setLines] = useState<LineState[]>(
    draft
      ? draft.lines.map((l) => ({
          key: l.id,
          accountId: l.accountId,
          debit: /[1-9]/.test(l.debit) ? l.debit : '',
          credit: /[1-9]/.test(l.credit) ? l.credit : '',
          description: l.description ?? '',
        }))
      : [blank(), blank()],
  );
  // One key per attempt; a retry after a network error reuses it so the server never makes two drafts.
  const [draftKey, setDraftKey] = useState(() => crypto.randomUUID());
  const [postKey, setPostKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState<'save' | 'post' | null>(null);
  const [error, setError] = useState<unknown>(null);

  const totals = journalTotals(lines, currency);
  const active = useMemo(() => (accounts.data ?? []).filter((a) => a.active), [accounts.data]);
  const lineErrors = useMemo(() => {
    const out = new Map<string, string>();
    if (error instanceof ApiError) {
      for (const d of error.details) {
        const m = /^lines\.(\d+)\./.exec(d.path);
        if (m) out.set(lines[Number(m[1])]?.key ?? '', d.message);
      }
    }
    return out;
  }, [error, lines]);

  const update = (key: string, patch: Partial<LineState>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const body = (): JournalDraftRequest => ({
    propertyId,
    accountingDate: date || undefined,
    narration: narration.trim(),
    reference: reference.trim() || undefined,
    lines: lines
      .filter((l) => l.accountId || l.debit || l.credit)
      .map((l) => ({
        accountId: l.accountId,
        debit: l.debit.trim() || '0',
        credit: l.credit.trim() || '0',
        description: l.description.trim() || undefined,
      })),
  });

  const save = async (andPost: boolean) => {
    setError(null);
    setBusy(andPost ? 'post' : 'save');
    let saved: JournalEntryDto | null = null;
    try {
      saved = draft
        ? await api.put<JournalEntryDto>(`/finance/journal-entries/${draft.id}`, body())
        : await api.postWith<JournalEntryDto>('/finance/journal-entries/draft', body(), {
            'idempotency-key': draftKey,
          });
      setDraftKey(crypto.randomUUID());
      if (andPost) {
        await api.postWith<JournalEntryDto>(
          `/finance/journal-entries/${saved.id}/post`,
          {},
          {
            'idempotency-key': postKey,
          },
        );
        setPostKey(crypto.randomUUID());
      }
      await queryClient.invalidateQueries({ queryKey: ['finance'] });
      onSaved?.();
      router.push(`/finance/journals/${saved.id}`);
    } catch (err) {
      setError(err);
      // The draft was saved even if posting failed; continue on its own page so a retry edits it.
      if (saved && !draft) {
        await queryClient.invalidateQueries({ queryKey: ['finance'] });
        router.push(`/finance/journals/${saved.id}?postFailed=1`);
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {error !== null && <ApiErrorAlert error={error} />}
      <Card>
        <div className="grid gap-4 sm:grid-cols-2">
          {me.properties.length > 1 && (
            <SelectField
              label={t('property')}
              value={propertyId}
              onChange={(e) => setPropertyId(e.target.value)}
            >
              {me.properties.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </SelectField>
          )}
          <TextField
            label={t('accountingDate')}
            type="date"
            value={date}
            max={selected?.businessDate}
            onChange={(e) => setDate(e.target.value)}
            hint={t('accountingDateHint')}
          />
          <TextField
            label={t('narration')}
            value={narration}
            maxLength={500}
            onChange={(e) => setNarration(e.target.value)}
            className="sm:col-span-2"
          />
          <TextField
            label={t('reference')}
            value={reference}
            maxLength={80}
            onChange={(e) => setReference(e.target.value)}
            hint={t('referenceHint')}
          />
        </div>
      </Card>

      <Card title={t('lines')}>
        {accounts.isError && <ApiErrorAlert error={accounts.error} />}
        <ol className="flex flex-col gap-3">
          {lines.map((l, i) => (
            <li
              key={l.key}
              className="grid gap-2 rounded-md border border-line p-3 md:grid-cols-[1fr_8rem_8rem_auto] md:items-end md:border-0 md:p-0"
            >
              <SelectField
                label={t('lineAccount', { n: i + 1 })}
                value={l.accountId}
                onChange={(e) => update(l.key, { accountId: e.target.value })}
                error={lineErrors.get(l.key)}
              >
                <option value="">{t('chooseAccount')}</option>
                {active.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} · {a.name}
                  </option>
                ))}
              </SelectField>
              <TextField
                label={t('debit')}
                inputMode="decimal"
                value={l.debit}
                onChange={(e) =>
                  update(l.key, { debit: e.target.value, ...(e.target.value ? { credit: '' } : {}) })
                }
                className="tabular"
              />
              <TextField
                label={t('credit')}
                inputMode="decimal"
                value={l.credit}
                onChange={(e) =>
                  update(l.key, { credit: e.target.value, ...(e.target.value ? { debit: '' } : {}) })
                }
                className="tabular"
              />
              <Button
                variant="ghost"
                disabled={lines.length <= 2}
                onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                aria-label={t('removeLine', { n: i + 1 })}
              >
                {t('remove')}
              </Button>
              <TextField
                label={t('lineDescription')}
                value={l.description}
                maxLength={300}
                onChange={(e) => update(l.key, { description: e.target.value })}
                className="md:col-span-4"
              />
            </li>
          ))}
        </ol>
        <div className="mt-3">
          <Button
            variant="secondary"
            onClick={() => setLines((ls) => [...ls, blank()])}
            disabled={lines.length >= 100}
          >
            {t('addLine')}
          </Button>
        </div>

        <dl className="mt-4 grid grid-cols-3 gap-2 border-t border-line pt-3 text-sm" aria-live="polite">
          <div>
            <dt className="text-muted">{t('totalDebit')}</dt>
            <dd className="tabular font-medium">{formatAmount(totals.debit, currency)}</dd>
          </div>
          <div>
            <dt className="text-muted">{t('totalCredit')}</dt>
            <dd className="tabular font-medium">{formatAmount(totals.credit, currency)}</dd>
          </div>
          <div>
            <dt className="text-muted">{t('difference')}</dt>
            <dd className={`tabular font-medium ${totals.balanced ? 'text-success' : 'text-danger'}`}>
              {totals.balanced ? t('balanced') : formatAmount(totals.difference, currency)}
            </dd>
          </div>
        </dl>
      </Card>

      {!totals.balanced && <Alert tone="info">{t('unbalancedNote')}</Alert>}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="secondary" onClick={() => router.back()}>
          {tCommon('cancel')}
        </Button>
        <Button
          variant="secondary"
          busy={busy === 'save'}
          disabled={busy !== null}
          onClick={() => void save(false)}
        >
          {busy === 'save' ? tCommon('saving') : t('saveDraft')}
        </Button>
        <Button
          busy={busy === 'post'}
          disabled={busy !== null || !totals.balanced}
          onClick={() => void save(true)}
        >
          {busy === 'post' ? t('posting') : t('saveAndPost')}
        </Button>
      </div>
    </div>
  );
}
