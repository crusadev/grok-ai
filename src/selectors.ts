/**
 * grok.com selectors, as prioritized candidate lists.
 *
 * The primary selectors below were verified against the live grok.com guest
 * UI (2026-05-19). Any list can be overridden at runtime via the matching
 * SELECTOR_* env var — overrides are tried before the defaults.
 */
import config, { SelectorKey } from './config';

const DEFAULTS: Record<SelectorKey, string[]> = {
  // The guest prompt composer.
  promptInput: [
    'textarea[aria-label*="Ask" i]',
    'textarea',
    'div[contenteditable="true"]',
  ],
  // The submit/send control next to the composer.
  sendButton: [
    'button[data-testid="chat-submit"]',
    'button[aria-label="Submit" i]',
    'form button[type="submit"]',
  ],
  // The assistant answer bubble. Note: the user's own message uses
  // [data-testid="user-message"] with the same inner markup, so the assistant
  // testid must be matched exactly to avoid grabbing the prompt echo.
  answerMessage: ['[data-testid="assistant-message"]'],
  // The rendered answer content inside an answer bubble (no "Thought for…" UI).
  answerContent: ['.response-content-markdown'],
  // The "Stop" control shown while the answer streams (best guess — unverified).
  stopButton: ['button[aria-label*="Stop" i]', 'button[data-testid*="stop" i]'],
  // Controls that appear once streaming has finished.
  completionMarker: [
    'button[aria-label*="Regenerate" i]',
    'button[aria-label*="Copy" i]',
  ],
  // Citation/source anchors inside an answer message.
  sourceLinks: ['a[href^="http"]'],
  // A separate sources/citations panel, if Grok renders one outside the bubble.
  sourcesPanel: [
    '[data-testid*="source" i]',
    '[data-testid*="citation" i]',
    '[class*="citation" i]',
  ],
};

/**
 * Resolve a selector candidate list: env overrides first (highest priority),
 * then the built-in defaults as fallback.
 */
export function getSelectors(key: SelectorKey): string[] {
  const overrides = config.selectorOverrides[key];
  return overrides.length > 0 ? [...overrides, ...DEFAULTS[key]] : [...DEFAULTS[key]];
}

/** Combine a selector list into a single CSS selector (comma-joined). */
export function combined(key: SelectorKey): string {
  return getSelectors(key).join(', ');
}

/** Visible-text markers for the Grok guest sign-up wall (lowercase). */
export const SIGNUP_WALL_PHRASES = [
  'sign up to keep chatting',
  'really high demand',
  'signing up gives you higher priority',
];

/** Visible-text markers for a Cloudflare / bot challenge (lowercase). */
export const CLOUDFLARE_PHRASES = [
  'just a moment',
  'verifying you are human',
  'attention required',
  'checking your browser',
  'enable javascript and cookies to continue',
];
