/**
 * Fetch trade details directly from Dhan V2 API using the repo's TOTP auth.
 * Run: npx tsx scripts/get-trades.ts
 */
import { config } from 'dotenv';
config({ path: '.env.local' });

import { getDhanAccessToken } from '../lib/dhan/auth';

async function dhanGet(pathname: string) {
  const token = await getDhanAccessToken();
  const resp = await fetch(`https://api.dhan.co${pathname}`, {
    method: 'GET',
    headers: {
      'access-token': token,
      'client-id': process.env.DHAN_CLIENT_ID!,
      Accept: 'application/json',
    },
  });
  const body = await resp.text();
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    json = body;
  }
  return { status: resp.status, json };
}

async function main() {
  console.log('\n=== Trade Book (today) : GET /v2/trades ===');
  const trades = await dhanGet('/v2/trades');
  console.log(`HTTP ${trades.status}`);
  console.log(JSON.stringify(trades.json, null, 2));

  console.log('\n=== Order Book (today) : GET /v2/orders ===');
  const orders = await dhanGet('/v2/orders');
  console.log(`HTTP ${orders.status}`);
  console.log(JSON.stringify(orders.json, null, 2));

  console.log('\n=== Positions : GET /v2/positions ===');
  const positions = await dhanGet('/v2/positions');
  console.log(`HTTP ${positions.status}`);
  console.log(JSON.stringify(positions.json, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
