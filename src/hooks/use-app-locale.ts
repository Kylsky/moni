import { useEffect, useState } from 'react';
import { type AppLocale, localeMeta } from '@/lib/locale';

export type LanguagePreference = 'browser' | AppLocale;

export function useAppLocale(initialLocale?: AppLocale) {
  const [preference, setPreference] = useState<LanguagePreference>(
    initialLocale ?? 'browser'
  );
  const [browser, setBrowser] = useState<AppLocale>('en');
  useEffect(() => {
    setBrowser(navigator.language.startsWith('zh') ? 'zh' : 'en');
    if (initialLocale) {
      setPreference(initialLocale);
      localStorage.setItem('moni-language', initialLocale);
      return;
    }
    const saved = localStorage.getItem('moni-language');
    if (saved === 'en' || saved === 'zh') setPreference(saved);
  }, [initialLocale]);
  const locale = preference === 'browser' ? browser : preference;
  useEffect(() => {
    document.documentElement.lang = localeMeta[locale].hreflang;
  }, [locale]);
  function selectLanguage(value: LanguagePreference) {
    setPreference(value);
    localStorage.setItem('moni-language', value);
  }
  return { locale, preference, selectLanguage };
}
