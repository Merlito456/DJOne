export interface YouTubeSearchItem {
  videoId: string;
  title: string;
  author: string;
  durationSec: number;
  durationText: string;
  thumbnail: string;
  bpmHint: number | null;
}

export interface YouTubePlaylistResult {
  title: string;
  tracks: YouTubeSearchItem[];
}

export interface YouTubeVideoInfoResult {
  videoId: string;
  title: string;
  author: string;
  durationSec: number;
  thumbnail: string;
  streamAvailable: boolean;
  bpmHint: number | null;
}

const INNERTUBE_CLIENT = {
  clientName: 'WEB',
  clientVersion: '2.20241120.01.00',
  hl: 'en',
  gl: 'US',
};

const INNERTUBE_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
};

export function parseDurationText(text?: string): number {
  if (!text) return 0;
  const cleaned = text.trim();
  if (!/^\d+(?::\d{1,2}){1,2}$/.test(cleaned)) return 0;
  const parts = cleaned.split(':').map((p) => parseInt(p, 10));
  if (parts.some(Number.isNaN)) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}

export function extractBpmHint(title: string): number | null {
  const match = title.match(/\b(7\d|8\d|9\d|1[0-7]\d|180)\s*bpm\b/i);
  if (match) {
    const val = parseInt(match[1], 10);
    if (val >= 70 && val <= 185) return val;
  }
  return null;
}

function findNodesByKey(obj: unknown, targetKey: string, out: any[] = []): any[] {
  if (!obj || typeof obj !== 'object') return out;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      findNodesByKey(item, targetKey, out);
    }
    return out;
  }
  const record = obj as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(record, targetKey) && record[targetKey] != null) {
    out.push(record[targetKey]);
  }
  for (const key of Object.keys(record)) {
    findNodesByKey(record[key], targetKey, out);
  }
  return out;
}

function readRunsText(node: any): string {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (typeof node.simpleText === 'string') return node.simpleText;
  if (typeof node.content === 'string') return node.content;
  if (typeof node.text === 'string') return node.text;
  if (Array.isArray(node.runs)) {
    return node.runs.map((r: any) => r?.text || '').join('');
  }
  return '';
}

function mapVideoRenderer(vr: any): YouTubeSearchItem | null {
  const videoId = String(vr?.videoId || '').trim();
  if (!/^[a-zA-Z0-9_-]{6,20}$/.test(videoId)) return null;

  const title = readRunsText(vr.title) || 'YouTube Track';
  const author =
    readRunsText(vr.ownerText) ||
    readRunsText(vr.longBylineText) ||
    readRunsText(vr.shortBylineText) ||
    'YouTube';

  const durationText =
    readRunsText(vr.lengthText) ||
    vr.thumbnailOverlays
      ?.map((o: any) => readRunsText(o?.thumbnailOverlayTimeStatusRenderer?.text))
      ?.find((t: string) => /\d+:\d+/.test(t)) ||
    '3:30';

  const durationSec = Number(vr.lengthSeconds) || parseDurationText(durationText) || 210;
  const thumbs = vr.thumbnail?.thumbnails;
  const thumb =
    (Array.isArray(thumbs) && thumbs.length > 0 ? thumbs[thumbs.length - 1]?.url : null) ||
    `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

  return {
    videoId,
    title,
    author,
    durationSec,
    durationText: durationText.trim() || '3:30',
    thumbnail: thumb,
    bpmHint: extractBpmHint(title),
  };
}

function mapLockupViewModel(lockup: any): YouTubeSearchItem | null {
  const videoId = String(lockup?.contentId || '').trim();
  if (!/^[a-zA-Z0-9_-]{6,20}$/.test(videoId)) return null;

  const title =
    lockup?.metadata?.lockupMetadataViewModel?.title?.content || 'YouTube Track';

  const rows =
    lockup?.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel
      ?.metadataRows || [];
  const author =
    rows?.[0]?.metadataParts?.[0]?.text?.content || 'YouTube Creator';

  const badges = findNodesByKey(lockup?.contentImage, 'thumbnailBadgeViewModel');
  const durationText =
    badges
      .map((b: any) => String(b?.text || '').trim())
      .find((t: string) => /^\d+(?::\d{1,2}){1,2}$/.test(t)) || '3:30';
  const durationSec = parseDurationText(durationText) || 210;

  const sources = lockup?.contentImage?.thumbnailViewModel?.image?.sources;
  const thumb =
    (Array.isArray(sources) && sources.length > 0 ? sources[0]?.url : null) ||
    `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

  return {
    videoId,
    title,
    author,
    durationSec,
    durationText,
    thumbnail: thumb,
    bpmHint: extractBpmHint(title),
  };
}

