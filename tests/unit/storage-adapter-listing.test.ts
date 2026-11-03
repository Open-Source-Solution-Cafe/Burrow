import { describe, expect, it, vi } from 'vitest';
import type { R2Bucket } from '@cloudflare/workers-types';
import { R2StorageAdapter } from '../../src/core/adapters/storage/r2';
import { S3StorageAdapter } from '../../src/core/adapters/storage/s3';

describe('storage adapter inventory listing', () => {
  it('follows R2 continuation cursors and returns sorted keys', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({ objects: [{ key: 'z.png' }], truncated: true, cursor: 'page-2' })
      .mockResolvedValueOnce({ objects: [{ key: 'a.png' }], truncated: false });
    const adapter = new R2StorageAdapter({ list } as unknown as R2Bucket);

    await expect(adapter.listObjects()).resolves.toEqual(['a.png', 'z.png']);
    expect(list).toHaveBeenNthCalledWith(1, { cursor: undefined });
    expect(list).toHaveBeenNthCalledWith(2, { cursor: 'page-2' });
  });

  it('follows S3 continuation tokens and returns sorted keys', async () => {
    const adapter = new S3StorageAdapter({
      endpoint: 'https://objects.example.test',
      region: 'us-east-1',
      bucket: 'test',
      accessKey: 'test',
      secretKey: 'test',
    });
    const responses = [
      { Contents: [{ Key: 'z.png' }], IsTruncated: true, NextContinuationToken: 'page-2' },
      { Contents: [{ Key: 'a.png' }], IsTruncated: false },
    ];
    const tokens: string[] = [];
    const send = vi.fn(async (command: { input: { ContinuationToken?: string } }) => {
      tokens.push(command.input.ContinuationToken ?? '<first>');
      return responses.shift()!;
    });
    (adapter as unknown as { client: { send: typeof send } }).client.send = send;

    await expect(adapter.listObjects()).resolves.toEqual(['a.png', 'z.png']);
    expect(send).toHaveBeenCalledTimes(2);
    expect(tokens).toEqual(['<first>', 'page-2']);
  });
});
