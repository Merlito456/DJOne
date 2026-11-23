import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { Innertube } from 'youtubei.js';
import {
  extractBpmHint,
  fetchYouTubePlaylist,
  parseDurationText,
  searchYouTubeVideos,
} from './shared/ytInnertube.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;

let ytInstance: Innertube | null = null;
let ytInitPromise: Promise<Innertube> | null = null;

async function getYouTubeClient(): Promise<Innertube> {
  if (ytInstance) return ytInstance;
  if (!ytInitPromise) {
    ytInitPromise = Innertube.create({
      retrieve_player: false,
    })
      .then((client) => {
        ytInstance = client;
        return client;
      })
      .catch((err) => {
        ytInitPromise = null;
        throw err;
      });
  }
  return ytInitPromise;
}

async function startServer() {
  const app = express();
  app.use(express.json());

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  // Search YouTube without any API key via Innertube
  app.get('/api/yt/search', async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) {
      res.status(400).json({ error: 'Query parameter q is required' });
      return;
    }

    try {
      const yt = await getYouTubeClient();
      const search = await yt.search(q, { type: 'video' });
      const rawList = (search.videos && search.videos.length > 0)
        ? search.videos
        : (search.results || []);

      let videos = rawList
        .filter((v: any) => v && (v.video_id || v.id) && v.title)
        .slice(0, 16)
        .map((v: any) => {
          const videoId = String(v.video_id || v.id);
          const title = v.title?.text || String(v.title || 'Untitled Track');
          const durationText = v.duration?.text || '0:00';
          const durationSec = Number(v.duration?.seconds) || parseDurationText(durationText) || 180;
          const author = v.author?.name || 'YouTube Creator';
          const thumb =
            v.thumbnails?.[0]?.url ||
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
        });

      // Fallback to shared pure-fetch YouTube Innertube endpoint if parser returned 0
      if (videos.length === 0) {
        videos = await searchYouTubeVideos(q, 16);
      }

      res.json({ results: videos });
    } catch (err: any) {
      try {
        const fallbackVideos = await searchYouTubeVideos(q, 16);
        res.json({ results: fallbackVideos });
      } catch (fallbackErr: any) {
        console.error('YouTube search error:', err?.message || err, fallbackErr?.message || '');
        res.status(502).json({
          error: 'Unable to reach YouTube search right now.',
          results: [],
        });
      }
    }
  });

  // Fetch an entire YouTube playlist (no API key needed)
  app.get('/api/yt/playlist', async (req, res) => {
    const listId = String(req.query.list || '').trim();
    if (!/^[a-zA-Z0-9_-]{8,64}$/.test(listId)) {
      res.status(400).json({ error: 'Invalid YouTube playlist ID' });
      return;
    }

    try {
      const yt = await getYouTubeClient();
      const playlist = await yt.getPlaylist(listId);
      const playlistTitle = playlist?.info?.title || 'YouTube Playlist';
      const rawItems =
        (playlist?.videos && playlist.videos.length > 0 ? playlist.videos : playlist?.items) || [];

      const items = rawItems
        .map((v: any) => {
          if (!v) return null;
          const videoId = String(v.content_id || v.video_id || v.id || '').trim();
          if (!videoId) return null;

          const title =
            v.metadata?.title?.text ||
            v.title?.text ||
            (typeof v.title === 'string' ? v.title : '') ||
            'Untitled Track';

          const author =
            v.metadata?.metadata?.metadata_rows?.[0]?.metadata_parts?.[0]?.text?.text ||
            v.author?.name ||
            'YouTube Creator';

          const badgeText =
            v.content_image?.overlays
              ?.flatMap((o: any) => o?.badges || [])
              ?.find((b: any) => b?.text && /\d+:\d+/.test(b.text))?.text || '';

          const durationText = badgeText || v.duration?.text || '3:30';
          const durationSec =
            Number(v.duration?.seconds) || parseDurationText(durationText) || 210;

          const thumb =
            v.content_image?.image?.[0]?.url ||
            v.thumbnails?.[0]?.url ||
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
        })
        .filter(Boolean)
        .slice(0, 25);

      if (items.length === 0) {
        const fallback = await fetchYouTubePlaylist(listId, 25);
        res.json({ title: fallback.title || playlistTitle, tracks: fallback.tracks });
        return;
      }

      res.json({ title: playlistTitle, tracks: items });
    } catch (err: any) {
      try {
        const fallback = await fetchYouTubePlaylist(listId, 25);
        res.json(fallback);
      } catch (fallbackErr: any) {
        console.error('YouTube playlist error:', err?.message || err, fallbackErr?.message || '');
        res.status(502).json({
          error: 'Unable to load that YouTube playlist.',
          tracks: [],
        });
      }
    }
  });

  // Fetch metadata for a YouTube video ID (no API key needed)
  app.get('/api/yt/info', async (req, res) => {
    const videoId = String(req.query.id || '').trim();
    if (!/^[a-zA-Z0-9_-]{6,20}$/.test(videoId)) {
      res.status(400).json({ error: 'Invalid YouTube video ID' });
      return;
    }

    try {
      // First try oEmbed for fast reliable title & author
      const oembedRes = await fetch(
        `https://www.youtube.com/oembed?url=${encodeURIComponent(
          `https://www.youtube.com/watch?v=${videoId}`
        )}&format=json`
      );

      let title = `YouTube Track (${videoId})`;
      let author = 'YouTube';
      let thumbnail = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

      if (oembedRes.ok) {
        const oembed = (await oembedRes.json()) as any;
        title = oembed.title || title;
        author = oembed.author_name || author;
        thumbnail = oembed.thumbnail_url || thumbnail;
      }

      let durationSec = 210;
      let streamAvailable = false;

      try {
        const yt = await getYouTubeClient();
        const info = await yt.getBasicInfo(videoId);
        if (info?.basic_info) {
          title = info.basic_info.title || title;
          author = info.basic_info.author || author;
          durationSec = Number(info.basic_info.duration) || durationSec;
        }
        const formats = info?.streaming_data?.adaptive_formats || [];
        streamAvailable = formats.some((f: any) => f.has_audio && f.url);
      } catch {
        // Fallback to oEmbed defaults cleanly
      }

      res.json({
        videoId,
        title,
        author,
        durationSec,
        thumbnail,
        streamAvailable,
        bpmHint: extractBpmHint(title),
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Failed to inspect video' });
    }
  });

  // Attempt direct audio proxy when YouTube allows Innertube stream extraction
  app.get('/api/yt/stream/:id', async (req, res) => {
    const videoId = String(req.params.id || '').trim();
    if (!/^[a-zA-Z0-9_-]{6,20}$/.test(videoId)) {
      res.status(400).json({ error: 'Invalid video ID' });
      return;
    }

    try {
      const yt = await getYouTubeClient();
      const info = await yt.getBasicInfo(videoId);
      const format = info.chooseFormat({ type: 'audio', quality: 'best' });
      const url = format ? await format.decipher(yt.session.player) : '';

      if (!url) {
        res.status(422).json({
          fallback: 'iframe',
          reason: 'Direct stream unavailable from server IP; using YouTube player bridge.',
        });
        return;
      }

      const upstream = await fetch(url, {
        headers: req.headers.range ? { Range: String(req.headers.range) } : undefined,
      });

      if (!upstream.ok || !upstream.body) {
        res.status(422).json({
          fallback: 'iframe',
          reason: 'Upstream stream restricted; using YouTube player bridge.',
        });
        return;
      }

      res.status(upstream.status);
      res.setHeader('Content-Type', format.mime_type || 'audio/mp4');
      res.setHeader('Accept-Ranges', 'bytes');
      const contentLength = upstream.headers.get('content-length');
      if (contentLength) res.setHeader('Content-Length', contentLength);
      const contentRange = upstream.headers.get('content-range');
      if (contentRange) res.setHeader('Content-Range', contentRange);

      const reader = upstream.body.getReader();
      req.on('close', () => {
        reader.cancel().catch(() => {});
      });

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.writableEnded) {
          res.write(value);
        }
      }
      res.end();
    } catch {
      if (!res.headersSent) {
        res.status(422).json({
          fallback: 'iframe',
          reason: 'Using browser YouTube player bridge.',
        });
      }
    }
  });


  // Vite middleware in development, static dist in production
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`DeckForge server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});