export async function searchYouTubeVideos(
  query: string,
  limit = 16
): Promise<YouTubeSearchItem[]> {
  const res = await fetch('https://www.youtube.com/youtubei/v1/search?prettyPrint=false', {
    method: 'POST',
    headers: INNERTUBE_HEADERS,
    body: JSON.stringify({
      context: { client: INNERTUBE_CLIENT },
      query,
      params: 'EgIQAQ%3D%3D',
    }),
  });

  if (!res.ok) {
    throw new Error(`YouTube search upstream returned ${res.status}`);
  }

  const json = (await res.json()) as any;
  const seen = new Set<string>();
  const results: YouTubeSearchItem[] = [];

  const videoRenderers = findNodesByKey(json, 'videoRenderer');
  for (const vr of videoRenderers) {
    const mapped = mapVideoRenderer(vr);
    if (!mapped || seen.has(mapped.videoId)) continue;
    seen.add(mapped.videoId);
    results.push(mapped);
    if (results.length >= limit) return results;
  }

  const lockups = findNodesByKey(json, 'lockupViewModel');
  for (const lk of lockups) {
    const mapped = mapLockupViewModel(lk);
    if (!mapped || seen.has(mapped.videoId)) continue;
    seen.add(mapped.videoId);
    results.push(mapped);
    if (results.length >= limit) return results;
  }

  return results;
}

export async function fetchYouTubePlaylist(
  listId: string,
  limit = 25
): Promise<YouTubePlaylistResult> {
  const browseId = listId.startsWith('VL') ? listId : `VL${listId}`;
  const res = await fetch('https://www.youtube.com/youtubei/v1/browse?prettyPrint=false', {
    method: 'POST',
    headers: INNERTUBE_HEADERS,
    body: JSON.stringify({
      context: { client: INNERTUBE_CLIENT },
      browseId,
    }),
  });

  if (!res.ok) {
    throw new Error(`YouTube playlist upstream returned ${res.status}`);
  }

  const json = (await res.json()) as any;
  const title =
    json?.metadata?.playlistMetadataRenderer?.title ||
    readRunsText(json?.header?.playlistHeaderRenderer?.title) ||
    json?.header?.pageHeaderRenderer?.pageTitle ||
    'YouTube Playlist';

  const seen = new Set<string>();
  const tracks: YouTubeSearchItem[] = [];

  const playlistRenderers = findNodesByKey(json, 'playlistVideoRenderer');
  for (const pvr of playlistRenderers) {
    const mapped = mapVideoRenderer({
      ...pvr,
      ownerText: pvr.shortBylineText,
    });
    if (!mapped || seen.has(mapped.videoId)) continue;
    seen.add(mapped.videoId);
    tracks.push(mapped);
    if (tracks.length >= limit) break;
  }

  if (tracks.length < limit) {
    const lockups = findNodesByKey(json, 'lockupViewModel');
    for (const lk of lockups) {
      const mapped = mapLockupViewModel(lk);
      if (!mapped || seen.has(mapped.videoId)) continue;
      seen.add(mapped.videoId);
      tracks.push(mapped);
      if (tracks.length >= limit) break;
    }
  }

  return { title, tracks };
}

export async function fetchYouTubeVideoInfo(
  videoId: string
): Promise<YouTubeVideoInfoResult> {
  let title = `YouTube Track (${videoId})`;
  let author = 'YouTube';
  let thumbnail = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
  let durationSec = 210;

  try {
    const oembedRes = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(
        `https://www.youtube.com/watch?v=${videoId}`
      )}&format=json`
    );
    if (oembedRes.ok) {
      const oembed = (await oembedRes.json()) as any;
      title = oembed.title || title;
      author = oembed.author_name || author;
      thumbnail = oembed.thumbnail_url || thumbnail;
    }
  } catch {
    // Keep fallback metadata
  }

  try {
    const matches = await searchYouTubeVideos(videoId, 5);
    const exact = matches.find((m) => m.videoId === videoId);
    if (exact) {
      title = exact.title || title;
      author = exact.author || author;
      durationSec = exact.durationSec || durationSec;
      thumbnail = exact.thumbnail || thumbnail;
    }
  } catch {
    // Keep oEmbed metadata cleanly
  }

  return {
    videoId,
    title,
    author,
    durationSec,
    thumbnail,
    streamAvailable: false,
    bpmHint: extractBpmHint(title),
  };
}
