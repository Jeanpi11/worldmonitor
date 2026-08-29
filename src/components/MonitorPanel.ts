import { Panel } from './Panel';
import { t, getCurrentLanguage } from '@/services/i18n';
import type { Monitor, NewsItem } from '@/types';
import { MONITOR_COLORS } from '@/config';
import { generateId, formatTime, getCSSColor } from '@/utils';
import { sanitizeUrl } from '@/utils/sanitize';
import { h, replaceChildren } from '@/utils/dom-utils';
import {
  collectNewsMentions,
  mergeMentionHistory,
  monitorDisplayName,
  normalizeMonitor,
  parseMonitorTerms,
  type MonitorMention,
} from '@/services/brand-monitor';
import {
  loadMonitorMentionHistory,
  removeMonitorMentionHistory,
  saveMonitorMentionHistory,
} from '@/services/brand-monitor-history';
import {
  fetchGoogleNewsMentions,
  fetchYouTubeMentions,
  type YouTubeMentionResult,
} from '@/services/brand-monitor-sources';

type RemoteStatus = 'idle' | 'ready' | 'unavailable';

export class MonitorPanel extends Panel {
  private monitors: Monitor[] = [];
  private latestNews: NewsItem[] = [];
  private mentionHistory: MonitorMention[] = [];
  private onMonitorsChange?: (monitors: Monitor[]) => void;
  private nameInput!: HTMLInputElement;
  private keywordsInput!: HTMLInputElement;
  private exclusionsInput!: HTMLInputElement;
  private monitorsList!: HTMLElement;
  private results!: HTMLElement;
  private refreshButton!: HTMLButtonElement;
  private isRefreshing = false;
  private refreshGeneration = 0;
  private webStatus: RemoteStatus = 'idle';
  private youtubeStatus: YouTubeMentionResult['status'] | 'idle' = 'idle';

  constructor(initialMonitors: Monitor[] = []) {
    super({ id: 'monitors', title: t('panels.monitors'), infoTooltip: t('components.monitors.infoTooltip') });
    this.monitors = initialMonitors.map(normalizeMonitor).filter((monitor) => monitor.keywords.length > 0);
    this.mentionHistory = this.activeHistory(loadMonitorMentionHistory());
    this.renderInput();
    this.renderMonitorsList();
    this.renderResultsContent();
  }

  private renderInput(): void {
    this.nameInput = h('input', {
      type: 'text',
      className: 'monitor-input',
      placeholder: t('components.monitor.namePlaceholder'),
      'aria-label': t('components.monitor.namePlaceholder'),
    }) as HTMLInputElement;
    this.keywordsInput = h('input', {
      type: 'text',
      className: 'monitor-input',
      placeholder: t('components.monitor.placeholder'),
      'aria-label': t('components.monitor.placeholder'),
      onKeypress: (event: Event) => {
        if ((event as KeyboardEvent).key === 'Enter') this.addMonitor();
      },
    }) as HTMLInputElement;
    this.exclusionsInput = h('input', {
      type: 'text',
      className: 'monitor-input',
      placeholder: t('components.monitor.exclusionsPlaceholder'),
      'aria-label': t('components.monitor.exclusionsPlaceholder'),
    }) as HTMLInputElement;

    const inputContainer = h('div', { className: 'monitor-input-container' },
      h('div', { className: 'monitor-form-grid' },
        h('label', { className: 'monitor-field' },
          h('span', { className: 'monitor-field-label' }, t('components.monitor.nameLabel')),
          this.nameInput,
        ),
        h('label', { className: 'monitor-field' },
          h('span', { className: 'monitor-field-label' }, t('components.monitor.keywordsLabel')),
          this.keywordsInput,
        ),
        h('label', { className: 'monitor-field' },
          h('span', { className: 'monitor-field-label' }, t('components.monitor.exclusionsLabel')),
          this.exclusionsInput,
        ),
      ),
      h('div', { className: 'monitor-actions' },
        h('button', { className: 'monitor-add-btn', onClick: () => this.addMonitor() },
          t('components.monitor.add'),
        ),
        this.refreshButton = h('button', {
          className: 'monitor-refresh-btn',
          onClick: () => void this.refreshRemoteMentions(true),
        }, t('components.monitor.refresh')) as HTMLButtonElement,
      ),
    );

    this.monitorsList = h('div', { className: 'monitors-list' });
    this.results = h('div', { className: 'monitors-results' });
    this.setContentNodes(inputContainer, this.monitorsList, this.results);
  }

