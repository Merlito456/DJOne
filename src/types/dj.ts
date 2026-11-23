export type DeckId = 'A' | 'B';

export type TrackSourceType = 'local' | 'youtube-stream' | 'youtube-iframe';

export type FxType =
  | 'echo'
  | 'reverb'
  | 'flanger'
  | 'drive'
  | 'phaser'
  | 'bitcrush'
  | 'tremolo'
  | 'chorus'
  | 'ringmod'
  | 'autopan'
  | 'comb'
  | 'stutter'
  | 'subharm'
  | 'shimmer'
  | 'lofi'
  | 'dubdelay';

export type CrossfaderCurve = 'blend' | 'power' | 'cut';

export interface WaveformBandSample {
  low: number;  // 0..1
  mid: number;  // 0..1
  high: number; // 0..1
  peak: number; // 0..1
}

export interface HotCue {
  index: number;
  timeSec: number | null;
  label: string;
  color: string;
}

export type TrackSectionLabel =
  | 'intro'
  | 'verse'
  | 'build'
  | 'drop'
  | 'breakdown'
  | 'outro';

export interface TrackSectionSegment {
  label: TrackSectionLabel;
  startSec: number;
  endSec: number;
  energy: number;
}

export type GrooveDnaGenre =
  | 'house-edm'
  | 'trap-halftime'
  | 'afro-reggaeton'
  | 'lofi-slowed'
  | 'dnb-break'
  | 'pop-vocal'
  | 'rock-live';

export type StemIsolationMode = 'off' | 'vocal-focus' | 'instrumental' | 'drums-only';

export interface TempoSegmentPoint {
  startSec: number;
  bpm: number;
  downbeatSec: number;
}

export type GrooveBridgePattern =
  | 'off'
  | 'top-hats'
  | 'house-4x4'
  | 'sub-808'
  | 'afro-perc'
  | 'chord-arp';

export type VocalDensityTag = 'instrumental' | 'balanced' | 'vocal-dense' | 'acapella';

export interface VocalProfile {
  density: VocalDensityTag;
  flavorTags: string[];
}

export interface TrackCalibration {
  trackKey: string; // youtubeId or track.id
  bpm?: number;
  musicalKey?: string;
  firstBeatSec?: number;
  dropCueSec?: number;
  autoTrimGain?: number;
  updatedAt: number;
}

export interface AiTasteProfile {
  styleScores: Record<string, number>;
  fxScores: Record<string, number>;
  pairScores: Record<string, number>;
  preferredAggressivenessDelta: number;
  completedCount: number;
  skippedCount: number;
  updatedAt: number;
}

export interface TrackItem {
  id: string;
  title: string;
  artist: string;
  bpm: number;
  musicalKey: string;
  durationSec: number;
  sourceType: TrackSourceType;
  youtubeId?: string;
  thumbnail?: string;
  fileUrl?: string;
  firstBeatSec: number;
  dropCueSec?: number;
  detectedDropSec?: number;
  sections?: TrackSectionSegment[];
  tempoMap?: TempoSegmentPoint[];
  autoTrimGain?: number;
  calibrated?: boolean;
  addedAt: number;
}

export interface Playlist {
  id: string;
  name: string;
  trackIds: string[];
  isSystem?: boolean;
  preferredVibe?: AiDjVibe;
  remixMode?: boolean;
  aggressiveness?: number; // 0..100
}

export interface CarloPlaylistFile {
  format: 'deckforge.carlo';
  version: 1;
  exportedAt: string;
  playlist: {
    name: string;
    preferredVibe?: AiDjVibe;
    remixMode?: boolean;
    aggressiveness?: number;
    trackIds: string[];
  };
  tracks: TrackItem[];
}

export interface DeckFxState {
  enabled: boolean;
  type: FxType;
  wet: number;       // 0..1
  beatDiv: number;   // 0.25, 0.5, 0.75, 1, 2
}

