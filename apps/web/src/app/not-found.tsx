import { useTranslations } from 'next-intl';
import Link from 'next/link';

export default function NotFound() {
  const t = useTranslations('common');
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-3 px-4 text-center">
      <h1 className="text-xl font-semibold text-navy-800">{t('notFoundTitle')}</h1>
      <p className="text-sm text-muted">{t('notFoundBody')}</p>
      <Link href="/" className="text-sm font-medium text-teal-700 underline">
        {t('backHome')}
      </Link>
    </main>
  );
}
