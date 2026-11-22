import { describe, expect, it } from 'vitest';
import { compareStorageInventory } from '../../src/core/adapters/storage/inventory';
// @ts-expect-error untyped local .mjs script
import { resolveInventoryD1Execution } from '../../scripts/inventory-storage.mjs';

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

describe('resolveInventoryD1Execution (#011)', () => {
  const defaultBaseConfig = {
    name: 'burrow',
    d1_databases: [{ binding: 'DB', database_name: 'burrow', migrations_dir: 'migrations' }],
    r2_buckets: [{ binding: 'FILES', bucket_name: 'burrow-files' }],
  };

  it('selects burrow-staging and staging config when --remote --staging are passed', () => {
    const execution = resolveInventoryD1Execution({
      args: ['--remote', '--staging'],
      env: {},
      baseConfig: defaultBaseConfig,
      getConfigArgs: ({ profile }: { profile: { localConfigFilename: string } }) => [
        '--config',
        profile.localConfigFilename,
      ],
    });
    expect(execution.target.kind).toBe('remote');
    expect(execution.profile?.isStaging).toBe(true);
    expect(execution.databaseName).toBe('burrow-staging');
    expect(execution.d1Args).toEqual(['--config', 'wrangler.staging.local.jsonc', '--remote']);
  });

  it('selects production burrow database and wrangler.local.jsonc for --remote without --staging', () => {
    const execution = resolveInventoryD1Execution({
      args: ['--remote'],
      env: {},
      baseConfig: defaultBaseConfig,
      getConfigArgs: ({ profile }: { profile: { localConfigFilename: string } }) => [
        '--config',
        profile.localConfigFilename,
      ],
    });
    expect(execution.target.kind).toBe('remote');
    expect(execution.profile?.isStaging).toBe(false);
    expect(execution.databaseName).toBe('burrow');
    expect(execution.d1Args).toEqual(['--config', 'wrangler.local.jsonc', '--remote']);
  });

  it('respects custom renamed wrangler.jsonc database names on cloned deployments', () => {
    const execution = resolveInventoryD1Execution({
      args: ['--remote'],
      env: {},
      baseConfig: {
        name: 'my-team-notes',
        d1_databases: [{ binding: 'DB', database_name: 'my-team-notes-db' }],
        r2_buckets: [{ binding: 'FILES', bucket_name: 'my-team-notes-files' }],
      },
      getConfigArgs: ({ profile }: { profile: { localConfigFilename: string } }) => [
        '--config',
        profile.localConfigFilename,
      ],
    });
    expect(execution.target.kind).toBe('remote');
    expect(execution.databaseName).toBe('my-team-notes-db');
  });
});
