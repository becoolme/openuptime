/** Grey placeholder rows shown in a table while its data is still loading, so a slow request never looks like an empty list. */
export function SkeletonRows({ cols, rows = 5 }: { cols: number; rows?: number }) {
  return (
    <div role="status" aria-busy="true" aria-live="polite">
      {Array.from({ length: rows }, (_, r) => (
        <div className="tr" key={r} aria-hidden="true">
          {Array.from({ length: cols }, (_, c) => <span key={c}><i className="sk" style={{ width: c === 0 ? "62%" : "70%" }} /></span>)}
        </div>
      ))}
    </div>
  );
}
