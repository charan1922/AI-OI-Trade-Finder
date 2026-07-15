/**
 * Telegram-side rendering + noise control for AI trade commentary.
 *
 * The commentary text is markdown written for the /trade-commentary page
 * (### headings, • bullets, occasional **bold** / *emphasis*). Telegram has
 * no markdown-file renderer: sent as plain text the ### and ** show as
 * literal characters, and Telegram's MarkdownV2 parse mode would reject the
 * text outright over unescaped ".", "-", "(" etc. So we convert the small
 * markdown subset the commentary actually uses into Telegram-native HTML
 * (parse_mode: 'HTML') — headings become bold lines, bullets stay bullets,
 * entities are escaped — and the phone renders as cleanly as the web page.
 *
 * Noise control: the poller generates a read every ~5 minutes, and quiet
 * stretches produce near-identical HOLD / end-of-day-recap texts back to
 * back. `sendCommentaryToTelegram` mutes a read that repeats the previous
 * one's verdicts with no material text change — but never mutes TRADE NOW /
 * EXIT NOW, and never stays silent longer than MAX_MUTE_MS. The read is
 * always stored in the DB regardless; muting only affects the phone ping.
 */

import { broadcastMessage } from './bot';

const TAG = '[TelegramCommentary]';

/** Telegram sendMessage hard limit (characters). */
export const TELEGRAM_MESSAGE_LIMIT = 4096;

/** Two consecutive reads with identical verdict headings and bigram-set
 *  similarity at/above this are considered the same message. Tuned against
 *  real 2026-07-14 rows: post-close recap repeats score 0.55–0.75, genuine
 *  new-information reads score < 0.45. */
export const NEAR_DUPLICATE_SIMILARITY = 0.5;

/** Never mute the phone for longer than this, even through a string of
 *  near-identical reads (poller cycles every ~5 min → at most 2 in a row). */
export const MAX_MUTE_MS = 15 * 60_000;

/* ------------------------------------------------------------------ */
/*  Markdown → Telegram HTML                                           */
/* ------------------------------------------------------------------ */

/** Escape the characters Telegram's HTML parse mode reserves. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Convert the commentary's markdown subset to Telegram HTML.
 * Handles: #..###### headings → <b> lines, **bold** → <b>, *em* or _em_ → <i>,
 * `code` → <code>, - / * bullets → •, markdown tables → plain " · " rows,
 * horizontal rules dropped. Everything else passes through escaped.
 */
