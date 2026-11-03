import { describe, expect, it } from 'vitest';
import { isYoutubeVideoId, parseMediaUrl } from './mediaUrl';

const id = 'dQw4w9WgXcQ';

describe('media URL parsing', () => {
  it.each([
    `https://youtu.be/${id}?si=tracking`,
    `https://www.youtube.com/watch?v=${id}&feature=share`,
    `http://youtube.com/shorts/${id}`,
    `https://m.youtube.com/watch?v=${id}`,
    `https://www.youtube-nocookie.com/embed/${id}`,
    `https://youtube.com/embed/${id}/`,
  ])('normalizes supported YouTube URL %s', (url) => {
    expect(parseMediaUrl(url)).toEqual({
      kind: 'youtube',
      videoId: id,
      url: `https://www.youtube.com/watch?v=${id}`,
    });
  });

  it.each([
    '',
    '/relative',
    '//youtube.com/watch?v=x',
    'javascript:alert(1)',
    'data:text/html,test',
    'file:///tmp/test',
    'https://user:pass@youtube.com/watch?v=dQw4w9WgXcQ',
  ])('rejects unsafe or invalid URL %s', (url) => {
    expect(parseMediaUrl(url)).toBeNull();
  });

  it.each([
    'https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ',
    'https://evil.test/youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtube.com/watch?v=bad',
    'https://youtube.com/embed/dQw4w9WgXcQ/extra',
    'https://youtu.be/dQw4w9WgXcQ/extra',
    'https://youtube.com:8443/watch?v=dQw4w9WgXcQ',
    'https://example.com/video.mp4',
  ])('retains unsupported web URLs as links: %s', (url) => {
    expect(parseMediaUrl(url)).toEqual({ kind: 'link', url });
  });

  it('trims input and escapes path characters in links', () => {
    expect(parseMediaUrl(' https://example.com/a b ')).toEqual({
      kind: 'link',
      url: 'https://example.com/a%20b',
    });
  });

  it.each(['', 'too-short', 'dQw4w9WgXcQ/evil', '<script>xxx', 'dQw4w9WgXcQ?foo'])(
    'rejects invalid stored video ID %s',
    (value) => {
      expect(isYoutubeVideoId(value)).toBe(false);
    },
  );
});
