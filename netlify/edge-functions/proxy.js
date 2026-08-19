/**
 * Netlify Edge Function — same streaming CORS proxy as api/proxy.js.
 * Wired to /proxy and /health by netlify.toml.
 */
const ALLOWED_HOSTS = [
  'agentrouter.org',
  'api.anthropic.com',
  'api.openai.com',
  'openrouter.ai',
  'api.deepseek.com',
  'api.groq.com',
  'api.together.xyz',
  'generativelanguage.googleapis.com',
];

const FORWARD = new Set([
  'content-type', 'accept', 'authorization', 'x-api-key',
  'anthropic-version', 'anthropic-beta', 'anthropic-dangerous-direct-browser-access',
  'openai-organization', 'openai-beta', 'http-referer', 'x-title', 'originator',
  'x-app', 'x-stainless-lang', 'x-stainless-package-version', 'x-stainless-os',
  'x-stainless-arch', 'x-stainless-runtime', 'x-stainless-runtime-version',
  'x-stainless-retry-count',
]);

const DEFAULT_UA = 'claude-cli/1.0.60 (external, cli)';

function cors(h = new Headers()) {
  h.set('Access-Control-Allow-Origin', '*');
  h.set('Access-Control-Allow-Headers', '*');
  h.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  return h;
}

const fail = (status, message) =>
  new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: cors(new Headers({ 'Content-Type': 'application/json' })),
  });

export default async (req) => {
  const url = new URL(req.url);

  if (url.pathname === '/health') {
    return new Response(JSON.stringify({ ok: true, server: 'try-and-learn' }), {
      headers: cors(new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })),
    });
  }

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });

  const target = url.searchParams.get('url');
  if (!target) return fail(400, 'Missing ?url= parameter');

  let t;
  try { t = new URL(target); } catch { return fail(400, 'Malformed ?url='); }
  if (!/^https?:$/.test(t.protocol)) return fail(400, 'Only http/https URLs are allowed');
  if (!ALLOWED_HOSTS.some((h) => t.hostname === h || t.hostname.endsWith('.' + h))) {
    return fail(403, `Host '${t.hostname}' is not allowed by this proxy.`);
  }

  const headers = new Headers();
  req.headers.forEach((v, k) => { if (FORWARD.has(k.toLowerCase()) && v) headers.set(k, v); });
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

  headers.set('User-Agent', req.headers.get('x-ar-ua') || DEFAULT_UA);
  const extra = req.headers.get('x-ar-extra');
  if (extra) {
    try {
      for (const [k, v] of Object.entries(JSON.parse(extra))) {
        if (typeof v === 'string') headers.set(k, v);
      }
    } catch { /* ignore */ }
  }
  if (t.hostname.includes('anthropic') || headers.has('x-api-key')) {
    headers.set('anthropic-dangerous-direct-browser-access', 'true');
  }

  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.text();

  let upstream;
  try {
    upstream = await fetch(t.toString(), { method: req.method, headers, body });
  } catch (e) {
    return fail(502, 'Proxy could not reach upstream: ' + (e && e.message ? e.message : e));
  }

  /* Datacenter IPs (which this function runs on) can get an anti-bot HTML page
     from relays behind a WAF. Return actionable JSON instead of raw HTML. */
  const ctype = upstream.headers.get('Content-Type') || '';
  if (/text\/html/i.test(ctype)) {
    return fail(502,
      'The upstream relay returned an anti-bot/firewall HTML page instead of JSON. '
      + 'Its firewall blocks datacenter IPs, so this site\'s serverless proxy cannot reach it. '
      + 'Open Settings and untick "Route through proxy" to call the relay directly from your browser.');
  }

  const out = cors(new Headers());
  out.set('Content-Type', ctype || 'application/json');

  out.set('Cache-Control', 'no-cache, no-transform');
  out.set('X-Accel-Buffering', 'no');
  return new Response(upstream.body, { status: upstream.status, headers: out });
};