export interface DeckState {
  deckId: DeckId;
  track: TrackItem | null;
  isLoading: boolean;
  loadError: string | null;
  playbackMode: 'webaudio' | 'youtube-iframe' | 'none';
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  baseBpm: number;
  playbackRate: number; // e.g. 1.0 = 0% pitch
  pitchRange: 0.08 | 0.16 | 0.5;
  keyLock: boolean;
  semitoneShift?: number;
  isMaster: boolean;
  syncLocked: boolean;
  cuePointSec: number;
  hotCues: HotCue[];
  loopActive: boolean;
  loopStartSec: number;
  loopEndSec: number;
  loopBars: number | null;
  gainTrim: number;     // 0..1.5 (1.0 = 0dB)
  eqLow: number;        // -1..1 (0 = 0dB)
  eqMid: number;        // -1..1
  eqHigh: number;       // -1..1
  killLow: boolean;
  killMid: boolean;
  killHigh: boolean;
  filter: number;       // -1 (LPF) .. 0 (OFF) .. +1 (HPF)
  channelVolume: number;// 0..1
  pflCue: boolean;
  fx: DeckFxState;
  stemMode: StemIsolationMode;
  waveform: WaveformBandSample[];
  sections?: TrackSectionSegment[];
  detectedDropSec?: number;
}

export interface MixerState {
  crossfader: number; // -1 (Deck A) .. 0 (Center) .. +1 (Deck B)
  crossfaderCurve: CrossfaderCurve;
  crossfaderReverse: boolean;
  masterGain: number; // 0..1.2
  headphoneMix: number; // 0..1
}

export interface YouTubeSearchResult {
  videoId: string;
  title: string;
  author: string;
  durationSec: number;
  durationText: string;
  thumbnail: string;
  bpmHint: number | null;
}

export interface RecordingItem {
  id: string;
  title: string;
  createdAt: number;
  durationSec: number;
  format: 'wav' | 'webm';
  url: string;
  sizeBytes: number;
}

export type AiDjVibe =
  | 'club-blend'
  | 'festival-drop'
  | 'techno-hypnotic'
  | 'scratch-chop'
  | 'mashup-live'
  | 'chill-sunset';

export type AiEnergyMode = 'wave' | 'build' | 'chill';

export type AiChopPatternType =
  | 'off'
  | 'quarter-chop'
  | 'eighth-gate'
  | 'ping-pong-2beat'
  | 'transformer-scratch';

export type SoundTrickType =
  | 'riser'
  | 'sub-drop'
  | 'dub-siren'
  | 'backspin'
  | 'laser'
  | 'air-horn'
  | 'vinyl-stop'
  | 'snare-roll'
  | 'tape-rewind'
  | 'sweep-down'
  | 'chord-stab'
  | 'scratch-chirp'
  | 'drop-alarm'
  | 'tom-fill'
  | 'vinyl-crack'
  | 'riser-chord';

export type DjVoiceCategory = 'shout' | 'hype' | 'groove' | 'countdown' | 'scratch-vox';

export type DjVoiceDropId =
  | 'hey-chant'
  | 'lets-go'
  | 'hands-up'
  | 'put-em-up'
  | 'make-some-noise'
  | 'crowd-roar'
  | 'everybody-jump'
  | 'pump-it'
  | 'turn-it-up'
  | 'oh-my-god'
  | 'groove-yeah'
  | 'ah-yeah-chop'
  | 'funk-woo'
  | 'afro-eyy'
  | 'vocoder-harmony'
  | 'sunset-breathe'
  | 'count-1234'
  | 'three-two-one'
  | 'bass-drop'
  | 'pull-up'
  | 'dj-scratch-aaah'
  | 'yo-yo-yo'
  | 'check-mic'
  | 'vip-remix';

export type CustomVoiceSlotId = 'custom-1' | 'custom-2' | 'custom-3' | 'custom-4';

export type AnyVoiceDropId = DjVoiceDropId | CustomVoiceSlotId;

export interface CustomVoiceDropMeta {
  id: CustomVoiceSlotId;
  label: string;
  durationSec: number;
  hasAudio: boolean;
  enabled: boolean;
}

