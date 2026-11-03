import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertResetDirectory,
  resolveLocalPaths,
  selectDatabaseTarget,
} from '../../src/server/database-target';

const root = path.resolve('test-burrow');

describe('database command targets', () => {
  it('defaults to the Node database and storage paths used by development', () => {
    expect(selectDatabaseTarget([], {}, root)).toEqual({
      kind: 'node',
      sqlitePath: path.join(root, 'data/burrow.db'),
      storagePath: path.join(root, 'data/uploads'),
    });
  });

  it('resolves configured local paths relative to the repository', () => {
    expect(
      resolveLocalPaths(root, {
        SQLITE_PATH: 'custom/notes.db',
        LOCAL_STORAGE_PATH: 'custom/files',
      }),
    ).toEqual({
      sqlitePath: path.join(root, 'custom/notes.db'),
      storagePath: path.join(root, 'custom/files'),
    });
  });

  it('requires an explicit Worker target and matches dev:worker persistence', () => {
    expect(
      selectDatabaseTarget(['--worker'], { DATABASE_URL: 'postgres://example/test' }, root),
    ).toEqual({ kind: 'worker', persistTo: path.join(root, 'data') });
  });

  it.each(['--remote', '--r', '-r'])('preserves the %s remote alias', (flag) => {
    expect(selectDatabaseTarget([flag], {}, root)).toEqual({ kind: 'remote' });
  });

  it.each(['--worker', '--local', '--l', '-l'])('rejects remote combined with %s', (flag) => {
    expect(() => selectDatabaseTarget(['--remote', flag], {}, root)).toThrow('Cannot combine');
  });

  it('refuses to silently select SQLite when the Node runtime uses PostgreSQL', () => {
    expect(() =>
      selectDatabaseTarget([], { DATABASE_URL: 'postgres://example/test' }, root),
    ).toThrow('DATABASE_URL');
  });

  it('permits reset of a named storage directory but rejects roots and ancestors', () => {
    expect(() => assertResetDirectory(path.join(root, 'data/uploads'), root)).not.toThrow();
    for (const unsafe of [root, path.dirname(root), path.parse(root).root]) {
      expect(() => assertResetDirectory(unsafe, root)).toThrow('Unsafe reset directory');
    }
  });
});
