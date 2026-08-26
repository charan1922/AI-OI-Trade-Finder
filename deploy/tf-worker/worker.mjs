/**
 * REMOTE TradeFinder browser worker.
 *
 * Runs on its own small host so Chromium never competes with the trading app
 * for CPU. Design:
 * docs/superpowers/specs/2026-08-24-tf-browser-remote-worker-design.md
 *
 * DELIBERATELY KNOWS NOTHING ABOUT TRADEFINDER. It fetches its cookie, page
 * list and cadence from the main app, opens those pages, and forwards every
 * /api_be/ response it sees. Which feeds matter, what their payloads mean, and
 * whether a response counts as success are ALL decided by the main app (see
 * lib/tf-live/ingest.ts) — so capturing a new feed never requires touching or
 * redeploying this file.
 *
 * Plain .mjs on purpose: no TypeScript, no bundler, no Prisma — `node
 * worker.mjs` is the whole deployment. Mirrors deploy/box/**, which is
 * ESLint-ignored for the same reason.
 *
 * Env: MAIN_APP_URL, TF_WORKER_SECRET.
 */
import { chromium } from 'playwright';

const MAIN_APP_URL = (process.env.MAIN_APP_URL ?? '').replace(/\/$/, '');
const SECRET = process.env.TF_WORKER_SECRET ?? '';
if (!MAIN_APP_URL || !SECRET) {
  console.error('[tf_worker] MAIN_APP_URL and TF_WORKER_SECRET are both required');
  process.exit(1);
}

/** How often we re-read config. Also the heartbeat cadence, so the main app's
 *  3-minute liveness window sees us even while TradeFinder is silent. */
const POLL_MS = 60_000;
const REALISTIC_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';

const state = { browser: null, context: null, pages: new Map(), reloadTimer: null, reloadIntervalMs: 90_000 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function callMain(path, init = {}) {
  const response = await fetch(`${MAIN_APP_URL}${path}`, {
    ...init,
    headers: { 'X-TF-Worker-Secret': SECRET, ...(init.headers ?? {}) },
  });
  if (!response.ok) throw new Error(`${path} → HTTP ${response.status}`);
  return response.json();
}

function postJson(path, payload) {
  return callMain(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

/** Forward one observed response. Never throws into Playwright's event loop. */
async function forward(response) {
  const url = response.url();
  if (!url.includes('/api_be/')) return;
  let body = null;
  let ok = response.ok();
  try {
    body = await response.json();
  } catch {
    // A non-JSON body (e.g. an HTML login redirect served as 200) IS the "looks
    // logged out" signal — report it as a failure rather than drop it.
    ok = false;
  }
  try {
    await postJson('/api/tf/ingest', { pathname: new URL(url).pathname, status: response.status(), ok, body });
  } catch (error) {
    console.warn(`[tf_worker] ingest failed: ${error.message}`);
  }
}

async function openBrowser(config) {
  console.log(`[tf_worker] launching Chromium for ${config.pages.length} page(s)`);
  // No heap cap and no OS nice: this host runs nothing else, which is the whole
  // reason the worker exists.
  state.browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  state.browser.on('disconnected', () => {
    state.browser = null;
    state.context = null;
    state.pages.clear();
  });
  state.context = await state.browser.newContext({ userAgent: REALISTIC_UA });
  await state.context.addCookies(config.cookies);

  for (const url of config.pages) {
    const page = await state.context.newPage();
    page.on('response', (response) => void forward(response).catch(() => undefined));
    state.pages.set(url, page);
    // Sequential, and a failure here is not fatal — the reload loop retries.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
  }

  // TradeFinder's page fires ONE round of requests per load and then goes
  // silent, so our own reload IS the capture tick. Staggered across pages so
  // two renderers never navigate in the same instant.
  state.reloadIntervalMs = config.reloadIntervalMs;
  state.reloadTimer = setInterval(() => {
    const urls = [...state.pages.keys()];
    const spacing = state.reloadIntervalMs / Math.max(urls.length, 1);
    urls.forEach((url, index) => {
      setTimeout(() => {
        const page = state.pages.get(url);
        if (page) void page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
      }, spacing * index);
    });
  }, state.reloadIntervalMs);
}

async function closeBrowser() {
  if (state.reloadTimer) {
    clearInterval(state.reloadTimer);
    state.reloadTimer = null;
  }
  const browser = state.browser;
  state.browser = null;
  state.context = null;
  state.pages.clear();
  if (browser) {
    console.log('[tf_worker] closing Chromium');
    await browser.close().catch(() => undefined);
  }
}

async function tick() {
  let config;
  try {
    config = await callMain('/api/tf/worker-config');
  } catch (error) {
    // Cannot reach the main app: keep whatever is running and retry. Tearing the
    // browser down over a transient network blip would lose captures for nothing.
    console.warn(`[tf_worker] config fetch failed: ${error.message}`);
    return;
  }

  const wanted = config.shouldRun === true && Array.isArray(config.cookies) && config.cookies.length > 0;
  if (!wanted) {
    if (state.browser) await closeBrowser();
    // Still check in, so "alive, deliberately idle" is distinguishable from
    // "dead" on /tf.
    await postJson('/api/tf/ingest', { heartbeat: true }).catch(() => undefined);
    return;
  }

  if (!state.browser) {
    try {
      await openBrowser(config);
    } catch (error) {
      console.error(`[tf_worker] launch failed: ${error.message}`);
      await closeBrowser();
    }
    return;
  }
  await postJson('/api/tf/ingest', { heartbeat: true }).catch(() => undefined);
}

process.on('SIGTERM', () => void closeBrowser().then(() => process.exit(0)));
process.on('SIGINT', () => void closeBrowser().then(() => process.exit(0)));

console.log(`[tf_worker] started — polling ${MAIN_APP_URL} every ${POLL_MS / 1000}s`);
for (;;) {
  await tick();
  await sleep(POLL_MS);
}
