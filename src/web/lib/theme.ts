import { useCallback, useEffect, useState } from 'react';

export type BurrowTheme = 'basalt' | 'modern' | 'light';

const THEME_STORAGE_KEY = 'burrow-theme';
const THEME_CHANGE_EVENT = 'burrow:theme-change';

export function normalizeTheme(raw: string | null | undefined): BurrowTheme {
  if (raw === 'basalt') return 'basalt';
  if (raw === 'light') return 'light';
  return 'modern';
}

export function getStoredTheme(): BurrowTheme {
  if (typeof window === 'undefined') return 'modern';
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (raw === 'modern' || raw === 'light' || raw === 'basalt') return raw;
    if (raw === 'dark') return 'modern';
    const attr = document.documentElement.getAttribute('data-theme');
    if (attr === 'modern' || attr === 'light' || attr === 'basalt') return attr;
    return 'modern';
  } catch {
    return 'modern';
  }
}

export function applyThemeToDom(theme: BurrowTheme): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (theme === 'light') {
    root.classList.remove('dark');
    root.style.colorScheme = 'light';
  } else {
    root.classList.add('dark');
    root.style.colorScheme = 'dark';
  }
  root.setAttribute('data-theme', theme);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* ignore storage errors */
  }
  window.dispatchEvent(new CustomEvent<BurrowTheme>(THEME_CHANGE_EVENT, { detail: theme }));
}

export const THEME_LABELS: Record<BurrowTheme, string> = {
  basalt: 'Basalt Dark',
  modern: 'Modern Dark',
  light: 'Basalt Light',
};

export function useTheme() {
  const [theme, setThemeState] = useState<BurrowTheme>(() => getStoredTheme());

  useEffect(() => {
    const onThemeChange = (e: Event) => {
      const detail = (e as CustomEvent<BurrowTheme>).detail;
      if (detail) {
        setThemeState(normalizeTheme(detail));
      } else {
        setThemeState(getStoredTheme());
      }
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === THEME_STORAGE_KEY) {
        const next = normalizeTheme(e.newValue);
        setThemeState(next);
        applyThemeToDom(next);
      }
    };
    window.addEventListener(THEME_CHANGE_EVENT, onThemeChange);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(THEME_CHANGE_EVENT, onThemeChange);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const setTheme = useCallback((next: BurrowTheme) => {
    setThemeState(next);
    applyThemeToDom(next);
  }, []);

  const cycleTheme = useCallback(() => {
    const current = getStoredTheme();
    const order: BurrowTheme[] = ['modern', 'basalt', 'light'];
    const idx = order.indexOf(current);
    const next = order[(idx + 1) % order.length] ?? 'modern';
    setTheme(next);
    return next;
  }, [setTheme]);

  return {
    theme,
    setTheme,
    cycleTheme,
    isDark: theme !== 'light',
    isModern: theme === 'modern',
    isBasalt: theme !== 'modern',
  };
}
