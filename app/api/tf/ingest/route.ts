/**
 * Ingest point for the REMOTE TradeFinder browser worker.
 *
 * The worker forwards EVERY response whose URL contains /api_be/ and judges none
 * of them — this handler applies the same allowlist, the same success/rejection
 * rule and the same parsers the in-process relay used, so TradeFinder's schema
 * lives in exactly one place (lib/tf-live/ingest.ts). A payload for a feed
 * nobody reads is answered 200 and dropped, matching the old behaviour where
 * such traffic never reached the database.
 *
 * UNAUTHENTICATED AT THE PROXY (allowlisted in proxy.ts); auth is the
 * X-TF-Worker-Secret header, failing closed when unset in production.
 */
import { NextResponse } from 'next/server';

import { noteCaptureFailure, noteCaptureSuccess, noteWorkerSeen } from '@/lib/tf-live/browser';
import { classifyTfResponse, endpointTagFor, extractRows, failureAlarmMessage } from '@/lib/tf-live/ingest';
import { recordTfBrowserOutcome, recordTfLiveCapture, recordTfLiveRows } from '@/lib/tf-live/store';
import { parseIngestPayload, verifyWorkerSecret, WORKER_SECRET_HEADER } from '@/lib/tf-live/worker-protocol';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request): Promise<Response> {
  const supplied = req.headers.get(WORKER_SECRET_HEADER);
  if (!verifyWorkerSecret(supplied, process.env.TF_WORKER_SECRET, process.env.NODE_ENV === 'production')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  // Recorded before validation: even a malformed body proves the worker is
  // alive and reaching us, which is what the /tf badge reports.
  noteWorkerSeen();

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  const parsed = parseIngestPayload(raw);
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
  if (parsed.payload.kind === 'heartbeat') {
    return NextResponse.json({ success: true, stored: false, reason: 'heartbeat' });
  }

  const { pathname, status, ok, body } = parsed.payload;
  const tag = endpointTagFor(pathname);
  // Not one of the feeds we keep — real TradeFinder traffic nobody reads.
  if (!tag) return NextResponse.json({ success: true, stored: false, reason: 'not-tracked' });

  try {
    const verdict = classifyTfResponse(ok, status, body);
    if (verdict.outcome === 'rejected') {
      await recordTfLiveCapture({
        endpoint: tag,
        status: 'error',
        error: `TradeFinder rejected it (${verdict.detail})`,
      });
      // Only a SUSTAINED run of rejections raises the operator alarm — see
      // failureAlarmMessage()'s note on the 2026-08-10 incident.
      const { consecutiveFailures, sawFirstSuccess } = noteCaptureFailure();
      const alarm = failureAlarmMessage(consecutiveFailures, sawFirstSuccess, verdict.detail);
      if (alarm) await recordTfBrowserOutcome(false, alarm);
      return NextResponse.json({ success: true, stored: true, outcome: 'error', alarmed: alarm != null });
    }

    const captureId = await recordTfLiveCapture({
      endpoint: tag,
      status: 'success',
      payloadJson: JSON.stringify(body),
    });
    const rows = extractRows(tag, body);
    if (captureId && rows) await recordTfLiveRows(captureId, rows);
    noteCaptureSuccess();
    await recordTfBrowserOutcome(true);
    return NextResponse.json({ success: true, stored: true, outcome: 'success', endpoint: tag });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
