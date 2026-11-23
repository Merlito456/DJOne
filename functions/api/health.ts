export async function onRequestGet(): Promise<Response> {
  return new Response(JSON.stringify({ ok: true, runtime: 'cloudflare-pages' }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
