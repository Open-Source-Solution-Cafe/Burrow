export type MediaUrl =
  { kind: 'youtube'; videoId: string; url: string } | { kind: 'link'; url: string };

export function isYoutubeVideoId(value: string): boolean {
  return /^[A-Za-z0-9_-]{11}$/.test(value);
}

/** Only explicit web URLs are links. Only exact supported hosts/routes become embeds. */
export function parseMediaUrl(input: string): MediaUrl | null {
  let parsed: URL;
  try {
    parsed = new URL(input.trim());
  } catch {
    return null;
  }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    return null;
  }

  const fallback: MediaUrl = { kind: 'link', url: parsed.href };
  if (parsed.port) return fallback;
  const host = parsed.hostname.toLowerCase();
  let id: string | null = null;
  if (host === 'youtu.be') {
    id = /^\/([A-Za-z0-9_-]{11})\/?$/.exec(parsed.pathname)?.[1] ?? null;
  } else if (
    [
      'youtube.com',
      'www.youtube.com',
      'm.youtube.com',
      'www.youtube-nocookie.com',
      'youtube-nocookie.com',
    ].includes(host)
  ) {
    if (parsed.pathname === '/watch') id = parsed.searchParams.get('v');
    else id = /^\/(?:shorts|embed)\/([A-Za-z0-9_-]{11})\/?$/.exec(parsed.pathname)?.[1] ?? null;
  }
  return id && isYoutubeVideoId(id)
    ? { kind: 'youtube', videoId: id, url: `https://www.youtube.com/watch?v=${id}` }
    : fallback;
}
