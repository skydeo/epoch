// Shared toast — success/error notices used by Settings save and Import confirm
// (HANDOFF §7). A tiny context provider mounts one fixed stack; call `useToast()`
// and fire `toast.success(msg)` / `toast.error(msg)`. Toasts auto-dismiss.

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

type ToastKind = "success" | "error";

interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastApi {
  success: (message: string) => void;
  error: (message: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const remove = useCallback((id: number) => {
    setItems((xs) => xs.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (kind: ToastKind, message: string) => {
      const id = nextId.current++;
      setItems((xs) => [...xs, { id, kind, message }]);
      // Errors linger a little longer so they can be read.
      window.setTimeout(() => remove(id), kind === "error" ? 6000 : 3500);
    },
    [remove],
  );

  const api = useMemo<ToastApi>(
    () => ({
      success: (m) => push("success", m),
      error: (m) => push("error", m),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed bottom-[calc(80px+env(safe-area-inset-bottom))] right-3 left-3 z-50 items-end min-[900px]:bottom-5 min-[900px]:left-auto min-[900px]:right-5 flex flex-col gap-2.5"
      >
        {items.map((t) => (
          <div
            key={t.id}
            role="status"
            onClick={() => remove(t.id)}
            className="pointer-events-auto flex max-w-[360px] cursor-pointer items-start gap-2.5 rounded-tile border px-4 py-3 text-[13.5px] font-medium shadow-[var(--shadow)] animate-epfade"
            style={
              t.kind === "success"
                ? {
                    borderColor: "var(--mint)",
                    background: "var(--teal-soft)",
                    color: "var(--mint)",
                  }
                : {
                    borderColor: "var(--danger)",
                    background: "var(--danger-soft)",
                    color: "var(--danger)",
                  }
            }
          >
            <span className="mt-[3px] h-2 w-2 flex-none rounded-full bg-current" />
            <span>{t.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within <ToastProvider>");
  return ctx;
}
