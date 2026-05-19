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

/** Response body returned by POST /scrape. */
export interface ScrapeResponse {
  success: boolean;
  result?: GrokResult;
  error?: string;
}

/** Options for a single Grok automation attempt. */
export interface GrokAttemptOptions {
  prompt: string;
  proxyUrl: string;
  include: IncludeOptions;
}
