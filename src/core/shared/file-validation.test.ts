import { describe, expect, it } from 'vitest';
import { isAllowedFileContent } from './file-validation';

describe('attachment content validation', () => {
  it.each([
    ['application/pdf', '%PDF-1.7'], ['application/zip', 'PK\x03\x04'],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'PK\x03\x04'],
    ['video/mp4', '\x00\x00\x00\x18ftyp'], ['video/webm', '\x1a\x45\xdf\xa3'],
    ['audio/mpeg', 'ID3'], ['audio/ogg', 'OggS'], ['audio/wav', 'RIFF0000WAVE'],
    ['text/plain', 'hello'], ['text/csv', 'a,b\n1,2'],
  ])('accepts %s signatures and rejects unrelated bytes', (mime, sample) => {
    const bytes = Uint8Array.from([...sample].map((char) => char.charCodeAt(0)));
    expect(isAllowedFileContent(mime, bytes)).toBe(true);
    expect(isAllowedFileContent(mime, new Uint8Array([0, 1, 2]))).toBe(false);
  });
  it('rejects malformed UTF8 text', () => {
    expect(isAllowedFileContent('text/plain', new Uint8Array([0xff]))).toBe(false);
  });
});
