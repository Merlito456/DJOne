import {
  AiDjVibe,
  CleanEditWindow,
  GapFillerResult,
  GoldenMashupPair,
  GroqDirectorPlan,
  GroqLiveDirectorResponse,
  GroqVoicePersona,
  LyricCueWord,
  MixStoryExport,
  OfflineRenderMode,
  ReactiveAdLibKind,
  TrackEnrichment,
  TrackItem,
  TrackLyricCues,
  VipDropVariation,
  VocalChopSoloPlan,
} from '../types/dj';

export async function requestGroqRemixDirector(params: {
  mode: OfflineRenderMode;
  vibe: AiDjVibe;
  directionPrompt?: string;
  tracks: Pick<TrackItem, 'title' | 'artist' | 'bpm' | 'musicalKey' | 'detectedVocalDensity'>[];
}): Promise<GroqDirectorPlan> {
  const response = await fetch('/api/ai/remix-director', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mode: params.mode,
      vibe: params.vibe,
      directionPrompt: params.directionPrompt || '',
      tracks: params.tracks.map((t) => ({
        title: t.title,
        artist: t.artist,
        bpm: t.bpm,
        musicalKey: t.musicalKey,
        detectedVocalDensity: t.detectedVocalDensity || 'balanced',
      })),
    }),
  });

  if (!response.ok) {
    throw new Error(`Groq AI Director failed (${response.status})`);
  }
  return (await response.json()) as GroqDirectorPlan;
}

export async function fetchGroqTtsDropBuffer(params: {
  text: string;
  voice?: GroqVoicePersona;
  audioCtx: BaseAudioContext;
}): Promise<AudioBuffer | null> {
  const cleanText = params.text.trim();
  if (!cleanText) return null;

  try {
    const response = await fetch('/api/ai/tts-drop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: cleanText,
        voice: params.voice || 'troy',
      }),
    });

    if (!response.ok) {
      return null;
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('audio')) {
      return null;
    }

    const arrayBuf = await response.arrayBuffer();
    if (arrayBuf.byteLength < 512) return null;
    return await params.audioCtx.decodeAudioData(arrayBuf.slice(0));
  } catch {
    return null;
  }
}

export function encodeAudioBufferTo16kMonoWavBase64(
  buffer: AudioBuffer,
  startSec = 0,
  maxDurationSec = 75
): string {
  const srcRate = buffer.sampleRate;
  const targetRate = 16000;
  const clampedStart = Math.max(0, Math.min(Math.max(0, buffer.duration - 2), startSec));
  const sliceDur = Math.max(2, Math.min(maxDurationSec, buffer.duration - clampedStart));
  const outSamples = Math.min(targetRate * 75, Math.max(1600, Math.floor(sliceDur * targetRate)));
  const numCh = Math.min(2, buffer.numberOfChannels);
  const ch0 = buffer.getChannelData(0);
  const ch1 = numCh > 1 ? buffer.getChannelData(1) : ch0;

  const dataSize = outSamples * 2;
  const ab = new ArrayBuffer(44 + dataSize);
  const view = new DataView(ab);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, targetRate, true);
  view.setUint32(28, targetRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  const step = srcRate / targetRate;
  const startFrame = Math.floor(clampedStart * srcRate);
  for (let i = 0; i < outSamples; i++) {
    const srcIdx = Math.min(buffer.length - 1, Math.floor(startFrame + i * step));
    const mono = Math.max(-1, Math.min(1, (ch0[srcIdx] + ch1[srcIdx]) * 0.5));
    view.setInt16(44 + i * 2, mono < 0 ? mono * 0x8000 : mono * 0x7fff, true);
  }

  const bytes = new Uint8Array(ab);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export async function requestGroqWhisperCues(params: {
  buffer?: AudioBuffer | null;
  title: string;
  durationSec: number;
  offsetSec?: number;
}): Promise<TrackLyricCues> {
  const offsetSec = params.offsetSec ?? (params.buffer && params.buffer.duration > 90 ? 15 : 0);
  const audioBase64 = params.buffer
    ? encodeAudioBufferTo16kMonoWavBase64(params.buffer, offsetSec, 75)
    : '';

  const response = await fetch('/api/ai/transcribe-cues', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      audioBase64,
      offsetSec,
      durationSec: params.durationSec,
      title: params.title,
    }),
  });

  if (!response.ok) {
    throw new Error(`Whisper cue scan failed (${response.status})`);
  }
  return (await response.json()) as TrackLyricCues;
}

