import {
  AnyVoiceDropId,
  CustomVoiceDropMeta,
  CustomVoiceSlotId,
  DjVoiceCategory,
  DjVoiceDropId,
  DjVoicePresetMeta,
  VoiceFrequencyMode,
} from '../types/dj';

export const CUSTOM_VOICE_SLOT_IDS: CustomVoiceSlotId[] = [
  'custom-1',
  'custom-2',
  'custom-3',
  'custom-4',
];

export function isCustomVoiceDropId(id: AnyVoiceDropId | string): id is CustomVoiceSlotId {
  return typeof id === 'string' && id.startsWith('custom-');
}


export const DJ_VOICE_CATEGORIES: { id: DjVoiceCategory; label: string }[] = [
  { id: 'shout', label: 'Shout' },
  { id: 'hype', label: 'Hype' },
  { id: 'groove', label: 'Groove' },
  { id: 'countdown', label: 'Count' },
  { id: 'scratch-vox', label: 'Scratch' },
];

export const DJ_VOICE_LIBRARY: DjVoicePresetMeta[] = [
  // Shouts (5)
  {
    id: 'hey-chant',
    label: 'Hey! x3',
    calloutText: 'Hey! Hey! Hey!',
    category: 'shout',
    energyMin: 40,
    chillSafe: false,
    description: '3-beat stadium crowd shout chant with stereo club room slapback',
  },
  {
    id: 'lets-go',
    label: "Let's Go!",
    calloutText: "Let's Go!",
    category: 'shout',
    energyMin: 45,
    chillSafe: false,
    description: 'Punchy double-syllable MC drop callout',
  },
  {
    id: 'hands-up',
    label: 'Hands Up!',
    calloutText: 'Hands Up!',
    category: 'shout',
    energyMin: 55,
    chillSafe: false,
    description: 'Rising festival crowd shout for pre-drop builds',
  },
  {
    id: 'put-em-up',
    label: "Put 'Em Up",
    calloutText: "Put 'Em Up!",
    category: 'shout',
    energyMin: 55,
    chillSafe: false,
    description: 'Syncopated 3-hit club MC shout',
  },
  {
    id: 'make-some-noise',
    label: 'Make Noise!',
    calloutText: 'Make Some Noise!',
    category: 'shout',
    energyMin: 60,
    chillSafe: false,
    description: 'Wide arena crowd shout with stadium reverb tail',
  },

  // Hype (5)
  {
    id: 'crowd-roar',
    label: 'Crowd Roar',
    calloutText: 'Stadium Crowd Roar',
    category: 'hype',
    energyMin: 45,
    chillSafe: false,
    description: 'Filtered festival crowd cheer & stereo vocal swell',
  },
  {
    id: 'everybody-jump',
    label: 'Jump! x4',
    calloutText: 'Jump! Jump! Jump!',
    category: 'hype',
    energyMin: 65,
    chillSafe: false,
    description: 'Quarter-note quantized bounce chant synced to track BPM',
  },
  {
    id: 'pump-it',
    label: 'Pump It!',
    calloutText: 'Pump It Up!',
    category: 'hype',
    energyMin: 50,
    chillSafe: false,
    description: 'Driving rhythmic 3-hit MC hype push',
  },
  {
    id: 'turn-it-up',
    label: 'Turn It Up',
    calloutText: 'Turn It Up!',
    category: 'hype',
    energyMin: 48,
    chillSafe: false,
    description: 'Upward sweeping formant boost callout',
  },
  {
    id: 'oh-my-god',
    label: 'Whoa Drop!',
    calloutText: 'Whoa! Drop!',
    category: 'hype',
    energyMin: 60,
    chillSafe: false,
    description: 'High-impact formant gasp into crowd shout',
  },

  // Grooving (6)
  {
    id: 'groove-yeah',
    label: 'Oooo-Yeah',
    calloutText: 'Oooo-Yeah!',
    category: 'groove',
    energyMin: 0,
    chillSafe: true,
    description: 'Soulful diphthong formant slide with warm stereo club delay',
  },
  {
    id: 'ah-yeah-chop',
    label: 'Ah-Yeah Cut',
    calloutText: 'Ah-Ah-Yeah!',
    category: 'groove',
    energyMin: 25,
    chillSafe: true,
    description: 'Beat-synced 1/8th rhythmic vocal chop groove',
  },
  {
    id: 'funk-woo',
    label: 'Club Woo!',
    calloutText: 'Woo!',
    category: 'groove',
    energyMin: 30,
    chillSafe: false,
    description: 'Soaring disco/house falsetto pitch scoop',
  },
  {
    id: 'afro-eyy',
    label: 'Ayy-O!',
    calloutText: 'Ayy-O! Ayy-O!',
    category: 'groove',
    energyMin: 30,
    chillSafe: true,
    description: 'Two-tone Afro/Latin call-and-response groove chant',
  },
  {
    id: 'vocoder-harmony',
    label: 'Key Vocoder',
    calloutText: 'In-Key Vocoder Vox',
    category: 'groove',
    energyMin: 0,
    chillSafe: true,
    description: 'Camelot-tuned 3-voice formant chord glide synced to song key',
  },
  {
    id: 'sunset-breathe',
    label: 'Breathe Vox',
    calloutText: 'Velvet Vocal Pad',
    category: 'groove',
    energyMin: 0,
    chillSafe: true,
    description: 'Airy whispered formant wash for Sunset & Breather mixes',
  },

  // Countdown (4)
  {
    id: 'count-1234',
    label: '1-2-3-4!',
    calloutText: 'One! Two! Three! Four!',
    category: 'countdown',
    energyMin: 40,
    chillSafe: false,
    description: '4-beat BPM-locked DJ countdown into drop',
  },
  {
    id: 'three-two-one',
    label: '3-2-1 Drop',
    calloutText: 'Three! Two! One!',
    category: 'countdown',
    energyMin: 50,
    chillSafe: false,
    description: 'Ascending pitch 3-beat countdown leading straight into Bar 1',
  },
  {
    id: 'bass-drop',
    label: 'Drop Bass!',
    calloutText: 'Drop That Bass!',
    category: 'countdown',
    energyMin: 55,
    chillSafe: false,
    description: 'Deep MC formant slam layered with sub-bass punch',
  },
  {
    id: 'pull-up',
    label: 'Pull Up!',
    calloutText: 'Pull Up! Selecta!',
    category: 'countdown',
    energyMin: 52,
    chillSafe: false,
    description: 'Sound-system rewind shout with dub echo tail',
  },

  // Scratch & Tags (4)
  {
    id: 'dj-scratch-aaah',
    label: 'Fresh Aaah!',
    calloutText: 'Fresh Aaaah!',
    category: 'scratch-vox',
    energyMin: 20,
    chillSafe: false,
    description: 'Classic turntablist baby-scratch formant cut',
  },
  {
    id: 'yo-yo-yo',
    label: 'Yo-Yo-Yo!',
    calloutText: 'Yo-Yo-Yo!',
    category: 'scratch-vox',
    energyMin: 35,
    chillSafe: false,
    description: 'Triplet turntable stutter vocal cut',
  },
  {
    id: 'check-mic',
    label: 'Check 1-2',
    calloutText: 'Check One-Two',
    category: 'scratch-vox',
    energyMin: 0,
    chillSafe: true,
    description: 'Crisp tight hip-hop mic check cut',
  },
  {
    id: 'vip-remix',
    label: 'VIP Remix',
    calloutText: 'VIP Live Remix!',
    category: 'scratch-vox',
    energyMin: 30,
    chillSafe: true,
    description: 'Talkbox formant VIP DJ tag with stereo slapback',
  },
];

