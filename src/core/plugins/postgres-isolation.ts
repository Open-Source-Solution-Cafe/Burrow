import { randomBytes } from 'node:crypto';
import type { PostgresLikeSql } from './plugin-db';
import { ALLOWLISTABLE_CORE_TABLES } from './manifest';

export function pluginPostgresSchemaName(pluginId: string): string {
  return `plugin_${pluginId.replace(/-/g, '_')}`;
}

export function pluginPostgresRoleName(pluginId: string): string {
  return `${pluginPostgresSchemaName(pluginId)}_role`;
}

export function pluginPostgresOwnerRoleName(pluginId: string): string {
  return `${pluginPostgresSchemaName(pluginId)}_owner`;
}

export function pluginPostgresMigratorRoleName(pluginId: string): string {
  return `${pluginPostgresSchemaName(pluginId)}_migrator`;
}

export interface PostgresIsolationProvisionOptions {
  coreTables?: readonly string[];
  allowSchemaCreate?: boolean;
}

interface RolePoolEntry {
  password: string;
  pool: PostgresClientWithEnd;
  hostKey: string;
}

interface PostgresClientWithEnd extends PostgresLikeSql {
  options?: {
    host?: string | string[];
    port?: number | string | (number | string)[];
    database?: string;
    path?: string;
    ssl?: unknown;
    connect_timeout?: number;
    idle_timeout?: number;
  };
  reserve?: () => Promise<PostgresLikeSql & { release: () => void }>;
  end?: (options?: { timeout?: number }) => Promise<void>;
}

const rolePoolsByKey = new Map<string, RolePoolEntry>();
const poolsByParentClient = new WeakMap<object, Set<string>>();
const wrappedEndClients = new WeakSet<object>();
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

function getDbKey(client: PostgresLikeSql): string {
  const opts = (client as PostgresClientWithEnd).options;
  if (!opts) return 'default';
  const host = Array.isArray(opts.host) ? opts.host.join(',') : String(opts.host ?? '');
  const port = Array.isArray(opts.port) ? opts.port.join(',') : String(opts.port ?? '');
  const db = String(opts.database ?? '');
  const path = String(opts.path ?? '');
  return `${host}|${port}|${path}|${db}`;
}

async function openDedicatedRolePool(
  parentClient: PostgresLikeSql,
  roleName: string,
  password: string,
  maxConnections: number,
): Promise<PostgresClientWithEnd> {
  const opts = (parentClient as PostgresClientWithEnd).options;
  if (!opts) {
    throw new Error('Cannot open dedicated plugin PostgreSQL pool: parent client does not expose connection options');
  }
  const { default: postgres } = await import('postgres');
  const host = Array.isArray(opts.host) ? opts.host[0] : opts.host;
  const rawPort = Array.isArray(opts.port) ? opts.port[0] : opts.port;
  const port = rawPort !== undefined ? Number(rawPort) : undefined;
  const pool = postgres({
    ...(opts.path ? { path: opts.path } : { host, port }),
    database: opts.database,
    ssl: opts.ssl as never,
    user: roleName,
    password,
    max: maxConnections,
    idle_timeout: opts.idle_timeout ?? 15,
    connect_timeout: opts.connect_timeout ?? 10,
    onnotice: () => {},
  }) as unknown as PostgresClientWithEnd;
  return pool;
}

function attachPoolLifecycle(parentClient: PostgresLikeSql, cacheKey: string): void {
  if (typeof parentClient !== 'object' && typeof parentClient !== 'function') return;
  let keys = poolsByParentClient.get(parentClient as object);
  if (!keys) {
    keys = new Set();
    poolsByParentClient.set(parentClient as object, keys);
  }
  keys.add(cacheKey);

  const clientWithEnd = parentClient as PostgresClientWithEnd;
  if (typeof clientWithEnd.end === 'function' && !wrappedEndClients.has(parentClient as object)) {
    wrappedEndClients.add(parentClient as object);
    const originalEnd = clientWithEnd.end.bind(parentClient);
    clientWithEnd.end = async (endOptions?: { timeout?: number }) => {
      await closePluginPostgresPools(parentClient);
      return originalEnd(endOptions);
    };
  }
}

