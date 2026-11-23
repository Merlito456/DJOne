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
    const directionPrompt = String(body.directionPrompt || '').trim().slice(0, 320);
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

    const inferStudioFxFromPrompt = (promptText: string, baseBpm: number) => {
      const p = promptText.toLowerCase();
      let bootlegPreset: 'off' | 'jersey-club' | 'amapiano' | 'phonk' | 'slowed-reverb' | 'nightcore' = 'off';
      if (/jersey|triplet/.test(p)) bootlegPreset = 'jersey-club';
      else if (/amapiano|log.?drum|afro/.test(p)) bootlegPreset = 'amapiano';
      else if (/phonk|cowbell/.test(p)) bootlegPreset = 'phonk';
      else if (/slowed|chopped|screwed/.test(p)) bootlegPreset = 'slowed-reverb';
      else if (/nightcore|rave|speed\s*up/.test(p)) bootlegPreset = 'nightcore';

      let synthLayerMode: 'off' | 'supersaw-pad' | 'acid-303' | 'sidechain-arp' = 'off';
      if (/acid|303|techno|berlin|dark/.test(p)) synthLayerMode = 'acid-303';
      else if (/pad|supersaw|euphoric|sunset|trance/.test(p)) synthLayerMode = 'supersaw-pad';
      else if (/arp|sidechain|house|plucked/.test(p)) synthLayerMode = 'sidechain-arp';
      else if (baseBpm >= 122) synthLayerMode = 'sidechain-arp';

      const reverseVocalSwell = /swell|reverse|before.*chorus|before.*drop|cinematic/.test(p) || tracks.length >= 1;
      const tapeStopDropPrep = /tape|brake|stop|vinyl|slam|berlin|techno/.test(p);
      const filterEnvelope: 'none' | 'dark-warm' | 'lpf-drop-open' | 'hpf-tension' =
        /dark|berlin|underwater|warm/.test(p)
          ? 'lpf-drop-open'
          : /tension|build|hpf|riser/.test(p)
          ? 'hpf-tension'
          : 'none';

      return { bootlegPreset, synthLayerMode, reverseVocalSwell, tapeStopDropPrep, filterEnvelope };
    };

    const buildFallbackPlan = (reason?: string) => {
      const a = tracks[0];
      const b = tracks[1] || a;
      const isHipHop = a.bpm < 108 || b.bpm < 108;
      const isHighEnergy = a.bpm >= 128 || vibe === 'festival-drop';
      const studio = inferStudioFxFromPrompt(directionPrompt, a.bpm);
      const recommendedTemplate = isHipHop
        ? 'hiphop-cut'
        : isHighEnergy
        ? 'festival-double-drop'
        : vibe === 'techno-hypnotic' || /berlin|dark|techno/.test(directionPrompt.toLowerCase())
        ? 'dub-echo-flip'
        : 'club-groove-swap';
      const recommendedBridge =
        studio.bootlegPreset === 'amapiano'
          ? 'afro-perc'
          : isHipHop || studio.bootlegPreset === 'phonk'
          ? 'sub-808'
          : vibe === 'chill-sunset'
          ? 'chord-arp'
          : 'house-4x4';
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
          ? `[cheerful] DJOne Studio exclusive! Dropping the ${studio.bootlegPreset !== 'off' ? studio.bootlegPreset : 'club'} flip of ${shortA}, lock in!`
          : `[cheerful] You're locked into DJOne! Mixing ${shortA} straight into ${shortB}, hands up!`;

      return {
        source: 'heuristic-fallback',
        configured: Boolean(process.env.GROQ_API_KEY),
        reason,
        mixTitle:
          tracks.length === 1
            ? `DJOne Studio Flip — ${shortA}`
            : `DJOne Live Blend: ${shortA} × ${shortB}`,
        recommendedTemplate,
        recommendedBridge,
        stemSwapPreference,
        masteringProfile: isHighEnergy ? 'festival-loud' : 'club-punch',
        calloutScript,
        directorNotes: `${a.bpm} BPM (${a.key}) → ${b.bpm} BPM (${b.key}) curated for ${vibe}.`,
        reharmonizeSynth: tracks.length === 1 || a.key !== b.key || studio.synthLayerMode !== 'off',
        ...studio,
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
        '  "calloutScript": string (1 short DJ/robot shoutout <= 140 chars matching directionPrompt tone),',
        '  "directorNotes": string (<= 160 chars technical reason why stems/key/tempo blend),',
        '  "reharmonizeSynth": boolean,',
        '  "bootlegPreset": "off" | "jersey-club" | "amapiano" | "phonk" | "slowed-reverb" | "nightcore",',
        '  "synthLayerMode": "off" | "supersaw-pad" | "acid-303" | "sidechain-arp",',
        '  "reverseVocalSwell": boolean,',
        '  "tapeStopDropPrep": boolean,',
        '  "filterEnvelope": "none" | "dark-warm" | "lpf-drop-open" | "hpf-tension"',
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
          max_tokens: 480,
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
      const validBootlegs = new Set(['off', 'jersey-club', 'amapiano', 'phonk', 'slowed-reverb', 'nightcore']);
      const validSynths = new Set(['off', 'supersaw-pad', 'acid-303', 'sidechain-arp']);
      const validEnvs = new Set(['none', 'dark-warm', 'lpf-drop-open', 'hpf-tension']);

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
        bootlegPreset: validBootlegs.has(parsed.bootlegPreset)
          ? parsed.bootlegPreset
          : fallback.bootlegPreset,
        synthLayerMode: validSynths.has(parsed.synthLayerMode)
          ? parsed.synthLayerMode
          : fallback.synthLayerMode,
        reverseVocalSwell:
          typeof parsed.reverseVocalSwell === 'boolean'
            ? parsed.reverseVocalSwell
            : fallback.reverseVocalSwell,
        tapeStopDropPrep:
          typeof parsed.tapeStopDropPrep === 'boolean'
            ? parsed.tapeStopDropPrep
            : fallback.tapeStopDropPrep,
        filterEnvelope: validEnvs.has(parsed.filterEnvelope)
          ? parsed.filterEnvelope
          : fallback.filterEnvelope,
      });
    } catch (err: any) {
      res.json(buildFallbackPlan(err?.message || 'Groq Director fallback active.'));
    }
  });

  // Groq Whisper Wordplay & Lyric Cue Detection (whisper-large-v3-turbo)
  const ANCHOR_WORD_SET = new Set([
    'tonight', 'fire', 'drop', 'love', 'dance', 'party', 'hands', 'night', 'move',
    'body', 'feel', 'music', 'club', 'floor', 'go', 'baby', 'time', 'bass', 'down', 'up',
  ]);

  const EXPLICIT_WORD_SET = new Set([
    'fuck', 'fucking', 'fucked', 'fucker', 'motherfucker', 'shit', 'shitty', 'bullshit',
    'bitch', 'bitches', 'asshole', 'bastard', 'damn', 'hell', 'crap', 'dick', 'cock',
    'pussy', 'whore', 'slut', 'cunt', 'nigga', 'nigger', 'fag', 'faggot', 'hoe',
  ]);

  const detectExplicitInWords = (wordItems: { word: string; startSec: number; endSec: number }[]) => {
    const windows: { startSec: number; endSec: number; word: string }[] = [];
    for (const w of wordItems) {
      const normalized = String(w.word || '')
        .toLowerCase()
        .replace(/[^a-z']/g, '');
      if (normalized && EXPLICIT_WORD_SET.has(normalized)) {
        const s = Math.max(0, Math.round((w.startSec - 0.04) * 100) / 100);
        const e = Math.max(s + 0.18, Math.round((w.endSec + 0.04) * 100) / 100);
        windows.push({ startSec: s, endSec: e, word: normalized.slice(0, 1) + '***' });
      }
    }
    return windows.slice(0, 64);
  };

  app.post('/api/ai/transcribe-cues', express.json({ limit: '14mb' }), async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const audioBase64 = typeof body.audioBase64 === 'string' ? body.audioBase64.trim() : '';
    const offsetSec = Number.isFinite(Number(body.offsetSec)) ? Math.max(0, Number(body.offsetSec)) : 0;
    const durationSec = Number.isFinite(Number(body.durationSec)) ? Math.max(10, Number(body.durationSec)) : 180;
    const title = String(body.title || 'Track').slice(0, 80);

    const buildHeuristicCues = () => {
      const cleanWords = title
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 2);
      const anchorHits = cleanWords
        .filter((w) => ANCHOR_WORD_SET.has(w))
        .slice(0, 4)
        .map((w, idx) => ({
          word: w,
          timeSec: Math.round((durationSec * (0.22 + idx * 0.16)) * 100) / 100,
        }));
      const cleanEditWindows = cleanWords.some((w) => EXPLICIT_WORD_SET.has(w)) || /\bexplicit\b/i.test(title)
        ? [
            {
              startSec: Math.round(durationSec * 0.28 * 100) / 100,
              endSec: Math.round((durationSec * 0.28 + 0.42) * 100) / 100,
              word: 'e***',
            },
            {
              startSec: Math.round(durationSec * 0.62 * 100) / 100,
              endSec: Math.round((durationSec * 0.62 + 0.42) * 100) / 100,
              word: 'e***',
            },
          ]
        : [];
      const hookPhrases = [
        { text: `${title.split('(')[0].trim().slice(0, 28)} · Intro`, startSec: Math.round(durationSec * 0.08 * 100) / 100, endSec: Math.round(durationSec * 0.14 * 100) / 100 },
        { text: `Hook A`, startSec: Math.round(durationSec * 0.25 * 100) / 100, endSec: Math.round(durationSec * 0.34 * 100) / 100 },
        { text: `Pre-Drop`, startSec: Math.round(durationSec * 0.44 * 100) / 100, endSec: Math.round(durationSec * 0.5 * 100) / 100 },
        { text: `Main Hook`, startSec: Math.round(durationSec * 0.58 * 100) / 100, endSec: Math.round(durationSec * 0.68 * 100) / 100 },
      ];
      return {
        source: 'heuristic-fallback',
        words: [],
        busyWindows: [
          { startSec: hookPhrases[1].startSec, endSec: hookPhrases[1].endSec },
          { startSec: hookPhrases[3].startSec, endSec: hookPhrases[3].endSec },
        ],
        hookPhrases,
        anchorWords: anchorHits,
        cleanEditWindows,
        scannedAt: Date.now(),
      };
    };

    const apiKey = process.env.GROQ_API_KEY?.trim();
    if (!apiKey || !audioBase64) {
      res.json(buildHeuristicCues());
      return;
    }

    try {
      const wavBuf = Buffer.from(audioBase64, 'base64');
      if (wavBuf.length < 512 || wavBuf.length > 12 * 1024 * 1024) {
        res.status(400).json({ error: 'Audio slice must be between 512 bytes and 12MB WAV.' });
        return;
      }

      const form = new FormData();
      form.append('file', new Blob([wavBuf], { type: 'audio/wav' }), 'track_excerpt.wav');
      form.append('model', 'whisper-large-v3-turbo');
      form.append('response_format', 'verbose_json');
      form.append('timestamp_granularities[]', 'word');
      form.append('timestamp_granularities[]', 'segment');

      const upstream = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        body: form,
        signal: AbortSignal.timeout(20000),
      });

      if (!upstream.ok) {
        res.json(buildHeuristicCues());
        return;
      }

      const data = (await upstream.json()) as any;
      const rawWords = Array.isArray(data?.words) ? data.words : [];
      const rawSegments = Array.isArray(data?.segments) ? data.segments : [];

      const words = rawWords
        .filter((w: any) => w && typeof w.word === 'string' && Number.isFinite(Number(w.start)))
        .slice(0, 600)
        .map((w: any) => ({
          word: String(w.word).trim().slice(0, 32),
          startSec: Math.round((offsetSec + Number(w.start)) * 100) / 100,
          endSec: Math.round((offsetSec + Number(w.end ?? Number(w.start) + 0.35)) * 100) / 100,
        }))
        .filter((w: any) => w.word.length > 0);

      // Merge contiguous vocal activity segments (gap <= 1.2s) into busyWindows for Anti-Vocal-Clash Guard
      const segList: { startSec: number; endSec: number; text: string }[] = rawSegments
        .filter((s: any) => s && Number.isFinite(Number(s.start)) && Number.isFinite(Number(s.end)))
        .map((s: any) => ({
          startSec: Math.round((offsetSec + Number(s.start)) * 100) / 100,
          endSec: Math.round((offsetSec + Number(s.end)) * 100) / 100,
          text: String(s.text || '').trim().slice(0, 64),
        }));

      const busyWindows: { startSec: number; endSec: number }[] = [];
      for (const seg of segList) {
        const last = busyWindows[busyWindows.length - 1];
        if (last && seg.startSec - last.endSec <= 1.1) {
          last.endSec = Math.max(last.endSec, seg.endSec);
        } else {
          busyWindows.push({ startSec: seg.startSec, endSec: seg.endSec });
        }
      }

      const anchorWords: { word: string; timeSec: number }[] = [];
      const seenAnchors = new Set<string>();
      for (const w of words) {
        const clean = w.word.toLowerCase().replace(/[^a-z]/g, '');
        if (clean.length >= 2 && ANCHOR_WORD_SET.has(clean) && !seenAnchors.has(clean)) {
          seenAnchors.add(clean);
          anchorWords.push({ word: clean, timeSec: w.startSec });
        }
      }

      // Pick up to 4 representative hook phrases for Hot Cues 1..4
      const hookPhrases = segList
        .filter((s) => s.text.length >= 4)
        .slice(0, 4)
        .map((s) => ({
          text: s.text.slice(0, 24),
          startSec: s.startSec,
          endSec: s.endSec,
        }));

      const cleanEditWindows = detectExplicitInWords(words);

      res.json({
        source: 'groq-whisper',
        words,
        busyWindows,
        hookPhrases,
        anchorWords,
        cleanEditWindows,
        scannedAt: Date.now(),
      });
    } catch {
      res.json(buildHeuristicCues());
    }
  });

  // Live Autopilot Prompt Director (Cue AI Set Architect)
  app.post('/api/ai/live-director', async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const prompt = String(body.prompt || '').trim().slice(0, 320);
    const stationName = String(body.stationName || 'DJOne').trim().slice(0, 40) || 'DJOne';
    const currentTrackId = typeof body.currentTrackId === 'string' ? body.currentTrackId : '';
    const rawTracks = Array.isArray(body.tracks) ? body.tracks.slice(0, 48) : [];
    const tracks = rawTracks
      .filter((t: any) => t && typeof t === 'object' && typeof t.id === 'string')
      .map((t: any) => ({
        id: String(t.id).slice(0, 80),
        title: String(t.title || 'Untitled').slice(0, 80),
        artist: String(t.artist || '').slice(0, 60),
        bpm: Number.isFinite(Number(t.bpm)) ? Math.round(Number(t.bpm) * 10) / 10 : 124,
        musicalKey: String(t.musicalKey || '8A').slice(0, 6),
        vocalDensity: String(t.detectedVocalDensity || 'balanced').slice(0, 24),
        subGenre: t.enrichment?.subGenre ? String(t.enrichment.subGenre).slice(0, 32) : undefined,
      }));

    if (!prompt || tracks.length === 0) {
      res.status(400).json({ error: 'Prompt and at least one track are required.' });
      return;
    }

    const buildFallbackLiveDirector = () => {
      const p = prompt.toLowerCase();
      const vibe = /techno|hypnotic|berlin|acid|dark/.test(p)
        ? 'techno-hypnotic'
        : /sunset|chill|warm|lofi|deep|afro/.test(p)
        ? 'chill-sunset'
        : /festival|peak|hype|drop|rave|chorus/.test(p)
        ? 'festival-drop'
        : /scratch|chop|hip.?hop|rap|jersey/.test(p)
        ? 'scratch-chop'
        : /mashup|blend|vocal/.test(p)
        ? 'mashup-live'
        : 'club-blend';
      const energyMode = /build|peak|ramp|escalat/.test(p)
        ? 'build'
        : /chill|cooldown|sunset|relax/.test(p)
        ? 'chill'
        : 'wave';
      const aggressiveness = /heavy|hard|slam|peak|festival|aggressive|chop/.test(p)
        ? 78
        : /smooth|sunset|gentle|warm|deep/.test(p)
        ? 38
        : 58;
      const bootlegFlip = /jersey/.test(p)
        ? 'jersey-club'
        : /amapiano|log.?drum/.test(p)
        ? 'amapiano'
        : /phonk|cowbell/.test(p)
        ? 'phonk'
        : /slowed/.test(p)
        ? 'slowed-reverb'
        : /nightcore/.test(p)
        ? 'nightcore'
        : 'off';
      const harmonicLayer = /acid|303|techno/.test(p)
        ? 'acid-303'
        : /pad|supersaw|sunset/.test(p)
        ? 'supersaw-pad'
        : /arp|house/.test(p)
        ? 'sidechain-arp'
        : 'off';
      const grooveBridge = /afro|amapiano/.test(p)
        ? 'afro-perc'
        : /house|tech/.test(p)
        ? 'house-4x4'
        : /hip.?hop|trap|808|phonk/.test(p)
        ? 'sub-808'
        : 'off';

      const sorted = [...tracks].sort((a, b) =>
        energyMode === 'build' ? a.bpm - b.bpm : energyMode === 'chill' ? b.bpm - a.bpm : 0
      );
      const orderedTrackIds = sorted.map((t) => t.id);
      const nextTrack = sorted.find((t) => t.id !== currentTrackId) || sorted[0];
      const transitionStylePrompt = /bass/.test(p)
        ? 'drop swap bass cut'
        : /dub|techno/.test(p)
        ? 'dub delay filter sweep'
        : 'phrase drop swap';

      return {
        source: 'heuristic-fallback',
        configured: Boolean(process.env.GROQ_API_KEY),
        summary: `Curated ${orderedTrackIds.length} tracks (${vibe}, ${energyMode}) for "${prompt.slice(0, 48)}"`,
        orderedTrackIds,
        vibe,
        energyMode,
        aggressiveness,
        bootlegFlip,
        harmonicLayer,
        grooveBridge,
        transitionStylePrompt,
        pairNotes: {},
        hostDropScript: `[cheerful] Locked into ${stationName}! Turning up the energy into ${nextTrack.title.split('(')[0].trim().slice(0, 26)}, let's go!`,
        hostVoice: vibe === 'chill-sunset' ? 'hannah' : 'troy',
      };
    };

    const apiKey = process.env.GROQ_API_KEY?.trim();
    if (!apiKey) {
      res.json(buildFallbackLiveDirector());
      return;
    }

    try {
      const systemPrompt = [
        'You are the live Set Director AI for DJOne.',
        'Given the user direction and track crate, reorder track IDs for the best harmonic/energy flow and pick live DJ settings.',
        'Return ONLY valid JSON:',
        '{',
        '  "summary": string (<= 110 chars),',
        '  "orderedTrackIds": string[] (using ONLY exact track IDs provided),',
        '  "vibe": "club-blend" | "festival-drop" | "techno-hypnotic" | "scratch-chop" | "mashup-live" | "chill-sunset",',
        '  "energyMode": "wave" | "build" | "chill",',
        '  "aggressiveness": number (0..100),',
        '  "bootlegFlip": "off" | "jersey-club" | "amapiano" | "phonk" | "slowed-reverb" | "nightcore",',
        '  "harmonicLayer": "off" | "supersaw-pad" | "acid-303" | "sidechain-arp",',
        '  "grooveBridge": "off" | "top-hats" | "house-4x4" | "sub-808" | "afro-perc" | "chord-arp",',
        '  "transitionStylePrompt": string (short FX cue like "drop swap", "dub delay", "staircase"),',
        '  "hostDropScript": string (1 energetic DJ radio drop <= 130 chars referencing stationName & vibe),',
        '  "hostVoice": "troy" | "daniel" | "austin" | "diana" | "hannah" | "autumn"',
        '}',
      ].join('\n');

      const upstream = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          temperature: 0.45,
          max_tokens: 650,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemPrompt },
            {
              role: 'user',
              content: JSON.stringify({ prompt, stationName, currentTrackId, tracks }),
            },
          ],
        }),
        signal: AbortSignal.timeout(12000),
      });

      if (!upstream.ok) {
        res.json(buildFallbackLiveDirector());
        return;
      }

      const data = (await upstream.json()) as any;
      const content = data?.choices?.[0]?.message?.content;
      const parsed = typeof content === 'string' ? JSON.parse(content) : {};
      const fallback = buildFallbackLiveDirector();

      const validIdSet = new Set(tracks.map((t: any) => t.id));
      const rawOrder: string[] = Array.isArray(parsed.orderedTrackIds)
        ? parsed.orderedTrackIds.filter((id: any) => typeof id === 'string' && validIdSet.has(id))
        : [];
      const seen = new Set(rawOrder);
      for (const t of tracks) {
        if (!seen.has(t.id)) rawOrder.push(t.id);
      }

      const validVibes = new Set(['club-blend', 'festival-drop', 'techno-hypnotic', 'scratch-chop', 'mashup-live', 'chill-sunset']);
      const validEnergy = new Set(['wave', 'build', 'chill']);
      const validBootlegs = new Set(['off', 'jersey-club', 'amapiano', 'phonk', 'slowed-reverb', 'nightcore']);
      const validLayers = new Set(['off', 'supersaw-pad', 'acid-303', 'sidechain-arp']);
      const validBridges = new Set(['off', 'top-hats', 'house-4x4', 'sub-808', 'afro-perc', 'chord-arp']);
      const validVoices = new Set(['troy', 'daniel', 'austin', 'diana', 'hannah', 'autumn']);

      res.json({
        source: 'groq',
        configured: true,
        summary: String(parsed.summary || fallback.summary).slice(0, 120),
        orderedTrackIds: rawOrder.length > 0 ? rawOrder : fallback.orderedTrackIds,
        vibe: validVibes.has(parsed.vibe) ? parsed.vibe : fallback.vibe,
        energyMode: validEnergy.has(parsed.energyMode) ? parsed.energyMode : fallback.energyMode,
        aggressiveness: Number.isFinite(Number(parsed.aggressiveness))
          ? Math.max(10, Math.min(100, Math.round(Number(parsed.aggressiveness))))
          : fallback.aggressiveness,
        bootlegFlip: validBootlegs.has(parsed.bootlegFlip) ? parsed.bootlegFlip : fallback.bootlegFlip,
        harmonicLayer: validLayers.has(parsed.harmonicLayer) ? parsed.harmonicLayer : fallback.harmonicLayer,
        grooveBridge: validBridges.has(parsed.grooveBridge) ? parsed.grooveBridge : fallback.grooveBridge,
        transitionStylePrompt: String(parsed.transitionStylePrompt || fallback.transitionStylePrompt).slice(0, 80),
        pairNotes: parsed.pairNotes && typeof parsed.pairNotes === 'object' ? parsed.pairNotes : {},
        hostDropScript: String(parsed.hostDropScript || fallback.hostDropScript).slice(0, 160),
        hostVoice: validVoices.has(String(parsed.hostVoice || '').toLowerCase())
          ? String(parsed.hostVoice).toLowerCase()
          : fallback.hostVoice,
      });
    } catch {
      res.json(buildFallbackLiveDirector());
    }
  });

  // Groq Crate Enricher & Mashup Chemistry Scorer (llama-3.1-8b-instant)
  app.post('/api/ai/crate-enrich', async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const rawTracks = Array.isArray(body.tracks) ? body.tracks.slice(0, 25) : [];
    const tracks = rawTracks
      .filter((t: any) => t && typeof t === 'object' && typeof t.id === 'string')
      .map((t: any) => ({
        id: String(t.id).slice(0, 80),
        title: String(t.title || 'Untitled').slice(0, 80),
        artist: String(t.artist || '').slice(0, 60),
        bpm: Number.isFinite(Number(t.bpm)) ? Math.round(Number(t.bpm) * 10) / 10 : 124,
        musicalKey: String(t.musicalKey || '8A').slice(0, 6),
        vocalDensity: String(t.detectedVocalDensity || 'balanced').slice(0, 24),
      }));

    if (tracks.length === 0) {
      res.status(400).json({ error: 'Tracks array is required.' });
      return;
    }

    const buildFallbackEnrichments = () => {
      const enrichments: Record<string, any> = {};
      for (let i = 0; i < tracks.length; i++) {
        const t = tracks[i];
        const next = tracks[(i + 1) % tracks.length];
        const txt = `${t.title} ${t.artist}`.toLowerCase();
        const subGenre = /afro|amapiano/.test(txt)
          ? 'Afro / Amapiano'
          : /techno|acid|berlin/.test(txt)
          ? 'Peak Techno'
          : /phonk|trap|rap|hip.?hop/.test(txt)
          ? 'Trap / Hip-Hop'
          : /lofi|chill|sunset/.test(txt) || t.bpm <= 98
          ? 'Sunset Downtempo'
          : t.bpm >= 150
          ? 'DnB / Rave'
          : 'Club House';
        const crowdMoment = t.bpm >= 127 ? 'Peak' : t.bpm <= 106 ? 'Cooldown' : 'Opener';
        const energyScore = Math.max(2, Math.min(10, Math.round((t.bpm - 72) / 9)));
        enrichments[t.id] = {
          subGenre,
          mood: crowdMoment === 'Peak' ? 'Driving' : crowdMoment === 'Cooldown' ? 'Warm' : 'Groovy',
          crowdMoment,
          energyScore,
          chemistryNote:
            next && next.id !== t.id
              ? `Pairs cleanly with ${next.title.split('(')[0].trim().slice(0, 20)} (${t.musicalKey}→${next.musicalKey}).`
              : `Solid ${subGenre} anchor in ${t.musicalKey}.`,
          updatedAt: Date.now(),
        };
      }
      return { source: 'heuristic-fallback', enrichments };
    };

    const apiKey = process.env.GROQ_API_KEY?.trim();
    if (!apiKey) {
      res.json(buildFallbackEnrichments());
      return;
    }

    try {
      const systemPrompt = [
        'You are a musicologist and pro DJ crate curator.',
        'For every track ID provided, classify subGenre, mood, crowdMoment ("Opener" | "Peak" | "Cooldown"), energyScore (1-10 integer), and a concise 1-sentence chemistryNote explaining mashup/transition pairing.',
        'Return ONLY valid JSON: { "items": [ { "id": string, "subGenre": string, "mood": string, "crowdMoment": "Opener"|"Peak"|"Cooldown", "energyScore": number, "chemistryNote": string } ] }',
      ].join('\n');

      const upstream = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'llama-3.1-8b-instant',
          temperature: 0.35,
          max_tokens: 1400,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: JSON.stringify({ tracks }) },
          ],
        }),
        signal: AbortSignal.timeout(12000),
      });

      if (!upstream.ok) {
        res.json(buildFallbackEnrichments());
        return;
      }

      const data = (await upstream.json()) as any;
      const content = data?.choices?.[0]?.message?.content;
      const parsed = typeof content === 'string' ? JSON.parse(content) : {};
      const items = Array.isArray(parsed.items) ? parsed.items : [];
      const fallback = buildFallbackEnrichments();
      const enrichments: Record<string, any> = { ...fallback.enrichments };
      const validMoments = new Set(['Opener', 'Peak', 'Cooldown']);

      for (const item of items) {
        if (!item || typeof item.id !== 'string' || !enrichments[item.id]) continue;
        enrichments[item.id] = {
          subGenre: String(item.subGenre || enrichments[item.id].subGenre).slice(0, 32),
          mood: String(item.mood || enrichments[item.id].mood).slice(0, 24),
          crowdMoment: validMoments.has(item.crowdMoment)
            ? item.crowdMoment
            : enrichments[item.id].crowdMoment,
          energyScore: Number.isFinite(Number(item.energyScore))
            ? Math.max(1, Math.min(10, Math.round(Number(item.energyScore))))
            : enrichments[item.id].energyScore,
          chemistryNote: String(item.chemistryNote || enrichments[item.id].chemistryNote).slice(0, 140),
          updatedAt: Date.now(),
        };
      }

      res.json({ source: 'groq', enrichments });
    } catch {
      res.json(buildFallbackEnrichments());
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

  // Golden Mashup Finder across crate (llama-3.3-70b-versatile + Camelot/BPM fallback)
  app.post('/api/ai/golden-mashups', async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const rawTracks = Array.isArray(body.tracks) ? body.tracks.slice(0, 36) : [];
    const tracks = rawTracks
      .filter((t: any) => t && typeof t === 'object' && typeof t.id === 'string')
      .map((t: any) => ({
        id: String(t.id).slice(0, 80),
        title: String(t.title || 'Track').slice(0, 72),
        artist: String(t.artist || '').slice(0, 48),
        bpm: Number.isFinite(Number(t.bpm)) ? Math.round(Number(t.bpm) * 10) / 10 : 124,
        musicalKey: String(t.musicalKey || '8A').slice(0, 6),
        vocalDensity: String(t.detectedVocalDensity || 'balanced').slice(0, 20),
        hooks: Array.isArray(t.hookTexts)
          ? t.hookTexts.slice(0, 3).map((x: any) => String(x).slice(0, 36))
          : [],
      }));

    if (tracks.length < 2) {
      res.status(400).json({ error: 'At least 2 crate tracks are required.' });
      return;
    }

    const parseCam = (k: string) => {
      const m = /^(\d{1,2})([AB])$/i.exec(k.trim());
      return m ? { num: Number(m[1]), mode: m[2].toUpperCase() } : { num: 8, mode: 'A' };
    };
    const keyDistScore = (k1: string, k2: string) => {
      const a = parseCam(k1);
      const b = parseCam(k2);
      const wheel = Math.min(Math.abs(a.num - b.num), 12 - Math.abs(a.num - b.num));
      if (a.num === b.num && a.mode === b.mode) return 38;
      if (a.num === b.num && a.mode !== b.mode) return 33;
      if (wheel === 1 && a.mode === b.mode) return 31;
      if (wheel === 2 && a.mode === b.mode) return 22;
      return Math.max(8, 24 - wheel * 3);
    };

    const buildFallbackPairs = () => {
      const scored: any[] = [];
      for (let i = 0; i < tracks.length; i++) {
        for (let j = 0; j < tracks.length; j++) {
          if (i === j) continue;
          const v = tracks[i];
          const inst = tracks[j];
          const bpmSpread = Math.min(
            Math.abs(v.bpm - inst.bpm),
            Math.abs(v.bpm * 2 - inst.bpm),
            Math.abs(v.bpm * 0.5 - inst.bpm)
          );
          if (bpmSpread > 14) continue;
          const vBonus = v.vocalDensity === 'acapella' ? 28 : v.vocalDensity === 'vocal-dense' ? 22 : 10;
          const iBonus = inst.vocalDensity === 'instrumental' ? 28 : inst.vocalDensity === 'balanced' ? 16 : 2;
          const kScore = keyDistScore(v.musicalKey, inst.musicalKey);
          const bpmScore = Math.max(0, 24 - bpmSpread * 1.8);
          const score = Math.max(45, Math.min(99, Math.round(vBonus + iBonus + kScore + bpmScore - 14)));
          const tpl = inst.bpm >= 126 ? 'festival-double-drop' : inst.bpm <= 104 ? 'hiphop-cut' : 'club-groove-swap';
          scored.push({
            vocalTrackId: v.id,
            instTrackId: inst.id,
            vocalTitle: v.title,
            instTitle: inst.title,
            compatibilityScore: score,
            template: tpl,
            stemSwapMode: 'a-vocal-b-beat',
            reason: `${v.musicalKey} vocal over ${inst.musicalKey} groove (${Math.round(inst.bpm)} BPM · Δ${bpmSpread.toFixed(1)})`,
          });
        }
      }
      scored.sort((a, b) => b.compatibilityScore - a.compatibilityScore);
      const unique: any[] = [];
      const used = new Set<string>();
      for (const s of scored) {
        const pairKey = `${s.vocalTrackId}|${s.instTrackId}`;
        if (used.has(pairKey)) continue;
        used.add(pairKey);
        unique.push(s);
        if (unique.length >= 4) break;
      }
      return { source: 'heuristic-fallback', pairs: unique };
    };

    const apiKey = process.env.GROQ_API_KEY?.trim();
    if (!apiKey) {
      res.json(buildFallbackPairs());
      return;
    }

    try {
      const systemPrompt = [
        'You are a world-class mashup producer analyzing a DJ crate.',
        'Pick up to 4 Golden Mashup pairs pairing a vocal-heavy track (vocalTrackId) over a clean groove/instrumental track (instTrackId).',
        'Favor harmonic Camelot matches, BPM within +/-10% (or half/double time), and vocal/instrumental contrast.',
        'Return ONLY JSON: { "pairs": [ { "vocalTrackId": string, "instTrackId": string, "compatibilityScore": number (60..99), "template": "festival-double-drop"|"hiphop-cut"|"club-groove-swap"|"dub-echo-flip", "stemSwapMode": "a-vocal-b-beat"|"b-vocal-a-beat"|"dual-hook", "reason": string (<= 95 chars) } ] }',
      ].join('\n');

      const upstream = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          temperature: 0.35,
          max_tokens: 700,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: JSON.stringify({ tracks }) },
          ],
        }),
        signal: AbortSignal.timeout(12000),
      });

      if (!upstream.ok) {
        res.json(buildFallbackPairs());
        return;
      }

      const data = (await upstream.json()) as any;
      const parsed = JSON.parse(data?.choices?.[0]?.message?.content || '{}');
      const byId = new Map<string, any>(tracks.map((t: any) => [String(t.id), t]));
      const validTemplates = new Set(['festival-double-drop', 'hiphop-cut', 'club-groove-swap', 'dub-echo-flip']);
      const validSwaps = new Set(['a-vocal-b-beat', 'b-vocal-a-beat', 'dual-hook']);
      const pairs = (Array.isArray(parsed.pairs) ? parsed.pairs : [])
        .filter((p: any) => p && byId.has(p.vocalTrackId) && byId.has(p.instTrackId) && p.vocalTrackId !== p.instTrackId)
        .slice(0, 4)
        .map((p: any) => ({
          vocalTrackId: p.vocalTrackId,
          instTrackId: p.instTrackId,
          vocalTitle: byId.get(p.vocalTrackId)!.title,
          instTitle: byId.get(p.instTrackId)!.title,
          compatibilityScore: Number.isFinite(Number(p.compatibilityScore))
            ? Math.max(55, Math.min(99, Math.round(Number(p.compatibilityScore))))
            : 88,
          template: validTemplates.has(p.template) ? p.template : 'club-groove-swap',
          stemSwapMode: validSwaps.has(p.stemSwapMode) ? p.stemSwapMode : 'a-vocal-b-beat',
          reason: String(p.reason || 'Complementary Camelot vocal-over-groove blend').slice(0, 100),
        }));

      res.json(pairs.length > 0 ? { source: 'groq', pairs } : buildFallbackPairs());
    } catch {
      res.json(buildFallbackPairs());
    }
  });

  // Crate Gap-Filler & Smart Bridge Search (llama-3.1-8b-instant)
  app.post('/api/ai/gap-filler', async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const query = String(body.query || '').trim().slice(0, 260);
    const contextTracks = Array.isArray(body.tracks) ? body.tracks.slice(0, 20) : [];
    if (!query) {
      res.status(400).json({ error: 'Bridge search prompt is required.' });
      return;
    }

    const buildFallbackGap = () => {
      const nums = Array.from(query.matchAll(/\b(\d{2,3})\s*(?:bpm)?\b/gi))
        .map((m) => Number(m[1]))
        .filter((n) => n >= 60 && n <= 190);
      const lowBpm = nums.length >= 2 ? Math.min(nums[0], nums[1]) : nums[0] || 116;
      const highBpm = nums.length >= 2 ? Math.max(nums[0], nums[1]) : Math.min(140, lowBpm + 10);
      const midBpm = Math.round((lowBpm + highBpm) * 0.5);
      const targetBpmMin = Math.max(68, midBpm - 3);
      const targetBpmMax = Math.min(180, midBpm + 3);
      const vibeHint = /afro|amapiano/i.test(query)
        ? 'afro house'
        : /hip.?hop|trap|rap/i.test(query)
        ? 'hip hop house edit'
        : /techno|acid/i.test(query)
        ? 'melodic techno'
        : 'club remix';
      return {
        source: 'heuristic-fallback',
        summary: `Bridge target ${targetBpmMin}-${targetBpmMax} BPM (${vibeHint}) for smooth energy ramp.`,
        targetBpmMin,
        targetBpmMax,
        targetKeys: ['8A', '9A', '8B'],
        vibeNote: `Halfway tempo bridge around ${midBpm} BPM with clean percussive intro.`,
        searchQueries: [
          `${midBpm} bpm ${vibeHint} dj edit`,
          `${midBpm} bpm house transition remix`,
          `${vibeHint} ${targetBpmMin} to ${targetBpmMax} bpm`,
        ],
      };
    };

    const apiKey = process.env.GROQ_API_KEY?.trim();
    if (!apiKey) {
      res.json(buildFallbackGap());
      return;
    }

    try {
      const systemPrompt = [
        'You are a DJ crate bridge specialist.',
        'Analyze the user gap query (e.g. bridging Track A at 116 BPM to Track B at 128 BPM) and suggest exact bridge BPM range, Camelot keys, vibe note, and 3 crisp YouTube search queries for finding DJ-friendly bridge tracks.',
        'Return ONLY valid JSON: { "summary": string, "targetBpmMin": number, "targetBpmMax": number, "targetKeys": string[], "vibeNote": string, "searchQueries": string[] }',
      ].join('\n');

      const upstream = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'llama-3.1-8b-instant',
          temperature: 0.4,
          max_tokens: 450,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: JSON.stringify({ query, contextTracks }) },
          ],
        }),
        signal: AbortSignal.timeout(10000),
      });

      if (!upstream.ok) {
        res.json(buildFallbackGap());
        return;
      }

      const data = (await upstream.json()) as any;
      const parsed = JSON.parse(data?.choices?.[0]?.message?.content || '{}');
      const fb = buildFallbackGap();
      const queries = Array.isArray(parsed.searchQueries)
        ? parsed.searchQueries.map((s: any) => String(s).trim().slice(0, 72)).filter(Boolean).slice(0, 4)
        : [];
      res.json({
        source: 'groq',
        summary: String(parsed.summary || fb.summary).slice(0, 140),
        targetBpmMin: Number.isFinite(Number(parsed.targetBpmMin)) ? Math.max(60, Math.min(185, Math.round(Number(parsed.targetBpmMin)))) : fb.targetBpmMin,
        targetBpmMax: Number.isFinite(Number(parsed.targetBpmMax)) ? Math.max(65, Math.min(190, Math.round(Number(parsed.targetBpmMax)))) : fb.targetBpmMax,
        targetKeys: Array.isArray(parsed.targetKeys) && parsed.targetKeys.length > 0
          ? parsed.targetKeys.slice(0, 4).map((k: any) => String(k).slice(0, 6))
          : fb.targetKeys,
        vibeNote: String(parsed.vibeNote || fb.vibeNote).slice(0, 140),
        searchQueries: queries.length > 0 ? queries : fb.searchQueries,
      });
    } catch {
      res.json(buildFallbackGap());
    }
  });

  // Auto Chapter & Mix-Story Exporter (llama-3.3-70b-versatile)
  app.post('/api/ai/mix-story', async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const title = String(body.title || 'DJOne Mix').slice(0, 80);
    const cueSheetText = String(body.cueSheetText || '').slice(0, 4000);
    const durationSec = Number.isFinite(Number(body.durationSec)) ? Math.max(10, Number(body.durationSec)) : 120;
    const hooks = Array.isArray(body.hooks) ? body.hooks.slice(0, 12).map((h: any) => String(h).slice(0, 64)) : [];

    const buildFallbackStory = () => {
      const lines = cueSheetText
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => /^\d{2}:\d{2}(:\d{2})?\s+/.test(l));
      const chapters = lines.length > 0
        ? lines.map((l) => {
            const sp = l.indexOf(' ');
            const ts = l.slice(0, sp);
            const rest = l.slice(sp + 1);
            return { timestamp: ts, label: rest.replace(/\[.*?\]/, '').trim(), note: rest.match(/\[(.*?)\]/)?.[1] || '' };
          })
        : [{ timestamp: '00:00', label: title, note: `${Math.round(durationSec)}s Studio Mix` }];
      const youtubeChapters = chapters.map((c) => `${c.timestamp} ${c.label}`).join('\n');
      const mixcloudTracklist = chapters.map((c, idx) => `${idx + 1}. ${c.label} (${c.timestamp})`).join('\n');
      return {
        source: 'heuristic-fallback',
        headline: `${title} — Live Harmonics & Beat-Locked Transitions`,
        youtubeChapters,
        mixcloudTracklist,
        storySummary: `A ${Math.max(1, Math.round(durationSec / 60))}-minute seamless DJOne journey featuring harmonic stem blends${hooks.length > 0 ? ` and standout vocal hooks (${hooks.slice(0, 3).join(', ')})` : ''}.`,
        socialCaption: `New mix live now: ${title} 🎧 Seamless key-locked blends & club drops. Drop your favorite transition timestamp below! #DJMix #ElectronicMusic`,
        chapters,
      };
    };

    const apiKey = process.env.GROQ_API_KEY?.trim();
    if (!apiKey) {
      res.json(buildFallbackStory());
      return;
    }

    try {
      const systemPrompt = [
        'You are a music curator writing mix liner notes, YouTube timestamp chapters, and social promo copy for a DJ set.',
        'Use the exact timestamps present in cueSheetText.',
        'Return ONLY JSON: { "headline": string, "storySummary": string (2-3 sentences), "socialCaption": string (<= 220 chars), "youtubeChapters": string (multiline "00:00 Track"), "mixcloudTracklist": string (numbered multiline) }',
      ].join('\n');

      const upstream = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          temperature: 0.55,
          max_tokens: 800,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: JSON.stringify({ title, durationSec, cueSheetText, hooks }) },
          ],
        }),
        signal: AbortSignal.timeout(12000),
      });

      if (!upstream.ok) {
        res.json(buildFallbackStory());
        return;
      }

      const data = (await upstream.json()) as any;
      const parsed = JSON.parse(data?.choices?.[0]?.message?.content || '{}');
      const fb = buildFallbackStory();
      res.json({
        source: 'groq',
        headline: String(parsed.headline || fb.headline).slice(0, 120),
        storySummary: String(parsed.storySummary || fb.storySummary).slice(0, 420),
        socialCaption: String(parsed.socialCaption || fb.socialCaption).slice(0, 260),
        youtubeChapters: String(parsed.youtubeChapters || fb.youtubeChapters).slice(0, 2000),
        mixcloudTracklist: String(parsed.mixcloudTracklist || fb.mixcloudTracklist).slice(0, 2000),
        chapters: fb.chapters,
      });
    } catch {
      res.json(buildFallbackStory());
    }
  });

  // Fred again..-style Auto Vocal-Chop Solo Word & Melody Selector (llama-3.1-8b-instant)
  app.post('/api/ai/vocal-chop-solo', async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const title = String(body.title || 'Track').slice(0, 80);
    const musicalKey = String(body.musicalKey || '8A').slice(0, 6);
    const durationSec = Number.isFinite(Number(body.durationSec)) ? Math.max(10, Number(body.durationSec)) : 180;
    const words = Array.isArray(body.words)
      ? body.words.slice(0, 140).filter((w: any) => w && typeof w.word === 'string' && Number.isFinite(Number(w.startSec)))
      : [];

    const buildFallbackChop = () => {
      const vowels = words.filter((w: any) => w.word.trim().length >= 3 && w.startSec >= 6 && w.startSec <= durationSec - 6);
      const chosen = vowels[Math.min(vowels.length - 1, Math.floor(vowels.length * 0.45))] || null;
      const isMajor = musicalKey.toUpperCase().endsWith('B');
      const pentatonicSemitones = isMajor ? [0, 2, 4, 7, 9, 12, 9, 7] : [0, 3, 5, 7, 10, 12, 10, 7];
      return {
        source: 'heuristic-fallback',
        word: chosen ? String(chosen.word).trim().slice(0, 20) : 'chorus-chop',
        cueSec: chosen ? Math.round(Number(chosen.startSec) * 100) / 100 : Math.round(durationSec * 0.34 * 100) / 100,
        pentatonicSemitones,
        moodNote: `8-bar ${musicalKey} pentatonic chop solo over warm chord swell`,
      };
    };

    const apiKey = process.env.GROQ_API_KEY?.trim();
    if (!apiKey || words.length < 3) {
      res.json(buildFallbackChop());
      return;
    }

    try {
      const systemPrompt = [
        'Pick ONE resonant single sung word from the provided timestamped words list ideal for a Fred again..-style pitched vocal-chop melodic solo, plus an 8-note semitone sequence inside [-5..12].',
        'Return ONLY JSON: { "word": string, "cueSec": number, "pentatonicSemitones": number[] (length 8, integers -5..12), "moodNote": string }',
      ].join('\n');

      const upstream = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'llama-3.1-8b-instant',
          temperature: 0.4,
          max_tokens: 260,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: JSON.stringify({ title, musicalKey, words: words.slice(0, 75) }) },
          ],
        }),
        signal: AbortSignal.timeout(9000),
      });

      if (!upstream.ok) {
        res.json(buildFallbackChop());
        return;
      }
      const data = (await upstream.json()) as any;
      const parsed = JSON.parse(data?.choices?.[0]?.message?.content || '{}');
      const fb = buildFallbackChop();
      const semis = Array.isArray(parsed.pentatonicSemitones)
        ? parsed.pentatonicSemitones
            .slice(0, 8)
            .map((n: any) => (Number.isFinite(Number(n)) ? Math.max(-5, Math.min(12, Math.round(Number(n)))) : 0))
        : [];
      res.json({
        source: 'groq',
        word: String(parsed.word || fb.word).slice(0, 24),
        cueSec: Number.isFinite(Number(parsed.cueSec))
          ? Math.max(1, Math.min(durationSec - 2, Number(parsed.cueSec)))
          : fb.cueSec,
        pentatonicSemitones: semis.length >= 4 ? semis : fb.pentatonicSemitones,
        moodNote: String(parsed.moodNote || fb.moodNote).slice(0, 100),
      });
    } catch {
      res.json(buildFallbackChop());
    }
  });

  // A/B/C Auditionable VIP Drop Variations (llama-3.3-70b-versatile)
  app.post('/api/ai/vip-variations', async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const prompt = String(body.prompt || 'High-impact festival VIP flip').trim().slice(0, 260);
    const titleA = String(body.titleA || 'Deck A').slice(0, 60);
    const titleB = String(body.titleB || 'Deck B').slice(0, 60);

    const buildFallbackVars = () => ({
      source: 'heuristic-fallback',
      variations: [
        {
          id: 'A',
          name: 'A · Festival Double Drop',
          tagline: 'HPF tension -> vocal swell -> 4x4 punch',
          vibe: 'festival-drop',
          aggressiveness: 82,
          mashupTemplate: 'festival-double-drop',
          bootlegFlip: 'off',
          harmonicSynthLayer: 'supersaw-pad',
          flipBridgePattern: 'house-4x4',
          reverseVocalSwell: true,
          tapeStopDropPrep: false,
          filterEnvelope: 'hpf-tension',
        },
        {
          id: 'B',
          name: 'B · Jersey / Phonk Chop',
          tagline: 'Triplet jersey bounce + tape-brake slam',
          vibe: 'scratch-chop',
          aggressiveness: 88,
          mashupTemplate: 'hiphop-cut',
          bootlegFlip: 'jersey-club',
          harmonicSynthLayer: 'off',
          flipBridgePattern: 'sub-808',
          reverseVocalSwell: false,
          tapeStopDropPrep: true,
          filterEnvelope: 'lpf-drop-open',
        },
        {
          id: 'C',
          name: 'C · Acid Club Dub',
          tagline: '303 arp + afro/dub groove echo swap',
          vibe: 'techno-hypnotic',
          aggressiveness: 68,
          mashupTemplate: 'dub-echo-flip',
          bootlegFlip: 'amapiano',
          harmonicSynthLayer: 'acid-303',
          flipBridgePattern: 'afro-perc',
          reverseVocalSwell: true,
          tapeStopDropPrep: true,
          filterEnvelope: 'dark-warm',
        },
      ],
    });

    const apiKey = process.env.GROQ_API_KEY?.trim();
    if (!apiKey) {
      res.json(buildFallbackVars());
      return;
    }

    try {
      const systemPrompt = [
        'Generate 3 contrasting DJ VIP drop variations ("A", "B", "C") tailored to the user prompt so the DJ can audition 8-bar previews side-by-side.',
        'Return ONLY JSON: { "variations": [ { "id": "A"|"B"|"C", "name": string, "tagline": string, "vibe": "club-blend"|"festival-drop"|"techno-hypnotic"|"scratch-chop"|"mashup-live"|"chill-sunset", "aggressiveness": number (35..95), "mashupTemplate": "club-groove-swap"|"festival-double-drop"|"hiphop-cut"|"dub-echo-flip", "bootlegFlip": "off"|"jersey-club"|"amapiano"|"phonk"|"slowed-reverb"|"nightcore", "harmonicSynthLayer": "off"|"supersaw-pad"|"acid-303"|"sidechain-arp", "flipBridgePattern": "off"|"top-hats"|"house-4x4"|"sub-808"|"afro-perc"|"chord-arp", "reverseVocalSwell": boolean, "tapeStopDropPrep": boolean, "filterEnvelope": "none"|"dark-warm"|"lpf-drop-open"|"hpf-tension" } ] }',
      ].join('\n');

      const upstream = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          temperature: 0.65,
          max_tokens: 900,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: JSON.stringify({ prompt, titleA, titleB }) },
          ],
        }),
        signal: AbortSignal.timeout(12000),
      });

      if (!upstream.ok) {
        res.json(buildFallbackVars());
        return;
      }

      const data = (await upstream.json()) as any;
      const parsed = JSON.parse(data?.choices?.[0]?.message?.content || '{}');
      const fb = buildFallbackVars();
      const rawVars = Array.isArray(parsed.variations) ? parsed.variations : [];
      if (rawVars.length < 3) {
        res.json(fb);
        return;
      }

      const validVibes = new Set(['club-blend', 'festival-drop', 'techno-hypnotic', 'scratch-chop', 'mashup-live', 'chill-sunset']);
      const validTpl = new Set(['club-groove-swap', 'festival-double-drop', 'hiphop-cut', 'dub-echo-flip']);
      const validBoot = new Set(['off', 'jersey-club', 'amapiano', 'phonk', 'slowed-reverb', 'nightcore']);
      const validSynth = new Set(['off', 'supersaw-pad', 'acid-303', 'sidechain-arp']);
      const validBridge = new Set(['off', 'top-hats', 'house-4x4', 'sub-808', 'afro-perc', 'chord-arp']);
      const validEnv = new Set(['none', 'dark-warm', 'lpf-drop-open', 'hpf-tension']);

      const ids: ('A' | 'B' | 'C')[] = ['A', 'B', 'C'];
      const variations = ids.map((slotId, i) => {
        const item = rawVars[i] || {};
        const dflt = fb.variations[i];
        return {
          id: slotId,
          name: String(item.name || dflt.name).slice(0, 42),
          tagline: String(item.tagline || dflt.tagline).slice(0, 68),
          vibe: validVibes.has(item.vibe) ? item.vibe : dflt.vibe,
          aggressiveness: Number.isFinite(Number(item.aggressiveness))
            ? Math.max(25, Math.min(98, Math.round(Number(item.aggressiveness))))
            : dflt.aggressiveness,
          mashupTemplate: validTpl.has(item.mashupTemplate) ? item.mashupTemplate : dflt.mashupTemplate,
          bootlegFlip: validBoot.has(item.bootlegFlip) ? item.bootlegFlip : dflt.bootlegFlip,
          harmonicSynthLayer: validSynth.has(item.harmonicSynthLayer) ? item.harmonicSynthLayer : dflt.harmonicSynthLayer,
          flipBridgePattern: validBridge.has(item.flipBridgePattern) ? item.flipBridgePattern : dflt.flipBridgePattern,
          reverseVocalSwell: typeof item.reverseVocalSwell === 'boolean' ? item.reverseVocalSwell : dflt.reverseVocalSwell,
          tapeStopDropPrep: typeof item.tapeStopDropPrep === 'boolean' ? item.tapeStopDropPrep : dflt.tapeStopDropPrep,
          filterEnvelope: validEnv.has(item.filterEnvelope) ? item.filterEnvelope : dflt.filterEnvelope,
        };
      });

      res.json({ source: 'groq', variations });
    } catch {
      res.json(buildFallbackVars());
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
