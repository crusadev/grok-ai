import { useEffect, useState } from 'react';
import type { JobDetail } from './types';
import { formatElapsed, formatMs, hostOf } from './format';

export interface ActiveJobState {
  publicId: string;
  prompt: string;
  country: string;
  submittedAt: number;
  detail: JobDetail | null;
}

/** Live "5 tabs racing" animation with an elapsed timer. */
function RacingLoader({ submittedAt, tabs }: { submittedAt: number; tabs: number }): JSX.Element {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="loader">
      <div className="loader__timer">{formatElapsed(now - submittedAt)}</div>
      <div className="loader__lanes">
        {Array.from({ length: tabs }, (_v, i) => (
          <div className="lane" key={i}>
            <span className="lane__id">TAB·{String(i + 1).padStart(2, '0')}</span>
            <div className="lane__track">
              <div className="lane__pulse" style={{ animationDelay: `${i * 0.26}s` }} />
            </div>
          </div>
        ))}
      </div>
      <div className="loader__caption">
        racing {tabs} proxied tabs — first answer wins
      </div>
    </div>
  );
}

function Metrics({ detail }: { detail: JobDetail }): JSX.Element {
  return (
    <div className="metrics">
      <div className="metric metric--hero">
        <span className="metric__label">Scrape time</span>
        <span className="metric__value">{formatMs(detail.scrapeMs)}</span>
      </div>
      <div className="metric">
        <span className="metric__label">Total round-trip</span>
        <span className="metric__value">{formatMs(detail.totalMs)}</span>
      </div>
      <div className="metric">
        <span className="metric__label">Wall hits</span>
        <span className="metric__value metric__value--wall">
          {detail.wallHits ?? '—'}
        </span>
      </div>
      <div className="metric">
        <span className="metric__label">Attempts</span>
        <span className="metric__value">{detail.attempts ?? '—'}</span>
      </div>
    </div>
  );
}

function Result({ detail }: { detail: JobDetail }): JSX.Element {
  const r = detail.result;
  return (
    <div className="result">
      <Metrics detail={detail} />
      {detail.status === 'failed' ? (
        <div className="result__error">
          <span className="result__error-tag">FAILED</span>
          {detail.error}
        </div>
      ) : (
        <>
          <div className="result__answer">{r?.text}</div>
          {r?.sources && r.sources.length > 0 && (
            <div className="result__sources">
              <span className="result__sources-label">
                {r.sources.length} source{r.sources.length === 1 ? '' : 's'}
              </span>
              <div className="result__sources-list">
                {r.sources.map((s) => (
                  <a key={s} href={s} target="_blank" rel="noreferrer">
                    {hostOf(s)}
                  </a>
                ))}
              </div>
            </div>
          )}
          {r?.markdown && (
            <details className="result__raw">
              <summary>Markdown</summary>
              <pre>{r.markdown}</pre>
            </details>
          )}
          {r?.html && (
            <details className="result__raw">
              <summary>HTML</summary>
              <pre>{r.html}</pre>
            </details>
          )}
        </>
      )}
    </div>
  );
}

export function ActiveJob({
  job,
  tabs,
}: {
  job: ActiveJobState | null;
  tabs: number;
}): JSX.Element {
  if (!job) {
    return (
      <div className="panel active">
        <div className="panel__head">
          <span className="panel__tag">02</span> ACTIVE REQUEST
        </div>
        <p className="active__idle">Standing by — dispatch a request above.</p>
      </div>
    );
  }
  const status = job.detail?.status ?? 'processing';
  return (
    <div className="panel active">
      <div className="panel__head">
        <span className="panel__tag">02</span> ACTIVE REQUEST
        <span className={`badge badge--${status}`}>{status}</span>
      </div>
      <div className="active__prompt">
        <span className="active__quote">{job.prompt}</span>
        <span className="active__country">{job.country.toUpperCase()}</span>
      </div>
      {status === 'processing' ? (
        <RacingLoader submittedAt={job.submittedAt} tabs={tabs} />
      ) : (
        <Result detail={job.detail as JobDetail} />
      )}
    </div>
  );
}