export const ALL_VOICE_IDS: DjVoiceDropId[] = DJ_VOICE_LIBRARY.map((v) => v.id);

export const VOICE_PRESET_MAP: Record<DjVoiceDropId, DjVoicePresetMeta> = DJ_VOICE_LIBRARY.reduce(
  (acc, item) => {
    acc[item.id] = item;
    return acc;
  },
  {} as Record<DjVoiceDropId, DjVoicePresetMeta>
);

const STORAGE_KEY = 'deckforge_voice_pack_v1';

export interface SavedVoicePackConfig {
  voiceFxEnabled: boolean;
  enabledVoiceIds: DjVoiceDropId[];
  voiceVolume: number;
  voiceFrequency: VoiceFrequencyMode;
}

export function loadVoicePackSettings(): SavedVoicePackConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return {
        voiceFxEnabled: true,
        enabledVoiceIds: [...ALL_VOICE_IDS],
        voiceVolume: 1.0,
        voiceFrequency: 'normal',
      };
    }
    const parsed = JSON.parse(raw) as Partial<SavedVoicePackConfig>;
    const validSet = new Set<DjVoiceDropId>(ALL_VOICE_IDS);
    const cleanedIds = Array.isArray(parsed.enabledVoiceIds)
      ? parsed.enabledVoiceIds.filter((id): id is DjVoiceDropId => validSet.has(id as DjVoiceDropId))
      : [...ALL_VOICE_IDS];
    const vol =
      typeof parsed.voiceVolume === 'number' && Number.isFinite(parsed.voiceVolume)
        ? Math.max(0, Math.min(1.5, parsed.voiceVolume))
        : 1.0;
    const freq: VoiceFrequencyMode =
      parsed.voiceFrequency === 'rare' ||
      parsed.voiceFrequency === 'normal' ||
      parsed.voiceFrequency === 'hype'
        ? parsed.voiceFrequency
        : 'normal';
    return {
      voiceFxEnabled: typeof parsed.voiceFxEnabled === 'boolean' ? parsed.voiceFxEnabled : true,
      enabledVoiceIds: cleanedIds,
      voiceVolume: vol,
      voiceFrequency: freq,
    };
  } catch {
    return {
      voiceFxEnabled: true,
      enabledVoiceIds: [...ALL_VOICE_IDS],
      voiceVolume: 1.0,
      voiceFrequency: 'normal',
    };
  }
}

