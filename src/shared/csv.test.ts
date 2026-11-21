import { describe, it, expect } from 'vitest';
import { parseCsv, serializeCsv } from './csv';

describe('RFC 4180 CSV utilities', () => {
  it('round-trips multiline, quoted, and unicode cells', () => {
    const csv = serializeCsv(
      ['Title', 'Status', 'Notes'],
      [
        ['Fix "auth" bug', 'In Progress', 'Line 1\nLine 2, with comma'],
        ['Ship 🚀', 'Done', null],
      ],
    );
    const parsed = parseCsv(csv);
    expect(parsed.headers).toEqual(['Title', 'Status', 'Notes']);
    expect(parsed.rows).toEqual([
      { Title: 'Fix "auth" bug', Status: 'In Progress', Notes: 'Line 1\nLine 2, with comma' },
      { Title: 'Ship 🚀', Status: 'Done', Notes: '' },
    ]);
  });
});