export interface WaveformAiMarker {
  id: string;
  deckId: DeckId;
  kind: 'moment' | 'fakeout' | 'vip-skip' | 'tease' | 'mix-out';
  timeSec: number;
  label: string;
  muted?: boolean;
  momentIndex?: number;
}

export interface DjVoicePresetMeta {
  id: DjVoiceDropId;
  label: string;
  calloutText: string;
  category: DjVoiceCategory;
  energyMin: number; // 0..100
  chillSafe: boolean;
  description: string;
}

export type AiTrickActionType =
  | 'eq-bass-swap'
  | 'stem-mid-swap'
  | 'double-drop-sync'
  | 'kill-drop-slam'
  | 'lpf-underwater-blend'
  | 'hot-cue-juggle'
  | 'cue-wordplay-juggle'
  | 'xfade-chop-16th'
  | 'xfade-ping-pong'
  | 'transformer-cut'
  | 'staircase-drop-build'
  | 'filter-sweep'
  | 'echo-out'
  | 'reverb-wash'
  | 'flanger-riser'
  | 'phaser-swirl'
  | 'bitcrush-breakdown'
  | 'tremolo-gate'
  | 'chorus-shimmer'
  | 'ringmod-morph'
  | 'autopan-drift'
  | 'comb-resonator'
  | 'stutter-drop'
  | 'subharm-boost'
  | 'shimmer-lift'
  | 'lofi-tape-warp'
  | 'dubdelay-throw'
  | 'echo-freeze-cut'
  | 'phrase-drop-swap'
  | 'beat-loop-roll'
  | 'chop-cut'
  | 'vinyl-brake'
  | 'sound-riser'
  | 'sound-sub-drop'
  | 'sound-siren'
  | 'sound-backspin'
  | 'sound-laser'
  | 'sound-air-horn'
  | 'sound-vinyl-stop'
  | 'sound-snare-roll'
  | 'sound-tape-rewind'
  | 'sound-sweep-down'
  | 'sound-chord-stab'
  | 'sound-scratch-chirp'
  | 'sound-drop-alarm'
  | 'sound-tom-fill'
  | 'sound-vinyl-crack'
  | 'sound-riser-chord';

export interface AiTrickStep {
  atProgress: number; // 0.0 .. 1.0 of transition
  durationProgress: number; // 0.05 .. 0.5
  action: AiTrickActionType;
  targetDeck: 'outgoing' | 'incoming';
  intensity: number; // 0.2 .. 1.0
  label: string;
}

export interface AiSetlistItem {
  trackId: string;
  title: string;
  bpm: number;
  musicalKey: string;
  energyRole: string; // e.g. "Lift", "Peak", "Groove"
  vocalTag?: VocalDensityTag;
  grooveDna?: GrooveDnaGenre;
}

export interface AiSongEffectMoment {
  atPct: number;       // 0.08 .. 0.56 during cruising
  durationMs: number;  // 900 .. 4500
  fxType: FxType;
  fxWet: number;
  beatDiv: number;
  filter: number;
  eqLow?: number;
  eqMid?: number;
  eqHigh?: number;
  loopBars?: number;
  chopPattern?: AiChopPatternType;
  cueJuggleSeq?: number[];
  soundTrick?: SoundTrickType;
  voiceDropId?: AnyVoiceDropId;
  pitchBurst?: number;
  beatSlicePattern?: number[];
  isVipDropFakeout?: boolean;
  useSampleAccurateBuild?: boolean;
  youtubePumpMode?: 'sidechain' | 'gate-8th' | 'drop-takeover';
  deckCHookPattern?: 'quarter' | 'half' | 'full-echo';
  label: string;
}

export interface OverlapClashProfile {
  bassClash: number; // 0..1
  midClash: number;  // 0..1
  recommendedOutLowCut: number;
  recommendedOutMidCut: number;
  recommendedInMidCut: number;
  summary: string;
}

export type GenrePhysicsMode = 'trap-to-house' | 'chill-velvet' | 'dnb-chop' | 'standard';

export interface AiTransitionVoiceCue {
  atProgress: number;
  voiceId: AnyVoiceDropId;
  label: string;
}

