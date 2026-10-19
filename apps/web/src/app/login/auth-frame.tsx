import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';

/** Centred card used by the sign-in steps. */
export function AuthFrame({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  const t = useTranslations('app');
  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <p className="mb-6 text-center text-xl font-semibold tracking-tight text-navy-800">
          {t('name')}
          <span className="block text-xs font-normal tracking-normal text-muted">{t('tagline')}</span>
        </p>
        <div className="rounded-lg border border-line bg-white p-6 shadow-sm sm:p-8">
          <h1 className="text-xl font-semibold text-navy-800">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
          <div className="mt-6">{children}</div>
        </div>
      </div>
    </main>
  );
}