export function saveVoicePackSettings(cfg: Partial<SavedVoicePackConfig> & { voiceFxEnabled: boolean; enabledVoiceIds: DjVoiceDropId[] }): void {
  try {
    const prev = loadVoicePackSettings();
    const merged: SavedVoicePackConfig = {
      voiceFxEnabled: cfg.voiceFxEnabled,
      enabledVoiceIds: cfg.enabledVoiceIds,
      voiceVolume:
        typeof cfg.voiceVolume === 'number' && Number.isFinite(cfg.voiceVolume)
          ? Math.max(0, Math.min(1.5, cfg.voiceVolume))
          : prev.voiceVolume,
      voiceFrequency:
        cfg.voiceFrequency === 'rare' ||
        cfg.voiceFrequency === 'normal' ||
        cfg.voiceFrequency === 'hype'
          ? cfg.voiceFrequency
          : prev.voiceFrequency,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
  } catch {
    // ignore storage quota failures
  }
}

// =========================================================================
// 4 Custom User Mic / Audio Drop Slots (IndexedDB PCM + localStorage Meta)
// =========================================================================

const CUSTOM_META_KEY = 'deckforge_custom_voice_metas_v1';
const IDB_NAME = 'deckforge_custom_voices_db';
const IDB_STORE = 'drops';

interface StoredCustomDropRecord {
  id: CustomVoiceSlotId;
  sampleRate: number;
  channels: Float32Array[];
  durationSec: number;
}

const DEFAULT_CUSTOM_METAS: CustomVoiceDropMeta[] = [
  { id: 'custom-1', label: 'My Drop 1', durationSec: 0, hasAudio: false, enabled: true },
  { id: 'custom-2', label: 'My Drop 2', durationSec: 0, hasAudio: false, enabled: true },
  { id: 'custom-3', label: 'My Drop 3', durationSec: 0, hasAudio: false, enabled: true },
  { id: 'custom-4', label: 'My Drop 4', durationSec: 0, hasAudio: false, enabled: true },
];

export function loadCustomVoiceMetas(): CustomVoiceDropMeta[] {
  try {
    const raw = localStorage.getItem(CUSTOM_META_KEY);
    if (!raw) return DEFAULT_CUSTOM_METAS.map((m) => ({ ...m }));
    const parsed = JSON.parse(raw) as Partial<CustomVoiceDropMeta>[];
    if (!Array.isArray(parsed)) return DEFAULT_CUSTOM_METAS.map((m) => ({ ...m }));
    return DEFAULT_CUSTOM_METAS.map((def) => {
      const found = parsed.find((p) => p?.id === def.id);
      if (!found) return { ...def };
      return {
        id: def.id,
        label: typeof found.label === 'string' && found.label.trim() ? found.label.trim() : def.label,
        durationSec: typeof found.durationSec === 'number' ? found.durationSec : 0,
        hasAudio: Boolean(found.hasAudio),
        enabled: typeof found.enabled === 'boolean' ? found.enabled : true,
      };
    });
  } catch {
    return DEFAULT_CUSTOM_METAS.map((m) => ({ ...m }));
  }
}

export function saveCustomVoiceMetas(metas: CustomVoiceDropMeta[]): void {
  try {
    localStorage.setItem(CUSTOM_META_KEY, JSON.stringify(metas));
  } catch {
    // ignore storage quota failures
  }
}

function openCustomVoicesDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable in this browser.'));
      return;
    }
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Failed to open IndexedDB.'));
  });
}

