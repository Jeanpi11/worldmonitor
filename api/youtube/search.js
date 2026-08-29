import { getCorsHeaders, isDisallowedOrigin } from '../_cors.js';
import { checkRateLimit } from '../_rate-limit.js';
import { jsonResponse } from '../_json-response.js';

export const config = { runtime: 'edge' };

const RATE_LIMIT_SCOPE = 'youtube-mention-search';
const RATE_LIMIT_PER_MINUTE = 10;
const MAX_QUERY_LENGTH = 450;
const MAX_RESULTS = 50;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;
const LANGUAGE_TAG = /^[a-z]{2,3}(?:-[a-z]{2,4})?$/i;

function normalizeQuery(value) {
  if (typeof value !== 'string') return '';
  return value.normalize('NFC').replace(CONTROL_CHARACTERS, ' ').replace(/\s+/g, ' ').trim();
}

function normalizePublishedAfter(value) {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  const now = Date.now();
  if (parsed > now + 60_000 || parsed < now - 31 * 24 * 60 * 60 * 1000) return null;
  return new Date(parsed).toISOString();
}

function safeText(value, maxLength = 500) {
  return typeof value === 'string'
    ? value.normalize('NFC').replace(CONTROL_CHARACTERS, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength)
    : '';
}

function normalizeItems(payload) {
  if (!Array.isArray(payload?.items)) return [];
  return payload.items.flatMap((item) => {
    const videoId = safeText(item?.id?.videoId, 11);
    const title = safeText(item?.snippet?.title, 300);
    const channelTitle = safeText(item?.snippet?.channelTitle, 200);
    const publishedAt = safeText(item?.snippet?.publishedAt, 40);
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId) || !title || !channelTitle || !publishedAt) return [];
    return [{
      videoId,
      title,
      description: safeText(item?.snippet?.description, 500),
      channelTitle,
      publishedAt,
    }];
  });
}

export const _internal = {
  normalizeItems,
  normalizePublishedAfter,
  normalizeQuery,
};

export default async function handler(request, ctx) {
  const cors = getCorsHeaders(request, 'GET, OPTIONS');
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'GET') return jsonResponse({ error: 'Method not allowed' }, 405, cors);
  if (isDisallowedOrigin(request)) return jsonResponse({ error: 'Origin not allowed' }, 403, cors);

  const limited = await checkRateLimit(request, cors, {
    ctx,
    scope: RATE_LIMIT_SCOPE,
    limit: RATE_LIMIT_PER_MINUTE,
    window: '60 s',
  });
  if (limited) return limited;

  const requestUrl = new URL(request.url);
  const query = normalizeQuery(requestUrl.searchParams.get('query'));
  if (!query || query.length > MAX_QUERY_LENGTH || !/[\p{L}\p{N}]/u.test(query)) {
    return jsonResponse({ error: 'Invalid query' }, 400, cors);
  }

  const rawPublishedAfter = requestUrl.searchParams.get('publishedAfter');
  const publishedAfter = normalizePublishedAfter(rawPublishedAfter);
  if (rawPublishedAfter && !publishedAfter) {
    return jsonResponse({ error: 'Invalid publishedAfter' }, 400, cors);
  }

  const relevanceLanguage = requestUrl.searchParams.get('relevanceLanguage') || '';
  if (relevanceLanguage && !LANGUAGE_TAG.test(relevanceLanguage)) {
    return jsonResponse({ error: 'Invalid relevanceLanguage' }, 400, cors);
  }

  const requestedMax = Number.parseInt(requestUrl.searchParams.get('maxResults') || '25', 10);
  const maxResults = Number.isFinite(requestedMax)
    ? Math.max(1, Math.min(MAX_RESULTS, requestedMax))
    : 25;
  const apiKey = process.env.YOUTUBE_DATA_API_KEY?.trim();
  if (!apiKey) {
    return jsonResponse({
      error: 'YOUTUBE_API_KEY_MISSING',
      configured: false,
      items: [],
    }, 503, { ...cors, 'Cache-Control': 'no-store' });
  }

  const upstreamUrl = new URL('https://www.googleapis.com/youtube/v3/search');
  upstreamUrl.searchParams.set('part', 'snippet');
  upstreamUrl.searchParams.set('type', 'video');
  upstreamUrl.searchParams.set('order', 'date');
  upstreamUrl.searchParams.set('safeSearch', 'moderate');
  upstreamUrl.searchParams.set('maxResults', String(maxResults));
  upstreamUrl.searchParams.set('q', query);
  upstreamUrl.searchParams.set('key', apiKey);
  if (publishedAfter) upstreamUrl.searchParams.set('publishedAfter', publishedAfter);
  if (relevanceLanguage) upstreamUrl.searchParams.set('relevanceLanguage', relevanceLanguage);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(upstreamUrl, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'WorldMonitor-Brand-Monitor/1.0',
      },
    });
    if (!response.ok) {
      return jsonResponse({ error: 'YOUTUBE_SEARCH_FAILED', configured: true, items: [] }, 502, {
        ...cors,
        'Cache-Control': 'no-store',
      });
    }
    const payload = await response.json();
    return jsonResponse({ configured: true, items: normalizeItems(payload) }, 200, {
      ...cors,
      'Cache-Control': 'public, max-age=900, s-maxage=1800, stale-while-revalidate=300',
      Vary: 'Origin',
    });
  } catch {
    return jsonResponse({ error: 'YOUTUBE_SEARCH_UNAVAILABLE', configured: true, items: [] }, 502, {
      ...cors,
      'Cache-Control': 'no-store',
    });
  } finally {
    clearTimeout(timeout);
  }
}
