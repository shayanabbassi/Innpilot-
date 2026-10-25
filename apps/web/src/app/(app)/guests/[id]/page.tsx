'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  DOCUMENT_TYPES,
  guestDocumentInput,
  type GuestDocumentDto,
  type FileLinkDto,
  type GuestDto,
  type RevealedDocumentDto,
} from '@innpilot/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';
import { AttachmentList } from '@/components/attachments';
import { GuestForm } from '@/components/guest-form';
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
  TextField,
} from '@/components/ui';
import { api } from '@/lib/api';
import { applyServerErrors } from '@/lib/forms';
import { useSession } from '@/lib/session';

const REVEAL_SECONDS = 30;

export default function GuestProfilePage() {
  const t = useTranslations('guests');
  const format = useFormatter();
  const { id } = useParams<{ id: string }>();
  const { can } = useSession();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const allowed = can('guest.read');
  const guest = useQuery({
    queryKey: ['guest', id],
    queryFn: () => api.get<GuestDto>(`/guests/${id}`),
    enabled: allowed,
  });

  if (!allowed) return <PermissionDenied />;
  if (guest.isPending) return <PageSkeleton />;
  if (guest.isError) return <PageError error={guest.error} onRetry={() => void guest.refetch()} />;
  const g = guest.data;
  const update = (next: GuestDto) => {
    queryClient.setQueryData(['guest', id], next);
    void queryClient.invalidateQueries({ queryKey: ['guests'] });
  };

  if (editing) {
    return (
      <>
        <PageHeader title={t('editTitle')} subtitle={g.fullName} />
        <GuestForm
          guest={g}
          allowDocument={false}
          onCancel={() => setEditing(false)}
          onSaved={(next) => {
            update(next);
            setEditing(false);
          }}
        />
      </>
    );
  }

  const row = (label: string, value: string | null) => (
    <div className="grid grid-cols-[8rem_1fr] gap-2 py-1.5 text-sm">
      <dt className="text-muted">{label}</dt>
      <dd className="break-words text-ink">{value || '—'}</dd>
    </div>
  );

  return (
    <>
      <Link href="/guests" className="mb-2 inline-block text-sm text-teal-700 underline">
        {t('back')}
      </Link>
      <PageHeader
        title={g.fullName}
        subtitle={t('since', { date: format.dateTime(new Date(g.createdAt), { dateStyle: 'medium' }) })}
        actions={can('guest.write') && <Button onClick={() => setEditing(true)}>{t('edit')}</Button>}
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={t('contact')}>
          <dl>
            {row(t('phone'), g.phone)}
            {row(t('email'), g.email)}
            {row(t('nationalityLabel'), g.nationality)}
          </dl>
        </Card>
        <Card title={t('address')}>
          <dl>
            {row(t('addressLine'), g.addressLine)}
            {row(t('city'), g.city)}
            {row(t('countryLabel'), g.countryCode)}
          </dl>
        </Card>
        <Card title={t('other')}>
          <dl>
            {row(t('preferences'), g.preferences)}
            {row(t('notes'), g.notes)}
          </dl>
          <p className="mt-2 text-sm text-muted">{g.marketingConsent ? t('consentYes') : t('consentNo')}</p>
        </Card>
        <DocumentsPanel guest={g} onChange={update} />
        <ScansPanel guest={g} onChange={update} />
      </div>
    </>
  );
}

