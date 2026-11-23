interface PagesContext {
  params?: {
    id?: string | string[];
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

export async function onRequestGet(context: PagesContext): Promise<Response> {
  const rawId = context.params?.id;
  const videoId = String(Array.isArray(rawId) ? rawId[0] : rawId || '').trim();
  if (!/^[a-zA-Z0-9_-]{6,20}$/.test(videoId)) {
    return jsonResponse({ error: 'Invalid video ID' }, 400);
  }

  // On Cloudflare Workers/Pages, direct googlevideo audio proxying is not supported;
  // return structured JSON so the client seamlessly uses the YouTube IFrame bridge.
  return jsonResponse(
    {
      fallback: 'iframe',
      reason: 'Using browser YouTube player bridge.',
    },
    422
  );
}
