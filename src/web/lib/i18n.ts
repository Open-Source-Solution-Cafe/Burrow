import { useSyncExternalStore } from 'react';
import { en, type TranslationDictionary } from '../i18n/en';
import { es } from '../i18n/es';
import { fr } from '../i18n/fr';

export type Locale = 'en' | 'es' | 'fr';

const dictionaries: Record<Locale, TranslationDictionary> = { en, es, fr };

export const STORAGE_LOCALE_KEY = 'burrow-locale';

export function detectBrowserLocale(): Locale {
  if (typeof window !== 'undefined') {
    try {
      const saved = localStorage.getItem(STORAGE_LOCALE_KEY);
      if (saved === 'en' || saved === 'es' || saved === 'fr') return saved;
      const nav = navigator.language?.toLowerCase() ?? '';
      if (nav.startsWith('es')) return 'es';
      if (nav.startsWith('fr')) return 'fr';
    } catch {
      // In restricted storage contexts, continue to fallback
    }
  }
  return 'en';
}

let activeLocale: Locale = detectBrowserLocale();
const subscribers = new Set<() => void>();

export function getLocale(): Locale {
  return activeLocale;
}

export function setLocale(nextLocale: Locale): void {
  if (activeLocale === nextLocale) return;
  activeLocale = nextLocale;
  if (typeof window !== 'undefined') {
    try {
      localStorage.setItem(STORAGE_LOCALE_KEY, nextLocale);
    } catch {
      // Ignore storage write issues
    }
  }
  for (const notify of subscribers) {
    notify();
  }
}

function subscribe(callback: () => void): () => void {
  subscribers.add(callback);
  return () => {
    subscribers.delete(callback);
  };
}

export function t(key: string, params?: Record<string, string | number>): string {
  const dict = dictionaries[activeLocale] || dictionaries.en;
  const segments = key.split('.');
  let resolved: any = dict;

  for (const segment of segments) {
    if (resolved && typeof resolved === 'object' && segment in resolved) {
      resolved = resolved[segment];
    } else {
      // Fall back to English dictionary
      let fallback: any = dictionaries.en;
      for (const fallbackSeg of segments) {
        if (fallback && typeof fallback === 'object' && fallbackSeg in fallback) {
          fallback = fallback[fallbackSeg];
        } else {
          fallback = undefined;
          break;
        }
      }
      resolved = fallback;
      break;
    }
  }

  if (typeof resolved !== 'string') {
    return key;
  }

  if (params) {
    return Object.entries(params).reduce(
      (acc, [placeholder, replacement]) =>
        acc.replace(new RegExp(`\\{${placeholder}\\}`, 'g'), String(replacement)),
      resolved,
    );
  }

  return resolved;
}

export function useTranslation() {
  const locale = useSyncExternalStore(subscribe, getLocale, () => 'en');
  return {
    t,
    locale,
    setLocale,
  };
}
