'use client';

import type { InvoiceProfileDto } from '@innpilot/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';
import {
  Alert,
  ApiErrorAlert,
  Button,
  Card,
  PageError,
  PageHeader,
  PageSkeleton,
  PermissionDenied,
  TextField,
} from '@/components/ui';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';

interface Field {
  key: string;
  label: string;
  value: string;
}

export default function InvoiceSettingsPage() {
  const t = useTranslations('invoiceSettings');
  const { property, can } = useSession();
  const allowed = !!property && can('property.read');
  const path = `/properties/${property?.id ?? ''}/invoice-profile`;
  const profile = useQuery({
    queryKey: ['tax', property?.id, 'invoice-profile'],
    queryFn: () => api.get<InvoiceProfileDto>(path),
    enabled: allowed,
  });

  if (!allowed) return <PermissionDenied />;
  if (profile.isPending) return <PageSkeleton />;
  if (profile.isError) return <PageError error={profile.error} onRetry={() => void profile.refetch()} />;
  return (
    <>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <ProfileForm key={path} initial={profile.data} path={path} canEdit={can('tax.configure')} />
    </>
  );
}

function ProfileForm({
  initial,
  path,
  canEdit,
}: {
  initial: InvoiceProfileDto;
  path: string;
  canEdit: boolean;
}) {
  const t = useTranslations('invoiceSettings');
  const tCommon = useTranslations('common');
  const format = useFormatter();
  const queryClient = useQueryClient();
  const [legalName, setLegalName] = useState(initial.legalName ?? '');
  const [address, setAddress] = useState(initial.address ?? '');
  const [fields, setFields] = useState<Field[]>(
    initial.registrationFields.map((f) => ({ key: crypto.randomUUID(), ...f })),
  );
  const [invoicePrefix, setInvoicePrefix] = useState(initial.invoicePrefix);
  const [receiptPrefix, setReceiptPrefix] = useState(initial.receiptPrefix);
  const [footer, setFooter] = useState(initial.footer ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);

  const save = async () => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await api.put(path, {
        legalName: legalName.trim() || null,
        address: address.trim() || null,
        registrationFields: fields
          .filter((f) => f.label.trim() || f.value.trim())
          .map((f) => ({ label: f.label.trim(), value: f.value.trim() })),
        invoicePrefix: invoicePrefix.trim(),
        receiptPrefix: receiptPrefix.trim(),
        footer: footer.trim() || null,
      });
      await queryClient.invalidateQueries({ queryKey: ['tax'] });
      setSaved(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const update = (key: string, patch: Partial<Field>) =>
    setFields((fs) => fs.map((f) => (f.key === key ? { ...f, ...patch } : f)));

  return (
    <div className="flex flex-col gap-4">
      <Alert tone="info">{t('legalNote')}</Alert>
      {saved && <Alert tone="success">{tCommon('saved')}</Alert>}
      {error !== null && <ApiErrorAlert error={error} />}
      <Card>
        <fieldset disabled={!canEdit} className="grid gap-4 sm:grid-cols-2">
          <TextField
            label={t('legalName')}
            value={legalName}
            maxLength={160}
            onChange={(e) => setLegalName(e.target.value)}
            className="sm:col-span-2"
          />
          <TextField
            label={t('address')}
            value={address}
            maxLength={500}
            onChange={(e) => setAddress(e.target.value)}
            className="sm:col-span-2"
          />
          <TextField
            label={t('invoicePrefix')}
            value={invoicePrefix}
            maxLength={12}
            onChange={(e) => setInvoicePrefix(e.target.value)}
            hint={t('prefixHint', { example: `${invoicePrefix}000123` })}
          />
          <TextField
            label={t('receiptPrefix')}
            value={receiptPrefix}
            maxLength={12}
            onChange={(e) => setReceiptPrefix(e.target.value)}
            hint={t('prefixHint', { example: `${receiptPrefix}000123` })}
          />
          <TextField
            label={t('footer')}
            value={footer}
            maxLength={1000}
            onChange={(e) => setFooter(e.target.value)}
            className="sm:col-span-2"
          />
        </fieldset>
      </Card>
      <Card title={t('registrationTitle')}>
        <p className="mb-3 text-sm text-muted">{t('registrationNote')}</p>
        <fieldset disabled={!canEdit} className="flex flex-col gap-3">
          {fields.map((f, i) => (
            <div key={f.key} className="grid gap-2 sm:grid-cols-[12rem_1fr_auto] sm:items-end">
              <TextField
                label={t('fieldLabel', { n: i + 1 })}
                value={f.label}
                maxLength={40}
                onChange={(e) => update(f.key, { label: e.target.value })}
              />
              <TextField
                label={t('fieldValue', { n: i + 1 })}
                value={f.value}
                maxLength={80}
                onChange={(e) => update(f.key, { value: e.target.value })}
              />
              <Button variant="ghost" onClick={() => setFields((fs) => fs.filter((x) => x.key !== f.key))}>
                {t('remove')}
              </Button>
            </div>
          ))}
          {fields.length < 6 && (
            <div>
              <Button
                variant="secondary"
                onClick={() => setFields((fs) => [...fs, { key: crypto.randomUUID(), label: '', value: '' }])}
              >
                {t('addField')}
              </Button>
            </div>
          )}
        </fieldset>
      </Card>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-muted">
          {t('lastChanged', {
            name: initial.updatedByName ?? tCommon('none'),
            date: format.dateTime(new Date(initial.updatedAt), { dateStyle: 'medium', timeStyle: 'short' }),
          })}
        </p>
        {canEdit && (
          <Button busy={busy} onClick={() => void save()}>
            {busy ? tCommon('saving') : tCommon('save')}
          </Button>
        )}
      </div>
    </div>
  );
}