export async function closePluginPostgresPools(parentClient: PostgresLikeSql): Promise<void> {
  if (typeof parentClient !== 'object' && typeof parentClient !== 'function') return;
  const keys = poolsByParentClient.get(parentClient as object);
  if (!keys) return;
  const toClose = [...keys];
  keys.clear();
  for (const key of toClose) {
    const entry = rolePoolsByKey.get(key);
    rolePoolsByKey.delete(key);
    if (entry?.pool.end) {
      await entry.pool.end({ timeout: 2 }).catch(() => {});
    }
  }
}

/**
 * Installs PostgreSQL server-level DDL event triggers using SECURITY INVOKER so `session_user`
 * and `current_user` evaluate as the actual plugin/migrator role (never elevated definer).
 */
async function ensureDdlEventTrigger(tx: PostgresLikeSql): Promise<void> {
  await tx.unsafe(`
DO $$
BEGIN
  CREATE OR REPLACE FUNCTION public.burrow_enforce_plugin_ddl() RETURNS event_trigger
  LANGUAGE plpgsql SECURITY INVOKER AS $fn$
  DECLARE
    cmd record;
    allowed_schema text;
  BEGIN
    IF session_user NOT LIKE 'plugin\\_%\\_role' ESCAPE '\\'
       AND session_user NOT LIKE 'plugin\\_%\\_migrator' ESCAPE '\\' THEN
      RETURN;
    END IF;
    IF TG_TAG IN (
      'CREATE FUNCTION', 'ALTER FUNCTION', 'DROP FUNCTION',
      'CREATE PROCEDURE', 'ALTER PROCEDURE', 'DROP PROCEDURE',
      'CREATE TRIGGER', 'ALTER TRIGGER', 'DROP TRIGGER',
      'CREATE EVENT TRIGGER', 'ALTER EVENT TRIGGER', 'DROP EVENT TRIGGER',
      'CREATE EXTENSION', 'ALTER EXTENSION', 'DROP EXTENSION',
      'CREATE ROLE', 'ALTER ROLE', 'DROP ROLE',
      'CREATE AGGREGATE', 'ALTER AGGREGATE', 'DROP AGGREGATE',
      'CREATE FOREIGN DATA WRAPPER', 'CREATE SERVER', 'CREATE USER MAPPING',
      'CREATE PUBLICATION', 'CREATE SUBSCRIPTION'
    ) THEN
      RAISE EXCEPTION 'permission denied: plugins cannot execute %', TG_TAG USING ERRCODE = '42501';
    END IF;
    allowed_schema := regexp_replace(session_user, '_(role|migrator)$', '');
    IF TG_EVENT = 'ddl_command_end' THEN
      FOR cmd IN SELECT classid, objid, schema_name, object_type FROM pg_event_trigger_ddl_commands()
      LOOP
        IF cmd.object_type IN ('function', 'procedure', 'aggregate', 'trigger', 'event trigger', 'extension') THEN
          RAISE EXCEPTION 'permission denied: plugins cannot create %', cmd.object_type USING ERRCODE = '42501';
        END IF;
        IF cmd.schema_name IS NOT NULL AND cmd.schema_name <> allowed_schema THEN
          RAISE EXCEPTION 'permission denied for schema % (plugin owns %)', cmd.schema_name, allowed_schema USING ERRCODE = '42501';
        END IF;
        IF cmd.classid = 'pg_catalog.pg_class'::regclass OR cmd.classid = 'pg_catalog.pg_constraint'::regclass THEN
          IF EXISTS (
            SELECT 1
            FROM pg_catalog.pg_constraint c
            JOIN pg_catalog.pg_class cls_ref ON cls_ref.oid = c.confrelid
            JOIN pg_catalog.pg_namespace n_ref ON n_ref.oid = cls_ref.relnamespace
            WHERE c.contype = 'f'
              AND n_ref.nspname <> allowed_schema
              AND c.confdeltype <> 'c'
              AND (
                (cmd.classid = 'pg_catalog.pg_class'::regclass AND c.conrelid = cmd.objid)
                OR (cmd.classid = 'pg_catalog.pg_constraint'::regclass AND c.oid = cmd.objid)
              )
          ) THEN
            RAISE EXCEPTION 'permission denied: foreign keys to external tables must specify ON DELETE CASCADE' USING ERRCODE = '42501';
          END IF;
        END IF;
      END LOOP;
    END IF;
  END $fn$;

  REVOKE ALL ON FUNCTION public.burrow_enforce_plugin_ddl() FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION public.burrow_enforce_plugin_ddl() TO PUBLIC;

  CREATE OR REPLACE FUNCTION public.burrow_enforce_plugin_drop() RETURNS event_trigger
  LANGUAGE plpgsql SECURITY INVOKER AS $fn$
  DECLARE
    obj record;
    allowed_schema text;
  BEGIN
    IF session_user NOT LIKE 'plugin\\_%\\_role' ESCAPE '\\'
       AND session_user NOT LIKE 'plugin\\_%\\_migrator' ESCAPE '\\' THEN
      RETURN;
    END IF;
    allowed_schema := regexp_replace(session_user, '_(role|migrator)$', '');
    FOR obj IN SELECT schema_name, object_type FROM pg_event_trigger_dropped_objects()
    LOOP
      IF obj.schema_name IS NOT NULL AND obj.schema_name <> allowed_schema THEN
        RAISE EXCEPTION 'permission denied to drop % in schema %', obj.object_type, obj.schema_name USING ERRCODE = '42501';
      END IF;
    END LOOP;
  END $fn$;

  REVOKE ALL ON FUNCTION public.burrow_enforce_plugin_drop() FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION public.burrow_enforce_plugin_drop() TO PUBLIC;

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

async function revokeGlobalCoreAndCatalogSurface(tx: PostgresLikeSql): Promise<void> {
  await tx.unsafe(`
DO $$
DECLARE
  fn record;
  v_name text;
  sensitive_catalog_views text[] := ARRAY[
    'pg_catalog.pg_roles',
    'pg_catalog.pg_user',
    'pg_catalog.pg_group',
    'pg_catalog.pg_shadow',
    'pg_catalog.pg_authid',
    'pg_catalog.pg_auth_members',
    'pg_catalog.pg_stat_activity',
    'pg_catalog.pg_stat_ssl',
    'pg_catalog.pg_stat_gssapi',
    'pg_catalog.pg_settings',
    'pg_catalog.pg_file_settings',
    'pg_catalog.pg_hba_file_rules',
    'pg_catalog.pg_config',
    'pg_catalog.pg_shmem_allocations',
    'pg_catalog.pg_backend_memory_contexts'
  ];
BEGIN
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT ALL ON DATABASE %I TO CURRENT_USER', current_database());

  REVOKE ALL ON SCHEMA public FROM PUBLIC;
  GRANT USAGE, CREATE ON SCHEMA public TO CURRENT_USER;
  EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC';
  EXECUTE 'REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC';

  REVOKE ALL ON SCHEMA information_schema FROM PUBLIC;
  REVOKE ALL ON ALL TABLES IN SCHEMA information_schema FROM PUBLIC;
  GRANT USAGE ON SCHEMA information_schema TO CURRENT_USER;
  GRANT SELECT ON ALL TABLES IN SCHEMA information_schema TO CURRENT_USER;

  FOREACH v_name IN ARRAY sensitive_catalog_views
  LOOP
    BEGIN
      EXECUTE format('REVOKE ALL ON %s FROM PUBLIC', v_name);
      EXECUTE format('GRANT SELECT ON %s TO CURRENT_USER', v_name);
    EXCEPTION
      WHEN insufficient_privilege OR undefined_table THEN
        NULL;
    END;
  END LOOP;

  FOR fn IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'pg_catalog'
      AND (p.proname LIKE 'pg\\_%advisory%lock%' ESCAPE '\\' OR p.proname = 'pg_notify')
  LOOP
    BEGIN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn.sig);
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO CURRENT_USER', fn.sig);
    EXCEPTION
      WHEN insufficient_privilege THEN
        NULL;
    END;
  END LOOP;
EXCEPTION
  WHEN insufficient_privilege THEN
    NULL;
END $$;
  `);
}

/**
 * Transfers object ownership inside `plugin_<id>` to the non-login `plugin_<id>_owner`
 * and re-grants DML-only privileges to `plugin_<id>_role`.
 */
export async function finalizePluginSchemaPrivileges(
  client: PostgresLikeSql,
  pluginId: string,
): Promise<void> {
  const schemaName = pluginPostgresSchemaName(pluginId);
  const ownerRole = pluginPostgresOwnerRoleName(pluginId);
  const roleName = pluginPostgresRoleName(pluginId);
  const migratorRole = pluginPostgresMigratorRoleName(pluginId);

  await client.unsafe(`
DO $$
DECLARE
  tbl record;
  seq record;
BEGIN
  FOR tbl IN SELECT tablename FROM pg_tables WHERE schemaname = ${quoteLiteral(schemaName)}
  LOOP
    EXECUTE format('ALTER TABLE %I.%I OWNER TO %I', ${quoteLiteral(schemaName)}, tbl.tablename, ${quoteLiteral(ownerRole)});
  END LOOP;
  FOR seq IN SELECT sequencename FROM pg_sequences WHERE schemaname = ${quoteLiteral(schemaName)}
  LOOP
    EXECUTE format('ALTER SEQUENCE %I.%I OWNER TO %I', ${quoteLiteral(schemaName)}, seq.sequencename, ${quoteLiteral(ownerRole)});
  END LOOP;
  EXECUTE format('REVOKE ALL ON SCHEMA %I FROM %I', ${quoteLiteral(schemaName)}, ${quoteLiteral(migratorRole)});
  EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM %I', ${quoteLiteral(schemaName)}, ${quoteLiteral(migratorRole)});
  EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA %I FROM %I', ${quoteLiteral(schemaName)}, ${quoteLiteral(migratorRole)});
  EXECUTE format('ALTER ROLE %I NOLOGIN CONNECTION LIMIT 0', ${quoteLiteral(migratorRole)});

  EXECUTE format('REVOKE CREATE ON SCHEMA %I FROM %I', ${quoteLiteral(schemaName)}, ${quoteLiteral(roleName)});
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', ${quoteLiteral(schemaName)}, ${quoteLiteral(roleName)});
  EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM %I', ${quoteLiteral(schemaName)}, ${quoteLiteral(roleName)});
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO %I', ${quoteLiteral(schemaName)}, ${quoteLiteral(roleName)});
  EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA %I FROM %I', ${quoteLiteral(schemaName)}, ${quoteLiteral(roleName)});
  EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO %I', ${quoteLiteral(schemaName)}, ${quoteLiteral(roleName)});
EXCEPTION
  WHEN insufficient_privilege OR undefined_object THEN
    NULL;
END $$;
  `);
}

async function prepareMigratorRole(
  client: PostgresLikeSql,
  pluginId: string,
  options: PostgresIsolationProvisionOptions,
): Promise<{ migratorRole: string; password: string }> {
  const schemaName = pluginPostgresSchemaName(pluginId);
  const migratorRole = pluginPostgresMigratorRoleName(pluginId);
  const hasCoreTables = (options.coreTables ?? []).length > 0;
  const searchPathSql = hasCoreTables
    ? `${quoteIdent(schemaName)}, public`
    : quoteIdent(schemaName);
  const password = randomBytes(24).toString('hex');

  await client.unsafe(`
DO $$
DECLARE
  tbl record;
  seq record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${quoteLiteral(migratorRole)}) THEN
    CREATE ROLE ${quoteIdent(migratorRole)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 5 PASSWORD ${quoteLiteral(password)};
  ELSE
    ALTER ROLE ${quoteIdent(migratorRole)} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 5 PASSWORD ${quoteLiteral(password)};
  END IF;
  EXECUTE format('ALTER ROLE %I SET search_path = %s', ${quoteLiteral(migratorRole)}, ${quoteLiteral(searchPathSql)});
  EXECUTE format('ALTER ROLE %I SET statement_timeout = %L', ${quoteLiteral(migratorRole)}, '15000ms');
  EXECUTE format('ALTER ROLE %I SET lock_timeout = %L', ${quoteLiteral(migratorRole)}, '5000ms');
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), ${quoteLiteral(migratorRole)});
  EXECUTE format('GRANT USAGE, CREATE ON SCHEMA %I TO %I', ${quoteLiteral(schemaName)}, ${quoteLiteral(migratorRole)});

  FOR tbl IN SELECT tablename FROM pg_tables WHERE schemaname = ${quoteLiteral(schemaName)}
  LOOP
    EXECUTE format('ALTER TABLE %I.%I OWNER TO %I', ${quoteLiteral(schemaName)}, tbl.tablename, ${quoteLiteral(migratorRole)});
  END LOOP;
  FOR seq IN SELECT sequencename FROM pg_sequences WHERE schemaname = ${quoteLiteral(schemaName)}
  LOOP
    EXECUTE format('ALTER SEQUENCE %I.%I OWNER TO %I', ${quoteLiteral(schemaName)}, seq.sequencename, ${quoteLiteral(migratorRole)});
  END LOOP;

  REVOKE ALL ON SCHEMA public FROM ${quoteIdent(migratorRole)};
  ${hasCoreTables ? `GRANT USAGE ON SCHEMA public TO ${quoteIdent(migratorRole)};` : ''}