export async function requestGroqLiveDirector(params: {
  prompt: string;
  stationName?: string;
  currentTrackId?: string;
  tracks: Pick<
    TrackItem,
    'id' | 'title' | 'artist' | 'bpm' | 'musicalKey' | 'detectedVocalDensity' | 'enrichment'
  >[];
}): Promise<GroqLiveDirectorResponse> {
  const response = await fetch('/api/ai/live-director', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: params.prompt,
      stationName: params.stationName || 'DJOne',
      currentTrackId: params.currentTrackId || '',
      tracks: params.tracks,
    }),
  });

  if (!response.ok) {
    throw new Error(`Live Director failed (${response.status})`);
  }
  return (await response.json()) as GroqLiveDirectorResponse;
}

export async function requestGroqCrateEnrich(params: {
  tracks: Pick<TrackItem, 'id' | 'title' | 'artist' | 'bpm' | 'musicalKey' | 'detectedVocalDensity'>[];
}): Promise<{ source: string; enrichments: Record<string, TrackEnrichment> }> {
  const response = await fetch('/api/ai/crate-enrich', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tracks: params.tracks }),
  });
  if (!response.ok) {
    throw new Error(`Crate enrichment failed (${response.status})`);
  }
  return (await response.json()) as { source: string; enrichments: Record<string, TrackEnrichment> };
}

export function buildDynamicHostDropScript(params: {
  stationName?: string;
  fromTrack?: TrackItem | null;
  toTrack?: TrackItem | null;
  vibe?: AiDjVibe;
}): string {
  const station = (params.stationName || 'DJOne').trim().slice(0, 28) || 'DJOne';
  const fromBpm = params.fromTrack ? Math.round(params.fromTrack.bpm) : null;
  const toBpm = params.toTrack ? Math.round(params.toTrack.bpm) : null;
  const toTitle = params.toTrack
    ? params.toTrack.title.split('(')[0].trim().slice(0, 28)
    : 'this next heater';
  if (fromBpm && toBpm && Math.abs(fromBpm - toBpm) >= 3) {
    return `[cheerful] ${station} live in the mix! Stepping from ${fromBpm} up to ${toBpm} BPM — lock in for ${toTitle}!`;
  }
  if (params.vibe === 'chill-sunset') {
    return `[warm] You're tuned to ${station} after hours. Smooth velvet blend into ${toTitle}.`;
  }
  return `[cheerful] ${station} exclusive! Hands in the air as we drop ${toTitle} right now!`;
}

const LOCAL_EXPLICIT_WORDS = new Set([
  'fuck', 'fucking', 'fucked', 'fucker', 'motherfucker', 'shit', 'shitty', 'bullshit',
  'bitch', 'bitches', 'asshole', 'bastard', 'damn', 'hell', 'crap', 'dick', 'cock',
  'pussy', 'whore', 'slut', 'cunt', 'nigga', 'nigger', 'fag', 'faggot', 'hoe',
]);

