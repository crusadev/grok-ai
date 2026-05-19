/**
 * Typed error hierarchy. Each error carries:
 *  - `retryable`: whether scrape.ts should retry the attempt with a fresh proxy IP.
 *  - `httpStatus`: the status the HTTP layer returns when this error is final.
 *  - `code`: a short machine-readable tag for logs.
 */

export type ErrorCode =
  | 'BAD_REQUEST'
  | 'SIGNUP_WALL'
  | 'CLOUDFLARE'
  | 'TIMEOUT'
  | 'NAVIGATION'
  | 'EXTRACTION'
  | 'OVERLOADED'
  | 'CONFIG';

export class AppError extends Error {
  readonly retryable: boolean;
  readonly httpStatus: number;
  readonly code: ErrorCode;

  constructor(
    code: ErrorCode,
    message: string,
    opts: { retryable: boolean; httpStatus: number },
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.retryable = opts.retryable;
    this.httpStatus = opts.httpStatus;
  }
}

/** Invalid input — never retried, surfaced as HTTP 400. */
export class BadRequestError extends AppError {
  constructor(message: string) {
    super('BAD_REQUEST', message, { retryable: false, httpStatus: 400 });
  }
}

/** Grok showed the "Sign up to keep chatting" wall — retry from a fresh IP. */
export class SignupWallError extends AppError {
  constructor(message = 'Grok guest sign-up wall encountered') {
    super('SIGNUP_WALL', message, { retryable: true, httpStatus: 502 });
  }
}

/** A Cloudflare / bot challenge blocked the page — retry from a fresh IP. */
export class CloudflareError extends AppError {
  constructor(message = 'Cloudflare challenge encountered') {
    super('CLOUDFLARE', message, { retryable: true, httpStatus: 502 });
  }
}

/** A wait (navigation or answer streaming) exceeded its timeout — retryable. */
export class TimeoutError extends AppError {
  constructor(message: string) {
    super('TIMEOUT', message, { retryable: true, httpStatus: 502 });
  }
}

/** Navigation / connection / proxy failure — retryable. */
export class NavigationError extends AppError {
  constructor(message: string) {
    super('NAVIGATION', message, { retryable: true, httpStatus: 502 });
  }
}

/** Could not locate/extract the expected DOM — retryable (may be transient). */
export class ExtractionError extends AppError {
  constructor(message: string) {
    super('EXTRACTION', message, { retryable: true, httpStatus: 502 });
  }
}

/** Server is at capacity — not retried, surfaced as HTTP 503. */
export class OverloadedError extends AppError {
  constructor(message = 'Server is at capacity, try again later') {
    super('OVERLOADED', message, { retryable: false, httpStatus: 503 });
  }
}

/** Configuration/startup error — not retryable. */
export class ConfigError extends AppError {
  constructor(message: string) {
    super('CONFIG', message, { retryable: false, httpStatus: 500 });
  }
}
