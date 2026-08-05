import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';

import { recordTfLiveCapture, recordTfLiveRows } from '@/lib/tf-live/store';

const ENDPOINTS = ['/api_be/data/market_pulse', '/api_be/data/order/all_sector'] as const;
const INTERVAL_MS = 2.5 * 60_000;
let timer: NodeJS.Timeout | null = null;
let running = false;

function configured() {
  return process.env.AUTONOMOUS_SERVER === 'true' && process.env.TF_LIVE_CDP_ENABLED === 'true';
}

function marketOpen(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const day = parts.find((part) => part.type === 'weekday')?.value;
  const minutes = value('hour') * 60 + value('minute');
  return day !== 'Sat' && day !== 'Sun' && minutes >= 9 * 60 + 15 && minutes <= 15 * 60 + 30;
}

function bridge() {
  const url = new URL(process.env.TF_LIVE_CDP_URL ?? 'http://tf-live-browser:9223');
  return { host: url.hostname, port: Number(url.port || 80) };
}

function getJson(path: string) {
  const { host, port } = bridge();
  return new Promise<unknown>((resolve, reject) => {
    const req = http.get({ hostname: host, port, path, headers: { Host: 'localhost' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => res.statusCode === 200 ? resolve(JSON.parse(body)) : reject(new Error(`CDP HTTP ${res.statusCode}`)));
    });
    req.on('error', reject);
  });
}

function frame(message: unknown) {
  const payload = Buffer.from(JSON.stringify(message));
  const mask = randomBytes(4);
  const header = payload.length < 126 ? 6 : payload.length <= 0xffff ? 8 : 14;
  const output = Buffer.alloc(header + payload.length);
  output[0] = 0x81;
  if (payload.length < 126) { output[1] = 0x80 | payload.length; mask.copy(output, 2); for (let i = 0; i < payload.length; i++) output[6 + i] = payload[i] ^ mask[i % 4]; }
  else if (payload.length <= 0xffff) { output[1] = 0xfe; output.writeUInt16BE(payload.length, 2); mask.copy(output, 4); for (let i = 0; i < payload.length; i++) output[8 + i] = payload[i] ^ mask[i % 4]; }
  else { output[1] = 0xff; output.writeBigUInt64BE(BigInt(payload.length), 2); mask.copy(output, 10); for (let i = 0; i < payload.length; i++) output[14 + i] = payload[i] ^ mask[i % 4]; }
  return output;
}

async function evaluate(expression: string): Promise<string> {
  const targets = (await getJson('/json/list')) as Array<{ type: string; url: string; webSocketDebuggerUrl: string }>;
  const target = targets.find((item) => item.type === 'page' && item.url.startsWith('https://tradefinder.in/market-pulse'));
  if (!target) throw new Error('Market Pulse browser tab is unavailable');
  const { host, port } = bridge();
  const debug = new URL(target.webSocketDebuggerUrl);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port }); let buffer = Buffer.alloc(0); let upgraded = false; let message = Buffer.alloc(0); const timeout = setTimeout(() => fail(new Error('TradeFinder CDP timed out')), 30_000);
    const fail = (error: Error) => { clearTimeout(timeout); socket.destroy(); reject(error); };
    const parse = () => { while (buffer.length >= 2) { let length = buffer[1] & 127; let offset = 2; if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; } else if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); offset = 10; } if (buffer.length < offset + length) return; const opcode = buffer[0] & 15; const fin = Boolean(buffer[0] & 128); const payload = buffer.subarray(offset, offset + length); buffer = buffer.subarray(offset + length); if (opcode === 1 || opcode === 0) { message = Buffer.concat([message, payload]); if (fin) { const event = JSON.parse(message.toString('utf8')); message = Buffer.alloc(0); if (event.id === 1) { clearTimeout(timeout); socket.end(); resolve(String(event.result?.result?.value ?? '')); } } } } };
    socket.on('connect', () => { const key = randomBytes(16).toString('base64'); socket.write(`GET ${debug.pathname}${debug.search} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`); });
    socket.on('data', (chunk) => { buffer = Buffer.concat([buffer, chunk]); if (!upgraded) { const split = buffer.indexOf('\r\n\r\n'); if (split < 0) return; if (!buffer.subarray(0, split).toString('utf8').startsWith('HTTP/1.1 101')) return fail(new Error('TradeFinder CDP upgrade failed')); upgraded = true; buffer = buffer.subarray(split + 4); socket.write(frame({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } })); } parse(); });
    socket.on('error', fail);
  });
}

export async function captureTfLiveEndpoint(endpoint: (typeof ENDPOINTS)[number]): Promise<void> {
  if (running || !configured() || !marketOpen()) return;
  running = true;
  try {
    const raw = await evaluate(`fetch('${endpoint}', { credentials: 'include' }).then(async r => JSON.stringify({ status: r.status, body: await r.text() }))`);
    const response = JSON.parse(raw) as { status: number; body: string };
    if (response.status < 200 || response.status >= 300) throw new Error(`TradeFinder returned HTTP ${response.status}`);
    const payload = JSON.parse(response.body) as unknown;
    const captureId = await recordTfLiveCapture({ endpoint, status: 'success', payloadJson: response.body });
    const rows = Array.isArray(payload) ? payload : payload && typeof payload === 'object' ? Object.values(payload as Record<string, unknown>).find(Array.isArray) as unknown[] | undefined : undefined;
    if (captureId && rows) await recordTfLiveRows(captureId, rows);
  } catch (error) { await recordTfLiveCapture({ endpoint, status: 'error', error: (error as Error).message }); }
  finally { running = false; }
}

export async function captureTfLiveMarketPulse(): Promise<void> {
  for (const endpoint of ENDPOINTS) await captureTfLiveEndpoint(endpoint);
}

export function startTfLiveCollector(): void {
  if (timer || !configured()) return;
  void captureTfLiveMarketPulse();
  timer = setInterval(() => void captureTfLiveMarketPulse(), INTERVAL_MS);
  timer.unref?.();
  console.log('[tf_live] collector started');
}
