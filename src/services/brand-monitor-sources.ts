import type { Monitor } from '@/types';
import { fetchWithProxy, rssProxyUrl } from '@/utils';
import {
  buildGoogleNewsSearchQuery,
  buildYouTubeSearchQuery,
  createExternalMention,
  type MonitorMention,
} from './brand-monitor';

const WEB_CACHE_TTL_MS = 30 * 60 * 1000;
const YOUTUBE_CACHE_TTL_MS = 4 * 60 * 60 * 1000;
const MAX_GOOGLE_NEWS_ITEMS = 40;

type SourceCache<T> = { key: string; fetchedAt: number; value: T };

export interface YouTubeMentionResult {
  status: 'ready' | 'not_configured' | 'unavailable';
  mentions: MonitorMention[];
}

interface YouTubeSearchItem {
  videoId?: unknown;
  title?: unknown;
  description?: unknown;
  channelTitle?: unknown;
  publishedAt?: unknown;
}

interface YouTubeSearchPayload {
  configured?: unknown;
  items?: unknown;
}

let webCache: SourceCache<MonitorMention[]> | null = null;
let youtubeCache: SourceCache<YouTubeMentionResult> | null = null;
let webInFlight: { key: string; promise: Promise<MonitorMention[]> } | null = null;
let youtubeInFlight: { key: string; promise: Promise<YouTubeMentionResult> } | null = null;

function localeOptions(language: string): { hl: string; gl: string; ceid: string } {
  const base = language.toLocaleLowerCase().split('-')[0] || 'en';
  if (base === 'es') return { hl: 'es', gl: 'ES', ceid: 'ES:es' };
  if (base === 'fr') return { hl: 'fr', gl: 'FR', ceid: 'FR:fr' };
  if (base === 'de') return { hl: 'de', gl: 'DE', ceid: 'DE:de' };
  if (base === 'pt') return { hl: 'pt-BR', gl: 'BR', ceid: 'BR:pt-419' };
  return { hl: 'en-US', gl: 'US', ceid: 'US:en' };
}

function parseDate(value: string | null): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function collectExternalMentions(
  monitors: Monitor[],
  source: 'web' | 'youtube',
  items: Array<{ sourceName: string; title: string; link: string; publishedAt: number; searchText?: string }>,
): MonitorMention[] {
  const mentions: MonitorMention[] = [];
  for (const item of items) {
    for (const monitor of monitors) {
      const mention = createExternalMention(monitor, source, item);
      if (mention) mentions.push(mention);
    }
  }
  return mentions;
}

async function requestGoogleNewsMentions(monitors: Monitor[], language: string): Promise<MonitorMention[]> {
  const query = buildGoogleNewsSearchQuery(monitors);
  if (!query) return [];
  const locale = localeOptions(language);
  const feedUrl = new URL('https://news.google.com/rss/search');
  feedUrl.searchParams.set('q', query);
  feedUrl.searchParams.set('hl', locale.hl);
  feedUrl.searchParams.set('gl', locale.gl);
  feedUrl.searchParams.set('ceid', locale.ceid);
  const response = await fetchWithProxy(rssProxyUrl(feedUrl.toString()));
  if (!response.ok) throw new Error(`Google News search failed (${response.status})`);
  const document = new DOMParser().parseFromString(await response.text(), 'text/xml');
  if (document.querySelector('parsererror')) throw new Error('Google News returned invalid RSS');
  const items = Array.from(document.querySelectorAll('item'))
    .slice(0, MAX_GOOGLE_NEWS_ITEMS)
    .map((item) => {
      const title = item.querySelector('title')?.textContent?.trim() ?? '';
      const link = item.querySelector('link')?.textContent?.trim() ?? '';
      const sourceName = item.querySelector('source')?.textContent?.trim() || 'Google News';
      return {
        sourceName,
        title,
        link,
        publishedAt: parseDate(item.querySelector('pubDate')?.textContent ?? null),
      };
    })
    .filter((item) => item.title && item.link);
  return collectExternalMentions(monitors, 'web', items);
}

export async function fetchGoogleNewsMentions(
  monitors: Monitor[],
  options: { language?: string; force?: boolean } = {},
): Promise<MonitorMention[]> {
  const language = options.language || 'en';
  const key = `${language}:${buildGoogleNewsSearchQuery(monitors)}`;
  if (!key.endsWith(':') && !options.force && webCache?.key === key && Date.now() - webCache.fetchedAt < WEB_CACHE_TTL_MS) {
    return webCache.value;
  }
  if (!options.force && webInFlight?.key === key) return webInFlight.promise;
  const promise = requestGoogleNewsMentions(monitors, language)
    .then((mentions) => {
      webCache = { key, fetchedAt: Date.now(), value: mentions };
      return mentions;
    })
    .finally(() => {
      if (webInFlight?.key === key) webInFlight = null;
    });
  webInFlight = { key, promise };
  return promise;
}

async function requestYouTubeMentions(monitors: Monitor[], language: string): Promise<YouTubeMentionResult> {
  const query = buildYouTubeSearchQuery(monitors);
  if (!query) return { status: 'ready', mentions: [] };
  const params = new URLSearchParams({
    query,
    maxResults: '50',
    publishedAfter: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    relevanceLanguage: language.split('-')[0] || 'en',
  });
  const response = await fetchWithProxy(`/api/youtube/search?${params}`);
  let payload: YouTubeSearchPayload = {};
  try {
    payload = await response.json() as YouTubeSearchPayload;
  } catch {
    return { status: 'unavailable', mentions: [] };
  }
  if (response.status === 503 && payload.configured === false) {
    return { status: 'not_configured', mentions: [] };
  }
  if (!response.ok || !Array.isArray(payload.items)) {
    return { status: 'unavailable', mentions: [] };
  }
  const items = (payload.items as YouTubeSearchItem[]).flatMap((item) => {
    if (
      typeof item.videoId !== 'string'
      || typeof item.title !== 'string'
      || typeof item.channelTitle !== 'string'
      || typeof item.publishedAt !== 'string'
    ) return [];
    return [{
      sourceName: item.channelTitle,
      title: item.title,
      link: `https://www.youtube.com/watch?v=${item.videoId}`,
      publishedAt: parseDate(item.publishedAt),
      searchText: `${item.title} ${typeof item.description === 'string' ? item.description : ''} ${item.channelTitle}`,
    }];
  });
  return { status: 'ready', mentions: collectExternalMentions(monitors, 'youtube', items) };
}

export async function fetchYouTubeMentions(
  monitors: Monitor[],
  options: { language?: string; force?: boolean } = {},
): Promise<YouTubeMentionResult> {
  const language = options.language || 'en';
  const key = `${language}:${buildYouTubeSearchQuery(monitors)}`;
  if (!options.force && youtubeCache?.key === key && Date.now() - youtubeCache.fetchedAt < YOUTUBE_CACHE_TTL_MS) {
    return youtubeCache.value;
  }
  if (!options.force && youtubeInFlight?.key === key) return youtubeInFlight.promise;
  const promise = requestYouTubeMentions(monitors, language)
    .then((result) => {
      youtubeCache = { key, fetchedAt: Date.now(), value: result };
      return result;
    })
    .finally(() => {
      if (youtubeInFlight?.key === key) youtubeInFlight = null;
    });
  youtubeInFlight = { key, promise };
  return promise;
}
