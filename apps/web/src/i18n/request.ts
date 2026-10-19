import { getRequestConfig } from 'next-intl/server';

/**
 * English only for now. Strings live in messages/<locale>.json so Urdu (with RTL) can be added
 * without touching components.
 */
export default getRequestConfig(async () => {
  const locale = 'en';
  return {
    locale,
    timeZone: 'Asia/Karachi',
    messages: (await import(`../../messages/${locale}.json`)).default,
  };
});
