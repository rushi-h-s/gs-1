"use client";

import { useCallback, useState } from "react";

type FileStatus = "pending" | "uploading" | "done" | "duplicate" | "error";

export interface FileState {
  file: File;
  status: FileStatus;
  error?: string;
}

const CONCURRENCY = 5;

export function useInvoiceBatchUpload(clientId: string, period: string) {
  const [files, setFiles] = useState<FileState[]>([]);
  const [running, setRunning] = useState(false);

  const start = useCallback(
    async (selected: File[]) => {
      const initial: FileState[] = selected.map((file) => ({ file, status: "pending" }));
      setFiles(initial);
      setRunning(true);

      let cursor = 0;

      async function worker() {
        while (cursor < initial.length) {
          const idx = cursor++;
          const item = initial[idx];

          setFiles((prev) =>
            prev.map((f, i) => (i === idx ? { ...f, status: "uploading" } : f)),
          );

          try {
            const fd = new FormData();
            fd.append("files", item.file);
            fd.append("client_id", clientId);
            fd.append("period", period);

            const res = await fetch("/api/invoices/upload", { method: "POST", body: fd });
            const body = await res.json();
            // Success body is an array with one entry per file; error body is { error }
            const result = Array.isArray(body) ? body[0] : undefined;

            let status: FileStatus = "done";
            let error: string | undefined;

            if (!res.ok) {
              status = "error";
              error = result?.error ?? (body as { error?: string })?.error ?? `HTTP ${res.status}`;
            } else if (result?.skipped) {
              status = "duplicate";
            } else if (result?.error) {
              status = "error";
              error = result.error;
            }

            setFiles((prev) =>
              prev.map((f, i) => (i === idx ? { ...f, status, error } : f)),
            );
          } catch (err) {
            setFiles((prev) =>
              prev.map((f, i) =>
                i === idx ? { ...f, status: "error", error: String(err) } : f,
              ),
            );
          }
        }
      }

      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      setRunning(false);
    },
    [clientId, period],
  );

  const counts = files.reduce(
    (acc, f) => { acc[f.status] = (acc[f.status] ?? 0) + 1; return acc; },
    {} as Record<FileStatus, number>,
  );

  return { files, counts, running, start };
}
