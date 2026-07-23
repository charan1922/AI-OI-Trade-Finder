'use client';

import { useEffect, useMemo, useState } from 'react';
import { Loader2, RotateCcw, Settings2 } from 'lucide-react';

import { ReadOnlyBanner } from '@/components/read-only-banner';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { DEFAULT_SETTINGS as AT_DEFAULTS } from '@/lib/auto-trade/config';
import { useRole } from '@/lib/auth/use-role';
import { cn } from '@/lib/utils';

interface ToggleState {
  key: string;
  label: string;
  description: string;
  category: string;
  default: boolean;
  value: boolean;
  updatedAt: string | null;
}

interface NumberState {
  key: string;
  label: string;
  description: string;
  category: string;
  default: number;
  min: number;
  max: number;
  value: number;
  updatedAt: string | null;
}

/** Time-of-day settings (IST minutes from midnight) get an HH:MM editor
 *  instead of a ±1 stepper. Heuristic: key ends in _MIN and the range sits in
 *  clock territory (min ≥ 06:00) — matches the WINDOW_ and COMMENTARY_ time
 *  keys and nothing else registered today. */
function isClockSetting(n: NumberState): boolean {
  return n.key.endsWith('_MIN') && n.min >= 6 * 60;
}

const toHHMM = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/**
 * The AUTO-TRADE order clock (entryStartMin/entryEndMin/squareOffMin from
 * lib/auto-trade/settings.ts) rendered here alongside the scanner window so
 * every time-of-day setting lives on ONE page (moved off /auto-trade
 * 2026-07-17 — it duplicated this card visually and confused which clock was
 * which). Values are stored in auto_trade_settings, NOT feature_toggles:
 * saves go to POST /api/auto-trade/settings (HH:MM form, parsed server-side).
 * The pseudo-keys end in _MIN so the shared ClockInput renderer picks them up.
 */
const AT_CLOCK_DEFS = [
  {
    key: 'AUTO_TRADE_ENTRY_START_MIN',
    settingKey: 'entryStartMin',
    label: 'Auto-trade entries open',
    min: 9 * 60 + 30,
    max: 12 * 60,
    description:
      'When the auto-trader may START placing entry orders (paper or real), default 09:45 — 5 minutes after the scan window opens, so the first picks have one settled cycle behind them. This clock controls ORDERS; the scan window above only controls suggestions.',
  },
  {
    key: 'AUTO_TRADE_ENTRY_END_MIN',
    settingKey: 'entryEndMin',
    label: 'Auto-trade entries close',
    min: 10 * 60,
    max: 14 * 60 + 30,
    description:
      'The last time the auto-trader may place a NEW entry order (default 11:00). Exits and stop management keep running all day regardless.',
  },
  {
    key: 'AUTO_TRADE_SQUARE_OFF_MIN',
    settingKey: 'squareOffMin',
    label: 'Auto-trade square-off',
    min: 14 * 60,
    max: 15 * 60 + 20,
    description:
      'Everything still open is force-closed at this time (default 15:12). Enforced in code — brokers auto-close intraday positions around 15:26 with a penalty, so we exit first.',
  },
] as const;

