'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { Card, PageHeader, PermissionDenied } from '@/components/ui';
import { useSession } from '@/lib/session';

/** The reports hub. Reports appear as their slices ship; each one checks its own permission on the server. */
export default function ReportsPage() {
  const t = useTranslations('reports');
  const { me, canTenant } = useSession();
  const financial = me.properties.some((p) => p.permissions.includes('report.financial'));
  const reports = [
    { href: '/reports/profit-loss', title: t('plTitle'), text: t('plSubtitle'), visible: financial },
    { href: '/reports/balance-sheet', title: t('bsTitle'), text: t('bsSubtitle'), visible: financial },
    {
      href: '/finance/trial-balance',
      title: t('tbTitle'),
      text: t('tbText'),
      visible: canTenant('journal.read'),
    },
  ].filter((r) => r.visible);

  if (reports.length === 0) return <PermissionDenied />;
  return (
    <>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <h2 className="mb-2 text-sm font-semibold uppercase text-muted">{t('financialGroup')}</h2>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {reports.map((r) => (
          <Link key={r.href} href={r.href} className="block rounded-lg focus-visible:outline-2">
            <Card className="h-full hover:border-navy-700/40">
              <p className="font-semibold text-ink">{r.title}</p>
              <p className="mt-1 text-sm text-muted">{r.text}</p>
            </Card>
          </Link>
        ))}
      </div>
    </>
  );
}
