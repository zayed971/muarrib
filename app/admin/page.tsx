'use client';

import { useState, useCallback } from 'react';
import type { MetricsSnapshot } from '@/lib/metrics';

interface MetricsResponse {
  all: MetricsSnapshot;
  today: MetricsSnapshot;
}

function fmtPct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(n < 1 ? 4 : 2)}`;
}

function StatCard({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`stat-card${accent ? ' accent' : ''}`}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

export default function AdminPage() {
  const [token, setToken] = useState('');
  const [data, setData] = useState<MetricsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/metrics?token=${encodeURIComponent(token)}`);
      if (!res.ok) {
        setError(res.status === 401 ? 'Invalid token.' : `Error ${res.status}`);
        setData(null);
        return;
      }
      setData((await res.json()) as MetricsResponse);
    } catch {
      setError('Could not reach /api/metrics.');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [token]);

  return (
    <div className="wrap admin-page">
      <header>
        <div className="brand">
          <span className="mark">مُعرِّب</span>
          <h1><span className="latin-name">Muʿarrib</span> — Admin</h1>
        </div>
        <p className="tagline">Live usage and cost metrics.</p>
      </header>

      <div className="admin-token-row">
        <input
          type="password"
          className="key-input"
          placeholder="Admin token"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && load()}
        />
        <button className="btn primary" onClick={load} disabled={loading || !token}>
          {loading ? 'Loading…' : 'Load metrics'}
        </button>
      </div>

      {error && <p className="number-warning">{error}</p>}

      {data && (
        <>
          <section className="admin-section">
            <h2 className="admin-section-title">All time</h2>
            <div className="admin-grid">
              <StatCard label="Total pages translated" value={data.all.pages.toLocaleString()} accent />
              <StatCard label="Cache hit-rate" value={fmtPct(data.all.cacheHitRate)} accent />
              <StatCard label="Estimated cost" value={fmtUsd(data.all.estimatedCostUsd)} accent />
              <StatCard label="Errors" value={data.all.errors.toLocaleString()} />
            </div>
          </section>

          <section className="admin-section">
            <h2 className="admin-section-title">Today (UTC)</h2>
            <div className="admin-grid">
              <StatCard label="Pages translated today" value={data.today.pages.toLocaleString()} accent />
              <StatCard label="Cache hit-rate today" value={fmtPct(data.today.cacheHitRate)} />
              <StatCard label="Estimated cost today" value={fmtUsd(data.today.estimatedCostUsd)} />
            </div>
          </section>

          <section className="admin-section">
            <h2 className="admin-section-title">By provider (all time)</h2>
            <div className="admin-grid">
              {Object.entries(data.all.byProvider).map(([provider, n]) => (
                <StatCard key={provider} label={provider} value={n.toLocaleString()} />
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