export async function saveCustomVoiceBufferToIdb(
  slotId: CustomVoiceSlotId,
  buffer: AudioBuffer
): Promise<number> {
  const maxFrames = Math.min(buffer.length, Math.floor(buffer.sampleRate * 8));
  const numCh = Math.min(2, buffer.numberOfChannels);
  const channels: Float32Array[] = [];
  for (let c = 0; c < numCh; c++) {
    channels.push(new Float32Array(buffer.getChannelData(c).subarray(0, maxFrames)));
  }
  const durationSec = Math.round((maxFrames / buffer.sampleRate) * 100) / 100;
  const db = await openCustomVoicesDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put({
      id: slotId,
      sampleRate: buffer.sampleRate,
      channels,
      durationSec,
    } satisfies StoredCustomDropRecord);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Failed saving voice drop.'));
  });
  db.close();
  return durationSec;
}

export async function loadAllCustomVoiceBuffers(
  decodeContext: BaseAudioContext
): Promise<Partial<Record<CustomVoiceSlotId, AudioBuffer>>> {
  const result: Partial<Record<CustomVoiceSlotId, AudioBuffer>> = {};
  try {
    const db = await openCustomVoicesDb();
    const records = await new Promise<StoredCustomDropRecord[]>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).getAll();
      req.onsuccess = () => resolve((req.result || []) as StoredCustomDropRecord[]);
      req.onerror = () => reject(req.error);
    });
    db.close();

    for (const rec of records) {
      if (!rec?.channels?.length || !rec.sampleRate) continue;
      const len = rec.channels[0].length;
      if (len < 64) continue;
      const buf = decodeContext.createBuffer(rec.channels.length, len, rec.sampleRate);
      for (let c = 0; c < rec.channels.length; c++) {
        buf.copyToChannel(new Float32Array(rec.channels[c]), c);
      }
      result[rec.id] = buf;
    }
  } catch {
    // ignore IDB errors cleanly
  }
  return result;
}

export async function deleteCustomVoiceBufferFromIdb(slotId: CustomVoiceSlotId): Promise<void> {
  try {
    const db = await openCustomVoicesDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).delete(slotId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // ignore
  }
}

/**
 * Strips leading/trailing dead air, applies tight club fade-in/out ramps,
 * and normalizes quiet recordings/samples toward -0.7 dB FS so custom drops snap onto Beat 1.
 */
