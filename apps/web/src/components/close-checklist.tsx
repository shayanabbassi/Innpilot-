'use client';

import type { CloseCheckDto } from '@innpilot/contracts';
import { useTranslations } from 'next-intl';

/** Blockers first (they stop the close), then warnings (accepted with a reason). */
export function CloseChecklist({ items }: { items: CloseCheckDto[] }) {
  const t = useTranslations('close');
  if (items.length === 0) return <p className="text-sm text-success">{t('allClear')}</p>;
  const group = (severity: CloseCheckDto['severity']) => items.filter((i) => i.severity === severity);
  return (
    <div className="flex flex-col gap-3 text-sm">
      {(['blocker', 'warning'] as const).map((severity) =>
        group(severity).length === 0 ? null : (
          <section key={severity}>
            <h3 className={`mb-1 font-medium ${severity === 'blocker' ? 'text-danger' : 'text-warning'}`}>
              {t(severity === 'blocker' ? 'blockers' : 'warnings')}
            </h3>
            <ul className="flex flex-col gap-1">
              {group(severity).map((i, n) => (
                <li key={`${i.check}-${n}`} className="rounded-md border border-line bg-canvas px-2 py-1">
                  <span className="font-medium">{t(`checks.${i.check}`)}</span>
                  <span className="text-muted">
                    {' '}
                    · {i.label}
                    {i.detail ? ` · ${i.detail}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ),
      )}
    </div>
  );
}