export default function ConfigPage() {
  const [toggles, setToggles] = useState<ToggleState[]>([]);
  const [numbers, setNumbers] = useState<NumberState[]>([]);
  const [atNumbers, setAtNumbers] = useState<NumberState[]>([]);
  /** Bypass switches that are ON but inert because their parent rule is OFF.
   *  Computed server-side (the builder sits next to a prisma import). */
  const [warnings, setWarnings] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { readOnly } = useRole();

  useEffect(() => {
    fetch('/api/config/toggles')
      .then((r) => r.json())
      .then((d) => {
        if (d.success) {
          setToggles(d.data);
          setNumbers(d.numbers ?? []);
          setWarnings(d.warnings ?? []);
        } else setError(d.error ?? 'Failed to load');
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
    // Auto-trade clock (see AT_CLOCK_DEFS). Best-effort: if the feed is
    // unavailable the rest of the page still works, those rows just don't show.
    fetch('/api/auto-trade', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => {
        const s = d?.settings as Record<string, number> | undefined;
        if (!d?.success || !s) return;
        setAtNumbers(
          AT_CLOCK_DEFS.map((def) => ({
            key: def.key,
            label: def.label,
            description: def.description,
            category: 'Entry & Exit Times',
            default: AT_DEFAULTS[def.settingKey],
            min: def.min,
            max: def.max,
            value: s[def.settingKey] ?? AT_DEFAULTS[def.settingKey],
            updatedAt: null,
          }))
        );
      })
      .catch(() => {});
  }, []);

  async function save(key: string, value: boolean | number, revert: () => void) {
    setSaving(key);
    setError(null);
    try {
      const res = await fetch('/api/config/toggles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value }),
      });
      const d = await res.json();
      if (d.success) {
        setToggles(d.data);
        setNumbers(d.numbers ?? []);
        setWarnings(d.warnings ?? []);
      } else {
        setError(d.error ?? 'Failed to save');
        revert();
      }
    } catch (e) {
      setError(String(e));
      revert();
    } finally {
      setSaving(null);
    }
  }

  function flip(key: string, value: boolean) {
    const before = toggles;
    setToggles((prev) => prev.map((t) => (t.key === key ? { ...t, value } : t))); // optimistic
    void save(key, value, () => setToggles(before));
  }

  /** Auto-trade clock rows save to the auto-trade settings store, not the
   *  feature-toggles table — HH:MM form, exactly what /auto-trade used to send. */
  async function saveAt(key: string, minutes: number, revert: () => void) {
    const def = AT_CLOCK_DEFS.find((d) => d.key === key);
    if (!def) return;
    setSaving(key);
    setError(null);
    try {
      const res = await fetch('/api/auto-trade/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: def.settingKey, value: toHHMM(minutes) }),
      });
      const d = await res.json();
      if (!d.success) {
        setError(d.error ?? 'Failed to save');
        revert();
      }
    } catch (e) {
      setError(String(e));
      revert();
    } finally {
      setSaving(null);
    }
  }

  function step(key: string, value: number) {
    if (key.startsWith('AUTO_TRADE_')) {
      const before = atNumbers;
      setAtNumbers((prev) => prev.map((n) => (n.key === key ? { ...n, value } : n))); // optimistic
      void saveAt(key, value, () => setAtNumbers(before));
      return;
    }
    const before = numbers;
    setNumbers((prev) => prev.map((n) => (n.key === key ? { ...n, value } : n))); // optimistic
    void save(key, value, () => setNumbers(before));
  }

  const allNumbers = useMemo(() => [...numbers, ...atNumbers], [numbers, atNumbers]);
  const categories = useMemo(
    () => [...new Set([...toggles.map((t) => t.category), ...allNumbers.map((n) => n.category)])],
    [toggles, allNumbers]
  );
  const overriddenCount =
    toggles.filter((t) => t.value !== t.default).length + allNumbers.filter((n) => n.value !== n.default).length;

  return (
    <TooltipProvider delayDuration={150}>
      <div className="mx-auto max-w-7xl p-3 sm:p-4">
        <header className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
              <Settings2 className="size-5 text-muted-foreground" /> Configuration
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Runtime settings — changes save instantly and apply from the next scan, no restart needed.
            </p>
          </div>
          {!loading && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="rounded-md border border-border bg-card px-2 py-1 tabular-nums">
                {toggles.length + allNumbers.length} settings
              </span>
              <span
                className={cn(
                  'rounded-md border px-2 py-1 tabular-nums',
                  overriddenCount > 0
                    ? 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400'
                    : 'border-border bg-card'
                )}
              >
                {overriddenCount} overridden
              </span>
            </div>
          )}
        </header>

        <ReadOnlyBanner note="Toggle and setting changes need the operator login." />

        {loading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </div>
        )}

        {error && (
          <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {/* A switch that is ON but unreachable because the rule it hangs off is
            OFF. This is NOT drift — both halves can sit at their own defaults —
            so the "overridden" count never catches it, and the row below reads
            as a live permission that is not running. */}
        {warnings.length > 0 && (
          <div className="mb-4 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
            <p className="font-semibold text-amber-700 dark:text-amber-400">
              {warnings.length === 1 ? 'A switch is ON but doing nothing' : `${warnings.length} switches are ON but doing nothing`}
            </p>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-[12px] text-muted-foreground">
              {warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </div>
        )}

        {!loading && toggles.length === 0 && allNumbers.length === 0 && !error && (
          <p className="text-sm text-muted-foreground">No settings registered.</p>
        )}

        {/* Category cards in a responsive grid — 1 col mobile, 2 from lg, 3 from xl
            so the whole set fits one viewport on a wide screen. */}
        <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
          {categories.map((cat) => {
            const catToggles = toggles.filter((t) => t.category === cat);
            const catNumbers = allNumbers.filter((n) => n.category === cat);
            const catOverridden =
              catToggles.filter((t) => t.value !== t.default).length +
              catNumbers.filter((n) => n.value !== n.default).length;
            return (
              <section key={cat} className="flex flex-col overflow-hidden rounded-xl border border-border bg-card">
                <header className="flex items-center justify-between border-b border-border bg-muted/40 px-3 py-1.5">
                  <h2 className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">{cat}</h2>
                  <span className="text-[10px] text-muted-foreground tabular-nums">
                    {catToggles.length + catNumbers.length} settings
                    {catOverridden > 0 && (
                      <span className="ml-1.5 text-amber-600 dark:text-amber-400">· {catOverridden} overridden</span>
                    )}
                  </span>
                </header>
                <div className="divide-y divide-border">
                  {catToggles.map((t) => (
                    <SettingRow
                      key={t.key}
                      label={t.label}
                      settingKey={t.key}
                      description={t.description}
                      overridden={t.value !== t.default}
                      onReset={readOnly || t.value === t.default ? undefined : () => flip(t.key, t.default)}
                      control={
                        <Switch
                          checked={t.value}
                          disabled={saving === t.key || readOnly}
                          onChange={(v) => flip(t.key, v)}
                          label={t.label}
                        />
                      }
                    />
                  ))}
                  {catNumbers.map((n) => (
                    <SettingRow
                      key={n.key}
                      label={n.label}
                      settingKey={n.key}
                      description={n.description}
                      overridden={n.value !== n.default}
                      meta={
                        isClockSetting(n)
                          ? `default ${toHHMM(n.default)} · range ${toHHMM(n.min)}–${toHHMM(n.max)}`
                          : `default ${n.default} · range ${n.min}–${n.max}`
                      }
                      onReset={readOnly || n.value === n.default ? undefined : () => step(n.key, n.default)}
                      control={
                        isClockSetting(n) ? (
                          <ClockInput
                            value={n.value}
                            min={n.min}
                            max={n.max}
                            disabled={saving === n.key || readOnly}
                            onCommit={(v) => step(n.key, v)}
                            label={n.label}
                          />
                        ) : (
                          <Stepper
                            value={n.value}
                            min={n.min}
                            max={n.max}
                            disabled={saving === n.key || readOnly}
                            onChange={(v) => step(n.key, v)}
                            label={n.label}
                          />
                        )
                      }
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </TooltipProvider>
  );
}

/** One setting row: name + always-visible description (clamped, full text on
 *  hover) on the left, the control on the right, reset when overridden. */
function SettingRow({
  label,
  settingKey,
  description,
  overridden,
  meta,
  onReset,
  control,
}: {
  label: string;
  settingKey: string;
  description: string;
  overridden: boolean;
  meta?: string;
  onReset?: () => void;
  control: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 px-3 py-1.5">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[13px] font-medium">{label}</span>
          {overridden && (
            <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-500/15 dark:text-amber-400">
              overridden
            </span>
          )}
          {onReset && (
            <button
              type="button"
              onClick={onReset}
              title="Reset to default"
              aria-label={`Reset ${label} to default`}
              className="text-muted-foreground/60 transition-colors hover:text-foreground"
            >
              <RotateCcw className="size-3" />
            </button>
          )}
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <p className="mt-0.5 line-clamp-1 cursor-default text-[11px] leading-snug text-muted-foreground">
              {description}
            </p>
          </TooltipTrigger>
          <TooltipContent className="max-w-sm leading-relaxed whitespace-normal">{description}</TooltipContent>
        </Tooltip>
        <div className="mt-0.5 flex flex-wrap items-center gap-2">
          <code className="font-mono text-[10px] text-muted-foreground/70">{settingKey}</code>
          {meta && <span className="text-[10px] text-muted-foreground/70">{meta}</span>}
        </div>
      </div>
      <div className="shrink-0 pt-0.5">{control}</div>
    </div>
  );
}

/** HH:MM editor for IST clock settings (stored as minutes from midnight).
 *  Commits on blur/Enter; malformed or out-of-range snaps back. */
function ClockInput({
  value,
  min,
  max,
  disabled,
  onCommit,
  label,
}: {
  value: number;
  min: number;
  max: number;
  disabled?: boolean;
  onCommit: (minutes: number) => void;
  label: string;
}) {
  const [draft, setDraft] = useState(toHHMM(value));
  const [synced, setSynced] = useState(value);
  if (synced !== value) {
    setSynced(value);
    setDraft(toHHMM(value));
  }
  const commit = () => {
    const m = draft.trim().match(/^(\d{1,2}):(\d{2})$/);
    const minutes = m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
    if (Number.isFinite(minutes) && minutes >= min && minutes <= max && minutes !== value) onCommit(minutes);
    else setDraft(toHHMM(value));
  };
  return (
    <input
      type="text"
      inputMode="numeric"
      aria-label={label}
      placeholder="HH:MM"
      value={draft}
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
      className="w-16 rounded border border-border bg-background px-1.5 py-1 text-right font-mono text-sm tabular-nums focus:border-primary focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
    />
  );
}

/** Lightweight − / value / + stepper for numeric settings. */
function Stepper({
  value,
  min,
  max,
  disabled,
  onChange,
  label,
}: {
  value: number;
  min: number;
  max: number;
  disabled?: boolean;
  onChange: (v: number) => void;
  label: string;
}) {
  const btn =
    'flex size-6 items-center justify-center rounded border text-sm leading-none transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40';
  return (
    <div className="flex shrink-0 items-center gap-2" aria-label={label}>
      <button type="button" className={btn} disabled={disabled || value <= min} onClick={() => onChange(value - 1)}>
        −
      </button>
      <span className="w-6 text-center font-mono text-sm tabular-nums">{value}</span>
      <button type="button" className={btn} disabled={disabled || value >= max} onClick={() => onChange(value + 1)}>
        +
      </button>
    </div>
  );
}

/** Lightweight toggle switch — no extra dependency. */
function Switch({
  checked,
  disabled,
  onChange,
  label,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors',
        'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none',
        'disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-primary' : 'bg-input'
      )}
    >
      <span
        className={cn(
          'inline-block size-5 transform rounded-full bg-background shadow transition-transform',
          checked ? 'translate-x-[22px]' : 'translate-x-0.5'
        )}
      />
    </button>
  );
}