END $$;
  `);

  for (const tbl of options.coreTables ?? []) {
    if (!ALLOWLISTABLE_CORE_TABLES.has(tbl)) continue;
    await client.unsafe(`
DO $$
BEGIN
  IF to_regclass(${quoteLiteral(`public.${tbl}`)}) IS NOT NULL THEN
    EXECUTE format('GRANT REFERENCES (id) ON TABLE public.%I TO %I', ${quoteLiteral(tbl)}, ${quoteLiteral(migratorRole)});
  END IF;
EXCEPTION
  WHEN insufficient_privilege OR undefined_column THEN
    NULL;
END $$;
    `);
  }

  return { migratorRole, password };
}

/**
 * Provisions a dedicated NOLOGIN schema owner (`plugin_<id>_owner`), a dedicated LOGIN runtime
 * role (`plugin_<id>_role`), and its isolated schema (`plugin_<id>`). Grants only DML on plugin
 * tables and explicitly allowlisted `manifest.coreTables` SELECT/REFERENCES privileges.
 */
export async function provisionPluginPostgresIsolation(
  txOrClient: PostgresLikeSql,
  pluginId: string,
  options: PostgresIsolationProvisionOptions = {},
): Promise<{ schemaName: string; roleName: string; ownerRoleName: string }> {
  const schemaName = pluginPostgresSchemaName(pluginId);
  const roleName = pluginPostgresRoleName(pluginId);
  const ownerRoleName = pluginPostgresOwnerRoleName(pluginId);
  const hasCoreTables = (options.coreTables ?? []).length > 0;
  const searchPathSql = hasCoreTables
    ? `${quoteIdent(schemaName)}, public`
    : quoteIdent(schemaName);

  for (const tbl of options.coreTables ?? []) {
    if (!ALLOWLISTABLE_CORE_TABLES.has(tbl)) {
      throw new Error(`Plugin "${pluginId}" coreTables entry "${tbl}" is forbidden`);
    }
  }

  const dbKey = getDbKey(txOrClient);
  const poolCacheKey = `${dbKey}:${roleName}`;
  let roleEntry = rolePoolsByKey.get(poolCacheKey);
  const rolePassword = roleEntry?.password ?? randomBytes(24).toString('hex');

  const applyProvision = async (tx: PostgresLikeSql) => {
    await tx.unsafe("SELECT pg_advisory_xact_lock(hashtext('burrow:plugin_isolation'))");
    await revokeGlobalCoreAndCatalogSurface(tx);

    // 1. Create non-login owner role and dedicated LOGIN plugin role (zero memberships in other roles)
    await tx.unsafe(`
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${quoteLiteral(ownerRoleName)}) THEN
    CREATE ROLE ${quoteIdent(ownerRoleName)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${quoteLiteral(roleName)}) THEN
    CREATE ROLE ${quoteIdent(roleName)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 10 PASSWORD ${quoteLiteral(rolePassword)};
  ELSE
    ALTER ROLE ${quoteIdent(roleName)} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 10 PASSWORD ${quoteLiteral(rolePassword)};
  END IF;
  EXECUTE format('ALTER ROLE %I SET search_path = %s', ${quoteLiteral(roleName)}, ${quoteLiteral(searchPathSql)});
  EXECUTE format('ALTER ROLE %I SET statement_timeout = %L', ${quoteLiteral(roleName)}, '3000ms');
  EXECUTE format('ALTER ROLE %I SET lock_timeout = %L', ${quoteLiteral(roleName)}, '2000ms');
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), ${quoteLiteral(roleName)});
EXCEPTION
  WHEN insufficient_privilege THEN
    NULL;
