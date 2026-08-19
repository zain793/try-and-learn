/**
 * Vercel Edge Function — streaming CORS proxy.
 * Mirrors server.py so the exact same front-end code works locally and in the cloud.
 * Mapped to /proxy by vercel.json.
 *
 * Kept deliberately self-contained (no shared imports) so it cannot break
 * because of bundler/runtime differences between hosts.
 */
export const config = { runtime: 'edge' };

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

// Only these client headers are relayed upstream; everything else is dropped.
const FORWARD = new Set([
  'content-type', 'accept', 'authorization', 'x-api-key',
  'anthropic-version', 'anthropic-beta', 'anthropic-dangerous-direct-browser-access',
  'openai-organization', 'openai-beta', 'http-referer', 'x-title', 'originator',
  'x-app', 'x-stainless-lang', 'x-stainless-package-version', 'x-stainless-os',
  'x-stainless-arch', 'x-stainless-runtime', 'x-stainless-runtime-version',
  'x-stainless-retry-count',
]);

const DEFAULT_UA = 'claude-cli/1.0.60 (external, cli)';

const cors = (h = new Headers()) => {
  h.set('Access-Control-Allow-Origin', '*');
  h.set('Access-Control-Allow-Headers', '*');
  h.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  return h;
};

const fail = (status, message) =>
  new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: cors(new Headers({ 'Content-Type': 'application/json' })),
  });

const hostAllowed = (host) =>
  ALLOWED_HOSTS.some((h) => host === h || host.endsWith('.' + h));

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });


  const target = new URL(req.url).searchParams.get('url');
  if (!target) return fail(400, 'Missing ?url= parameter');

  let t;
  try { t = new URL(target); } catch { return fail(400, 'Malformed ?url='); }
  if (!/^https?:$/.test(t.protocol)) return fail(400, 'Only http/https URLs are allowed');
  if (!hostAllowed(t.hostname)) return fail(403, `Host '${t.hostname}' is not allowed by this proxy.`);

  // rebuild the header set
  const headers = new Headers();
  req.headers.forEach((v, k) => { if (FORWARD.has(k.toLowerCase()) && v) headers.set(k, v); });
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

  // client identity (browsers cannot set User-Agent themselves)
  headers.set('User-Agent', req.headers.get('x-ar-ua') || DEFAULT_UA);
  const extra = req.headers.get('x-ar-extra');
  if (extra) {
    try {
      for (const [k, v] of Object.entries(JSON.parse(extra))) {
        if (typeof v === 'string') headers.set(k, v);
      }
    } catch { /* ignore malformed hint */ }
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

  /* Some relays (AgentRouter is behind Aliyun's WAF) answer datacenter IPs —
     which is what this function runs on — with an HTML anti-bot page instead of
     JSON. Passing that through produced a cryptic "Unexpected token '<'" in the
     browser, so translate it into an actionable JSON error. */
  const ctype = upstream.headers.get('Content-Type') || '';
  if (/text\/html/i.test(ctype)) {
    return fail(502,
      'The upstream relay returned an anti-bot/firewall HTML page instead of JSON. '
      + 'Its firewall blocks datacenter IPs, so this site\'s serverless proxy cannot reach it. '
      + 'Open Settings and untick "Route through proxy" to call the relay directly from your browser.');
  }

  // stream the response straight through (keeps token-by-token output working)
  const out = cors(new Headers());
  out.set('Content-Type', ctype || 'application/json');

  out.set('Cache-Control', 'no-cache, no-transform');
  out.set('X-Accel-Buffering', 'no');
  return new Response(upstream.body, { status: upstream.status, headers: out });
}
