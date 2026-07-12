import { NextResponse } from 'next/server';
import { setAutoTradeSetting } from '@/lib/auto-trade/settings';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/auto-trade/settings — update one runtime setting.
 * body { key, value } — the registry in lib/auto-trade/settings.ts is the
 * allowlist and validator. Admin-only via the proxy's default-deny on
 * unclassified mutating APIs (lib/auth/rbac.ts).
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { key?: string; value?: string };
    if (!body.key || body.value === undefined) {
      return NextResponse.json({ success: false, error: 'body must be { key, value }' }, { status: 400 });
    }
    const settings = await setAutoTradeSetting(body.key, String(body.value));
    return NextResponse.json({ success: true, settings });
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 400 });
  }
}