export function detectExplicitWindowsLocally(
  words: LyricCueWord[] | undefined,
  title: string,
  durationSec: number
): CleanEditWindow[] {
  if (words && words.length > 0) {
    const hits: CleanEditWindow[] = [];
    for (const w of words) {
      const clean = w.word.toLowerCase().replace(/[^a-z']/g, '');
      if (clean && LOCAL_EXPLICIT_WORDS.has(clean)) {
        hits.push({
          startSec: Math.max(0, w.startSec - 0.04),
          endSec: Math.max(w.startSec + 0.18, w.endSec + 0.04),
          word: `${clean.slice(0, 1)}***`,
        });
      }
    }
    return hits.slice(0, 64);
  }
  const titleTokens = title.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/);
  if (titleTokens.some((t) => LOCAL_EXPLICIT_WORDS.has(t)) || /\bexplicit\b/i.test(title)) {
    return [
      { startSec: Math.max(2, durationSec * 0.28), endSec: Math.max(2.42, durationSec * 0.28 + 0.42), word: 'e***' },
      { startSec: Math.max(4, durationSec * 0.62), endSec: Math.max(4.42, durationSec * 0.62 + 0.42), word: 'e***' },
    ];
  }
  return [];
}

export async function requestGoldenMashups(params: {
  tracks: Pick<TrackItem, 'id' | 'title' | 'artist' | 'bpm' | 'musicalKey' | 'detectedVocalDensity' | 'lyricCues'>[];
}): Promise<{ source: string; pairs: GoldenMashupPair[] }> {
  const response = await fetch('/api/ai/golden-mashups', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tracks: params.tracks.map((t) => ({
        id: t.id,
        title: t.title,
        artist: t.artist,
        bpm: t.bpm,
        musicalKey: t.musicalKey,
        detectedVocalDensity: t.detectedVocalDensity || 'balanced',
        hookTexts: t.lyricCues?.hookPhrases?.map((h) => h.text) || [],
      })),
    }),
  });
  if (!response.ok) {
    throw new Error(`Golden Mashups scan failed (${response.status})`);
  }
  return (await response.json()) as { source: string; pairs: GoldenMashupPair[] };
}

export async function requestGapFiller(params: {
  query: string;
  tracks: Pick<TrackItem, 'title' | 'bpm' | 'musicalKey'>[];
}): Promise<GapFillerResult> {
  const response = await fetch('/api/ai/gap-filler', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!response.ok) {
    throw new Error(`Gap-Filler query failed (${response.status})`);
  }
  return (await response.json()) as GapFillerResult;
}

export async function requestMixStory(params: {
  title: string;
  durationSec: number;
  cueSheetText?: string;
  hooks?: string[];
}): Promise<MixStoryExport> {
  const response = await fetch('/api/ai/mix-story', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!response.ok) {
    throw new Error(`Mix Story export failed (${response.status})`);
  }
  return (await response.json()) as MixStoryExport;
}

export async function requestVocalChopSolo(params: {
  title: string;
  musicalKey: string;
  durationSec: number;
  words?: LyricCueWord[];
}): Promise<VocalChopSoloPlan> {
  const response = await fetch('/api/ai/vocal-chop-solo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!response.ok) {
    throw new Error(`Vocal Chop Solo failed (${response.status})`);
  }
  return (await response.json()) as VocalChopSoloPlan;
}

export async function requestVipVariations(params: {
  prompt: string;
  titleA: string;
  titleB: string;
}): Promise<{ source: string; variations: VipDropVariation[] }> {
  const response = await fetch('/api/ai/vip-variations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!response.ok) {
    throw new Error(`VIP Variations failed (${response.status})`);
  }
  return (await response.json()) as { source: string; variations: VipDropVariation[] };
}

export async function preloadReactiveAdLibs(
  audioCtx: BaseAudioContext
): Promise<Partial<Record<ReactiveAdLibKind, AudioBuffer>>> {
  const scripts: { kind: ReactiveAdLibKind; text: string; voice: GroqVoicePersona }[] = [
    { kind: 'backspin', text: '[cheerful] Run that back!', voice: 'troy' },
    { kind: 'wild-take', text: '[excited] Bass swap incoming!', voice: 'daniel' },
    { kind: 'drop-slam', text: '[cheerful] Double drop!', voice: 'troy' },
  ];
  const entries = await Promise.all(
    scripts.map(async (item) => {
      const buf = await fetchGroqTtsDropBuffer({
        text: item.text,
        voice: item.voice,
        audioCtx,
      });
      return [item.kind, buf] as const;
    })
  );
  const result: Partial<Record<ReactiveAdLibKind, AudioBuffer>> = {};
  for (const [k, buf] of entries) {
    if (buf) result[k] = buf;
  }
  return result;
}
