import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Monitor, NewsItem } from '../src/types/index.ts';
import {
  buildGoogleNewsSearchQuery,
  buildYouTubeSearchQuery,
  collectNewsMentions,
  matchMonitorText,
  mergeMentionHistory,
  parseMonitorTerms,
  type MonitorMention,
} from '../src/services/brand-monitor.ts';

const monitor: Monitor = {
  id: 'acme-campaign',
  name: 'ACME Summer',
  keywords: ['ACME', 'Summer launch'],
  excludedKeywords: ['Acme Township'],
  color: '#11aaee',
};

describe('brand monitor terms and matching', () => {
  it('trims and deduplicates terms while preserving the first spelling', () => {
    assert.deepEqual(parseMonitorTerms(' ACME, acme, Lanzamiento  Verano, , !!! '), [
      'ACME',
      'Lanzamiento Verano',
    ]);
  });

  it('matches accents and whole terms, then applies exclusions', () => {
    const accentMonitor: Monitor = { ...monitor, keywords: ['Campaña'], excludedKeywords: [] };
    assert.equal(matchMonitorText(accentMonitor, 'La campana ya está activa'), 'Campaña');

    const shortMonitor: Monitor = { ...monitor, keywords: ['AI'], excludedKeywords: [] };
    assert.equal(matchMonitorText(shortMonitor, 'A train arrived'), null);
    assert.equal(matchMonitorText(shortMonitor, 'AI campaign results'), 'AI');
    assert.equal(matchMonitorText(monitor, 'ACME Township publishes a notice'), null);
  });

  it('builds bounded boolean queries and removes operator injection', () => {
    const second: Monitor = { ...monitor, id: 'second', keywords: ['Launch|Hack', 'Blue Sky'] };
    assert.equal(buildYouTubeSearchQuery([monitor, second]), 'ACME|Summer launch|Launch Hack|Blue Sky');
    assert.equal(
      buildGoogleNewsSearchQuery([monitor, second]),
      'ACME OR "Summer launch" OR "Launch Hack" OR "Blue Sky" when:7d',
    );
  });
});

describe('brand monitor mention collection and history', () => {
  it('finds a keyword in the article snippet', () => {
    const article = {
      title: 'Retail update',
      snippet: 'The ACME summer campaign launches this week.',
      link: 'https://example.com/acme',
      source: 'Example News',
      pubDate: new Date('2026-08-20T12:00:00.000Z'),
    } as NewsItem;
    const mentions = collectNewsMentions([article], [monitor]);
    assert.equal(mentions.length, 1);
    assert.equal(mentions[0]?.source, 'news');
    assert.equal(mentions[0]?.matchedKeyword, 'ACME');
  });

  it('deduplicates, prunes old mentions, and keeps newest results first', () => {
    const now = Date.parse('2026-08-29T12:00:00.000Z');
    const mention = (id: string, publishedAt: number): MonitorMention => ({
      id,
      monitorId: monitor.id,
      source: 'web',
      sourceName: 'Example',
      title: id,
      link: `https://example.com/${id}`,
      publishedAt,
      matchedKeyword: 'ACME',
    });
    const duplicate = mention('same', now - 1_000);
    const merged = mergeMentionHistory(
      [duplicate, mention('old', now - 31 * 24 * 60 * 60 * 1_000)],
      [{ ...duplicate, title: 'updated' }, mention('newest', now)],
      { now },
    );
    assert.deepEqual(merged.map((item) => item.id), ['newest', 'same']);
    assert.equal(merged[1]?.title, 'updated');
  });
});
