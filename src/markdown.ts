/** HTML -> Markdown conversion (turndown wrapper). */
import TurndownService from 'turndown';

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  emDelimiter: '*',
});

/** Convert an HTML fragment (Grok's answer element) to Markdown. */
export function htmlToMarkdown(html: string): string {
  return turndown.turndown(html).trim();
}