END $$;
    `);

    // 2. Schema owned by non-login ownerRoleName (never plugin_<id>_role)
    await tx.unsafe(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schemaName)}`);
    await tx.unsafe(`
DO $$
BEGIN
  EXECUTE format('ALTER SCHEMA %I OWNER TO %I', ${quoteLiteral(schemaName)}, ${quoteLiteral(ownerRoleName)});
  EXECUTE format('REVOKE ALL ON SCHEMA %I FROM PUBLIC', ${quoteLiteral(schemaName)});
  EXECUTE format('DROP FUNCTION IF EXISTS %I._exec_restricted(text)', ${quoteLiteral(schemaName)});
EXCEPTION
  WHEN insufficient_privilege THEN
    NULL;
END $$;
    `);

    // 3. Ensure core public tables/sequences are completely inaccessible unless allowlisted
    await tx.unsafe(`
DO $$
BEGIN
  EXECUTE format('REVOKE ALL ON SCHEMA public FROM %I', ${quoteLiteral(roleName)});
  ${hasCoreTables ? `EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', ${quoteLiteral(roleName)});` : ''}
  EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', ${quoteLiteral(roleName)});
  EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', ${quoteLiteral(roleName)});
  EXECUTE format('REVOKE ALL ON SCHEMA information_schema FROM %I', ${quoteLiteral(roleName)});
EXCEPTION
  WHEN insufficient_privilege THEN
    NULL;
END $$;
    `);

    // 4. Cross-plugin schema isolation across all plugin_* schemas and roles
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
  FOR r IN SELECT rolname FROM pg_roles WHERE (rolname LIKE 'plugin\\_%\\_role' ESCAPE '\\' OR rolname LIKE 'plugin\\_%\\_migrator' ESCAPE '\\') AND rolname <> ${quoteLiteral(roleName)}
  LOOP
    EXECUTE format('REVOKE ALL ON SCHEMA %I FROM %I', ${quoteLiteral(schemaName)}, r.rolname);
    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM %I', ${quoteLiteral(schemaName)}, r.rolname);
  END LOOP;
EXCEPTION
  WHEN insufficient_privilege THEN
    NULL;
END $$;
    `);

    // 5. Own-schema USAGE + DML only for runtime role; never CREATE on schema
    await finalizePluginSchemaPrivileges(tx, pluginId);

    // 6. Grant SELECT (and FK REFERENCES(id)) ONLY on explicitly declared manifest.coreTables
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
    EXECUTE format('GRANT REFERENCES (id) ON TABLE public.invites TO %I', ${quoteLiteral(roleName)});
  END IF;