export interface AiTransitionPlan {
  nextTrackId: string;
  mixStyle: string;
  mixStyleKey: string;
  sessionSignature: string;
  transitionBars: number;
  incomingStartPct: number; // 0.0 .. 0.28 beat-quantized cue-in offset
  tempoTargetBpm: number;   // smooth master BPM ramp target
  tempoFoldFactor?: 1 | 2 | 0.5;
  grooveRecipeLabel?: string;
  outGroove?: GrooveDnaGenre;
  inGroove?: GrooveDnaGenre;
  genrePhysicsMode?: GenrePhysicsMode;
  recommendedBridge?: GrooveBridgePattern;
  bpmDeltaLabel?: string;
  keyTransitionLabel?: string;
  semitoneShiftIn?: number;
  doubleDropCueSec?: number;
  clashProfile?: OverlapClashProfile;
  useBeatSliceStutter?: boolean;
  vocalCarryoverBars?: number;
  dynamicMidCallResponse?: boolean;
  recommendedOutStartPct?: number;
  pocketSummary?: string;
  setTensionScore?: number;
  isBreatherMix?: boolean;
  vipSkipEdit?: {
    triggerPct: number;
    targetSec: number;
    barsSkipped: number;
    label: string;
  };
  teasePreview?: {
    triggerPct: number;
    durationBars: number;
    cueSec: number;
    label: string;
  };
  aiNotes: string;
  tricks: AiTrickStep[];
  voiceDrops?: AiTransitionVoiceCue[];
  songMoments: AiSongEffectMoment[];
  upcomingQueue?: AiSetlistItem[];
  chopPattern?: AiChopPatternType;
  cueJuggleSeq?: number[];
  vocalPairingNote?: string;
}

export interface AiMashupPhase {
  barStart: number;
  barEnd: number;
  focusDeck: 'A' | 'B' | 'alternate' | 'both';
  crossfader: number;
  deckAEqLow: number;
  deckAEqMid: number;
  deckAEqHigh: number;
  deckBEqLow: number;
  deckBEqMid: number;
  deckBEqHigh: number;
  deckAStemMode?: StemIsolationMode;
  deckBStemMode?: StemIsolationMode;
  deckAFilter?: number;
  deckBFilter?: number;
  pingPongBars?: number;
  isDoubleDrop?: boolean;
  label: string;
}

export interface AiMashupBlendAdvice {
  syncDeck: 'A' | 'B';
  crossfader: number;
  mashupTotalBars?: number;
  deckA: {
    eqLow: number;
    eqMid: number;
    eqHigh: number;
    filter: number;
    fxEnabled: boolean;
    fxType: FxType;
    fxWet: number;
    stemMode?: StemIsolationMode;
  };
  deckB: {
    eqLow: number;
    eqMid: number;
    eqHigh: number;
    filter: number;
    fxEnabled: boolean;
    fxType: FxType;
    fxWet: number;
    stemMode?: StemIsolationMode;
  };
  harmonicSummary: string;
  phases?: AiMashupPhase[];
}

export interface AutopilotState {
  enabled: boolean;
  remixMode: boolean;
  quickMix: boolean;
  energyMode: AiEnergyMode;
  aggressiveness: number; // 0..100
  randomness: number;     // 0..100 offline variety & take entropy
  sessionSeed: number;
  targetPlaylistId: string;
  vibe: AiDjVibe;
  phase: 'idle' | 'planning' | 'cruising' | 'transitioning' | 'error';
  activePlan: AiTransitionPlan | null;
  upcomingQueue: AiSetlistItem[];
  lastDirection: string;
  transitionProgress: number; // 0..1
  currentActionLabel: string;
  errorMessage: string | null;
  muteSoundTricks: boolean;
  voiceFxEnabled: boolean;
  enabledVoiceIds: DjVoiceDropId[];
  mutedMomentIndices?: number[];
  grooveBridgePattern: GrooveBridgePattern;
  nextTransitionEtaSec: number | null;
  holdExtraBars: number;
  mashupRoutineActive: boolean;
}

