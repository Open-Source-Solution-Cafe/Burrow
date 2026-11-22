import type { PostgresLikeSql } from './plugin-db';
import { ALLOWLISTABLE_CORE_TABLES } from './manifest';

const EXECUTOR_ROLE = 'burrow_plugin_executor';
const FK_PARENT_TABLES = ['workspaces', 'projects', 'boards', 'cards', 'notepads', 'user'] as const;

export function pluginPostgresSchemaName(pluginId: string): string {
  return `plugin_${pluginId.replace(/-/g, '_')}`;
}

export function pluginPostgresRoleName(pluginId: string): string {
  return `${pluginPostgresSchemaName(pluginId)}_role`;
}

export interface PostgresIsolationProvisionOptions {
  coreTables?: readonly string[];
  allowSchemaCreate?: boolean;
}

const provisionedByClient = new WeakMap<object, Map<string, string>>();

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function quoteLiteral(val: string): string {
  return `'${val.replace(/'/g, "''")}'`;
}

function makeProvisionKey(pluginId: string, opts: PostgresIsolationProvisionOptions): string {
  const core = [...(opts.coreTables ?? [])].sort().join(',');
  return `${pluginId}:${opts.allowSchemaCreate ? 'create' : 'ro'}:${core}`;
}

/**
 * Installs PostgreSQL server-level DDL event triggers preventing plugin roles from defining
 * functions/triggers/extensions or mutating schemas outside their own `plugin_<id>`.
 * Runs inside a privilege-tolerant block so non-superuser managed DB connections skip superuser-only hooks gracefully.
 */
async function ensureDdlEventTrigger(tx: PostgresLikeSql): Promise<void> {
  await tx.unsafe(`
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'burrow_enforce_plugin_ddl') THEN
    CREATE FUNCTION public.burrow_enforce_plugin_ddl() RETURNS event_trigger
    LANGUAGE plpgsql SECURITY DEFINER AS $fn$
    DECLARE
      cmd record;
      allowed_schema text;
    BEGIN
      IF current_user NOT LIKE 'plugin\\_%\\_role' ESCAPE '\\' AND current_user <> '${EXECUTOR_ROLE}' THEN
        RETURN;
      END IF;
      IF current_user = '${EXECUTOR_ROLE}' THEN
        RAISE EXCEPTION 'permission denied for plugin executor DDL' USING ERRCODE = '42501';
      END IF;
      IF TG_TAG IN (
        'CREATE FUNCTION', 'ALTER FUNCTION', 'DROP FUNCTION',
        'CREATE PROCEDURE', 'ALTER PROCEDURE', 'DROP PROCEDURE',
        'CREATE TRIGGER', 'ALTER TRIGGER', 'DROP TRIGGER',
        'CREATE EVENT TRIGGER', 'ALTER EVENT TRIGGER', 'DROP EVENT TRIGGER',
        'CREATE EXTENSION', 'ALTER EXTENSION', 'DROP EXTENSION',
        'CREATE ROLE', 'ALTER ROLE', 'DROP ROLE'
      ) THEN
        RAISE EXCEPTION 'permission denied: plugins cannot execute %', TG_TAG USING ERRCODE = '42501';
      END IF;
      allowed_schema := regexp_replace(current_user, '_role$', '');
      IF TG_EVENT = 'ddl_command_end' THEN
        FOR cmd IN SELECT schema_name, object_type FROM pg_event_trigger_ddl_commands()
        LOOP
          IF cmd.object_type IN ('function', 'procedure', 'aggregate', 'trigger', 'event trigger', 'extension') THEN
            RAISE EXCEPTION 'permission denied: plugins cannot create %', cmd.object_type USING ERRCODE = '42501';
          END IF;
          IF cmd.schema_name IS NOT NULL AND cmd.schema_name <> allowed_schema THEN
            RAISE EXCEPTION 'permission denied for schema % (plugin owns %)', cmd.schema_name, allowed_schema USING ERRCODE = '42501';
          END IF;
        END LOOP;
      END IF;
    END $fn$;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'burrow_enforce_plugin_drop') THEN
    CREATE FUNCTION public.burrow_enforce_plugin_drop() RETURNS event_trigger
    LANGUAGE plpgsql SECURITY DEFINER AS $fn$
    DECLARE
      obj record;
      allowed_schema text;
    BEGIN
      IF current_user NOT LIKE 'plugin\\_%\\_role' ESCAPE '\\' AND current_user <> '${EXECUTOR_ROLE}' THEN
        RETURN;
      END IF;
      allowed_schema := regexp_replace(current_user, '_role$', '');
      FOR obj IN SELECT schema_name, object_type FROM pg_event_trigger_dropped_objects()
      LOOP
        IF obj.schema_name IS NOT NULL AND obj.schema_name <> allowed_schema THEN
          RAISE EXCEPTION 'permission denied to drop % in schema %', obj.object_type, obj.schema_name USING ERRCODE = '42501';
        END IF;
      END LOOP;
    END $fn$;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_event_trigger WHERE evtname = 'burrow_plugin_ddl_start') THEN
    CREATE EVENT TRIGGER burrow_plugin_ddl_start ON ddl_command_start EXECUTE FUNCTION public.burrow_enforce_plugin_ddl();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_event_trigger WHERE evtname = 'burrow_plugin_ddl_end') THEN
    CREATE EVENT TRIGGER burrow_plugin_ddl_end ON ddl_command_end EXECUTE FUNCTION public.burrow_enforce_plugin_ddl();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_event_trigger WHERE evtname = 'burrow_plugin_sql_drop') THEN
    CREATE EVENT TRIGGER burrow_plugin_sql_drop ON sql_drop EXECUTE FUNCTION public.burrow_enforce_plugin_drop();
  END IF;
EXCEPTION
  WHEN insufficient_privilege THEN
    NULL;
END $$;
  `);
}

