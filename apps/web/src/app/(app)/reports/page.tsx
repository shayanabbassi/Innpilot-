'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { Card, PageHeader, PermissionDenied } from '@/components/ui';
import { useSession } from '@/lib/session';

interface ReportLink {
  href: string;
  title: string;
  text: string;
  visible: boolean;
}

/** The reports hub. Reports appear as their slices ship; each one checks its own permission on the server. */
export default function ReportsPage() {
  const t = useTranslations('reports');
  const { me, canTenant } = useSession();
  const financial = me.properties.some((p) => p.permissions.includes('report.financial'));
  const operational = me.properties.some((p) => p.permissions.includes('report.operational'));
  const groups: [string, ReportLink[]][] = [
    [
      t('opsGroup'),
      [
        { href: '/reports/occupancy', title: t('occTitle'), text: t('occSubtitle'), visible: operational },
        {
          href: '/reports/arrivals-departures',
          title: t('movTitle'),
          text: t('movSubtitle'),
          visible: operational,
        },
        {
          href: '/reports/cashier-closings',
          title: t('ccTitle'),
          text: t('ccSubtitle'),
          visible: operational,
        },
      ],
    ],
    [
      t('financialGroup'),
      [
        { href: '/reports/profit-loss', title: t('plTitle'), text: t('plSubtitle'), visible: financial },
        { href: '/reports/balance-sheet', title: t('bsTitle'), text: t('bsSubtitle'), visible: financial },
        {
          href: '/finance/trial-balance',
          title: t('tbTitle'),
          text: t('tbText'),
          visible: canTenant('journal.read'),
        },
      ],
    ],
    [
      t('cashGroup'),
      [
        { href: '/reports/cashbook', title: t('cbTitle'), text: t('cbSubtitle'), visible: financial },
        { href: '/reports/cash-flow', title: t('cfTitle'), text: t('cfSubtitle'), visible: financial },
        { href: '/reports/revenue', title: t('revTitle'), text: t('revSubtitle'), visible: financial },
        { href: '/reports/tax-summary', title: t('taxTitle'), text: t('taxSubtitle'), visible: financial },
      ],
    ],
    [
      t('agingGroup'),
      [
        { href: '/reports/receivables', title: t('arTitle'), text: t('arSubtitle'), visible: financial },
        { href: '/reports/payables', title: t('apTitle'), text: t('apSubtitle'), visible: financial },
      ],
    ],
    [
      t('controlGroup'),
      [
        { href: '/reports/expenses', title: t('exTitle'), text: t('exSubtitle'), visible: financial },
        {
          href: '/reports/discrepancies',
          title: t('discTitle'),
          text: t('discSubtitle'),
          visible: financial,
        },
        {
          href: '/reports/user-activity',
          title: t('uaTitle'),
          text: t('uaSubtitle'),
          visible: canTenant('audit.read'),
        },
      ],
    ],
  ];
  const shown = groups
    .map(([title, links]) => [title, links.filter((r) => r.visible)] as const)
    .filter(([, links]) => links.length > 0);

  if (shown.length === 0) return <PermissionDenied />;
  return (
    <>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <div className="flex flex-col gap-6">
        {shown.map(([title, links]) => (
          <section key={title}>
            <h2 className="mb-2 text-sm font-semibold uppercase text-muted">{title}</h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {links.map((r) => (
                <Link key={r.href} href={r.href} className="block rounded-lg focus-visible:outline-2">
                  <Card className="h-full hover:border-navy-700/40">
                    <p className="font-semibold text-ink">{r.title}</p>
                    <p className="mt-1 text-sm text-muted">{r.text}</p>
                  </Card>
                </Link>
              ))}
            </div>
          </section>
        ))}
      </div>
    </>
  );
}
