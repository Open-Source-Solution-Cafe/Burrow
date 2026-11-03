import { describe, expect, it } from 'vitest';
import { referenceHref, type ReferencePreview } from './references';

const preview: ReferencePreview = {
  kind: 'notepad',
  id: 'note',
  workspaceId: 'ws',
  projectId: 'project',
  title: 'Note',
};

describe('resolved reference destinations', () => {
  it('uses the resolved project and target for each kind', () => {
    expect(referenceHref(preview)).toBe('/p/project/notepads/note');
    expect(referenceHref({ ...preview, kind: 'board', id: 'board' })).toBe(
      '/p/project/boards/board',
    );
    expect(referenceHref({ ...preview, kind: 'card', id: 'card', boardId: 'board' })).toBe(
      '/p/project/boards/board?cardId=card',
    );
  });
  it('never guesses a destination for incomplete targets', () => {
    expect(referenceHref({ ...preview, kind: 'card' })).toBeNull();
    expect(referenceHref({ ...preview, id: '' })).toBeNull();
    expect(referenceHref({ ...preview, projectId: '' })).toBeNull();
  });
  it('encodes identifiers rather than interpreting path/query syntax', () => {
    expect(referenceHref({ ...preview, projectId: 'p/other', id: 'id?foreign=1' })).toBe(
      '/p/p%2Fother/notepads/id%3Fforeign%3D1',
    );
  });
});
