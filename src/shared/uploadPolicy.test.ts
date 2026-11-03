import { describe, expect, it } from 'vitest';
import { getUploadFileType, isUploadPolicyStorageKey, uploadPolicyStorageKey } from './uploadPolicy';

describe('upload file type selection', () => {
  it('uses supported MIME types and recovers absent generic browser MIME types from extensions', () => {
    expect(getUploadFileType({ type: '', name: 'REPORT.PDF' })?.mimeType).toBe('application/pdf');
    expect(getUploadFileType({ type: 'application/octet-stream', name: 'photo.jpeg' })?.extension).toBe('jpg');
    expect(getUploadFileType({ type: 'application/x-zip-compressed', name: 'archive.zip' })?.mimeType).toBe('application/zip');
    expect(getUploadFileType({ type: 'text/html', name: 'fake.pdf' })).toBeUndefined();
    expect(getUploadFileType({ type: '', name: 'unknown.exe' })).toBeUndefined();
  });
  it('recognizes only an exact internal project policy key', () => {
    expect(isUploadPolicyStorageKey(uploadPolicyStorageKey('w', 'p'))).toBe(true);
    expect(isUploadPolicyStorageKey('w/p/child/.upload-policy.json')).toBe(false);
  });
});
