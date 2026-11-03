/** Check container signatures before storing browser-supplied attachment types. */
export function isAllowedFileContent(mime: string, bytes: Uint8Array): boolean {
  const at = (offset: number, signature: number[]) => signature.every((byte, i) => bytes[offset + i] === byte);
  const ascii = (offset: number, value: string) => at(offset, [...value].map((char) => char.charCodeAt(0)));
  if (mime === 'text/plain' || mime === 'text/csv') {
    if (bytes.includes(0)) return false;
    try { new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes); return true; } catch { return false; }
  }
  if (mime === 'application/pdf') return ascii(0, '%PDF-');
  if (mime === 'application/zip' || mime.startsWith('application/vnd.openxmlformats-officedocument.')) {
    return at(0, [0x50, 0x4b, 3, 4]) || at(0, [0x50, 0x4b, 5, 6]);
  }
  if (mime === 'video/mp4') return ascii(4, 'ftyp');
  if (mime === 'video/webm') return at(0, [0x1a, 0x45, 0xdf, 0xa3]);
  if (mime === 'audio/mpeg') return ascii(0, 'ID3') || (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0);
  if (mime === 'audio/ogg') return ascii(0, 'OggS');
  if (mime === 'audio/wav') return ascii(0, 'RIFF') && ascii(8, 'WAVE');
  return false;
}
