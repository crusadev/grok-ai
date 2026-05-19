import { useState } from 'react';
import type { JobDetail, JobSummary } from './types';
import { getScrape } from './api';
import { formatClock, formatMs, hostOf } from './format';

function HistoryRow({ job }: { job: JobSummary }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<JobDetail | null>(null);

  const toggle = async (): Promise<void> => {
    const next = !open;
    setOpen(next);
    if (next && !detail && job.status === 'success') {
      try {
        setDetail(await getScrape(job.publicId));
      } catch {
        /* leave detail null — the summary still shows */
      }
    }
  };

  const sources = detail?.result?.sources ?? [];

  return (
    <div className={`row row--${job.status}${open ? ' row--open' : ''}`}>
      <button className="row__head" onClick={toggle} type="button">
        <span className={`row__led row__led--${job.status}`} />
        <span className="row__prompt">{job.prompt}</span>
        <span className="row__country">{job.country.toUpperCase()}</span>
        <span className="row__walls" title="sign-up wall hits">
          ▚ {job.wallHits ?? 0}
        </span>
        <span className="row__time">{formatMs(job.scrapeMs)}</span>
      </button>
      {open && (
        <div className="row__body">
          <div className="row__meta">
            {formatClock(job.createdAt)} &nbsp;·&nbsp; total {formatMs(job.totalMs)}{' '}
            &nbsp;·&nbsp; {job.attempts ?? 0} attempts &nbsp;·&nbsp;{' '}
            {job.wallHits ?? 0} wall hits
          </div>
          {job.status === 'failed' && job.error && (
            <div className="row__error">{job.error}</div>
          )}
          {detail?.result && <div className="row__answer">{detail.result.text}</div>}
          {sources.length > 0 && (
            <div className="result__sources">
              <span className="result__sources-label">
                {sources.length} source{sources.length === 1 ? '' : 's'}
              </span>
              <div className="result__sources-list">
                {sources.map((s) => (
                  <a key={s} href={s} target="_blank" rel="noreferrer">
                    {hostOf(s)}
                  </a>
                ))}
              </div>
            </div>
          )}
          {job.status === 'success' && !detail && (
            <div className="row__loading">loading answer…</div>
          )}
          {job.status === 'processing' && (
            <div className="row__loading">still processing…</div>
          )}
        </div>
      )}
    </div>
  );
}

export interface HistoryProps {
  jobs: JobSummary[];
  page: number;
  pageSize: number;
  totalCount: number;
  onPageChange: (page: number) => void;
}

export function History({
  jobs,
  page,
  pageSize,
  totalCount,
  onPageChange,
}: HistoryProps): JSX.Element {
  // Total count can lag the live stream — clamp pageCount to >= current page so
  // the indicator never reads "Page 3 of 2" while SSE catches up.
  const lastPage = Math.max(1, Math.ceil(totalCount / pageSize), page);
  const canPrev = page > 1;
  const canNext = page < lastPage;

  return (
    <div className="panel">
      <div className="panel__head">
        <span className="panel__tag">04</span> HISTORY
        <span className="panel__count">{totalCount}</span>
      </div>
      <div className="history">
        {jobs.length === 0 ? (
          <p className="history__empty">No requests logged yet.</p>
        ) : (
          jobs.map((j) => <HistoryRow key={j.publicId} job={j} />)
        )}
      </div>
      <div className="pager">
        <button
          className="pager__btn"
          type="button"
          onClick={() => onPageChange(page - 1)}
          disabled={!canPrev}
        >
          ◂ PREV
        </button>
        <span className="pager__label">
          PAGE {page} / {lastPage}
        </span>
        <button
          className="pager__btn"
          type="button"
          onClick={() => onPageChange(page + 1)}
          disabled={!canNext}
        >
          NEXT ▸
        </button>
      </div>
    </div>
  );
}
