import {
  AiChopPatternType,
  AiDjVibe,
  AiEnergyMode,
  AiMashupBlendAdvice,
  AiMashupPhase,
  AiSetlistItem,
  AiSongEffectMoment,
  AiTasteProfile,
  AiTransitionPlan,
  AiTransitionVoiceCue,
  AiTrickActionType,
  AiTrickStep,
  AnyVoiceDropId,
  CustomVoiceDropMeta,
  DjVoiceCategory,
  DjVoiceDropId,
  FxType,
  GenrePhysicsMode,
  GrooveBridgePattern,
  GrooveDnaGenre,
  HotCue,
  SoundTrickType,
  StemIsolationMode,
  TrackItem,
  TrackSectionSegment,
  VocalDensityTag,
  VocalProfile,
  WaveformBandSample,
} from '../types/dj';
import { loadTasteProfile, shiftCamelotKey } from './aiMemory';
import { DJ_VOICE_LIBRARY, isCustomVoiceDropId, VOICE_PRESET_MAP } from './djVoices';
import { analyzeOverlapClash } from './waveformAnalyzer';

export interface CandidateTrackInput {
  id: string;
  title: string;
  artist: string;
  bpm: number;
  musicalKey: string;
  durationSec: number;
  firstBeatSec?: number;
  dropCueSec?: number;
  detectedDropSec?: number;
  sections?: TrackSectionSegment[];
}

interface CamelotKey {
  num: number;
  letter: 'A' | 'B';
}

const HOT_CUE_COLORS = ['#22D3EE', '#10B981', '#F59E0B', '#EC4899'];