/**
 * Provisions a dedicated NOLOGIN Postgres role (`plugin_<id>_role`) and schema (`plugin_<id>`),
 * revokes default/public/cross-plugin privileges, and grants access only on its own schema plus
 * FK REFERENCES and explicit `manifest.coreTables` SELECT grants.
 */
export async function provisionPluginPostgresIsolation(
  txOrClient: PostgresLikeSql,
  pluginId: string,
  options: PostgresIsolationProvisionOptions = {},
): Promise<{ schemaName: string; roleName: string }> {
  const schemaName = pluginPostgresSchemaName(pluginId);
  const roleName = pluginPostgresRoleName(pluginId);

  for (const tbl of options.coreTables ?? []) {
    if (!ALLOWLISTABLE_CORE_TABLES.has(tbl)) {
      throw new Error(`Plugin "${pluginId}" coreTables entry "${tbl}" is forbidden`);
    }
  }

  const applyProvision = async (tx: PostgresLikeSql) => {
    await tx.unsafe("SELECT pg_advisory_xact_lock(hashtext('burrow:plugin_isolation'))");

    await tx.unsafe(`
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${quoteLiteral(EXECUTOR_ROLE)}) THEN
    CREATE ROLE ${quoteIdent(EXECUTOR_ROLE)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${quoteLiteral(roleName)}) THEN
    CREATE ROLE ${quoteIdent(roleName)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
  EXECUTE format('GRANT %I TO %I', ${quoteLiteral(roleName)}, ${quoteLiteral(EXECUTOR_ROLE)});
  EXECUTE format('GRANT %I TO CURRENT_USER', ${quoteLiteral(roleName)});
EXCEPTION
  WHEN insufficient_privilege THEN
    NULL;
END $$;
    `);

    await tx.unsafe(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schemaName)}`);
    await tx.unsafe(`
DO $$
BEGIN
  EXECUTE format('ALTER SCHEMA %I OWNER TO %I', ${quoteLiteral(schemaName)}, ${quoteLiteral(roleName)});
EXCEPTION
  WHEN insufficient_privilege THEN
    NULL;
END $$;
    `);

    // Revoke PUBLIC, executor, and plugin grants on core schemas/objects & pg_notify
    await tx.unsafe(`REVOKE ALL ON SCHEMA ${quoteIdent(schemaName)} FROM PUBLIC`);
    await tx.unsafe(`
DO $$
BEGIN
  EXECUTE format('REVOKE ALL ON SCHEMA %I FROM %I', ${quoteLiteral(schemaName)}, ${quoteLiteral(EXECUTOR_ROLE)});
  REVOKE CREATE ON SCHEMA public FROM PUBLIC;
  EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I', ${quoteLiteral(EXECUTOR_ROLE)});
  EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I', ${quoteLiteral(roleName)});
  EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC, %I, %I', ${quoteLiteral(EXECUTOR_ROLE)}, ${quoteLiteral(roleName)});
  EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, %I, %I', ${quoteLiteral(EXECUTOR_ROLE)}, ${quoteLiteral(roleName)});
EXCEPTION
  WHEN insufficient_privilege THEN
    NULL;
END $$;
    `);

    await tx.unsafe(`
DO $$
BEGIN
  REVOKE EXECUTE ON FUNCTION pg_catalog.pg_notify(text, text) FROM PUBLIC;
  EXECUTE format('REVOKE EXECUTE ON FUNCTION pg_catalog.pg_notify(text, text) FROM %I, %I', ${quoteLiteral(EXECUTOR_ROLE)}, ${quoteLiteral(roleName)});
EXCEPTION
  WHEN insufficient_privilege OR undefined_function THEN
    NULL;
END $$;
    `);

    // Cross-plugin isolation across all plugin_* schemas and roles
    await tx.unsafe(`
DO $$
DECLARE
  s record;
  r record;
BEGIN
  FOR s IN SELECT nspname FROM pg_namespace WHERE nspname LIKE 'plugin\\_%' ESCAPE '\\' AND nspname <> ${quoteLiteral(schemaName)}
  LOOP
    EXECUTE format('REVOKE ALL ON SCHEMA %I FROM %I', s.nspname, ${quoteLiteral(roleName)});
    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM %I', s.nspname, ${quoteLiteral(roleName)});
  END LOOP;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname LIKE 'plugin\\_%\\_role' ESCAPE '\\' AND rolname <> ${quoteLiteral(roleName)}
  LOOP
    EXECUTE format('REVOKE ALL ON SCHEMA %I FROM %I', ${quoteLiteral(schemaName)}, r.rolname);
    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM %I', ${quoteLiteral(schemaName)}, r.rolname);
  END LOOP;
EXCEPTION
  WHEN insufficient_privilege THEN
    NULL;
END $$;
    `);

    // Own-schema grants & public schema lookup
    await tx.unsafe(`GRANT USAGE ON SCHEMA public TO ${quoteIdent(roleName)}`);
    if (options.allowSchemaCreate) {
      await tx.unsafe(`GRANT USAGE, CREATE ON SCHEMA ${quoteIdent(schemaName)} TO ${quoteIdent(roleName)}`);
    } else {
      await tx.unsafe(`REVOKE CREATE ON SCHEMA ${quoteIdent(schemaName)} FROM ${quoteIdent(roleName)}`);
      await tx.unsafe(`GRANT USAGE ON SCHEMA ${quoteIdent(schemaName)} TO ${quoteIdent(roleName)}`);
    }
    await tx.unsafe(
      `GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${quoteIdent(schemaName)} TO ${quoteIdent(roleName)}`,
    );
    await tx.unsafe(
      `GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA ${quoteIdent(schemaName)} TO ${quoteIdent(roleName)}`,
    );

    // Grant FK REFERENCES(id) on existing core parent tables without granting SELECT
    for (const parent of FK_PARENT_TABLES) {
      await tx.unsafe(`
DO $$
BEGIN
  IF to_regclass(${quoteLiteral(`public.${parent}`)}) IS NOT NULL THEN
    EXECUTE format('GRANT REFERENCES (id) ON TABLE public.%I TO %I', ${quoteLiteral(parent)}, ${quoteLiteral(roleName)});
  END IF;
EXCEPTION
  WHEN insufficient_privilege OR undefined_column THEN
    NULL;
END $$;
      `);
    }

    // Grant SELECT only on explicit manifest.coreTables allowlist (never exposing invites.token_hash)
    for (const tbl of options.coreTables ?? []) {
      if (!ALLOWLISTABLE_CORE_TABLES.has(tbl)) continue;
      if (tbl === 'invites') {
        await tx.unsafe(`
DO $$
BEGIN
  IF to_regclass('public.invites') IS NOT NULL THEN
    EXECUTE format(
      'GRANT SELECT (id, workspace_id, email, role, invited_by, expires_at, accepted_at, created_at) ON TABLE public.invites TO %I',
      ${quoteLiteral(roleName)}
    );
  END IF;
END $$;
        `);
      } else {
        await tx.unsafe(`
DO $$
BEGIN
  IF to_regclass(${quoteLiteral(`public.${tbl}`)}) IS NOT NULL THEN
    EXECUTE format('GRANT SELECT ON TABLE public.%I TO %I', ${quoteLiteral(tbl)}, ${quoteLiteral(roleName)});
  END IF;
END $$;
        `);
      }
    }

    // Install SECURITY DEFINER restricted statement runner owned by plugin role for utility commands
    await tx.unsafe(`
DO $$
BEGIN
  EXECUTE format($sql$
    CREATE OR REPLACE FUNCTION %I._exec_restricted(sql_text text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = %I, public AS $fn$
    DECLARE
      cleaned text;
    BEGIN
      cleaned := regexp_replace(sql_text, '/\\*.*?\\*/|--[^\\n]*', ' ', 'g');
      IF cleaned ~* '(^|;)\\s*(LISTEN|UNLISTEN|NOTIFY)(\\s|;|$)' THEN
        RAISE EXCEPTION 'permission denied for LISTEN/NOTIFY in plugin role' USING ERRCODE = '42501';
      END IF;
      EXECUTE sql_text;
    END $fn$;
  $sql$, ${quoteLiteral(schemaName)}, ${quoteLiteral(schemaName)});
  EXECUTE format('ALTER FUNCTION %I._exec_restricted(text) OWNER TO %I', ${quoteLiteral(schemaName)}, ${quoteLiteral(roleName)});
  EXECUTE format('REVOKE ALL ON FUNCTION %I._exec_restricted(text) FROM PUBLIC', ${quoteLiteral(schemaName)});
  EXECUTE format('GRANT EXECUTE ON FUNCTION %I._exec_restricted(text) TO %I', ${quoteLiteral(schemaName)}, ${quoteLiteral(roleName)});
EXCEPTION
  WHEN insufficient_privilege THEN
    NULL;
END $$;
    `);

    await ensureDdlEventTrigger(tx);
  };

  if (typeof txOrClient.begin === 'function' && !isAlreadyTransaction(txOrClient)) {
    await txOrClient.begin(applyProvision);
  } else {
    await applyProvision(txOrClient);
  }

  return { schemaName, roleName };
}

function isAlreadyTransaction(candidate: PostgresLikeSql): boolean {
  // postgres.js TransactionSql exposes savepoint() whereas root Sql exposes begin()/end()
  return typeof (candidate as { savepoint?: unknown }).savepoint === 'function';
}

export interface WithPluginRoleOptions extends PostgresIsolationProvisionOptions {
  /** If true, grants CREATE on `plugin_<id>` during the callback and revokes CREATE on completion. */
  allowMigrationDdl?: boolean;
}

const DATA_QUERY_HEAD_RE = /^\s*(?:SELECT|WITH|INSERT|UPDATE|DELETE|EXPLAIN|VALUES)\b/i;

/**
 * Executes a callback on PostgreSQL inside an isolated transaction with
 * `SET LOCAL ROLE "plugin_<id>_role"` and pinned `SET LOCAL search_path = "plugin_<id>", public`,
 * resetting role and search_path cleanly on completion.
 */
export async function withPluginPostgresRole<T>(
  client: PostgresLikeSql,
  pluginId: string,
  fn: (roleTx: PostgresLikeSql) => Promise<T>,
  options: WithPluginRoleOptions = {},
): Promise<T> {
  const cacheKey = makeProvisionKey(pluginId, {
    coreTables: options.coreTables,
    allowSchemaCreate: Boolean(options.allowMigrationDdl),
  });

  let clientCache = provisionedByClient.get(client);
  if (!clientCache) {
    clientCache = new Map();
    provisionedByClient.set(client, clientCache);
  }

  const schemaName = pluginPostgresSchemaName(pluginId);
  const roleName = pluginPostgresRoleName(pluginId);

  if (clientCache.get(pluginId) !== cacheKey || options.allowMigrationDdl) {
    await provisionPluginPostgresIsolation(client, pluginId, {
      coreTables: options.coreTables,
      allowSchemaCreate: Boolean(options.allowMigrationDdl),
    });
    if (!options.allowMigrationDdl) {
      clientCache.set(pluginId, cacheKey);
    }
  }

  const runScoped = async (tx: PostgresLikeSql): Promise<T> => {
    await tx.unsafe(`SET LOCAL ROLE ${quoteIdent(roleName)}`);
    await tx.unsafe(`SET LOCAL search_path = ${quoteIdent(schemaName)}, public`);

    const roleTx: PostgresLikeSql = {
      async unsafe(query: string, params?: unknown[]) {
        const hasParams = Array.isArray(params) && params.length > 0;
        if (!hasParams && !options.allowMigrationDdl && !DATA_QUERY_HEAD_RE.test(query)) {
          await tx.unsafe(`SELECT ${quoteIdent(schemaName)}._exec_restricted($1)`, [query]);
          return Object.assign([], { count: 0 });
        }
        return tx.unsafe(query, params ?? []);
      },
      async begin<U>(cb: (inner: PostgresLikeSql) => Promise<U>): Promise<U> {
        return cb(roleTx);
      },
    };

    let failed = false;
    try {
      return await fn(roleTx);
    } catch (err) {
      failed = true;
      throw err;
    } finally {
      if (!failed) {
        await tx.unsafe('RESET search_path').catch(() => {});
        await tx.unsafe('RESET ROLE').catch(() => {});
        if (options.allowMigrationDdl) {
          await tx
            .unsafe(`REVOKE CREATE ON SCHEMA ${quoteIdent(schemaName)} FROM ${quoteIdent(roleName)}`)
            .catch(() => {});
          clientCache.delete(pluginId);
        }
      }
    }
  };

  if (isAlreadyTransaction(client) || typeof client.begin !== 'function') {
    return runScoped(client);
  }

  return client.begin(runScoped);
}
