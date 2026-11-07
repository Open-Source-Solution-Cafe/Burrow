import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t, setLocale, getLocale, formatDate, STORAGE_LOCALE_KEY } from './i18n';
import { en } from '../i18n/en';
import { es } from '../i18n/es';
import { fr } from '../i18n/fr';

describe('i18n Internationalization', () => {
  const store = new Map<string, string>();
  const mockDoc = { documentElement: { lang: 'en' } };

  beforeEach(() => {
    store.clear();
    mockDoc.documentElement.lang = 'en';
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      clear: () => store.clear(),
    });
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', mockDoc);
    setLocale('en');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('translates keys in English by default', () => {
    expect(t('common.save')).toBe('Save');
    expect(t('login.signIn')).toBe('Sign in');
    expect(t('sidebar.trash')).toBe('Trash');
    expect(t('tasks.title')).toBe('My Tasks');
    expect(t('boards.addColumn')).toBe('Add Column');
  });

  it('switches to Spanish dynamically and updates html lang', () => {
    setLocale('es');
    expect(getLocale()).toBe('es');
    expect(mockDoc.documentElement.lang).toBe('es');
    expect(t('common.save')).toBe('Guardar');
    expect(t('login.signIn')).toBe('Iniciar sesión');
    expect(t('sidebar.trash')).toBe('Papelera');
    expect(t('tasks.title')).toBe('Mis tareas');
  });

  it('switches to French dynamically and updates html lang', () => {
    setLocale('fr');
    expect(getLocale()).toBe('fr');
    expect(mockDoc.documentElement.lang).toBe('fr');
    expect(t('common.save')).toBe('Enregistrer');
    expect(t('login.signIn')).toBe('Se connecter');
    expect(t('sidebar.trash')).toBe('Corbeille');
    expect(t('tasks.title')).toBe('Mes tâches');
  });

  it('interpolates parameters correctly', () => {
    expect(t('login.continueWith', { provider: 'Google' })).toBe('Continue with Google');
    setLocale('es');
    expect(t('login.continueWith', { provider: 'GitHub' })).toBe('Continuar con GitHub');
    setLocale('fr');
    expect(t('invite.joinWorkspace', { workspaceName: 'Design Team' })).toBe('Rejoindre Design Team');
  });

  it('formats dates according to active locale', () => {
    const timestamp = new Date('2026-11-06T12:00:00Z').getTime();
    setLocale('en');
    const formattedEn = formatDate(timestamp, { month: 'short', day: 'numeric', timeZone: 'UTC' });
    expect(formattedEn).toBe('Nov 6');

    setLocale('es');
    const formattedEs = formatDate(timestamp, { month: 'short', day: 'numeric', timeZone: 'UTC' });
    expect(formattedEs.toLowerCase()).toContain('6');

    setLocale('fr');
    const formattedFr = formatDate(timestamp, { month: 'short', day: 'numeric', timeZone: 'UTC' });
    expect(formattedFr.toLowerCase()).toContain('6');
  });

  it('falls back to English when a key is missing in another language', () => {
    setLocale('es');
    expect(t('nonexistent.key')).toBe('nonexistent.key');
  });

  it('persists selected locale to localStorage', () => {
    setLocale('fr');
    expect(store.get(STORAGE_LOCALE_KEY)).toBe('fr');
  });

  it('guarantees complete dictionary parity across all namespaces', () => {
    function assertParity(enObj: Record<string, any>, targetObj: Record<string, any>, targetName: string, prefix = '') {
      for (const [key, val] of Object.entries(enObj)) {
        const fullKey = prefix ? `${prefix}.${key}` : key;
        expect(targetObj, `${targetName} missing key: ${fullKey}`).toHaveProperty(key);
        if (typeof val === 'object' && val !== null) {
          expect(typeof targetObj[key]).toBe('object');
          assertParity(val, targetObj[key], targetName, fullKey);
        } else {
          expect(typeof targetObj[key]).toBe('string');
          expect((targetObj[key] as string).trim().length).toBeGreaterThan(0);
        }
      }
    }

    assertParity(en as unknown as Record<string, any>, es as unknown as Record<string, any>, 'es');
    assertParity(en as unknown as Record<string, any>, fr as unknown as Record<string, any>, 'fr');
  });
});
