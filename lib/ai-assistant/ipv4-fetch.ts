import http from 'node:http';
import https from 'node:https';

/**
 * Minimal fetch-compatible wrapper around Node's https.request that forces IPv4
 * (family: 4) to dodge undici's IPv6-first resolution under Next.js — the same
 * helper the reference Azure OpenAI integration uses. Buffers the whole response
 * (fine for the non-streaming Responses API calls this module makes).
 */
export function ipv4Fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url,
    );
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;
    const body = init?.body ? String(init.body) : undefined;

    const rawHeaders = (init?.headers ?? {}) as Record<string, string> | Headers;
    const headers: Record<string, string> = {};
    if (rawHeaders instanceof Headers) {
      rawHeaders.forEach((v, k) => {
        headers[k] = v;
      });
    } else {
      Object.assign(headers, rawHeaders);
    }

    const options = {
      hostname: url.hostname,
      port: url.port ? Number(url.port) : isHttps ? 443 : 80,
      path: url.pathname + url.search,
      method: init?.method ?? 'GET',
      headers,
      family: 4 as const,
    };

    const req = lib.request(options, (res) => {
      const parts: Buffer[] = [];
      res.on('data', (c: Buffer) => parts.push(c));
      res.on('end', () => {
        const text = Buffer.concat(parts).toString('utf-8');
        const responseHeaders = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (v) responseHeaders.set(k, Array.isArray(v) ? v.join(', ') : v);
        }
        resolve(new Response(text, { status: res.statusCode ?? 200, headers: responseHeaders }));
      });
      res.on('error', reject);
    });

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
