import path from 'node:path';

export function resolveLocalPaths(root: string, env: Record<string, string | undefined>) {
  return {
    sqlitePath: path.resolve(root, env.SQLITE_PATH || 'data/burrow.db'),
    storagePath: path.resolve(root, env.LOCAL_STORAGE_PATH || 'data/uploads'),
  };
}

/** Refuse recursive reset of the repository, any ancestor, or a filesystem root. */
export function assertResetDirectory(directory: string, root: string) {
  const relative = path.relative(directory, root);
  if (
    directory === path.parse(directory).root ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
  ) {
    throw new Error(`Unsafe reset directory: ${directory}`);
  }
}

/** Local SQLite is the default; Worker persistence must be selected explicitly. */
export function selectDatabaseTarget(
  args: readonly string[],
  env: Record<string, string | undefined>,
  root: string,
) {
  const has = (...flags: string[]) =>
    args.some((arg) => flags.some((flag) => arg === flag || arg.startsWith(`${flag}=`)));
  const remote = has('--remote', '--r', '-r');
  const worker = has('--worker');
  if (remote && (worker || has('--local', '--l', '-l'))) {
    throw new Error('Cannot combine --remote with --local or --worker');
  }
  if (remote) return { kind: 'remote' as const };
  if (worker) return { kind: 'worker' as const, persistTo: path.resolve(root, 'data') };
  if (env.DATABASE_URL) {
    throw new Error('SQLite commands cannot use DATABASE_URL; select --worker for local D1');
  }
  return { kind: 'node' as const, ...resolveLocalPaths(root, env) };
}
