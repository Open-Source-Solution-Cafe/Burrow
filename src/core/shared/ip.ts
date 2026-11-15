/**
 * Strict IPv4/IPv6 parsing, normalization, and CIDR allowlist matching.
 * Implemented without Node-only dependencies so Cloudflare Workers and Node
 * evaluate `TRUSTED_PROXIES` identically.
 */

export interface TrustedProxyRule {
  readonly raw: string;
  readonly version: 4 | 6;
  readonly network: bigint;
  readonly mask: bigint;
  readonly prefixLength: number;
}

const IPV4_PART_REGEX = /^(?:0|[1-9]\d{0,2})$/;

function parseIpv4ToBigInt(raw: string): bigint | null {
  const parts = raw.split('.');
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!IPV4_PART_REGEX.test(part)) return null;
    const octet = Number.parseInt(part, 10);
    if (octet < 0 || octet > 255) return null;
    value = (value << 8n) | BigInt(octet);
  }
  return value;
}

function formatIpv4(value: bigint): string {
  const b0 = Number((value >> 24n) & 0xffn);
  const b1 = Number((value >> 16n) & 0xffn);
  const b2 = Number((value >> 8n) & 0xffn);
  const b3 = Number(value & 0xffn);
  return `${b0}.${b1}.${b2}.${b3}`;
}

function parseIpv6ToBigInt(raw: string): bigint | null {
  const withoutZone = raw.split('%')[0] ?? '';
  if (!withoutZone || !withoutZone.includes(':')) return null;

  let expanded = withoutZone;
  // Support embedded IPv4 tail (e.g. ::ffff:192.0.2.128)
  const lastColon = expanded.lastIndexOf(':');
  const tail = expanded.slice(lastColon + 1);
  if (tail.includes('.')) {
    const ipv4 = parseIpv4ToBigInt(tail);
    if (ipv4 === null) return null;
    const hi = Number((ipv4 >> 16n) & 0xffffn).toString(16);
    const lo = Number(ipv4 & 0xffffn).toString(16);
    expanded = `${expanded.slice(0, lastColon)}:${hi}:${lo}`;
  }

  const doubleColonParts = expanded.split('::');
  if (doubleColonParts.length > 2) return null;

  const leftGroups = doubleColonParts[0] ? doubleColonParts[0].split(':') : [];
  const rightGroups = doubleColonParts.length === 2 && doubleColonParts[1]
    ? doubleColonParts[1].split(':')
    : [];

  if (doubleColonParts.length === 1 && leftGroups.length !== 8) return null;
  const totalGroups = leftGroups.length + rightGroups.length;
  if (doubleColonParts.length === 2 && totalGroups > 7) return null;

  const missingGroups = doubleColonParts.length === 2 ? 8 - totalGroups : 0;
  const groups = [
    ...leftGroups,
    ...Array.from({ length: missingGroups }, () => '0'),
    ...rightGroups,
  ];
  if (groups.length !== 8) return null;

  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    value = (value << 16n) | BigInt(Number.parseInt(group, 16));
  }
  return value;
}

function formatIpv6(value: bigint): string {
  const groups: string[] = [];
  for (let shift = 112n; shift >= 0n; shift -= 16n) {
    groups.push(Number((value >> shift) & 0xffffn).toString(16));
  }
  let bestStart = -1;
  let bestLen = 0;
  let curStart = -1;
  let curLen = 0;
  for (let i = 0; i < groups.length; i += 1) {
    if (groups[i] === '0') {
      if (curStart === -1) curStart = i;
      curLen += 1;
      if (curLen > bestLen) {
        bestStart = curStart;
        bestLen = curLen;
      }
    } else {
      curStart = -1;
      curLen = 0;
    }
  }
  if (bestLen < 2) return groups.join(':');
  const head = groups.slice(0, bestStart).join(':');
  const tail = groups.slice(bestStart + bestLen).join(':');
  return `${head}::${tail}`;
}

export interface ParsedIp {
  version: 4 | 6;
  value: bigint;
  normalized: string;
}

/**
 * Parse and normalize an IPv4 or IPv6 address.
 * IPv4-mapped IPv6 addresses (::ffff:a.b.c.d) are normalized to IPv4 so
 * Docker bridge sockets match IPv4 CIDR allowlists consistently.
 */
