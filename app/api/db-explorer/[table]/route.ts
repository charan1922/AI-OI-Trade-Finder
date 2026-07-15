import { type NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { assertBrowsableTable, getColumns, TABLE_META } from '@/lib/db-explorer/tables';
import { adminOnly } from '@/lib/auth/server';

export const dynamic = 'force-dynamic';

const MIN_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 50;

function prettify(name: string): string {
  return name
    .split('_')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/** NextResponse.json can't serialize BigInt or blobs — coerce cells to safe JSON. */
function jsonSafe(v: unknown): unknown {
  if (typeof v === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  if (v instanceof Uint8Array) return `‹blob ${v.byteLength}b›`;
  return v;
}

/**
 * Paginated, sortable, searchable read of a single non-sensitive table.
 *
 * Query params:
 *   page      1-based page number (default 1)
 *   pageSize  10..200 (default 50)
 *   sort      column name to order by (validated against the table's columns)
 *   dir       'asc' | 'desc'
 *   q         global search — LIKE across every column (cast to text)
 *   filters   JSON object { column: substring } for per-column search
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ table: string }> }) {
  const denied = adminOnly(req);
  if (denied) return denied;
  try {
    const { table: rawTable } = await params;
    const table = await assertBrowsableTable(rawTable); // throws → sensitive/unknown table
    const columns = await getColumns(table);
    const colNames = new Set(columns.map((c) => c.name));

    const sp = req.nextUrl.searchParams;
    const page = Math.max(1, Number(sp.get('page')) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(MIN_PAGE_SIZE, Number(sp.get('pageSize')) || DEFAULT_PAGE_SIZE));
    const q = (sp.get('q') || '').trim();

    const sortParam = sp.get('sort') || '';
    const sort = colNames.has(sortParam) ? sortParam : '';
    const dir = sp.get('dir') === 'desc' ? 'DESC' : 'ASC';

    let filters: Record<string, string> = {};
    try {
      const parsed = JSON.parse(sp.get('filters') || '{}');
      if (parsed && typeof parsed === 'object') filters = parsed;
    } catch {
      /* ignore malformed filters */
    }

    // --- WHERE (values parameterized; identifiers validated + quoted) ---
    const clauses: string[] = [];
    const values: unknown[] = [];

    if (q) {
      const ors = columns.map((c) => `CAST("${c.name}" AS TEXT) LIKE ? ESCAPE '\\'`);
      clauses.push(`(${ors.join(' OR ')})`);
      const like = `%${escapeLike(q)}%`;
      for (let i = 0; i < columns.length; i++) values.push(like);
    }

    for (const [col, val] of Object.entries(filters)) {
      if (!colNames.has(col) || typeof val !== 'string' || val.trim() === '') continue;
      clauses.push(`CAST("${col}" AS TEXT) LIKE ? ESCAPE '\\'`);
      values.push(`%${escapeLike(val.trim())}%`);
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    // --- total (with filters) ---
    const countRows = await prisma.$queryRawUnsafe<{ c: bigint | number }[]>(
      `SELECT COUNT(*) AS c FROM "${table}" ${where}`,
      ...values
    );
    const total = Number(countRows[0]?.c ?? 0);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(page, totalPages);
    const offset = (safePage - 1) * pageSize;

    // Deterministic order: explicit sort, else rowid (fast + stable).
    const orderBy = sort ? `ORDER BY "${sort}" ${dir}` : 'ORDER BY rowid ASC';

    const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT * FROM "${table}" ${where} ${orderBy} LIMIT ? OFFSET ?`,
      ...values,
      pageSize,
      offset
    );

    const data = rows.map((row) => {
      const clean: Record<string, unknown> = {};
      for (const c of columns) clean[c.name] = jsonSafe(row[c.name]);
      return clean;
    });

    const meta = TABLE_META[table] ?? {
      label: prettify(table),
      description: '',
    };

    return NextResponse.json({
      success: true,
      data: {
        table,
        label: meta.label,
        description: meta.description,
        columns,
        rows: data,
        page: safePage,
        pageSize,
        total,
        totalPages,
        sort,
        dir: dir.toLowerCase(),
      },
    });
  } catch (err) {
    const msg = String(err);
    const status = msg.includes('not available') ? 404 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}

/** Escape LIKE wildcards in a user substring (paired with ESCAPE '\'). */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}
