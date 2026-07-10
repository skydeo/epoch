// Reusable loading / error / empty states for cards and tables. Later phases
// (tables) should reuse these so every async surface looks the same.

export function Spinner({ label = "Loading…" }: { label?: string }) {
  return (
    <div
      role="status"
      className="flex items-center justify-center gap-2.5 py-10 text-[13px] text-ink-3"
    >
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-line border-t-primary" />
      <span>{label}</span>
    </div>
  );
}

export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-3 py-10 text-center">
      <div className="rounded-field bg-danger-soft px-3.5 py-2 text-[13px] font-medium text-danger">
        {message}
      </div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="rounded-field border border-line-strong bg-surface-2 px-4 py-2 text-[13px] font-semibold text-ink"
        >
          Retry
        </button>
      )}
    </div>
  );
}

export function EmptyState({ message }: { message: string }) {
  return (
    <div className="py-10 text-center text-[13px] text-ink-3">{message}</div>
  );
}
