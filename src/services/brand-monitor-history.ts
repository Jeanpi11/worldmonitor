import type { MonitorMention } from './brand-monitor';
import { mergeMentionHistory } from './brand-monitor';

const HISTORY_KEY = 'worldmonitor-brand-mention-history-v1';

export function loadMonitorMentionHistory(): MonitorMention[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? mergeMentionHistory([], parsed as MonitorMention[]) : [];
  } catch {
    return [];
  }
}

export function saveMonitorMentionHistory(mentions: MonitorMention[]): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(mergeMentionHistory([], mentions)));
  } catch {
    // Private mode or a full storage quota should not break live monitoring.
  }
}

export function removeMonitorMentionHistory(monitorId: string): MonitorMention[] {
  const remaining = loadMonitorMentionHistory().filter((mention) => mention.monitorId !== monitorId);
  saveMonitorMentionHistory(remaining);
  return remaining;
}
