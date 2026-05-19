/** API types — mirror the JSON the Grok-scraper backend emits. */

export type JobStatus = 'processing' | 'success' | 'failed';

export interface GrokResult {
  text: string;
  sources: string[];
  html?: string;
  markdown?: string;
}

/** GET /scrape/:public_id */
export interface JobDetail {
  success: boolean;
  public_id: string;
  status: JobStatus;
  createdAt: string;
  scrapeMs: number | null;
  totalMs: number | null;
  attempts: number | null;
  wallHits: number | null;
  result?: GrokResult;
  error?: string;
}

/** A row from GET /scrapes */
export interface JobSummary {
  publicId: string;
  prompt: string;
  country: string;
  status: JobStatus;
  createdAt: string;
  scrapeMs: number | null;
  totalMs: number | null;
  attempts: number | null;
  wallHits: number | null;
  error?: string;
}

/** GET /analytics */
export interface Analytics {
  total: number;
  success: number;
  failed: number;
  processing: number;
  successRate: number;
  avgScrapeMs: number | null;
  avgTotalMs: number | null;
}

/** GET /stats */
export interface SystemStats {
  workers: number;
  browsers: number;
  tabsPerRequest: number;
  queue: { waiting: number; active: number };
}
