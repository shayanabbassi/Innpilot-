'use client';

import type { ReceiptDto } from '@innpilot/contracts';
import { useQuery } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Button, PageError, PageSkeleton, PermissionDenied } from '@/components/ui';
import { api } from '@/lib/api';
import { formatAmount } from '@/lib/finance';
import { useSession } from '@/lib/session';

/** A printable payment receipt (decision D8: print or save as PDF from the browser). */
export default function ReceiptPage() {
  const t = useTranslations('receipt');
  const tFolio = useTranslations('folio');
  const format = useFormatter();
  const { id } = useParams<{ id: string }>();
  const { property, can } = useSession();
  const allowed = !!property && can('folio.read');
  const receipt = useQuery({
    queryKey: ['receipt', property?.id, id],
    queryFn: () => api.get<ReceiptDto>(`/properties/${property!.id}/payments/${id}/receipt`),
    enabled: allowed,
  });

  if (!allowed) return <PermissionDenied />;
  if (receipt.isPending) return <PageSkeleton />;
  if (receipt.isError) return <PageError error={receipt.error} onRetry={() => void receipt.refetch()} />;
  const { payment: p, hotel } = receipt.data;
  const fmt = (v: string) => formatAmount(v, p.currencyCode);

  return (
    <>
      <div className="no-print mb-4 flex flex-wrap items-center justify-between gap-2">
        <Link href={`/reservations/${p.reservationId}`} className="text-sm text-teal-700 underline">
          {t('back', { ref: p.bookingReference })}
        </Link>
        <Button onClick={() => window.print()}>{t('print')}</Button>
      </div>
      <article className="mx-auto max-w-xl rounded-lg border border-line bg-white p-6 text-sm print:border-0 print:p-0">
        <header className="mb-6 border-b border-line pb-4">
          <h1 className="text-lg font-semibold text-navy-800">{hotel.legalName ?? hotel.name}</h1>
          {hotel.legalName && hotel.legalName !== hotel.name && <p className="text-muted">{hotel.name}</p>}
          {hotel.address && <p className="whitespace-pre-line text-muted">{hotel.address}</p>}
          {hotel.registrationFields.map((f) => (
            <p key={f.label} className="text-muted">
              {f.label}: {f.value}
            </p>
          ))}
        </header>
        <h2 className="mb-4 text-base font-semibold">
          {p.kind === 'deposit' ? t('depositReceipt') : t('paymentReceipt')} {p.receiptNumber}
        </h2>
        <dl className="grid grid-cols-[10rem_1fr] gap-y-1">
          <dt className="text-muted">{t('date')}</dt>
          <dd>{format.dateTime(new Date(p.receivedAt), { dateStyle: 'medium', timeStyle: 'short' })}</dd>
          <dt className="text-muted">{t('guest')}</dt>
          <dd>{p.guestName}</dd>
          <dt className="text-muted">{t('booking')}</dt>
          <dd>
            {p.bookingReference} · {p.folioLabel}
          </dd>
          <dt className="text-muted">{t('method')}</dt>
          <dd>
            {tFolio(`methods.${p.method}`)}
            {p.externalReference && ` · ${p.externalReference}`}
          </dd>
          <dt className="text-muted">{t('amount')}</dt>
          <dd className="tabular text-base font-semibold">{fmt(p.amount)}</dd>
        </dl>
        {p.refunds.length > 0 && (
          <section className="mt-4 border-t border-line pt-3">
            <h3 className="mb-1 font-medium">{t('refunds')}</h3>
            <ul>
              {p.refunds.map((r) => (
                <li key={r.id} className="flex justify-between gap-2">
                  <span>
                    {r.refundNumber} · {r.businessDate} · {r.reason}
                  </span>
                  <span className="tabular">−{fmt(r.amount)}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
        <p className="mt-4 text-xs text-muted">
          {t('receivedBy', { name: p.createdByName ?? '—' })}
          {p.notes && ` · ${p.notes}`}
        </p>
        {hotel.footer && (
          <p className="mt-6 border-t border-line pt-3 text-center text-muted">{hotel.footer}</p>
        )}
        <p className="mt-2 text-center text-xs text-muted">{t('notTaxInvoice')}</p>
      </article>
    </>
  );
}
