'use client';

/**
 * /prompts — read-only viewer of the AI prompt version history
 * (prompt_versions table). Two prompts today: 'trade-commentary' (the
 * battle-tested narration contract) and 'auto-trader' (the execution
 * doctrine, which composes the same battle-tested writing blocks).
 * Pick a version to read the exact text that was/is running.
 */

import { Loader2, RefreshCw, ScrollText } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

interface VersionMeta {
  key: string;
  version: number;
  createdAt: string;
  chars: number;
}

const KEY_LABELS: Record<string, string> = {
  'trade-commentary': 'Trade Commentary (battle-tested narrator)',
  'auto-trader': 'Auto Trader (execution doctrine)',
};

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' });
}

export default function PromptsPage() {
  const [versions, setVersions] = useState<VersionMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ key: string; version: number } | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [textLoading, setTextLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/prompts', { cache: 'no-store' });
      const data = (await res.json()) as { success: boolean; versions?: VersionMeta[]; error?: string };
      if (data.success && data.versions) {
        setVersions(data.versions);
        setError(null);
      } else {
        setError(data.error ?? 'failed to load');
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let stopped = false;
    const kick = setTimeout(() => {
      if (!stopped) void load();
    }, 0);
    return () => {
      stopped = true;
      clearTimeout(kick);
    };
  }, [load]);

  const view = useCallback(async (key: string, version: number) => {
    setSelected({ key, version });
    setTextLoading(true);
    setText(null);
    try {
      const res = await fetch(`/api/prompts?key=${encodeURIComponent(key)}&version=${version}`, { cache: 'no-store' });
      const data = (await res.json()) as { success: boolean; text?: string; error?: string };
      setText(data.success ? (data.text ?? '') : `Error: ${data.error ?? 'failed'}`);
    } catch (err) {
      setText(`Error: ${(err as Error).message}`);
    } finally {
      setTextLoading(false);
    }
  }, []);

  const keys = [...new Set(versions.map((v) => v.key))];

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4">
      <div className="flex items-center gap-2">
        <ScrollText className="size-5" />
        <h1 className="text-lg font-bold">AI Prompts</h1>
        <span className="text-xs text-muted-foreground">
          Version history — a new version is recorded automatically whenever a prompt changes in code.
        </span>
        <button
          type="button"
          onClick={() => void load()}
          className="ml-auto rounded border border-border p-1.5 hover:bg-muted"
          title="Refresh"
        >
          {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
        </button>
      </div>

      {error && (
        <div className="rounded-md border border-red-500/50 bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {keys.map((key) => {
        const rows = versions.filter((v) => v.key === key);
        const latest = rows[0]?.version;
        return (
          <section key={key} className="rounded-lg border border-border bg-card p-4">
            <h2 className="text-sm font-bold">{KEY_LABELS[key] ?? key}</h2>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              key <code className="rounded bg-muted px-1">{key}</code> · {rows.length} version(s) · latest v{latest}
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {rows.map((v) => {
                const active = selected?.key === key && selected.version === v.version;
                return (
                  <button
                    key={v.version}
                    type="button"
                    onClick={() => void view(key, v.version)}
                    title={`${fmtDate(v.createdAt)} · ${v.chars.toLocaleString('en-IN')} chars`}
                    className={`rounded border px-2.5 py-1 text-xs font-medium ${
                      active
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-border bg-background hover:bg-muted'
                    }`}
                  >
                    v{v.version}
                    {v.version === latest && <span className="ml-1 opacity-70">(current)</span>}
                  </button>
                );
              })}
            </div>
            {selected?.key === key && (
              <div className="mt-3">
                {textLoading ? (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" /> loading v{selected.version}…
                  </div>
                ) : (
                  text != null && (
                    <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/40 p-3 text-[11px] leading-relaxed">
                      {text}
                    </pre>
                  )
                )}
              </div>
            )}
          </section>
        );
      })}

      {!loading && keys.length === 0 && !error && (
        <p className="text-sm text-muted-foreground">No prompts recorded yet.</p>
      )}
    </div>
  );
}
