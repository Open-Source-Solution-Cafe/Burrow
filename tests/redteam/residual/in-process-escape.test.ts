import { describe, expect, it } from 'vitest';

/**
 * Residual in-process trust boundary suite.
 *
 * Plugins run inside the operator's Node.js or Cloudflare Worker isolate without
 * V8 Isolate / OS process sandboxing. They are installed at the operator's discretion
 * as operator-trusted code; these assertions document the inherent process-level
 * globals reachable by loaded JavaScript plugin modules.
 */
describe('Residual In-Process Plugin Boundary (Node / Worker Runtime)', () => {
  it('documents that globalThis/fetch/process remain reachable from in-process JS plugin code', () => {
    expect(typeof globalThis.fetch).toBe('function');
    expect(typeof process.env).toBe('object');
  });
});
