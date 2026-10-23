'use client';

import type { InvoiceDto } from '@innpilot/contracts';
import { useQuery } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Button, PageError, PageSkeleton, PermissionDenied } from '@/components/ui';
import { api } from '@/lib/api';
import { formatAmount } from '@/lib/finance';
import { useSession } from '@/lib/session';

/** A printable invoice, exactly as issued at check-out (decision D8: print or save as PDF from the browser). */
export default function InvoicePage() {
  const t = useTranslations('invoice');
  const format = useFormatter();
  const { id } = useParams<{ id: string }>();
  const { property, can } = useSession();
  const allowed = !!property && can('folio.read');
  const invoice = useQuery({
    queryKey: ['invoice', property?.id, id],
    queryFn: () => api.get<InvoiceDto>(`/properties/${property!.id}/invoices/${id}`),
    enabled: allowed,
  });

  if (!allowed) return <PermissionDenied />;
  if (invoice.isPending) return <PageSkeleton />;
  if (invoice.isError) return <PageError error={invoice.error} onRetry={() => void invoice.refetch()} />;
  const inv = invoice.data;
  const fmt = (v: string) => formatAmount(v, inv.currencyCode);
  const hotel = inv.hotel;
  const date = (d: string) =>
    format.dateTime(new Date(`${d}T00:00:00Z`), { dateStyle: 'medium', timeZone: 'UTC' });

  return (
    <>
      <div className="no-print mb-4 flex flex-wrap items-center justify-between gap-2">
        <Link href={`/reservations/${inv.reservationId}`} className="text-sm text-teal-700 underline">
          {t('back', { ref: inv.bookingReference })}
        </Link>
        <Button onClick={() => window.print()}>{t('print')}</Button>
      </div>
      <article className="mx-auto max-w-3xl rounded-lg border border-line bg-white p-6 text-sm print:border-0 print:p-0">
        <header className="mb-6 flex flex-col gap-4 border-b border-line pb-4 sm:flex-row sm:justify-between">
          <div>
            <h1 className="text-lg font-semibold text-navy-800">{hotel.legalName ?? hotel.name}</h1>
            {hotel.legalName && hotel.legalName !== hotel.name && <p className="text-muted">{hotel.name}</p>}
            {hotel.address && <p className="whitespace-pre-line text-muted">{hotel.address}</p>}
            {hotel.registrationFields.map((f) => (
              <p key={f.label} className="text-muted">
                {f.label}: {f.value}
              </p>
            ))}
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 sm:text-right">
            <dt className="text-muted">{t('number')}</dt>
            <dd className="font-semibold">{inv.invoiceNumber}</dd>
            <dt className="text-muted">{t('date')}</dt>
            <dd>{date(inv.issueDate)}</dd>
            <dt className="text-muted">{t('billTo')}</dt>
            <dd>{inv.billTo}</dd>
            <dt className="text-muted">{t('booking')}</dt>
            <dd>{inv.bookingReference}</dd>
          </dl>
        </header>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[34rem]">
            <thead>
              <tr className="border-b border-line text-left text-muted">
                <th className="py-2 pr-3 font-medium">{t('dateCol')}</th>
                <th className="py-2 pr-3 font-medium">{t('description')}</th>
                <th className="py-2 pr-3 text-right font-medium">{t('net')}</th>
                <th className="py-2 pr-3 text-right font-medium">{t('tax')}</th>
                <th className="py-2 text-right font-medium">{t('amount')}</th>
              </tr>
            </thead>
            <tbody>
              {inv.lines.map((l) => (
                <tr key={l.lineNo} className="border-b border-line/60 align-top">
                  <td className="tabular py-1.5 pr-3">{l.serviceDate}</td>
                  <td className="py-1.5 pr-3">
                    {l.description}
                    {l.quantity !== '1' && (
                      <span className="text-muted">
                        {' '}
                        ({l.quantity} × {fmt(l.unitPrice)})
                      </span>
                    )}
                  </td>
                  <td className="tabular py-1.5 pr-3 text-right">{fmt(l.net)}</td>
                  <td className="tabular py-1.5 pr-3 text-right">{fmt(l.tax)}</td>
                  <td className="tabular py-1.5 text-right">{fmt(l.gross)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="font-semibold">
                <td className="py-2 pr-3" colSpan={2}>
                  {t('total')}
                </td>
                <td className="tabular py-2 pr-3 text-right">{fmt(inv.net)}</td>
                <td className="tabular py-2 pr-3 text-right">{fmt(inv.tax)}</td>
                <td className="tabular py-2 text-right">{fmt(inv.gross)}</td>
              </tr>
            </tfoot>
          </table>
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <section>
            {inv.taxSummary.length > 0 && (
              <>
                <h2 className="mb-1 font-medium">{t('taxSummary')}</h2>
                <ul className="text-muted">
                  {inv.taxSummary.map((s) => (
                    <li
                      key={`${s.code}-${s.ratePercent}-${s.inclusive}`}
                      className="flex justify-between gap-2"
                    >
                      <span>
                        {s.code} {s.name} {s.ratePercent}%{s.inclusive ? ` (${t('inclusive')})` : ''} ·{' '}
                        {t('onBase', { base: fmt(s.base) })}
                      </span>
                      <span className="tabular">{fmt(s.amount)}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
          <dl className="grid grid-cols-[1fr_auto] gap-y-1 sm:justify-self-end">
            <dt className="text-muted">{t('total')}</dt>
            <dd className="tabular text-right">{fmt(inv.gross)}</dd>
            <dt className="text-muted">{t('paid')}</dt>
            <dd className="tabular text-right">−{fmt(inv.paid)}</dd>
            {/[1-9]/.test(inv.writtenOff) && (
              <>
                <dt className="text-muted">{t('writtenOff')}</dt>
                <dd className="tabular text-right">−{fmt(inv.writtenOff)}</dd>
              </>
            )}
            <dt className="font-semibold">{t('balanceDue')}</dt>
            <dd className="tabular text-right font-semibold">{fmt(inv.balanceDue)}</dd>
          </dl>
        </div>

        {hotel.footer && (
          <p className="mt-6 border-t border-line pt-3 text-center text-muted">{hotel.footer}</p>
        )}
        <p className="mt-2 text-center text-xs text-muted">{t('notCertified')}</p>
      </article>
    </>
  );
}
