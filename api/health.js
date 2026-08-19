/** Vercel Edge Function — /health. Lets the page confirm the proxy is reachable. */
export const config = { runtime: 'edge' };

export default function handler() {
  return new Response(JSON.stringify({ ok: true, server: 'try-and-learn' }), {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    },
  });
}