export function parseIp(raw: string | null | undefined): ParsedIp | null {
  if (!raw || typeof raw !== 'string') return null;
  let trimmed = raw.trim();
  if (!trimmed || trimmed.length > 64) return null;
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    trimmed = trimmed.slice(1, -1);
  }

  const v4 = parseIpv4ToBigInt(trimmed);
  if (v4 !== null) {
    return { version: 4, value: v4, normalized: formatIpv4(v4) };
  }

  const v6 = parseIpv6ToBigInt(trimmed);
  if (v6 === null) return null;

  // Map ::ffff:0:0/96 to IPv4
  const ipv4MappedPrefix = 0xffffn << 32n;
  if ((v6 & ~0xffffffffn) === ipv4MappedPrefix) {
    const mappedV4 = v6 & 0xffffffffn;
    return { version: 4, value: mappedV4, normalized: formatIpv4(mappedV4) };
  }

  return { version: 6, value: v6, normalized: formatIpv6(v6) };
}

export function formatNormalizedIp(raw: string | null | undefined): string | null {
  return parseIp(raw)?.normalized ?? null;
}

function makeMask(totalBits: number, prefixLength: number): bigint {
  if (prefixLength === 0) return 0n;
  const hostBits = BigInt(totalBits - prefixLength);
  const allOnes = (1n << BigInt(totalBits)) - 1n;
  return (allOnes >> hostBits) << hostBits;
}

export function parseCidrRule(rawEntry: string): TrustedProxyRule {
  const trimmed = rawEntry.trim();
  if (!trimmed) {
    throw new Error('TRUSTED_PROXIES entries must not be empty');
  }
  const slashIndex = trimmed.indexOf('/');
  const ipPart = slashIndex === -1 ? trimmed : trimmed.slice(0, slashIndex);
  const prefixPart = slashIndex === -1 ? null : trimmed.slice(slashIndex + 1);

  const parsed = parseIp(ipPart);
  if (!parsed) {
    throw new Error(`Invalid IP address in TRUSTED_PROXIES: "${trimmed}"`);
  }

  const maxBits = parsed.version === 4 ? 32 : 128;
  let prefixLength = maxBits;
  if (prefixPart !== null) {
    if (!/^\d{1,3}$/.test(prefixPart)) {
      throw new Error(`Invalid CIDR prefix length in TRUSTED_PROXIES: "${trimmed}"`);
    }
    prefixLength = Number.parseInt(prefixPart, 10);
    if (prefixLength < 0 || prefixLength > maxBits) {
      throw new Error(
        `CIDR prefix length out of range (0-${maxBits}) in TRUSTED_PROXIES: "${trimmed}"`,
      );
    }
  }

  const mask = makeMask(maxBits, prefixLength);
  return {
    raw: trimmed,
    version: parsed.version,
    network: parsed.value & mask,
    mask,
    prefixLength,
  };
}

const parsedTrustedProxiesCache = new Map<string, TrustedProxyRule[]>();

/**
 * Parse a comma-separated list of IP addresses or CIDR ranges for TRUSTED_PROXIES.
 * Throws on any malformed entry so invalid proxy allowlists fail startup immediately.
 */
export function parseTrustedProxies(raw: string | undefined | null): TrustedProxyRule[] {
  if (!raw || !raw.trim()) return [];
  const cached = parsedTrustedProxiesCache.get(raw);
  if (cached) return cached;

  const entries = raw.split(',').map((entry) => entry.trim());
  if (entries.some((entry) => entry.length === 0)) {
    throw new Error(`TRUSTED_PROXIES contains an empty entry: "${raw}"`);
  }
  const rules = entries.map(parseCidrRule);
  if (parsedTrustedProxiesCache.size > 128) {
    parsedTrustedProxiesCache.clear();
  }
  parsedTrustedProxiesCache.set(raw, rules);
  return rules;
}

export function isIpInTrustedProxies(
  ip: string | null | undefined,
  rules: readonly TrustedProxyRule[],
): boolean {
  if (rules.length === 0) return false;
  const parsed = parseIp(ip);
  if (!parsed) return false;
  return rules.some(
    (rule) => rule.version === parsed.version && (parsed.value & rule.mask) === rule.network,
  );
}
