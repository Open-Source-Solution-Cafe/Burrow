import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout } from 'node:timers/promises';
import postgres from 'postgres';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  interface ProvidedContext {
    postgresTestUrl: string;
  }
}

const exec = promisify(execFile);
const docker = async (...args: string[]) =>
  (await exec('docker', args, { windowsHide: true, timeout: 120_000 })).stdout.trim();

/** Own a disposable database; an override selects the server, never its test data. */
export default async function setup(project: TestProject) {
  const database = `burrow_test_${randomUUID().replaceAll('-', '')}`;
  let container: string | undefined;
  let admin: ReturnType<typeof postgres> | undefined;
  let created = false;
  const cleanup = async () => {
    try {
      if (created && admin) await admin.unsafe(`DROP DATABASE "${database}" WITH (FORCE)`);
    } finally {
      try {
        await admin?.end();
      } finally {
        if (container) await docker('rm', '--force', container);
      }
    }
  };
  try {
    let adminUrl = process.env.BURROW_TEST_POSTGRES_URL;
    if (!adminUrl) {
      const candidateContainer = `burrow-test-${randomUUID()}`;
      await docker(
        'run',
        '--detach',
        '--rm',
        '--name',
        candidateContainer,
        '--publish',
        '127.0.0.1::5432',
        '--env',
        'POSTGRES_USER=burrow_test',
        '--env',
        'POSTGRES_PASSWORD=burrow_test',
        '--env',
        'POSTGRES_DB=postgres',
        'postgres:17',
      );
      container = candidateContainer;
      const address = await docker('port', container, '5432/tcp');
      const port = /^127\.0\.0\.1:(\d+)$/.exec(address)?.[1];
      if (!port) throw new Error('Disposable PostgreSQL did not publish a loopback port');
      adminUrl = `postgres://burrow_test:burrow_test@127.0.0.1:${port}/postgres`;
    }
    admin = postgres(adminUrl, { max: 1, connect_timeout: 2, onnotice: () => {} });
    for (let attempt = 0; ; attempt++) {
      try {
        await admin`SELECT 1`;
        break;
      } catch (error) {
        if (attempt === 39) throw error;
        await setTimeout(250);
      }
    }
    await admin.unsafe(`CREATE DATABASE "${database}"`);
    created = true;
    const testUrl = new URL(adminUrl);
    testUrl.pathname = `/${database}`;
    project.provide('postgresTestUrl', testUrl.toString());
    return cleanup;
  } catch (error) {
    await cleanup();
    throw new Error(
      'Database contracts require Docker or BURROW_TEST_POSTGRES_URL with CREATE DATABASE permission',
      { cause: error },
    );
  }
}
