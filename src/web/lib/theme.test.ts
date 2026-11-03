import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyThemeToDom, getStoredTheme } from './theme';

afterEach(() => vi.unstubAllGlobals());

describe('saved theme restoration', () => {
  it.each(['basalt', 'modern', 'light'] as const)('restores %s on a fresh page', (saved) => {
    const values = new Map([['burrow-theme', saved]]);
    const attributes = new Map<string, string>();
    const classes = new Set<string>();
    const root = {
      style: { colorScheme: '' },
      getAttribute: (name: string) => attributes.get(name) ?? null,
      setAttribute: (name: string, value: string) => attributes.set(name, value),
      classList: {
        add: (name: string) => classes.add(name),
        remove: (name: string) => classes.delete(name),
      },
    };
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key),
      setItem: (key: string, value: typeof saved) => values.set(key, value),
    });
    vi.stubGlobal('document', { documentElement: root });
    vi.stubGlobal('window', { dispatchEvent: vi.fn() });

    applyThemeToDom(getStoredTheme());

    expect(attributes.get('data-theme')).toBe(saved);
    expect(classes.has('dark')).toBe(saved !== 'light');
    expect(root.style.colorScheme).toBe(saved === 'light' ? 'light' : 'dark');
    expect(values.get('burrow-theme')).toBe(saved);
  });
});