export function trimAndFadeVoiceBuffer(
  ctx: BaseAudioContext,
  buffer: AudioBuffer
): AudioBuffer {
  const sr = buffer.sampleRate;
  const numCh = Math.min(2, buffer.numberOfChannels);
  const len = buffer.length;
  if (len < Math.floor(sr * 0.08)) return buffer;

  let globalPeak = 0;
  for (let ch = 0; ch < numCh; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      const a = Math.abs(data[i]);
      if (a > globalPeak) globalPeak = a;
    }
  }
  const threshold = Math.max(0.012, globalPeak * 0.035);

  let firstActive = 0;
  outerStart: for (let i = 0; i < len; i++) {
    for (let ch = 0; ch < numCh; ch++) {
      if (Math.abs(buffer.getChannelData(ch)[i]) >= threshold) {
        firstActive = i;
        break outerStart;
      }
    }
  }

  let lastActive = len - 1;
  outerEnd: for (let i = len - 1; i >= firstActive; i--) {
    for (let ch = 0; ch < numCh; ch++) {
      if (Math.abs(buffer.getChannelData(ch)[i]) >= threshold) {
        lastActive = i;
        break outerEnd;
      }
    }
  }

  const prePad = Math.floor(sr * 0.012);
  const postPad = Math.floor(sr * 0.035);
  const startIdx = Math.max(0, firstActive - prePad);
  const endIdx = Math.min(len, lastActive + postPad);
  const outLen = Math.max(Math.min(len, Math.floor(sr * 0.12)), endIdx - startIdx);

  const fadeInSamples = Math.min(Math.floor(sr * 0.008), Math.floor(outLen * 0.15));
  const fadeOutSamples = Math.min(Math.floor(sr * 0.028), Math.floor(outLen * 0.25));
  const normScale = globalPeak > 0.008 ? Math.min(3.5, Math.max(1.0, 0.92 / globalPeak)) : 1.0;

  const out = ctx.createBuffer(numCh, outLen, sr);
  for (let ch = 0; ch < numCh; ch++) {
    const src = buffer.getChannelData(ch);
    const dst = out.getChannelData(ch);
    for (let i = 0; i < outLen; i++) {
      let env = 1;
      if (i < fadeInSamples) env = i / Math.max(1, fadeInSamples);
      else if (i >= outLen - fadeOutSamples) {
        env = (outLen - i) / Math.max(1, fadeOutSamples);
      }
      const s = (src[startIdx + i] || 0) * normScale * env;
      dst[i] = Math.max(-0.98, Math.min(0.98, s));
    }
  }
  return out;
}

/**
 * Starts live microphone capture (capped safely at maxSec) and resolves an AudioBuffer on stop.
 */
export async function startMicDropCapture(
  ctx: AudioContext,
  maxSec = 4.0,
  onAutoStop?: (buf: AudioBuffer) => void
): Promise<{ stop: () => Promise<AudioBuffer>; cancel: () => void }> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Microphone recording is not supported in this browser.');
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: true,
    },
  });

  const chunks: BlobPart[] = [];
  const recorder = new MediaRecorder(stream);
  let settled = false;
  let autoTimer: ReturnType<typeof setTimeout> | null = null;

  const stopPromise = new Promise<AudioBuffer>((resolve, reject) => {
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    recorder.onerror = () => {
      if (!settled) {
        settled = true;
        stream.getTracks().forEach((t) => t.stop());
        reject(new Error('Microphone capture failed.'));
      }
    };
    recorder.onstop = async () => {
      if (autoTimer) {
        clearTimeout(autoTimer);
        autoTimer = null;
      }
      stream.getTracks().forEach((t) => t.stop());
      if (settled) return;
      settled = true;
      try {
        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        const arr = await blob.arrayBuffer();
        const decoded = await ctx.decodeAudioData(arr);
        resolve(decoded);
      } catch {
        reject(new Error('Could not decode captured microphone audio.'));
      }
    };
  });

  recorder.start(80);
  autoTimer = setTimeout(() => {
    if (recorder.state === 'recording') {
      recorder.stop();
      stopPromise.then((buf) => onAutoStop?.(buf)).catch(() => {});
    }
  }, Math.max(800, maxSec * 1000));

  return {
    stop: async () => {
      if (recorder.state === 'recording') {
        recorder.stop();
      }
      return stopPromise;
    },
    cancel: () => {
      if (autoTimer) {
        clearTimeout(autoTimer);
        autoTimer = null;
      }
      settled = true;
      if (recorder.state === 'recording') {
        try {
          recorder.stop();
        } catch {
          // ignore
        }
      }
      stream.getTracks().forEach((t) => t.stop());
    },
  };
}

