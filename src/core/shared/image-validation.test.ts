import { describe, expect, it } from 'vitest';
import { isAllowedImageContent } from './image-validation';

const bytes = (...values: number[]) => new Uint8Array(values);

describe('isAllowedImageContent', () => {
  it.each([
    ['image/png', bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00)],
    ['image/jpeg', bytes(0xff, 0xd8, 0xff, 0xe0)],
    ['image/gif', new TextEncoder().encode('GIF89aDATA')],
    ['image/gif', new TextEncoder().encode('GIF87aDATA')],
    ['image/webp', new TextEncoder().encode('RIFF\x00\x00\x00\x00WEBPDATA')],
  ])('accepts %s signature bytes', (mimeType, content) => {
    expect(isAllowedImageContent(mimeType, content)).toBe(true);
  });

  it.each([
    '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>',
    '\uFEFF  \n<svg viewBox="0 0 1 1"/>',
    '<?xml version="1.0" encoding="UTF-8"?>\n  <svg xmlns="http://www.w3.org/2000/svg"/>',
  ])('accepts an SVG document with supported prolog: %s', (document) => {
    expect(isAllowedImageContent('image/svg+xml', new TextEncoder().encode(document))).toBe(true);
  });

  it.each([
    ['image/png', bytes(0xff, 0xd8, 0xff, 0xe0)],
    ['image/jpeg', bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)],
    ['image/webp', new TextEncoder().encode('GIF89aDATA')],
    ['image/gif', new TextEncoder().encode('<svg/>')],
    ['image/svg+xml', bytes(0x89, 0x50, 0x4e, 0x47)],
  ])('rejects content spoofed as %s', (mimeType, content) => {
    expect(isAllowedImageContent(mimeType, content)).toBe(false);
  });

  it('rejects truncated and malformed raster signatures', () => {
    expect(isAllowedImageContent('image/png', bytes(0x89, 0x50, 0x4e))).toBe(false);
    expect(isAllowedImageContent('image/jpeg', bytes(0xff, 0xd8))).toBe(false);
    expect(isAllowedImageContent('image/gif', new TextEncoder().encode('GIF89'))).toBe(false);
    expect(isAllowedImageContent('image/webp', new TextEncoder().encode('RIFF1234WEB'))).toBe(false);
    expect(isAllowedImageContent('image/webp', new TextEncoder().encode('RIFF1234NOPE'))).toBe(false);
  });

  it.each([
    '<html><svg/></html>',
    '<!DOCTYPE svg [<!ENTITY x "boom">]><svg/>',
    '<?xml version="1.0"?><!DOCTYPE svg><svg/>',
    '<?xml version="1.0" <svg/>',
    '<svgscript/>',
    '<svg',
  ])('rejects invalid SVG documents: %s', (document) => {
    expect(isAllowedImageContent('image/svg+xml', new TextEncoder().encode(document))).toBe(false);
  });

  it('rejects unknown MIME types and invalid UTF-8 SVG data', () => {
    expect(isAllowedImageContent('image/bmp', bytes(0x42, 0x4d))).toBe(false);
    expect(isAllowedImageContent('image/svg+xml', bytes(0xc3, 0x28))).toBe(false);
  });
});
