/** Shared request/response and internal types. */

/** What extra formats the caller wants returned alongside `text`. */
export interface IncludeOptions {
  html: boolean;
  markdown: boolean;
}

/** A validated incoming scrape request. */
export interface ScrapeRequest {
  prompt: string;
  /** 2-letter ISO country code, lowercased. Drives the proxy country. */
  country: string;
  include: IncludeOptions;
}

/** The extracted Grok answer. */
export interface GrokResult {
  text: string;
  sources: string[];
  html?: string;
  markdown?: string;
}

/** Lifecycle status of an async scrape job. */
export type JobStatus = 'processing' | 'success' | 'failed';

/** Payload carried on the BullMQ scrape queue. */
export interface ScrapeJobData {
  publicId: string;
  request: ScrapeRequest;
}

/** Per-job attempt statistics. */
export interface JobStats {
  attempts: number;
  wallHits: number;
}

/** A scrape job row (no answer bodies) — used for the history list. */
export interface JobSummary {
  publicId: string;
  prompt: string;
  country: string;
  status: JobStatus;
  /** ISO timestamp the job was enqueued. */
  createdAt: string;
  /** Worker pickup → answer, in ms (null until finished). */
  scrapeMs: number | null;
  /** Enqueue → answer, in ms (null until finished). */
  totalMs: number | null;
  attempts: number | null;
  wallHits: number | null;
  error?: string;
}

/** A full scrape job — the summary plus the extracted answer. */
export interface JobRecord extends JobSummary {
  result?: GrokResult;
}

/** Aggregate metrics across all jobs. */
export interface Analytics {
  total: number;
  success: number;
  failed: number;
  processing: number;
  /** Percentage (0–100) of finished jobs that succeeded. */
  successRate: number;
  avgScrapeMs: number | null;
  avgTotalMs: number | null;
}

/** Live operational stats. */
export interface SystemStats {
  workers: number;
  browsers: number;
  tabsPerRequest: number;
  queue: { waiting: number; active: number };
}
