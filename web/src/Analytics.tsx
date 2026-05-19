import type { Analytics } from './types';
import { formatMs } from './format';

function Stat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div className="stat">
      <span className="stat__label">{label}</span>
      <span className="stat__value">{value}</span>
      <span className="stat__sub">{sub}</span>
    </div>
  );
}

export function AnalyticsPanel({ data }: { data: Analytics | null }): JSX.Element {
  const finished = data ? data.success + data.failed : 0;
  return (
    <div className="panel">
      <div className="panel__head">
        <span className="panel__tag">03</span> ANALYTICS
      </div>
      <div className="stats">
        <Stat
          label="Success rate"
          value={data ? `${data.successRate}%` : '—'}
          sub={data ? `${data.success} ok · ${data.failed} failed` : 'no data'}
        />
        <Stat
          label="Avg scrape"
          value={data ? formatMs(data.avgScrapeMs) : '—'}
          sub="worker → answer"
        />
        <Stat
          label="Requests"
          value={data ? String(data.total) : '—'}
          sub={data ? `${data.processing} in flight` : 'no data'}
        />
      </div>
      {data && finished > 0 && (
        <div className="ratebar" title={`${data.successRate}% success`}>
          <div className="ratebar__fill" style={{ width: `${data.successRate}%` }} />
        </div>
      )}
    </div>
  );
}
