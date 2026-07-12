"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  Check, ChevronDown, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, ChevronsUpDown, ChevronUp,
  Columns3, Copy, Database, Filter, KeyRound, Lock, RefreshCw, Search, Table2, X,
} from "lucide-react"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { cn } from "@/lib/utils"

type TableInfo = { name: string; label: string; description: string; rowCount: number; columnCount: number }
type ColumnInfo = { name: string; type: string; pk: boolean; notnull: boolean }
type TableData = {
  table: string; label: string; description: string
  columns: ColumnInfo[]
  rows: Record<string, unknown>[]
  page: number; pageSize: number; total: number; totalPages: number
  sort: string; dir: "asc" | "desc"
}

const PAGE_SIZES = [25, 50, 100, 200]

// ─────────────────────────────────────────────────────────────────────────────
// Cell rendering — read-only, type-aware
// ─────────────────────────────────────────────────────────────────────────────
function Cell({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="text-muted-foreground/50">—</span>
  if (typeof value === "boolean")
    return (
      <span className={cn("inline-block rounded px-1.5 py-0 text-[10px] font-medium border", value
        ? "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900"
        : "bg-zinc-100 text-zinc-600 border-zinc-300 dark:bg-zinc-800 dark:text-zinc-400 dark:border-zinc-700")}>
        {String(value)}
      </span>
    )
  if (typeof value === "number")
    return <span className="tabular-nums">{value}</span>
  const s = String(value)
  const looksJson = s.startsWith("[") || s.startsWith("{")
  return (
    <span
      title={s.length > 60 ? s : undefined}
      className={cn("block max-w-[22rem] truncate", looksJson && "font-mono text-[11px] text-muted-foreground")}
    >
      {s === "" ? <span className="text-muted-foreground/50">·</span> : s}
    </span>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Full-value formatting for the record detail drawer
// ─────────────────────────────────────────────────────────────────────────────
function formatFull(value: unknown): { text: string; mono: boolean } {
  if (value === null || value === undefined) return { text: "", mono: true }
  if (typeof value === "boolean" || typeof value === "number") return { text: String(value), mono: true }
  const s = String(value)
  if (s.startsWith("[") || s.startsWith("{")) {
    try {
      return { text: JSON.stringify(JSON.parse(s), null, 2), mono: true } // pretty-print JSON columns
    } catch {
      /* not valid JSON — fall through to raw text */
    }
  }
  return { text: s, mono: false }
}

// ─────────────────────────────────────────────────────────────────────────────
// Record detail drawer — every column, full untruncated value
// ─────────────────────────────────────────────────────────────────────────────
function RowDetailSheet({
  open, onClose, table, label, rowNumber, columns, row,
}: {
  open: boolean; onClose: () => void; table: string; label: string
  rowNumber: number | null; columns: ColumnInfo[]; row: Record<string, unknown> | null
}) {
  const [copied, setCopied] = useState<string | null>(null)
  const copy = (key: string, text: string) => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(key)
      setTimeout(() => setCopied(null), 1200)
    })
  }

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <SheetContent side="right" className="w-full !max-w-[min(46rem,94vw)] p-0 gap-0">
        <SheetHeader className="border-b pr-12">
          <SheetTitle className="flex items-center gap-2">
            <span>{label}</span>
            {rowNumber !== null && <span className="text-xs font-normal text-muted-foreground tabular-nums">row #{rowNumber}</span>}
          </SheetTitle>
          <SheetDescription className="font-mono text-[11px]">{table}</SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-auto divide-y">
          {row && columns.map((c) => {
            const raw = row[c.name]
            const isNull = raw === null || raw === undefined
            const { text, mono } = formatFull(raw)
            return (
              <div key={c.name} className="px-4 py-2.5 group">
                <div className="flex items-center gap-2 mb-1">
                  {c.pk && <KeyRound className="size-3 text-amber-500 shrink-0" />}
                  <span className="font-mono text-xs font-medium">{c.name}</span>
                  <span className="text-[9px] uppercase text-muted-foreground/60">{c.type || "—"}</span>
                  {!isNull && text !== "" && (
                    <button
                      onClick={() => copy(c.name, text)}
                      title="Copy value"
                      className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-foreground transition-opacity"
                    >
                      {copied === c.name ? <Check className="size-3 text-emerald-500" /> : <Copy className="size-3" />}
                      {copied === c.name ? "Copied" : "Copy"}
                    </button>
                  )}
                </div>
                {isNull ? (
                  <span className="text-xs text-muted-foreground/50 italic">NULL</span>
                ) : text === "" ? (
                  <span className="text-xs text-muted-foreground/50 italic">(empty string)</span>
                ) : (
                  <pre className={cn("text-xs whitespace-pre-wrap break-words max-h-96 overflow-auto rounded bg-muted/40 px-2 py-1.5", mono ? "font-mono" : "font-sans")}>
                    {text}
                  </pre>
                )}
              </div>
            )
          })}
        </div>

        <SheetFooter className="border-t flex-row items-center gap-2 py-2.5">
          <span className="text-[11px] text-muted-foreground">{columns.length} columns</span>
          <button
            onClick={() => row && copy("__row__", JSON.stringify(row, null, 2))}
            className="ml-auto flex items-center gap-1.5 h-7 px-2.5 rounded border text-xs text-muted-foreground hover:text-foreground hover:border-foreground/40 transition-colors"
          >
            {copied === "__row__" ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5" />}
            {copied === "__row__" ? "Copied" : "Copy row as JSON"}
          </button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Table navigator (left rail)
// ─────────────────────────────────────────────────────────────────────────────
function TableNav({
  tables, selected, onSelect,
}: { tables: TableInfo[]; selected: string | null; onSelect: (name: string) => void }) {
  const [filter, setFilter] = useState("")
  const shown = useMemo(() => {
    const q = filter.toLowerCase()
    return q ? tables.filter((t) => t.name.toLowerCase().includes(q) || t.label.toLowerCase().includes(q)) : tables
  }, [tables, filter])

  return (
    <aside className="w-64 shrink-0 border-r flex flex-col bg-muted/20">
      <div className="px-3 py-2.5 border-b flex items-center gap-2">
        <Database className="size-4 text-muted-foreground" />
        <span className="text-xs font-semibold tracking-wide">Tables</span>
        <span className="ml-auto text-[10px] text-muted-foreground tabular-nums">{tables.length}</span>
      </div>
      <div className="p-2 border-b">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <Input
            placeholder="Filter tables…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="pl-8 h-7 text-xs"
          />
        </div>
      </div>
      <div className="flex-1 overflow-auto py-1">
        {shown.map((t) => {
          const active = t.name === selected
          return (
            <button
              key={t.name}
              onClick={() => onSelect(t.name)}
              className={cn(
                "w-full text-left px-3 py-1.5 flex items-center gap-2 border-l-2 transition-colors",
                active
                  ? "border-l-primary bg-primary/10"
                  : "border-l-transparent hover:bg-muted/60",
              )}
            >
              <Table2 className={cn("size-3.5 shrink-0", active ? "text-primary" : "text-muted-foreground/70")} />
              <span className="flex-1 min-w-0">
                <span className={cn("block truncate text-xs", active ? "font-medium" : "")}>{t.label}</span>
                <span className="block truncate font-mono text-[10px] text-muted-foreground">{t.name}</span>
              </span>
              <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
                {t.rowCount.toLocaleString()}
              </span>
            </button>
          )
        })}
        {shown.length === 0 && <p className="px-3 py-4 text-xs text-muted-foreground">No tables match.</p>}
      </div>
    </aside>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Column chooser
// ─────────────────────────────────────────────────────────────────────────────
function ColumnChooser({
  columns, visible, setVisible,
}: { columns: ColumnInfo[]; visible: Set<string>; setVisible: (s: Set<string>) => void }) {
  const toggle = (name: string) => {
    const next = new Set(visible)
    if (next.has(name)) { if (next.size > 1) next.delete(name) } else next.add(name)
    setVisible(next)
  }
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className="flex items-center gap-1.5 h-7 px-2 rounded border text-xs text-muted-foreground hover:text-foreground hover:border-foreground/40 transition-colors">
          <Columns3 className="size-3.5" />
          Columns
          <span className="tabular-nums opacity-60">{visible.size}/{columns.length}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 p-1.5 max-h-80 overflow-auto">
        <div className="flex items-center justify-between px-1.5 py-1 mb-1 border-b">
          <span className="text-[11px] font-medium text-muted-foreground">Columns</span>
          <div className="flex gap-1.5">
            <button className="text-[10px] text-primary hover:underline" onClick={() => setVisible(new Set(columns.map((c) => c.name)))}>All</button>
          </div>
        </div>
        {columns.map((c) => (
          <label key={c.name} className="flex items-center gap-2 px-1.5 py-1 rounded hover:bg-muted/60 cursor-pointer">
            <input type="checkbox" checked={visible.has(c.name)} onChange={() => toggle(c.name)} className="size-3.5 accent-primary" />
            <span className="flex-1 truncate text-xs font-mono">{c.name}</span>
            {c.pk && <KeyRound className="size-3 text-amber-500" />}
          </label>
        ))}
      </PopoverContent>
    </Popover>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Main page
// ─────────────────────────────────────────────────────────────────────────────
export default function DbExplorerPage() {
  const [tables, setTables] = useState<TableInfo[]>([])
  const [tablesError, setTablesError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)

  // Query state for the selected table
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [sort, setSort] = useState("")
  const [dir, setDir] = useState<"asc" | "desc">("asc")
  const [q, setQ] = useState("")
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [showFilters, setShowFilters] = useState(false)

  const [data, setData] = useState<TableData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [visible, setVisible] = useState<Set<string>>(new Set())
  const [detail, setDetail] = useState<{ row: Record<string, unknown>; number: number } | null>(null)

  // Debounced search inputs (avoid a fetch per keystroke)
  const [debouncedQ, setDebouncedQ] = useState("")
  const [debouncedFilters, setDebouncedFilters] = useState<Record<string, string>>({})
  useEffect(() => {
    const id = setTimeout(() => { setDebouncedQ(q); setDebouncedFilters(filters) }, 350)
    return () => clearTimeout(id)
  }, [q, filters])

  const reqIdRef = useRef(0)

  // Switch tables: reset all per-table query state (stable — no deps).
  const selectTable = useCallback((name: string, pushUrl = true) => {
    setSelected(name)
    setPage(1); setSort(""); setDir("asc"); setQ(""); setFilters({}); setShowFilters(false)
    setDebouncedQ(""); setDebouncedFilters({}); setVisible(new Set()); setData(null)
    if (pushUrl) {
      const url = new URL(window.location.href)
      url.searchParams.set("table", name)
      window.history.replaceState(null, "", url.toString())
    }
  }, [])

  // Load the table index once
  useEffect(() => {
    fetch("/api/db-explorer")
      .then((r) => r.json())
      .then((json) => {
        if (json.success) {
          setTables(json.data)
          const fromUrl = new URLSearchParams(window.location.search).get("table")
          const initial = json.data.find((t: TableInfo) => t.name === fromUrl)?.name ?? json.data[0]?.name ?? null
          if (initial) selectTable(initial, false)
        } else setTablesError(json.error ?? "Failed to load tables")
      })
      .catch((e) => setTablesError(String(e)))
  }, [selectTable])

  // Fetch rows whenever the query changes. setState is deferred to async
  // callbacks (never synchronously in the effect) to satisfy the hooks rules.
  const load = useCallback(() => {
    if (!selected) return
    const reqId = ++reqIdRef.current
    queueMicrotask(() => { if (reqId === reqIdRef.current) setLoading(true) })
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) })
    if (sort) { params.set("sort", sort); params.set("dir", dir) }
    if (debouncedQ) params.set("q", debouncedQ)
    const activeFilters = Object.fromEntries(Object.entries(debouncedFilters).filter(([, v]) => v.trim() !== ""))
    if (Object.keys(activeFilters).length) params.set("filters", JSON.stringify(activeFilters))

    fetch(`/api/db-explorer/${encodeURIComponent(selected)}?${params}`)
      .then((r) => r.json())
      .then((json) => {
        if (reqId !== reqIdRef.current) return // a newer request superseded this one
        if (json.success) {
          setData(json.data)
          setError(null)
          setVisible((prev) => (prev.size === 0 ? new Set(json.data.columns.map((c: ColumnInfo) => c.name)) : prev))
          if (json.data.page !== page) setPage(json.data.page)
        } else setError(json.error ?? "Failed to load")
      })
      .catch((e) => { if (reqId === reqIdRef.current) setError(String(e)) })
      .finally(() => { if (reqId === reqIdRef.current) setLoading(false) })
  }, [selected, page, pageSize, sort, dir, debouncedQ, debouncedFilters])

  useEffect(() => { load() }, [load])

  const toggleSort = (col: string) => {
    setPage(1)
    if (sort !== col) { setSort(col); setDir("asc") }
    else if (dir === "asc") setDir("desc")
    else { setSort(""); setDir("asc") } // third click clears
  }

  const setFilter = (col: string, val: string) => { setPage(1); setFilters((f) => ({ ...f, [col]: val })) }
  const clearAll = () => { setPage(1); setQ(""); setFilters({}); setSort(""); setDir("asc") }

  const shownColumns = useMemo(
    () => (data ? data.columns.filter((c) => visible.has(c.name)) : []),
    [data, visible],
  )
  const anyFilter = q !== "" || Object.values(filters).some((v) => v.trim() !== "") || sort !== ""

  const from = data && data.total > 0 ? (data.page - 1) * data.pageSize + 1 : 0
  const to = data ? Math.min(data.page * data.pageSize, data.total) : 0

  return (
    <div className="flex h-screen overflow-hidden">
      <TableNav tables={tables} selected={selected} onSelect={selectTable} />

      <main className="flex-1 flex flex-col overflow-hidden min-w-0">
        {/* Header */}
        <div className="px-4 py-2.5 border-b shrink-0">
          <div className="flex items-center gap-2">
            <h1 className="text-sm font-semibold">{data?.label ?? selected ?? "Database Explorer"}</h1>
            <span className="inline-flex items-center gap-1 rounded border bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900 px-1.5 py-0 text-[10px] font-medium">
              <Lock className="size-3" /> Read-only
            </span>
            {selected && <code className="text-[11px] text-muted-foreground font-mono">{selected}</code>}
            {data && <span className="ml-auto text-[11px] text-muted-foreground">Click a row to view the full record →</span>}
          </div>
          {data?.description && <p className="text-xs text-muted-foreground mt-0.5">{data.description}</p>}
        </div>

        {/* Toolbar */}
        <div className="flex items-center gap-2 px-4 py-2 border-b shrink-0 flex-wrap">
          <div className="relative w-64">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
            <Input
              placeholder="Search all columns…"
              value={q}
              onChange={(e) => { setPage(1); setQ(e.target.value) }}
              className="pl-8 h-7 text-xs"
            />
          </div>

          <button
            onClick={() => setShowFilters((v) => !v)}
            className={cn("flex items-center gap-1.5 h-7 px-2 rounded border text-xs transition-colors",
              showFilters ? "border-primary text-primary bg-primary/5" : "text-muted-foreground hover:text-foreground hover:border-foreground/40")}
          >
            <Filter className="size-3.5" /> Filters
          </button>

          {data && <ColumnChooser columns={data.columns} visible={visible} setVisible={setVisible} />}

          <button
            onClick={load}
            title="Refresh"
            className="flex items-center justify-center size-7 rounded border text-muted-foreground hover:text-foreground hover:border-foreground/40 transition-colors"
          >
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
          </button>

          {anyFilter && (
            <button onClick={clearAll} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
              <X className="size-3.5" /> Clear
            </button>
          )}

          {/* Pagination */}
          <div className="ml-auto flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              Rows
              <select
                value={pageSize}
                onChange={(e) => { setPage(1); setPageSize(Number(e.target.value)) }}
                className="h-7 rounded border bg-background px-1.5 text-xs"
              >
                {PAGE_SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <span className="text-xs text-muted-foreground tabular-nums whitespace-nowrap">
              {from.toLocaleString()}–{to.toLocaleString()} of {(data?.total ?? 0).toLocaleString()}
            </span>
            <div className="flex items-center gap-0.5">
              <PagerBtn disabled={!data || data.page <= 1} onClick={() => setPage(1)}><ChevronsLeft className="size-4" /></PagerBtn>
              <PagerBtn disabled={!data || data.page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}><ChevronLeft className="size-4" /></PagerBtn>
              <span className="px-2 text-xs text-muted-foreground tabular-nums whitespace-nowrap">
                {data?.page ?? 1}/{data?.totalPages ?? 1}
              </span>
              <PagerBtn disabled={!data || data.page >= data.totalPages} onClick={() => setPage((p) => p + 1)}><ChevronRight className="size-4" /></PagerBtn>
              <PagerBtn disabled={!data || data.page >= data.totalPages} onClick={() => data && setPage(data.totalPages)}><ChevronsRight className="size-4" /></PagerBtn>
            </div>
          </div>
        </div>

        {/* Table */}
        <div className="flex-1 overflow-auto">
          {tablesError && <p className="text-xs text-destructive p-4">{tablesError}</p>}
          {error && <p className="text-xs text-destructive p-4">{error}</p>}
          {!error && data && (
            <table className="text-xs border-separate border-spacing-0 min-w-full">
              <thead className="sticky top-0 z-10">
                <tr>
                  <th className="sticky left-0 z-20 bg-muted text-muted-foreground font-medium text-right px-3 py-1.5 border-b border-r w-12">#</th>
                  {shownColumns.map((c) => {
                    const active = data.sort === c.name
                    return (
                      <th
                        key={c.name}
                        onClick={() => toggleSort(c.name)}
                        className="bg-muted border-b border-r px-3 py-1.5 text-left font-medium whitespace-nowrap cursor-pointer select-none hover:bg-muted/70 group"
                      >
                        <span className="inline-flex items-center gap-1.5">
                          {c.pk && <KeyRound className="size-3 text-amber-500 shrink-0" />}
                          <span className="font-mono">{c.name}</span>
                          {active ? (
                            dir === "asc" ? <ChevronUp className="size-3.5 text-primary" /> : <ChevronDown className="size-3.5 text-primary" />
                          ) : (
                            <ChevronsUpDown className="size-3.5 text-muted-foreground/40 group-hover:text-muted-foreground" />
                          )}
                        </span>
                        <span className="block text-[9px] font-normal text-muted-foreground/60 uppercase">{c.type || "—"}</span>
                      </th>
                    )
                  })}
                </tr>
                {showFilters && (
                  <tr>
                    <th className="sticky left-0 z-20 bg-background border-b border-r" />
                    {shownColumns.map((c) => (
                      <th key={c.name} className="bg-background border-b border-r px-1.5 py-1">
                        <Input
                          value={filters[c.name] ?? ""}
                          onChange={(e) => setFilter(c.name, e.target.value)}
                          placeholder="filter…"
                          className="h-6 text-[11px] px-1.5 font-normal"
                        />
                      </th>
                    ))}
                  </tr>
                )}
              </thead>
              <tbody>
                {data.rows.length === 0 ? (
                  <tr>
                    <td colSpan={shownColumns.length + 1} className="px-3 py-10 text-center text-muted-foreground">
                      {loading ? "Loading…" : "No rows match."}
                    </td>
                  </tr>
                ) : (
                  data.rows.map((row, i) => (
                    <tr
                      key={i}
                      onClick={() => setDetail({ row, number: from + i })}
                      className="group hover:bg-primary/5 even:bg-muted/20 cursor-pointer"
                    >
                      <td className="sticky left-0 z-10 bg-background text-right px-3 py-1 text-muted-foreground tabular-nums border-b border-r">
                        {from + i}
                      </td>
                      {shownColumns.map((c) => (
                        <td key={c.name} className="px-3 py-1 border-b border-r align-top whitespace-nowrap">
                          <Cell value={row[c.name]} />
                        </td>
                      ))}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          )}
          {!data && !error && !tablesError && (
            <p className="text-xs text-muted-foreground p-4">{selected ? "Loading…" : "Select a table."}</p>
          )}
        </div>

        <RowDetailSheet
          open={detail !== null}
          onClose={() => setDetail(null)}
          table={data?.table ?? selected ?? ""}
          label={data?.label ?? ""}
          rowNumber={detail?.number ?? null}
          columns={data?.columns ?? []}
          row={detail?.row ?? null}
        />
      </main>
    </div>
  )
}

function PagerBtn({ children, disabled, onClick }: { children: React.ReactNode; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className="flex items-center justify-center size-7 rounded border text-muted-foreground enabled:hover:text-foreground enabled:hover:border-foreground/40 disabled:opacity-30 transition-colors"
    >
      {children}
    </button>
  )
}
