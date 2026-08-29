import type { Monitor, NewsItem } from '@/types';

export type MonitorMentionSource = 'news' | 'web' | 'youtube';

export interface MonitorMention {
  id: string;
  monitorId: string;
  source: MonitorMentionSource;
  sourceName: string;
  title: string;
  link: string;
  publishedAt: number;
  matchedKeyword: string;
}

const MAX_MONITOR_TERMS = 20;
const MAX_TERM_LENGTH = 80;
const DEFAULT_HISTORY_DAYS = 30;
const DEFAULT_HISTORY_LIMIT = 500;
const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;
const COMBINING_MARKS = /[\u0300-\u036f]/g;

function foldText(value: string): string {
  return value
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .toLocaleLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function containsBoundedTerm(text: string, term: string): boolean {
  if (!term) return false;
  let offset = text.indexOf(term);
  while (offset !== -1) {
    const before = offset > 0 ? text[offset - 1] : undefined;
    const afterIndex = offset + term.length;
    const after = afterIndex < text.length ? text[afterIndex] : undefined;
    const needsLeftBoundary = LETTER_OR_NUMBER.test(term[0] ?? '');
    const needsRightBoundary = LETTER_OR_NUMBER.test(term[term.length - 1] ?? '');
    const leftMatches = !needsLeftBoundary || before === undefined || !LETTER_OR_NUMBER.test(before);
    const rightMatches = !needsRightBoundary || after === undefined || !LETTER_OR_NUMBER.test(after);
    if (leftMatches && rightMatches) return true;
    offset = text.indexOf(term, offset + 1);
  }
  return false;
}

export function parseMonitorTerms(value: string): string[] {
  const terms = value
    .split(',')
    .map((term) => term.normalize('NFC').trim().replace(/\s+/g, ' '))
    .filter((term) => term.length > 0 && term.length <= MAX_TERM_LENGTH && LETTER_OR_NUMBER.test(term));
  const uniqueTerms = new Map<string, string>();
  for (const term of terms) {
    const key = term.toLocaleLowerCase();
    if (!uniqueTerms.has(key)) uniqueTerms.set(key, term);
  }
  return [...uniqueTerms.values()].slice(0, MAX_MONITOR_TERMS);
}

export function normalizeMonitor(monitor: Monitor, fallbackIndex = 0): Monitor {
  const keywords = parseMonitorTerms(monitor.keywords.join(','));
  const excludedKeywords = parseMonitorTerms((monitor.excludedKeywords ?? []).join(','));
  const fallbackName = keywords[0] || `Monitor ${fallbackIndex + 1}`;
  return {
    ...monitor,
    name: monitor.name?.trim() || fallbackName,
    keywords,
    excludedKeywords,
  };
}

export function monitorDisplayName(monitor: Monitor): string {
  return monitor.name?.trim() || monitor.keywords[0] || 'Monitor';
}

export function matchMonitorText(monitor: Monitor, value: string): string | null {
  const text = foldText(value);
  if (!text) return null;
  const excluded = (monitor.excludedKeywords ?? [])
    .map(foldText)
    .some((term) => containsBoundedTerm(text, term));
  if (excluded) return null;
  for (const keyword of monitor.keywords) {
    const foldedKeyword = foldText(keyword);
    if (containsBoundedTerm(text, foldedKeyword)) return keyword;
  }
  return null;
}

function mentionId(monitorId: string, source: MonitorMentionSource, link: string): string {
  return `${monitorId}:${source}:${link}`;
}

export function collectNewsMentions(news: NewsItem[], monitors: Monitor[]): MonitorMention[] {
  const mentions: MonitorMention[] = [];
  const seen = new Set<string>();
  for (const item of news) {
    const searchText = `${item.title} ${item.snippet ?? ''}`;
    for (const monitor of monitors) {
      const matchedKeyword = matchMonitorText(monitor, searchText);
      if (!matchedKeyword || !item.link) continue;
      const id = mentionId(monitor.id, 'news', item.link);
      if (seen.has(id)) continue;
      seen.add(id);
      mentions.push({
        id,
        monitorId: monitor.id,
        source: 'news',
        sourceName: item.source,
        title: item.title,
        link: item.link,
        publishedAt: item.pubDate.getTime(),
        matchedKeyword,
      });
    }
  }
  return mentions;
}

function sanitizeBooleanSearchTerm(value: string): string {
  return value.replace(/[|"\r\n]/g, ' ').replace(/\s+/g, ' ').trim();
}

function uniqueSearchTerms(monitors: Monitor[]): string[] {
  const terms = monitors.flatMap((monitor) => monitor.keywords)
    .map(sanitizeBooleanSearchTerm)
    .filter(Boolean);
  const uniqueTerms = new Map<string, string>();
  for (const term of terms) {
    const key = term.toLocaleLowerCase();
    if (!uniqueTerms.has(key)) uniqueTerms.set(key, term);
  }
  return [...uniqueTerms.values()];
}

function appendWithinLimit(parts: string[], separator: string, maxLength: number): string {
  let query = '';
  for (const part of parts) {
    const candidate = query ? `${query}${separator}${part}` : part;
    if (candidate.length > maxLength) break;
    query = candidate;
  }
  return query;
}

export function buildYouTubeSearchQuery(monitors: Monitor[], maxLength = 450): string {
  return appendWithinLimit(uniqueSearchTerms(monitors), '|', maxLength);
}

export function buildGoogleNewsSearchQuery(monitors: Monitor[], maxLength = 420): string {
  const terms = uniqueSearchTerms(monitors).map((term) => term.includes(' ') ? `"${term}"` : term);
  const query = appendWithinLimit(terms, ' OR ', Math.max(1, maxLength - ' when:7d'.length));
  return query ? `${query} when:7d` : '';
}

export function mergeMentionHistory(
  existing: MonitorMention[],
  incoming: MonitorMention[],
  options: { now?: number; maxAgeDays?: number; maxItems?: number } = {},
): MonitorMention[] {
  const now = options.now ?? Date.now();
  const maxAgeDays = options.maxAgeDays ?? DEFAULT_HISTORY_DAYS;
  const maxItems = options.maxItems ?? DEFAULT_HISTORY_LIMIT;
  const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000;
  const merged = new Map<string, MonitorMention>();
  for (const mention of [...existing, ...incoming]) {
    if (!Number.isFinite(mention.publishedAt) || mention.publishedAt < cutoff || mention.publishedAt > now + 60_000) continue;
    if (!mention.monitorId || !mention.link || !mention.title) continue;
    merged.set(mention.id, mention);
  }
  return [...merged.values()]
    .sort((left, right) => right.publishedAt - left.publishedAt)
    .slice(0, Math.max(1, maxItems));
}

export function createExternalMention(
  monitor: Monitor,
  source: Exclude<MonitorMentionSource, 'news'>,
  item: { sourceName: string; title: string; link: string; publishedAt: number; searchText?: string },
): MonitorMention | null {
  const matchedKeyword = matchMonitorText(monitor, item.searchText ?? item.title);
  if (!matchedKeyword || !item.link) return null;
  return {
    id: mentionId(monitor.id, source, item.link),
    monitorId: monitor.id,
    source,
    sourceName: item.sourceName,
    title: item.title,
    link: item.link,
    publishedAt: item.publishedAt,
    matchedKeyword,
  };
}
