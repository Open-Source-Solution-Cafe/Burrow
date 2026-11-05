import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// @ts-expect-error untyped local .mjs script
import * as checkDecoupling from '../../scripts/check-decoupling.mjs';

const {
  DEFAULT_VOCABULARY,
  evaluateDecoupling,
  findViolationsInText,
  isAllowlisted,
  VOCABULARY_REGEXPS,
} = checkDecoupling as any;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('check-decoupling: unit tests', () => {
  it('defines the standard SaaS vocabulary terms', () => {
    expect(DEFAULT_VOCABULARY).toEqual([
      'stripe',
      'billing',
      'enterprise',
      'burrow-cloud',
      'organization',
      'org_id',
      'tenant',
    ]);
  });

  describe('findViolationsInText: vocabulary detection', () => {
    it.each([
      ['stripe', 'const stripeKey = "sk_test_123";'],
      ['billing', 'const billingPlan = "pro";'],
      ['enterprise', 'if (isEnterprise) { /* ... */ }'],
      ['burrow-cloud', 'import { cloud } from "burrow-cloud";'],
      ['organization', 'const organizationName = "Acme Corp";'],
      ['org_id', 'SELECT * FROM users WHERE org_id = $1;'],
      ['tenant', 'function getTenantConfig(tenantId: string) {}'],
    ])('detects "%s" in code', (term: string, code: string) => {
      const violations = findViolationsInText('src/sample.ts', code);
      expect(violations.length).toBeGreaterThanOrEqual(1);
      expect(violations[0].term).toBe(term);
      expect(violations[0].file).toBe('src/sample.ts');
    });

    it('handles case-insensitivity across all terms', () => {
      const sample = `
        const STRIPE = true;
        const BILLING_CYCLE = 'monthly';
        const EnterpriseCustomer = class {};
        // Burrow-Cloud reference
        const CurrentOrganization = 'Acme';
        const ORG_ID = '123';
        const CurrentTenant = 't1';
      `;
      const violations = findViolationsInText('src/case.ts', sample);
      const detectedTerms = new Set(violations.map((v: any) => v.term));
      for (const term of DEFAULT_VOCABULARY) {
        expect(detectedTerms.has(term)).toBe(true);
      }
    });

    it('detects compound word variants like tenant_id, organizations, and multi-tenant', () => {
      const snippet = `
        const tenant_id = 't_123';
        const organizations = [];
        const isMultiTenant = true;
        const stripe_customer_id = 'cus_123';
        const billing_owner = 'user_1';
      `;
      const violations = findViolationsInText('src/compound.ts', snippet);
      const terms = violations.map((v: any) => v.term);
      expect(terms).toContain('tenant');
      expect(terms).toContain('organization');
      expect(terms).toContain('stripe');
      expect(terms).toContain('billing');
    });

    it('passes completely clean text with zero violations', () => {
      const cleanSnippet = `
        export function calculateTotal(items: number[]) {
          return items.reduce((a, b) => a + b, 0);
        }
      `;
      const violations = findViolationsInText('src/clean.ts', cleanSnippet);
      expect(violations).toEqual([]);
    });
  });

  describe('isAllowlisted: allow-list behavior', () => {
    it('permits a usage when path, pattern, and reason are valid', () => {
      const allowList = [
        {
          path: 'src/web/components/boards/views/KanbanView.tsx',
          pattern: 'stripe',
          reason: 'UI visual stripe color on card badge',
        },
      ];

      const allowed = isAllowlisted(
        'src/web/components/boards/views/KanbanView.tsx',
        '// Accent stripe styling',
        'stripe',
        allowList,
      );
      expect(allowed).toBe(true);
    });

    it('rejects an allowlist entry missing a reason', () => {
      const invalidAllowList = [
        {
          path: 'src/sample.ts',
          pattern: 'stripe',
          reason: '   ',
        },
      ];

      const allowed = isAllowlisted(
        'src/sample.ts',
        'const stripe = true;',
        'stripe',
        invalidAllowList,
      );
      expect(allowed).toBe(false);
    });

    it('rejects an allowlist entry if the file path differs', () => {
      const allowList = [
        {
          path: 'src/other.ts',
          pattern: 'stripe',
          reason: 'Permitted in other file',
        },
      ];

      const allowed = isAllowlisted('src/sample.ts', 'const stripe = true;', 'stripe', allowList);
      expect(allowed).toBe(false);
    });

    it('rejects an allowlist entry if the pattern does not match', () => {
      const allowList = [
        {
          path: 'src/sample.ts',
          pattern: 'billing',
          reason: 'Permitted billing only',
        },
      ];

      const allowed = isAllowlisted('src/sample.ts', 'const stripe = true;', 'stripe', allowList);
      expect(allowed).toBe(false);
    });

    it('supports wildcard pattern to allow all vocabulary in a specific script/test file', () => {
      const allowList = [
        {
          path: 'scripts/check-decoupling.mjs',
          pattern: '.*',
          reason: 'Scanner defines terms',
        },
      ];

      const allowed = isAllowlisted(
        'scripts/check-decoupling.mjs',
        "const term = 'stripe';",
        'stripe',
        allowList,
      );
      expect(allowed).toBe(true);
    });

    it('normalizes Windows backslashes in paths', () => {
      const allowList = [
        {
          path: 'src/folder/file.ts',
          pattern: 'tenant',
          reason: 'Valid reason',
        },
      ];

      const allowed = isAllowlisted('src\\folder\\file.ts', '// tenant note', 'tenant', allowList);
      expect(allowed).toBe(true);
    });
  });

  describe('evaluateDecoupling: integration across files', () => {
    it('detects violations in a directory and reports details', () => {
      const allowList: any[] = [];
      const testContent = 'const tenant_id = "test";\nconst stripe = true;';
      const violations = findViolationsInText('docs/test.md', testContent, allowList);
      expect(violations.length).toBe(2);
      expect(violations[0].line).toBe(1);
      expect(violations[1].line).toBe(2);
    });

    it('identifies stale allowlist entries that were not matched', () => {
      const allowList = [
        {
          path: 'src/non-existent-file-123.ts',
          pattern: 'stripe',
          reason: 'Hypothetical reason',
        },
      ];

      const result = evaluateDecoupling(root, allowList, {
        targetDirs: ['scripts'],
        vocabRules: VOCABULARY_REGEXPS,
      });

      expect(result.staleAllowlist.length).toBe(1);
      expect(result.staleAllowlist[0].path).toBe('src/non-existent-file-123.ts');
    });

    it('passes clean scan on the real Burrow repository with decoupling-allowlist.json', async () => {
      const fs = await import('node:fs');
      const allowlistPath = path.join(root, 'scripts', 'decoupling-allowlist.json');
      const allowList = JSON.parse(fs.readFileSync(allowlistPath, 'utf8'));

      const result = evaluateDecoupling(root, allowList);
      expect(result.ok).toBe(true);
      expect(result.violations).toEqual([]);
      expect(result.staleAllowlist).toEqual([]);
    });
  });
});
