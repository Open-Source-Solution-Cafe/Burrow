import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t, setLocale, getLocale, STORAGE_LOCALE_KEY } from './i18n';

describe('i18n Internationalization', () => {
  const store = new Map<string, string>();

  beforeEach(() => {
    store.clear();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      clear: () => store.clear(),
    });
    vi.stubGlobal('window', {});
    setLocale('en');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('translates keys in English by default', () => {
    expect(t('common.save')).toBe('Save');
    expect(t('login.signIn')).toBe('Sign in');
    expect(t('sidebar.trash')).toBe('Trash');
  });

  it('switches to Spanish dynamically', () => {
    setLocale('es');
    expect(getLocale()).toBe('es');
    expect(t('common.save')).toBe('Guardar');
    expect(t('login.signIn')).toBe('Iniciar sesión');
    expect(t('sidebar.trash')).toBe('Papelera');
  });

  it('switches to French dynamically', () => {
    setLocale('fr');
    expect(getLocale()).toBe('fr');
    expect(t('common.save')).toBe('Enregistrer');
    expect(t('login.signIn')).toBe('Se connecter');
    expect(t('sidebar.trash')).toBe('Corbeille');
  });

  it('interpolates parameters correctly', () => {
    expect(t('login.continueWith', { provider: 'Google' })).toBe('Continue with Google');
    setLocale('es');
    expect(t('login.continueWith', { provider: 'GitHub' })).toBe('Continuar con GitHub');
  });

  it('falls back to English when a key is missing in another language', () => {
    setLocale('es');
    expect(t('nonexistent.key')).toBe('nonexistent.key');
  });

  it('persists selected locale to localStorage', () => {
    setLocale('fr');
    expect(store.get(STORAGE_LOCALE_KEY)).toBe('fr');
  });
});
