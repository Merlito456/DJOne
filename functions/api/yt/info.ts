import { fetchYouTubeVideoInfo } from '../../../shared/ytInnertube';

interface PagesContext {
  request: Request;
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
  const url = new URL(context.request.url);
  const videoId = String(url.searchParams.get('id') || '').trim();
  if (!/^[a-zA-Z0-9_-]{6,20}$/.test(videoId)) {
    return jsonResponse({ error: 'Invalid YouTube video ID' }, 400);
  }

  try {
    const info = await fetchYouTubeVideoInfo(videoId);
    return jsonResponse(info, 200);
  } catch (err: any) {
    return jsonResponse(
      { error: err?.message || 'Failed to inspect video' },
      500
    );
  }
}
