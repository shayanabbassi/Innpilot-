'use client';

import type { SupplierDto } from '@innpilot/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { useSuppliers } from '@/components/expense-form';
import {
  ApiErrorAlert,
  Button,
  Card,
  Dialog,
  EmptyState,
  PageError,
  PageHeader,
  PageSkeleton,
  PermissionDenied,
  StatusBadge,
  TextField,
} from '@/components/ui';
import { api } from '@/lib/api';
import { formatAmount } from '@/lib/finance';
import { useSession } from '@/lib/session';

type Editing = { mode: 'new' } | { mode: 'edit'; supplier: SupplierDto } | null;

export default function SuppliersPage() {
  const t = useTranslations('suppliers');
  const { can, property } = useSession();
  const allowed = can('expense.write');
  const canManage = can('supplier.manage');
  const suppliers = useSuppliers(allowed);
  const [editing, setEditing] = useState<Editing>(null);

  if (!allowed) return <PermissionDenied />;
  if (suppliers.isPending) return <PageSkeleton />;
  if (suppliers.isError)
    return <PageError error={suppliers.error} onRetry={() => void suppliers.refetch()} />;
  const cur = property?.currencyCode ?? 'PKR';

  return (
    <>
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={canManage && <Button onClick={() => setEditing({ mode: 'new' })}>{t('add')}</Button>}
      />
      {suppliers.data.length === 0 ? (
        <EmptyState message={t('none')} />
      ) : (
        <Card>
          <ul className="divide-y divide-line text-sm">
            {suppliers.data.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3">
                <div className="min-w-0 flex-1">
                  <p className={`font-medium ${s.active ? 'text-ink' : 'text-muted'}`}>{s.name}</p>
                  <p className="text-xs text-muted">
                    {[s.contact, t('terms', { days: s.paymentTermsDays })].filter(Boolean).join(' · ')}
                  </p>
                </div>
                {!s.active && <StatusBadge tone="neutral">{t('inactive')}</StatusBadge>}
                <div className="text-right">
                  <p className="tabular font-medium">{formatAmount(s.owed, cur)}</p>
                  <p className="text-xs text-muted">{t('openBills', { n: s.openBills })}</p>
                </div>
                {canManage && (
                  <Button variant="ghost" onClick={() => setEditing({ mode: 'edit', supplier: s })}>
                    {t('edit')}
                    <span className="sr-only"> {s.name}</span>
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
      <SupplierDialog editing={editing} onClose={() => setEditing(null)} />
    </>
  );
}

function SupplierDialog({ editing, onClose }: { editing: Editing; onClose: () => void }) {
  const t = useTranslations('suppliers');
  const tCommon = useTranslations('common');
  const queryClient = useQueryClient();
  const existing = editing?.mode === 'edit' ? editing.supplier : null;
  const [name, setName] = useState('');
  const [contact, setContact] = useState('');
  const [taxIdentifier, setTaxIdentifier] = useState('');
  const [terms, setTerms] = useState('0');
  const [notes, setNotes] = useState('');
  const [active, setActive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [openedFor, setOpenedFor] = useState<Editing>(null);
  if (editing !== openedFor) {
    setOpenedFor(editing);
    setError(null);
    setName(existing?.name ?? '');
    setContact(existing?.contact ?? '');
    setTaxIdentifier(existing?.taxIdentifier ?? '');
    setTerms(String(existing?.paymentTermsDays ?? 0));
    setNotes(existing?.notes ?? '');
    setActive(existing?.active ?? true);
  }

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = {
        name: name.trim(),
        contact: contact.trim() || (existing ? null : undefined),
        taxIdentifier: taxIdentifier.trim() || (existing ? null : undefined),
        paymentTermsDays: Number(terms) || 0,
        notes: notes.trim() || (existing ? null : undefined),
        ...(existing ? { active } : {}),
      };
      if (existing) await api.patch(`/suppliers/${existing.id}`, body);
      else await api.post('/suppliers', body);
      await queryClient.invalidateQueries({ queryKey: ['suppliers'] });
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={editing !== null}
      onClose={onClose}
      title={existing ? t('editTitle', { name: existing.name }) : t('add')}
    >
      <div className="flex flex-col gap-4">
        {error !== null && <ApiErrorAlert error={error} />}
        <TextField label={t('name')} value={name} maxLength={160} onChange={(e) => setName(e.target.value)} />
        <TextField
          label={t('contact')}
          value={contact}
          maxLength={200}
          onChange={(e) => setContact(e.target.value)}
        />
        <TextField
          label={t('taxIdentifier')}
          value={taxIdentifier}
          maxLength={40}
          onChange={(e) => setTaxIdentifier(e.target.value)}
        />
        <TextField
          label={t('paymentTerms')}
          inputMode="numeric"
          value={terms}
          onChange={(e) => setTerms(e.target.value.replace(/\D/g, ''))}
          hint={t('paymentTermsHint')}
        />
        <TextField
          label={t('notes')}
          value={notes}
          maxLength={500}
          onChange={(e) => setNotes(e.target.value)}
        />
        {existing && (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
            />
            {t('activeLabel')}
          </label>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {tCommon('cancel')}
          </Button>
          <Button busy={busy} disabled={name.trim().length === 0} onClick={() => void save()}>
            {busy ? tCommon('saving') : tCommon('save')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
