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


  // Groq AI Remix Director (server-side proxy — keeps GROQ_API_KEY off the client)
  app.post('/api/ai/remix-director', async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const mode = String(body.mode || 'mashup-32').slice(0, 32);
    const vibe = String(body.vibe || 'club-blend').slice(0, 32);
    const directionPrompt = String(body.directionPrompt || '').trim().slice(0, 260);
    const tracksRaw = Array.isArray(body.tracks) ? body.tracks.slice(0, 20) : [];

    const tracks = tracksRaw
      .filter((t: any) => t && typeof t === 'object')
      .map((t: any) => ({
        title: String(t.title || 'Untitled').slice(0, 80),
        artist: String(t.artist || '').slice(0, 60),
        bpm: Number.isFinite(Number(t.bpm)) ? Math.round(Number(t.bpm) * 10) / 10 : 124,
        key: String(t.musicalKey || '8A').slice(0, 6),
        vocalDensity: String(t.detectedVocalDensity || 'balanced').slice(0, 24),
      }));

    if (tracks.length === 0) {
      res.status(400).json({ error: 'At least one track summary is required.' });
      return;
    }

    const buildFallbackPlan = (reason?: string) => {
      const a = tracks[0];
      const b = tracks[1] || a;
      const isHipHop = a.bpm < 108 || b.bpm < 108;
      const isHighEnergy = a.bpm >= 128 || vibe === 'festival-drop';
      const recommendedTemplate = isHipHop
        ? 'hiphop-cut'
        : isHighEnergy
        ? 'festival-double-drop'
        : vibe === 'techno-hypnotic'
        ? 'dub-echo-flip'
        : 'club-groove-swap';
      const recommendedBridge = isHipHop ? 'sub-808' : vibe === 'chill-sunset' ? 'chord-arp' : 'house-4x4';
      const stemSwapPreference =
        a.vocalDensity === 'vocal-dense' && b.vocalDensity !== 'vocal-dense'
          ? 'a-vocal-b-beat'
          : b.vocalDensity === 'vocal-dense' && a.vocalDensity !== 'vocal-dense'
          ? 'b-vocal-a-beat'
          : 'auto';
      const shortA = a.title.split('(')[0].trim().slice(0, 22);
      const shortB = b.title.split('(')[0].trim().slice(0, 22);
      const calloutScript =
        tracks.length === 1
          ? `[cheerful] DJOne exclusive! Turning up ${shortA} right now, let's go!`
          : `[cheerful] You're locked into DJOne! Mixing ${shortA} straight into ${shortB}, hands up!`;

      return {
        source: 'heuristic-fallback',
        configured: Boolean(process.env.GROQ_API_KEY),
        reason,
        mixTitle:
          tracks.length === 1
            ? `DJOne Club Flip — ${shortA}`
            : `DJOne Live Blend: ${shortA} × ${shortB}`,
        recommendedTemplate,
        recommendedBridge,
        stemSwapPreference,
        masteringProfile: isHighEnergy ? 'festival-loud' : 'club-punch',
        calloutScript,
        directorNotes: `${a.bpm} BPM (${a.key}) → ${b.bpm} BPM (${b.key}) curated for ${vibe}.`,
        reharmonizeSynth: tracks.length === 1 || a.key !== b.key,
      };
    };

    const apiKey = process.env.GROQ_API_KEY?.trim();
    if (!apiKey) {
      res.json(buildFallbackPlan('Set GROQ_API_KEY in server secrets for Groq LLM planning.'));
      return;
    }

    try {
      const systemPrompt = [
        'You are the expert AI Music Director inside DJOne, a pro DJ mixing studio.',
        'Return ONLY valid JSON matching this schema:',
        '{',
        '  "mixTitle": string (max 64 chars),',
        '  "recommendedTemplate": "club-groove-swap" | "festival-double-drop" | "hiphop-cut" | "dub-echo-flip",',
        '  "recommendedBridge": "off" | "house-4x4" | "sub-808" | "afro-perc" | "chord-arp",',
        '  "stemSwapPreference": "auto" | "a-vocal-b-beat" | "b-vocal-a-beat" | "dual-hook",',
        '  "masteringProfile": "clean" | "club-punch" | "festival-loud" | "vinyl-warmth",',
        '  "calloutScript": string (1 energetic short DJ shoutout line <= 140 chars mentioning DJOne and track names),',
        '  "directorNotes": string (<= 160 chars technical reason why stems/key/tempo blend),',
        '  "reharmonizeSynth": boolean',
        '}',
      ].join('\n');

      const userPrompt = JSON.stringify({
        mode,
        vibe,
        directionPrompt: directionPrompt || 'Craft a clean, club-ready, tightly beat-matched edit.',
        tracks,
      });

      const upstream = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          temperature: 0.55,
          max_tokens: 420,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
        }),
        signal: AbortSignal.timeout(12000),
      });

      if (!upstream.ok) {
        const errText = await upstream.text().catch(() => '');
        res.json(buildFallbackPlan(`Groq API returned ${upstream.status}${errText ? `: ${errText.slice(0, 80)}` : ''}`));
        return;
      }

      const data = (await upstream.json()) as any;
      const content = data?.choices?.[0]?.message?.content;
      const parsed = typeof content === 'string' ? JSON.parse(content) : {};
      const fallback = buildFallbackPlan();

      const validTemplates = new Set([
        'club-groove-swap',
        'festival-double-drop',
        'hiphop-cut',
        'dub-echo-flip',
      ]);
      const validBridges = new Set(['off', 'house-4x4', 'sub-808', 'afro-perc', 'chord-arp']);
      const validSwaps = new Set(['auto', 'a-vocal-b-beat', 'b-vocal-a-beat', 'dual-hook']);
      const validMasters = new Set(['clean', 'club-punch', 'festival-loud', 'vinyl-warmth']);

      res.json({
        source: 'groq',
        configured: true,
        mixTitle: String(parsed.mixTitle || fallback.mixTitle).slice(0, 70),
        recommendedTemplate: validTemplates.has(parsed.recommendedTemplate)
          ? parsed.recommendedTemplate
          : fallback.recommendedTemplate,
        recommendedBridge: validBridges.has(parsed.recommendedBridge)
          ? parsed.recommendedBridge
          : fallback.recommendedBridge,
        stemSwapPreference: validSwaps.has(parsed.stemSwapPreference)
          ? parsed.stemSwapPreference
          : fallback.stemSwapPreference,
        masteringProfile: validMasters.has(parsed.masteringProfile)
          ? parsed.masteringProfile
          : fallback.masteringProfile,
        calloutScript: String(parsed.calloutScript || fallback.calloutScript).slice(0, 180),
        directorNotes: String(parsed.directorNotes || fallback.directorNotes).slice(0, 200),
        reharmonizeSynth:
          typeof parsed.reharmonizeSynth === 'boolean'
            ? parsed.reharmonizeSynth
            : fallback.reharmonizeSynth,
      });
    } catch (err: any) {
      res.json(buildFallbackPlan(err?.message || 'Groq Director fallback active.'));
    }
  });

  // Groq Orpheus TTS proxy for custom spoken DJ intro drops
  app.post('/api/ai/tts-drop', async (req, res) => {
    const apiKey = process.env.GROQ_API_KEY?.trim();
    if (!apiKey) {
      res.status(422).json({
        fallback: 'synth',
        reason: 'GROQ_API_KEY not configured; falling back to onboard DJOne synth drops.',
      });
      return;
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const text = String(body.text || '').trim().slice(0, 220);
    if (!text) {
      res.status(400).json({ error: 'Text prompt is required.' });
      return;
    }

    const allowedVoices = new Set(['troy', 'daniel', 'austin', 'diana', 'hannah', 'autumn']);
    const voice = allowedVoices.has(String(body.voice || '').toLowerCase())
      ? String(body.voice).toLowerCase()
      : 'troy';

    try {
      const upstream = await fetch('https://api.groq.com/openai/v1/audio/speech', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'canopylabs/orpheus-v1-english',
          voice,
          input: text,
          response_format: 'wav',
        }),
        signal: AbortSignal.timeout(15000),
      });

      if (!upstream.ok) {
        res.status(422).json({
          fallback: 'synth',
          reason: `Groq TTS unavailable (${upstream.status}).`,
        });
        return;
      }

      const audioBuf = Buffer.from(await upstream.arrayBuffer());
      res.setHeader('Content-Type', 'audio/wav');
      res.setHeader('Content-Length', String(audioBuf.length));
      res.send(audioBuf);
    } catch {
      res.status(422).json({
        fallback: 'synth',
        reason: 'Groq TTS request timed out; using onboard synth voice.',
      });
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
    console.log(`DJOne server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});
