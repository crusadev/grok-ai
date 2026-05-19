import type { Analytics, JobDetail, JobSummary, SystemStats } from './types';

/** All API calls go through `/api`, proxied to the backend (Vite dev or nginx). */
const BASE = '/api';

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

export interface SubmitInput {
  prompt: string;
  country: string;
  html: boolean;
  markdown: boolean;
}

export async function submitScrape(input: SubmitInput): Promise<string> {
  const res = await fetch(`${BASE}/scrape`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: input.prompt,
      country: input.country,
      include: { html: input.html, markdown: input.markdown },
    }),
  });
  const body = (await res.json()) as { success: boolean; public_id?: string; error?: string };
  if (!res.ok || !body.success || !body.public_id) {
    throw new Error(body.error || `submit failed (HTTP ${res.status})`);
  }
  return body.public_id;
}

export const getScrape = (publicId: string): Promise<JobDetail> =>
  getJson<JobDetail>(`/scrape/${publicId}`);

export const listScrapes = (
  opts: { limit?: number; offset?: number } = {},
): Promise<{ jobs: JobSummary[] }> => {
  const params = new URLSearchParams();
  params.set('limit', String(opts.limit ?? 100));
  if (opts.offset) params.set('offset', String(opts.offset));
  return getJson<{ jobs: JobSummary[] }>(`/scrapes?${params.toString()}`);
};

export const getAnalytics = (): Promise<Analytics> => getJson<Analytics>('/analytics');

export const getStats = (): Promise<SystemStats> => getJson<SystemStats>('/stats');

/** Server-pushed event types — must mirror src/events.ts on the backend. */
export interface JobEvent {
  type: 'job';
  summary: JobSummary;
}
export interface StatsEvent {
  type: 'stats';
  workers: number;
  tabsPerRequest: number;
  queue: { waiting: number; active: number };
}
export type AppEvent = JobEvent | StatsEvent;

/**
 * Subscribe to the SSE event stream. The browser's EventSource auto-reconnects
 * on transient drops (the server sends `retry: 3000`), so we don't manage that
 * ourselves. Returns a `close()` to tear down on unmount.
 */
export function subscribeEvents(onEvent: (event: AppEvent) => void): () => void {
  const es = new EventSource(`${BASE}/events`);
  es.onmessage = (msg) => {
    try {
      onEvent(JSON.parse(msg.data) as AppEvent);
    } catch {
      /* malformed frame — ignore */
    }
  };
  return () => es.close();
}
