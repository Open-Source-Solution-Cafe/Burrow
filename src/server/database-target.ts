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

export const KNOWN_CLI_FLAGS = new Set([
  '--remote',
  '--r',
  '-r',
  '--worker',
  '--local',
  '--l',
  '-l',
  '--postgres',
  '--staging',
  '--env',
  '--name',
  '--domain',
  '--domains',
  '--workers-dev',
  '--dry-run',
  '--force',
  '--rotate-bootstrap-token',
  '--skip-checks',
  '--keep-r2',
  '--skip-r2-check',
  '--clean-r2',
  '--confirm',
  '--confirm-production-reset',
  '--confirm-production-teardown',
  '--confirm-demo-reset',
  '--demo',
  '--email',
  '--password',
  '--sqlite',
  '--build',
  '--help',
  '-h',
]);

export const VALUE_CLI_FLAGS = new Set([
  '--env',
  '--name',
  '--domain',
  '--domains',
  '--confirm',
  '--confirm-production-reset',
  '--confirm-production-teardown',
  '--confirm-demo-reset',
  '--email',
  '--password',
]);

export interface ParsedCliArgs {
  booleanFlags: Record<string, boolean>;
  values: Record<string, string>;
  positionals: string[];
}

export function parseCliArgs(
  args: readonly string[],
  allowedFlags: ReadonlySet<string> = KNOWN_CLI_FLAGS,
): ParsedCliArgs {
  const booleanFlags: Record<string, boolean> = {};
  const values: Record<string, string> = {};
  const positionals: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg || arg === '--') continue;

    if (!arg.startsWith('-')) {
      positionals.push(arg);
      continue;
    }

    const eqIdx = arg.indexOf('=');
    const flagName = eqIdx === -1 ? arg : arg.slice(0, eqIdx);
    if (!allowedFlags.has(flagName)) {
      throw new Error(`Unknown CLI argument: ${flagName}`);
    }

    if (VALUE_CLI_FLAGS.has(flagName)) {
      let value: string;
      if (eqIdx !== -1) {
        value = arg.slice(eqIdx + 1);
      } else {
        const next = args[i + 1];
        if (next === undefined || next.startsWith('-')) {
          throw new Error(`Missing value for CLI argument: ${flagName}`);
        }
        value = next;
        i += 1;
      }
      if (!value.trim()) {
        throw new Error(`Missing value for CLI argument: ${flagName}`);
      }
      values[flagName] = value.trim();
      continue;
    }

    if (eqIdx !== -1) {
      const rawBool = arg.slice(eqIdx + 1).trim().toLowerCase();
      if (rawBool === 'true') {
        booleanFlags[flagName] = true;
      } else if (rawBool === 'false') {
        booleanFlags[flagName] = false;
      } else {
        throw new Error(`Invalid boolean value "${arg.slice(eqIdx + 1)}" for CLI argument: ${flagName}`);
      }
    } else {
      booleanFlags[flagName] = true;
    }
  }

  if (booleanFlags['--staging'] === true && values['--env'] && values['--env'] !== 'staging') {
    throw new Error(
      `Contradictory CLI arguments: cannot combine --staging with --env=${values['--env']}`,
    );
  }
  if (booleanFlags['--staging'] === false && values['--env'] === 'staging') {
    throw new Error('Contradictory CLI arguments: cannot combine --staging=false with --env=staging');
  }
  if (booleanFlags['--demo'] === true && booleanFlags['--staging'] === true) {
    throw new Error('Contradictory CLI arguments: cannot combine --demo with --staging');
  }
  if (booleanFlags['--demo'] === true && values['--env'] && values['--env'] !== 'demo') {
    throw new Error(
      `Contradictory CLI arguments: cannot combine --demo with --env=${values['--env']}`,
    );
  }
  if (booleanFlags['--demo'] === false && values['--env'] === 'demo') {
    throw new Error('Contradictory CLI arguments: cannot combine --demo=false with --env=demo');
  }

  return { booleanFlags, values, positionals };
}

/** Local SQLite is the default; Worker persistence must be selected explicitly. */
export function selectDatabaseTarget(
  args: readonly string[],
  env: Record<string, string | undefined>,
  root: string,
) {
  const parsed = parseCliArgs(args);
  const isSet = (...flags: string[]) => flags.some((flag) => parsed.booleanFlags[flag] === true);
  const remote = isSet('--remote', '--r', '-r');
  const worker = isSet('--worker');
  const local = isSet('--local', '--l', '-l');
  if (remote && (worker || local)) {
    throw new Error('Cannot combine --remote with --local or --worker');
  }
  if (worker && local) {
    throw new Error('Cannot combine --worker with --local');
  }
  if (remote) return { kind: 'remote' as const };
  if (worker) return { kind: 'worker' as const, persistTo: path.resolve(root, 'data') };
  if (env.DATABASE_URL) {
    throw new Error('SQLite commands cannot use DATABASE_URL; select --worker for local D1');
  }
  return { kind: 'node' as const, ...resolveLocalPaths(root, env) };
}
