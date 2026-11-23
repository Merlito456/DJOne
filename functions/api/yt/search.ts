import { searchYouTubeVideos } from '../../../shared/ytInnertube';

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
  const q = String(url.searchParams.get('q') || '').trim();
  if (!q) {
    return jsonResponse({ error: 'Query parameter q is required', results: [] }, 400);
  }

  try {
    const results = await searchYouTubeVideos(q, 16);
    return jsonResponse({ results }, 200);
  } catch (err: any) {
    return jsonResponse(
      {
        error: err?.message || 'Unable to reach YouTube search right now.',
        results: [],
      },
      502
    );
  }
}
