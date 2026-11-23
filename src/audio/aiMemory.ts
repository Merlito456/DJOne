import { AiTasteProfile, TrackCalibration, TrackItem } from '../types/dj';

const CALIBRATION_STORAGE_KEY = 'deckforge_track_calibrations_v1';
const TASTE_STORAGE_KEY = 'deckforge_ai_taste_v1';

// Camelot wheel -> musical pitch root Hz (around C4..B4 register, or bass octave for sub-drop)
// A = minor keys, B = major keys
const CAMELOT_PITCH_MAP: Record<string, { rootHz: number; isMinor: boolean; noteLabel: string }> = {
  '1A': { rootHz: 207.65, isMinor: true, noteLabel: 'G#m' },
  '2A': { rootHz: 233.08, isMinor: true, noteLabel: 'D#m' },
  '3A': { rootHz: 277.18, isMinor: true, noteLabel: 'A#m' },
  '4A': { rootHz: 174.61, isMinor: true, noteLabel: 'Fm' },
  '5A': { rootHz: 261.63, isMinor: true, noteLabel: 'Cm' },
  '6A': { rootHz: 196.0, isMinor: true, noteLabel: 'Gm' },
  '7A': { rootHz: 293.66, isMinor: true, noteLabel: 'Dm' },
  '8A': { rootHz: 220.0, isMinor: true, noteLabel: 'Am' },
  '9A': { rootHz: 329.63, isMinor: true, noteLabel: 'Em' },
  '10A': { rootHz: 246.94, isMinor: true, noteLabel: 'Bm' },
  '11A': { rootHz: 185.0, isMinor: true, noteLabel: 'F#m' },
  '12A': { rootHz: 277.18, isMinor: true, noteLabel: 'C#m' },

  '1B': { rootHz: 246.94, isMinor: false, noteLabel: 'B' },
  '2B': { rootHz: 185.0, isMinor: false, noteLabel: 'F#' },
  '3B': { rootHz: 277.18, isMinor: false, noteLabel: 'C#' },
  '4B': { rootHz: 207.65, isMinor: false, noteLabel: 'G#' },
  '5B': { rootHz: 311.13, isMinor: false, noteLabel: 'D#' },
  '6B': { rootHz: 233.08, isMinor: false, noteLabel: 'A#' },
  '7B': { rootHz: 349.23, isMinor: false, noteLabel: 'F' },
  '8B': { rootHz: 261.63, isMinor: false, noteLabel: 'C' },
  '9B': { rootHz: 196.0, isMinor: false, noteLabel: 'G' },
  '10B': { rootHz: 293.66, isMinor: false, noteLabel: 'D' },
  '11B': { rootHz: 220.0, isMinor: false, noteLabel: 'A' },
  '12B': { rootHz: 329.63, isMinor: false, noteLabel: 'E' },
};

export const ALL_CAMELOT_KEYS = [
  '1A', '2A', '3A', '4A', '5A', '6A', '7A', '8A', '9A', '10A', '11A', '12A',
  '1B', '2B', '3B', '4B', '5B', '6B', '7B', '8B', '9B', '10B', '11B', '12B',
];

export function shiftCamelotKey(musicalKey: string, semitones: number): string {
  const m = String(musicalKey || '8A')
    .trim()
    .toUpperCase()
    .match(/^(\d{1,2})([AB])$/);
  if (!m) return '8A';
  const baseNum = Math.max(1, Math.min(12, parseInt(m[1], 10)));
  const shifted = ((((baseNum - 1 + semitones * 7) % 12) + 12) % 12) + 1;
  return `${shifted}${m[2]}`;
}

export function camelotToHarmony(musicalKey?: string): {
  rootHz: number;
  chordHz: number[];
  isMinor: boolean;
  noteLabel: string;
} {
  const clean = String(musicalKey || '8A').trim().toUpperCase();
  const entry = CAMELOT_PITCH_MAP[clean] || CAMELOT_PITCH_MAP['8A'];
  const r = entry.rootHz;
  // Minor 7th vs Major 7th triad voicing
  const chordHz = entry.isMinor
    ? [r, r * 1.1892, r * 1.4983, r * 1.7818]
    : [r, r * 1.2599, r * 1.4983, r * 1.8877];
  return {
    rootHz: r,
    chordHz,
    isMinor: entry.isMinor,
    noteLabel: entry.noteLabel,
  };
}

function getSafeStorage(): Storage | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    // ignore SSR or sandbox errors
  }
  return null;
}

// ============================================================================
// Persistent Track Memory & Beat Calibration (by youtubeId || track.id)
// ============================================================================

export function getTrackCalibrationKey(track: Pick<TrackItem, 'id' | 'youtubeId'>): string {
  return track.youtubeId ? `yt:${track.youtubeId}` : track.id;
}

