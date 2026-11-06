/**
 * AI Analysis v2's own compact markdown renderer (v2 keeps the shared components/rich-text.tsx untouched). Supports
 * what the agent writes: **bold**, `code`, `-`/`•`/`*` bullets, `1.` numbered lists, `#`–`####` headings, `---`
 * rules and `| a | b |` tables. Anything else is a plain paragraph. No markdown library (no new packages).
 */
import type { ReactNode } from 'react';

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).forEach((seg, i) => {
    if (seg.startsWith('**') && seg.endsWith('**') && seg.length > 4) {
      out.push(
        <strong key={`${key}-b${i}`} className="font-semibold text-foreground">
          {seg.slice(2, -2)}
        </strong>
      );
    } else if (seg.startsWith('`') && seg.endsWith('`') && seg.length > 2) {
      out.push(
        <code key={`${key}-c${i}`} className="rounded bg-muted px-1 font-mono text-[0.92em]">
          {seg.slice(1, -1)}
        </code>
      );
    } else if (seg) {
      out.push(<span key={`${key}-t${i}`}>{seg}</span>);
    }
  });
  return out;
}

const isTableRow = (t: string) => t.startsWith('|') && t.endsWith('|') && t.length > 1;
const splitRow = (t: string) =>
  t
    .slice(1, -1)
    .split('|')
    .map((c) => c.trim());
const isSeparator = (cells: string[]) => cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(c));

function Table({ rows, k }: { rows: string[]; k: string }) {
  const parsed = rows.map(splitRow);
  const hasHeader = parsed.length > 1 && isSeparator(parsed[1]);
  const header = hasHeader ? parsed[0] : null;
  const body = parsed.filter((cells, i) => !(hasHeader && i <= 1) && !isSeparator(cells));
  return (
    <div className="overflow-x-auto">
      <table className="w-auto border-collapse tabular-nums">
        {header && (
          <thead>
            <tr>
              {header.map((c, i) => (
                <th key={`${k}-h${i}`} className="whitespace-nowrap border-b border-border/60 py-0.5 pr-3 text-left font-semibold text-muted-foreground">
                  {inline(c, `${k}-h${i}`)}
                </th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {body.map((cells, r) => (
            <tr key={`${k}-r${r}`} className="border-b border-border/30 last:border-0">
              {cells.map((c, i) => (
                <td key={`${k}-r${r}c${i}`} className="whitespace-nowrap py-0.5 pr-3">
                  {inline(c, `${k}-r${r}c${i}`)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Markdown({ content, className }: { content: string; className?: string }) {
  const lines = content.split('\n');
  const out: ReactNode[] = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    if (isTableRow(t)) {
      const rows: string[] = [];
      while (i < lines.length && isTableRow(lines[i].trim())) rows.push(lines[i++].trim());
      i--;
      out.push(<Table key={`t${i}`} rows={rows} k={`t${i}`} />);
      continue;
    }
    if (/^(---|___|\*\*\*)$/.test(t)) {
      out.push(<hr key={i} className="my-1 border-border/50" />);
      continue;
    }
    const heading = /^#{1,4}\s+(.*)$/.exec(t);
    if (heading) {
      out.push(
        <div key={i} className="pt-1 font-semibold text-foreground">
          {inline(heading[1], `h${i}`)}
        </div>
      );
      continue;
    }
    const bullet = /^[-•*]\s+(.*)$/.exec(t);
    if (bullet) {
      out.push(
        <div key={i} className="flex gap-1.5 pl-1">
          <span className="mt-[0.55em] size-1 shrink-0 rounded-full bg-muted-foreground/60" />
          <span>{inline(bullet[1], `l${i}`)}</span>
        </div>
      );
      continue;
    }
    const numbered = /^(\d+)[.)]\s+(.*)$/.exec(t);
    if (numbered) {
      out.push(
        <div key={i} className="flex gap-1.5 pl-1">
          <span className="shrink-0 tabular-nums text-muted-foreground">{numbered[1]}.</span>
          <span>{inline(numbered[2], `n${i}`)}</span>
        </div>
      );
      continue;
    }
    out.push(<p key={i}>{inline(t, `p${i}`)}</p>);
  }
  return <div className={className ?? 'space-y-1 text-[11px] leading-relaxed text-foreground/90'}>{out}</div>;
}
