/**
 * RichText — a tiny, dependency-free markdown renderer for the AI-written text
 * the app produces (commentary reads, auto-trade decision summaries, entry
 * reasons). Supports exactly what those prompts emit: **bold**, `-`/`•`/`*`
 * bullets, `#`–`####` headings, `---` rules, and `| a | b |` tables. Anything
 * else renders as a plain paragraph.
 *
 * Extracted from app/trade-commentary/page.tsx (verbatim) so /auto-trade and
 * /trade-commentary render the same text identically instead of one showing raw
 * `###`/`**`. No external markdown library — the input shape is narrow and known.
 */
import type { ReactNode } from 'react';

/** Inline formatting: **bold** → <strong>, everything else plain text. */
export function renderInline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  text.split(/(\*\*[^*]+\*\*)/g).forEach((seg, i) => {
    if (seg.startsWith('**') && seg.endsWith('**')) {
      out.push(
        <strong key={`${key}-b${i}`} className="font-semibold text-foreground">
          {seg.slice(2, -2)}
        </strong>
      );
    } else if (seg) {
      out.push(<span key={`${key}-t${i}`}>{seg}</span>);
    }
  });
  return out;
}

const isTableRow = (t: string) => t.startsWith('|') && t.endsWith('|') && t.length > 1;
const isSeparatorRow = (cells: string[]) => cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(c));
const splitRow = (t: string) =>
  t
    .slice(1, -1)
    .split('|')
    .map((c) => c.trim());

/** Render a run of `| a | b |` lines as a compact table. Scrolls on narrow screens. */
function MdTable({ rows, k }: { rows: string[]; k: string }) {
  const parsed = rows.map(splitRow);
  const hasHeader = parsed.length > 1 && isSeparatorRow(parsed[1]);
  const header = hasHeader ? parsed[0] : null;
  const body = parsed.filter((cells, i) => !(hasHeader && i <= 1) && !isSeparatorRow(cells));
  return (
    <div className="overflow-x-auto">
      <table className="w-auto border-collapse text-[11px] tabular-nums">
        {header && (
          <thead>
            <tr>
              {header.map((c, i) => (
                <th
                  key={`${k}-h${i}`}
                  className={`whitespace-nowrap border-b border-border/60 py-0.5 text-left font-semibold text-muted-foreground ${i === 0 ? 'pr-4' : 'px-3'}`}
                >
                  {renderInline(c, `${k}-h${i}`)}
                </th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {body.map((cells, r) => (
            <tr key={`${k}-r${r}`} className="border-b border-border/30 last:border-0">
              {cells.map((c, i) => (
                <td
                  key={`${k}-r${r}c${i}`}
                  className={`whitespace-nowrap py-0.5 ${i === 0 ? 'pr-4 font-medium text-foreground' : 'px-3'}`}
                >
                  {renderInline(c, `${k}-r${r}c${i}`)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Render AI-written markdown text as formatted blocks. `className` overrides the
 *  wrapper styling (default matches the commentary read). */
export function RichText({ content, className }: { content: string; className?: string }) {
  const lines = content.split('\n');
  const out: ReactNode[] = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    if (isTableRow(t)) {
      const tbl: string[] = [];
      while (i < lines.length && isTableRow(lines[i].trim())) tbl.push(lines[i++].trim());
      i--; // for-loop will ++ back
      if (tbl.length) out.push(<MdTable key={`t${i}`} rows={tbl} k={`t${i}`} />);
      continue;
    }
    if (/^(---|___|\*\*\*)$/.test(t)) {
      out.push(<hr key={i} className="my-1.5 border-border/50" />);
      continue;
    }
    if (/^[-•*]\s+/.test(t)) {
      out.push(
        <div key={i} className="flex gap-1.5 pl-0.5">
          <span className="mt-[6px] h-1 w-1 shrink-0 rounded-full bg-primary/50" />
          <span>{renderInline(t.replace(/^[-•*]\s+/, ''), `l${i}`)}</span>
        </div>
      );
      continue;
    }
    if (/^#{1,4}\s+/.test(t)) {
      out.push(
        <div key={i} className="pt-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {renderInline(t.replace(/^#{1,4}\s+/, ''), `h${i}`)}
        </div>
      );
      continue;
    }
    out.push(<p key={i}>{renderInline(t, `p${i}`)}</p>);
  }
  return <div className={className ?? 'space-y-1 text-[12px] leading-relaxed text-foreground/90'}>{out}</div>;
}
