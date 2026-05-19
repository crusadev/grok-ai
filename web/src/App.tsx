import { useCallback, useEffect, useState } from 'react';
import type { Analytics, JobSummary, SystemStats } from './types';
import {
  getAnalytics,
  getScrape,
  listScrapes,
  submitScrape,
  subscribeEvents,
  type SubmitInput,
} from './api';
import { SystemStrip } from './SystemStrip';
import { SubmitPanel } from './SubmitPanel';
import { ActiveJob, type ActiveJobState } from './ActiveJob';
import { AnalyticsPanel } from './Analytics';
import { History } from './History';

function Header(): JSX.Element {
  return (
    <header className="header">
      <div className="header__mark">
        <span className="header__glyph">▚▚</span>
        <h1 className="header__title">GROK SCRAPER</h1>
      </div>
      <span className="header__sub">PROXY-RACE CONTROL CONSOLE</span>
    </header>
  );
}

const PAGE_SIZE = 25;

/**
 * Merge a single job update into the current page, preserving created_at-desc
 * order. Returns the same array reference when the update is irrelevant to the
 * current page, so React skips the re-render.
 */
function mergeHistory(
  prev: JobSummary[],
  incoming: JobSummary,
  page: number,
  pageSize: number,
): JobSummary[] {
  const idx = prev.findIndex((j) => j.publicId === incoming.publicId);
  if (idx >= 0) {
    // In-place update — never reorder, just overwrite the row.
    const next = prev.slice();
    next[idx] = incoming;
    return next;
  }
  // A fresh job. It always belongs at the top of page 1; on later pages it
  // would force a re-paginate, which the user does explicitly via Next/Prev.
  if (page !== 1) return prev;
  const next = [incoming, ...prev];
  if (next.length > pageSize) next.length = pageSize;
  return next;
}

export function App(): JSX.Element {
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [history, setHistory] = useState<JobSummary[]>([]);
  const [historyPage, setHistoryPage] = useState(1);
  const [active, setActive] = useState<ActiveJobState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reloadAnalytics = useCallback((): void => {
    getAnalytics()
      .then(setAnalytics)
      .catch(() => undefined);
  }, []);

  // Fetch the current page on mount and whenever the user pages forward/back.
  useEffect(() => {
    let cancelled = false;
    listScrapes({ limit: PAGE_SIZE, offset: (historyPage - 1) * PAGE_SIZE })
      .then((r) => {
        if (!cancelled) setHistory(r.jobs);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [historyPage]);

  // One analytics snapshot up front; SSE drives refreshes after that.
  useEffect(() => {
    reloadAnalytics();
  }, [reloadAnalytics]);

  // Single SSE subscription drives stats, history, active job, and analytics.
  // Replaces the 4 s stats poll and the 1.5 s job poll.
  useEffect(() => {
    const close = subscribeEvents((event) => {
      if (event.type === 'stats') {
        setStats({
          workers: event.workers,
          // One reused browser per worker process — workers and browsers track 1:1.
          browsers: event.workers,
          tabsPerRequest: event.tabsPerRequest,
          queue: event.queue,
        });
        return;
      }
      // event.type === 'job'
      const summary = event.summary;
      setHistory((prev) => mergeHistory(prev, summary, historyPage, PAGE_SIZE));
      setActive((cur) => {
        if (!cur || cur.publicId !== summary.publicId) return cur;
        const detail = {
          success: summary.status === 'success',
          public_id: summary.publicId,
          status: summary.status,
          createdAt: summary.createdAt,
          scrapeMs: summary.scrapeMs,
          totalMs: summary.totalMs,
          attempts: summary.attempts,
          wallHits: summary.wallHits,
          error: summary.error,
        };
        return { ...cur, detail };
      });
      if (summary.status !== 'processing') {
        reloadAnalytics();
      }
    });
    return close;
  }, [historyPage, reloadAnalytics]);

  // When the active job finishes, fetch the answer body once (events carry
  // the summary, not text/sources/html/markdown).
  const activeId = active?.publicId;
  const activeStatus = active?.detail?.status;
  const activeHasBody = !!active?.detail?.result;
  useEffect(() => {
    if (!activeId || activeStatus !== 'success' || activeHasBody) return;
    let cancelled = false;
    getScrape(activeId)
      .then((detail) => {
        if (cancelled) return;
        setActive((cur) =>
          cur && cur.publicId === activeId ? { ...cur, detail } : cur,
        );
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [activeId, activeStatus, activeHasBody]);

  const submit = async (input: SubmitInput): Promise<void> => {
    setError(null);
    try {
      const publicId = await submitScrape(input);
      // Bouncing the user back to page 1 makes their newly-submitted job
      // immediately visible in History without them having to navigate.
      if (historyPage !== 1) setHistoryPage(1);
      setActive({
        publicId,
        prompt: input.prompt,
        country: input.country,
        submittedAt: Date.now(),
        detail: null,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'submit failed');
    }
  };

  const busy =
    active !== null && (!active.detail || active.detail.status === 'processing');

  return (
    <div className="app">
      <Header />
      <SystemStrip stats={stats} />
      <main className="grid">
        <div className="col">
          <SubmitPanel onSubmit={submit} busy={busy} />
          {error && <div className="banner banner--error">⚠ {error}</div>}
          <ActiveJob job={active} tabs={stats?.tabsPerRequest ?? 5} />
        </div>
        <div className="col">
          <AnalyticsPanel data={analytics} />
          <History
            jobs={history}
            page={historyPage}
            pageSize={PAGE_SIZE}
            totalCount={analytics?.total ?? 0}
            onPageChange={setHistoryPage}
          />
        </div>
      </main>
    </div>
  );
}