export function loadCalibrationMap(): Record<string, TrackCalibration> {
  const store = getSafeStorage();
  if (!store) return {};
  try {
    const raw = store.getItem(CALIBRATION_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function getTrackCalibration(
  track: Pick<TrackItem, 'id' | 'youtubeId'>
): TrackCalibration | null {
  const map = loadCalibrationMap();
  return map[getTrackCalibrationKey(track)] || null;
}

export function saveTrackCalibration(
  track: Pick<TrackItem, 'id' | 'youtubeId'>,
  patch: Partial<Omit<TrackCalibration, 'trackKey' | 'updatedAt'>>
): TrackCalibration {
  const map = loadCalibrationMap();
  const key = getTrackCalibrationKey(track);
  const existing = map[key] || { trackKey: key, updatedAt: Date.now() };
  const next: TrackCalibration = {
    ...existing,
    ...patch,
    trackKey: key,
    updatedAt: Date.now(),
  };
  map[key] = next;

  const store = getSafeStorage();
  if (store) {
    try {
      store.setItem(CALIBRATION_STORAGE_KEY, JSON.stringify(map));
    } catch {
      // ignore storage quota errors
    }
  }
  return next;
}

export function mergeTrackWithCalibration(track: TrackItem): TrackItem {
  const cal = getTrackCalibration(track);
  if (!cal) return track;
  return {
    ...track,
    bpm: typeof cal.bpm === 'number' && cal.bpm >= 60 ? cal.bpm : track.bpm,
    musicalKey: cal.musicalKey || track.musicalKey,
    firstBeatSec: typeof cal.firstBeatSec === 'number' ? cal.firstBeatSec : track.firstBeatSec,
    dropCueSec: typeof cal.dropCueSec === 'number' ? cal.dropCueSec : track.dropCueSec,
    autoTrimGain:
      typeof cal.autoTrimGain === 'number' && cal.autoTrimGain >= 0.45 && cal.autoTrimGain <= 1.5
        ? cal.autoTrimGain
        : track.autoTrimGain,
    calibrated: true,
  };
}

// ============================================================================
// Offline Taste Learning (Local Transition Q-Score Memory)
// ============================================================================

const DEFAULT_TASTE_PROFILE: AiTasteProfile = {
  styleScores: {},
  fxScores: {},
  pairScores: {},
  preferredAggressivenessDelta: 0,
  completedCount: 0,
  skippedCount: 0,
  updatedAt: 0,
};

let inMemoryTasteFallback: AiTasteProfile = { ...DEFAULT_TASTE_PROFILE };

export function loadTasteProfile(): AiTasteProfile {
  const store = getSafeStorage();
  if (!store) return inMemoryTasteFallback;
  try {
    const raw = store.getItem(TASTE_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_TASTE_PROFILE };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_TASTE_PROFILE };
    return {
      styleScores: parsed.styleScores || {},
      fxScores: parsed.fxScores || {},
      pairScores: parsed.pairScores || {},
      preferredAggressivenessDelta:
        typeof parsed.preferredAggressivenessDelta === 'number'
          ? parsed.preferredAggressivenessDelta
          : 0,
      completedCount: Number(parsed.completedCount) || 0,
      skippedCount: Number(parsed.skippedCount) || 0,
      updatedAt: Number(parsed.updatedAt) || 0,
    };
  } catch {
    return { ...DEFAULT_TASTE_PROFILE };
  }
}

function saveTasteProfile(profile: AiTasteProfile) {
  inMemoryTasteFallback = profile;
  const store = getSafeStorage();
  if (!store) return;
  try {
    store.setItem(TASTE_STORAGE_KEY, JSON.stringify(profile));
  } catch {
    // ignore storage errors
  }
}

function clampQ(val: number): number {
  return Math.max(-10, Math.min(16, Math.round(val * 100) / 100));
}

export type TasteFeedbackOutcome =
  | 'completed'
  | 'skipped_mix_now'
  | 'wild_take_override'
  | 'kept_take';

export function recordAiFeedbackEvent(params: {
  outcome: TasteFeedbackOutcome;
  outTrackId?: string | null;
  inTrackId?: string | null;
  mixStyleKey?: string | null;
  fxTypes?: string[];
  aggressiveness?: number;
}): AiTasteProfile {
  const cur = loadTasteProfile();
  const next: AiTasteProfile = {
    styleScores: { ...cur.styleScores },
    fxScores: { ...cur.fxScores },
    pairScores: { ...cur.pairScores },
    preferredAggressivenessDelta: cur.preferredAggressivenessDelta,
    completedCount: cur.completedCount,
    skippedCount: cur.skippedCount,
    updatedAt: Date.now(),
  };

  const delta =
    params.outcome === 'completed'
      ? 1.5
      : params.outcome === 'kept_take'
      ? 1.0
      : params.outcome === 'skipped_mix_now'
      ? -1.8
      : -0.9; // wild_take_override pushes style bias & raises energy appetite slightly

  if (params.outcome === 'completed' || params.outcome === 'kept_take') {
    next.completedCount += 1;
  } else {
    next.skippedCount += 1;
  }

  if (params.mixStyleKey) {
    const prev = next.styleScores[params.mixStyleKey] ?? 0;
    next.styleScores[params.mixStyleKey] = clampQ(prev * 0.94 + delta);
  }

  if (params.fxTypes && params.fxTypes.length > 0) {
    for (const fx of params.fxTypes) {
      const prev = next.fxScores[fx] ?? 0;
      next.fxScores[fx] = clampQ(prev * 0.94 + delta * 0.8);
    }
  }

  if (params.outTrackId && params.inTrackId) {
    const pairKey = `${params.outTrackId}->${params.inTrackId}`;
    const prev = next.pairScores[pairKey] ?? 0;
    next.pairScores[pairKey] = clampQ(prev * 0.95 + delta * 1.4);
  }

  if (params.outcome === 'wild_take_override') {
    next.preferredAggressivenessDelta = Math.max(
      -20,
      Math.min(20, Math.round((next.preferredAggressivenessDelta + 2.5) * 10) / 10)
    );
  } else if (params.outcome === 'skipped_mix_now' && (params.aggressiveness ?? 50) > 65) {
    next.preferredAggressivenessDelta = Math.max(
      -20,
      Math.min(20, Math.round((next.preferredAggressivenessDelta - 2.0) * 10) / 10)
    );
  }

  saveTasteProfile(next);
  return next;
}

export function resetTasteProfile(): AiTasteProfile {
  const fresh: AiTasteProfile = { ...DEFAULT_TASTE_PROFILE, updatedAt: Date.now() };
  saveTasteProfile(fresh);
  return fresh;
}
