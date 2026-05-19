import type { SystemStats } from './types';

function Gauge({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="gauge">
      <span className="gauge__label">{label}</span>
      <span className={`gauge__value${accent ? ' gauge__value--accent' : ''}`}>
        {value}
      </span>
    </div>
  );
}

export function SystemStrip({ stats }: { stats: SystemStats | null }) {
  const d = '—';
  const live = stats !== null;
  return (
    <div className="strip">
      <div className={`strip__sig${live ? ' strip__sig--live' : ''}`}>
        <span className="strip__dot" />
        {live ? 'ONLINE' : 'LINKING'}
      </div>
      <div className="strip__gauges">
        <Gauge label="Containers" value={live ? String(stats.workers) : d} accent />
        <Gauge label="Browsers" value={live ? String(stats.browsers) : d} accent />
        <Gauge label="Tabs / req" value={live ? String(stats.tabsPerRequest) : d} />
        <Gauge label="Queued" value={live ? String(stats.queue.waiting) : d} />
        <Gauge label="Active" value={live ? String(stats.queue.active) : d} />
      </div>
    </div>
  );
}
