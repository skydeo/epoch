import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { PageHeader } from "../components/PageHeader";
import { Button } from "../components/ui";
import { useToast } from "../components/Toast";
import { ApiError, api } from "../lib/api";
import { fmtG } from "../lib/format";
import type { ImportPreview } from "../types";

type Mode = "replace" | "merge";

const CSV_FORMAT: { title: string; body: string }[] = [
  {
    title: "Columns",
    body: "Date, Hours, Type, Reason, Requested (header row required).",
  },
  { title: "Dates", body: "ISO (2026-07-13) or US (7/13/2026)." },
  { title: "Type", body: "PTO or Personal Holiday (case-insensitive)." },
  {
    title: "Requested",
    body: "Yes/No or TRUE/FALSE — whether already entered in the HR system.",
  },
  {
    title: "0-hour rows",
    body: "Skipped automatically — the sheet pads ranges with weekend rows.",
  },
  {
    title: "Modes",
    body: "Replace-all is destructive but idempotent; Merge keeps existing rows and skips duplicates.",
  },
];

export function Import() {
  const qc = useQueryClient();
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);

  const [fileName, setFileName] = useState<string | null>(null);
  const [csvText, setCsvText] = useState<string>("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [mode, setMode] = useState<Mode>("replace");
  const [dragOver, setDragOver] = useState(false);

  const previewMut = useMutation({
    mutationFn: (file: File) => api.importPreview(file),
    onSuccess: (data) => setPreview(data),
    onError: (err) => {
      setPreview(null);
      toast.error(err instanceof ApiError ? err.message : "Could not read that CSV.");
    },
  });

  const confirmMut = useMutation({
    mutationFn: () => api.importConfirm({ csv_text: csvText, mode }),
    onSuccess: (res) => {
      toast.success(
        `Imported ${res.imported} row${res.imported === 1 ? "" : "s"}` +
          (res.skipped ? `, skipped ${res.skipped}` : "") +
          ` (${res.mode}).`,
      );
      // A wholesale usage change ripples through every query — invalidate all.
      qc.invalidateQueries();
      reset();
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : "Import failed."),
  });

  function reset() {
    setFileName(null);
    setCsvText("");
    setPreview(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  async function handleFile(file: File) {
    setFileName(file.name);
    setCsvText(await file.text());
    previewMut.mutate(file);
  }

  const canConfirm =
    !!preview && preview.count > 0 && !confirmMut.isPending && !previewMut.isPending;

  function confirmImport() {
    if (!preview) return;
    if (mode === "replace") {
      const ok = window.confirm(
        `Replace the entire usage log with ${preview.count} row(s)? ` +
          "This deletes all existing entries first.",
      );
      if (!ok) return;
    }
    confirmMut.mutate();
  }

  return (
    <section className="animate-epfade">
      <PageHeader
        title="Import / Export"
        blurb="Load the usage log from a CSV export of the sheet, or back up the current log in the same format."
      />

      <div className="mb-6 grid grid-cols-[repeat(auto-fit,minmax(min(100%,300px),1fr))] gap-4">
        {/* ===== Import card ===== */}
        <div className="rounded-card border border-line bg-surface p-[22px] shadow-[var(--shadow)]">
          <h2 className="mb-3.5 font-display text-base font-semibold">Import CSV</h2>

          <div
            role="button"
            tabIndex={0}
            onClick={() => inputRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                inputRef.current?.click();
              }
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const file = e.dataTransfer.files?.[0];
              if (file) handleFile(file);
            }}
            className="cursor-pointer rounded-[14px] border-2 border-dashed px-5 py-[34px] text-center transition-colors focus-visible:ring-2 focus-visible:ring-primary"
            style={{
              borderColor: dragOver ? "var(--primary)" : "var(--border-strong)",
              background: dragOver ? "var(--primary-soft)" : "var(--surface-2)",
            }}
          >
            <div className="mx-auto mb-3 flex h-[46px] w-[46px] items-center justify-center rounded-[13px] bg-primary-soft">
              <span
                className="mt-[-4px] h-4 w-4 border-b-[2.5px] border-l-[2.5px] border-primary"
                style={{ transform: "rotate(-45deg)" }}
              />
            </div>
            <div className="text-sm font-semibold">
              {fileName ? fileName : "Drop your CSV here"}
            </div>
            <div className="mt-1 text-[12.5px] text-ink-3">
              or click to browse — Date, Hours, Type, Reason, Requested
            </div>
            <input
              ref={inputRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleFile(file);
              }}
            />
          </div>

          {previewMut.isPending && (
            <div className="mt-4 text-[13px] text-ink-3">Reading CSV…</div>
          )}

          {preview && (
            <div className="mt-4">
              <div className="mb-3 flex flex-wrap items-center gap-2 text-[13.5px]">
                <span className="font-display font-bold text-primary">
                  {preview.count}
                </span>
                <span className="text-ink-2">
                  valid row{preview.count === 1 ? "" : "s"} ready to import
                </span>
                {preview.errors.length > 0 && (
                  <span className="text-danger">
                    · {preview.errors.length} error
                    {preview.errors.length === 1 ? "" : "s"}
                  </span>
                )}
              </div>

              {preview.errors.length > 0 && (
                <ul className="mb-3 max-h-40 list-disc overflow-auto rounded-field border border-danger bg-danger-soft px-5 py-2.5 text-[12.5px] text-danger">
                  {preview.errors.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              )}

              {preview.sample.length > 0 && (
                <div className="mb-3 overflow-x-auto rounded-field border border-line">
                  <table className="w-full text-left text-[12.5px]">
                    <thead className="bg-surface-2 text-[11px] uppercase tracking-[0.04em] text-ink-3">
                      <tr>
                        <th className="px-3 py-2 font-bold">Date</th>
                        <th className="px-3 py-2 text-right font-bold">Hours</th>
                        <th className="px-3 py-2 font-bold">Type</th>
                        <th className="px-3 py-2 font-bold">Reason</th>
                        <th className="px-3 py-2 font-bold">Req</th>
                      </tr>
                    </thead>
                    <tbody className="font-display tabular-nums">
                      {preview.sample.map((r, i) => (
                        <tr key={i} className="border-t border-line">
                          <td className="px-3 py-1.5">{r.date}</td>
                          <td className="px-3 py-1.5 text-right">{fmtG(r.hours)}</td>
                          <td className="px-3 py-1.5">
                            {r.type === "personal_holiday" ? "PH" : "PTO"}
                          </td>
                          <td className="px-3 py-1.5">{r.reason || "—"}</td>
                          <td className="px-3 py-1.5">{r.requested ? "Yes" : "No"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {preview.count > preview.sample.length && (
                    <div className="border-t border-line px-3 py-1.5 text-[11.5px] text-ink-3">
                      …and {preview.count - preview.sample.length} more
                    </div>
                  )}
                </div>
              )}

              {/* Mode + confirm */}
              <div className="mb-3 flex flex-wrap gap-4 text-[13px]">
                <label className="flex cursor-pointer items-center gap-2 font-medium text-ink-2">
                  <input
                    type="radio"
                    name="mode"
                    className="accent-primary"
                    checked={mode === "replace"}
                    onChange={() => setMode("replace")}
                  />
                  Replace all
                  <span className="text-[11.5px] text-danger">(destructive)</span>
                </label>
                <label className="flex cursor-pointer items-center gap-2 font-medium text-ink-2">
                  <input
                    type="radio"
                    name="mode"
                    className="accent-primary"
                    checked={mode === "merge"}
                    onChange={() => setMode("merge")}
                  />
                  Merge
                  <span className="text-[11.5px] text-ink-3">(skip duplicates)</span>
                </label>
              </div>

              <div className="flex gap-2.5">
                <Button onClick={confirmImport} disabled={!canConfirm}>
                  {confirmMut.isPending
                    ? "Importing…"
                    : mode === "replace"
                      ? "Replace log"
                      : "Merge rows"}
                </Button>
                <Button variant="ghost" onClick={reset}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* ===== Export card ===== */}
        <div className="rounded-card border border-line bg-surface p-[22px] shadow-[var(--shadow)]">
          <h2 className="mb-3.5 font-display text-base font-semibold">Export CSV</h2>
          <p className="mb-4 text-[13.5px] leading-[1.6] text-ink-2">
            Download the whole usage log in the import format — use it as a backup.
            Accruals are always recomputed, never exported.
          </p>
          <a
            href={api.exportUrl}
            download
            className="inline-flex cursor-pointer whitespace-nowrap rounded-[11px] border border-line-strong bg-surface-2 px-[18px] py-2.5 text-[13.5px] font-semibold text-ink focus-visible:ring-2 focus-visible:ring-primary"
          >
            Download usage_export.csv
          </a>
        </div>
      </div>

      {/* ===== CSV format reference ===== */}
      <div className="rounded-card border border-line bg-surface p-[22px] shadow-[var(--shadow)]">
        <h2 className="mb-3.5 font-display text-base font-semibold">CSV format</h2>
        <div className="flex flex-col gap-3">
          {CSV_FORMAT.map((f) => (
            <div key={f.title} className="flex items-start gap-3">
              <span className="mt-[7px] h-[7px] w-[7px] flex-none rounded-full bg-teal" />
              <div className="text-[13.5px] leading-[1.55] text-ink-2">
                <strong className="text-ink">{f.title}</strong> — {f.body}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