  private addMonitor(): void {
    const keywords = parseMonitorTerms(this.keywordsInput.value);
    if (keywords.length === 0) {
      this.keywordsInput.focus();
      return;
    }

    const monitor: Monitor = normalizeMonitor({
      id: generateId(),
      name: this.nameInput.value.trim() || keywords[0],
      keywords,
      excludedKeywords: parseMonitorTerms(this.exclusionsInput.value),
      createdAt: Date.now(),
      color: MONITOR_COLORS[this.monitors.length % MONITOR_COLORS.length] ?? getCSSColor('--status-live'),
    });

    this.monitors.push(monitor);
    this.nameInput.value = '';
    this.keywordsInput.value = '';
    this.exclusionsInput.value = '';
    this.onMonitorsChange?.(this.monitors);
    this.absorbNewsMentions();
    this.renderMonitorsList();
    this.renderResultsContent();
    void this.refreshRemoteMentions(true);
  }

  public removeMonitor(id: string): void {
    this.refreshGeneration += 1;
    this.isRefreshing = false;
    this.monitors = this.monitors.filter((monitor) => monitor.id !== id);
    this.mentionHistory = this.activeHistory(removeMonitorMentionHistory(id));
    this.onMonitorsChange?.(this.monitors);
    this.renderMonitorsList();
    this.renderResultsContent();
    if (this.monitors.length > 0) void this.refreshRemoteMentions(true);
  }

  private renderMonitorsList(): void {
    replaceChildren(this.monitorsList,
      ...this.monitors.map((monitor) => {
        const exclusions = monitor.excludedKeywords?.length
          ? ` · ${t('components.monitor.excluding', { terms: monitor.excludedKeywords.join(', ') })}`
          : '';
        const name = monitorDisplayName(monitor);
        return h('span', { className: 'monitor-tag' },
          h('span', {
            className: 'monitor-tag-color',
            style: { backgroundColor: this.monitorColor(monitor) },
          }),
          h('span', { className: 'monitor-tag-copy' },
            h('strong', {}, name),
            h('small', {}, `${monitor.keywords.join(', ')}${exclusions}`),
          ),
          h('button', {
            className: 'monitor-tag-remove',
            type: 'button',
            'aria-label': t('components.monitor.remove', { name }),
            onClick: () => this.removeMonitor(monitor.id),
          }, '×'),
        );
      }),
    );
  }

  private monitorColor(monitor: Monitor): string {
    return /^#[0-9a-f]{6}$/i.test(monitor.color)
      ? monitor.color
      : getCSSColor('--status-live');
  }

  private activeHistory(mentions: MonitorMention[]): MonitorMention[] {
    const activeIds = new Set(this.monitors.map((monitor) => monitor.id));
    return mentions.filter((mention) => activeIds.has(mention.monitorId));
  }

  private absorbNewsMentions(): void {
    this.mentionHistory = this.activeHistory(mergeMentionHistory(
      this.mentionHistory,
      collectNewsMentions(this.latestNews, this.monitors),
    ));
    saveMonitorMentionHistory(this.mentionHistory);
  }

  public renderResults(news: NewsItem[]): void {
    this.latestNews = news;
    this.absorbNewsMentions();
    this.renderResultsContent();
    if (this.monitors.length > 0) void this.refreshRemoteMentions(false);
  }

