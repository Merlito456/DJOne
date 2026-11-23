import {
  AiDjVibe,
  GroqDirectorPlan,
  GroqVoicePersona,
  OfflineRenderMode,
  TrackItem,
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