END $$;
        `);
      } else {
        await tx.unsafe(`
DO $$
BEGIN
  IF to_regclass(${quoteLiteral(`public.${tbl}`)}) IS NOT NULL THEN
    EXECUTE format('GRANT SELECT ON TABLE public.%I TO %I', ${quoteLiteral(tbl)}, ${quoteLiteral(roleName)});
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ${quoteLiteral(tbl)} AND column_name = 'id'
    ) THEN
      EXECUTE format('GRANT REFERENCES (id) ON TABLE public.%I TO %I', ${quoteLiteral(tbl)}, ${quoteLiteral(roleName)});
    END IF;
  END IF;
END $$;
        `);
      }
    }

    await ensureDdlEventTrigger(tx);
  };

  if (typeof txOrClient.begin === 'function' && !isAlreadyTransaction(txOrClient)) {
    await txOrClient.begin(applyProvision);
  } else {
    await applyProvision(txOrClient);
  }

  if (!roleEntry && (txOrClient as PostgresClientWithEnd).options) {
    const pool = await openDedicatedRolePool(txOrClient, roleName, rolePassword, 4);
    roleEntry = { password: rolePassword, pool, hostKey: dbKey };
    rolePoolsByKey.set(poolCacheKey, roleEntry);
    attachPoolLifecycle(txOrClient, poolCacheKey);
  } else if (roleEntry) {
    attachPoolLifecycle(txOrClient, poolCacheKey);
  }

  return { schemaName, roleName, ownerRoleName };
}

function isAlreadyTransaction(candidate: PostgresLikeSql): boolean {
  return typeof (candidate as { savepoint?: unknown }).savepoint === 'function';
}

export interface WithPluginRoleOptions extends PostgresIsolationProvisionOptions {
  /** If true, runs callback on the ephemeral `plugin_<id>_migrator` LOGIN pool with schema CREATE. */
  allowMigrationDdl?: boolean;
}

/**
 * Executes a callback on PostgreSQL over a dedicated connection pool authenticated directly as
 * `plugin_<id>_role` (or short-lived `plugin_<id>_migrator` during migrations). `session_user` IS
 * the plugin role so `RESET ROLE` and `SET SESSION AUTHORIZATION` cannot escalate privileges.
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
      allowSchemaCreate: false,
    });
    if (!options.allowMigrationDdl) {
      clientCache.set(pluginId, cacheKey);
    }
  }

  if (options.allowMigrationDdl) {
    const { migratorRole, password } = await prepareMigratorRole(client, pluginId, options);
    const migratorPool = await openDedicatedRolePool(client, migratorRole, password, 2);
    try {
      const migratorTx: PostgresLikeSql = {
        async unsafe(query: string, params?: unknown[]) {
          return migratorPool.unsafe(query, params ?? []);
        },
        async begin<U>(cb: (inner: PostgresLikeSql) => Promise<U>): Promise<U> {
          if (typeof migratorPool.begin === 'function') {
            return migratorPool.begin(cb as never);
          }
          return cb(migratorTx);
        },
      };
      return await fn(migratorTx);
    } finally {
      if (migratorPool.end) {
        await migratorPool.end({ timeout: 2 }).catch(() => {});
      }
      await finalizePluginSchemaPrivileges(client, pluginId).catch(() => {});
      clientCache.delete(pluginId);
    }
  }

  const dbKey = getDbKey(client);
  const poolCacheKey = `${dbKey}:${roleName}`;
  const entry = rolePoolsByKey.get(poolCacheKey);
  if (!entry) {
    throw new Error(`Dedicated connection pool for plugin role "${roleName}" is not initialized`);
  }

  const rolePool = entry.pool;
  const searchPathReset =
    (options.coreTables ?? []).length > 0
      ? `SET search_path = ${quoteIdent(schemaName)}, public`
      : `SET search_path = ${quoteIdent(schemaName)}`;

  if (typeof rolePool.reserve === 'function') {
    const conn = await rolePool.reserve();
    const roleTx: PostgresLikeSql = {
      async unsafe(query: string, params?: unknown[]) {
        return conn.unsafe(query, params ?? []);
      },
      async begin<U>(cb: (inner: PostgresLikeSql) => Promise<U>): Promise<U> {
        return cb(roleTx);
      },
    };
    try {
      return await fn(roleTx);
    } finally {
      await conn
        .unsafe(`RESET statement_timeout; RESET lock_timeout; ${searchPathReset}; DISCARD TEMP`)
        .catch(() => {});
      conn.release();
    }
  }

  const fallbackTx: PostgresLikeSql = {
    async unsafe(query: string, params?: unknown[]) {
      return rolePool.unsafe(query, params ?? []);
    },
    async begin<U>(cb: (inner: PostgresLikeSql) => Promise<U>): Promise<U> {
      return cb(fallbackTx);
    },
  };
  return fn(fallbackTx);
}
