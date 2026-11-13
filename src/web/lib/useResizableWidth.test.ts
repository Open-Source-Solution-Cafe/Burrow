import { afterEach, describe, expect, it, vi } from 'vitest';
import { clampWidth, persistWidth, readStoredWidth } from './useResizableWidth';

afterEach(() => vi.unstubAllGlobals());

describe('useResizableWidth helpers', () => {
  it('clamps values to [minWidth, maxWidth]', () => {
    expect(clampWidth(120, 200, 480)).toBe(200);
    expect(clampWidth(320, 200, 480)).toBe(320);
    expect(clampWidth(640, 200, 480)).toBe(480);
  });

  it('reads and clamps persisted width from localStorage', () => {
    const store = new Map<string, string>([
      ['sidebar:modern-width', '310'],
      ['sidebar:too-small', '80'],
      ['sidebar:invalid', 'not-a-number'],
    ]);
    vi.stubGlobal('window', {});
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
    });

    expect(readStoredWidth('sidebar:modern-width', 232, 200, 480)).toBe(310);
    expect(readStoredWidth('sidebar:too-small', 232, 200, 480)).toBe(200);
    expect(readStoredWidth('sidebar:invalid', 232, 200, 480)).toBe(232);
    expect(readStoredWidth('sidebar:missing', 232, 200, 480)).toBe(232);

    persistWidth('sidebar:modern-width', 360);
    expect(store.get('sidebar:modern-width')).toBe('360');
  });
});
