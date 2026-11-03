const IMAGE_SIGNATURES: Record<string, readonly number[]> = {
  'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  'image/jpeg': [0xff, 0xd8, 0xff],
  'image/gif': [0x47, 0x49, 0x46, 0x38],
};

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

function isWebp(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 12 &&
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  );
}

function isSvg(bytes: Uint8Array): boolean {
  let document: string;
  try {
    document = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return false;
  }

  if (document.startsWith('\uFEFF')) document = document.slice(1);
  if (/<!DOCTYPE\b/i.test(document)) return false;

  let root = document.trimStart();
  if (/^<\?xml(?:\s|\?)/.test(root)) {
    const declarationEnd = root.indexOf('?>');
    if (declarationEnd < 0) return false;
    root = root.slice(declarationEnd + 2).trimStart();
  }

  return /^<svg(?=[\s/>])/i.test(root);
}

/** Check that an image's leading bytes agree with its declared MIME type. */
export function isAllowedImageContent(mimeType: string, bytes: Uint8Array): boolean {
  if (!(bytes instanceof Uint8Array)) return false;

  const mime = mimeType.toLowerCase();
  if (mime === 'image/svg+xml') return isSvg(bytes);
  if (mime === 'image/webp') return isWebp(bytes);

  const signature = IMAGE_SIGNATURES[mime];
  if (!signature || bytes.length < signature.length || !startsWith(bytes, signature)) {
    return false;
  }
  if (mime === 'image/gif') {
    return (
      bytes.length >= 6 &&
      (bytes[4] === 0x37 || bytes[4] === 0x39) &&
      bytes[5] === 0x61
    );
  }
  return true;
}
