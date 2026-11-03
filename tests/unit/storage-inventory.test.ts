import { describe, expect, it } from 'vitest';
import { compareStorageInventory } from '../../src/core/adapters/storage/inventory';

describe('compareStorageInventory', () => {
  it('excludes only scoped internal policy objects', () => {
    expect(compareStorageInventory([], ['w/p/.upload-policy.json', '.upload-policy.json', 'w/p/deep/.upload-policy.json'])).toEqual({
      missingObjects: [], unregisteredObjects: ['.upload-policy.json', 'w/p/deep/.upload-policy.json'],
    });
  });
  it('reports missing registered objects and stored objects without registrations', () => {
    expect(
      compareStorageInventory(
        ['w/p/a.png', 'w/p/b.png', 'w/p/a.png'],
        ['w/p/b.png', 'legacy/orphan.png', 'legacy/orphan.png'],
      ),
    ).toEqual({
      missingObjects: ['w/p/a.png'],
      unregisteredObjects: ['legacy/orphan.png'],
    });
  });

  it('returns empty results when the registry and store match', () => {
    expect(compareStorageInventory(['a.png', 'b.png'], ['b.png', 'a.png'])).toEqual({
      missingObjects: [],
      unregisteredObjects: [],
    });
  });

  it('handles empty registry and object store', () => {
    expect(compareStorageInventory([], [])).toEqual({
      missingObjects: [],
      unregisteredObjects: [],
    });
  });
});