function hashString(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function createRng(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickOne<T>(arr: readonly T[], rng: () => number): T {
  return arr[Math.floor(rng() * arr.length) % arr.length];
}

function parseCamelot(keyStr: string): CamelotKey | null {
  const m = String(keyStr || '')
    .trim()
    .toUpperCase()
    .match(/^(\d{1,2})([AB])$/);
  if (!m) return null;
  const num = parseInt(m[1], 10);
  if (num < 1 || num > 12) return null;
  return { num, letter: m[2] as 'A' | 'B' };
}

function fastCamelotScore(a: CamelotKey | null, b: CamelotKey | null): number {
  if (!a || !b) return 12;
  if (a.num === b.num && a.letter === b.letter) return 42;
  const diff = (b.num - a.num + 12) % 12;
  if (a.letter === b.letter && (diff === 1 || diff === 11)) return 36;
  if (a.num === b.num && a.letter !== b.letter) return 33;
  if (a.letter === b.letter && (diff === 2 || diff === 7)) return 24;
  return 6;
}

export function camelotCompatibility(keyA: string, keyB: string): { score: number; relation: string } {
  const a = parseCamelot(keyA);
  const b = parseCamelot(keyB);
  if (!a || !b) return { score: 12, relation: 'neutral key blend' };

  if (a.num === b.num && a.letter === b.letter) {
    return { score: 42, relation: 'exact key lock' };
  }
  const diff = (b.num - a.num + 12) % 12;
  if (a.letter === b.letter && (diff === 1 || diff === 11)) {
    return { score: 36, relation: 'adjacent Camelot step' };
  }
  if (a.num === b.num && a.letter !== b.letter) {
    return { score: 33, relation: 'relative major/minor lift' };
  }
  if (a.letter === b.letter && (diff === 2 || diff === 7)) {
    return { score: 24, relation: 'energy boost shift' };
  }
  return { score: 6, relation: 'rhythmic percussive swap' };
}

// ============================================================================
// Wave-2 Advance #5: Offline "Semitone Snap" Key-Shift Resolver
// ============================================================================

export function resolveSemitoneSnap(
  outKey: string,
  inKey: string,
  outBpm: number,
  inBpm: number
): {
  semitones: number;
  snappedKey: string;
  pitchMultiplier: number;
  snapped: boolean;
} {
  const baseCompat = camelotCompatibility(outKey, inKey);
  if (baseCompat.score >= 24) {
    return { semitones: 0, snappedKey: inKey, pitchMultiplier: 1, snapped: false };
  }

  let bestSemitones = 0;
  let bestScore = baseCompat.score;
  let bestKey = inKey;
  let bestMult = 1;

  for (const st of [1, -1, 2, -2]) {
    const shiftedKey = shiftCamelotKey(inKey, st);
    const compat = camelotCompatibility(outKey, shiftedKey);
    const mult = Math.pow(2, st / 12);
    const shiftedBpm = (inBpm || 124) * mult;
    const folded = computeEffectiveBpmMatch(outBpm || 124, shiftedBpm);
    // Only accept semitone pitch lock when resulting tempo remains within playable DJ pitch reach
    if (compat.score > bestScore && compat.score >= 33 && folded.effectiveDiff <= 15) {
      bestScore = compat.score;
      bestSemitones = st;
      bestKey = shiftedKey;
      bestMult = Math.round(mult * 10000) / 10000;
    }
  }

  return {
    semitones: bestSemitones,
    snappedKey: bestKey,
    pitchMultiplier: bestMult,
    snapped: bestSemitones !== 0,
  };
}

// ============================================================================
// Wave-2 Advance #3: True Double-Drop Phrasing Alignment Calculator
// ============================================================================

export function computeDoubleDropCueSec(params: {
  outgoingTrack: Pick<TrackItem, 'dropCueSec' | 'detectedDropSec' | 'bpm' | 'durationSec'> | null;
  incomingTrack: Pick<CandidateTrackInput, 'dropCueSec' | 'detectedDropSec' | 'bpm' | 'durationSec' | 'firstBeatSec'>;
  currentTimeSec?: number;
  outBpm: number;
  transitionBars: number;
}): number | undefined {
  const { outgoingTrack, incomingTrack, currentTimeSec = 0, outBpm, transitionBars } = params;
  if (!outgoingTrack) return undefined;
  const outDrop = outgoingTrack.dropCueSec ?? outgoingTrack.detectedDropSec;
  const inDrop = incomingTrack.dropCueSec ?? incomingTrack.detectedDropSec;
  if (typeof outDrop !== 'number' || typeof inDrop !== 'number') return undefined;

  const barSec = (60 / Math.max(65, outBpm || 124)) * 4;
  const remainingToOutDrop = outDrop - currentTimeSec;
  // Double-drop makes sense when outgoing drop lands near or inside the transition window
  if (remainingToOutDrop < barSec * 1.5 || remainingToOutDrop > barSec * (transitionBars + 4)) {
    return undefined;
  }

  const inBeatSec = 60 / Math.max(65, incomingTrack.bpm || 124);
  const rawCue = inDrop - remainingToOutDrop;
  if (rawCue < 1 || rawCue >= Math.max(12, (incomingTrack.durationSec || 180) - 8)) {
    return undefined;
  }

  const firstBeat = incomingTrack.firstBeatSec || 0;
  const qBeats = Math.round((rawCue - firstBeat) / inBeatSec);
  const quantizedCue = Math.max(0, firstBeat + qBeats * inBeatSec);
  return Math.round(quantizedCue * 100) / 100;
}

// ============================================================================
// Feature #6: Harmonic Mashup Pairing Score (Vocal vs. Instrumental Awareness)
// ============================================================================

export function analyzeVocalProfile(title: string, artist = ''): VocalProfile {
  const text = `${title} ${artist}`.toLowerCase();
  const flavorTags: string[] = [];

  if (/\bslowed\b|\breverb\b/.test(text)) flavorTags.push('slowed');
  if (/\blive\b|\bconcert\b|\bset\b|\bfestival\b/.test(text)) flavorTags.push('live');
  if (/\bremix\b|\bedit\b|\bbootleg\b|\bvip\b|\brework\b/.test(text)) flavorTags.push('remix');
  if (/\blo[- ]?fi\b|\bchillhop\b/.test(text)) flavorTags.push('lofi');

  if (/\bacapella\b|\ba cappella\b|\bvocal stem\b|\bonly vocals\b/.test(text)) {
    return { density: 'acapella', flavorTags };
  }

  if (
    /\binstrumental\b|\btype beat\b|\bbeats?\b|\bkaraoke\b|\boff vocal\b|\bdub mix\b|\bextended dub\b|\bbacking track\b|\bno vocal\b|\btechno\b|\bambient\b|\bsynthwave\b/.test(
      text
    )
  ) {
    return { density: 'instrumental', flavorTags };
  }

  if (
    /\bft\.?\b|\bfeat\.?\b|\blyrics?\b|\bofficial audio\b|\bofficial video\b|\bofficial music\b|\bsing\b|\bcover\b|\brap\b|\bballad\b/.test(
      text
    )
  ) {
    return { density: 'vocal-dense', flavorTags };
  }

  return { density: 'balanced', flavorTags };
}

export function computePairVocalCompatibility(
  outTrack: Pick<CandidateTrackInput, 'title' | 'artist'> | null,
  inTrack: Pick<CandidateTrackInput, 'title' | 'artist'>
): {
  score: number;
  clashRisk: 'ideal-mashup' | 'low' | 'moderate' | 'high';
  recommendedBarsBonus: number;
  note: string;
} {
  const inProf = analyzeVocalProfile(inTrack.title, inTrack.artist);
  if (!outTrack) {
    return {
      score: 0,
      clashRisk: 'low',
      recommendedBarsBonus: 0,
      note: `${inProf.density} opener`,
    };
  }

  const outProf = analyzeVocalProfile(outTrack.title, outTrack.artist);

  const outIsInst = outProf.density === 'instrumental';
  const inIsInst = inProf.density === 'instrumental';
  const outIsVocal = outProf.density === 'vocal-dense' || outProf.density === 'acapella';
  const inIsVocal = inProf.density === 'vocal-dense' || inProf.density === 'acapella';

  // Instrumental + Vocal = Dream Mashup pairing (stretch overlap bars!)
  if ((outIsInst && inIsVocal) || (inIsInst && outIsVocal)) {
    return {
      score: 18,
      clashRisk: 'ideal-mashup',
      recommendedBarsBonus: 8,
      note: 'Instrumental × Vocal bed (extended blend)',
    };
  }

  if (outIsInst && inIsInst) {
    return {
      score: 10,
      clashRisk: 'low',
      recommendedBarsBonus: 4,
      note: 'Clean instrumental groove weave',
    };
  }

  // Two dense vocal tracks competing over each other: penalize in path optimizer & use crisp cutover
  if (outIsVocal && inIsVocal) {
    return {
      score: -18,
      clashRisk: 'high',
      recommendedBarsBonus: -4,
      note: 'Dual-vocal swap (fast phrase cut)',
    };
  }

  if (outProf.density === 'balanced' && inIsVocal) {
    return {
      score: 2,
      clashRisk: 'moderate',
      recommendedBarsBonus: 0,
      note: 'Balanced mid-carve blend',
    };
  }

  return {
    score: 5,
    clashRisk: 'low',
    recommendedBarsBonus: 0,
    note: 'Smooth harmonic blend',
  };
}

// ============================================================================
// Advance #5: Groove & Genre DNA Fingerprinting + Pairing Recipes
// ============================================================================

export function detectGrooveDna(
  track: Pick<CandidateTrackInput, 'title' | 'artist' | 'bpm'>
): GrooveDnaGenre {
  const text = `${track.title} ${track.artist}`.toLowerCase();
  const bpm = track.bpm || 124;

  // 1. Explicit genre/style keywords always take priority over BPM-band fallback
  if (/\bdnb\b|\bdrum\s*&?\s*bass\b|\bjungle\b|\bliquid\b/.test(text)) {
    return 'dnb-break';
  }
  if (/\blo[- ]?fi\b|\bslowed\b|\bchillhop\b|\bsunset\b|\bambient\b/.test(text)) {
    return /trap|rap|hip.?hop|drill|phonk/.test(text) ? 'trap-halftime' : 'lofi-slowed';
  }
  if (/\bafro\b|\bamapiano\b|\breggaeton\b|\bdancehall\b|\blatin\b|\bperreo\b/.test(text)) {
    return 'afro-reggaeton';
  }
  if (/\btrap\b|\bphonk\b|\bdrill\b|\bhip.?hop\b|\brap\b|\b808\b/.test(text)) {
    return 'trap-halftime';
  }
  if (/\btechno\b|\bhouse\b|\bedm\b|\bfestival\b|\btrance\b|\bclub\b|\belectro\b|\brave\b|\bdubstep\b/.test(text)) {
    return 'house-edm';
  }
  if (/\brocks?\b|\bguitar\b|\bband\b|\bmetal\b|\bindie\b|\bpunk\b/.test(text)) {
    return 'rock-live';
  }

  // 2. Fallback to BPM zone when untagged
  if (bpm >= 158) return 'dnb-break';
  if (bpm <= 92) return 'lofi-slowed';
  if (bpm >= 94 && bpm <= 114) return 'afro-reggaeton';
  if (bpm >= 118 && bpm <= 133) return 'house-edm';
  if (bpm >= 134 && bpm <= 156) return 'trap-halftime';
  return 'pop-vocal';
}

// ============================================================================
// Advance #2B: Half-Time & Double-Time BPM Fold Resolver (70 ↔ 140, 87 ↔ 174)
// ============================================================================

export function computeEffectiveBpmMatch(
  refBpm: number,
  candBpm: number
): {
  effectiveDiff: number;
  foldFactor: 1 | 2 | 0.5;
  beatDivScale: number;
  relation: string;
} {
  const safeRef = Math.max(60, refBpm || 124);
  const safeCand = Math.max(60, candBpm || 124);

  const straightDiff = Math.abs(safeCand - safeRef);
  const doubleDiff = Math.abs(safeCand * 2 - safeRef);
  const halfDiff = Math.abs(safeCand * 0.5 - safeRef);

  if (doubleDiff + 4 < straightDiff && doubleDiff <= 12) {
    return {
      effectiveDiff: doubleDiff,
      foldFactor: 2,
      beatDivScale: 0.5,
      relation: 'double-time 2x lock',
    };
  }
  if (halfDiff + 4 < straightDiff && halfDiff <= 12) {
    return {
      effectiveDiff: halfDiff,
      foldFactor: 0.5,
      beatDivScale: 2,
      relation: 'half-time 1/2x lock',
    };
  }
  return {
    effectiveDiff: straightDiff,
    foldFactor: 1,
    beatDivScale: 1,
    relation: straightDiff <= 3 ? 'tight BPM lock' : 'tempo glide',
  };
}

// ============================================================================
// Feature #1B & Advance #1: Structure-Aware Quantized Auto Hot-Cue Anchors
// ============================================================================

export function computeAutoHotCues(
  durationSec: number,
  baseBpm: number,
  dropCueSec?: number,
  firstBeatSec = 0,
  detectedDropSec?: number,
  sections?: TrackSectionSegment[]
): HotCue[] {
  const dur = Math.max(20, durationSec || 180);
  const bpm = Math.max(60, baseBpm || 124);
  const barSec = (60 / bpm) * 4;
  const quantize = (sec: number) => {
    const barsFromAnchor = Math.max(0, Math.round((sec - firstBeatSec) / barSec));
    const q = firstBeatSec + barsFromAnchor * barSec;
    return Math.round(Math.max(1, Math.min(dur - 4, q)) * 100) / 100;
  };

  const secVerse = sections?.find((s) => s.label === 'verse');
  const secBuild = sections?.find((s) => s.label === 'build');

  const anchor1 = quantize(Math.min(15, dur * 0.08));
  const anchor2 = quantize(secVerse ? secVerse.startSec : Math.min(45, dur * 0.25));
  const anchor3 = quantize(secBuild ? secBuild.startSec : Math.min(75, dur * 0.44));

  const preferredDrop =
    typeof dropCueSec === 'number' && dropCueSec > 2 && dropCueSec < dur - 2
      ? dropCueSec
      : typeof detectedDropSec === 'number' && detectedDropSec > 4 && detectedDropSec < dur - 4
      ? detectedDropSec
      : null;

  const anchor4 =
    preferredDrop !== null
      ? Math.round(preferredDrop * 100) / 100
      : quantize(Math.min(dur - 12, Math.max(anchor3 + barSec * 2, dur * 0.62)));

  const labels = ['Intro', 'Verse', 'Build', 'Drop'];
  const times = [anchor1, anchor2, anchor3, anchor4];

  return times.map((t, index) => ({
    index,
    timeSec: t,
    label: labels[index],
    color: HOT_CUE_COLORS[index],
  }));
}

// ============================================================================
// Scoring & Beam Search Whole-Set Path Optimizer (Features #2, #5, #6 + Tempo Fold)
// ============================================================================

function scoreCandidate(
  outgoing: TrackItem | CandidateTrackInput | null,
  currentBpm: number,
  candidate: CandidateTrackInput,
  playedIds: Set<string>,
  direction: string,
  energyMode: AiEnergyMode = 'wave',
  stepIndex = 0,
  rng?: () => number,
  randomness = 65,
  tasteCache?: AiTasteProfile,
  precomputedKeys?: Map<string, CamelotKey | null>,
  precomputedDensities?: Map<string, VocalDensityTag>
): number {
  const unplayedBonus = playedIds.has(candidate.id) ? 0 : 120;
  const refBpm = currentBpm || outgoing?.bpm || 124;
  const bpmMatch = computeEffectiveBpmMatch(refBpm, candidate.bpm);
  const bpmDiff = bpmMatch.effectiveDiff;
  const bpmScore = Math.max(-42, 35 - bpmDiff * 1.45) + (bpmMatch.foldFactor !== 1 ? 6 : 0);

  const keyScore = outgoing
    ? precomputedKeys
      ? fastCamelotScore(
          precomputedKeys.get(outgoing.id) ?? parseCamelot(outgoing.musicalKey),
          precomputedKeys.get(candidate.id) ?? parseCamelot(candidate.musicalKey)
        )
      : camelotCompatibility(outgoing.musicalKey, candidate.musicalKey).score
    : 25;

  let vocalScore = 0;
  if (outgoing && precomputedDensities) {
    const outD = precomputedDensities.get(outgoing.id) ?? 'balanced';
    const inD = precomputedDensities.get(candidate.id) ?? 'balanced';
    const outIsInst = outD === 'instrumental';
    const inIsInst = inD === 'instrumental';
    const outIsVoc = outD === 'vocal-dense' || outD === 'acapella';
    const inIsVoc = inD === 'vocal-dense' || inD === 'acapella';
    if ((outIsInst && inIsVoc) || (inIsInst && outIsVoc)) vocalScore = 18;
    else if (outIsInst && inIsInst) vocalScore = 10;
    else if (outIsVoc && inIsVoc) vocalScore = -18;
    else if (outD === 'balanced' && inIsVoc) vocalScore = 2;
    else vocalScore = 5;
  } else {
    vocalScore = computePairVocalCompatibility(outgoing, candidate).score;
  }

  let energyScore = 0;
  if (energyMode === 'build') {
    energyScore =
      candidate.bpm >= refBpm || bpmMatch.foldFactor === 2
        ? Math.min(24, bpmDiff * 0.8 + 12)
        : -12;
  } else if (energyMode === 'chill') {
    energyScore = Math.max(-18, 16 - bpmDiff * 1.2) + (candidate.bpm <= 126 ? 10 : -4);
  } else {
    const wantPeak = stepIndex % 2 === 0;
    energyScore = wantPeak ? (candidate.bpm >= refBpm ? 11 : 0) : candidate.bpm <= refBpm + 4 ? 11 : -4;
  }

  const dir = direction.toLowerCase();
  let dirBonus = 0;
  if (/(fast|hard|peak|energy|drop|hype|up|build)/.test(dir)) {
    dirBonus += (candidate.bpm - refBpm) * 0.85;
  } else if (/(slow|chill|deep|warm|down|relax|sunset)/.test(dir)) {
    dirBonus += (refBpm - candidate.bpm) * 0.85;
  }

  // Offline Taste Learning Q-score bias for proven pairs
  const taste = tasteCache ?? loadTasteProfile();
  const pairQ = outgoing ? taste.pairScores[`${outgoing.id}->${candidate.id}`] ?? 0 : 0;

  const randSpread = 4 + (Math.max(0, Math.min(100, randomness)) / 100) * 24;
  const sessionJitter = rng ? (rng() - 0.5) * randSpread : 0;

  return (
    unplayedBonus +
    bpmScore +
    keyScore +
    vocalScore +
    energyScore +
    dirBonus +
    pairQ * 2.2 +
    sessionJitter
  );
}

function classifyEnergyRole(bpm: number, idx: number, energyMode: AiEnergyMode = 'wave'): string {
  if (energyMode === 'build') {
    return idx === 0 ? 'Warmup' : idx >= 2 ? 'Peak' : 'Lift';
  }
  if (bpm >= 132 || idx % 3 === 1) return 'Peak';
  if (bpm >= 125) return 'Lift';
  if (bpm <= 119) return 'Warmup';
  return idx % 2 === 0 ? 'Groove' : 'Release';
}

/**
 * Fast Offline Beam Search Whole-Set Optimizer (< 5ms for 5..50 tracks).
 * Prevents Camelot dead-ends, builds smooth tempo bridges, spaces vocal density,
 * and shapes intentional peaks & valleys across the entire remaining set.
 */
export function optimizePlaylistSetlist<T extends CandidateTrackInput>(params: {
  tracks: T[];
  anchorTrack?: T | CandidateTrackInput | null;
  currentBpm?: number;
  direction?: string;
  energyMode?: AiEnergyMode;
  randomness?: number;
  sessionSeed?: number;
  maxLength?: number;
}): T[] {
  const {
    tracks,
    anchorTrack = null,
    currentBpm,
    direction = '',
    energyMode = 'wave',
    randomness = 55,
    sessionSeed = 42,
    maxLength = tracks.length,
  } = params;

  if (tracks.length <= 1) return [...tracks];

  const targetLen = Math.min(tracks.length, Math.max(1, maxLength), 48);
  const pool = tracks.slice(0, 48);
  const rng = createRng((sessionSeed ^ 0x517cc1b7) >>> 0);
  const emptyPlayed = new Set<string>();
  const BEAM_WIDTH = pool.length > 20 ? 4 : 6;
  const EXPAND_K = Math.min(pool.length, pool.length > 20 ? 4 : 6);

  // Precompute metadata caches once outside loops for sub-5ms beam search
  const taste = loadTasteProfile();
  const parsedKeys = new Map<string, CamelotKey | null>();
  const vocalDensities = new Map<string, VocalDensityTag>();
  for (const t of pool) {
    parsedKeys.set(t.id, parseCamelot(t.musicalKey));
    vocalDensities.set(t.id, analyzeVocalProfile(t.title, t.artist).density);
  }
  if (anchorTrack && !parsedKeys.has(anchorTrack.id)) {
    parsedKeys.set(anchorTrack.id, parseCamelot(anchorTrack.musicalKey));
    vocalDensities.set(anchorTrack.id, analyzeVocalProfile(anchorTrack.title, anchorTrack.artist).density);
  }

  // Precompute static harmonic+tempo exit safety score per track in pool (O(N^2) integer math)
  const exitSafetyMap = new Map<string, number>();
  for (let i = 0; i < pool.length; i++) {
    const a = pool[i];
    const keyA = parsedKeys.get(a.id) ?? null;
    let bestExit = -30;
    for (let j = 0; j < pool.length; j++) {
      if (i === j) continue;
      const b = pool[j];
      const s = fastCamelotScore(keyA, parsedKeys.get(b.id) ?? null) - Math.abs(b.bpm - a.bpm) * 1.1;
      if (s > bestExit) bestExit = s;
    }
    exitSafetyMap.set(a.id, bestExit);
  }

  interface BeamNode {
    path: T[];
    usedIds: Set<string>;
    score: number;
  }

  let beams: BeamNode[] = [];

  if (anchorTrack) {
    const scoredFirst = pool
      .map((c) => {
        const edgeScore = scoreCandidate(
          anchorTrack,
          currentBpm || anchorTrack.bpm,
          c,
          emptyPlayed,
          direction,
          energyMode,
          0,
          rng,
          randomness,
          taste,
          parsedKeys,
          vocalDensities
        );
        const lookaheadBonus = pool.length > 2 ? (exitSafetyMap.get(c.id) ?? 0) * 0.35 : 0;
        return { item: c, score: edgeScore + lookaheadBonus };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, BEAM_WIDTH);

    beams = scoredFirst.map((s) => ({
      path: [s.item],
      usedIds: new Set([s.item.id]),
      score: s.score,
    }));
  } else {
    const openers = [...pool]
      .sort((a, b) => {
        if (energyMode === 'build') return a.bpm - b.bpm;
        if (energyMode === 'chill') return b.bpm - a.bpm;
        return (hashString(a.id) % 97) - (hashString(b.id) % 97);
      })
      .slice(0, BEAM_WIDTH);

    beams = openers.map((item) => ({
      path: [item],
      usedIds: new Set([item.id]),
      score: 0,
    }));
  }

  for (let step = 1; step < targetLen; step++) {
    const nextBeams: BeamNode[] = [];

    for (const beam of beams) {
      const prev = beam.path[beam.path.length - 1];
      const remaining = pool.filter((c) => !beam.usedIds.has(c.id));
      if (remaining.length === 0) {
        nextBeams.push(beam);
        continue;
      }

      const ranked = remaining
        .map((c) => {
          const edgeScore = scoreCandidate(
            prev,
            prev.bpm,
            c,
            emptyPlayed,
            direction,
            energyMode,
            step,
            rng,
            randomness * 0.65,
            taste,
            parsedKeys,
            vocalDensities
          );
          const lookaheadBonus =
            remaining.length > 1 ? (exitSafetyMap.get(c.id) ?? 0) * 0.35 : 0;
          return { item: c, delta: edgeScore + lookaheadBonus };
        })
        .sort((a, b) => b.delta - a.delta)
        .slice(0, EXPAND_K);

      for (const r of ranked) {
        const nextUsed = new Set(beam.usedIds);
        nextUsed.add(r.item.id);
        nextBeams.push({
          path: [...beam.path, r.item],
          usedIds: nextUsed,
          score: beam.score + r.delta,
        });
      }
    }

    if (nextBeams.length === 0) break;
    nextBeams.sort((a, b) => b.score - a.score);

    const deduped: BeamNode[] = [];
    const seenSig = new Set<string>();
    for (const b of nextBeams) {
      const sig = b.path.slice(-2).map((t) => t.id).join('>');
      if (!seenSig.has(sig) || deduped.length < 2) {
        seenSig.add(sig);
        deduped.push(b);
      }
      if (deduped.length >= BEAM_WIDTH) break;
    }
    beams = deduped;
  }

  const bestOrder = beams[0]?.path || [...pool];
  if (tracks.length > bestOrder.length) {
    const used = new Set(bestOrder.map((t) => t.id));
    for (const t of tracks) {
      if (!used.has(t.id) && bestOrder.length < maxLength) bestOrder.push(t);
    }
  }
  return bestOrder;
}

const FX_FRIENDLY_NAME: Record<FxType, string> = {
  echo: 'Dub Echo',
  reverb: 'Cathedral Verb',
  flanger: 'Jet Flanger',
  drive: 'Warm Drive',
  phaser: '4-Stage Phaser',
  bitcrush: 'Lo-Fi Crush',
  tremolo: 'Trance Gate',
  chorus: 'Stereo Chorus',
  ringmod: 'Ring Mod',
  autopan: 'Auto-Pan',
  comb: 'Comb Resonator',
  stutter: 'Beat Stutter',
  subharm: 'Sub-Bass Punch',
  shimmer: 'Airy Shimmer',
  lofi: 'Lo-Fi Vinyl',
  dubdelay: 'Dotted Dub',
};

function resolveGenrePhysicsMode(
  vibe: AiDjVibe,
  outGroove: GrooveDnaGenre,
  inGroove: GrooveDnaGenre
): GenrePhysicsMode {
  if (
    (outGroove === 'trap-halftime' || outGroove === 'lofi-slowed') &&
    inGroove === 'house-edm'
  ) {
    return 'trap-to-house';
  }
  if (
    vibe === 'chill-sunset' ||
    (outGroove === 'lofi-slowed' && inGroove !== 'house-edm' && inGroove !== 'dnb-break')
  ) {
    return 'chill-velvet';
  }
  if (outGroove === 'dnb-break' || inGroove === 'dnb-break') {
    return 'dnb-chop';
  }
  return 'standard';
}

function pickContextVoiceDrop(params: {
  voiceFxEnabled?: boolean;
  enabledVoiceIds?: DjVoiceDropId[];
  enabledCustomDrops?: CustomVoiceDropMeta[];
  vibe: AiDjVibe;
  aggressiveness: number;
  isGentle?: boolean;
  preferCategories?: DjVoiceCategory[];
  rng: () => number;
}): { id: AnyVoiceDropId; label: string; isCustom: boolean } | undefined {
  const {
    voiceFxEnabled = false,
    enabledVoiceIds = [],
    enabledCustomDrops = [],
    vibe,
    aggressiveness,
    isGentle = false,
    preferCategories,
    rng,
  } = params;
  if (!voiceFxEnabled) return undefined;

  const activeCustom = enabledCustomDrops.filter((c) => c.hasAudio && c.enabled);
  const allowedSet = new Set(enabledVoiceIds);
  let candidates = DJ_VOICE_LIBRARY.filter((v) => allowedSet.has(v.id));

  if (candidates.length === 0 && activeCustom.length === 0) return undefined;

  // Sunset or Breather Mix only permits smooth chillSafe grooving/vocoder/tag voices (plus custom drops at lower rate)
  if (vibe === 'chill-sunset' || isGentle) {
    candidates = candidates.filter((v) => v.chillSafe);
  } else {
    const energyFiltered = candidates.filter((v) => v.energyMin <= aggressiveness + 20);
    if (energyFiltered.length > 0) candidates = energyFiltered;
  }

  if (preferCategories && preferCategories.length > 0 && candidates.length > 0) {
    const catMatched = candidates.filter((v) => preferCategories.includes(v.category));
    if (catMatched.length > 0) candidates = catMatched;
  }

  // Give enabled user mic/audio drops a distinct 32% selection chance when available
  if (activeCustom.length > 0 && (candidates.length === 0 || rng() < (isGentle ? 0.18 : 0.34))) {
    const chosen = pickOne(activeCustom, rng);
    return { id: chosen.id, label: chosen.label, isCustom: true };
  }

  if (candidates.length === 0) return undefined;
  const chosenPreset = pickOne(candidates, rng);
  return { id: chosenPreset.id, label: chosenPreset.label, isCustom: false };
}

function resolveVoiceDisplayLabel(id: AnyVoiceDropId, customDrops?: CustomVoiceDropMeta[]): string {
  if (isCustomVoiceDropId(id)) {
    return customDrops?.find((c) => c.id === id)?.label || 'Custom Drop';
  }
  return VOICE_PRESET_MAP[id]?.label || id;
}

function buildSongEffectMoments(params: {
  vibe: AiDjVibe;
  remixMode: boolean;
  aggressiveness: number; // 0..100
  randomness: number;     // 0..100
  quickMix: boolean;
  beatDivScale?: number;
  sections?: TrackSectionSegment[];
  durationSec?: number;
  bpm?: number;
  dropSec?: number;
  voiceFxEnabled?: boolean;
  enabledVoiceIds?: DjVoiceDropId[];
  enabledCustomDrops?: CustomVoiceDropMeta[];
  rng: () => number;
}): AiSongEffectMoment[] {
  const {
    vibe,
    remixMode,
    aggressiveness,
    randomness,
    quickMix,
    beatDivScale = 1,
    sections,
    durationSec = 180,
    bpm = 124,
    dropSec,
    voiceFxEnabled = false,
    enabledVoiceIds = [],
    enabledCustomDrops = [],
    rng,
  } = params;
  const taste = loadTasteProfile();
  const effectiveAggr = Math.max(
    0,
    Math.min(100, aggressiveness + taste.preferredAggressivenessDelta * 0.5)
  );
  const aggr = effectiveAggr / 100;
  const rand = Math.max(0, Math.min(100, randomness)) / 100;
  const isChill = vibe === 'chill-sunset';

  const gentleFx: FxType[] = ['chorus', 'autopan', 'reverb', 'shimmer', 'lofi', 'echo', 'phaser'];
  const clubFx: FxType[] = [
    'dubdelay',
    'shimmer',
    'subharm',
    'phaser',
    'tremolo',
    'flanger',
    'comb',
    'autopan',
    'lofi',
  ];
  const wildFx: FxType[] = [
    'stutter',
    'bitcrush',
    'ringmod',
    'dubdelay',
    'subharm',
    'comb',
    'tremolo',
    'lofi',
    'drive',
  ];

  let pool: FxType[] =
    isChill || aggr < 0.34
      ? gentleFx
      : aggr < 0.68
      ? clubFx
      : wildFx;

  if (rand >= 0.65 && !isChill) {
    pool = [...pool, ...clubFx, ...gentleFx];
  }

  const expandedPool: FxType[] = [...pool];
  for (const fx of pool) {
    const q = taste.fxScores[fx] ?? 0;
    if (q > 1.5 && (!isChill || gentleFx.includes(fx))) expandedPool.push(fx);
  }

  const gentleTricks: SoundTrickType[] = ['chord-stab', 'sweep-down', 'riser-chord', 'riser'];
  const clubTricks: SoundTrickType[] = [
    'riser',
    'laser',
    'chord-stab',
    'snare-roll',
    'tom-fill',
    'vinyl-crack',
    'riser-chord',
    'sweep-down',
  ];
  const wildTricks: SoundTrickType[] = [
    'scratch-chirp',
    'vinyl-crack',
    'tom-fill',
    'drop-alarm',
    'riser-chord',
    'tape-rewind',
    'snare-roll',
    'laser',
    'air-horn',
    'dub-siren',
  ];
  const trickPool = isChill || aggr < 0.34 ? gentleTricks : aggr < 0.68 ? clubTricks : wildTricks;

  let momentCount = 0;
  if (remixMode) {
    momentCount = aggr >= 0.72 || rand >= 0.75 ? 3 : aggr >= 0.3 ? 2 : 1;
  } else if (aggr >= 0.6 || rand >= 0.75 || vibe === 'mashup-live' || vibe === 'scratch-chop') {
    momentCount = 2;
  } else if (aggr >= 0.22 || rand >= 0.4) {
    momentCount = 1;
  }

  if (quickMix && momentCount > 2) momentCount = 2;
  if (momentCount === 0) return [];

  const minPct = 0.09;
  const maxPct = quickMix ? 0.27 : 0.48;
  const span = maxPct - minPct;

  // Structure-aware anchor percentages (prioritize Build & Breakdown sections over Vocal Verses)
  const preferredSectionPcts: number[] = [];
  if (sections && sections.length > 0 && durationSec > 10) {
    for (const seg of sections) {
      if (seg.label === 'build' || seg.label === 'breakdown') {
        const midPct = (seg.startSec + seg.endSec) / (2 * durationSec);
        if (midPct >= minPct && midPct <= maxPct) {
          preferredSectionPcts.push(Math.round(midPct * 1000) / 1000);
        }
      }
    }
  }

  const moments: AiSongEffectMoment[] = [];
  const usedFx = new Set<FxType>();

  // Upgrade #3: VIP Drop Fakeout & Rework right before detected/calibrated drop inside cruising window
  const barSec = (60 / Math.max(65, bpm)) * 4;
  if (
    !isChill &&
    (remixMode || aggr >= 0.58) &&
    typeof dropSec === 'number' &&
    durationSec > 24
  ) {
    const fakeoutStartSec = Math.max(6, dropSec - barSec * 1.5);
    const fakeoutPct = fakeoutStartSec / durationSec;
    if (fakeoutPct >= minPct && fakeoutPct <= maxPct - 0.04) {
      const fakeoutVoice = pickContextVoiceDrop({
        voiceFxEnabled,
        enabledVoiceIds,
        enabledCustomDrops,
        vibe,
        aggressiveness,
        preferCategories: ['countdown', 'hype', 'shout'],
        rng,
      });
      moments.push({
        atPct: Math.round(fakeoutPct * 1000) / 1000,
        durationMs: Math.round(Math.max(2400, Math.min(4400, barSec * 2 * 1000))),
        fxType: 'dubdelay',
        fxWet: 0.64,
        beatDiv: Math.max(0.25, 0.5 * beatDivScale),
        filter: 0.46,
        eqLow: -0.92,
        eqMid: 0.16,
        soundTrick: 'snare-roll',
        voiceDropId: fakeoutVoice?.id,
        beatSlicePattern: [0, 0, 1, 2, 0, 1, 3, 2],
        isVipDropFakeout: true,
        useSampleAccurateBuild: true,
        youtubePumpMode: 'drop-takeover',
        label: `VIP Drop Fakeout${fakeoutVoice ? ` · "${fakeoutVoice.label}"` : ' · Sample-Accurate Build + Re-Drop'}`,
      });
    }
  }

  const chopChoices: AiChopPatternType[] =
    vibe === 'scratch-chop' || aggr >= 0.62
      ? ['quarter-chop', 'eighth-gate', 'transformer-scratch']
      : ['quarter-chop'];
  const cueSeqChoices: number[][] = [
    [0, 0, 1, 2],
    [0, 1, 0, 3],
    [1, 1, 2, 1],
  ];

  const remainingSlots = Math.max(0, momentCount - moments.length);
  for (let i = 0; i < remainingSlots; i++) {
    const slotBase = minPct + ((i + 0.15 + rng() * (0.4 + rand * 0.35)) / Math.max(1, remainingSlots)) * span;
    const rawPct =
      i < preferredSectionPcts.length
        ? preferredSectionPcts[i]
        : Math.max(0.08, Math.min(maxPct, Math.round(slotBase * 1000) / 1000));
    const atPct = Math.max(0.08, Math.min(maxPct, rawPct));

    // Skip colliding closely with a VIP Drop Fakeout window
    if (moments.some((m) => Math.abs(m.atPct - atPct) < 0.06)) continue;

    let fxType = pickOne(expandedPool, rng);
    for (let retry = 0; retry < 5 && usedFx.has(fxType); retry++) {
      fxType = pickOne(expandedPool, rng);
    }
    usedFx.add(fxType);

    const rawDiv = pickOne(aggr > 0.58 ? [0.25, 0.5, 0.75] : [0.5, 0.75, 1], rng);
    const beatDiv = Math.max(0.25, Math.min(2, rawDiv * beatDivScale));
    const fxWet = Math.round((0.32 + aggr * 0.42 + rng() * 0.15) * 100) / 100;
    const filter =
      rng() > 0.4 - rand * 0.2
        ? Math.round((0.18 + aggr * 0.44) * (rng() > 0.38 ? 1 : -1) * 100) / 100
        : 0;

    let eqLow: number | undefined;
    let eqMid: number | undefined;
    let eqHigh: number | undefined;
    const stemRoll = rng();
    if (stemRoll < 0.22 + rand * 0.2) {
      eqLow = -0.88;
      eqMid = 0.16;
    } else if (stemRoll < 0.35 + rand * 0.15) {
      eqMid = -0.68;
      eqHigh = 0.22;
    } else if (fxType === 'subharm') {
      eqLow = 0.22;
    }

    const useLoop = !isChill && (remixMode || aggr > 0.52 || rand > 0.72);
    const loopBars = useLoop && rng() > 0.28 ? pickOne([0.25, 0.5, 1], rng) : undefined;
    const soundTrick = rng() < 0.42 + aggr * 0.35 + rand * 0.18 ? pickOne(trickPool, rng) : undefined;
    const pitchBurst =
      !isChill && aggr > 0.65 && rng() < 0.25 + rand * 0.32
        ? pickOne([0.88, 0.92, 1.06], rng)
        : undefined;

    const chopPattern: AiChopPatternType | undefined =
      !isChill && (remixMode || vibe === 'scratch-chop' || aggr > 0.58) && rng() < 0.36 + aggr * 0.25
        ? pickOne(chopChoices, rng)
        : undefined;
    const cueJuggleSeq: number[] | undefined =
      !isChill && !loopBars && (remixMode || vibe === 'scratch-chop') && rng() < 0.24 + aggr * 0.22
        ? pickOne(cueSeqChoices, rng)
        : undefined;

    const sliceChoices: number[][] = [
      [0, 0, 1, 2, 0, 1, 3, 2],
      [0, 1, 0, 2, 0, 1, 0, 3],
      [0, 0, 2, 2, 1, 3, 1, 3],
    ];
    const beatSlicePattern: number[] | undefined =
      !isChill && !loopBars && (remixMode || aggr >= 0.62) && rng() < 0.32 + aggr * 0.28
        ? pickOne(sliceChoices, rng)
        : undefined;

    // Upgrade #2: Hybrid Synth Pump Mode for YouTube IFrame decks
    const youtubePumpMode: AiSongEffectMoment['youtubePumpMode'] =
      chopPattern === 'eighth-gate' || chopPattern === 'transformer-scratch'
        ? 'gate-8th'
        : beatSlicePattern || loopBars === 0.25 || loopBars === 0.5
        ? 'drop-takeover'
        : !isChill && (remixMode || aggr >= 0.45)
        ? 'sidechain'
        : undefined;

    // Live Micro-Sampler ("Remix Deck C") vocal hook callback on build/drop moments
    const deckCHookPattern: AiSongEffectMoment['deckCHookPattern'] =
      !isChill && (remixMode || vibe === 'mashup-live' || aggr >= 0.55) && rng() < 0.42
        ? pickOne(['quarter', 'half', 'full-echo'], rng)
        : isChill && rng() < 0.28
        ? 'full-echo'
        : undefined;

    const durationMs = Math.round(1050 + (1 - aggr * 0.28) * 900 + rng() * 750);

    const stemTag =
      beatSlicePattern
        ? ' + Beat Slice'
        : cueJuggleSeq
        ? ' + Cue Juggle'
        : chopPattern
        ? ` + ${chopPattern === 'eighth-gate' ? '1/8 Chop' : '1/4 Gate'}`
        : eqLow && eqLow < -0.5
        ? ' + Bass Cut'
        : eqMid && eqMid < -0.5
        ? ' + Mid Scoop'
        : '';

    const voiceChance = isChill
      ? 0.25
      : remixMode
      ? 0.52 + aggr * 0.28
      : 0.32 + aggr * 0.28;
    const preferredCats: DjVoiceCategory[] =
      vibe === 'scratch-chop'
        ? ['scratch-vox', 'groove']
        : vibe === 'festival-drop'
        ? ['countdown', 'shout', 'hype']
        : vibe === 'mashup-live'
        ? ['groove', 'scratch-vox', 'shout']
        : isChill
        ? ['groove']
        : ['groove', 'shout', 'hype', 'scratch-vox'];
    const voicePick =
      rng() < voiceChance
        ? pickContextVoiceDrop({
            voiceFxEnabled,
            enabledVoiceIds,
            enabledCustomDrops,
            vibe,
            aggressiveness,
            preferCategories: preferredCats,
            rng,
          })
        : undefined;
    const voiceDropId = voicePick?.id;

    moments.push({
      atPct,
      durationMs,
      fxType,
      fxWet: Math.min(0.9, fxWet),
      beatDiv,
      filter,
      eqLow,
      eqMid,
      eqHigh,
      loopBars,
      chopPattern,
      cueJuggleSeq,
      soundTrick,
      voiceDropId,
      pitchBurst,
      beatSlicePattern,
      youtubePumpMode,
      deckCHookPattern,
      label: `Take · ${FX_FRIENDLY_NAME[fxType]}${stemTag}${
        voicePick ? ` + "${voicePick.label}"` : ''
      }${deckCHookPattern ? ' + Deck C Hook' : ''}${
        loopBars ? ` + ${loopBars === 0.25 ? '1/4' : loopBars === 0.5 ? '1/2' : '1'}-Bar` : ''
      }`,
    });
  }

  return moments.sort((a, b) => a.atPct - b.atPct);
}

function buildTricksForPlan(params: {
  vibe: AiDjVibe;
  direction: string;
  bpmDiff: number;
  aggressiveness: number;
  randomness: number;
  vocalCompat: ReturnType<typeof computePairVocalCompatibility>;
  outGroove: GrooveDnaGenre;
  inGroove: GrooveDnaGenre;
  rng: () => number;
}): {
  mixStyle: string;
  mixStyleKey: string;
  transitionBars: number;
  incomingStartPct: number;
  tricks: AiTrickStep[];
  signatureTag: string;
  chopPattern: AiChopPatternType;
  cueJuggleSeq?: number[];
  recommendedBridge: GrooveBridgePattern;
  grooveRecipeLabel: string;
} {
  const {
    vibe,
    direction,
    bpmDiff,
    aggressiveness,
    randomness,
    vocalCompat,
    outGroove,
    inGroove,
    rng,
  } = params;
  const taste = loadTasteProfile();
  const aggr = Math.max(
    0,
    Math.min(100, aggressiveness + taste.preferredAggressivenessDelta * 0.45)
  ) / 100;
  const rand = Math.max(0, Math.min(100, randomness)) / 100;
  const scaleInt = (base: number) =>
    Math.round(Math.max(0.28, Math.min(1.0, base * (0.68 + aggr * 0.46))) * 100) / 100;

  const dir = direction.toLowerCase();
  const hasStaircase = /staircase|escalat|4.?stage|silence.?gap/.test(dir);
  const hasCueWordplay = /wordplay|cue.?juggle|stutter.?jump/.test(dir);
  const hasPingPong = /ping.?pong|chop.?seq|gate.?chop|transformer/.test(dir);
  const hasDoubleDrop = /double.?drop/.test(dir);
  const hasDropSwap = /drop.?swap|phrase/.test(dir);
  const hasVocalSwap = /vocal|stem|mid/.test(dir);
  const hasKillSlam = /kill|slam|hard/.test(dir);
  const hasUnderwater = /underwater|lpf|muffle|deep|sunset/.test(dir);
  const hasScratch = /scratch|chop|juggle|backspin|chirp/.test(dir);
  const hasPhaser = /phaser|swirl|psych/.test(dir);
  const hasCrush = /crush|bit|lofi|vinyl/.test(dir);
  const hasGate = /gate|tremolo|trance|pump/.test(dir);
  const hasChorus = /chorus|shimmer|wide/.test(dir);
  const hasRingmod = /ring|morph|metallic/.test(dir);
  const hasAutopan = /pan|stereo|drift/.test(dir);
  const hasComb = /comb|resonat/.test(dir);
  const hasStutter = /stutter|repeat/.test(dir);
  const hasSubharm = /sub|punch|bass.?boost/.test(dir);
  const hasShimmer = /shimmer|air|euphoric/.test(dir);
  const hasDub = /dub|dotted|delay/.test(dir);
  const hasEchoFreeze = /freeze|horn|air.?horn|alarm/.test(dir);
  const hasSnareLaser = /snare|roll|laser|tom/.test(dir);
  const hasVinylStop = /vinyl.?stop|power.?down|rewind/.test(dir);
  const hasQuick = /fast|quick|short|cut/.test(dir);
  const hasLong = /long|slow|extended|gradual/.test(dir);

  let transitionBars =
    vibe === 'scratch-chop'
      ? 4
      : vibe === 'techno-hypnotic' || vibe === 'chill-sunset' || vibe === 'mashup-live'
      ? 16
      : 8;

  // Apply Vocal/Instrumental Mashup awareness to transition duration
  transitionBars = Math.max(
    4,
    Math.min(vibe === 'mashup-live' ? 24 : 20, transitionBars + vocalCompat.recommendedBarsBonus)
  );
  if (hasQuick || (aggr >= 0.8 && transitionBars > 4 && vibe !== 'techno-hypnotic' && vibe !== 'mashup-live')) {
    transitionBars = 4;
  } else if (hasLong && transitionBars < 16) {
    transitionBars = 16;
  }

  let incomingStartPct =
    vibe === 'festival-drop' || vibe === 'scratch-chop'
      ? 0.14
      : vibe === 'mashup-live'
      ? 0.1
      : 0.04;
  if (hasDoubleDrop || hasDropSwap || hasStaircase || hasQuick || aggr > 0.7) {
    incomingStartPct = 0.15;
  }
  incomingStartPct = Math.max(0.02, Math.min(0.24, incomingStartPct + (rng() - 0.5) * rand * 0.1));

  // Advance #5 & Wave-2 #7: Groove & Genre DNA Pairing Recipe (+ In-Key Chord/Arp Bridges)
  let grooveRecipeLabel = 'Club Harmonic Blend';
  let recommendedBridge: GrooveBridgePattern = 'top-hats';
  if ((outGroove === 'pop-vocal' || outGroove === 'trap-halftime') && inGroove === 'house-edm') {
    grooveRecipeLabel = 'Vocal/Trap → Club Drop';
    recommendedBridge = 'house-4x4';
  } else if (outGroove === 'lofi-slowed' && (inGroove === 'house-edm' || inGroove === 'dnb-break')) {
    grooveRecipeLabel = 'Slowed → High-Energy Lift';
    recommendedBridge = 'sub-808';
  } else if (outGroove === 'afro-reggaeton' || inGroove === 'afro-reggaeton') {
    grooveRecipeLabel = 'Afro/Dem-bow Groove Lock';
    recommendedBridge = 'afro-perc';
  } else if (vibe === 'chill-sunset' || vibe === 'mashup-live' || outGroove === 'lofi-slowed') {
    grooveRecipeLabel = 'Harmonic Chord & Arp Glue';
    recommendedBridge = 'chord-arp';
  } else if (outGroove === 'house-edm' && inGroove === 'house-edm') {
    grooveRecipeLabel = '4×4 Extended Club Mix';
    recommendedBridge = 'top-hats';
  } else if (outGroove === 'trap-halftime' || inGroove === 'trap-halftime') {
    grooveRecipeLabel = '808 Halftime Switch';
    recommendedBridge = 'sub-808';
  }

  // Explicit Directive 1: 4-Stage Staircase Roll Escalation -> 1-Beat Silence -> Sub-Drop + Hard Cut
  if (hasStaircase) {
    return {
      mixStyle: '4-Stage Staircase Roll & Silence Drop',
      mixStyleKey: 'staircase-drop-build',
      signatureTag: 'Staircase 2→1→1/2 + Silence Drop',
      transitionBars: Math.max(8, transitionBars),
      incomingStartPct: 0.16,
      chopPattern: 'eighth-gate',
      recommendedBridge,
      grooveRecipeLabel,
      tricks: [
        { atProgress: 0.04, durationProgress: 0.16, action: 'sound-riser-chord', targetDeck: 'incoming', intensity: scaleInt(0.84), label: 'In-Key Staircase Riser' },
        { atProgress: 0.06, durationProgress: 0.88, action: 'staircase-drop-build', targetDeck: 'outgoing', intensity: scaleInt(0.95), label: '4-Stage Staircase Roll Escalation' },
        { atProgress: 0.56, durationProgress: 0.18, action: 'sound-snare-roll', targetDeck: 'outgoing', intensity: scaleInt(0.9), label: '16th Escalation Snare Roll' },
        { atProgress: 0.86, durationProgress: 0.12, action: 'sound-sub-drop', targetDeck: 'incoming', intensity: scaleInt(0.96), label: 'In-Key Sub-Drop Hard Cut' },
      ],
    };
  }

  // Explicit Directive 2: Hot-Cue Wordplay & Stutter Jumps
  if (hasCueWordplay) {
    const seq = pickOne(
      [
        [0, 0, 1, 2],
        [0, 1, 0, 3],
        [1, 1, 2, 3],
      ],
      rng
    );
    return {
      mixStyle: 'Hot-Cue Wordplay Juggle Swap',
      mixStyleKey: 'cue-wordplay-juggle',
      signatureTag: `Cue Juggle [${seq.map((i) => i + 1).join('-')}]`,
      transitionBars: Math.max(4, Math.min(8, transitionBars)),
      incomingStartPct: 0.14,
      chopPattern: 'quarter-chop',
      cueJuggleSeq: seq,
      recommendedBridge,
      grooveRecipeLabel,
      tricks: [
        { atProgress: 0.05, durationProgress: 0.42, action: 'cue-wordplay-juggle', targetDeck: 'outgoing', intensity: scaleInt(0.9), label: `Cue Wordplay (${seq.map((n) => n + 1).join('-')})` },
        { atProgress: 0.44, durationProgress: 0.12, action: pickOne(['sound-scratch-chirp', 'sound-chord-stab'], rng), targetDeck: 'incoming', intensity: scaleInt(0.86), label: 'In-Key Wordplay Accent' },
        { atProgress: 0.48, durationProgress: 0.34, action: 'xfade-chop-16th', targetDeck: 'incoming', intensity: scaleInt(0.92), label: '1/8-Beat Chop Launch' },
        { atProgress: 0.8, durationProgress: 0.18, action: 'sound-sub-drop', targetDeck: 'incoming', intensity: scaleInt(0.9), label: 'Sub-Drop Anchor Lock' },
      ],
    };
  }

  // Explicit Directive 3: Crossfader Pattern Sequencer (Ping-Pong / 1/8 Chop / Transformer)
  if (hasPingPong) {
    const useTransformer = /transformer/.test(dir);
    const pattern: AiChopPatternType = useTransformer ? 'transformer-scratch' : 'ping-pong-2beat';
    return {
      mixStyle: useTransformer ? 'Transformer Gate Scratch Cut' : '2-Beat Ping-Pong Sequencer',
      mixStyleKey: useTransformer ? 'transformer-cut' : 'xfade-ping-pong',
      signatureTag: useTransformer ? 'Transformer Gate Chop' : '2-Beat Ping-Pong A↔B',
      transitionBars: Math.max(4, Math.min(8, transitionBars)),
      incomingStartPct: 0.12,
      chopPattern: pattern,
      recommendedBridge,
      grooveRecipeLabel,
      tricks: [
        { atProgress: 0.06, durationProgress: 0.14, action: 'sound-riser-chord', targetDeck: 'incoming', intensity: scaleInt(0.8), label: 'In-Key Prep Riser' },
        {
          atProgress: 0.12,
          durationProgress: 0.68,
          action: useTransformer ? 'transformer-cut' : 'xfade-ping-pong',
          targetDeck: 'incoming',
          intensity: scaleInt(0.92),
          label: useTransformer ? 'Synced Transformer Gate' : '2-Beat A↔B Ping-Pong',
        },
        { atProgress: 0.78, durationProgress: 0.14, action: 'sound-sub-drop', targetDeck: 'incoming', intensity: scaleInt(0.9), label: 'Downbeat Sub Resolution' },
      ],
    };
  }

  if (hasDoubleDrop) {
    return {
      mixStyle: 'Double-Drop Harmonic Slam',
      mixStyleKey: 'double-drop-sync',
      signatureTag: 'Double Drop + Snare + Sub',
      transitionBars,
      incomingStartPct,
      chopPattern: 'off',
      recommendedBridge,
      grooveRecipeLabel,
      tricks: [
        { atProgress: 0.04, durationProgress: 0.24, action: 'sound-riser', targetDeck: 'incoming', intensity: scaleInt(0.85), label: 'Build Tension Riser' },
        { atProgress: 0.12, durationProgress: 0.26, action: 'beat-loop-roll', targetDeck: 'outgoing', intensity: scaleInt(0.78), label: '1/2-Bar Loop Roll Build' },
        { atProgress: 0.26, durationProgress: 0.14, action: 'sound-snare-roll', targetDeck: 'outgoing', intensity: scaleInt(0.85), label: '16th Snare Roll Build' },
        { atProgress: 0.42, durationProgress: 0.36, action: 'double-drop-sync', targetDeck: 'incoming', intensity: scaleInt(0.95), label: 'Dual-Deck Double Drop' },
        { atProgress: 0.48, durationProgress: 0.1, action: 'sound-sub-drop', targetDeck: 'incoming', intensity: scaleInt(0.9), label: 'Sub-Bass Impact Hit' },
        { atProgress: 0.78, durationProgress: 0.2, action: 'echo-out', targetDeck: 'outgoing', intensity: scaleInt(0.72), label: 'Echo Tail Release' },
      ],
    };
  }

  if (hasDropSwap) {
    return {
      mixStyle: 'Phrase Drop & Roll Swap',
      mixStyleKey: 'phrase-drop-swap',
      signatureTag: 'Drop Swap + Chord Stab',
      transitionBars: 8,
      incomingStartPct,
      chopPattern: 'off',
      recommendedBridge,
      grooveRecipeLabel,
      tricks: [
        { atProgress: 0.06, durationProgress: 0.26, action: pickOne(['phaser-swirl', 'comb-resonator'], rng), targetDeck: 'outgoing', intensity: scaleInt(0.75), label: 'Buildup Resonator Swirl' },
        { atProgress: 0.22, durationProgress: 0.16, action: 'sound-snare-roll', targetDeck: 'outgoing', intensity: scaleInt(0.88), label: 'Quantized Snare Fill' },
        { atProgress: 0.42, durationProgress: 0.34, action: 'phrase-drop-swap', targetDeck: 'incoming', intensity: scaleInt(0.95), label: 'Downbeat Bass-Drop Swap' },
        { atProgress: 0.46, durationProgress: 0.12, action: pickOne(['sound-sub-drop', 'sound-chord-stab'], rng), targetDeck: 'incoming', intensity: scaleInt(0.9), label: 'Impact Drop Stab' },
        { atProgress: 0.76, durationProgress: 0.2, action: 'echo-freeze-cut', targetDeck: 'outgoing', intensity: scaleInt(0.75), label: 'Echo Freeze Exit' },
      ],
    };
  }

  if (hasStutter || hasRingmod || hasComb || hasAutopan) {
    const leadAction: AiTrickActionType = hasStutter
      ? 'stutter-drop'
      : hasRingmod
      ? 'ringmod-morph'
      : hasComb
      ? 'comb-resonator'
      : 'autopan-drift';
    const leadTitle = hasStutter
      ? 'Beat Stutter Chop'
      : hasRingmod
      ? 'Ring-Mod Sci-Fi Morph'
      : hasComb
      ? 'Comb Resonator Sweep'
      : '3D Auto-Pan Glide';
    return {
      mixStyle: leadTitle,
      mixStyleKey: leadAction,
      signatureTag: leadTitle,
      transitionBars,
      incomingStartPct,
      chopPattern: hasStutter ? 'quarter-chop' : 'off',
      recommendedBridge,
      grooveRecipeLabel,
      tricks: [
        { atProgress: 0.06, durationProgress: 0.36, action: leadAction, targetDeck: 'outgoing', intensity: scaleInt(0.85), label: leadTitle },
        { atProgress: 0.3, durationProgress: 0.14, action: pickOne(['sound-tape-rewind', 'sound-chord-stab', 'sound-laser'], rng), targetDeck: 'incoming', intensity: scaleInt(0.82), label: 'Session Signature Hit' },
        { atProgress: 0.46, durationProgress: 0.32, action: aggr > 0.6 ? 'kill-drop-slam' : 'eq-bass-swap', targetDeck: 'incoming', intensity: scaleInt(0.92), label: 'Harmonic Bass Cutover' },
        { atProgress: 0.76, durationProgress: 0.2, action: pickOne(['echo-out', 'reverb-wash'], rng), targetDeck: 'outgoing', intensity: scaleInt(0.75), label: 'Smooth Space Exit' },
      ],
    };
  }

  if (hasPhaser) {
    return {
      mixStyle: 'Phaser Vortex Blend',
      mixStyleKey: 'phaser-swirl',
      signatureTag: 'Phaser + Chorus',
      transitionBars,
      incomingStartPct,
      chopPattern: 'off',
      recommendedBridge,
      grooveRecipeLabel,
      tricks: [
        { atProgress: 0.08, durationProgress: 0.42, action: 'phaser-swirl', targetDeck: 'outgoing', intensity: scaleInt(0.88), label: '4-Stage Phaser Sweep' },
        { atProgress: 0.3, durationProgress: 0.32, action: 'chorus-shimmer', targetDeck: 'incoming', intensity: scaleInt(0.7), label: 'Stereo Chorus Entry' },
        { atProgress: 0.46, durationProgress: 0.3, action: 'eq-bass-swap', targetDeck: 'incoming', intensity: scaleInt(0.9), label: 'Harmonic Bass Swap' },
        { atProgress: 0.74, durationProgress: 0.22, action: 'reverb-wash', targetDeck: 'outgoing', intensity: scaleInt(0.72), label: 'Lush Reverb Wash' },
      ],
    };
  }

  if (hasCrush) {
    return {
      mixStyle: 'Bitcrush Breakdown Cut',
      mixStyleKey: 'bitcrush-breakdown',
      signatureTag: 'Crush + Laser Slam',
      transitionBars,
      incomingStartPct,
      chopPattern: 'off',
      recommendedBridge,
      grooveRecipeLabel,
      tricks: [
        { atProgress: 0.08, durationProgress: 0.34, action: 'bitcrush-breakdown', targetDeck: 'outgoing', intensity: scaleInt(0.85), label: 'Lo-Fi Bitcrush Degrade' },
        { atProgress: 0.32, durationProgress: 0.14, action: 'sound-laser', targetDeck: 'incoming', intensity: scaleInt(0.8), label: 'Laser Synth Cue Shot' },
        { atProgress: 0.45, durationProgress: 0.32, action: 'kill-drop-slam', targetDeck: 'incoming', intensity: scaleInt(0.95), label: 'Clean Drop Slam' },
        { atProgress: 0.76, durationProgress: 0.2, action: 'echo-out', targetDeck: 'outgoing', intensity: scaleInt(0.7), label: 'Echo Out Fade' },
      ],
    };
  }

  if (hasGate) {
    return {
      mixStyle: 'Trance-Gate Tremolo Switch',
      mixStyleKey: 'tremolo-gate',
      signatureTag: 'Gate + Mid Stem',
      transitionBars,
      incomingStartPct,
      chopPattern: 'quarter-chop',
      recommendedBridge,
      grooveRecipeLabel,
      tricks: [
        { atProgress: 0.1, durationProgress: 0.38, action: 'tremolo-gate', targetDeck: 'outgoing', intensity: scaleInt(0.85), label: 'Beat-Synced Tremolo Gate' },
        { atProgress: 0.28, durationProgress: 0.32, action: 'stem-mid-swap', targetDeck: 'incoming', intensity: scaleInt(0.8), label: 'Mid-Band Groove Layer' },
        { atProgress: 0.5, durationProgress: 0.28, action: 'eq-bass-swap', targetDeck: 'incoming', intensity: scaleInt(0.92), label: 'Quantized Bass Takeover' },
        { atProgress: 0.78, durationProgress: 0.18, action: 'filter-sweep', targetDeck: 'outgoing', intensity: scaleInt(0.75), label: 'HPF Air Sweep Out' },
      ],
    };
  }

  if (hasEchoFreeze || hasSnareLaser || hasVinylStop) {
    return {
      mixStyle: 'Club Stunt Echo-Freeze Transition',
      mixStyleKey: 'echo-freeze-cut',
      signatureTag: 'Echo Freeze + Stunt Hit',
      transitionBars: 8,
      incomingStartPct,
      chopPattern: 'off',
      recommendedBridge,
      grooveRecipeLabel,
      tricks: [
        { atProgress: 0.08, durationProgress: 0.2, action: 'sound-snare-roll', targetDeck: 'outgoing', intensity: scaleInt(0.85), label: 'Snare Roll Anticipation' },
        { atProgress: 0.28, durationProgress: 0.24, action: 'echo-freeze-cut', targetDeck: 'outgoing', intensity: scaleInt(0.88), label: 'Echo Freeze Cross-Cut' },
        {
          atProgress: 0.48,
          durationProgress: 0.12,
          action: hasVinylStop ? 'sound-tape-rewind' : hasEchoFreeze ? 'sound-air-horn' : 'sound-laser',
          targetDeck: 'incoming',
          intensity: scaleInt(0.85),
          label: hasVinylStop ? 'Tape Rewind Spinback' : hasEchoFreeze ? 'Club Horn Impact' : 'Laser Synth Zap',
        },
        { atProgress: 0.52, durationProgress: 0.3, action: 'eq-bass-swap', targetDeck: 'incoming', intensity: scaleInt(0.92), label: 'Locked Bass Handover' },
      ],
    };
  }

  if (hasVocalSwap || hasChorus) {
    return {
      mixStyle: 'Vocal Mid-Stem & Chorus Shimmer',
      mixStyleKey: 'stem-mid-swap',
      signatureTag: 'Vocal Stem + Chorus',
      transitionBars,
      incomingStartPct,
      chopPattern: 'off',
      recommendedBridge,
      grooveRecipeLabel,
      tricks: [
        { atProgress: 0.05, durationProgress: 0.25, action: 'lpf-underwater-blend', targetDeck: 'outgoing', intensity: scaleInt(0.6), label: 'Soft LPF Entry Carve' },
        { atProgress: 0.18, durationProgress: 0.38, action: 'chorus-shimmer', targetDeck: 'incoming', intensity: scaleInt(0.68), label: 'Stereo Chorus Vocal Bed' },
        { atProgress: 0.22, durationProgress: 0.45, action: 'stem-mid-swap', targetDeck: 'incoming', intensity: scaleInt(0.85), label: 'Vocal / Mid Stem Swap' },
        { atProgress: 0.48, durationProgress: 0.3, action: 'eq-bass-swap', targetDeck: 'incoming', intensity: scaleInt(0.9), label: 'Clean Low-End Handover' },
        { atProgress: 0.74, durationProgress: 0.24, action: 'reverb-wash', targetDeck: 'outgoing', intensity: scaleInt(0.65), label: 'Silk Reverb Fade Out' },
      ],
    };
  }

  if (hasKillSlam) {
    return {
      mixStyle: 'EQ Kill-Drop Slam',
      mixStyleKey: 'kill-drop-slam',
      signatureTag: 'Kill Slam + Sub Punch',
      transitionBars,
      incomingStartPct,
      chopPattern: 'off',
      recommendedBridge,
      grooveRecipeLabel,
      tricks: [
        { atProgress: 0.08, durationProgress: 0.25, action: pickOne(['flanger-riser', 'comb-resonator'], rng), targetDeck: 'outgoing', intensity: scaleInt(0.8), label: 'Resonant Tension Sweep' },
        { atProgress: 0.25, durationProgress: 0.15, action: 'sound-riser', targetDeck: 'incoming', intensity: scaleInt(0.9), label: 'White-Noise Riser' },
        { atProgress: 0.46, durationProgress: 0.38, action: 'kill-drop-slam', targetDeck: 'incoming', intensity: scaleInt(0.95), label: 'Bass-Kill Drop Slam' },
        { atProgress: 0.52, durationProgress: 0.12, action: 'sound-sub-drop', targetDeck: 'incoming', intensity: scaleInt(0.9), label: 'Sub Impact Punch' },
        { atProgress: 0.8, durationProgress: 0.18, action: 'echo-out', targetDeck: 'outgoing', intensity: scaleInt(0.75), label: 'Outgoing Echo Decay' },
      ],
    };
  }

  if (hasScratch || vibe === 'scratch-chop') {
    const seq = pickOne(
      [
        [0, 0, 1, 2],
        [0, 1, 0, 3],
      ],
      rng
    );
    const chopOp = pickOne(['xfade-chop-16th', 'xfade-ping-pong', 'transformer-cut'] as const, rng);
    const hitSfx = pickOne(['sound-scratch-chirp', 'sound-tape-rewind', 'sound-laser'] as const, rng);
    return {
      mixStyle: 'Cue-Juggle & Chop Sequencer',
      mixStyleKey: chopOp,
      signatureTag: `Chop · ${hitSfx.replace('sound-', '')}`,
      transitionBars: 4,
      incomingStartPct: 0.12,
      chopPattern: chopOp === 'transformer-cut' ? 'transformer-scratch' : 'ping-pong-2beat',
      cueJuggleSeq: seq,
      recommendedBridge,
      grooveRecipeLabel,
      tricks: [
        { atProgress: 0.05, durationProgress: 0.28, action: 'cue-wordplay-juggle', targetDeck: 'outgoing', intensity: scaleInt(0.88), label: 'Quantized Cue Wordplay' },
        { atProgress: 0.32, durationProgress: 0.34, action: chopOp, targetDeck: 'incoming', intensity: scaleInt(0.92), label: 'Crossfader Rhythm Sequencer' },
        { atProgress: 0.56, durationProgress: 0.14, action: hitSfx, targetDeck: 'incoming', intensity: scaleInt(0.84), label: 'Turntablist Trick Shot' },
        { atProgress: 0.7, durationProgress: 0.22, action: 'eq-bass-swap', targetDeck: 'incoming', intensity: scaleInt(0.92), label: 'Instant Bass Cutover' },
        { atProgress: 0.82, durationProgress: 0.16, action: pickOne(['sound-backspin', 'vinyl-brake'], rng), targetDeck: 'outgoing', intensity: scaleInt(0.85), label: 'Vinyl Backspin Exit' },
      ],
    };
  }

  if (hasSubharm || hasShimmer || hasDub || (/lofi|vinyl/.test(dir) && !/bit/.test(dir))) {
    const newAction: AiTrickActionType = hasSubharm
      ? 'subharm-boost'
      : hasShimmer
      ? 'shimmer-lift'
      : hasDub
      ? 'dubdelay-throw'
      : 'lofi-tape-warp';
    const title = hasSubharm
      ? 'Sub-Harmonic Drop Punch'
      : hasShimmer
      ? 'Euphoric Shimmer Lift'
      : hasDub
      ? 'Dotted Dub Delay Throw'
      : 'Lo-Fi Tape Breakdown';
    return {
      mixStyle: title,
      mixStyleKey: newAction,
      signatureTag: title,
      transitionBars,
      incomingStartPct,
      chopPattern: 'off',
      recommendedBridge,
      grooveRecipeLabel,
      tricks: [
        { atProgress: 0.06, durationProgress: 0.38, action: newAction, targetDeck: hasSubharm ? 'incoming' : 'outgoing', intensity: scaleInt(0.86), label: title },
        { atProgress: 0.34, durationProgress: 0.14, action: pickOne(['sound-riser-chord', 'sound-tom-fill', 'sound-vinyl-crack'], rng), targetDeck: 'incoming', intensity: scaleInt(0.85), label: 'Dynamic Accent Hit' },
        { atProgress: 0.48, durationProgress: 0.3, action: 'eq-bass-swap', targetDeck: 'incoming', intensity: scaleInt(0.92), label: 'Harmonic Bass Takeover' },
        { atProgress: 0.76, durationProgress: 0.22, action: hasDub ? 'dubdelay-throw' : 'reverb-wash', targetDeck: 'outgoing', intensity: scaleInt(0.76), label: 'Tail Wash Out' },
      ],
    };
  }

  // Session-unique stochastic choreography seeded with Groove DNA + Genre Transition Physics + Taste Learning Q-scores
  const genrePhysics = resolveGenrePhysicsMode(vibe, outGroove, inGroove);

  const openerPool: AiTrickActionType[] =
    genrePhysics === 'chill-velvet'
      ? ['lpf-underwater-blend', 'shimmer-lift', 'lofi-tape-warp', 'autopan-drift', 'chorus-shimmer']
      : genrePhysics === 'dnb-chop'
      ? ['beat-loop-roll', 'xfade-chop-16th', 'transformer-cut', 'flanger-riser']
      : genrePhysics === 'trap-to-house'
      ? ['stem-mid-swap', 'shimmer-lift', 'staircase-drop-build', 'dubdelay-throw']
      : vibe === 'techno-hypnotic'
      ? ['dubdelay-throw', 'phaser-swirl', 'comb-resonator', 'tremolo-gate', 'xfade-ping-pong']
      : vibe === 'mashup-live'
      ? ['shimmer-lift', 'chorus-shimmer', 'xfade-ping-pong', 'stem-mid-swap', 'tremolo-gate']
      : outGroove === 'pop-vocal' && inGroove === 'house-edm'
      ? ['cue-wordplay-juggle', 'stem-mid-swap', 'staircase-drop-build', 'xfade-ping-pong']
      : vibe === 'festival-drop'
      ? aggr > 0.55
        ? ['staircase-drop-build', 'stutter-drop', 'comb-resonator', 'flanger-riser', 'subharm-boost']
        : ['shimmer-lift', 'flanger-riser', 'phaser-swirl', 'beat-loop-roll']
      : aggr > 0.65
      ? ['staircase-drop-build', 'cue-wordplay-juggle', 'xfade-chop-16th', 'ringmod-morph', 'bitcrush-breakdown']
      : aggr < 0.3
      ? ['lpf-underwater-blend', 'shimmer-lift', 'chorus-shimmer', 'autopan-drift', 'lofi-tape-warp']
      : ['dubdelay-throw', 'xfade-ping-pong', 'shimmer-lift', 'phaser-swirl', 'stem-mid-swap', 'autopan-drift'];

  const weightedOpeners: AiTrickActionType[] = [...openerPool];
  for (const op of openerPool) {
    if ((taste.styleScores[op] ?? 0) > 1.2) {
      weightedOpeners.push(op, op);
    }
  }

  const swapPool: AiTrickActionType[] =
    genrePhysics === 'chill-velvet'
      ? ['eq-bass-swap', 'stem-mid-swap']
      : genrePhysics === 'dnb-chop'
      ? ['kill-drop-slam', 'phrase-drop-swap', 'double-drop-sync']
      : aggr > 0.7
      ? ['phrase-drop-swap', 'kill-drop-slam', 'double-drop-sync', 'subharm-boost', 'eq-bass-swap']
      : aggr < 0.3
      ? ['eq-bass-swap', 'stem-mid-swap']
      : ['eq-bass-swap', 'phrase-drop-swap', 'subharm-boost', 'stem-mid-swap'];

  const exitPool: AiTrickActionType[] =
    genrePhysics === 'chill-velvet'
      ? ['reverb-wash', 'shimmer-lift', 'lofi-tape-warp', 'filter-sweep']
      : aggr > 0.68
      ? ['echo-freeze-cut', 'dubdelay-throw', 'vinyl-brake', 'stutter-drop', 'lofi-tape-warp']
      : ['dubdelay-throw', 'echo-out', 'reverb-wash', 'shimmer-lift', 'filter-sweep'];

  const sfxPool: SoundTrickType[] =
    genrePhysics === 'chill-velvet'
      ? ['chord-stab', 'riser-chord', 'sweep-down', 'vinyl-crack']
      : aggr > 0.68
      ? ['drop-alarm', 'tom-fill', 'vinyl-crack', 'snare-roll', 'sub-drop', 'tape-rewind', 'scratch-chirp', 'riser-chord']
      : aggr < 0.3
      ? ['sweep-down', 'chord-stab', 'riser-chord']
      : ['riser-chord', 'tom-fill', 'vinyl-crack', 'riser', 'sub-drop', 'chord-stab', 'dub-siren'];

  if (genrePhysics === 'chill-velvet' && transitionBars < 16 && !hasQuick) {
    transitionBars = 16;
  } else if (genrePhysics === 'dnb-chop' && transitionBars > 8) {
    transitionBars = 8;
  }

  const openFx = pickOne(weightedOpeners, rng);
  const swapTrick = pickOne(swapPool, rng);
  const exitFx = pickOne(exitPool, rng);
  const midSfx = pickOne(sfxPool, rng);

  if (openFx === 'staircase-drop-build') {
    return {
      mixStyle: `${grooveRecipeLabel} · 4-Stage Staircase Drop`,
      mixStyleKey: 'staircase-drop-build',
      signatureTag: 'Staircase 2→1→1/2 + Silence',
      transitionBars: Math.max(8, transitionBars),
      incomingStartPct: Math.max(0.14, incomingStartPct),
      chopPattern: 'eighth-gate',
      recommendedBridge,
      grooveRecipeLabel,
      tricks: [
        { atProgress: 0.04, durationProgress: 0.16, action: 'sound-riser-chord', targetDeck: 'incoming', intensity: scaleInt(0.84), label: 'In-Key Staircase Riser' },
        { atProgress: 0.06, durationProgress: 0.88, action: 'staircase-drop-build', targetDeck: 'outgoing', intensity: scaleInt(0.95), label: '4-Stage Staircase Roll' },
        { atProgress: 0.56, durationProgress: 0.18, action: 'sound-snare-roll', targetDeck: 'outgoing', intensity: scaleInt(0.9), label: '16th Escalation Snare Roll' },
        { atProgress: 0.86, durationProgress: 0.12, action: 'sound-sub-drop', targetDeck: 'incoming', intensity: scaleInt(0.96), label: 'In-Key Sub-Drop Cutover' },
      ],
    };
  }

  const labelMap: Partial<Record<AiTrickActionType, string>> = {
    'lpf-underwater-blend': 'Underwater LPF Entry',
    'autopan-drift': '3D Auto-Pan Glide',
    'chorus-shimmer': 'Stereo Chorus Shimmer',
    'phaser-swirl': '4-Stage Phaser Swirl',
    'comb-resonator': 'Comb Resonator Sweep',
    'tremolo-gate': 'Beat-Synced Gate',
    'flanger-riser': 'Jet Flanger Tension',
    'stutter-drop': 'Square Stutter Chop',
    'ringmod-morph': 'Ring-Mod Morph',
    'bitcrush-breakdown': 'Lo-Fi Bitcrush',
    'subharm-boost': 'Sub-Harmonic Punch',
    'shimmer-lift': 'Airy Shimmer Lift',
    'lofi-tape-warp': 'Lo-Fi Tape Breakdown',
    'dubdelay-throw': 'Dotted Dub Delay',
    'stem-mid-swap': 'Mid-Stem Vocal Swap',
    'beat-loop-roll': '1/2-Bar Loop Roll',
    'eq-bass-swap': 'Harmonic Bass Swap',
    'phrase-drop-swap': 'Phrase Bass-Drop Swap',
    'kill-drop-slam': 'EQ Kill-Drop Slam',
    'double-drop-sync': 'Dual Double-Drop Lock',
    'echo-freeze-cut': 'Echo Freeze Cut',
    'vinyl-brake': 'Turntable Brake Out',
    'echo-out': '1/2-Beat Echo Tail',
    'reverb-wash': 'Cathedral Reverb Wash',
    'filter-sweep': 'HPF Air Sweep Out',
    'cue-wordplay-juggle': 'Hot-Cue Wordplay Juggle',
    'xfade-chop-16th': '1/8-Beat Chop Gate',
    'xfade-ping-pong': '2-Beat Ping-Pong A↔B',
    'transformer-cut': 'Transformer Scratch Cut',
    'staircase-drop-build': '4-Stage Staircase Build',
  };

  const chopPattern: AiChopPatternType =
    openFx === 'xfade-ping-pong'
      ? 'ping-pong-2beat'
      : openFx === 'xfade-chop-16th'
      ? 'eighth-gate'
      : openFx === 'transformer-cut'
      ? 'transformer-scratch'
      : 'off';

  const cueJuggleSeq =
    openFx === 'cue-wordplay-juggle' ? pickOne([[0, 0, 1, 2], [0, 1, 0, 3]], rng) : undefined;

  const tricks: AiTrickStep[] = [
    {
      atProgress: 0.05,
      durationProgress: openFx === 'cue-wordplay-juggle' || openFx.startsWith('xfade-') ? 0.42 : 0.34,
      action: openFx,
      targetDeck:
        openFx === 'chorus-shimmer' || openFx === 'stem-mid-swap' || openFx === 'shimmer-lift'
          ? 'incoming'
          : 'outgoing',
      intensity: scaleInt(0.8),
      label: labelMap[openFx] || 'Opening Texture',
    },
    ...(aggr >= 0.38 && rng() > 0.3 - rand * 0.2
      ? [
          {
            atProgress: 0.26,
            durationProgress: 0.22,
            action: (aggr > 0.65
              ? pickOne(['beat-loop-roll', 'xfade-chop-16th', 'lofi-tape-warp'], rng)
              : 'stem-mid-swap') as AiTrickActionType,
            targetDeck: (aggr > 0.65 ? 'outgoing' : 'incoming') as 'outgoing' | 'incoming',
            intensity: scaleInt(0.82),
            label: aggr > 0.65 ? 'Mid-Transition Chop Roll' : 'Mid-Stem Layering',
          },
        ]
      : []),
    {
      atProgress: 0.44,
      durationProgress: 0.14,
      action: (`sound-${midSfx === 'dub-siren' ? 'siren' : midSfx}`) as AiTrickActionType,
      targetDeck: 'incoming',
      intensity: scaleInt(0.8),
      label: `In-Key · ${midSfx}`,
    },
    {
      atProgress: 0.48,
      durationProgress: 0.32,
      action: swapTrick,
      targetDeck: 'incoming',
      intensity: scaleInt(0.92),
      label: labelMap[swapTrick] || 'Bass Handover',
    },
    {
      atProgress: 0.76,
      durationProgress: 0.22,
      action: exitFx,
      targetDeck: 'outgoing',
      intensity: scaleInt(0.76),
      label: labelMap[exitFx] || 'Exit Tail',
    },
  ];

  const vibeTitle: Record<AiDjVibe, string> = {
    'club-blend': 'Club Blend',
    'festival-drop': 'Festival Peak',
    'techno-hypnotic': 'Techno Hypnotic',
    'scratch-chop': 'Turntablist Chop',
    'mashup-live': 'Live Mashup',
    'chill-sunset': 'Velvet Sunset',
  };

  return {
    mixStyle: `${vibeTitle[vibe]} · ${labelMap[openFx] || grooveRecipeLabel}`,
    mixStyleKey: openFx,
    signatureTag: `${(labelMap[openFx] || openFx).split(' ')[0]} + ${midSfx}`,
    transitionBars: bpmDiff > 10 && !hasQuick ? Math.max(8, transitionBars) : transitionBars,
    incomingStartPct,
    tricks,
    chopPattern,
    cueJuggleSeq,
    recommendedBridge,
    grooveRecipeLabel,
  };
}

export function generateOfflineWildTake(params: {
  aggressiveness?: number;
  randomness?: number;
  seed?: number;
  voiceFxEnabled?: boolean;
  enabledVoiceIds?: DjVoiceDropId[];
  enabledCustomDrops?: CustomVoiceDropMeta[];
}): AiSongEffectMoment {
  const {
    aggressiveness = 65,
    randomness = 75,
    seed = Date.now(),
    voiceFxEnabled = false,
    enabledVoiceIds = [],
    enabledCustomDrops = [],
  } = params;
  const rng = createRng((seed ^ 0x9e3779b9) >>> 0);
  const chosenVibe = pickOne(['club-blend', 'festival-drop', 'mashup-live', 'scratch-chop'] as const, rng);
  const moments = buildSongEffectMoments({
    vibe: chosenVibe,
    remixMode: true,
    aggressiveness: Math.max(55, aggressiveness),
    randomness: Math.max(60, randomness),
    quickMix: false,
    voiceFxEnabled,
    enabledVoiceIds,
    enabledCustomDrops,
    rng,
  });
  const baseMoment =
    moments[0] || {
      atPct: 0.1,
      durationMs: 2200,
      fxType: 'dubdelay',
      fxWet: 0.58,
      beatDiv: 0.5,
      filter: 0.25,
      eqLow: -0.82,
      chopPattern: 'quarter-chop',
      beatSlicePattern: [0, 0, 1, 2, 0, 1, 3, 2],
      soundTrick: 'chord-stab',
      label: 'Take · Dotted Dub + Beat Slice',
    };
  if (
    voiceFxEnabled &&
    (enabledVoiceIds.length > 0 || enabledCustomDrops.some((c) => c.hasAudio && c.enabled)) &&
    !baseMoment.voiceDropId
  ) {
    const wildVoice = pickContextVoiceDrop({
      voiceFxEnabled,
      enabledVoiceIds,
      enabledCustomDrops,
      vibe: chosenVibe,
      aggressiveness,
      rng,
    });
    if (wildVoice) {
      baseMoment.voiceDropId = wildVoice.id;
      baseMoment.label = `${baseMoment.label} + "${wildVoice.label}"`;
    }
  }
  return baseMoment;
}

/**
 * Automatic "Club VIP Edit" Arrangement Skipper for long tracks (> 3m05s).
 * Spots repetitive mid-track verse/breakdown stretches and plans an exact
 * 8/16/24-bar phrase-locked Beat-Jump skip straight into the upcoming build/drop.
 */
function computeClubVipSkipEdit(params: {
  track: TrackItem | null;
  waveform?: WaveformBandSample[];
  bpm: number;
  quickMix: boolean;
  remixMode: boolean;
}): AiTransitionPlan['vipSkipEdit'] {
  const { track, waveform, bpm, quickMix, remixMode } = params;
  if (!track || track.durationSec < 185) return undefined;
  const dur = track.durationSec;
  const barSec = (60 / Math.max(65, bpm)) * 4;
  const firstBeat = track.firstBeatSec || 0;

  let triggerSec = dur * 0.26;
  let targetSec = 0;

  const sections = track.sections || [];
  const earlyRepetitive = sections.find(
    (s) => (s.label === 'verse' || s.label === 'breakdown') && s.startSec >= dur * 0.2 && s.startSec <= dur * 0.42
  );
  const laterHighlight = sections.find(
    (s) =>
      (s.label === 'build' || s.label === 'drop') &&
      s.startSec >= (earlyRepetitive ? earlyRepetitive.startSec : dur * 0.24) + 20 &&
      s.startSec <= dur * (quickMix ? 0.56 : 0.72)
  );

  if (laterHighlight) {
    triggerSec = earlyRepetitive ? earlyRepetitive.startSec + barSec : dur * 0.24;
    targetSec = laterHighlight.startSec;
  } else if (waveform && waveform.length >= 48 && (remixMode || dur >= 215)) {
    // Fallback: locate a calm verse window (~22-34%) jumping ahead to highest energy peak (~48-68%)
    const scanStart = Math.floor(waveform.length * 0.46);
    const scanEnd = Math.floor(waveform.length * 0.68);
    let peakVal = -1;
    let peakIdx = scanStart;
    for (let i = scanStart; i < scanEnd; i++) {
      const e = waveform[i].low * 0.55 + waveform[i].mid * 0.35 + waveform[i].high * 0.1;
      if (e > peakVal) {
        peakVal = e;
        peakIdx = i;
      }
    }
    triggerSec = dur * 0.24;
    targetSec = Math.max(triggerSec + 22, (peakIdx / waveform.length) * dur - barSec * 2);
  }

  if (targetSec <= triggerSec + barSec * 6) return undefined;

  const rawBarsGap = (targetSec - triggerSec) / barSec;
  const barsSkipped = Math.max(8, Math.round(rawBarsGap / 8) * 8);
  const trigBars = Math.max(4, Math.round((triggerSec - firstBeat) / barSec));
  const alignedTriggerSec = firstBeat + trigBars * barSec;
  const alignedTargetSec = alignedTriggerSec + barsSkipped * barSec;

  if (alignedTargetSec >= dur - 24 || alignedTriggerSec / dur >= (quickMix ? 0.31 : 0.44)) {
    return undefined;
  }

  return {
    triggerPct: Math.round((alignedTriggerSec / dur) * 1000) / 1000,
    targetSec: Math.round(alignedTargetSec * 1000) / 1000,
    barsSkipped,
    label: `Club VIP Edit · -${barsSkipped} Bar Skip to Drop`,
  };
}

export function planOfflineTransition(params: {
  outgoingTrack: TrackItem | null;
  currentBpm: number;
  vibe: AiDjVibe;
  direction?: string;
  candidates: CandidateTrackInput[];
  playedTrackIds?: string[];
  remixMode?: boolean;
  energyMode?: AiEnergyMode;
  aggressiveness?: number; // 0..100
  randomness?: number;     // 0..100
  sessionSeed?: number;
  quickMix?: boolean;
  outWaveform?: WaveformBandSample[];
  inWaveform?: WaveformBandSample[];
  currentTimeSec?: number;
  setTensionScore?: number;
  peakMixStreak?: number;
  voiceFxEnabled?: boolean;
  enabledVoiceIds?: DjVoiceDropId[];
  enabledCustomDrops?: CustomVoiceDropMeta[];
}): AiTransitionPlan {
  const {
    outgoingTrack,
    currentBpm,
    vibe,
    direction = '',
    candidates,
    playedTrackIds = [],
    remixMode = false,
    energyMode = 'wave',
    aggressiveness = 55,
    randomness = 65,
    sessionSeed = Date.now(),
    quickMix = false,
    outWaveform,
    inWaveform,
    currentTimeSec = 0,
    setTensionScore = 45,
    peakMixStreak = 0,
    voiceFxEnabled = false,
    enabledVoiceIds = [],
    enabledCustomDrops = [],
  } = params;
  const playedSet = new Set(playedTrackIds);

  const trackMixSeed =
    (sessionSeed ^
      hashString(outgoingTrack?.id || 'opener') ^
      Math.imul(playedTrackIds.length + 1, 2654435761)) >>>
    0;
  const rng = createRng(trackMixSeed);

  // Run Beam Search Optimizer preferring unplayed candidates first so set paths have zero dead-ends
  const unplayedPool = candidates.filter((c) => !playedSet.has(c.id));
  const optimizerPool = unplayedPool.length > 0 ? unplayedPool : candidates;
  const beamOrdered = optimizePlaylistSetlist({
    tracks: optimizerPool,
    anchorTrack: outgoingTrack,
    currentBpm,
    direction,
    energyMode,
    randomness,
    sessionSeed: trackMixSeed,
    maxLength: Math.min(optimizerPool.length, 24),
  });

  const chosen = beamOrdered[0] || candidates[0];
  const refBpm = currentBpm || outgoingTrack?.bpm || chosen.bpm;

  // Wave-2 Advance #5: Semitone Snap Key-Shift Resolver for dissonant pairings
  const snap = outgoingTrack
    ? resolveSemitoneSnap(outgoingTrack.musicalKey, chosen.musicalKey, refBpm, chosen.bpm)
    : { semitones: 0, snappedKey: chosen.musicalKey, pitchMultiplier: 1, snapped: false };

  const effectiveChosenBpm = chosen.bpm * snap.pitchMultiplier;
  const bpmMatch = computeEffectiveBpmMatch(refBpm, effectiveChosenBpm);
  const bpmDiff = bpmMatch.effectiveDiff;
  const foldedChosenBpm = effectiveChosenBpm * bpmMatch.foldFactor;

  const compatResult = outgoingTrack
    ? camelotCompatibility(outgoingTrack.musicalKey, snap.snappedKey)
    : { score: 25, relation: 'set opener' };
  const keyRel = snap.snapped
    ? `${compatResult.relation} (${snap.semitones > 0 ? '+' : ''}${snap.semitones}st snap)`
    : compatResult.relation;
  const vocalCompat = computePairVocalCompatibility(outgoingTrack, chosen);

  const outGroove = outgoingTrack ? detectGrooveDna(outgoingTrack) : detectGrooveDna(chosen);
  const inGroove = detectGrooveDna(chosen);

  const built = buildTricksForPlan({
    vibe,
    direction,
    bpmDiff,
    aggressiveness,
    randomness,
    vocalCompat,
    outGroove,
    inGroove,
    rng,
  });

  // If pairing remains harmonically dissonant even after semitone probe, engage chord-arp bridge glue
  const resolvedBridge: GrooveBridgePattern =
    compatResult.score < 24 && built.recommendedBridge === 'top-hats'
      ? 'chord-arp'
      : built.recommendedBridge;

  // Wave-2 Advance #2: Overlap Window RGB Clash Matrix
  const clashProfile = analyzeOverlapClash(
    outWaveform,
    inWaveform,
    quickMix ? 0.34 : remixMode ? 0.48 : 0.62,
    built.incomingStartPct,
    0.12
  );

  // Wave-2 Advance #3: True Double-Drop Phrasing Alignment
  const doubleDropCueSec = computeDoubleDropCueSec({
    outgoingTrack,
    incomingTrack: chosen,
    currentTimeSec,
    outBpm: refBpm,
    transitionBars: built.transitionBars,
  });

  const genrePhysicsMode = resolveGenrePhysicsMode(vibe, outGroove, inGroove);

  const songMoments = buildSongEffectMoments({
    vibe,
    remixMode,
    aggressiveness,
    randomness,
    quickMix,
    beatDivScale: bpmMatch.beatDivScale,
    sections: outgoingTrack?.sections,
    durationSec: outgoingTrack?.durationSec,
    bpm: refBpm,
    dropSec: outgoingTrack?.dropCueSec ?? outgoingTrack?.detectedDropSec,
    voiceFxEnabled,
    enabledVoiceIds,
    enabledCustomDrops,
    rng,
  });

  const takeHex = (trackMixSeed & 0xfff).toString(16).toUpperCase().padStart(3, '0');
  const sessionSignature = `Take #${takeHex} · ${built.signatureTag}`;
  const mixStyle = remixMode ? `Live Remix · ${built.mixStyle}` : built.mixStyle;
  const transitionBars = remixMode ? Math.max(8, built.transitionBars) : built.transitionBars;
  const incomingStartPct = remixMode ? Math.max(0.1, built.incomingStartPct) : built.incomingStartPct;

  const upcomingQueue: AiSetlistItem[] = beamOrdered.slice(0, 4).map((t, idx) => ({
    trackId: t.id,
    title: t.title,
    bpm: t.bpm,
    musicalKey: t.musicalKey,
    energyRole: classifyEnergyRole(t.bpm, idx, energyMode),
    vocalTag: analyzeVocalProfile(t.title, t.artist).density,
    grooveDna: detectGrooveDna(t),
  }));

  const tempoTargetBpm = Math.round(((refBpm * 0.35 + foldedChosenBpm * 0.65) || chosen.bpm) * 10) / 10;
  const bpmPctDelta = Math.round(((tempoTargetBpm - refBpm) / Math.max(60, refBpm)) * 100);
  const bpmDeltaLabel =
    bpmMatch.foldFactor !== 1
      ? `${bpmMatch.foldFactor}x Fold (${chosen.bpm.toFixed(0)}→${foldedChosenBpm.toFixed(0)})`
      : bpmPctDelta === 0
      ? '0% BPM Lock'
      : `${bpmPctDelta > 0 ? '+' : ''}${bpmPctDelta}% BPM`;
  const keyTransitionLabel = outgoingTrack
    ? `${outgoingTrack.musicalKey}→${snap.snapped ? `${snap.snappedKey} (${snap.semitones > 0 ? '+' : ''}${snap.semitones}st)` : chosen.musicalKey}`
    : `${chosen.musicalKey}`;

  // Macro "Set Tension & Breather Arc" Director
  const isBreatherMix =
    !direction.trim() &&
    vibe !== 'techno-hypnotic' &&
    ((peakMixStreak >= 2 && setTensionScore >= 72) ||
      (energyMode === 'wave' && peakMixStreak >= 3));

  const breatherFilteredTricks = isBreatherMix
    ? built.tricks.map((t) => {
        if (
          t.action === 'sound-air-horn' ||
          t.action === 'sound-drop-alarm' ||
          t.action === 'sound-laser' ||
          t.action === 'sound-snare-roll' ||
          t.action === 'staircase-drop-build' ||
          t.action === 'transformer-cut' ||
          t.action === 'xfade-chop-16th'
        ) {
          return {
            ...t,
            action: (t.targetDeck === 'incoming' ? 'shimmer-lift' : 'reverb-wash') as AiTrickActionType,
            intensity: Math.min(0.65, t.intensity),
            label: 'Breather Arc · Atmospheric Shimmer Wash',
          };
        }
        return t;
      })
    : built.tricks;

  const finalBridge: GrooveBridgePattern = isBreatherMix
    ? vibe === 'chill-sunset'
      ? 'chord-arp'
      : 'top-hats'
    : resolvedBridge;

  const finalTransitionBars = isBreatherMix
    ? Math.max(12, transitionBars)
    : transitionBars;

  const useBeatSliceStutter =
    !isBreatherMix &&
    genrePhysicsMode !== 'chill-velvet' &&
    (remixMode || aggressiveness >= 68) &&
    rng() < 0.35 + (aggressiveness / 100) * 0.3;

  // Upgrade #3: Acapella/Vocal Stem Carryover over next groove (8-12 bars) when ideal mashup or Live Mashup vibe
  const vocalCarryoverBars =
    outgoingTrack &&
    (vocalCompat.clashRisk === 'ideal-mashup' || (vibe === 'mashup-live' && vocalCompat.clashRisk !== 'high'))
      ? vibe === 'mashup-live'
        ? 12
        : 8
      : 0;

  // Upgrade #4: Dynamic 2-bar Call-and-Response Mid-Carve when mid-band clash or dual vocals are high
  const dynamicMidCallResponse =
    !isBreatherMix && (clashProfile.midClash >= 0.45 || vocalCompat.clashRisk === 'high');

  const vipSkipEdit = isBreatherMix
    ? undefined
    : computeClubVipSkipEdit({
        track: outgoingTrack,
        waveform: outWaveform,
        bpm: refBpm,
        quickMix,
        remixMode,
      });

  // Curate 1-2 AI transition voice cues (countdown/hype into drop + optional groove/tag opener)
  const voiceDrops: AiTransitionVoiceCue[] = [];
  const hasAnyVoices =
    enabledVoiceIds.length > 0 || enabledCustomDrops.some((c) => c.hasAudio && c.enabled);
  if (voiceFxEnabled && hasAnyVoices) {
    const gentleOnly = isBreatherMix || vibe === 'chill-sunset';
    if (!gentleOnly && (remixMode || aggressiveness >= 45 || rng() < 0.65)) {
      const openerVoice = pickContextVoiceDrop({
        voiceFxEnabled,
        enabledVoiceIds,
        enabledCustomDrops,
        vibe,
        aggressiveness,
        preferCategories:
          vibe === 'scratch-chop' ? ['scratch-vox', 'groove'] : ['groove', 'shout', 'scratch-vox'],
        rng,
      });
      if (openerVoice) {
        voiceDrops.push({
          atProgress: 0.14,
          voiceId: openerVoice.id,
          label: `AI Vox · ${
            openerVoice.isCustom
              ? openerVoice.label
              : VOICE_PRESET_MAP[openerVoice.id as DjVoiceDropId]?.calloutText || openerVoice.label
          }`,
        });
      }
    }
    const dropVoice = pickContextVoiceDrop({
      voiceFxEnabled,
      enabledVoiceIds,
      enabledCustomDrops,
      vibe,
      aggressiveness,
      isGentle: gentleOnly,
      preferCategories: gentleOnly
        ? ['groove']
        : vibe === 'scratch-chop'
        ? ['scratch-vox', 'hype']
        : ['countdown', 'hype', 'shout'],
      rng,
    });
    if (dropVoice) {
      voiceDrops.push({
        atProgress: gentleOnly ? 0.38 : 0.42,
        voiceId: dropVoice.id,
        label: `AI Vox · ${
          dropVoice.isCustom
            ? dropVoice.label
            : VOICE_PRESET_MAP[dropVoice.id as DjVoiceDropId]?.calloutText || dropVoice.label
        }`,
      });
    }
  }

  // Upgrade #5: "Tease the Next Song" Breakdown Mashup Preview
  let teasePreview: AiTransitionPlan['teasePreview'];
  if (outgoingTrack && !isBreatherMix && !quickMix && outgoingTrack.durationSec >= 55) {
    const outDur = outgoingTrack.durationSec;
    const breakdownSeg = outgoingTrack.sections?.find(
      (s) =>
        s.label === 'breakdown' &&
        s.startSec / outDur >= 0.18 &&
        s.startSec / outDur <= 0.46
    );
    const candidatePct = breakdownSeg
      ? breakdownSeg.startSec / outDur
      : remixMode
      ? 0.28 + rng() * 0.08
      : -1;
    const curPct = currentTimeSec / Math.max(10, outDur);
    if (
      candidatePct >= Math.max(0.16, curPct + 0.04) &&
      candidatePct <= 0.48 &&
      !songMoments.some((m) => Math.abs(m.atPct - candidatePct) < 0.055)
    ) {
      const inFirst = chosen.firstBeatSec || 0;
      const inBeatSec = 60 / Math.max(65, chosen.bpm || 124);
      const rawInCue =
        chosen.dropCueSec ??
        chosen.detectedDropSec ??
        Math.min(chosen.durationSec * 0.32, 36);
      const qBeats = Math.max(0, Math.round((rawInCue - inFirst) / inBeatSec));
      const teaseCueSec = Math.max(
        0,
        Math.min(Math.max(8, chosen.durationSec - 12), inFirst + qBeats * inBeatSec)
      );
      teasePreview = {
        triggerPct: Math.round(candidatePct * 1000) / 1000,
        durationBars: 4,
        cueSec: Math.round(teaseCueSec * 100) / 100,
        label: `Breakdown Tease · "${chosen.title.split('(')[0].trim()}" Vocal`,
      };
    }
  }

  return {
    nextTrackId: chosen.id,
    mixStyle: isBreatherMix ? `Breather Reset · ${mixStyle}` : mixStyle,
    mixStyleKey: built.mixStyleKey,
    sessionSignature,
    transitionBars: finalTransitionBars,
    incomingStartPct,
    tempoTargetBpm: Math.max(70, Math.min(185, tempoTargetBpm)),
    tempoFoldFactor: bpmMatch.foldFactor,
    grooveRecipeLabel: isBreatherMix ? 'Breather Arc · Tension Reset' : built.grooveRecipeLabel,
    outGroove,
    inGroove,
    genrePhysicsMode: isBreatherMix ? 'chill-velvet' : genrePhysicsMode,
    recommendedBridge: finalBridge,
    bpmDeltaLabel,
    keyTransitionLabel,
    semitoneShiftIn: snap.semitones,
    doubleDropCueSec,
    clashProfile,
    useBeatSliceStutter,
    vocalCarryoverBars,
    dynamicMidCallResponse,
    setTensionScore: Math.round(setTensionScore),
    isBreatherMix,
    vipSkipEdit,
    teasePreview,
    aiNotes: `${sessionSignature} · ${
      isBreatherMix ? 'Breather Arc Reset' : built.grooveRecipeLabel
    } · ${keyRel} · ${clashProfile.summary}${
      typeof doubleDropCueSec === 'number' ? ' · Double-Drop Aligned' : ''
    }${vocalCarryoverBars > 0 ? ` · +${vocalCarryoverBars}b Vocal Carry` : ''}${
      vipSkipEdit ? ` · -${vipSkipEdit.barsSkipped}b VIP Skip` : ''
    }${teasePreview ? ' · Breakdown Tease' : ''}${
      voiceDrops.length > 0 ? ` · ${voiceDrops.length} Vox` : ''
    }`,
    tricks: breatherFilteredTricks,
    voiceDrops,
    songMoments: isBreatherMix ? songMoments.slice(0, 1) : songMoments,
    upcomingQueue,
    chopPattern: isBreatherMix ? 'off' : built.chopPattern,
    cueJuggleSeq: built.cueJuggleSeq,
    vocalPairingNote: vocalCompat.note,
  };
}

export function sortTracksHarmonically(
  tracks: TrackItem[],
  energyMode: AiEnergyMode = 'wave'
): TrackItem[] {
  if (tracks.length <= 1) return tracks;
  return optimizePlaylistSetlist({
    tracks,
    energyMode,
    randomness: 18,
    sessionSeed: 1337,
  });
}

export function computeOfflineMashupBlend(params: {
  deckA: { title: string; artist: string; bpm: number; musicalKey: string };
  deckB: { title: string; artist: string; bpm: number; musicalKey: string };
  direction?: string;
  aggressiveness?: number;
  sessionSeed?: number;
}): AiMashupBlendAdvice {
  const { deckA, deckB, direction = '', aggressiveness = 55, sessionSeed = Date.now() } = params;
  const dir = direction.toLowerCase();
  const rng = createRng(
    (sessionSeed ^ hashString(`${deckA.title}:${deckB.title}`)) >>> 0
  );

  const vocalA = analyzeVocalProfile(deckA.title, deckA.artist);
  const vocalB = analyzeVocalProfile(deckB.title, deckB.artist);
  const vocalPair = computePairVocalCompatibility(deckA, deckB);

  const preferDeckBBass = /deck\s*b\s*bass|b\s*low|keep\s*b/.test(dir);
  const preferDeckABass = /deck\s*a\s*bass|a\s*low|keep\s*a/.test(dir);
  const useEcho = /echo|dub/.test(dir);
  const useFlanger = /flang/.test(dir);
  const usePhaser = /phaser|swirl/.test(dir);
  const useTremolo = /gate|tremolo/.test(dir);
  const useCrush = /crush|bit|lofi/.test(dir);
  const useChorus = /chorus|wide/.test(dir);
  const useRing = /ring|morph/.test(dir);
  const useAutopan = /pan|stereo/.test(dir);
  const useComb = /comb|resonat/.test(dir);
  const useStutter = /stutter|repeat/.test(dir);

  let aHoldsBass = preferDeckABass || (!preferDeckBBass && deckA.bpm >= deckB.bpm);
  if (!preferDeckABass && !preferDeckBBass) {
    if (vocalA.density === 'instrumental' && vocalB.density !== 'instrumental') {
      aHoldsBass = true;
    } else if (vocalB.density === 'instrumental' && vocalA.density !== 'instrumental') {
      aHoldsBass = false;
    }
  }

  const autoPool: FxType[] =
    aggressiveness >= 70
      ? ['stutter', 'comb', 'ringmod', 'dubdelay', 'bitcrush', 'phaser']
      : aggressiveness <= 30
      ? ['shimmer', 'chorus', 'autopan', 'lofi', 'reverb', 'echo']
      : ['dubdelay', 'shimmer', 'phaser', 'autopan', 'tremolo', 'lofi'];

  const stemDeckFxType: FxType = useStutter
    ? 'stutter'
    : useRing
    ? 'ringmod'
    : useComb
    ? 'comb'
    : useAutopan
    ? 'autopan'
    : usePhaser
    ? 'phaser'
    : useTremolo
    ? 'tremolo'
    : useCrush
    ? 'bitcrush'
    : useChorus
    ? 'chorus'
    : useFlanger
    ? 'flanger'
    : useEcho
    ? 'echo'
    : pickOne(autoPool, rng);

  const keyRel = camelotCompatibility(deckA.musicalKey, deckB.musicalKey).relation;
  const fxWet = Math.round((0.24 + (aggressiveness / 100) * 0.22) * 100) / 100;

  const bassDeckMid = vocalPair.clashRisk === 'high' ? -0.58 : -0.18;
  const stemDeckMid = vocalPair.clashRisk === 'ideal-mashup' ? 0.34 : 0.22;

  const stemA: StemIsolationMode = aHoldsBass ? 'instrumental' : 'vocal-focus';
  const stemB: StemIsolationMode = aHoldsBass ? 'vocal-focus' : 'instrumental';
  const swapStemA: StemIsolationMode = aHoldsBass ? 'vocal-focus' : 'drums-only';
  const swapStemB: StemIsolationMode = aHoldsBass ? 'drums-only' : 'vocal-focus';

  // Upgrade #1: Continuous 32-Bar Live Bootleg Mashup Choreography Phases (powered by 3-Stem HPSS)
  const phases: AiMashupPhase[] = [
    {
      barStart: 0,
      barEnd: 8,
      focusDeck: aHoldsBass ? 'B' : 'A',
      crossfader: aHoldsBass ? 0.08 : -0.08,
      deckAEqLow: aHoldsBass ? 0.08 : -0.82,
      deckAEqMid: aHoldsBass ? bassDeckMid : stemDeckMid,
      deckAEqHigh: aHoldsBass ? -0.08 : 0.18,
      deckBEqLow: aHoldsBass ? -0.82 : 0.08,
      deckBEqMid: aHoldsBass ? stemDeckMid : bassDeckMid,
      deckBEqHigh: aHoldsBass ? 0.18 : -0.08,
      deckAStemMode: stemA,
      deckBStemMode: stemB,
      deckAFilter: 0,
      deckBFilter: 0,
      label: `32-Bar Bootleg (1-8) · ${aHoldsBass ? 'A Beat × B Vocals' : 'B Beat × A Vocals'}`,
    },
    {
      barStart: 8,
      barEnd: 16,
      focusDeck: aHoldsBass ? 'A' : 'B',
      crossfader: aHoldsBass ? -0.1 : 0.1,
      deckAEqLow: aHoldsBass ? -0.78 : 0.12,
      deckAEqMid: aHoldsBass ? 0.28 : -0.42,
      deckAEqHigh: 0.14,
      deckBEqLow: aHoldsBass ? 0.12 : -0.78,
      deckBEqMid: aHoldsBass ? -0.42 : 0.28,
      deckBEqHigh: 0.14,
      deckAStemMode: swapStemA,
      deckBStemMode: swapStemB,
      deckAFilter: 0,
      deckBFilter: 0,
      label: `32-Bar Bootleg (9-16) · Stem Swap ${aHoldsBass ? 'A Vocals × B Drums' : 'B Vocals × A Drums'}`,
    },
    {
      barStart: 16,
      barEnd: 20,
      focusDeck: 'alternate',
      crossfader: 0,
      deckAEqLow: -0.22,
      deckAEqMid: 0.14,
      deckAEqHigh: 0.16,
      deckBEqLow: -0.22,
      deckBEqMid: 0.14,
      deckBEqHigh: 0.16,
      deckAStemMode: 'off',
      deckBStemMode: 'off',
      deckAFilter: 0,
      deckBFilter: 0,
      pingPongBars: 1,
      label: '32-Bar Bootleg (17-20) · 1-Bar A↔B Ping-Pong Trade',
    },
    {
      barStart: 20,
      barEnd: 24,
      focusDeck: 'both',
      crossfader: 0,
      deckAEqLow: -0.88,
      deckAEqMid: 0.18,
      deckAEqHigh: 0.22,
      deckBEqLow: -0.88,
      deckBEqMid: 0.18,
      deckBEqHigh: 0.22,
      deckAStemMode: 'off',
      deckBStemMode: 'off',
      deckAFilter: 0.48,
      deckBFilter: 0.42,
      label: '32-Bar Bootleg (21-24) · Pre-Drop HPF Tension Build',
    },
    {
      barStart: 24,
      barEnd: 32,
      focusDeck: 'both',
      crossfader: 0,
      deckAEqLow: aHoldsBass ? 0.14 : -0.88,
      deckAEqMid: aHoldsBass ? bassDeckMid : stemDeckMid,
      deckAEqHigh: 0.14,
      deckBEqLow: aHoldsBass ? -0.88 : 0.14,
      deckBEqMid: aHoldsBass ? stemDeckMid : bassDeckMid,
      deckBEqHigh: 0.14,
      deckAStemMode: 'off',
      deckBStemMode: 'off',
      deckAFilter: 0,
      deckBFilter: 0,
      isDoubleDrop: true,
      label: '32-Bar Bootleg (25-32) · Double-Drop Slam + Bass Lock',
    },
  ];

  return {
    syncDeck: aHoldsBass ? 'B' : 'A',
    crossfader: 0,
    mashupTotalBars: 32,
    deckA: {
      eqLow: aHoldsBass ? 0.08 : -0.82,
      eqMid: aHoldsBass ? bassDeckMid : stemDeckMid,
      eqHigh: aHoldsBass ? -0.1 : 0.16,
      filter: aHoldsBass ? 0 : 0.18,
      fxEnabled: !aHoldsBass,
      fxType: aHoldsBass ? 'subharm' : stemDeckFxType,
      fxWet: aHoldsBass ? 0 : fxWet,
      stemMode: stemA,
    },
    deckB: {
      eqLow: aHoldsBass ? -0.82 : 0.08,
      eqMid: aHoldsBass ? stemDeckMid : bassDeckMid,
      eqHigh: aHoldsBass ? 0.16 : -0.1,
      filter: aHoldsBass ? 0.18 : 0,
      fxEnabled: aHoldsBass,
      fxType: aHoldsBass ? stemDeckFxType : 'subharm',
      fxWet: aHoldsBass ? fxWet : 0,
      stemMode: stemB,
    },
    harmonicSummary: `32-Bar Live Bootleg · Deck ${aHoldsBass ? 'A' : 'B'} Inst + Deck ${
      aHoldsBass ? 'B' : 'A'
    } Vocal (${FX_FRIENDLY_NAME[stemDeckFxType]}) · ${vocalPair.note} · ${keyRel}`,
    phases,
  };
}
