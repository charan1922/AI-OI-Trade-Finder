"use client"

import { useEffect, useState } from "react"
import { Info, Loader2 } from "lucide-react"

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

interface ToggleState {
  key: string
  label: string
  description: string
  category: string
  default: boolean
  value: boolean
  updatedAt: string | null
}

interface NumberState {
  key: string
  label: string
  description: string
  category: string
  default: number
  min: number
  max: number
  value: number
  updatedAt: string | null
}

export default function ConfigPage() {
  const [toggles, setToggles] = useState<ToggleState[]>([])
  const [numbers, setNumbers] = useState<NumberState[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch("/api/config/toggles")
      .then((r) => r.json())
      .then((d) => {
        if (d.success) {
          setToggles(d.data)
          setNumbers(d.numbers ?? [])
        } else setError(d.error ?? "Failed to load")
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false))
  }, [])

  async function save(key: string, value: boolean | number, revert: () => void) {
    setSaving(key)
    setError(null)
    try {
      const res = await fetch("/api/config/toggles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value }),
      })
      const d = await res.json()
      if (d.success) {
        setToggles(d.data)
        setNumbers(d.numbers ?? [])
      } else {
        setError(d.error ?? "Failed to save")
        revert()
      }
    } catch (e) {
      setError(String(e))
      revert()
    } finally {
      setSaving(null)
    }
  }

  function flip(key: string, value: boolean) {
    const before = toggles
    setToggles((prev) => prev.map((t) => (t.key === key ? { ...t, value } : t))) // optimistic
    void save(key, value, () => setToggles(before))
  }

  function step(key: string, value: number) {
    const before = numbers
    setNumbers((prev) => prev.map((n) => (n.key === key ? { ...n, value } : n))) // optimistic
    void save(key, value, () => setNumbers(before))
  }

  const categories = [...new Set([...toggles.map((t) => t.category), ...numbers.map((n) => n.category)])]

  return (
    <TooltipProvider delayDuration={150}>
      <div className="mx-auto max-w-3xl p-6">
        <header className="mb-6">
          <h1 className="text-xl font-semibold tracking-tight">Feature Toggles</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Runtime on/off switches for the app. Changes save instantly and take effect on the next
            scan — no restart needed. Hover the <Info className="inline size-3.5 align-[-2px]" /> for what each does.
          </p>
        </header>

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

        {!loading && toggles.length === 0 && numbers.length === 0 && !error && (
          <p className="text-sm text-muted-foreground">No toggles registered.</p>
        )}

        {categories.map((cat) => (
          <section key={cat} className="mb-6">
            <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{cat}</h2>
            <div className="divide-y divide-border overflow-hidden rounded-lg border bg-card">
              {toggles
                .filter((t) => t.category === cat)
                .map((t) => (
                  <div key={t.key} className="flex items-start justify-between gap-4 p-4">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm font-medium">{t.label}</span>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              aria-label={`About ${t.label}`}
                              className="text-muted-foreground/70 transition-colors hover:text-foreground"
                            >
                              <Info className="size-3.5" />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-xs whitespace-normal leading-relaxed">
                            {t.description}
                          </TooltipContent>
                        </Tooltip>
                        {t.value !== t.default && (
                          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-500/15 dark:text-amber-400">
                            changed from default
                          </span>
                        )}
                      </div>
                      <code className="mt-0.5 block font-mono text-[11px] text-muted-foreground">{t.key}</code>
                    </div>
                    <Switch
                      checked={t.value}
                      disabled={saving === t.key}
                      onChange={(v) => flip(t.key, v)}
                      label={t.label}
                    />
                  </div>
                ))}
              {numbers
                .filter((n) => n.category === cat)
                .map((n) => (
                  <div key={n.key} className="flex items-start justify-between gap-4 p-4">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm font-medium">{n.label}</span>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              aria-label={`About ${n.label}`}
                              className="text-muted-foreground/70 transition-colors hover:text-foreground"
                            >
                              <Info className="size-3.5" />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-xs whitespace-normal leading-relaxed">
                            {n.description}
                          </TooltipContent>
                        </Tooltip>
                        {n.value !== n.default && (
                          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-500/15 dark:text-amber-400">
                            changed from default
                          </span>
                        )}
                      </div>
                      <code className="mt-0.5 block font-mono text-[11px] text-muted-foreground">{n.key}</code>
                    </div>
                    <Stepper
                      value={n.value}
                      min={n.min}
                      max={n.max}
                      disabled={saving === n.key}
                      onChange={(v) => step(n.key, v)}
                      label={n.label}
                    />
                  </div>
                ))}
            </div>
          </section>
        ))}
      </div>
    </TooltipProvider>
  )
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
  value: number
  min: number
  max: number
  disabled?: boolean
  onChange: (v: number) => void
  label: string
}) {
  const btn =
    "flex size-6 items-center justify-center rounded border text-sm leading-none transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
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
  )
}

/** Lightweight toggle switch — no extra dependency. */
function Switch({
  checked,
  disabled,
  onChange,
  label,
}: {
  checked: boolean
  disabled?: boolean
  onChange: (v: boolean) => void
  label: string
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
        "relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        "disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-primary" : "bg-input",
      )}
    >
      <span
        className={cn(
          "inline-block size-5 transform rounded-full bg-background shadow transition-transform",
          checked ? "translate-x-[22px]" : "translate-x-0.5",
        )}
      />
    </button>
  )
}
