import { NextResponse } from 'next/server';

import { getAllNumberSettings, getAllToggles, setNumberSetting, setToggle } from '@/lib/config/feature-toggles';

export const dynamic = 'force-dynamic';

/** GET — every toggle + numeric setting with its definition + effective value. */
export async function GET() {
  try {
    const [data, numbers] = [await getAllToggles(), await getAllNumberSettings()];
    return NextResponse.json({ success: true, data, numbers });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

/** POST { key, value } — boolean flips a toggle, number sets a numeric setting;
 *  returns the fresh lists either way. */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { key?: unknown; value?: unknown };
    if (typeof body.key !== 'string' || (typeof body.value !== 'boolean' && typeof body.value !== 'number')) {
      return NextResponse.json({ error: 'body must be { key: string, value: boolean | number }' }, { status: 400 });
    }
    if (typeof body.value === 'boolean') await setToggle(body.key, body.value);
    else await setNumberSetting(body.key, body.value);
    const [data, numbers] = [await getAllToggles(), await getAllNumberSettings()];
    return NextResponse.json({ success: true, data, numbers });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
