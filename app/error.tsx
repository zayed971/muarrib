'use client';

export default function Error({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="wrap">
      <div className="error-page">
        <h1>مُعرِّب — Something went wrong</h1>
        <p>
          The app hit an unexpected error while running in your browser. Your PDF was never
          uploaded — nothing was sent or lost. Reloading usually fixes this.
        </p>
        <div className="error-actions">
          <button type="button" className="btn primary" onClick={() => reset()}>Try again</button>
          <button type="button" className="btn ghost" onClick={() => window.location.reload()}>Reload page</button>
        </div>
      </div>
    </div>
  );
}