  private renderResultsContent(): void {
    if (!this.results) return;
    this.refreshButton.textContent = this.isRefreshing
      ? t('components.monitor.refreshing')
      : t('components.monitor.refresh');
    if (this.isRefreshing) this.refreshButton.setAttribute('disabled', '');
    else this.refreshButton.removeAttribute('disabled');

    if (this.monitors.length === 0) {
      replaceChildren(this.results,
        h('div', { className: 'monitor-empty' }, t('components.monitor.addKeywords')),
      );
      return;
    }

    const summaries = this.monitors.map((monitor) => {
      const mentions = this.mentionHistory.filter((mention) => mention.monitorId === monitor.id);
      const counts = {
        news: mentions.filter((mention) => mention.source === 'news').length,
        web: mentions.filter((mention) => mention.source === 'web').length,
        youtube: mentions.filter((mention) => mention.source === 'youtube').length,
      };
      return h('div', {
        className: 'monitor-summary-card',
        style: { borderLeftColor: this.monitorColor(monitor) },
      },
        h('strong', {}, monitorDisplayName(monitor)),
        h('div', { className: 'monitor-summary-counts' },
          h('span', {}, t('components.monitor.newsCount', { count: String(counts.news) })),
          h('span', {}, t('components.monitor.webCount', { count: String(counts.web) })),
          h('span', {}, t('components.monitor.youtubeCount', { count: String(counts.youtube) })),
        ),
      );
    });

    const notices: HTMLElement[] = [];
    if (this.isRefreshing) {
      notices.push(h('div', { className: 'monitor-source-notice' }, t('components.monitor.refreshingSources')));
    }
    if (this.youtubeStatus === 'not_configured') {
      notices.push(h('div', { className: 'monitor-source-notice monitor-source-warning' },
        t('components.monitor.youtubeNotConfigured'),
      ));
    } else if (this.youtubeStatus === 'unavailable') {
      notices.push(h('div', { className: 'monitor-source-notice monitor-source-warning' },
        t('components.monitor.youtubeUnavailable'),
      ));
    }
    if (this.webStatus === 'unavailable') {
      notices.push(h('div', { className: 'monitor-source-notice monitor-source-warning' },
        t('components.monitor.webUnavailable'),
      ));
    }

    const mentions = this.activeHistory(this.mentionHistory);
    const countText = mentions.length > 40
      ? t('components.monitor.showingMatches', { count: '40', total: String(mentions.length) })
      : `${mentions.length} ${mentions.length === 1 ? t('components.monitor.match') : t('components.monitor.matches')}`;
    const monitorById = new Map(this.monitors.map((monitor) => [monitor.id, monitor]));
    const resultNodes = mentions.slice(0, 40).map((mention) => {
      const monitor = monitorById.get(mention.monitorId);
      const sourceLabel = t(`components.monitor.sources.${mention.source}`);
      return h('div', {
        className: 'monitor-result',
        style: { borderLeftColor: monitor ? this.monitorColor(monitor) : getCSSColor('--status-live') },
      },
        h('div', { className: 'monitor-result-heading' },
          h('span', { className: `monitor-source-badge monitor-source-${mention.source}` }, sourceLabel),
          h('span', { className: 'monitor-result-monitor' }, monitor ? monitorDisplayName(monitor) : ''),
        ),
        h('a', {
          className: 'item-title',
          href: sanitizeUrl(mention.link),
          target: '_blank',
          rel: 'noopener',
        }, mention.title),
        h('div', { className: 'item-time' },
          `${mention.sourceName} · ${formatTime(new Date(mention.publishedAt))} · “${mention.matchedKeyword}”`,
        ),
      );
    });

    replaceChildren(this.results,
      h('div', { className: 'monitor-summary-grid' }, ...summaries),
      ...notices,
      h('div', { className: 'monitor-result-count' }, countText),
      ...(resultNodes.length > 0
        ? resultNodes
        : [h('div', { className: 'monitor-empty' },
          t('components.monitor.noMatches', { count: String(this.latestNews.length) }),
        )]),
    );
  }

  private async refreshRemoteMentions(force: boolean): Promise<void> {
    if (this.monitors.length === 0 || (this.isRefreshing && !force)) return;
    const generation = ++this.refreshGeneration;
    this.isRefreshing = true;
    this.renderResultsContent();
    const language = getCurrentLanguage();
    const [webResult, youtubeResult] = await Promise.allSettled([
      fetchGoogleNewsMentions(this.monitors, { language, force }),
      fetchYouTubeMentions(this.monitors, { language, force }),
    ]);
    if (generation !== this.refreshGeneration) return;

    const incoming: MonitorMention[] = [];
    if (webResult.status === 'fulfilled') {
      this.webStatus = 'ready';
      incoming.push(...webResult.value);
    } else {
      this.webStatus = 'unavailable';
    }
    if (youtubeResult.status === 'fulfilled') {
      this.youtubeStatus = youtubeResult.value.status;
      incoming.push(...youtubeResult.value.mentions);
    } else {
      this.youtubeStatus = 'unavailable';
    }
    this.mentionHistory = this.activeHistory(mergeMentionHistory(this.mentionHistory, incoming));
    saveMonitorMentionHistory(this.mentionHistory);
    this.isRefreshing = false;
    this.renderResultsContent();
  }

  public onChanged(callback: (monitors: Monitor[]) => void): void {
    this.onMonitorsChange = callback;
  }

  public getMonitors(): Monitor[] {
    return [...this.monitors];
  }

  public setMonitors(monitors: Monitor[]): void {
    this.refreshGeneration += 1;
    this.isRefreshing = false;
    this.monitors = monitors.map(normalizeMonitor).filter((monitor) => monitor.keywords.length > 0);
    this.mentionHistory = this.activeHistory(loadMonitorMentionHistory());
    this.absorbNewsMentions();
    this.renderMonitorsList();
    this.renderResultsContent();
    if (this.monitors.length > 0) void this.refreshRemoteMentions(false);
  }
}
