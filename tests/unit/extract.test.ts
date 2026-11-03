import { describe, expect, it } from 'vitest';
import { extractFromContent } from '../../src/shared/extract';

describe('document extraction', () => {
  it.each(['', 'broken', '{}', 'null'])('treats malformed document %j as empty', (content) => {
    expect(extractFromContent(content)).toEqual({ text: '', mentions: [], links: [] });
  });

  it('retains tag and date text without treating them as resource references', () => {
    const result = extractFromContent(JSON.stringify([{
      type: 'paragraph',
      content: [
        { type: 'mention', props: { kind: 'tag', id: 'tag-1', label: 'Research' } },
        { type: 'text', text: ' on ' },
        { type: 'mention', props: { kind: 'date', isoDate: '2026-10-26', label: 'Monday' } },
      ],
    }]));
    expect(result.text).toBe('Research on Monday');
    expect(result.mentions.map((mention) => mention.kind)).toEqual(['tag', 'date']);
    expect(result.links).toEqual([]);
  });

  it('deduplicates nested resource references while keeping their visible text', () => {
    const mention = { type: 'mention', props: { kind: 'user', id: 'user-1', label: 'Alex' } };
    const result = extractFromContent(JSON.stringify([{
      type: 'paragraph', content: [mention], children: [
        { type: 'paragraph', content: [{ type: 'link', content: [mention] }] },
        { type: 'notepadLink', props: { notepadId: 'note-1' } },
        { type: 'notepadLink', props: { notepadId: 'note-1' } },
      ],
    }]));
    expect(result.text).toBe('AlexAlex');
    expect(result.mentions).toHaveLength(1);
    expect(result.links).toEqual([
      { targetType: 'user', targetId: 'user-1' },
      { targetType: 'notepad', targetId: 'note-1' },
    ]);
  });
});