export function markdownToTelegramHtml(md: string): string {
  const out: string[] = [];
  for (const rawLine of md.split('\n')) {
    let line = escapeHtml(rawLine.trimEnd());

    // Horizontal rules and table separator rows (|---|---|) → drop.
    if (/^\s*-{3,}\s*$/.test(line)) continue;
    if (/^\s*\|[\s|:-]+\|\s*$/.test(line) && line.includes('-')) continue;

    // Table rows → plain line, cells joined with " · ".
    if (/^\s*\|.*\|\s*$/.test(line)) {
      line = line
        .replace(/^\s*\|/, '')
        .replace(/\|\s*$/, '')
        .split('|')
        .map((c) => c.trim())
        .filter(Boolean)
        .join(' · ');
    }

    // Headings → bold line (strip any stray ** the model wrapped them in).
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.*)$/);
    if (heading) {
      out.push(`<b>${heading[1].replace(/\*\*/g, '').trim()}</b>`);
      continue;
    }

    // "- " / "* " bullets → "• " (existing • bullets pass through untouched).
    line = line.replace(/^(\s*)[-*]\s+/, '$1• ');

    // **bold** first, then single *em* / _em_ (word-edge only, so snake_case
    // identifiers and stray asterisks survive), then `code`.
    line = line.replace(/\*\*([^*\n]+?)\*\*/g, '<b>$1</b>');
    line = line.replace(/(^|[\s(])\*(?!\s)([^*\n]+?)\*(?=$|[\s.,;:!?)])/g, '$1<i>$2</i>');
    line = line.replace(/(^|\s)_(?!\s)([^_\n]+?)_(?=$|[\s.,;:!?)])/g, '$1<i>$2</i>');
    line = line.replace(/`([^`\n]+?)`/g, '<code>$1</code>');

    out.push(line);
  }
  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Split rendered Telegram HTML without cutting an entity or leaving a tag
 * open. Active formatting is closed at each boundary and reopened next. */
export function chunkForTelegram(text: string, limit = TELEGRAM_MESSAGE_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  const active: string[] = [];
  let current = '';
  const closingTags = () =>
    [...active]
      .reverse()
      .map((tag) => `</${tag}>`)
      .join('');
  const reopenTags = () => active.map((tag) => `<${tag}>`).join('');
  const flush = () => {
    const closers = closingTags();
    if (current && current !== reopenTags()) chunks.push(current + closers);
    current = reopenTags();
  };
  const tokens = text.match(/<\/?(?:b|i|code)>|&(?:amp|lt|gt);|[^<&]+|[<&]/g) ?? [];

  for (const token of tokens) {
    const open = token.match(/^<(b|i|code)>$/);
    const close = token.match(/^<\/(b|i|code)>$/);
    if (open || close || token.startsWith('&')) {
      if (current.length + token.length + closingTags().length > limit) flush();
      current += token;
      if (open) active.push(open[1]);
      if (close) {
        const index = active.lastIndexOf(close[1]);
        if (index >= 0) active.splice(index, 1);
      }
      continue;
    }

    let rest = token;
    while (rest) {
      const available = limit - current.length - closingTags().length;
      if (available <= 0) {
        flush();
        continue;
      }
      if (rest.length <= available) {
        current += rest;
        break;
      }
      let cut = available;
      if (cut > 1 && /[\uD800-\uDBFF]/.test(rest[cut - 1])) cut -= 1;
      const whitespace = rest.lastIndexOf(' ', cut);
      if (whitespace > Math.floor(cut / 2)) cut = whitespace + 1;
      current += rest.slice(0, cut);
      rest = rest.slice(cut);
      flush();
    }
  }
  if (current && current !== reopenTags()) chunks.push(current + closingTags());
  return chunks;
}

/* ------------------------------------------------------------------ */
/*  Near-duplicate detection (5-min poller repeats)                    */
/* ------------------------------------------------------------------ */

/** The read's actionable skeleton: its "### TICKER — VERDICT" headings.
 *  Any change here (new verdict, new SL level, new name) = new information. */
function verdictSignature(text: string): string {
  return text
    .split('\n')
    .map((l) => l.match(/^\s{0,3}#{1,6}\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => m[1].replace(/\*\*/g, '').trim().toUpperCase())
    .join(' | ');
}

/** Word-bigram set with numbers collapsed to '#' — a HOLD that only re-states
 *  drifting spot prices normalizes to nearly the same set. */
function normalizedBigrams(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .replace(/\d+(?:\.\d+)?/g, '#')
    .replace(/[^a-z#À-￿]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const grams = new Set<string>();
  for (let i = 0; i < tokens.length - 1; i++) grams.add(`${tokens[i]} ${tokens[i + 1]}`);
  return grams;
}

/** Jaccard similarity of the two reads' normalized bigram sets (0..1). */
export function readSimilarity(a: string, b: string): number {
  const ga = normalizedBigrams(a);
  const gb = normalizedBigrams(b);
  if (ga.size === 0 || gb.size === 0) return 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  return inter / (ga.size + gb.size - inter);
}

/**
 * True when `next` repeats `prev` with nothing new to act on: identical
 * verdict headings AND highly similar prose. TRADE NOW / EXIT NOW reads are
 * NEVER duplicates — an actionable call always reaches the phone.
 */
export function isNearDuplicateRead(prev: string | null | undefined, next: string): boolean {
  if (!prev) return false;
  if (/\b(TRADE NOW|EXIT NOW)\b/i.test(next)) return false;
  if (verdictSignature(prev) !== verdictSignature(next)) return false;
  return readSimilarity(prev, next) >= NEAR_DUPLICATE_SIMILARITY;
}

/* ------------------------------------------------------------------ */
/*  Send                                                               */
/* ------------------------------------------------------------------ */

const g = globalThis as { __tgCommentaryLastSentAt?: number };

export interface CommentarySendResult {
  sent: boolean;
  muted: boolean;
  deliveredRecipients: number;
  failedRecipients: number;
}

/**
 * Format a commentary read for Telegram and await verified recipient results.
 * `previousText` is the immediately preceding
 * stored read — when the new read is a near-duplicate of it and the phone
 * was pinged within MAX_MUTE_MS, the send is skipped to avoid 5-minute
 * repeat noise. The mute clock advances only after at least one recipient
 * receives every chunk successfully.
 */
export async function sendCommentaryToTelegram(
  text: string,
  previousText?: string | null
): Promise<CommentarySendResult> {
  const now = Date.now();
  const sentRecently = g.__tgCommentaryLastSentAt != null && now - g.__tgCommentaryLastSentAt < MAX_MUTE_MS;
  if (sentRecently && isNearDuplicateRead(previousText, text)) {
    console.log(`${TAG} muted near-duplicate read (same verdicts, no new information)`);
    return {
      sent: false,
      muted: true,
      deliveredRecipients: 0,
      failedRecipients: 0,
    };
  }
  const html = `📊 <b>Trade Commentary</b>\n\n${markdownToTelegramHtml(text)}`;
  const recipientOk = new Map<string, boolean>();
  for (const chunk of chunkForTelegram(html)) {
    // Broadcast: operator chat + TELEGRAM_VIEWER_CHAT_IDS — commentary is the
    // read-only feed both get; operator commands stay single-chat.
    const results = await broadcastMessage(chunk, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
    for (const result of results) {
      recipientOk.set(result.chatId, (recipientOk.get(result.chatId) ?? true) && result.ok);
    }
  }
  const deliveredRecipients = [...recipientOk.values()].filter(Boolean).length;
  const failedRecipients = recipientOk.size - deliveredRecipients;
  if (deliveredRecipients > 0) g.__tgCommentaryLastSentAt = now;
  return {
    sent: deliveredRecipients > 0,
    muted: false,
    deliveredRecipients,
    failedRecipients,
  };
}
