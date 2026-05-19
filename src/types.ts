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

/** A scrape job as stored in / read back from the database. */
export interface JobRecord {
  publicId: string;
  status: JobStatus;
  result?: GrokResult;
  error?: string;
}
