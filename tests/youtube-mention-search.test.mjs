import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { _internal } from '../api/youtube/search.js';

describe('YouTube mention search normalization', () => {
  it('normalizes queries without leaving control characters', () => {
    assert.equal(_internal.normalizeQuery('  ACME\nSummer\u0000Campaign  '), 'ACME Summer Campaign');
  });

  it('accepts only recent, valid publication dates', () => {
    assert.equal(_internal.normalizePublishedAfter('not-a-date'), null);
    assert.equal(_internal.normalizePublishedAfter(new Date(Date.now() - 40 * 24 * 60 * 60 * 1_000).toISOString()), null);
    assert.match(_internal.normalizePublishedAfter(new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString()), /^\d{4}-/);
  });

  it('returns only safe video records with valid YouTube ids', () => {
    const items = _internal.normalizeItems({
      items: [
        {
          id: { videoId: 'abcdefghijk' },
          snippet: {
            title: ' ACME\nlaunch ',
            description: 'Campaign results',
            channelTitle: 'Brand Channel',
            publishedAt: '2026-08-20T12:00:00Z',
          },
        },
        { id: { videoId: 'bad' }, snippet: { title: 'Ignored', channelTitle: 'Bad' } },
      ],
    });
    assert.deepEqual(items, [{
      videoId: 'abcdefghijk',
      title: 'ACME launch',
      description: 'Campaign results',
      channelTitle: 'Brand Channel',
      publishedAt: '2026-08-20T12:00:00Z',
    }]);
  });
});
