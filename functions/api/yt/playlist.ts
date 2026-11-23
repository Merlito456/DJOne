import { fetchYouTubePlaylist } from '../../../shared/ytInnertube';

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
  const listId = String(url.searchParams.get('list') || '').trim();
  if (!/^[a-zA-Z0-9_-]{8,64}$/.test(listId)) {
    return jsonResponse({ error: 'Invalid YouTube playlist ID', tracks: [] }, 400);
  }

  try {
    const playlist = await fetchYouTubePlaylist(listId, 25);
    return jsonResponse(playlist, 200);
  } catch (err: any) {
    return jsonResponse(
      {
        error: err?.message || 'Unable to load that YouTube playlist.',
        tracks: [],
      },
      502
    );
  }
}
