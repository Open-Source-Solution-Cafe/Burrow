import { describe, expect, it } from 'vitest';
import {
  MAX_UPLOAD_BYTES,
  WORKER_MAX_UPLOAD_BYTES,
  isCloudflareWorkersRuntime,
  maxUploadBytesForRuntime,
  resolveDeploymentRuntime,
} from '../../src/shared/uploadPolicy';

describe('deployment runtime detection and upload size caps', () => {
  it('does not classify Node/SQLite or Docker/PostgreSQL as Workers based on nullable FILES bindings', () => {
    expect(isCloudflareWorkersRuntime({ FILES: null })).toBe(false);
    expect(isCloudflareWorkersRuntime({ FILES: undefined })).toBe(false);
    expect(
      resolveDeploymentRuntime({
        env: { FILES: null, DATABASE_URL: 'postgres://burrow:pw@localhost:5432/burrow' },
      }),
    ).toBe('docker-postgres');
    expect(resolveDeploymentRuntime({ env: { FILES: null } })).toBe('node-sqlite');
  });

  it('detects explicit worker runtime and keeps Worker upload ceiling at 25 MB', () => {
    expect(isCloudflareWorkersRuntime({ CF_WORKERS: true })).toBe(true);
    expect(resolveDeploymentRuntime({ runtime: 'worker' })).toBe('worker');
    expect(resolveDeploymentRuntime({ env: { BURROW_RUNTIME: 'worker' } })).toBe('worker');

    expect(maxUploadBytesForRuntime('worker')).toBe(WORKER_MAX_UPLOAD_BYTES);
    expect(maxUploadBytesForRuntime('worker')).toBe(25 * 1024 * 1024);
    expect(maxUploadBytesForRuntime('node-sqlite')).toBe(MAX_UPLOAD_BYTES);
    expect(maxUploadBytesForRuntime('docker-postgres')).toBe(MAX_UPLOAD_BYTES);
    expect(MAX_UPLOAD_BYTES).toBe(100 * 1024 * 1024);
  });
});