function DocumentsPanel({ guest, onChange }: { guest: GuestDto; onChange: (g: GuestDto) => void }) {
  const t = useTranslations('guests');
  const tTypes = useTranslations('guests.types');
  const format = useFormatter();
  const { can } = useSession();
  const [adding, setAdding] = useState(false);
  const [revealing, setRevealing] = useState<GuestDocumentDto | null>(null);
  const [removing, setRemoving] = useState<GuestDocumentDto | null>(null);
  const [shown, setShown] = useState<{ id: string; number: string; secondsLeft: number } | null>(null);

  // Revealed numbers disappear on their own; nothing is kept in the query cache.
  useEffect(() => {
    if (!shown) return;
    if (shown.secondsLeft <= 0) {
      setShown(null);
      return;
    }
    const id = setTimeout(() => setShown((s) => (s ? { ...s, secondsLeft: s.secondsLeft - 1 } : s)), 1000);
    return () => clearTimeout(id);
  }, [shown]);

  if (guest.documents === null) {
    return (
      <Card title={t('documents')}>
        <p className="text-sm text-muted">{t('documentsHidden', { count: guest.documentCount })}</p>
      </Card>
    );
  }

  const canManage = can('guest.write') && can('guest.identity.read');
  return (
    <Card title={t('documents')}>
      {guest.documents.length === 0 ? (
        <p className="text-sm text-muted">{t('noDocuments')}</p>
      ) : (
        <ul className="divide-y divide-line">
          {guest.documents.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
              <div>
                <p className="font-medium text-ink">
                  {tTypes(d.documentType)} ({d.issuingCountry})
                </p>
                <p className="tabular text-muted">
                  {shown?.id === d.id ? (
                    <span className="font-semibold text-ink">{shown.number}</span>
                  ) : (
                    t('masked', { last4: d.last4 })
                  )}
                  {d.expiryDate &&
                    ` · ${t('expires', {
                      date: format.dateTime(new Date(`${d.expiryDate}T00:00:00Z`), {
                        dateStyle: 'medium',
                        timeZone: 'UTC',
                      }),
                    })}`}
                </p>
                {shown?.id === d.id && (
                  <p className="text-xs text-muted">{t('revealedNote', { seconds: shown.secondsLeft })}</p>
                )}
              </div>
              <div className="flex gap-1">
                {shown?.id === d.id ? (
                  <Button variant="ghost" className="min-h-8 px-2" onClick={() => setShown(null)}>
                    {t('hide')}
                  </Button>
                ) : (
                  <Button variant="ghost" className="min-h-8 px-2" onClick={() => setRevealing(d)}>
                    {t('reveal')}
                  </Button>
                )}
                {canManage && (
                  <Button variant="ghost" className="min-h-8 px-2" onClick={() => setRemoving(d)}>
                    {t('remove')}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {canManage && (
        <div className="mt-3">
          <Button variant="secondary" onClick={() => setAdding(true)}>
            {t('addDocument')}
          </Button>
        </div>
      )}
      {adding && <AddDocumentDialog guestId={guest.id} onClose={() => setAdding(false)} onSaved={onChange} />}
      {revealing && (
        <RevealDialog
          guestId={guest.id}
          document={revealing}
          onClose={() => setRevealing(null)}
          onRevealed={(r) => {
            setShown({ id: r.id, number: r.number, secondsLeft: REVEAL_SECONDS });
            setRevealing(null);
          }}
        />
      )}
      {removing && (
        <RemoveDialog
          guestId={guest.id}
          document={removing}
          onClose={() => setRemoving(null)}
          onRemoved={(g) => {
            onChange(g);
            setRemoving(null);
          }}
        />
      )}
    </Card>
  );
}

/** Scans of identity documents (slice 6.2): same access as the numbers; opening one needs a reason. */
function ScansPanel({ guest, onChange }: { guest: GuestDto; onChange: (g: GuestDto) => void }) {
  const t = useTranslations('guests');
  const { can } = useSession();
  if (guest.scans === null) {
    return (
      <Card title={t('scans')}>
        <p className="text-sm text-muted">{t('scansHidden')}</p>
      </Card>
    );
  }
  const canManage = can('guest.write') && can('guest.identity.read');
  const base = `/guests/${guest.id}/scans`;
  return (
    <Card title={t('scans')}>
      <AttachmentList
        files={guest.scans}
        emptyText={t('noScans')}
        askReason
        upload={canManage ? async (file) => onChange(await api.upload<GuestDto>(base, file)) : undefined}
        link={(id, reason) => api.post<FileLinkDto>(`${base}/${id}/link`, { reason })}
        remove={canManage ? async (id) => onChange(await api.del<GuestDto>(`${base}/${id}`)) : undefined}
      />
    </Card>
  );
}

function RevealDialog({
  guestId,
  document,
  onClose,
  onRevealed,
}: {
  guestId: string;
  document: GuestDocumentDto;
  onClose: () => void;
  onRevealed: (r: RevealedDocumentDto) => void;
}) {
  const t = useTranslations('guests');
  const tTypes = useTranslations('guests.types');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      onRevealed(
        await api.post<RevealedDocumentDto>(`/guests/${guestId}/documents/${document.id}/reveal`, { reason }),
      );
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };
  return (
    <Dialog open onClose={onClose} title={t('revealTitle', { type: tTypes(document.documentType) })}>
      <div className="flex flex-col gap-4">
        {error !== null && <ApiErrorAlert error={error} />}
        <TextField
          label={t('revealReason')}
          value={reason}
          maxLength={300}
          onChange={(e) => setReason(e.target.value)}
        />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button busy={busy} disabled={reason.trim().length < 3} onClick={() => void submit()}>
            {t('revealConfirm')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function RemoveDialog({
  guestId,
  document,
  onClose,
  onRemoved,
}: {
  guestId: string;
  document: GuestDocumentDto;
  onClose: () => void;
  onRemoved: (g: GuestDto) => void;
}) {
  const t = useTranslations('guests');
  const tTypes = useTranslations('guests.types');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      onRemoved(await api.del<GuestDto>(`/guests/${guestId}/documents/${document.id}`));
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };
  return (
    <Dialog open onClose={onClose} title={t('removeTitle', { type: tTypes(document.documentType) })}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted">{t('removeBody')}</p>
        {error !== null && <ApiErrorAlert error={error} />}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button variant="danger" busy={busy} onClick={() => void submit()}>
            {t('remove')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function AddDocumentDialog({
  guestId,
  onClose,
  onSaved,
}: {
  guestId: string;
  onClose: () => void;
  onSaved: (g: GuestDto) => void;
}) {
  const t = useTranslations('guests');
  const tTypes = useTranslations('guests.types');
  const [error, setError] = useState<unknown>(null);
  const form = useForm<z.input<typeof guestDocumentInput>>({
    resolver: zodResolver(guestDocumentInput),
    defaultValues: { documentType: 'cnic', issuingCountry: 'PK', number: '', expiryDate: null },
  });
  const { errors, isSubmitting } = form.formState;
  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      onSaved(await api.post<GuestDto>(`/guests/${guestId}/documents`, values));
      onClose();
    } catch (err) {
      if (
        !applyServerErrors(err, form.setError, ['documentType', 'issuingCountry', 'number', 'expiryDate'])
      ) {
        setError(err);
      }
    }
  });
  return (
    <Dialog open onClose={onClose} title={t('addDocument')}>
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        {error !== null && <ApiErrorAlert error={error} />}
        <SelectField label={t('documentType')} {...form.register('documentType')}>
          {DOCUMENT_TYPES.map((d) => (
            <option key={d} value={d}>
              {tTypes(d)}
            </option>
          ))}
        </SelectField>
        <TextField
          label={t('issuingCountry')}
          maxLength={2}
          error={errors.issuingCountry?.message}
          {...form.register('issuingCountry')}
        />
        <TextField
          label={t('number')}
          autoComplete="off"
          error={errors.number?.message}
          {...form.register('number')}
        />
        <TextField
          label={t('expiryDate')}
          type="date"
          error={errors.expiryDate?.message}
          {...form.register('expiryDate', { setValueAs: (v: string) => v || null })}
        />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button type="submit" busy={isSubmitting}>
            {t('addDocument')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
