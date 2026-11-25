import type { PluginLogger, PluginManifest } from '@burrow/sdk';

const SECRET_KEY_NAME_RE = /SECRET|TOKEN|KEY|PASSWORD|DATABASE_URL|DSN|PRIVATE|CREDENTIAL|AUTH/i;
const INLINE_SECRET_PATTERNS: readonly RegExp[] = [
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bsk_(?:live|test)_[A-Za-z0-9]{8,}\b/g,
  /\bwhsec_[A-Za-z0-9]{8,}\b/g,
  /\bpostgres(?:ql)?:\/\/[^:\s]+:[^@\s]+@[^\s]+/gi,
];

const CORE_RESERVED_CONFIG_KEYS = new Set<string>([
  'BETTER_AUTH_SECRET',
  'BOOTSTRAP_TOKEN',
  'DATABASE_URL',
  'ADMIN_API_KEY',
  'SELF_UPDATE_WEBHOOK_TOKEN',
  'RESEND_API_KEY',
  'GOOGLE_CLIENT_SECRET',
  'GITHUB_CLIENT_SECRET',
  'S3_SECRET_KEY',
  'S3_ACCESS_KEY',
]);

/** Collects sensitive env/config values so logger and error responses never leak them. */
export function collectSecretValues(
  env: Record<string, unknown>,
  configKeys: readonly string[] = [],
): string[] {
  const values = new Set<string>();
  const declared = new Set(configKeys);

  for (const [key, rawVal] of Object.entries(env)) {
    if (typeof rawVal !== 'string') continue;
    const trimmed = rawVal.trim();
    if (trimmed.length < 6) continue;
    if (SECRET_KEY_NAME_RE.test(key) || declared.has(key)) {
      values.add(trimmed);
    }
  }

  return [...values].sort((a, b) => b.length - a.length);
}

/** Replaces any known secret strings or token patterns with `[REDACTED]`. */
export function redactSecrets(input: string, secretValues: readonly string[] = []): string {
  let out = input;
  for (const secret of secretValues) {
    if (secret && out.includes(secret)) {
      out = out.split(secret).join('[REDACTED]');
    }
  }
  for (const pattern of INLINE_SECRET_PATTERNS) {
    out = out.replace(pattern, '[REDACTED]');
  }
  return out;
}

const MAX_META_SANITIZE_DEPTH = 32;

export function sanitizeMetaValue(
  value: unknown,
  secretValues: readonly string[],
  depth = 0,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactSecrets(value, secretValues);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth > MAX_META_SANITIZE_DEPTH) return '[TRUNCATED]';
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactSecrets(value.message, secretValues),
    };
  }
  if (typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeMetaValue(item, secretValues, depth + 1, seen));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_NAME_RE.test(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = sanitizeMetaValue(v, secretValues, depth + 1, seen);
      }
    }
    return out;
  }
  return String(value);
}

export function buildScopedPluginConfig(
  manifest: PluginManifest,
  env: Record<string, unknown>,
  allowCoreReservedKeys = false,
): Readonly<Record<string, string | undefined>> {
  const out: Record<string, string | undefined> = {};
  for (const key of manifest.configKeys ?? []) {
    if (!allowCoreReservedKeys && CORE_RESERVED_CONFIG_KEYS.has(key)) {
      continue;
    }
    const val = env[key];
    out[key] = typeof val === 'string' ? val : val !== undefined && val !== null ? String(val) : undefined;
  }
  return Object.freeze(out);
}

export function createPluginLogger(
  pluginId: string,
  secretValues: readonly string[] = [],
  sink: Pick<Console, 'info' | 'warn' | 'error' | 'debug'> = console,
): PluginLogger {
  const format = (level: 'info' | 'warn' | 'error' | 'debug', message: string, meta?: Record<string, unknown>) => {
    const safeMsg = `[plugin:${pluginId}] ${redactSecrets(message, secretValues)}`;
    if (meta) {
      const safeMeta = sanitizeMetaValue(meta, secretValues);
      sink[level](`${safeMsg} ${JSON.stringify(safeMeta)}`);
    } else {
      sink[level](safeMsg);
    }
  };

  return {
    info: (message, meta) => format('info', message, meta),
    warn: (message, meta) => format('warn', message, meta),
    error: (message, meta) => format('error', message, meta),
    debug: (message, meta) => format('debug', message, meta),
  };
}
