import { NextResponse } from 'next/server';
import { COMMENTARY_SYSTEM } from '@/lib/ai-commentary/generate';
import { AUTO_TRADER_SYSTEM } from '@/lib/auto-trade/decision/system-prompt';
import { getPromptText, listPromptVersions, recordPromptVersion } from '@/lib/prompts/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/prompts — prompt version history (read-only).
 *   (no params)          → every stored version of every prompt (metadata),
 *                          after making sure the CURRENT code prompts are
 *                          recorded (so the list is never empty/stale).
 *   ?key=X[&version=N]   → the full text of one version (latest when omitted).
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const key = url.searchParams.get('key');
    if (key) {
      const versionParam = Number(url.searchParams.get('version'));
      const row = await getPromptText(key, Number.isFinite(versionParam) && versionParam > 0 ? versionParam : undefined);
      if (!row) return NextResponse.json({ success: false, error: `no stored prompt for '${key}'` }, { status: 404 });
      return NextResponse.json({ success: true, key, ...row });
    }
    // Make sure what's running right now is in the table before listing.
    await recordPromptVersion('trade-commentary', COMMENTARY_SYSTEM);
    await recordPromptVersion('auto-trader', AUTO_TRADER_SYSTEM);
    const versions = await listPromptVersions();
    return NextResponse.json({ success: true, versions });
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
}
