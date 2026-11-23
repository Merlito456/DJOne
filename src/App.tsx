import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Disc3, Sliders, Sparkles, Library, Circle, Square, ListMusic, FolderPlus } from 'lucide-react';
import { djEngine } from './audio/djEngine';
import { ALL_CAMELOT_KEYS, recordAiFeedbackEvent } from './audio/aiMemory';
import { runHpssSeparation } from './audio/hpssWorker';
import {
  computeAutoHotCues,
  computeOfflineMashupBlend,
  generateOfflineWildTake,
  planOfflineTransition,
} from './audio/offlineAiDj';
import {
  buildElasticTempoMap,
  computeWaveformLoudnessGain,
  detectBpmAndGrid,
  detectCamelotKey,
  estimateTrackLoudnessGain,
  extractRgbWaveform,
  findSparsestMashupPocket,
  generateDeterministicBeatWaveform,
  resolveElasticPhraseAtTime,
  segmentTrackStructure,
} from './audio/waveformAnalyzer';
import { renderOfflineAiRemixWav } from './audio/offlineMixRenderer';
import { YouTubeDeckPlayer } from './audio/youtubeBridge';
import { AiAutopilotPanel } from './components/AiAutopilotPanel';
import { DeckPanel } from './components/DeckPanel';
import { DualWaveformDisplay } from './components/DualWaveformDisplay';
import { LibraryPanel } from './components/LibraryPanel';
import { MixerConsole } from './components/MixerConsole';
import { PlaylistBuilderModal } from './components/PlaylistBuilderModal';
import { RecordingModal } from './components/RecordingModal';
import {
  downloadCarloPlaylistFile,
  parseCarloPlaylistText,
  useLibraryStore,
} from './store/useLibraryStore';
import {
  ALL_VOICE_IDS,
  deleteCustomVoiceBufferFromIdb,
  DJ_VOICE_LIBRARY,
  isCustomVoiceDropId,
  loadAllCustomVoiceBuffers,
  loadCustomVoiceMetas,
  loadVoicePackSettings,
  saveCustomVoiceBufferToIdb,
  saveCustomVoiceMetas,
  saveVoicePackSettings,
  startMicDropCapture,
  VOICE_PRESET_MAP,
} from './audio/djVoices';
import {
  AiChopPatternType,
  AiDjVibe,
  AiEnergyMode,
  AiMashupPhase,
  AiTransitionPlan,
  AnyVoiceDropId,
  AutopilotState,
  CustomVoiceDropMeta,
  CustomVoiceSlotId,
  DeckFxState,
  DeckId,
  DeckState,
  DjVoiceCategory,
  DjVoiceDropId,
  GrooveBridgePattern,
  MixerState,
  Playlist,
  SoundTrickType,
  StemIsolationMode,
  TrackItem,
  WaveformAiMarker,
} from './types/dj';

const HOT_CUE_COLORS = ['#22D3EE', '#10B981', '#F59E0B', '#EC4899'];

function createInitialDeckState(deckId: DeckId): DeckState {
  return {
    deckId,
    track: null,
    isLoading: false,
    loadError: null,
    playbackMode: 'none',
    isPlaying: false,
    currentTime: 0,
    duration: 0,
    baseBpm: 124,
    playbackRate: 1,
    pitchRange: 0.08,
    keyLock: true,
    isMaster: deckId === 'A',
    syncLocked: false,
    cuePointSec: 0,
    hotCues: [0, 1, 2, 3].map((index) => ({
      index,
      timeSec: null,
      label: `Cue ${index + 1}`,
      color: HOT_CUE_COLORS[index],
    })),
    loopActive: false,
    loopStartSec: 0,
    loopEndSec: 0,
    loopBars: null,
    gainTrim: 1,
    eqLow: 0,
    eqMid: 0,
    eqHigh: 0,
    killLow: false,
    killMid: false,
    killHigh: false,
    filter: 0,
    channelVolume: 0.88,
    pflCue: false,
    fx: {
      enabled: false,
      type: 'echo',
      wet: 0.35,
      beatDiv: 0.5,
    },
    stemMode: 'off',
    waveform: [],
  };
}

type MobileTab = 'decks' | 'mixer' | 'fx' | 'crate';

export default function App() {
  const library = useLibraryStore();

  const [deckA, setDeckA] = useState<DeckState>(() => createInitialDeckState('A'));
  const [deckB, setDeckB] = useState<DeckState>(() => createInitialDeckState('B'));
  const [mixer, setMixer] = useState<MixerState>({
    crossfader: 0,
    crossfaderCurve: 'power',
    crossfaderReverse: false,
    masterGain: 0.9,
    headphoneMix: 0.5,
  });

  const [mobileTab, setMobileTab] = useState<MobileTab>('decks');
  const [mobileActiveDeck, setMobileActiveDeck] = useState<DeckId>('A');

  const [isRecording, setIsRecording] = useState(false);
  const [recordingSec, setRecordingSec] = useState(0);
  const [recordingModalOpen, setRecordingModalOpen] = useState(false);

  const [isCrateOpen, setIsCrateOpen] = useState(false);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [editingPlaylist, setEditingPlaylist] = useState<Playlist | null>(null);

  const [autopilot, setAutopilot] = useState<AutopilotState>(() => {
    const savedVoices = loadVoicePackSettings();
    return {
      enabled: false,
      remixMode: false,
      quickMix: false,
      energyMode: 'wave',
      aggressiveness: 55,
      randomness: 65,
      sessionSeed: (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0,
      targetPlaylistId: 'all',
      vibe: 'club-blend',
      phase: 'idle',
      activePlan: null,
      upcomingQueue: [],
      lastDirection: '',
      transitionProgress: 0,
      currentActionLabel: '',
      errorMessage: null,
      muteSoundTricks: false,
      voiceFxEnabled: savedVoices.voiceFxEnabled,
      enabledVoiceIds: savedVoices.enabledVoiceIds,
      grooveBridgePattern: 'off',
      nextTransitionEtaSec: null,
      holdExtraBars: 0,
      mashupRoutineActive: false,
      mutedMomentIndices: [],
    };
  });
  const [mashupLoading, setMashupLoading] = useState(false);

  const [customVoiceDrops, setCustomVoiceDrops] = useState<CustomVoiceDropMeta[]>(() =>
    loadCustomVoiceMetas()
  );
  const customVoiceDropsRef = useRef(customVoiceDrops);
  customVoiceDropsRef.current = customVoiceDrops;
  const customVoiceBuffersRef = useRef<Partial<Record<CustomVoiceSlotId, AudioBuffer>>>({});
  const customBuffersLoadedRef = useRef(false);
  const [recordingSlotId, setRecordingSlotId] = useState<CustomVoiceSlotId | null>(null);
  const [micError, setMicError] = useState<string | null>(null);
  const micCaptureRef = useRef<{
    slotId: CustomVoiceSlotId;
    stop: () => Promise<AudioBuffer | null>;
    cancel: () => void;
  } | null>(null);

  const [isDesktop, setIsDesktop] = useState<boolean>(() =>
    typeof window !== 'undefined' ? window.matchMedia('(min-width: 1024px)').matches : true
  );
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)');
    const onChange = () => setIsDesktop(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const deckARef = useRef(deckA);
  const deckBRef = useRef(deckB);
  const mixerRef = useRef(mixer);
  const autopilotRef = useRef(autopilot);
  const libraryRef = useRef(library);
  libraryRef.current = library;

  const ytPlayersRef = useRef<Record<DeckId, YouTubeDeckPlayer | null>>({
    A: null,
    B: null,
  });
  const localFileBuffersRef = useRef<Map<string, ArrayBuffer>>(new Map());
  const loadSeqRef = useRef<Record<DeckId, number>>({ A: 0, B: 0 });

  // AI Autopilot runtime session refs
  const aiSessionRef = useRef<{
    outgoingDeck: DeckId;
    incomingDeck: DeckId;
    plan: AiTransitionPlan | null;
    transitionStartMs: number;
    transitionDurationMs: number;
    firedSoundIndices: Set<number>;
    firedVoiceIndices: Set<number>;
    firedMomentIndices: Set<number>;
    loopStartedIndices: Set<number>;
    loopEndedIndices: Set<number>;
    playedTrackIds: Set<string>;
    planSeq: number;
    isStartingTransition: boolean;
    midRemixTimeoutId: ReturnType<typeof setTimeout> | null;
    lastCueStepIdx: number;
    lastCueSeekAtMs: number;
    staircaseStage: number;
    cruisingChopPattern: AiChopPatternType;
    cruisingChopUntilMs: number;
    cruisingCueSeq: number[] | null;
    cruisingCueUntilMs: number;
    cruisingCueStartMs: number;
    cruisingReturnSec: number;
    pllLastCheckMs: number;
    pllNudgeUntilMs: number;
    pllNudgedDeck: DeckId | null;
    pllBaseRate: number;
    aiAutoBridgeActive: boolean;
    mashupPhases: AiMashupPhase[] | null;
    mashupStartMs: number;
    mashupTotalBars: number;
    mashupSyncDeck: DeckId;
    lastMashupLabel: string;
    lastMashupDoubleDropFired: boolean;
    // Upgrade #1: Bar-1 / Beat-1 Phase-Locked Quantizer
    pendingMomentIdx: number | null;
    pendingMomentQueuedAtMs: number;
    pendingTransitionQuantize: boolean;
    pendingTransitionQueuedAtMs: number;
    // Upgrade #2: YouTube IFrame Hybrid Synth Remix Layer
    ytPumpDeck: DeckId | null;
    ytPumpMode: 'sidechain' | 'gate-8th' | 'drop-takeover' | null;
    ytPumpStartMs: number;
    ytPumpUntilMs: number;
    ytPumpBridgeActive: boolean;
    ytPumpDropSlammed: boolean;
    // Upgrade #3: VIP Drop Fakeout & Post-Transition Vocal Carryover
    vipFakeoutDeck: DeckId | null;
    vipFakeoutStartMs: number;
    vipFakeoutUntilMs: number;
    vipFakeoutStage: number;
    carryoverDeck: DeckId | null;
    carryoverStartMs: number;
    carryoverUntilMs: number;
    // Upgrade #5: Energy / Outro Rescue Guard & Auto-Loop Safety Net
    lowEnergySinceMs: number;
    rescueLoopActive: boolean;
    outroSafetyLoopActive: boolean;
    lastScratchAtMs: number;
    // Wave-3 Upgrades: Tension Arc, VIP Skip Edit, Stereo Width Slam & Audio Tape-Brake
    setTensionScore: number;
    peakMixStreak: number;
    vipSkipFired: boolean;
    widthSlamUntilMs: number;
    tapeBrakeFired: boolean;
    // Upgrade #5: Breakdown Tease Preview
    teaseFired: boolean;
    teaseActive: boolean;
    teaseStartMs: number;
    teaseUntilMs: number;
  }>({
    outgoingDeck: 'A',
    incomingDeck: 'B',
    plan: null,
    transitionStartMs: 0,
    transitionDurationMs: 16000,
    firedSoundIndices: new Set(),
    firedVoiceIndices: new Set(),
    firedMomentIndices: new Set(),
    loopStartedIndices: new Set(),
    loopEndedIndices: new Set(),
    playedTrackIds: new Set(),
    planSeq: 0,
    isStartingTransition: false,
    midRemixTimeoutId: null,
    lastCueStepIdx: -1,
    lastCueSeekAtMs: 0,
    staircaseStage: 0,
    cruisingChopPattern: 'off',
    cruisingChopUntilMs: 0,
    cruisingCueSeq: null,
    cruisingCueUntilMs: 0,
    cruisingCueStartMs: 0,
    cruisingReturnSec: 0,
    pllLastCheckMs: 0,
    pllNudgeUntilMs: 0,
    pllNudgedDeck: null,
    pllBaseRate: 1,
    aiAutoBridgeActive: false,
    mashupPhases: null,
    mashupStartMs: 0,
    mashupTotalBars: 32,
    mashupSyncDeck: 'B',
    lastMashupLabel: '',
    lastMashupDoubleDropFired: false,
    pendingMomentIdx: null,
    pendingMomentQueuedAtMs: 0,
    pendingTransitionQuantize: false,
    pendingTransitionQueuedAtMs: 0,
    ytPumpDeck: null,
    ytPumpMode: null,
    ytPumpStartMs: 0,
    ytPumpUntilMs: 0,
    ytPumpBridgeActive: false,
    ytPumpDropSlammed: false,
    vipFakeoutDeck: null,
    vipFakeoutStartMs: 0,
    vipFakeoutUntilMs: 0,
    vipFakeoutStage: 0,
    carryoverDeck: null,
    carryoverStartMs: 0,
    carryoverUntilMs: 0,
    lowEnergySinceMs: 0,
    rescueLoopActive: false,
    outroSafetyLoopActive: false,
    lastScratchAtMs: 0,
    setTensionScore: 45,
    peakMixStreak: 0,
    vipSkipFired: false,
    widthSlamUntilMs: 0,
    tapeBrakeFired: false,
    teaseFired: false,
    teaseActive: false,
    teaseStartMs: 0,
    teaseUntilMs: 0,
  });

  const ensureCustomBuffersLoaded = useCallback(async () => {
    if (customBuffersLoadedRef.current) return;
    customBuffersLoadedRef.current = true;
    try {
      const ctx = await djEngine.resume();
      const loaded = await loadAllCustomVoiceBuffers(ctx);
      customVoiceBuffersRef.current = { ...loaded, ...customVoiceBuffersRef.current };
    } catch {
      customBuffersLoadedRef.current = false;
    }
  }, []);

  const isAnyVoiceEnabled = useCallback((voiceId: AnyVoiceDropId): boolean => {
    if (isCustomVoiceDropId(voiceId)) {
      return Boolean(
        customVoiceDropsRef.current.find((c) => c.id === voiceId && c.hasAudio && c.enabled)
      );
    }
    return autopilotRef.current.enabledVoiceIds.includes(voiceId);
  }, []);

  const playAnyVoiceDrop = useCallback(
    async (
      voiceId: AnyVoiceDropId,
      bpm: number,
      musicalKey?: string,
      pitchRate = 1
    ) => {
      if (isCustomVoiceDropId(voiceId)) {
        await ensureCustomBuffersLoaded();
        const buf = customVoiceBuffersRef.current[voiceId];
        if (buf) {
          await djEngine.playCustomVoiceBuffer(buf, bpm);
        }
        return;
      }
      await djEngine.playVoiceDrop(voiceId, bpm, musicalKey, pitchRate);
    },
    [ensureCustomBuffersLoaded]
  );

  const getDeckRef = (id: DeckId) => (id === 'A' ? deckARef.current : deckBRef.current);

  const setDeckState = useCallback((id: DeckId, updater: (prev: DeckState) => DeckState) => {
    const ref = id === 'A' ? deckARef : deckBRef;
    const next = updater(ref.current);
    ref.current = next;
    if (id === 'A') setDeckA(next);
    else setDeckB(next);
  }, []);

  const setMixerState = useCallback((updater: (prev: MixerState) => MixerState) => {
    const next = updater(mixerRef.current);
    mixerRef.current = next;
    setMixer(next);
  }, []);

  const setAutopilotState = useCallback((updater: (prev: AutopilotState) => AutopilotState) => {
    const next = updater(autopilotRef.current);
    autopilotRef.current = next;
    setAutopilot(next);
  }, []);

  // Unified live playhead getter across WebAudio & YouTube IFrame modes
  const getLiveTime = useCallback((deckId: DeckId): number => {
    const d = deckId === 'A' ? deckARef.current : deckBRef.current;
    if (d.playbackMode === 'webaudio') {
      return djEngine.getDeckTime(deckId);
    }
    if (d.playbackMode === 'youtube-iframe') {
      return ytPlayersRef.current[deckId]?.getCurrentTime() ?? d.currentTime;
    }
    return d.currentTime;
  }, []);

  // Sync Web Audio DSP + YouTube IFrame volumes whenever mixer or deck parameters change
  useEffect(() => {
    djEngine.updateMixVolumes({
      volA: deckA.channelVolume,
      volB: deckB.channelVolume,
      crossfader: mixer.crossfader,
      curve: mixer.crossfaderCurve,
      reverse: mixer.crossfaderReverse,
      masterGain: mixer.masterGain,
    });

    const { gainA, gainB } = djEngine.computeCrossfaderGains(
      mixer.crossfader,
      mixer.crossfaderCurve,
      mixer.crossfaderReverse
    );

    if (deckA.playbackMode === 'youtube-iframe' && aiSessionRef.current.ytPumpDeck !== 'A') {
      ytPlayersRef.current.A?.setVolume(deckA.channelVolume * gainA * mixer.masterGain * 100);
    }
    if (deckB.playbackMode === 'youtube-iframe' && aiSessionRef.current.ytPumpDeck !== 'B') {
      ytPlayersRef.current.B?.setVolume(deckB.channelVolume * gainB * mixer.masterGain * 100);
    }
  }, [
    deckA.channelVolume,
    deckA.playbackMode,
    deckB.channelVolume,
    deckB.playbackMode,
    mixer,
  ]);

  useEffect(() => {
    if (deckA.playbackMode === 'webaudio') {
      djEngine.updateDeckEq('A', {
        trim: deckA.gainTrim,
        low: deckA.eqLow,
        mid: deckA.eqMid,
        high: deckA.eqHigh,
        killLow: deckA.killLow,
        killMid: deckA.killMid,
        killHigh: deckA.killHigh,
        filter: deckA.filter,
      });
    }
  }, [
    deckA.playbackMode,
    deckA.gainTrim,
    deckA.eqLow,
    deckA.eqMid,
    deckA.eqHigh,
    deckA.killLow,
    deckA.killMid,
    deckA.killHigh,
    deckA.filter,
  ]);

  useEffect(() => {
    if (deckB.playbackMode === 'webaudio') {
      djEngine.updateDeckEq('B', {
        trim: deckB.gainTrim,
        low: deckB.eqLow,
        mid: deckB.eqMid,
        high: deckB.eqHigh,
        killLow: deckB.killLow,
        killMid: deckB.killMid,
        killHigh: deckB.killHigh,
        filter: deckB.filter,
      });
    }
  }, [
    deckB.playbackMode,
    deckB.gainTrim,
    deckB.eqLow,
    deckB.eqMid,
    deckB.eqHigh,
    deckB.killLow,
    deckB.killMid,
    deckB.killHigh,
    deckB.filter,
  ]);

  useEffect(() => {
    if (deckA.playbackMode === 'webaudio') {
      djEngine.updateDeckFx('A', deckA.fx, deckA.baseBpm * deckA.playbackRate);
    }
  }, [deckA.playbackMode, deckA.fx, deckA.baseBpm, deckA.playbackRate]);

  useEffect(() => {
    if (deckB.playbackMode === 'webaudio') {
      djEngine.updateDeckFx('B', deckB.fx, deckB.baseBpm * deckB.playbackRate);
    }
  }, [deckB.playbackMode, deckB.fx, deckB.baseBpm, deckB.playbackRate]);

  useEffect(() => {
    if (deckA.playbackMode === 'webaudio') {
      djEngine.setDeckStemMode('A', deckA.stemMode);
    }
  }, [deckA.playbackMode, deckA.stemMode]);

  useEffect(() => {
    if (deckB.playbackMode === 'webaudio') {
      djEngine.setDeckStemMode('B', deckB.stemMode);
    }
  }, [deckB.playbackMode, deckB.stemMode]);

  // Keep playing state synced for Web Audio end-of-track & YouTube IFrame looping
  useEffect(() => {
    const id = setInterval(() => {
      (['A', 'B'] as DeckId[]).forEach((deckId) => {
        const d = getDeckRef(deckId);
        if (d.playbackMode === 'webaudio') {
          const playingNow = djEngine.isDeckPlaying(deckId);
          if (playingNow !== d.isPlaying) {
            setDeckState(deckId, (prev) => ({ ...prev, isPlaying: playingNow }));
          }
        } else if (d.playbackMode === 'youtube-iframe' && d.isPlaying && d.loopActive) {
          const t = ytPlayersRef.current[deckId]?.getCurrentTime() ?? 0;
          if (d.loopEndSec > d.loopStartSec + 0.05 && t >= d.loopEndSec) {
            ytPlayersRef.current[deckId]?.seekTo(d.loopStartSec);
          }
        }
      });
    }, 45);
    return () => clearInterval(id);
  }, [setDeckState]);

  // Recording elapsed timer
  useEffect(() => {
    if (!isRecording) return;
    const start = Date.now();
    const id = setInterval(() => {
      setRecordingSec((Date.now() - start) / 1000);
    }, 250);
    return () => clearInterval(id);
  }, [isRecording]);

  // Load Track onto Deck A or B
  const loadTrackToDeck = useCallback(
    async (deckId: DeckId, track: TrackItem) => {
      const seq = ++loadSeqRef.current[deckId];

      // Unconditionally stop any previous WebAudio or YouTube playback immediately on song change
      djEngine.pauseDeck(deckId);
      djEngine.setDeckLoop(deckId, false, 0, 0);
      djEngine.setDeckBuffer(deckId, null);
      djEngine.setDeckHpssBuffers(deckId, null, null);
      djEngine.setDeckSemitoneShift(deckId, 0);
      djEngine.setDeckKeyLock(deckId, getDeckRef(deckId).keyLock);
      ytPlayersRef.current[deckId]?.stop();

      setDeckState(deckId, (prev) => ({
        ...prev,
        track,
        isLoading: true,
        loadError: null,
        playbackMode: 'none',
        isPlaying: false,
        currentTime: 0,
        duration: track.durationSec,
        baseBpm: track.bpm,
        playbackRate: 1,
        syncLocked: false,
        cuePointSec: 0,
        loopActive: false,
        loopBars: null,
        eqLow: 0,
        eqMid: 0,
        eqHigh: 0,
        killLow: false,
        killMid: false,
        killHigh: false,
        filter: 0,
        fx: { ...prev.fx, enabled: false },
        stemMode: 'off',
        hotCues: [0, 1, 2, 3].map((index) => ({
          index,
          timeSec: null,
          label: `Cue ${index + 1}`,
          color: HOT_CUE_COLORS[index],
        })),
      }));

      try {
        if (track.sourceType === 'local') {
          const raw = localFileBuffersRef.current.get(track.id);
          if (!raw) throw new Error('Local audio buffer expired; please re-import file.');
          const buf = await djEngine.decodeAudioData(raw.slice(0));
          if (seq !== loadSeqRef.current[deckId]) return;
          const waveform = extractRgbWaveform(buf, 1600);
          const detected = detectBpmAndGrid(buf);
          const keyInfo = detectCamelotKey(buf);
          const resolvedKey =
            !track.calibrated && keyInfo.confidence >= 0.25 ? keyInfo.musicalKey : track.musicalKey;
          const seg = segmentTrackStructure(waveform, buf.duration, detected.bpm);
          const tempoMap = buildElasticTempoMap(buf, detected.bpm, detected.firstBeatSec);
          const loudness = estimateTrackLoudnessGain(buf);
          const autoTrimGain = track.autoTrimGain ?? loudness.autoTrimGain;

          djEngine.setDeckBuffer(deckId, buf);
          djEngine.setDeckKeyLock(deckId, getDeckRef(deckId).keyLock);
          djEngine.setDeckSemitoneShift(deckId, 0);
          // Background 3-Stem HPSS Worker separation (non-blocking) for vocal/drum/bass stems
          djEngine.resume().then((audioCtx) => {
            void runHpssSeparation(audioCtx, buf).then((res) => {
              if (res && seq === loadSeqRef.current[deckId]) {
                djEngine.setDeckHpssBuffers(
                  deckId,
                  res.harmonicBuffer,
                  res.percussiveBuffer,
                  res.bassBuffer
                );
              }
            });
          });
          libraryRef.current.updateTrackMeta(track.id, {
            bpm: detected.bpm,
            musicalKey: resolvedKey,
            durationSec: buf.duration,
            firstBeatSec: detected.firstBeatSec,
            detectedDropSec: seg.autoDropSec,
            sections: seg.segments,
            tempoMap,
            autoTrimGain,
          });
          const autoCues = computeAutoHotCues(
            buf.duration,
            detected.bpm,
            track.dropCueSec,
            detected.firstBeatSec,
            seg.autoDropSec,
            seg.segments
          );
          setDeckState(deckId, (prev) => ({
            ...prev,
            track: {
              ...track,
              bpm: detected.bpm,
              musicalKey: resolvedKey,
              firstBeatSec: detected.firstBeatSec,
              detectedDropSec: seg.autoDropSec,
              sections: seg.segments,
              tempoMap,
              autoTrimGain,
            },
            isLoading: false,
            playbackMode: 'webaudio',
            duration: buf.duration,
            baseBpm: detected.bpm,
            semitoneShift: 0,
            gainTrim: autoTrimGain,
            waveform,
            sections: seg.segments,
            detectedDropSec: seg.autoDropSec,
            hotCues: autoCues,
          }));
          return;
        }

        if (track.youtubeId) {
          let streamOk = false;
          try {
            const abortCtrl = new AbortController();
            const streamTimeout = setTimeout(() => abortCtrl.abort(), 3800);
            const resp = await fetch(
              `/api/yt/stream/${encodeURIComponent(track.youtubeId)}`,
              { signal: abortCtrl.signal }
            ).finally(() => clearTimeout(streamTimeout));
            if (seq !== loadSeqRef.current[deckId]) return;
            if (resp.ok && resp.headers.get('content-type')?.includes('audio')) {
              const arr = await resp.arrayBuffer();
              if (seq !== loadSeqRef.current[deckId]) return;
              const buf = await djEngine.decodeAudioData(arr);
              if (seq !== loadSeqRef.current[deckId]) return;
              const waveform = extractRgbWaveform(buf, 1600);
              const detected = detectBpmAndGrid(buf);
              const keyInfo = detectCamelotKey(buf);
              const resolvedKey =
                !track.calibrated && keyInfo.confidence >= 0.25
                  ? keyInfo.musicalKey
                  : track.musicalKey;
              const seg = segmentTrackStructure(waveform, buf.duration, detected.bpm);
              const tempoMap = buildElasticTempoMap(buf, detected.bpm, detected.firstBeatSec);
              const loudness = estimateTrackLoudnessGain(buf);
              const autoTrimGain = track.autoTrimGain ?? loudness.autoTrimGain;

              djEngine.setDeckBuffer(deckId, buf);
              djEngine.setDeckKeyLock(deckId, getDeckRef(deckId).keyLock);
              djEngine.setDeckSemitoneShift(deckId, 0);
              djEngine.resume().then((audioCtx) => {
                void runHpssSeparation(audioCtx, buf).then((res) => {
                  if (res && seq === loadSeqRef.current[deckId]) {
                    djEngine.setDeckHpssBuffers(
                      deckId,
                      res.harmonicBuffer,
                      res.percussiveBuffer,
                      res.bassBuffer
                    );
                  }
                });
              });
              libraryRef.current.updateTrackMeta(track.id, {
                sourceType: 'youtube-stream',
                bpm: detected.bpm,
                musicalKey: resolvedKey,
                durationSec: buf.duration,
                firstBeatSec: detected.firstBeatSec,
                detectedDropSec: seg.autoDropSec,
                sections: seg.segments,
                tempoMap,
                autoTrimGain,
              });
              const autoCues = computeAutoHotCues(
                buf.duration,
                detected.bpm,
                track.dropCueSec,
                detected.firstBeatSec,
                seg.autoDropSec,
                seg.segments
              );
              setDeckState(deckId, (prev) => ({
                ...prev,
                track: {
                  ...track,
                  sourceType: 'youtube-stream',
                  bpm: detected.bpm,
                  musicalKey: resolvedKey,
                  firstBeatSec: detected.firstBeatSec,
                  detectedDropSec: seg.autoDropSec,
                  sections: seg.segments,
                  tempoMap,
                  autoTrimGain,
                },
                isLoading: false,
                playbackMode: 'webaudio',
                duration: buf.duration,
                baseBpm: detected.bpm,
                semitoneShift: 0,
                gainTrim: autoTrimGain,
                waveform,
                sections: seg.segments,
                detectedDropSec: seg.autoDropSec,
                hotCues: autoCues,
              }));
              streamOk = true;
            }
          } catch {
            if (seq !== loadSeqRef.current[deckId]) return;
            streamOk = false;
          }

          if (!streamOk) {
            if (seq !== loadSeqRef.current[deckId]) return;
            if (!ytPlayersRef.current[deckId]) {
              ytPlayersRef.current[deckId] = new YouTubeDeckPlayer(
                deckId,
                (playing) => {
                  setDeckState(deckId, (prev) =>
                    prev.playbackMode === 'youtube-iframe' ? { ...prev, isPlaying: playing } : prev
                  );
                },
                (realDuration) => {
                  setDeckState(deckId, (prev) => {
                    if (prev.playbackMode !== 'youtube-iframe' || !prev.track) return prev;
                    const wfReal = generateDeterministicBeatWaveform(
                      prev.track.youtubeId || prev.track.id,
                      realDuration,
                      prev.baseBpm
                    );
                    const segReal = segmentTrackStructure(wfReal, realDuration, prev.baseBpm);
                    const autoTrimGain =
                      prev.track.autoTrimGain ?? computeWaveformLoudnessGain(wfReal);
                    libraryRef.current.updateTrackMeta(prev.track.id, {
                      durationSec: realDuration,
                      detectedDropSec: segReal.autoDropSec,
                      sections: segReal.segments,
                      autoTrimGain,
                    });
                    return {
                      ...prev,
                      duration: realDuration,
                      gainTrim: autoTrimGain,
                      waveform: wfReal,
                      sections: segReal.segments,
                      detectedDropSec: segReal.autoDropSec,
                      track: {
                        ...prev.track,
                        durationSec: realDuration,
                        detectedDropSec: segReal.autoDropSec,
                        sections: segReal.segments,
                        autoTrimGain,
                      },
                      hotCues: computeAutoHotCues(
                        realDuration,
                        prev.baseBpm,
                        prev.track.dropCueSec,
                        prev.track.firstBeatSec,
                        segReal.autoDropSec,
                        segReal.segments
                      ),
                    };
                  });
                }
              );
            }
            const estDur = track.durationSec || 210;
            const wf = generateDeterministicBeatWaveform(track.youtubeId, estDur, track.bpm);
            const seg = segmentTrackStructure(wf, estDur, track.bpm);
            const autoTrimGain = track.autoTrimGain ?? computeWaveformLoudnessGain(wf);
            libraryRef.current.updateTrackMeta(track.id, { autoTrimGain });
            const autoCues = computeAutoHotCues(
              estDur,
              track.bpm,
              track.dropCueSec,
              track.firstBeatSec,
              seg.autoDropSec,
              seg.segments
            );
            setDeckState(deckId, (prev) => ({
              ...prev,
              playbackMode: 'youtube-iframe',
              gainTrim: autoTrimGain,
              waveform: wf,
              sections: seg.segments,
              detectedDropSec: seg.autoDropSec,
              track: prev.track
                ? {
                    ...prev.track,
                    detectedDropSec: seg.autoDropSec,
                    sections: seg.segments,
                    autoTrimGain,
                  }
                : prev.track,
              hotCues: autoCues,
            }));
            await ytPlayersRef.current[deckId]!.mountAndLoad(track.youtubeId);
            if (seq !== loadSeqRef.current[deckId]) {
              ytPlayersRef.current[deckId]?.stop();
              return;
            }
            setDeckState(deckId, (prev) => ({
              ...prev,
              isLoading: false,
            }));
          }
        }
      } catch (err: any) {
        if (seq !== loadSeqRef.current[deckId]) return;
        setDeckState(deckId, (prev) => ({
          ...prev,
          isLoading: false,
          playbackMode: 'none',
          loadError: err?.message || 'Unable to load track audio.',
        }));
      }
    },
    [setDeckState]
  );

  // Transport & DSP Handlers
  const handleTogglePlay = useCallback(
    async (deckId: DeckId, forcePlay?: boolean) => {
      const d = getDeckRef(deckId);
      const shouldPlay = typeof forcePlay === 'boolean' ? forcePlay : !d.isPlaying;

      if (!shouldPlay) {
        // Always stop BOTH engines unconditionally so no orphaned audio survives song changes
        djEngine.pauseDeck(deckId);
        ytPlayersRef.current[deckId]?.stop();
        setDeckState(deckId, (prev) => ({ ...prev, isPlaying: false }));
        return;
      }

      if (!d.track || d.isLoading || d.playbackMode === 'none') return;

      // Keep mixer gains synchronized before starting playback
      const m = mixerRef.current;
      djEngine.updateMixVolumes({
        volA: deckARef.current.channelVolume,
        volB: deckBRef.current.channelVolume,
        crossfader: m.crossfader,
        curve: m.crossfaderCurve,
        reverse: m.crossfaderReverse,
        masterGain: m.masterGain,
      });

      if (d.playbackMode === 'webaudio') {
        try {
          await djEngine.playDeck(deckId);
          setDeckState(deckId, (prev) => ({
            ...prev,
            isPlaying: djEngine.isDeckPlaying(deckId),
          }));
        } catch (err: any) {
          setDeckState(deckId, (prev) => ({
            ...prev,
            isPlaying: false,
            loadError: err?.message || 'Unable to start audio playback.',
          }));
        }
      } else if (d.playbackMode === 'youtube-iframe') {
        const { gainA, gainB } = djEngine.computeCrossfaderGains(
          m.crossfader,
          m.crossfaderCurve,
          m.crossfaderReverse
        );
        const deckGain = deckId === 'A' ? gainA : gainB;
        const targetVol = d.channelVolume * deckGain * m.masterGain * 100;
        const ytPlayer = ytPlayersRef.current[deckId];
        if (ytPlayer) {
          ytPlayer.setVolume(targetVol);
          ytPlayer.play();
        }
        setDeckState(deckId, (prev) => ({ ...prev, isPlaying: true }));
      }
    },
    [setDeckState]
  );

  const handleSeek = useCallback(
    (deckId: DeckId, timeSec: number) => {
      const d = getDeckRef(deckId);
      const clamped = Math.max(0, Math.min(d.duration, timeSec));
      if (d.playbackMode === 'webaudio') {
        djEngine.seekDeck(deckId, clamped);
      } else if (d.playbackMode === 'youtube-iframe') {
        ytPlayersRef.current[deckId]?.seekTo(clamped);
      }
      setDeckState(deckId, (prev) => ({ ...prev, currentTime: clamped }));
    },
    [setDeckState]
  );

  const handleCue = useCallback(
    (deckId: DeckId) => {
      const d = getDeckRef(deckId);
      if (!d.track) return;
      if (d.isPlaying) {
        if (d.playbackMode === 'webaudio') {
          djEngine.pauseDeck(deckId);
          djEngine.seekDeck(deckId, d.cuePointSec);
        } else {
          ytPlayersRef.current[deckId]?.pause();
          ytPlayersRef.current[deckId]?.seekTo(d.cuePointSec);
        }
        setDeckState(deckId, (prev) => ({
          ...prev,
          isPlaying: false,
          currentTime: prev.cuePointSec,
        }));
      } else {
        const now = getLiveTime(deckId);
        setDeckState(deckId, (prev) => ({ ...prev, cuePointSec: now }));
      }
    },
    [getLiveTime, setDeckState]
  );

  const handlePitchChange = useCallback(
    (deckId: DeckId, rate: number) => {
      const d = getDeckRef(deckId);
      const clamped = Math.max(0.35, Math.min(1.65, rate));
      if (d.playbackMode === 'webaudio') {
        djEngine.setDeckRate(deckId, clamped);
      } else if (d.playbackMode === 'youtube-iframe') {
        ytPlayersRef.current[deckId]?.setPlaybackRate(clamped);
      }
      setDeckState(deckId, (prev) => ({
        ...prev,
        playbackRate: clamped,
        syncLocked: false,
      }));
    },
    [setDeckState]
  );

  const handleSync = useCallback(
    (deckId: DeckId) => {
      const otherId: DeckId = deckId === 'A' ? 'B' : 'A';
      const thisDeck = getDeckRef(deckId);
      const otherDeck = getDeckRef(otherId);
      if (!thisDeck.track || !otherDeck.track) return;

      const otherTime = getLiveTime(otherId);
      const thisTime = getLiveTime(deckId);

      // Elastic Beat-Grid phrase lookup for tight sync even across live-drumming intros/bridges
      const otherPhrase = resolveElasticPhraseAtTime(
        otherDeck.track.tempoMap,
        otherDeck.baseBpm,
        otherDeck.track.firstBeatSec || 0,
        otherTime
      );
      const thisPhrase = resolveElasticPhraseAtTime(
        thisDeck.track.tempoMap,
        thisDeck.baseBpm,
        thisDeck.track.firstBeatSec || 0,
        thisTime
      );

      const snapYtStep = (rate: number): number =>
        rate <= 0.875 ? 0.75 : rate >= 1.125 ? 1.25 : 1;

      // Upgrade #4: Reverse Master Clock when syncing YouTube IFrame <-> WebAudio!
      // YouTube only supports discrete rates (0.75, 1, 1.25), so continuously stretch the WebAudio deck to match.
      if (thisDeck.playbackMode === 'youtube-iframe' && otherDeck.playbackMode === 'webaudio') {
        const targetBpm = otherPhrase.bpm * otherDeck.playbackRate;
        let foldedBase = thisPhrase.bpm;
        const straightDiff = Math.abs(thisPhrase.bpm - targetBpm);
        const doubleDiff = Math.abs(thisPhrase.bpm * 2 - targetBpm);
        const halfDiff = Math.abs(thisPhrase.bpm * 0.5 - targetBpm);
        if (doubleDiff + 4 < straightDiff && doubleDiff <= 14) foldedBase = thisPhrase.bpm * 2;
        else if (halfDiff + 4 < straightDiff && halfDiff <= 14) foldedBase = thisPhrase.bpm * 0.5;

        const ytRate = snapYtStep(targetBpm / foldedBase);
        const effectiveYtBpm = foldedBase * ytRate;
        const webStretchRate = Math.max(0.55, Math.min(1.5, effectiveYtBpm / otherPhrase.bpm));

        const ytBeatSec = 60 / effectiveYtBpm;
        const otherBeatSec = 60 / effectiveYtBpm;
        const otherPhase =
          ((((otherTime - otherPhrase.firstBeatSec) % otherBeatSec) + otherBeatSec) % otherBeatSec) /
          otherBeatSec;
        const thisPhase =
          ((((thisTime - thisPhrase.firstBeatSec) % ytBeatSec) + ytBeatSec) % ytBeatSec) /
          ytBeatSec;
        let phaseDiff = otherPhase - thisPhase;
        if (phaseDiff > 0.5) phaseDiff -= 1;
        if (phaseDiff < -0.5) phaseDiff += 1;
        const alignedTime = Math.max(
          0,
          Math.min(thisDeck.duration, thisTime + phaseDiff * ytBeatSec)
        );

        ytPlayersRef.current[deckId]?.setPlaybackRate(ytRate);
        ytPlayersRef.current[deckId]?.seekTo(alignedTime);
        djEngine.setDeckKeyLock(otherId, true);
        djEngine.setDeckRate(otherId, webStretchRate);

        setDeckState(deckId, (prev) => ({
          ...prev,
          playbackRate: ytRate,
          currentTime: alignedTime,
          syncLocked: true,
          isMaster: true, // YouTube acts as quantized clock master
        }));
        setDeckState(otherId, (prev) => ({
          ...prev,
          playbackRate: webStretchRate,
          keyLock: true,
          syncLocked: true,
          isMaster: false,
        }));
        return;
      }

      if (thisDeck.playbackMode === 'webaudio' && otherDeck.playbackMode === 'youtube-iframe') {
        const ytRate = snapYtStep(otherDeck.playbackRate);
        const ytEffectiveBpm = otherPhrase.bpm * ytRate;
        let foldedBase = thisPhrase.bpm;
        const straightDiff = Math.abs(thisPhrase.bpm - ytEffectiveBpm);
        const doubleDiff = Math.abs(thisPhrase.bpm * 2 - ytEffectiveBpm);
        const halfDiff = Math.abs(thisPhrase.bpm * 0.5 - ytEffectiveBpm);
        if (doubleDiff + 4 < straightDiff && doubleDiff <= 14) foldedBase = thisPhrase.bpm * 2;
        else if (halfDiff + 4 < straightDiff && halfDiff <= 14) foldedBase = thisPhrase.bpm * 0.5;

        const webRate = Math.max(0.5, Math.min(1.5, ytEffectiveBpm / foldedBase));
        const otherBeatSec = 60 / ytEffectiveBpm;
        const thisBeatSec = 60 / foldedBase;

        const otherPhase =
          ((((otherTime - otherPhrase.firstBeatSec) % otherBeatSec) + otherBeatSec) % otherBeatSec) /
          otherBeatSec;
        const thisPhase =
          ((((thisTime - thisPhrase.firstBeatSec) % thisBeatSec) + thisBeatSec) % thisBeatSec) /
          thisBeatSec;
        let phaseDiff = otherPhase - thisPhase;
        if (phaseDiff > 0.5) phaseDiff -= 1;
        if (phaseDiff < -0.5) phaseDiff += 1;
        const alignedTime = Math.max(
          0,
          Math.min(thisDeck.duration, thisTime + phaseDiff * thisBeatSec)
        );

        ytPlayersRef.current[otherId]?.setPlaybackRate(ytRate);
        djEngine.setDeckKeyLock(deckId, true);
        djEngine.setDeckRate(deckId, webRate);
        djEngine.seekDeck(deckId, alignedTime);

        setDeckState(deckId, (prev) => ({
          ...prev,
          playbackRate: webRate,
          keyLock: true,
          currentTime: alignedTime,
          syncLocked: true,
          isMaster: false,
        }));
        setDeckState(otherId, (prev) => ({
          ...prev,
          playbackRate: ytRate,
          isMaster: true,
        }));
        return;
      }

      const targetBpm = otherPhrase.bpm * otherDeck.playbackRate;
      let foldedBase = thisPhrase.bpm;
      const straightDiff = Math.abs(thisPhrase.bpm - targetBpm);
      const doubleDiff = Math.abs(thisPhrase.bpm * 2 - targetBpm);
      const halfDiff = Math.abs(thisPhrase.bpm * 0.5 - targetBpm);
      if (doubleDiff + 4 < straightDiff && doubleDiff <= 14) {
        foldedBase = thisPhrase.bpm * 2;
      } else if (halfDiff + 4 < straightDiff && halfDiff <= 14) {
        foldedBase = thisPhrase.bpm * 0.5;
      }
      const newRate = Math.max(0.5, Math.min(1.5, targetBpm / foldedBase));

      const otherBeatSec = 60 / targetBpm;
      const thisBeatSec = 60 / foldedBase;

      const otherFirst = otherPhrase.firstBeatSec;
      const thisFirst = thisPhrase.firstBeatSec;

      const otherPhase =
        ((((otherTime - otherFirst) % otherBeatSec) + otherBeatSec) % otherBeatSec) / otherBeatSec;
      const thisPhase =
        ((((thisTime - thisFirst) % thisBeatSec) + thisBeatSec) % thisBeatSec) / thisBeatSec;

      let phaseDiff = otherPhase - thisPhase;
      if (phaseDiff > 0.5) phaseDiff -= 1;
      if (phaseDiff < -0.5) phaseDiff += 1;

      const alignedTime = Math.max(0, Math.min(thisDeck.duration, thisTime + phaseDiff * thisBeatSec));

      if (thisDeck.playbackMode === 'webaudio') {
        djEngine.setDeckRate(deckId, newRate);
        djEngine.seekDeck(deckId, alignedTime);
      } else if (thisDeck.playbackMode === 'youtube-iframe') {
        ytPlayersRef.current[deckId]?.setPlaybackRate(newRate);
        ytPlayersRef.current[deckId]?.seekTo(alignedTime);
      }

      setDeckState(deckId, (prev) => ({
        ...prev,
        playbackRate: newRate,
        currentTime: alignedTime,
        syncLocked: true,
        isMaster: false,
      }));
      setDeckState(otherId, (prev) => ({ ...prev, isMaster: true }));
    },
    [getLiveTime, setDeckState]
  );

  const handleToggleLoop = useCallback(
    (deckId: DeckId, bars: number) => {
      const d = getDeckRef(deckId);
      if (!d.track) return;
      const cur = getLiveTime(deckId);
      const beatSec = 60 / d.baseBpm;
      const loopLen = bars * 4 * beatSec;
      const start = Math.max(0, cur);
      const end = Math.min(d.duration, start + loopLen);

      if (d.playbackMode === 'webaudio') {
        djEngine.setDeckLoop(deckId, true, start, end);
      }
      setDeckState(deckId, (prev) => ({
        ...prev,
        loopActive: true,
        loopStartSec: start,
        loopEndSec: end,
        loopBars: bars,
      }));
    },
    [getLiveTime, setDeckState]
  );

  const handleExitLoop = useCallback(
    (deckId: DeckId) => {
      const d = getDeckRef(deckId);
      if (d.playbackMode === 'webaudio') {
        djEngine.setDeckLoop(deckId, false, 0, 0);
      }
      setDeckState(deckId, (prev) => ({
        ...prev,
        loopActive: false,
        loopBars: null,
      }));
    },
    [setDeckState]
  );

  const handleBeatJump = useCallback(
    (deckId: DeckId, beats: number) => {
      const d = getDeckRef(deckId);
      if (!d.track) return;
      const beatSec = 60 / d.baseBpm;
      const next = getLiveTime(deckId) + beats * beatSec;
      handleSeek(deckId, next);
    },
    [getLiveTime, handleSeek]
  );

  // =========================================================================
  // OFFLINE AI AUTO-PILOT DJ ENGINE (Local Harmonic & Beat Choreography)
  // =========================================================================

  const getPlaylistTracks = useCallback(
    (playlistId: string, trackIdsOverride?: string[]): TrackItem[] => {
      const allTracks = libraryRef.current.tracks;
      if (trackIdsOverride && trackIdsOverride.length > 0) {
        const map = new Map(allTracks.map((t) => [t.id, t]));
        return trackIdsOverride
          .map((id) => map.get(id))
          .filter((t): t is TrackItem => Boolean(t));
      }
      if (!playlistId || playlistId === 'all') return allTracks;
      const pl = libraryRef.current.playlists.find((p) => p.id === playlistId);
      if (!pl) return allTracks;
      const map = new Map(allTracks.map((t) => [t.id, t]));
      return pl.trackIds
        .map((id) => map.get(id))
        .filter((t): t is TrackItem => Boolean(t));
    },
    []
  );

  const requestNextAiPlan = useCallback(
    async (
      outgoingDeckId: DeckId,
      vibe: AiDjVibe,
      directionOverride?: string,
      targetPlaylistIdOverride?: string,
      remixModeOverride?: boolean,
      trackIdsOverride?: string[],
      aggressivenessOverride?: number,
      seedOverride?: number,
      randomnessOverride?: number
    ) => {
      const myPlanSeq = ++aiSessionRef.current.planSeq;

      const incomingDeckId: DeckId = outgoingDeckId === 'A' ? 'B' : 'A';
      const outDeck = getDeckRef(outgoingDeckId);
      const playlistId = targetPlaylistIdOverride ?? autopilotRef.current.targetPlaylistId;
      const remixMode = remixModeOverride ?? autopilotRef.current.remixMode;
      const aggressiveness = aggressivenessOverride ?? autopilotRef.current.aggressiveness;
      const randomness = randomnessOverride ?? autopilotRef.current.randomness;
      const sessionSeed = seedOverride ?? autopilotRef.current.sessionSeed;
      const pool = getPlaylistTracks(playlistId, trackIdsOverride);

      if (outDeck.track?.id) {
        aiSessionRef.current.playedTrackIds.add(outDeck.track.id);
      }

      const otherTracks = pool.filter((t) => t.id !== outDeck.track?.id);
      const rawCandidates = otherTracks.length > 0 ? otherTracks : pool;
      const candidates = rawCandidates.map((t) => ({
        id: t.id,
        title: t.title,
        artist: t.artist,
        bpm: t.bpm,
        musicalKey: t.musicalKey,
        durationSec: t.durationSec,
        firstBeatSec: t.firstBeatSec,
        dropCueSec: t.dropCueSec,
        detectedDropSec: t.detectedDropSec,
        sections: t.sections,
      }));

      if (candidates.length === 0) {
        setAutopilotState((prev) => ({
          ...prev,
          enabled: false,
          phase: 'error',
          errorMessage: 'Selected playlist has no tracks. Add tracks first.',
        }));
        return;
      }

      // Reset cycle once every track in the playlist has been played
      const unplayedLeft = candidates.some((c) => !aiSessionRef.current.playedTrackIds.has(c.id));
      if (!unplayedLeft) {
        aiSessionRef.current.playedTrackIds.clear();
        if (outDeck.track?.id) aiSessionRef.current.playedTrackIds.add(outDeck.track.id);
      }

      setAutopilotState((prev) => ({
        ...prev,
        phase: 'planning',
        errorMessage: null,
        currentActionLabel: directionOverride
          ? `Planning "${directionOverride}"...`
          : remixMode
          ? 'Offline AI crafting live remix choreography...'
          : 'Offline AI analyzing BPM, Camelot key & transitions...',
      }));

      try {
        const failedIds = new Set<string>();
        let loadedPlan: AiTransitionPlan | null = null;
        let chosenTrack: TrackItem | undefined;
        let lastLoadError = '';
        const maxAttempts = Math.min(candidates.length, 4);

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          const attemptCandidates = candidates.filter((c) => !failedIds.has(c.id));
          if (attemptCandidates.length === 0) break;

          await ensureCustomBuffersLoaded();
          const plan = planOfflineTransition({
            outgoingTrack: outDeck.track,
            currentBpm: outDeck.track ? outDeck.baseBpm * outDeck.playbackRate : 124,
            vibe,
            direction: directionOverride ?? autopilotRef.current.lastDirection,
            candidates: attemptCandidates,
            playedTrackIds: Array.from(aiSessionRef.current.playedTrackIds),
            remixMode,
            energyMode: autopilotRef.current.energyMode,
            aggressiveness,
            randomness,
            sessionSeed: (sessionSeed + attempt * 7919) >>> 0,
            quickMix: autopilotRef.current.quickMix,
            outWaveform: outDeck.waveform,
            currentTimeSec: getLiveTime(outgoingDeckId),
            setTensionScore: aiSessionRef.current.setTensionScore,
            peakMixStreak: aiSessionRef.current.peakMixStreak,
            voiceFxEnabled: autopilotRef.current.voiceFxEnabled,
            enabledVoiceIds: autopilotRef.current.enabledVoiceIds,
            enabledCustomDrops: customVoiceDropsRef.current,
          });

          chosenTrack = libraryRef.current.tracks.find((t) => t.id === plan.nextTrackId);
          if (!chosenTrack) {
            failedIds.add(plan.nextTrackId);
            continue;
          }

          aiSessionRef.current.playedTrackIds.add(chosenTrack.id);
          const curInDeck = getDeckRef(incomingDeckId);
          if (
            curInDeck.track?.id !== chosenTrack.id ||
            curInDeck.playbackMode === 'none' ||
            curInDeck.loadError
          ) {
            await loadTrackToDeck(incomingDeckId, chosenTrack);
          }

          if (myPlanSeq !== aiSessionRef.current.planSeq || !autopilotRef.current.enabled) {
            return;
          }

          const loadedInDeck = getDeckRef(incomingDeckId);
          if (
            loadedInDeck.track &&
            loadedInDeck.playbackMode !== 'none' &&
            !loadedInDeck.loadError
          ) {
            // Wave-3 #4: Sliding-Window "Sparsest Pocket" Mashup Cue Finder once incoming waveform is decoded
            if (loadedInDeck.waveform.length >= 24 && outDeck.waveform.length >= 24) {
              const curOutPct = outDeck.duration > 10 ? getLiveTime(outgoingDeckId) / outDeck.duration : 0.1;
              const pocket = findSparsestMashupPocket({
                wfOut: outDeck.waveform,
                wfIn: loadedInDeck.waveform,
                outBpm: outDeck.baseBpm,
                outDurationSec: outDeck.duration,
                inBpm: loadedInDeck.baseBpm,
                inDurationSec: loadedInDeck.duration,
                minOutPct: Math.max(autopilotRef.current.quickMix ? 0.3 : 0.42, curOutPct + 0.04),
                maxOutPct: autopilotRef.current.quickMix ? 0.56 : 0.78,
                preferredBars: plan.transitionBars,
              });
              plan.clashProfile = pocket.clashProfile;
              plan.pocketSummary = pocket.pocketSummary;
              if (typeof plan.doubleDropCueSec !== 'number' && !plan.isBreatherMix) {
                plan.incomingStartPct = pocket.inStartPct;
                plan.recommendedOutStartPct = pocket.outStartPct;
                if (
                  plan.genrePhysicsMode !== 'chill-velvet' &&
                  plan.genrePhysicsMode !== 'dnb-chop'
                ) {
                  plan.transitionBars = pocket.recommendedBars;
                }
              }
            }
            loadedPlan = plan;
            break;
          }

          lastLoadError =
            loadedInDeck.loadError || `Unable to cue "${chosenTrack.title}".`;
          failedIds.add(chosenTrack.id);
        }

        if (myPlanSeq !== aiSessionRef.current.planSeq || !autopilotRef.current.enabled) {
          return;
        }

        if (!loadedPlan || !chosenTrack) {
          setAutopilotState((prev) => ({
            ...prev,
            enabled: false,
            phase: 'error',
            errorMessage: lastLoadError || 'Unable to cue next playable track in playlist.',
            currentActionLabel: '',
          }));
          return;
        }

        aiSessionRef.current.outgoingDeck = outgoingDeckId;
        aiSessionRef.current.incomingDeck = incomingDeckId;
        aiSessionRef.current.plan = loadedPlan;
        aiSessionRef.current.vipSkipFired = false;
        aiSessionRef.current.teaseFired = false;
        aiSessionRef.current.teaseActive = false;
        aiSessionRef.current.teaseStartMs = 0;
        aiSessionRef.current.teaseUntilMs = 0;
        aiSessionRef.current.firedSoundIndices.clear();
        aiSessionRef.current.firedVoiceIndices.clear();
        aiSessionRef.current.firedMomentIndices.clear();
        aiSessionRef.current.loopStartedIndices.clear();
        aiSessionRef.current.loopEndedIndices.clear();

        setAutopilotState((prev) => {
          if (!prev.enabled) return prev;
          return {
            ...prev,
            phase: 'cruising',
            activePlan: loadedPlan,
            upcomingQueue: loadedPlan.upcomingQueue || [],
            transitionProgress: 0,
            holdExtraBars: 0,
            nextTransitionEtaSec: null,
            mutedMomentIndices: [],
            currentActionLabel: `${loadedPlan.sessionSignature} · Next: "${chosenTrack?.title || 'Track'}"`,
          };
        });
      } catch (err: any) {
        if (myPlanSeq !== aiSessionRef.current.planSeq) return;
        setAutopilotState((prev) => ({
          ...prev,
          enabled: false,
          phase: 'error',
          errorMessage: err?.message || 'AI Autopilot error.',
          currentActionLabel: '',
        }));
      }
    },
    [getLiveTime, getPlaylistTracks, loadTrackToDeck, setAutopilotState]
  );

  const stopCarryoverIfActive = useCallback(() => {
    const sess = aiSessionRef.current;
    if (!sess.carryoverDeck) return;
    const prevCarry = sess.carryoverDeck;
    sess.carryoverDeck = null;
    sess.carryoverUntilMs = 0;
    djEngine.setDeckSidechainDuck(prevCarry, 1);
    handleTogglePlay(prevCarry, false);
    setDeckState(prevCarry, (p) => ({
      ...p,
      channelVolume: 0.9,
      eqLow: 0,
      eqMid: 0,
      eqHigh: 0,
      killLow: false,
      killMid: false,
      killHigh: false,
      filter: 0,
      playbackRate: 1,
      stemMode: 'off',
      fx: { ...p.fx, enabled: false },
    }));
    setMixerState((m) => ({
      ...m,
      crossfader: sess.outgoingDeck === 'A' ? -1 : 1,
    }));
  }, [handleTogglePlay, setDeckState, setMixerState]);

  const beginAiTransitionNow = useCallback(
    async (triggeredManually = false) => {
      const sess = aiSessionRef.current;
      if (sess.isStartingTransition) return;
      if (!sess.plan && !(autopilotRef.current.enabled && sess.carryoverDeck)) return;

      sess.isStartingTransition = true;

      try {
        if (!sess.plan && sess.carryoverDeck) {
          stopCarryoverIfActive();
          await requestNextAiPlan(
            sess.outgoingDeck,
            autopilotRef.current.vibe,
            undefined,
            autopilotRef.current.targetPlaylistId,
            autopilotRef.current.remixMode
          );
        }

        if (!sess.plan || !autopilotRef.current.enabled) return;

        const outId = sess.outgoingDeck;
        const inId = sess.incomingDeck;
        const outDeck = getDeckRef(outId);
        const inDeck = getDeckRef(inId);
        if (!inDeck.track || inDeck.isLoading || inDeck.playbackMode === 'none') return;

        // Record Taste Learning signal if user skipped cruising via manual Mix Now early
        if (triggeredManually && autopilotRef.current.phase === 'cruising') {
          const curT = getLiveTime(outId);
          const dur = Math.max(10, outDeck.duration);
          if (curT / dur < 0.35) {
            recordAiFeedbackEvent({
              outcome: 'skipped_mix_now',
              outTrackId: outDeck.track?.id,
              inTrackId: inDeck.track?.id,
              mixStyleKey: sess.plan.mixStyleKey,
              aggressiveness: autopilotRef.current.aggressiveness,
            });
          }
        }

        const myPlanSeq = sess.planSeq;

        if (sess.midRemixTimeoutId) {
          clearTimeout(sess.midRemixTimeoutId);
          sess.midRemixTimeoutId = null;
        }
        sess.cruisingChopPattern = 'off';
        sess.cruisingChopUntilMs = 0;
        sess.cruisingCueSeq = null;
        sess.cruisingCueUntilMs = 0;
        sess.pllLastCheckMs = 0;
        sess.pllNudgeUntilMs = 0;
        sess.pllNudgedDeck = null;
        sess.pllBaseRate = 1;
        sess.mashupPhases = null;
        sess.pendingMomentIdx = null;
        sess.pendingTransitionQuantize = false;
        sess.ytPumpDeck = null;
        sess.ytPumpMode = null;
        sess.ytPumpUntilMs = 0;
        if (sess.ytPumpBridgeActive) {
          sess.ytPumpBridgeActive = false;
          if (autopilotRef.current.grooveBridgePattern === 'off') {
            djEngine.stopGrooveBridge();
          }
        }
        sess.vipFakeoutDeck = null;
        sess.vipFakeoutUntilMs = 0;
        sess.vipFakeoutStage = 0;
        if (sess.teaseActive) {
          sess.teaseActive = false;
          handleTogglePlay(inId, false);
        }
        sess.teaseStartMs = 0;
        sess.teaseUntilMs = 0;
        sess.lowEnergySinceMs = 0;
        sess.widthSlamUntilMs = 0;
        sess.tapeBrakeFired = false;
        sess.lastScratchAtMs = 0;
        djEngine.setDeckStereoWidth('A', 1);
        djEngine.setDeckStereoWidth('B', 1);
        if (sess.rescueLoopActive && !sess.outroSafetyLoopActive) {
          sess.rescueLoopActive = false;
          handleExitLoop(outId);
        }
        if (sess.carryoverDeck) {
          const prevCarry = sess.carryoverDeck;
          sess.carryoverDeck = null;
          sess.carryoverUntilMs = 0;
          djEngine.setDeckSidechainDuck(prevCarry, 1);
          if (prevCarry !== outId) {
            setDeckState(prevCarry, (p) => ({
              ...p,
              stemMode: 'off',
              eqLow: 0,
              eqMid: 0,
              eqHigh: 0,
              filter: 0,
              fx: { ...p.fx, enabled: false },
            }));
          }
        }

        const effBpm = Math.max(80, outDeck.baseBpm * outDeck.playbackRate);
        const bars = sess.plan.transitionBars || 8;
        const beatSec = 60 / effBpm;
        sess.transitionDurationMs = Math.max(8000, Math.min(24000, bars * 4 * beatSec * 1000));
        sess.transitionStartMs = performance.now();
        sess.firedSoundIndices.clear();
        sess.firedVoiceIndices.clear();
        sess.loopStartedIndices.clear();
        sess.loopEndedIndices.clear();
        sess.lastCueStepIdx = -1;
        sess.lastCueSeekAtMs = 0;
        sess.staircaseStage = 0;

        // Flip phase synchronously before async play calls so 25fps loop never re-enters
        setAutopilotState((prev) => ({
          ...prev,
          phase: 'transitioning',
          transitionProgress: 0,
          nextTransitionEtaSec: null,
          holdExtraBars: 0,
          mashupRoutineActive: false,
          currentActionLabel: sess.plan ? sess.plan.aiNotes : prev.currentActionLabel,
        }));

        // Upgrade #2: Apply Semitone Snap pitch shift independently of BPM via Pitch Worklet
        const snapSt = sess.plan.semitoneShiftIn || 0;
        if (inDeck.playbackMode === 'webaudio') {
          djEngine.setDeckKeyLock(inId, true);
          djEngine.setDeckSemitoneShift(inId, snapSt);
        }

        setDeckState(inId, (prev) => ({
          ...prev,
          eqLow: -0.78,
          eqMid: -0.15,
          eqHigh: -0.1,
          killLow: false,
          killMid: false,
          killHigh: false,
          stemMode: 'off',
          semitoneShift: snapSt,
          channelVolume: 0.9,
          filter: 0,
        }));
        setDeckState(outId, (prev) => ({
          ...prev,
          channelVolume: 0.9,
        }));
        setMixerState((m) => ({ ...m, crossfader: outId === 'A' ? -1 : 1 }));

        // Upgrade #1: Bar-1 / Beat-1 Phase-Locked Incoming Cue Calculation
        const fold = sess.plan.tempoFoldFactor || 1;
        const inBeatSec = 60 / Math.max(60, inDeck.baseBpm * fold);
        const inBarSec = inBeatSec * 4;
        const inFirst = inDeck.track.firstBeatSec || 0;
        const outFirst = outDeck.track?.firstBeatSec || 0;
        const outBarSec = (60 / Math.max(60, outDeck.baseBpm)) * 4;
        const outLive = getLiveTime(outId);
        const outBarPhase =
          (((outLive - outFirst) % outBarSec) + outBarSec) % outBarSec / outBarSec;

        const customDrop = inDeck.track.dropCueSec;
        const doubleDropCue = sess.plan.doubleDropCueSec;
        let baseCueSec = 0;
        if (
          typeof doubleDropCue === 'number' &&
          doubleDropCue > 0.5 &&
          doubleDropCue < Math.max(12, inDeck.duration - 6)
        ) {
          baseCueSec = doubleDropCue;
        } else if (
          typeof customDrop === 'number' &&
          customDrop > 4 &&
          customDrop < Math.max(12, inDeck.duration - 4)
        ) {
          const leadInBars = Math.max(1, Math.min(4, Math.round(bars / 2)));
          baseCueSec = Math.max(0, customDrop - leadInBars * inBarSec);
        } else if (sess.plan.incomingStartPct > 0.02 && inDeck.duration > 20) {
          const rawOffset = inDeck.duration * sess.plan.incomingStartPct;
          const quantizedBars = Math.round(rawOffset / inBarSec);
          baseCueSec = Math.min(inDeck.duration * 0.35, quantizedBars * inBarSec);
        }

        // Snap baseCueSec to Bar 1 + exact fractional phase of outgoing bar so Beat 1s align!
        const nearestBarIdx = Math.max(0, Math.round((baseCueSec - inFirst) / inBarSec));
        const phaseAlignedCue = Math.max(
          0,
          Math.min(
            Math.max(4, inDeck.duration - 6),
            inFirst + nearestBarIdx * inBarSec + outBarPhase * inBarSec
          )
        );
        if (phaseAlignedCue > 0.05) {
          handleSeek(inId, phaseAlignedCue);
        }

        if (!getDeckRef(inId).isPlaying) {
          await handleTogglePlay(inId, true);
        }
        if (myPlanSeq !== aiSessionRef.current.planSeq || !autopilotRef.current.enabled) {
          return;
        }
        handleSync(inId);
        sess.transitionStartMs = performance.now();
      } finally {
        sess.isStartingTransition = false;
      }
    },
    [
      getLiveTime,
      handleExitLoop,
      handleSeek,
      handleSync,
      handleTogglePlay,
      requestNextAiPlan,
      setAutopilotState,
      setDeckState,
      setMixerState,
      stopCarryoverIfActive,
    ]
  );

  const stopAiSessionCleanly = useCallback(() => {
    const wasActiveTrick =
      autopilotRef.current.phase === 'transitioning' ||
      Boolean(aiSessionRef.current.midRemixTimeoutId) ||
      aiSessionRef.current.cruisingChopUntilMs > 0;
    aiSessionRef.current.planSeq++;
    aiSessionRef.current.isStartingTransition = false;
    aiSessionRef.current.plan = null;
    aiSessionRef.current.cruisingChopPattern = 'off';
    aiSessionRef.current.cruisingChopUntilMs = 0;
    aiSessionRef.current.cruisingCueSeq = null;
    aiSessionRef.current.cruisingCueUntilMs = 0;
    aiSessionRef.current.staircaseStage = 0;
    aiSessionRef.current.pllNudgeUntilMs = 0;
    aiSessionRef.current.pllNudgedDeck = null;
    aiSessionRef.current.pendingMomentIdx = null;
    aiSessionRef.current.pendingTransitionQuantize = false;
    aiSessionRef.current.ytPumpDeck = null;
    aiSessionRef.current.ytPumpMode = null;
    aiSessionRef.current.ytPumpUntilMs = 0;
    aiSessionRef.current.ytPumpBridgeActive = false;
    aiSessionRef.current.vipFakeoutDeck = null;
    aiSessionRef.current.vipFakeoutUntilMs = 0;
    aiSessionRef.current.vipFakeoutStage = 0;
    aiSessionRef.current.lowEnergySinceMs = 0;
    aiSessionRef.current.rescueLoopActive = false;
    aiSessionRef.current.outroSafetyLoopActive = false;
    aiSessionRef.current.lastScratchAtMs = 0;
    aiSessionRef.current.lastMashupDoubleDropFired = false;
    aiSessionRef.current.vipSkipFired = false;
    aiSessionRef.current.teaseFired = false;
    aiSessionRef.current.teaseActive = false;
    aiSessionRef.current.teaseStartMs = 0;
    aiSessionRef.current.teaseUntilMs = 0;
    aiSessionRef.current.widthSlamUntilMs = 0;
    aiSessionRef.current.tapeBrakeFired = false;
    aiSessionRef.current.setTensionScore = 45;
    aiSessionRef.current.peakMixStreak = 0;
    djEngine.clearDeckCHook();
    djEngine.setDeckStereoWidth('A', 1);
    djEngine.setDeckStereoWidth('B', 1);
    djEngine.setDeckSidechainDuck('A', 1);
    djEngine.setDeckSidechainDuck('B', 1);
    djEngine.setDeckSemitoneShift('A', 0);
    djEngine.setDeckSemitoneShift('B', 0);
    if (aiSessionRef.current.carryoverDeck) {
      const cDeck = aiSessionRef.current.carryoverDeck;
      aiSessionRef.current.carryoverDeck = null;
      aiSessionRef.current.carryoverUntilMs = 0;
      handleTogglePlay(cDeck, false);
    }
    if (aiSessionRef.current.aiAutoBridgeActive) {
      aiSessionRef.current.aiAutoBridgeActive = false;
      djEngine.stopGrooveBridge();
    }
    if (aiSessionRef.current.midRemixTimeoutId) {
      clearTimeout(aiSessionRef.current.midRemixTimeoutId);
      aiSessionRef.current.midRemixTimeoutId = null;
    }
    handleExitLoop('A');
    handleExitLoop('B');
    if (wasActiveTrick) {
      for (const id of ['A', 'B'] as DeckId[]) {
        setDeckState(id, (p) => ({
          ...p,
          channelVolume: 0.9,
          eqLow: 0,
          eqMid: 0,
          eqHigh: 0,
          killLow: false,
          killMid: false,
          killHigh: false,
          filter: 0,
          playbackRate: 1,
          semitoneShift: 0,
          stemMode: 'off',
          fx: { ...p.fx, enabled: false },
        }));
        if (getDeckRef(id).playbackMode === 'webaudio') {
          djEngine.setDeckRate(id, 1);
        } else if (getDeckRef(id).playbackMode === 'youtube-iframe') {
          ytPlayersRef.current[id]?.setPlaybackRate(1);
        }
      }
    }
    setAutopilotState((prev) => ({
      ...prev,
      enabled: false,
      phase: 'idle',
      activePlan: null,
      mutedMomentIndices: [],
      transitionProgress: 0,
      nextTransitionEtaSec: null,
      holdExtraBars: 0,
      currentActionLabel: '',
      errorMessage: null,
    }));
  }, [handleExitLoop, handleTogglePlay, setAutopilotState, setDeckState]);

  const startPlaylistAutoDj = useCallback(
    async (
      playlistId: string,
      remixOverride?: boolean,
      options?: {
        forceStart?: boolean;
        vibeOverride?: AiDjVibe;
        trackIdsOverride?: string[];
        aggressivenessOverride?: number;
      }
    ) => {
      const plObj = libraryRef.current.playlists.find((p) => p.id === playlistId);
      const nextRemixMode =
        remixOverride !== undefined
          ? remixOverride
          : plObj?.remixMode ?? autopilotRef.current.remixMode;
      const nextVibe =
        options?.vibeOverride ?? plObj?.preferredVibe ?? autopilotRef.current.vibe;
      const nextAggressiveness =
        options?.aggressivenessOverride ?? plObj?.aggressiveness ?? autopilotRef.current.aggressiveness;
      const freshSessionSeed =
        (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;

      if (
        !options?.forceStart &&
        autopilotRef.current.enabled &&
        autopilotRef.current.targetPlaylistId === playlistId &&
        autopilotRef.current.remixMode === nextRemixMode
      ) {
        stopAiSessionCleanly();
        return;
      }

      const plTracks = getPlaylistTracks(playlistId, options?.trackIdsOverride);
      libraryRef.current.setActivePlaylistId(playlistId);

      if (plTracks.length === 0) {
        setIsCrateOpen(true);
        setAutopilotState((prev) => ({
          ...prev,
          enabled: false,
          targetPlaylistId: playlistId,
          phase: 'error',
          errorMessage: 'No YouTube tracks in this playlist yet. Open Playlists & Songs to add tracks.',
        }));
        return;
      }

      const myStartSeq = ++aiSessionRef.current.planSeq;
      aiSessionRef.current.isStartingTransition = false;
      aiSessionRef.current.playedTrackIds.clear();
      aiSessionRef.current.plan = null;
      aiSessionRef.current.firedMomentIndices.clear();
      if (aiSessionRef.current.midRemixTimeoutId) {
        clearTimeout(aiSessionRef.current.midRemixTimeoutId);
        aiSessionRef.current.midRemixTimeoutId = null;
      }

      // Engage active planning UI immediately so rapid double-clicks & loading states are clear
      setAutopilotState((prev) => ({
        ...prev,
        enabled: true,
        remixMode: nextRemixMode,
        vibe: nextVibe,
        aggressiveness: nextAggressiveness,
        sessionSeed: freshSessionSeed,
        targetPlaylistId: playlistId,
        phase: 'planning',
        errorMessage: null,
        transitionProgress: 0,
        currentActionLabel: `Starting Offline AI on "${plTracks[0].title}"...`,
      }));

      await djEngine.resume();
      if (myStartSeq !== aiSessionRef.current.planSeq || !autopilotRef.current.enabled) {
        return;
      }

      const plTrackIds = new Set(plTracks.map((t) => t.id));
      const aPlayingInPl =
        deckARef.current.isPlaying &&
        deckARef.current.playbackMode !== 'none' &&
        deckARef.current.track &&
        plTrackIds.has(deckARef.current.track.id);
      const bPlayingInPl =
        deckBRef.current.isPlaying &&
        deckBRef.current.playbackMode !== 'none' &&
        deckBRef.current.track &&
        plTrackIds.has(deckBRef.current.track.id);

      let leadDeck: DeckId = 'A';
      if (bPlayingInPl && !aPlayingInPl) {
        await handleTogglePlay('A', false);
        handleExitLoop('B');
        leadDeck = 'B';
        if (deckBRef.current.track) {
          aiSessionRef.current.playedTrackIds.add(deckBRef.current.track.id);
        }
      } else if (aPlayingInPl) {
        await handleTogglePlay('B', false);
        handleExitLoop('A');
        leadDeck = 'A';
        if (deckARef.current.track) {
          aiSessionRef.current.playedTrackIds.add(deckARef.current.track.id);
        }
      } else {
        await handleTogglePlay('B', false);
        await handleTogglePlay('A', false);
        handleExitLoop('A');
        handleExitLoop('B');
        if (myStartSeq !== aiSessionRef.current.planSeq || !autopilotRef.current.enabled) {
          return;
        }

        // Try playlist tracks cleanly in order until an opening track loads & plays
        let startedTrack: TrackItem | null = null;
        let lastErr = '';
        for (const candidate of plTracks) {
          if (myStartSeq !== aiSessionRef.current.planSeq || !autopilotRef.current.enabled) {
            return;
          }
          const needLoad =
            deckARef.current.track?.id !== candidate.id ||
            deckARef.current.playbackMode === 'none' ||
            deckARef.current.isLoading ||
            Boolean(deckARef.current.loadError);
          if (needLoad) {
            setAutopilotState((prev) => ({
              ...prev,
              currentActionLabel: `Loading "${candidate.title}" onto Deck A...`,
            }));
            await loadTrackToDeck('A', candidate);
          } else {
            const curA = getLiveTime('A');
            if (deckARef.current.duration > 10 && curA >= deckARef.current.duration - 10) {
              handleSeek('A', 0);
            }
          }

          if (myStartSeq !== aiSessionRef.current.planSeq || !autopilotRef.current.enabled) {
            return;
          }

          const loadedA = getDeckRef('A');
          if (loadedA.track && loadedA.playbackMode !== 'none' && !loadedA.loadError) {
            startedTrack = candidate;
            break;
          }
          lastErr = loadedA.loadError || `Unable to load "${candidate.title}".`;
        }

        if (!startedTrack) {
          setAutopilotState((prev) => ({
            ...prev,
            enabled: false,
            targetPlaylistId: playlistId,
            phase: 'error',
            errorMessage: lastErr || 'Unable to load tracks in this playlist.',
            currentActionLabel: '',
          }));
          return;
        }

        leadDeck = 'A';
        setMixerState((m) => ({ ...m, crossfader: -1 }));
        setDeckState('A', (p) => ({
          ...p,
          channelVolume: 0.9,
          eqLow: 0,
          eqMid: 0,
          eqHigh: 0,
          killLow: false,
          killMid: false,
          killHigh: false,
          filter: 0,
          playbackRate: 1,
        }));
        if (getDeckRef('A').playbackMode === 'webaudio') {
          djEngine.setDeckRate('A', 1);
        }

        await handleTogglePlay('A', true);
        if (myStartSeq !== aiSessionRef.current.planSeq || !autopilotRef.current.enabled) {
          return;
        }
        aiSessionRef.current.playedTrackIds.add(startedTrack.id);
      }

      const standbyDeck: DeckId = leadDeck === 'A' ? 'B' : 'A';
      setMixerState((m) => ({ ...m, crossfader: leadDeck === 'A' ? -1 : 1 }));
      setDeckState(leadDeck, (p) => ({
        ...p,
        isMaster: true,
        channelVolume: Math.max(0.85, p.channelVolume),
        eqLow: 0,
        eqMid: 0,
        eqHigh: 0,
        killLow: false,
        killMid: false,
        killHigh: false,
        filter: 0,
        playbackRate: 1,
      }));
      setDeckState(standbyDeck, (p) => ({ ...p, isMaster: false }));

      // Ensure mixer gains & YouTube volume apply immediately without waiting on render cycle
      const mNow = mixerRef.current;
      djEngine.updateMixVolumes({
        volA: deckARef.current.channelVolume,
        volB: deckBRef.current.channelVolume,
        crossfader: mNow.crossfader,
        curve: mNow.crossfaderCurve,
        reverse: mNow.crossfaderReverse,
        masterGain: mNow.masterGain,
      });
      if (getDeckRef(leadDeck).playbackMode === 'youtube-iframe') {
        ytPlayersRef.current[leadDeck]?.setVolume(
          getDeckRef(leadDeck).channelVolume * mNow.masterGain * 100
        );
      }

      await requestNextAiPlan(
        leadDeck,
        nextVibe,
        undefined,
        playlistId,
        nextRemixMode,
        options?.trackIdsOverride,
        nextAggressiveness,
        freshSessionSeed
      );
    },
    [
      getLiveTime,
      getPlaylistTracks,
      handleExitLoop,
      handleSeek,
      handleTogglePlay,
      loadTrackToDeck,
      requestNextAiPlan,
      setAutopilotState,
      setDeckState,
      setMixerState,
      stopAiSessionCleanly,
    ]
  );

  const handleToggleAutopilot = useCallback(async () => {
    if (autopilotRef.current.enabled) {
      stopAiSessionCleanly();
      return;
    }

    await startPlaylistAutoDj(autopilotRef.current.targetPlaylistId, autopilotRef.current.remixMode, {
      forceStart: true,
    });
  }, [startPlaylistAutoDj, stopAiSessionCleanly]);

  const handleToggleRemixMode = useCallback(async () => {
    const nextRemix = !autopilotRef.current.remixMode;
    setAutopilotState((prev) => ({ ...prev, remixMode: nextRemix }));
    if (autopilotRef.current.enabled) {
      await startPlaylistAutoDj(autopilotRef.current.targetPlaylistId, nextRemix, {
        forceStart: true,
      });
    }
  }, [setAutopilotState, startPlaylistAutoDj]);

  const handleToggleQuickMix = useCallback(() => {
    setAutopilotState((prev) => ({ ...prev, quickMix: !prev.quickMix }));
  }, [setAutopilotState]);

  const handleEnergyModeChange = useCallback(
    (energyMode: AiEnergyMode) => {
      setAutopilotState((prev) => ({ ...prev, energyMode }));
    },
    [setAutopilotState]
  );

  const handleAggressivenessChange = useCallback(
    (aggressiveness: number) => {
      const clamped = Math.max(0, Math.min(100, Math.round(aggressiveness)));
      setAutopilotState((prev) => ({ ...prev, aggressiveness: clamped }));
      if (autopilotRef.current.enabled && autopilotRef.current.phase === 'cruising') {
        stopCarryoverIfActive();
        requestNextAiPlan(
          aiSessionRef.current.outgoingDeck,
          autopilotRef.current.vibe,
          undefined,
          autopilotRef.current.targetPlaylistId,
          autopilotRef.current.remixMode,
          undefined,
          clamped
        );
      }
    },
    [requestNextAiPlan, setAutopilotState, stopCarryoverIfActive]
  );

  const handleRandomnessChange = useCallback(
    (randomness: number) => {
      const clamped = Math.max(0, Math.min(100, Math.round(randomness)));
      setAutopilotState((prev) => ({ ...prev, randomness: clamped }));
      if (autopilotRef.current.enabled && autopilotRef.current.phase === 'cruising') {
        stopCarryoverIfActive();
        requestNextAiPlan(
          aiSessionRef.current.outgoingDeck,
          autopilotRef.current.vibe,
          undefined,
          autopilotRef.current.targetPlaylistId,
          autopilotRef.current.remixMode,
          undefined,
          autopilotRef.current.aggressiveness,
          autopilotRef.current.sessionSeed,
          clamped
        );
      }
    },
    [requestNextAiPlan, setAutopilotState, stopCarryoverIfActive]
  );

  const handleRegenerateTake = useCallback(() => {
    const newSeed = (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
    setAutopilotState((prev) => ({ ...prev, sessionSeed: newSeed }));
    if (autopilotRef.current.enabled && autopilotRef.current.phase === 'cruising') {
      stopCarryoverIfActive();
      requestNextAiPlan(
        aiSessionRef.current.outgoingDeck,
        autopilotRef.current.vibe,
        undefined,
        autopilotRef.current.targetPlaylistId,
        autopilotRef.current.remixMode,
        undefined,
        autopilotRef.current.aggressiveness,
        newSeed,
        autopilotRef.current.randomness
      );
    }
  }, [requestNextAiPlan, setAutopilotState, stopCarryoverIfActive]);

  const handleTriggerWildTake = useCallback(async () => {
    await djEngine.resume();
    const targetId: DeckId =
      autopilotRef.current.enabled && aiSessionRef.current.outgoingDeck
        ? aiSessionRef.current.outgoingDeck
        : deckBRef.current.isPlaying && !deckARef.current.isPlaying
        ? 'B'
        : deckARef.current.isPlaying
        ? 'A'
        : mixerRef.current.crossfader > 0.2 && deckBRef.current.track
        ? 'B'
        : 'A';

    const targetDeck = getDeckRef(targetId);
    if (!targetDeck.track) return;
    if (!targetDeck.isPlaying) {
      await handleTogglePlay(targetId, true);
    }

    await ensureCustomBuffersLoaded();
    const entropySeed = (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
    const moment = generateOfflineWildTake({
      aggressiveness: autopilotRef.current.aggressiveness,
      randomness: autopilotRef.current.randomness,
      seed: entropySeed,
      voiceFxEnabled: autopilotRef.current.voiceFxEnabled,
      enabledVoiceIds: autopilotRef.current.enabledVoiceIds,
      enabledCustomDrops: customVoiceDropsRef.current,
    });

    if (aiSessionRef.current.midRemixTimeoutId) {
      clearTimeout(aiSessionRef.current.midRemixTimeoutId);
      aiSessionRef.current.midRemixTimeoutId = null;
    }

    if (autopilotRef.current.enabled) {
      recordAiFeedbackEvent({
        outcome: 'wild_take_override',
        outTrackId: targetDeck.track.id,
        aggressiveness: autopilotRef.current.aggressiveness,
      });
    }

    const bpm = Math.max(80, targetDeck.baseBpm * targetDeck.playbackRate);
    const activePitch = targetDeck.playbackMode === 'webaudio' ? targetDeck.playbackRate : 1;
    if (moment.soundTrick) {
      djEngine.playSoundTrick(moment.soundTrick, bpm, targetDeck.track.musicalKey, activePitch);
    }
    if (
      moment.voiceDropId &&
      autopilotRef.current.voiceFxEnabled &&
      isAnyVoiceEnabled(moment.voiceDropId)
    ) {
      void playAnyVoiceDrop(moment.voiceDropId, bpm, targetDeck.track.musicalKey, activePitch);
    }
    if (moment.deckCHookPattern && djEngine.hasDeckCHook() && !autopilotRef.current.muteSoundTricks) {
      djEngine.triggerDeckCHook({ pattern: moment.deckCHookPattern, targetBpm: bpm });
    }
    if (moment.loopBars) {
      handleToggleLoop(targetId, moment.loopBars);
    }
    if (moment.pitchBurst && targetDeck.playbackMode === 'webaudio') {
      djEngine.setDeckRate(targetId, moment.pitchBurst);
    }
    if (moment.beatSlicePattern && targetDeck.playbackMode === 'webaudio') {
      djEngine.triggerDeckBeatSlices(targetId, {
        currentSec: getLiveTime(targetId),
        bpm,
        dropCueSec: targetDeck.track.dropCueSec ?? targetDeck.detectedDropSec,
        pattern: moment.beatSlicePattern,
        sliceBeats: 0.5,
      });
    }

    if (targetDeck.playbackMode === 'youtube-iframe' && moment.youtubePumpMode) {
      const now = performance.now();
      aiSessionRef.current.ytPumpDeck = targetId;
      aiSessionRef.current.ytPumpMode = moment.youtubePumpMode;
      aiSessionRef.current.ytPumpStartMs = now;
      aiSessionRef.current.ytPumpUntilMs = now + moment.durationMs;
      aiSessionRef.current.ytPumpDropSlammed = false;
      if (
        moment.youtubePumpMode === 'drop-takeover' &&
        !autopilotRef.current.muteSoundTricks &&
        autopilotRef.current.grooveBridgePattern === 'off'
      ) {
        aiSessionRef.current.ytPumpBridgeActive = true;
        djEngine.startGrooveBridge('house-4x4', bpm, targetDeck.track.musicalKey || '8A', 1);
      }
    }

    const activeXf = targetId === 'A' ? -1 : 1;
    if (moment.chopPattern && moment.chopPattern !== 'off') {
      aiSessionRef.current.cruisingChopPattern = moment.chopPattern;
      aiSessionRef.current.cruisingChopUntilMs = performance.now() + moment.durationMs;
      setMixerState((m) => ({ ...m, crossfader: activeXf }));
    }

    setDeckState(targetId, (prev) => ({
      ...prev,
      filter: moment.filter,
      eqLow: moment.eqLow ?? prev.eqLow,
      eqMid: moment.eqMid ?? prev.eqMid,
      eqHigh: moment.eqHigh ?? prev.eqHigh,
      playbackRate: moment.pitchBurst ?? prev.playbackRate,
      fx: {
        ...prev.fx,
        enabled: true,
        type: moment.fxType,
        wet: moment.fxWet,
        beatDiv: moment.beatDiv,
      },
    }));

    setAutopilotState((prev) => ({
      ...prev,
      sessionSeed: entropySeed,
      currentActionLabel: `Wild Take on Deck ${targetId} · ${moment.label.replace('Take · ', '')}`,
    }));

    aiSessionRef.current.midRemixTimeoutId = setTimeout(() => {
      aiSessionRef.current.midRemixTimeoutId = null;
      aiSessionRef.current.cruisingChopPattern = 'off';
      aiSessionRef.current.cruisingChopUntilMs = 0;
      if (aiSessionRef.current.ytPumpDeck === targetId) {
        aiSessionRef.current.ytPumpDeck = null;
        aiSessionRef.current.ytPumpMode = null;
        aiSessionRef.current.ytPumpUntilMs = 0;
        aiSessionRef.current.ytPumpDropSlammed = false;
      }
      if (aiSessionRef.current.ytPumpBridgeActive) {
        aiSessionRef.current.ytPumpBridgeActive = false;
        if (autopilotRef.current.grooveBridgePattern === 'off' && !aiSessionRef.current.aiAutoBridgeActive) {
          djEngine.stopGrooveBridge();
        }
      }
      const td = getDeckRef(targetId);
      if (td.playbackMode === 'youtube-iframe') {
        const { gainA, gainB } = djEngine.computeCrossfaderGains(
          mixerRef.current.crossfader,
          mixerRef.current.crossfaderCurve,
          mixerRef.current.crossfaderReverse
        );
        const baseGain = targetId === 'A' ? gainA : gainB;
        ytPlayersRef.current[targetId]?.setVolume(
          td.channelVolume * baseGain * mixerRef.current.masterGain * 100
        );
      }
      handleExitLoop(targetId);
      if (td.playbackMode === 'webaudio') {
        djEngine.setDeckRate(targetId, 1);
      }
      setMixerState((m) => ({ ...m, crossfader: targetId === 'A' ? -1 : 1 }));
      setDeckState(targetId, (prev) => ({
        ...prev,
        channelVolume: 0.9,
        eqLow: 0,
        eqMid: 0,
        eqHigh: 0,
        filter: 0,
        playbackRate: 1,
        fx: { ...prev.fx, enabled: false },
      }));
    }, moment.durationMs);
  }, [getLiveTime, handleExitLoop, handleToggleLoop, handleTogglePlay, setAutopilotState, setDeckState, setMixerState]);

  const handleTargetPlaylistChange = useCallback(
    async (playlistId: string) => {
      if (autopilotRef.current.enabled) {
        await startPlaylistAutoDj(playlistId, undefined, { forceStart: true });
      } else {
        const plObj = libraryRef.current.playlists.find((p) => p.id === playlistId);
        setAutopilotState((prev) => ({
          ...prev,
          targetPlaylistId: playlistId,
          remixMode: plObj?.remixMode ?? prev.remixMode,
          vibe: plObj?.preferredVibe ?? prev.vibe,
          aggressiveness: plObj?.aggressiveness ?? prev.aggressiveness,
          errorMessage: null,
        }));
      }
    },
    [setAutopilotState, startPlaylistAutoDj]
  );

  const handleSavePlaylistFromBuilder = useCallback(
    async (payload: {
      id?: string;
      name: string;
      trackIds: string[];
      preferredVibe: AiDjVibe;
      remixMode: boolean;
      aggressiveness: number;
      launchAutoDj: boolean;
    }) => {
      let targetId = payload.id;
      if (targetId) {
        library.updatePlaylist(targetId, {
          name: payload.name,
          trackIds: payload.trackIds,
          preferredVibe: payload.preferredVibe,
          remixMode: payload.remixMode,
          aggressiveness: payload.aggressiveness,
        });
      } else {
        targetId = library.createPlaylist(payload.name, payload.trackIds, {
          preferredVibe: payload.preferredVibe,
          remixMode: payload.remixMode,
          aggressiveness: payload.aggressiveness,
        });
      }

      library.setActivePlaylistId(targetId);

      if (payload.launchAutoDj) {
        await startPlaylistAutoDj(targetId, payload.remixMode, {
          forceStart: true,
          vibeOverride: payload.preferredVibe,
          trackIdsOverride: payload.trackIds,
          aggressivenessOverride: payload.aggressiveness,
        });
      }
    },
    [library, startPlaylistAutoDj]
  );

  const handleExportCarloPlaylist = useCallback(
    (playlistId: string) => {
      const carlo = libraryRef.current.exportPlaylistToCarlo(playlistId);
      if (carlo) {
        downloadCarloPlaylistFile(carlo);
      }
    },
    []
  );

  const handleImportCarloFile = useCallback(async (file: File) => {
    const raw = await file.text();
    const parsed = parseCarloPlaylistText(raw);
    const result = libraryRef.current.importCarloPlaylist(parsed);
    if (!autopilotRef.current.enabled) {
      setAutopilotState((prev) => ({
        ...prev,
        targetPlaylistId: result.playlistId,
        vibe: parsed.playlist.preferredVibe ?? prev.vibe,
        remixMode: parsed.playlist.remixMode ?? prev.remixMode,
        aggressiveness: parsed.playlist.aggressiveness ?? prev.aggressiveness,
        errorMessage: null,
      }));
    }
    return result;
  }, [setAutopilotState]);

  const handleDirectAi = useCallback(
    async (direction: string) => {
      await djEngine.resume();
      setAutopilotState((prev) => ({ ...prev, lastDirection: direction }));

      const aPlaying = deckARef.current.isPlaying;
      const bPlaying = deckBRef.current.isPlaying;
      const leadDeck: DeckId =
        autopilotRef.current.enabled && aiSessionRef.current.outgoingDeck
          ? aiSessionRef.current.outgoingDeck
          : bPlaying && !aPlaying
          ? 'B'
          : 'A';

      if (!getDeckRef(leadDeck).isPlaying) {
        const plTracks = getPlaylistTracks(autopilotRef.current.targetPlaylistId);
        if (!getDeckRef(leadDeck).track || getDeckRef(leadDeck).playbackMode === 'none') {
          const fallbackTrack = plTracks[0] || libraryRef.current.tracks[0];
          if (fallbackTrack) await loadTrackToDeck(leadDeck, fallbackTrack);
        }
        await handleTogglePlay(leadDeck, true);
      }

      if (!autopilotRef.current.enabled) {
        setMixerState((m) => ({ ...m, crossfader: leadDeck === 'A' ? -1 : 1 }));
        setAutopilotState((prev) => ({ ...prev, enabled: true, errorMessage: null }));
      }

      await requestNextAiPlan(leadDeck, autopilotRef.current.vibe, direction);
      if (aiSessionRef.current.plan) {
        await beginAiTransitionNow();
      }
    },
    [
      beginAiTransitionNow,
      getPlaylistTracks,
      handleTogglePlay,
      loadTrackToDeck,
      requestNextAiPlan,
      setAutopilotState,
      setMixerState,
    ]
  );

  const handleHoldExtraBars = useCallback(() => {
    setAutopilotState((prev) => {
      const nextHold = Math.min(32, prev.holdExtraBars + 8);
      return {
        ...prev,
        holdExtraBars: nextHold,
        currentActionLabel: `Holding track +${nextHold} bars · delaying mix cutover`,
      };
    });
  }, [setAutopilotState]);

  const handleSwapUpcomingStyle = useCallback(() => {
    const state = autopilotRef.current;
    const sess = aiSessionRef.current;
    if (!state.enabled || state.phase !== 'cruising') return;
    stopCarryoverIfActive();
    const outDeck = getDeckRef(sess.outgoingDeck);
    const inDeck = getDeckRef(sess.incomingDeck);
    recordAiFeedbackEvent({
      outcome: 'skipped_mix_now',
      outTrackId: outDeck.track?.id,
      inTrackId: inDeck.track?.id,
      mixStyleKey: sess.plan?.mixStyleKey,
      aggressiveness: state.aggressiveness,
    });
    const newSeed = (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
    setAutopilotState((prev) => ({
      ...prev,
      sessionSeed: newSeed,
      currentActionLabel: 'Re-rolling upcoming transition recipe & pairing...',
    }));
    requestNextAiPlan(
      sess.outgoingDeck,
      state.vibe,
      undefined,
      state.targetPlaylistId,
      state.remixMode,
      undefined,
      state.aggressiveness,
      newSeed,
      Math.min(100, state.randomness + 15)
    );
  }, [requestNextAiPlan, setAutopilotState, stopCarryoverIfActive]);

  const handleToggleMuteSfx = useCallback(() => {
    setAutopilotState((prev) => ({
      ...prev,
      muteSoundTricks: !prev.muteSoundTricks,
      currentActionLabel: !prev.muteSoundTricks
        ? 'AI Sound Tricks muted (pure track mix)'
        : 'AI Sound Tricks enabled',
    }));
  }, [setAutopilotState]);

  const handleToggleVoiceFx = useCallback(() => {
    setAutopilotState((prev) => {
      const nextEnabled = !prev.voiceFxEnabled;
      saveVoicePackSettings({
        voiceFxEnabled: nextEnabled,
        enabledVoiceIds: prev.enabledVoiceIds,
      });
      return {
        ...prev,
        voiceFxEnabled: nextEnabled,
        currentActionLabel: nextEnabled
          ? `DJ Voices & Shouts enabled (${prev.enabledVoiceIds.length}/${ALL_VOICE_IDS.length} active)`
          : 'AI DJ Voices muted during remixes',
      };
    });
  }, [setAutopilotState]);

  const handleToggleVoiceItem = useCallback(
    (voiceId: DjVoiceDropId) => {
      setAutopilotState((prev) => {
        const exists = prev.enabledVoiceIds.includes(voiceId);
        const nextIds = exists
          ? prev.enabledVoiceIds.filter((id) => id !== voiceId)
          : [...prev.enabledVoiceIds, voiceId];
        saveVoicePackSettings({
          voiceFxEnabled: prev.voiceFxEnabled,
          enabledVoiceIds: nextIds,
        });
        const meta = VOICE_PRESET_MAP[voiceId];
        return {
          ...prev,
          enabledVoiceIds: nextIds,
          currentActionLabel: `${meta.label} ${exists ? 'disabled' : 'enabled'} for AI remixes`,
        };
      });
    },
    [setAutopilotState]
  );

  const handleSetVoiceCategoryEnabled = useCallback(
    (category: DjVoiceCategory, enabled: boolean) => {
      setAutopilotState((prev) => {
        const catIds = DJ_VOICE_LIBRARY.filter((v) => v.category === category).map((v) => v.id);
        const set = new Set(prev.enabledVoiceIds);
        catIds.forEach((id) => {
          if (enabled) set.add(id);
          else set.delete(id);
        });
        const nextIds = ALL_VOICE_IDS.filter((id) => set.has(id));
        saveVoicePackSettings({
          voiceFxEnabled: prev.voiceFxEnabled,
          enabledVoiceIds: nextIds,
        });
        return {
          ...prev,
          enabledVoiceIds: nextIds,
          currentActionLabel: `${category.toUpperCase()} voices ${enabled ? 'enabled' : 'disabled'} (${nextIds.length}/${ALL_VOICE_IDS.length})`,
        };
      });
    },
    [setAutopilotState]
  );

  const handleEnableAllVoices = useCallback(
    (enableAll: boolean) => {
      setAutopilotState((prev) => {
        const nextIds = enableAll ? [...ALL_VOICE_IDS] : [];
        saveVoicePackSettings({
          voiceFxEnabled: prev.voiceFxEnabled,
          enabledVoiceIds: nextIds,
        });
        return {
          ...prev,
          enabledVoiceIds: nextIds,
          currentActionLabel: enableAll
            ? `All ${ALL_VOICE_IDS.length} DJ voices & shouts enabled`
            : 'All DJ voices disabled for AI remixes',
        };
      });
    },
    [setAutopilotState]
  );

  const handleTriggerCustomSlot = useCallback(
    async (slotId: CustomVoiceSlotId) => {
      await ensureCustomBuffersLoaded();
      const buf = customVoiceBuffersRef.current[slotId];
      if (!buf) return;
      const masterDeck = deckARef.current.isMaster ? deckARef.current : deckBRef.current;
      const activeDeck = masterDeck.track ? masterDeck : deckARef.current.track ? deckARef.current : deckBRef.current;
      const bpm = activeDeck.track ? activeDeck.baseBpm * activeDeck.playbackRate : 124;
      await djEngine.playCustomVoiceBuffer(buf, bpm);
      const slotMeta = customVoiceDropsRef.current.find((c) => c.id === slotId);
      setAutopilotState((prev) => ({
        ...prev,
        currentActionLabel: `Custom Drop · ${slotMeta?.label || slotId}`,
      }));
    },
    [ensureCustomBuffersLoaded, setAutopilotState]
  );

  const handleToggleRecordCustomSlot = useCallback(
    async (slotId: CustomVoiceSlotId) => {
      setMicError(null);
      if (micCaptureRef.current) {
        const activeCap = micCaptureRef.current;
        micCaptureRef.current = null;
        setRecordingSlotId(null);
        const buf = await activeCap.stop();
        if (buf && buf.duration >= 0.1) {
          customVoiceBuffersRef.current[activeCap.slotId] = buf;
          const dur = await saveCustomVoiceBufferToIdb(activeCap.slotId, buf);
          const idx = activeCap.slotId.slice(-1);
          setCustomVoiceDrops((prev) => {
            const next = prev.map((m) =>
              m.id === activeCap.slotId
                ? { ...m, label: `Mic ${idx}`, durationSec: dur, hasAudio: true, enabled: true }
                : m
            );
            saveCustomVoiceMetas(next);
            return next;
          });
          setAutopilotState((prev) => ({
            ...prev,
            currentActionLabel: `Saved Mic ${idx} (${dur.toFixed(1)}s) for live & AI remixes`,
          }));
        }
        if (activeCap.slotId === slotId) return;
      }

      try {
        const ctx = await djEngine.resume();
        setRecordingSlotId(slotId);
        const cap = await startMicDropCapture(ctx, 4.0, async (autoBuf) => {
          micCaptureRef.current = null;
          setRecordingSlotId(null);
          if (autoBuf && autoBuf.duration >= 0.1) {
            customVoiceBuffersRef.current[slotId] = autoBuf;
            const dur = await saveCustomVoiceBufferToIdb(slotId, autoBuf);
            const idx = slotId.slice(-1);
            setCustomVoiceDrops((prev) => {
              const next = prev.map((m) =>
                m.id === slotId
                  ? { ...m, label: `Mic ${idx}`, durationSec: dur, hasAudio: true, enabled: true }
                  : m
              );
              saveCustomVoiceMetas(next);
              return next;
            });
          }
        });
        micCaptureRef.current = { slotId, stop: cap.stop, cancel: cap.cancel };
      } catch (err: any) {
        setRecordingSlotId(null);
        setMicError(err?.message || 'Microphone access denied or unavailable.');
      }
    },
    [setAutopilotState]
  );

  const handleUploadCustomSlot = useCallback(
    async (slotId: CustomVoiceSlotId, file: File) => {
      setMicError(null);
      try {
        const arr = await file.arrayBuffer();
        const buf = await djEngine.decodeAudioData(arr);
        customVoiceBuffersRef.current[slotId] = buf;
        const dur = await saveCustomVoiceBufferToIdb(slotId, buf);
        const cleanName = file.name.replace(/\.[^/.]+$/, '').slice(0, 14) || `Drop ${slotId.slice(-1)}`;
        setCustomVoiceDrops((prev) => {
          const next = prev.map((m) =>
            m.id === slotId
              ? { ...m, label: cleanName, durationSec: dur, hasAudio: true, enabled: true }
              : m
          );
          saveCustomVoiceMetas(next);
          return next;
        });
        setAutopilotState((prev) => ({
          ...prev,
          currentActionLabel: `Loaded Drop "${cleanName}" (${dur.toFixed(1)}s)`,
        }));
      } catch {
        setMicError('Could not decode uploaded audio drop.');
      }
    },
    [setAutopilotState]
  );

  const handleToggleCustomSlotEnabled = useCallback((slotId: CustomVoiceSlotId) => {
    setCustomVoiceDrops((prev) => {
      const next = prev.map((m) => (m.id === slotId ? { ...m, enabled: !m.enabled } : m));
      saveCustomVoiceMetas(next);
      return next;
    });
  }, []);

  const handleClearCustomSlot = useCallback(async (slotId: CustomVoiceSlotId) => {
    delete customVoiceBuffersRef.current[slotId];
    await deleteCustomVoiceBufferFromIdb(slotId);
    const idx = slotId.slice(-1);
    setCustomVoiceDrops((prev) => {
      const next = prev.map((m) =>
        m.id === slotId
          ? { ...m, label: `My Drop ${idx}`, durationSec: 0, hasAudio: false, enabled: true }
          : m
      );
      saveCustomVoiceMetas(next);
      return next;
    });
  }, []);

  const handleCycleGrooveBridge = useCallback(async () => {
    const order: GrooveBridgePattern[] = [
      'off',
      'top-hats',
      'house-4x4',
      'sub-808',
      'afro-perc',
      'chord-arp',
    ];
    const cur = autopilotRef.current.grooveBridgePattern;
    const next = order[(order.indexOf(cur) + 1) % order.length];
    aiSessionRef.current.aiAutoBridgeActive = false;

    if (next === 'off') {
      djEngine.stopGrooveBridge();
      setAutopilotState((prev) => ({ ...prev, grooveBridgePattern: 'off' }));
      return;
    }

    const masterDeck = deckARef.current.isMaster ? deckARef.current : deckBRef.current;
    const activeDeck = masterDeck.track ? masterDeck : deckARef.current.track ? deckARef.current : deckBRef.current;
    const bpm = activeDeck.track ? activeDeck.baseBpm * activeDeck.playbackRate : 124;
    const key = activeDeck.track?.musicalKey || '8A';
    const pitchRate = activeDeck.playbackMode === 'webaudio' ? activeDeck.playbackRate : 1;
    await djEngine.startGrooveBridge(next, bpm, key, pitchRate);
    setAutopilotState((prev) => ({
      ...prev,
      grooveBridgePattern: next,
      currentActionLabel: `Groove Bridge: ${next.toUpperCase()} locked at ${bpm.toFixed(1)} BPM (${key})`,
    }));
  }, [setAutopilotState]);

  const handleAiMashupBlend = useCallback(async () => {
    if (autopilotRef.current.mashupRoutineActive) {
      aiSessionRef.current.mashupPhases = null;
      aiSessionRef.current.lastMashupLabel = '';
      setDeckState('A', (prev) => ({
        ...prev,
        eqLow: 0,
        eqMid: 0,
        eqHigh: 0,
        filter: 0,
        stemMode: 'off',
        fx: { ...prev.fx, enabled: false },
      }));
      setDeckState('B', (prev) => ({
        ...prev,
        eqLow: 0,
        eqMid: 0,
        eqHigh: 0,
        filter: 0,
        stemMode: 'off',
        fx: { ...prev.fx, enabled: false },
      }));
      setMixerState((m) => ({ ...m, crossfader: 0 }));
      setAutopilotState((prev) => ({
        ...prev,
        mashupRoutineActive: false,
        currentActionLabel: '16-Bar Blend A+B routine stopped',
      }));
      return;
    }

    const dA = deckARef.current;
    const dB = deckBRef.current;
    if (!dA.track || !dB.track) {
      setAutopilotState((prev) => ({
        ...prev,
        errorMessage: 'Load tracks on both Deck A & Deck B to blend.',
      }));
      return;
    }

    setMashupLoading(true);
    setAutopilotState((prev) => ({ ...prev, errorMessage: null }));

    try {
      await djEngine.resume();
      const advice = computeOfflineMashupBlend({
        deckA: {
          title: dA.track.title,
          artist: dA.track.artist,
          bpm: dA.baseBpm * dA.playbackRate,
          musicalKey: dA.track.musicalKey,
        },
        deckB: {
          title: dB.track.title,
          artist: dB.track.artist,
          bpm: dB.baseBpm * dB.playbackRate,
          musicalKey: dB.track.musicalKey,
        },
        direction: autopilotRef.current.lastDirection,
        aggressiveness: autopilotRef.current.aggressiveness,
        sessionSeed: (autopilotRef.current.sessionSeed ^ Date.now()) >>> 0,
      });

      if (!dA.isPlaying) await handleTogglePlay('A', true);
      if (!dB.isPlaying) await handleTogglePlay('B', true);
      handleSync(advice.syncDeck === 'A' ? 'A' : 'B');

      aiSessionRef.current.mashupPhases = advice.phases || null;
      aiSessionRef.current.mashupTotalBars = advice.mashupTotalBars || 32;
      aiSessionRef.current.mashupStartMs = performance.now();
      aiSessionRef.current.mashupSyncDeck = advice.syncDeck;
      aiSessionRef.current.lastMashupLabel = advice.harmonicSummary;
      aiSessionRef.current.lastMashupDoubleDropFired = false;

      setMixerState((m) => ({
        ...m,
        crossfader: Math.max(-0.6, Math.min(0.6, advice.crossfader ?? 0)),
      }));
      setDeckState('A', (prev) => ({
        ...prev,
        eqLow: advice.deckA.eqLow,
        eqMid: advice.deckA.eqMid,
        eqHigh: advice.deckA.eqHigh,
        filter: advice.deckA.filter,
        stemMode: prev.playbackMode === 'webaudio' ? advice.deckA.stemMode || 'off' : 'off',
        fx: {
          ...prev.fx,
          enabled: advice.deckA.fxEnabled,
          type: advice.deckA.fxType,
          wet: advice.deckA.fxWet,
        },
      }));
      setDeckState('B', (prev) => ({
        ...prev,
        eqLow: advice.deckB.eqLow,
        eqMid: advice.deckB.eqMid,
        eqHigh: advice.deckB.eqHigh,
        filter: advice.deckB.filter,
        stemMode: prev.playbackMode === 'webaudio' ? advice.deckB.stemMode || 'off' : 'off',
        fx: {
          ...prev.fx,
          enabled: advice.deckB.fxEnabled,
          type: advice.deckB.fxType,
          wet: advice.deckB.fxWet,
        },
      }));

      setAutopilotState((prev) => ({
        ...prev,
        mashupRoutineActive: Boolean(advice.phases && advice.phases.length > 0),
        currentActionLabel: `Blend A+B: ${advice.harmonicSummary}`,
      }));
    } catch (err: any) {
      setAutopilotState((prev) => ({
        ...prev,
        errorMessage: err?.message || 'AI Blend failed.',
      }));
    } finally {
      setMashupLoading(false);
    }
  }, [handleSync, handleTogglePlay, setAutopilotState, setDeckState, setMixerState]);

  // Real-time 25fps AI Auto-Pilot, Groove Bridge & 16-Bar Mashup Choreography Executor Loop
  useEffect(() => {
    if (!autopilot.enabled && !autopilot.mashupRoutineActive && autopilot.grooveBridgePattern === 'off') {
      return;
    }

    const timer = setInterval(() => {
      const state = autopilotRef.current;
      const sess = aiSessionRef.current;
      const nowMs = performance.now();

      // Keep active Groove Drum Bridge quantized to active master deck tempo & Camelot key (+ live pitch rate)
      if (state.grooveBridgePattern !== 'off' || sess.aiAutoBridgeActive) {
        const masterD = deckARef.current.isMaster ? deckARef.current : deckBRef.current;
        const activeD = masterD.track ? masterD : deckARef.current.track ? deckARef.current : deckBRef.current;
        if (activeD.track) {
          djEngine.updateGrooveBridge(
            activeD.baseBpm * activeD.playbackRate,
            activeD.track.musicalKey,
            activeD.playbackMode === 'webaudio' ? activeD.playbackRate : 1
          );
        }
      }

      // Upgrade #1: Continuous 32-Bar Live Bootleg Mashup Routine Stepper (3-Stem HPSS)
      if (state.mashupRoutineActive && sess.mashupPhases && sess.mashupPhases.length > 0 && state.phase !== 'transitioning') {
        const dA = deckARef.current;
        const dB = deckBRef.current;
        if (!dA.track || !dB.track || (!dA.isPlaying && !dB.isPlaying)) {
          sess.mashupPhases = null;
          setAutopilotState((prev) => ({ ...prev, mashupRoutineActive: false }));
          return;
        }
        const refDeck = dA.isMaster ? dA : dB;
        const effBpm = Math.max(70, refDeck.baseBpm * refDeck.playbackRate);
        const barSec = (60 / effBpm) * 4;
        const totalBars = sess.mashupTotalBars || 32;
        const barPos = ((nowMs - sess.mashupStartMs) / 1000 / barSec) % totalBars;
        const activePh =
          sess.mashupPhases.find((ph) => barPos >= ph.barStart && barPos < ph.barEnd) ||
          sess.mashupPhases[0];

        let targetXf = activePh.crossfader;
        if (activePh.pingPongBars && activePh.pingPongBars > 0) {
          const tradeIdx = Math.floor((barPos - activePh.barStart) / activePh.pingPongBars);
          targetXf = tradeIdx % 2 === 0 ? -0.62 : 0.62;
        }

        if (activePh.isDoubleDrop) {
          if (!sess.lastMashupDoubleDropFired) {
            sess.lastMashupDoubleDropFired = true;
            if (!state.muteSoundTricks) {
              djEngine.playSoundTrick(
                'sub-drop',
                effBpm,
                refDeck.track?.musicalKey,
                refDeck.playbackMode === 'webaudio' ? refDeck.playbackRate : 1
              );
            }
            if (dA.playbackMode === 'webaudio') djEngine.setDeckStereoWidth('A', 1.24);
            if (dB.playbackMode === 'webaudio') djEngine.setDeckStereoWidth('B', 1.24);
            sess.widthSlamUntilMs = nowMs + 1800;
          }
        } else {
          sess.lastMashupDoubleDropFired = false;
        }

        setMixerState((m) => ({ ...m, crossfader: targetXf }));
        setDeckState('A', (prev) => ({
          ...prev,
          eqLow: activePh.deckAEqLow,
          eqMid: activePh.deckAEqMid,
          eqHigh: activePh.deckAEqHigh,
          filter: typeof activePh.deckAFilter === 'number' ? activePh.deckAFilter : prev.filter,
          stemMode:
            prev.playbackMode === 'webaudio' && activePh.deckAStemMode
              ? activePh.deckAStemMode
              : prev.stemMode,
        }));
        setDeckState('B', (prev) => ({
          ...prev,
          eqLow: activePh.deckBEqLow,
          eqMid: activePh.deckBEqMid,
          eqHigh: activePh.deckBEqHigh,
          filter: typeof activePh.deckBFilter === 'number' ? activePh.deckBFilter : prev.filter,
          stemMode:
            prev.playbackMode === 'webaudio' && activePh.deckBStemMode
              ? activePh.deckBStemMode
              : prev.stemMode,
        }));

        // Upgrade #4: Live RMS Low-Band Sidechain during 32-Bar Mashup
        if (dA.playbackMode === 'webaudio' && dB.playbackMode === 'webaudio') {
          const bassId = sess.mashupSyncDeck === 'A' ? 'B' : 'A';
          const vocalId = sess.mashupSyncDeck;
          const kickEnergy = djEngine.getDeckLowBandLevel(bassId);
          djEngine.setDeckSidechainDuck(vocalId, 1 - kickEnergy * 0.28);
          djEngine.setDeckSidechainDuck(bassId, 1);
        }

        if (sess.lastMashupLabel !== activePh.label) {
          sess.lastMashupLabel = activePh.label;
          setAutopilotState((prev) => ({
            ...prev,
            currentActionLabel: activePh.label,
          }));
        }
      }

      // Upgrade #3: Post-Transition Vocal/Acapella Carryover runner
      if (state.enabled && sess.carryoverDeck) {
        const cId = sess.carryoverDeck;
        const cDeck = getDeckRef(cId);
        const totalMs = Math.max(1000, sess.carryoverUntilMs - sess.carryoverStartMs);
        const cp = (nowMs - sess.carryoverStartMs) / totalMs;
        if (cp >= 1 || !cDeck.isPlaying || state.phase === 'transitioning') {
          sess.carryoverDeck = null;
          sess.carryoverUntilMs = 0;
          djEngine.setDeckSidechainDuck(cId, 1);
          handleTogglePlay(cId, false);
          setDeckState(cId, (prev) => ({
            ...prev,
            channelVolume: 0.9,
            eqLow: 0,
            eqMid: 0,
            eqHigh: 0,
            filter: 0,
            stemMode: 'off',
            playbackRate: 1,
            isMaster: false,
            fx: { ...prev.fx, enabled: false },
          }));
          if (cDeck.playbackMode === 'webaudio') djEngine.setDeckRate(cId, 1);
          const mainXf = sess.outgoingDeck === 'A' ? -1 : 1;
          setMixerState((m) => ({ ...m, crossfader: mainXf }));
          if (!sess.plan && state.phase !== 'transitioning') {
            requestNextAiPlan(
              sess.outgoingDeck,
              state.vibe,
              undefined,
              state.targetPlaylistId,
              state.remixMode
            );
          }
        } else {
          // Taper vocal stem smoothly during final 35% of carryover + RMS duck from main kick
          const mainId = sess.outgoingDeck;
          const fadeOut = cp > 0.65 ? Math.max(0.05, 1 - (cp - 0.65) / 0.35) : 1;
          setDeckState(cId, (prev) => ({ ...prev, channelVolume: 0.85 * fadeOut }));
          if (getDeckRef(mainId).playbackMode === 'webaudio') {
            const kickEnergy = djEngine.getDeckLowBandLevel(mainId);
            djEngine.setDeckSidechainDuck(cId, 1 - kickEnergy * 0.32);
          }
        }
      }

      // Upgrade #2: YouTube IFrame Hybrid Synth Remix Pump Runner
      if (sess.ytPumpDeck && sess.ytPumpUntilMs > 0) {
        const pId = sess.ytPumpDeck;
        const pDeck = getDeckRef(pId);
        const { gainA, gainB } = djEngine.computeCrossfaderGains(
          mixerRef.current.crossfader,
          mixerRef.current.crossfaderCurve,
          mixerRef.current.crossfaderReverse
        );
        const baseGain = pId === 'A' ? gainA : gainB;
        const fullVol = pDeck.channelVolume * baseGain * mixerRef.current.masterGain * 100;

        if (nowMs >= sess.ytPumpUntilMs || pDeck.playbackMode !== 'youtube-iframe') {
          sess.ytPumpDeck = null;
          sess.ytPumpMode = null;
          sess.ytPumpUntilMs = 0;
          sess.ytPumpDropSlammed = false;
          if (sess.ytPumpBridgeActive) {
            sess.ytPumpBridgeActive = false;
            if (state.grooveBridgePattern === 'off' && !sess.aiAutoBridgeActive) {
              djEngine.stopGrooveBridge();
            }
          }
          if (pDeck.playbackMode === 'youtube-iframe') {
            ytPlayersRef.current[pId]?.setVolume(fullVol);
          }
        } else {
          const pBpm = Math.max(70, pDeck.baseBpm * pDeck.playbackRate);
          const pBeatMs = 60000 / pBpm;
          const elapsedPump = nowMs - sess.ytPumpStartMs;
          const pumpTotal = Math.max(500, sess.ytPumpUntilMs - sess.ytPumpStartMs);
          const pumpProgress = elapsedPump / pumpTotal;

          if (sess.ytPumpMode === 'gate-8th') {
            const open = Math.floor(elapsedPump / Math.max(85, pBeatMs * 0.5)) % 2 === 0;
            ytPlayersRef.current[pId]?.setVolume(open ? fullVol : fullVol * 0.08);
          } else if (sess.ytPumpMode === 'drop-takeover') {
            if (pumpProgress < 0.52) {
              // Duck YouTube briefly while in-key Groove Bridge + snare roll takes over!
              ytPlayersRef.current[pId]?.setVolume(fullVol * 0.16);
            } else {
              if (!sess.ytPumpDropSlammed) {
                sess.ytPumpDropSlammed = true;
                if (!state.muteSoundTricks) {
                  djEngine.playSoundTrick('sub-drop', pBpm, pDeck.track?.musicalKey);
                }
                if (sess.ytPumpBridgeActive) {
                  sess.ytPumpBridgeActive = false;
                  if (state.grooveBridgePattern === 'off' && !sess.aiAutoBridgeActive) {
                    djEngine.stopGrooveBridge();
                  }
                }
              }
              ytPlayersRef.current[pId]?.setVolume(fullVol);
            }
          } else {
            // Beat-synced 1/4 sidechain pump envelope
            const beatPhase = (elapsedPump % pBeatMs) / pBeatMs;
            const env = beatPhase < 0.25 ? 0.36 + (beatPhase / 0.25) * 0.64 : 1;
            ytPlayersRef.current[pId]?.setVolume(fullVol * env);
          }
        }
      }

      if (!state.enabled || !sess.plan) return;

      const outId = sess.outgoingDeck;
      const inId = sess.incomingDeck;
      const outDeck = getDeckRef(outId);
      const inDeck = getDeckRef(inId);

      // Auto-reset Stereo Width expansion after drop slam window expires
      if (sess.widthSlamUntilMs > 0 && nowMs >= sess.widthSlamUntilMs) {
        sess.widthSlamUntilMs = 0;
        djEngine.setDeckStereoWidth('A', 1);
        djEngine.setDeckStereoWidth('B', 1);
      }

      // Upgrade #3 + Stereo Width Automation: VIP Drop Fakeout Multi-Phrase Runner
      if (sess.vipFakeoutDeck && sess.vipFakeoutUntilMs > 0) {
        const vId = sess.vipFakeoutDeck;
        const vDeck = getDeckRef(vId);
        const totalV = Math.max(800, sess.vipFakeoutUntilMs - sess.vipFakeoutStartMs);
        const vp = (nowMs - sess.vipFakeoutStartMs) / totalV;
        if (vp >= 1 || state.phase === 'transitioning') {
          sess.vipFakeoutDeck = null;
          sess.vipFakeoutUntilMs = 0;
          sess.vipFakeoutStage = 0;
          if (vDeck.playbackMode === 'webaudio' && sess.widthSlamUntilMs === 0) {
            djEngine.setDeckStereoWidth(vId, 1);
          }
          handleExitLoop(vId);
          setDeckState(vId, (prev) => ({
            ...prev,
            eqLow: 0,
            eqMid: 0,
            eqHigh: 0,
            filter: 0,
            fx: { ...prev.fx, enabled: false },
          }));
        } else if (vp < 0.44) {
          if (sess.vipFakeoutStage < 1) {
            sess.vipFakeoutStage = 1;
            handleToggleLoop(vId, 0.5);
          }
          if (vDeck.playbackMode === 'webaudio') {
            djEngine.setDeckStereoWidth(vId, Math.max(0.28, 1 - vp * 1.4));
          }
          setDeckState(vId, (prev) => ({
            ...prev,
            eqLow: -0.92,
            filter: 0.45,
            fx: { ...prev.fx, enabled: true, type: 'dubdelay', wet: 0.62, beatDiv: 0.5 },
          }));
        } else if (vp < 0.56) {
          if (sess.vipFakeoutStage < 2) {
            sess.vipFakeoutStage = 2;
            handleExitLoop(vId);
            if (!state.muteSoundTricks) {
              djEngine.playSoundTrick(
                'sub-drop',
                Math.max(70, vDeck.baseBpm * vDeck.playbackRate),
                vDeck.track?.musicalKey,
                vDeck.playbackMode === 'webaudio' ? vDeck.playbackRate : 1
              );
            }
          }
          if (vDeck.playbackMode === 'webaudio') {
            djEngine.setDeckStereoWidth(vId, 0.24);
          }
          setDeckState(vId, (prev) => ({
            ...prev,
            eqLow: -0.98,
            filter: 0.65,
          }));
        } else if (sess.vipFakeoutStage < 3) {
          sess.vipFakeoutStage = 3;
          const vBpm = Math.max(70, vDeck.baseBpm * vDeck.playbackRate);
          if (vDeck.playbackMode === 'webaudio') {
            djEngine.setDeckStereoWidth(vId, 1.28);
            sess.widthSlamUntilMs = nowMs + 1800;
            djEngine.triggerDeckBeatSlices(vId, {
              currentSec: getLiveTime(vId),
              bpm: vBpm,
              dropCueSec: vDeck.track?.dropCueSec ?? vDeck.detectedDropSec,
              pattern: [0, 0, 1, 2, 0, 1, 3, 2],
              sliceBeats: 0.5,
            });
          }
          setDeckState(vId, (prev) => ({
            ...prev,
            eqLow: 0.14,
            filter: 0,
            fx: { ...prev.fx, enabled: false },
          }));
          setAutopilotState((prev) => ({
            ...prev,
            currentActionLabel: 'VIP Re-Drop SLAM!',
          }));
        }
      }

      if (state.phase === 'cruising') {
        if (sess.isStartingTransition) return;
        const cur = getLiveTime(outId);
        const dur = Math.max(10, outDeck.duration);
        const remaining = dur - cur;
        const pct = cur / dur;
        // Upgrade #5: Dynamic Elastic Beat-Grid Tempo Map lookup
        const elastic = resolveElasticPhraseAtTime(
          outDeck.track?.tempoMap,
          outDeck.baseBpm,
          outDeck.track?.firstBeatSec || 0,
          cur
        );
        const bpm = Math.max(80, elastic.bpm * outDeck.playbackRate);
        const beatMs = 60000 / bpm;
        const beatSec = 60 / bpm;
        const barSec = beatSec * 4;
        const firstBeat = elastic.firstBeatSec;
        const beatPhase = (((cur - firstBeat) % beatSec) + beatSec) % beatSec / beatSec;
        const barPhase = (((cur - firstBeat) % barSec) + barSec) % barSec / barSec;
        const nearBeatBoundary = beatPhase <= 0.16 || beatPhase >= 0.84;
        const nearBar1Boundary = barPhase <= 0.11 || barPhase >= 0.89;

        // Upgrade #5: Real-Time Energy & Outro Rescue Guard
        const inOutroSection = Boolean(
          outDeck.sections?.some(
            (s) => s.label === 'outro' && cur >= s.startSec && cur <= s.endSec
          )
        );
        if (outDeck.playbackMode === 'webaudio' && pct > 0.32) {
          const liveRms = djEngine.getDeckLevel(outId);
          if (liveRms < 0.08) {
            if (sess.lowEnergySinceMs === 0) sess.lowEnergySinceMs = nowMs;
          } else {
            sess.lowEnergySinceMs = 0;
          }
        } else {
          sess.lowEnergySinceMs = 0;
        }
        const sustainedQuietOutro =
          sess.lowEnergySinceMs > 0 && nowMs - sess.lowEnergySinceMs >= 2200;

        // Upgrade #5: Auto-Loop Safety Net if track nears outro before transition finishes (or while buffering)
        const neededMixSec = (sess.plan.transitionBars || 8) * barSec;
        if (
          outDeck.playbackMode === 'webaudio' &&
          !outDeck.loopActive &&
          !sess.rescueLoopActive &&
          ((remaining <= barSec * 6 && (inDeck.isLoading || sess.isStartingTransition)) ||
            (remaining <= neededMixSec + 2 && remaining > 1.5))
        ) {
          const safetyBars = remaining >= barSec * 4.5 ? 4 : 2;
          sess.rescueLoopActive = true;
          sess.outroSafetyLoopActive = true;
          handleToggleLoop(outId, safetyBars);
          setAutopilotState((prev) => ({
            ...prev,
            currentActionLabel: `Auto-Loop Safety Net · Holding ${safetyBars}-Bar Groove`,
          }));
        }

        // Advance #7 + Sparsest Pocket Finder: Live countdown ETA accounting for +8 Bars hold & Early Outro Guard
        const baseThreshold = state.quickMix ? 0.34 : state.remixMode ? 0.48 : 0.62;
        const pocketTargetPct = sess.plan.recommendedOutStartPct
          ? Math.max(baseThreshold * 0.92, Math.min(0.8, sess.plan.recommendedOutStartPct))
          : baseThreshold;
        const transitionThreshold = Math.min(
          0.88,
          pocketTargetPct + (state.holdExtraBars * barSec) / dur
        );
        const minRemainTrigger = Math.min(22, dur * 0.35);
        let triggerAtSec = Math.min(dur - minRemainTrigger, dur * transitionThreshold);
        if ((inOutroSection || sustainedQuietOutro) && pct > 0.3) {
          triggerAtSec = Math.min(triggerAtSec, cur + barSec * 1.5);
        }
        const etaSec = Math.max(0, Math.round(triggerAtSec - cur));
        if (state.nextTransitionEtaSec !== etaSec) {
          setAutopilotState((prev) =>
            prev.nextTransitionEtaSec === etaSec ? prev : { ...prev, nextTransitionEtaSec: etaSec }
          );
        }

        // Wave-3 #6: Automatic "Club VIP Edit" Arrangement Skipper for Long Tracks
        const vipSkip = sess.plan.vipSkipEdit;
        if (
          vipSkip &&
          !sess.vipSkipFired &&
          !outDeck.isLoading &&
          pct >= vipSkip.triggerPct &&
          pct <= vipSkip.triggerPct + 0.08 &&
          cur < vipSkip.targetSec - barSec * 4 &&
          nearBar1Boundary
        ) {
          sess.vipSkipFired = true;
          if (!state.muteSoundTricks) {
            djEngine.playSoundTrick(
              'chord-stab',
              bpm,
              outDeck.track?.musicalKey,
              outDeck.playbackMode === 'webaudio' ? outDeck.playbackRate : 1
            );
          }
          setDeckState(outId, (prev) => ({
            ...prev,
            fx: { ...prev.fx, enabled: true, type: 'dubdelay', wet: 0.48, beatDiv: 0.5 },
          }));
          handleSeek(outId, vipSkip.targetSec);
          setAutopilotState((prev) => ({
            ...prev,
            currentActionLabel: vipSkip.label,
          }));
          setTimeout(() => {
            setDeckState(outId, (prev) => ({
              ...prev,
              fx: prev.fx.type === 'dubdelay' ? { ...prev.fx, enabled: false } : prev.fx,
            }));
          }, Math.max(450, beatMs * 1.5));
        }

        // Execute live cruising Crossfader Pattern Sequencer (+ real turntable scratch bursts)
        if (sess.cruisingChopUntilMs > 0) {
          const soloXf = outId === 'A' ? -1 : 1;
          if (nowMs < sess.cruisingChopUntilMs) {
            const subDivMs =
              sess.cruisingChopPattern === 'eighth-gate' ? beatMs * 0.25 : beatMs * 0.5;
            const step = Math.floor(nowMs / Math.max(90, subDivMs));
            const open =
              sess.cruisingChopPattern === 'transformer-scratch'
                ? step % 4 !== 1
                : step % 2 === 0;
            if (
              sess.cruisingChopPattern === 'transformer-scratch' &&
              outDeck.playbackMode === 'webaudio' &&
              nowMs - sess.lastScratchAtMs >= Math.max(280, beatMs * 1.5)
            ) {
              sess.lastScratchAtMs = nowMs;
              djEngine.triggerDeckTurntableScratch(outId, {
                currentSec: cur,
                bpm,
                pattern: '2click-flare',
                preferHarmonic: true,
              });
            }
            setMixerState((m) => ({ ...m, crossfader: open ? soloXf : 0 }));
          } else {
            sess.cruisingChopUntilMs = 0;
            sess.cruisingChopPattern = 'off';
            setMixerState((m) => ({ ...m, crossfader: soloXf }));
          }
        }

        // Execute live cruising Hot-Cue Wordplay Stutter Jumps
        if (sess.cruisingCueSeq && sess.cruisingCueUntilMs > 0) {
          if (nowMs < sess.cruisingCueUntilMs) {
            const stepMs = Math.max(240, beatMs * 0.5);
            const stepIdx = Math.floor((nowMs - sess.cruisingCueStartMs) / stepMs);
            if (stepIdx !== sess.lastCueStepIdx && nowMs - sess.lastCueSeekAtMs >= 220) {
              sess.lastCueStepIdx = stepIdx;
              const cueSlot = sess.cruisingCueSeq[stepIdx % sess.cruisingCueSeq.length];
              const targetCue = outDeck.hotCues[cueSlot]?.timeSec;
              if (typeof targetCue === 'number') {
                sess.lastCueSeekAtMs = nowMs;
                handleSeek(outId, targetCue);
              }
            }
          } else {
            sess.cruisingCueSeq = null;
            sess.cruisingCueUntilMs = 0;
            if (sess.cruisingReturnSec > 0 && sess.cruisingReturnSec < dur - 5) {
              handleSeek(outId, sess.cruisingReturnSec);
            }
          }
        }

        // Upgrade #5: "Tease the Next Song" Breakdown Mashup Preview (Sneak next vocal on breakdown)
        if (sess.teaseActive) {
          if (nowMs >= sess.teaseUntilMs || inDeck.playbackMode !== 'webaudio') {
            sess.teaseActive = false;
            handleTogglePlay(inId, false);
            djEngine.setDeckRate(inId, 1);
            setDeckState(inId, (prev) => ({
              ...prev,
              channelVolume: 0.9,
              eqLow: 0,
              eqMid: 0,
              eqHigh: 0,
              filter: 0,
              stemMode: 'off',
              playbackRate: 1,
              fx: { ...prev.fx, enabled: false },
            }));
            setMixerState((m) => ({ ...m, crossfader: outId === 'A' ? -1 : 1 }));
          }
        } else if (
          sess.plan.teasePreview &&
          !sess.teaseFired &&
          inDeck.playbackMode === 'webaudio' &&
          !inDeck.isLoading &&
          !inDeck.isPlaying &&
          pct >= sess.plan.teasePreview.triggerPct &&
          pct <= sess.plan.teasePreview.triggerPct + 0.08 &&
          nearBar1Boundary
        ) {
          const tease = sess.plan.teasePreview;
          sess.teaseFired = true;
          sess.teaseActive = true;
          sess.teaseStartMs = nowMs;
          sess.teaseUntilMs = nowMs + Math.min(9000, Math.max(2500, tease.durationBars * barSec * 1000));
          const fold = sess.plan.tempoFoldFactor || 1;
          const teaseRate = Math.max(0.65, Math.min(1.4, bpm / Math.max(60, inDeck.baseBpm * fold)));
          djEngine.setDeckKeyLock(inId, true);
          djEngine.setDeckRate(inId, teaseRate);
          djEngine.setDeckStemMode(inId, 'vocal-focus');
          setDeckState(inId, (prev) => ({
            ...prev,
            channelVolume: 0.68,
            eqLow: -0.92,
            eqMid: 0.22,
            eqHigh: 0.1,
            filter: 0.26,
            stemMode: 'vocal-focus',
            playbackRate: teaseRate,
            fx: { ...prev.fx, enabled: true, type: 'dubdelay', wet: 0.48, beatDiv: 0.5 },
          }));
          setMixerState((m) => ({ ...m, crossfader: outId === 'A' ? -0.45 : 0.45 }));
          djEngine.playDeck(inId, tease.cueSec).then(() => {
            setDeckState(inId, (prev) => ({ ...prev, isPlaying: djEngine.isDeckPlaying(inId) }));
          });
          setAutopilotState((prev) => ({
            ...prev,
            currentActionLabel: tease.label,
          }));
        }

        // Upgrade #1: Beat-Quantized Per-Song Offline AI Live Remix Moments during Cruising
        const moments = sess.plan.songMoments || [];
        const mutedSet = new Set(state.mutedMomentIndices || []);
        if (sess.pendingMomentIdx === null) {
          for (let mIdx = 0; mIdx < moments.length; mIdx++) {
            const moment = moments[mIdx];
            if (
              !mutedSet.has(mIdx) &&
              !sess.firedMomentIndices.has(mIdx) &&
              pct >= moment.atPct &&
              pct <= moment.atPct + 0.08
            ) {
              sess.pendingMomentIdx = mIdx;
              sess.pendingMomentQueuedAtMs = nowMs;
              break;
            }
          }
        }

        if (sess.pendingMomentIdx !== null) {
          const mIdx = sess.pendingMomentIdx;
          const moment = moments[mIdx];
          const waitedTooLong = nowMs - sess.pendingMomentQueuedAtMs >= beatMs * 1.15;
          if (!moment || mutedSet.has(mIdx)) {
            sess.pendingMomentIdx = null;
          } else if (nearBeatBoundary || waitedTooLong) {
            sess.pendingMomentIdx = null;
            sess.firedMomentIndices.add(mIdx);

            if (sess.midRemixTimeoutId) {
              clearTimeout(sess.midRemixTimeoutId);
              sess.midRemixTimeoutId = null;
            }
            const outPitchRate = outDeck.playbackMode === 'webaudio' ? outDeck.playbackRate : 1;

            // Upgrade #4: Exact Sample-Accurate Build-Up Escalator on Web Audio clock
            if (moment.useSampleAccurateBuild && !state.muteSoundTricks) {
              const voiceOk =
                moment.voiceDropId &&
                state.voiceFxEnabled &&
                isAnyVoiceEnabled(moment.voiceDropId);
              const customBuf =
                voiceOk && moment.voiceDropId && isCustomVoiceDropId(moment.voiceDropId)
                  ? customVoiceBuffersRef.current[moment.voiceDropId] || null
                  : null;
              const presetVoice =
                voiceOk && moment.voiceDropId && !isCustomVoiceDropId(moment.voiceDropId)
                  ? moment.voiceDropId
                  : null;
              void djEngine.scheduleBuildUpSequence({
                bpm,
                musicalKey: outDeck.track?.musicalKey,
                pitchRate: outPitchRate,
                bars: 1,
                voiceId: presetVoice,
                customVoiceBuffer: customBuf,
              });
            } else {
              if (moment.soundTrick && !state.muteSoundTricks) {
                djEngine.playSoundTrick(moment.soundTrick, bpm, outDeck.track?.musicalKey, outPitchRate);
              }
              if (
                moment.voiceDropId &&
                !state.muteSoundTricks &&
                state.voiceFxEnabled &&
                isAnyVoiceEnabled(moment.voiceDropId)
              ) {
                void playAnyVoiceDrop(moment.voiceDropId, bpm, outDeck.track?.musicalKey, outPitchRate);
              }
            }
            if (moment.deckCHookPattern && djEngine.hasDeckCHook() && !state.muteSoundTricks) {
              djEngine.triggerDeckCHook({
                pattern: moment.deckCHookPattern,
                targetBpm: bpm,
              });
            }

            // Upgrade #3: VIP Drop Fakeout Multi-Phrase Arc
            if (moment.isVipDropFakeout) {
              sess.vipFakeoutDeck = outId;
              sess.vipFakeoutStartMs = nowMs;
              sess.vipFakeoutUntilMs = nowMs + moment.durationMs;
              sess.vipFakeoutStage = 0;
            } else if (moment.loopBars) {
              handleToggleLoop(outId, moment.loopBars);
            }

            // Upgrade #2: Hybrid Synth Remix Layer for YouTube IFrame Decks
            if (outDeck.playbackMode === 'youtube-iframe' && moment.youtubePumpMode) {
              sess.ytPumpDeck = outId;
              sess.ytPumpMode = moment.youtubePumpMode;
              sess.ytPumpStartMs = nowMs;
              sess.ytPumpUntilMs = nowMs + moment.durationMs;
              sess.ytPumpDropSlammed = false;
              if (
                moment.youtubePumpMode === 'drop-takeover' &&
                !state.muteSoundTricks &&
                state.grooveBridgePattern === 'off'
              ) {
                sess.ytPumpBridgeActive = true;
                djEngine.startGrooveBridge(
                  sess.plan.recommendedBridge && sess.plan.recommendedBridge !== 'off'
                    ? sess.plan.recommendedBridge
                    : 'house-4x4',
                  bpm,
                  outDeck.track?.musicalKey || '8A',
                  1
                );
              }
            }

            if (moment.chopPattern && moment.chopPattern !== 'off') {
              sess.cruisingChopPattern = moment.chopPattern;
              sess.cruisingChopUntilMs = nowMs + moment.durationMs;
            }
            if (moment.cueJuggleSeq && moment.cueJuggleSeq.length > 0 && !moment.loopBars) {
              sess.cruisingCueSeq = moment.cueJuggleSeq;
              sess.cruisingCueStartMs = nowMs;
              sess.cruisingCueUntilMs = nowMs + Math.min(moment.durationMs, 1800);
              sess.cruisingReturnSec = cur + 1.5;
              sess.lastCueStepIdx = -1;
            }
            if (moment.pitchBurst && outDeck.playbackMode === 'webaudio') {
              djEngine.setDeckRate(outId, moment.pitchBurst);
            }
            if (!moment.isVipDropFakeout && moment.beatSlicePattern && outDeck.playbackMode === 'webaudio') {
              djEngine.triggerDeckBeatSlices(outId, {
                currentSec: cur,
                bpm,
                dropCueSec: outDeck.track?.dropCueSec ?? outDeck.detectedDropSec,
                pattern: moment.beatSlicePattern,
                sliceBeats: 0.5,
              });
            }
            setDeckState(outId, (prev) => ({
              ...prev,
              filter: moment.filter,
              eqLow: moment.eqLow ?? prev.eqLow,
              eqMid: moment.eqMid ?? prev.eqMid,
              eqHigh: moment.eqHigh ?? prev.eqHigh,
              playbackRate: moment.pitchBurst ?? prev.playbackRate,
              fx: {
                ...prev.fx,
                enabled: true,
                type: moment.fxType,
                wet: moment.fxWet,
                beatDiv: moment.beatDiv,
              },
            }));
            setAutopilotState((prev) => ({
              ...prev,
              currentActionLabel: moment.label,
            }));
            if (!moment.isVipDropFakeout) {
              sess.midRemixTimeoutId = setTimeout(() => {
                sess.midRemixTimeoutId = null;
                sess.cruisingChopPattern = 'off';
                sess.cruisingChopUntilMs = 0;
                handleExitLoop(outId);
                if (getDeckRef(outId).playbackMode === 'webaudio') {
                  djEngine.setDeckRate(outId, 1);
                }
                setMixerState((m) => ({ ...m, crossfader: outId === 'A' ? -1 : 1 }));
                setDeckState(outId, (prev) => ({
                  ...prev,
                  eqLow: 0,
                  eqMid: 0,
                  eqHigh: 0,
                  filter: 0,
                  playbackRate: 1,
                  fx: { ...prev.fx, enabled: false },
                }));
              }, moment.durationMs);
            }
          }
        }

        const endedEarly = !outDeck.isPlaying && !outDeck.isLoading && cur >= Math.max(2, dur - 2.0);
        const shouldMixSoon =
          cur >= triggerAtSec || pct >= transitionThreshold || remaining <= minRemainTrigger || endedEarly;
        if (shouldMixSoon && !sess.pendingTransitionQuantize) {
          sess.pendingTransitionQuantize = true;
          sess.pendingTransitionQueuedAtMs = nowMs;
        }
        if (sess.pendingTransitionQuantize) {
          const maxWaitMs = Math.min(2200, beatMs * 2.5);
          if (
            endedEarly ||
            nearBar1Boundary ||
            nowMs - sess.pendingTransitionQueuedAtMs >= maxWaitMs
          ) {
            sess.pendingTransitionQuantize = false;
            beginAiTransitionNow(false);
          }
        }
        return;
      }

      if (state.phase === 'transitioning') {
        const elapsed = nowMs - sess.transitionStartMs;
        const p = Math.max(0, Math.min(1, elapsed / sess.transitionDurationMs));
        const physics = sess.plan.genrePhysicsMode || 'standard';

        const startXf = outId === 'A' ? -1 : 1;
        const endXf = inId === 'A' ? -1 : 1;
        // Upgrade #6: Genre-Specific Crossfader & Tempo Physics
        let xfFactor = p;
        if (physics === 'chill-velvet') {
          xfFactor = 0.5 - 0.5 * Math.cos(p * Math.PI);
        } else if (physics === 'dnb-chop') {
          xfFactor = p < 0.72 ? p * 0.35 : 0.35 + ((p - 0.72) / 0.28) * 0.65;
        }
        let xf = startXf + (endXf - startXf) * xfFactor;

        // Smooth tempo drift & Upgrade #4 Reverse Master Clock when YouTube IFrame mixes with WebAudio
        const fold = sess.plan.tempoFoldFactor || 1;
        const snapYtStep = (r: number) => (r <= 0.875 ? 0.75 : r >= 1.125 ? 1.25 : 1);
        const outIsYt = outDeck.playbackMode === 'youtube-iframe';
        const inIsYt = inDeck.playbackMode === 'youtube-iframe';
        let currentTargetBpm: number;
        let outRate: number;
        let inRate: number;

        if (outIsYt && inDeck.playbackMode === 'webaudio') {
          outRate = snapYtStep(outDeck.playbackRate);
          currentTargetBpm = outDeck.baseBpm * outRate;
          inRate = Math.max(0.5, Math.min(1.5, currentTargetBpm / (inDeck.baseBpm * fold)));
          djEngine.setDeckKeyLock(inId, true);
        } else if (inIsYt && outDeck.playbackMode === 'webaudio') {
          inRate = snapYtStep(inDeck.playbackRate);
          currentTargetBpm = inDeck.baseBpm * fold * inRate;
          outRate = Math.max(0.5, Math.min(1.5, currentTargetBpm / outDeck.baseBpm));
          djEngine.setDeckKeyLock(outId, true);
        } else {
          const startMasterBpm = outDeck.baseBpm;
          const targetMasterBpm = sess.plan.tempoTargetBpm || inDeck.baseBpm * fold;
          const tempoProgress =
            physics === 'trap-to-house' ? 0.5 - 0.5 * Math.cos(p * Math.PI) : p;
          currentTargetBpm = startMasterBpm + (targetMasterBpm - startMasterBpm) * tempoProgress;
          outRate = Math.max(0.5, Math.min(1.5, currentTargetBpm / outDeck.baseBpm));
          const desiredInRawRate = currentTargetBpm / (inDeck.baseBpm * fold);
          inRate = Math.max(0.5, Math.min(1.5, desiredInRawRate));
        }
        const beatMs = 60000 / Math.max(70, currentTargetBpm);

        // Advance #3 & Upgrade #6: Auto Groove Drum Bridge glue mid-transition (forced on Trap->House)
        const wantAutoBridge =
          (state.remixMode || physics === 'trap-to-house') &&
          !state.muteSoundTricks &&
          state.grooveBridgePattern === 'off';
        const bridgePatternToUse =
          physics === 'trap-to-house'
            ? 'house-4x4'
            : sess.plan.recommendedBridge || 'off';
        if (wantAutoBridge && bridgePatternToUse !== 'off') {
          const bridgeStartP = physics === 'trap-to-house' ? 0.08 : 0.14;
          const bridgeEndP = physics === 'trap-to-house' ? 0.9 : 0.85;
          if (p >= bridgeStartP && p < bridgeEndP && !sess.aiAutoBridgeActive) {
            sess.aiAutoBridgeActive = true;
            const bridgeKey = inDeck.track?.musicalKey || outDeck.track?.musicalKey || '8A';
            const bridgePitch = inDeck.track?.musicalKey
              ? inDeck.playbackMode === 'webaudio'
                ? inRate
                : 1
              : outDeck.playbackMode === 'webaudio'
              ? outRate
              : 1;
            djEngine.startGrooveBridge(
              bridgePatternToUse,
              currentTargetBpm,
              bridgeKey,
              bridgePitch
            );
          } else if (p >= bridgeEndP && sess.aiAutoBridgeActive) {
            sess.aiAutoBridgeActive = false;
            djEngine.stopGrooveBridge();
          }
        }

        const clash = sess.plan.clashProfile;
        let outChannelVolume = 0.9;
        let inChannelVolume = 0.9;
        let outEqLow = 0;
        let outEqMid = clash ? clash.recommendedOutMidCut * Math.sin(p * Math.PI * 0.6) : 0;
        let outEqHigh = 0;
        let inEqLow = (clash ? clash.recommendedOutLowCut : -0.78) * Math.max(0, 1 - p * 1.4);
        let inEqMid = (clash ? clash.recommendedInMidCut : -0.15) * Math.max(0, 1 - p * 1.3);
        let inEqHigh = -0.1 * Math.max(0, 1 - p * 1.3);

        // Upgrade #4: Dynamic 2-Bar Call-and-Response Mid-Carve & Live RMS Kick Sidechain
        if (sess.plan.dynamicMidCallResponse && p >= 0.15 && p <= 0.85) {
          const twoBarTurn = Math.floor(elapsed / Math.max(800, beatMs * 8)) % 2;
          outEqMid = twoBarTurn === 0 ? 0.16 : -0.62;
          inEqMid = twoBarTurn === 0 ? -0.62 : 0.18;
        }
        if (outDeck.playbackMode === 'webaudio' && inDeck.playbackMode === 'webaudio') {
          const outKickEnergy = djEngine.getDeckLowBandLevel(outId);
          djEngine.setDeckSidechainDuck(inId, 1 - outKickEnergy * 0.34);
        }

        let outKillLow = false;
        let outKillHigh = false;
        let outFilter = 0;
        let inFilter = 0;
        let outFx: Partial<DeckFxState> | null = null;
        let inFx: Partial<DeckFxState> | null = null;
        let activeLabel = sess.plan.aiNotes;
        const activeKey = inDeck.track?.musicalKey || outDeck.track?.musicalKey;

        // Wave-2 Advance #6: Quantized mid-transition Beat-Slice fill when enabled
        if (
          sess.plan.useBeatSliceStutter &&
          p >= 0.45 &&
          p <= 0.54 &&
          !sess.firedSoundIndices.has(9999) &&
          outDeck.playbackMode === 'webaudio'
        ) {
          sess.firedSoundIndices.add(9999);
          djEngine.triggerDeckBeatSlices(outId, {
            currentSec: getLiveTime(outId),
            bpm: currentTargetBpm,
            dropCueSec: outDeck.track?.dropCueSec ?? outDeck.detectedDropSec,
            pattern: [0, 0, 1, 2, 0, 2, 1, 3],
            sliceBeats: 0.25,
          });
          activeLabel = 'Beat-Slice Transient Fill';
        }

        // Offline AI DJ Voice, Shout & Countdown Triggering (strictly respects voiceFxEnabled & enabledVoiceIds/custom drops)
        if (sess.plan.voiceDrops && sess.plan.voiceDrops.length > 0) {
          sess.plan.voiceDrops.forEach((vCue, vIdx) => {
            if (p >= vCue.atProgress && !sess.firedVoiceIndices.has(vIdx)) {
              sess.firedVoiceIndices.add(vIdx);
              if (
                !state.muteSoundTricks &&
                state.voiceFxEnabled &&
                isAnyVoiceEnabled(vCue.voiceId)
              ) {
                const vPitch = inDeck.track?.musicalKey
                  ? inDeck.playbackMode === 'webaudio'
                    ? inRate
                    : 1
                  : outDeck.playbackMode === 'webaudio'
                  ? outRate
                  : 1;
                void playAnyVoiceDrop(vCue.voiceId, currentTargetBpm, activeKey, vPitch);
                activeLabel = vCue.label;
              }
            }
          });
        }

        sess.plan.tricks.forEach((trick, idx) => {
          const endP = trick.atProgress + Math.max(0.08, trick.durationProgress);
          const inWindow = p >= trick.atProgress && p <= endP;
          const localP = inWindow
            ? Math.max(
                0,
                Math.min(1, (p - trick.atProgress) / Math.max(0.05, endP - trick.atProgress))
              )
            : 0;

          // Key-Adaptive + Pitch-Compensated One-Shot Sound Tricks (respects Advance #7 SFX Mute override)
          if (
            p >= trick.atProgress &&
            !sess.firedSoundIndices.has(idx) &&
            trick.action.startsWith('sound-')
          ) {
            sess.firedSoundIndices.add(idx);
            if (
              trick.action === 'sound-vinyl-stop' &&
              outDeck.playbackMode === 'webaudio' &&
              !sess.tapeBrakeFired
            ) {
              sess.tapeBrakeFired = true;
              djEngine.triggerDeckTapeBrake(
                outId,
                Math.min(1.15, (60 / Math.max(70, currentTargetBpm)) * 1.5)
              );
            }
            if (!state.muteSoundTricks) {
              const bpm = currentTargetBpm;
              const trickPitch = inDeck.track?.musicalKey
                ? inDeck.playbackMode === 'webaudio'
                  ? inRate
                  : 1
                : outDeck.playbackMode === 'webaudio'
                ? outRate
                : 1;
              if (trick.action === 'sound-riser') djEngine.playSoundTrick('riser', bpm, activeKey, trickPitch);
              else if (trick.action === 'sound-sub-drop') djEngine.playSoundTrick('sub-drop', bpm, activeKey, trickPitch);
              else if (trick.action === 'sound-siren') djEngine.playSoundTrick('dub-siren', bpm, activeKey, trickPitch);
              else if (trick.action === 'sound-backspin') djEngine.playSoundTrick('backspin', bpm, activeKey, trickPitch);
              else if (trick.action === 'sound-laser') djEngine.playSoundTrick('laser', bpm, activeKey, trickPitch);
              else if (trick.action === 'sound-air-horn') djEngine.playSoundTrick('air-horn', bpm, activeKey, trickPitch);
              else if (trick.action === 'sound-vinyl-stop') djEngine.playSoundTrick('vinyl-stop', bpm, activeKey, trickPitch);
              else if (trick.action === 'sound-snare-roll') djEngine.playSoundTrick('snare-roll', bpm, activeKey, trickPitch);
              else if (trick.action === 'sound-tape-rewind') djEngine.playSoundTrick('tape-rewind', bpm, activeKey, trickPitch);
              else if (trick.action === 'sound-sweep-down') djEngine.playSoundTrick('sweep-down', bpm, activeKey, trickPitch);
              else if (trick.action === 'sound-chord-stab') djEngine.playSoundTrick('chord-stab', bpm, activeKey, trickPitch);
              else if (trick.action === 'sound-scratch-chirp') {
                djEngine.playSoundTrick('scratch-chirp', bpm, activeKey, trickPitch);
                if (outDeck.playbackMode === 'webaudio') {
                  sess.lastScratchAtMs = nowMs;
                  djEngine.triggerDeckTurntableScratch(outId, {
                    currentSec: getLiveTime(outId),
                    bpm,
                    pattern: 'chirp',
                    preferHarmonic: true,
                  });
                }
              }
              else if (trick.action === 'sound-drop-alarm') djEngine.playSoundTrick('drop-alarm', bpm, activeKey, trickPitch);
              else if (trick.action === 'sound-tom-fill') djEngine.playSoundTrick('tom-fill', bpm, activeKey, trickPitch);
              else if (trick.action === 'sound-vinyl-crack') djEngine.playSoundTrick('vinyl-crack', bpm, activeKey, trickPitch);
              else if (trick.action === 'sound-riser-chord') djEngine.playSoundTrick('riser-chord', bpm, activeKey, trickPitch);
              activeLabel = `Trick: ${trick.label}`;
            }
          }

          if (trick.action === 'beat-loop-roll') {
            if (p >= trick.atProgress && !sess.loopStartedIndices.has(idx)) {
              sess.loopStartedIndices.add(idx);
              handleToggleLoop(outId, 0.5);
              activeLabel = `Loop Roll: ${trick.label}`;
            } else if (p > endP && !sess.loopEndedIndices.has(idx)) {
              sess.loopEndedIndices.add(idx);
              handleExitLoop(outId);
            }
          }

          if (trick.action === 'hot-cue-juggle' && inWindow) {
            if (localP > 0.45 && !sess.firedSoundIndices.has(idx + 1000)) {
              sess.firedSoundIndices.add(idx + 1000);
              handleBeatJump(outId, -2);
            }
          }

          // Feature #1B: YouTube-Native Quantized Hot-Cue Wordplay & Stutter Jumps
          if (trick.action === 'cue-wordplay-juggle' && inWindow) {
            const seq = sess.plan?.cueJuggleSeq || [0, 0, 1, 2];
            const stepDurationMs = Math.max(240, beatMs * 0.5);
            const stepIdx = Math.floor((elapsed - trick.atProgress * sess.transitionDurationMs) / stepDurationMs);
            if (stepIdx >= 0 && stepIdx !== sess.lastCueStepIdx && nowMs - sess.lastCueSeekAtMs >= 220) {
              sess.lastCueStepIdx = stepIdx;
              const cueSlot = seq[stepIdx % seq.length];
              const cueSec = outDeck.hotCues[cueSlot]?.timeSec;
              if (typeof cueSec === 'number') {
                sess.lastCueSeekAtMs = nowMs;
                handleSeek(outId, cueSec);
              }
            }
            activeLabel = `Hot-Cue Wordplay (${seq.map((n) => n + 1).join('-')})`;
          }

          // Feature #3: 4-Stage Staircase Roll Escalation & 1-Beat Silence Drop
          if (trick.action === 'staircase-drop-build' && inWindow) {
            if (localP < 0.36) {
              if (sess.staircaseStage < 1) {
                sess.staircaseStage = 1;
                handleToggleLoop(outId, 2);
              }
              if (outDeck.playbackMode === 'webaudio') djEngine.setDeckStereoWidth(outId, 0.72);
              outFilter = 0.22;
              xf = startXf;
              activeLabel = 'Staircase 1/4 · 2-Bar Lock';
            } else if (localP < 0.6) {
              if (sess.staircaseStage < 2) {
                sess.staircaseStage = 2;
                handleToggleLoop(outId, 1);
              }
              if (outDeck.playbackMode === 'webaudio') djEngine.setDeckStereoWidth(outId, 0.48);
              outFilter = 0.42;
              xf = startXf * 0.85 + endXf * 0.15;
              activeLabel = 'Staircase 2/4 · 1-Bar Roll + Riser';
            } else if (localP < 0.8) {
              if (sess.staircaseStage < 3) {
                sess.staircaseStage = 3;
                handleToggleLoop(outId, 0.5);
                if (!state.muteSoundTricks) {
                  void djEngine.scheduleBuildUpSequence({
                    bpm: currentTargetBpm,
                    musicalKey: activeKey,
                    pitchRate: inRate,
                    bars: 1,
                  });
                }
              }
              if (outDeck.playbackMode === 'webaudio') djEngine.setDeckStereoWidth(outId, 0.28);
              const chopOpen = Math.floor(elapsed / Math.max(110, beatMs * 0.25)) % 2 === 0;
              xf = chopOpen ? startXf * 0.5 : endXf * 0.5;
              outFilter = 0.62;
              activeLabel = 'Staircase 3/4 · Sample-Accurate Build';
            } else if (localP < 0.9) {
              if (sess.staircaseStage < 4) {
                sess.staircaseStage = 4;
                handleExitLoop(outId);
              }
              outChannelVolume = 0;
              inChannelVolume = 0;
              activeLabel = 'Staircase 4/4 · 1-Beat Silence Gap...';
            } else {
              if (sess.staircaseStage < 5) {
                sess.staircaseStage = 5;
                handleExitLoop(outId);
                if (inDeck.playbackMode === 'webaudio') {
                  djEngine.setDeckStereoWidth(inId, 1.25);
                  sess.widthSlamUntilMs = nowMs + 1800;
                }
              }
              outChannelVolume = 0;
              inChannelVolume = 0.94;
              xf = endXf;
              inEqLow = 0.08;
              inEqMid = 0;
              inEqHigh = 0;
              activeLabel = 'DROP SLAM · Chorus Cutover';
            }
          }

          if (inWindow) {
            if (
              trick.action !== 'staircase-drop-build' &&
              trick.action !== 'cue-wordplay-juggle'
            ) {
              activeLabel = trick.label;
            }

            // Feature #1A + Upgrade #3: Crossfader Pattern Sequencers + Real AudioBuffer Turntable Scratch
            if (trick.action === 'xfade-chop-16th') {
              const gate = Math.floor(elapsed / Math.max(95, beatMs * 0.25)) % 2 === 0;
              xf = gate ? startXf * (1 - localP * 0.6) : endXf * (0.4 + localP * 0.6);
              if (
                outDeck.playbackMode === 'webaudio' &&
                nowMs - sess.lastScratchAtMs >= Math.max(300, beatMs * 1.6)
              ) {
                sess.lastScratchAtMs = nowMs;
                djEngine.triggerDeckTurntableScratch(outId, {
                  currentSec: getLiveTime(outId),
                  bpm: currentTargetBpm,
                  pattern: 'baby',
                  preferHarmonic: true,
                });
              }
              activeLabel = '1/8-Beat Scratch Chop Sequencer';
            } else if (trick.action === 'xfade-ping-pong') {
              const ping = Math.floor(elapsed / Math.max(220, beatMs * 2)) % 2 === 0;
              xf = ping ? startXf * 0.85 : endXf * 0.85;
              activeLabel = '2-Beat Deck Ping-Pong A↔B';
            } else if (trick.action === 'transformer-cut') {
              const stab = Math.floor(elapsed / Math.max(95, beatMs * 0.25)) % 4;
              xf = stab === 0 || stab === 2 ? endXf * 0.88 : startXf * 0.72;
              if (
                outDeck.playbackMode === 'webaudio' &&
                nowMs - sess.lastScratchAtMs >= Math.max(260, beatMs * 1.35)
              ) {
                sess.lastScratchAtMs = nowMs;
                djEngine.triggerDeckTurntableScratch(outId, {
                  currentSec: getLiveTime(outId),
                  bpm: currentTargetBpm,
                  pattern: stab % 2 === 0 ? '2click-flare' : 'crab',
                  preferHarmonic: true,
                });
              }
              activeLabel = 'Turntable Transformer Scratch';
            } else if (trick.action === 'eq-bass-swap') {
              if (localP < 0.5) {
                outEqLow = -0.35 * localP;
                inEqLow = -0.88;
              } else {
                outEqLow = -0.95;
                inEqLow = 0;
              }
            } else if (trick.action === 'stem-mid-swap') {
              outEqMid = -0.75 * localP;
              inEqMid = 0.22 * (1 - Math.abs(localP - 0.5));
            } else if (trick.action === 'double-drop-sync') {
              xf = 0;
              const toggle = Math.floor(localP * 4) % 2 === 0;
              outEqLow = toggle ? 0 : -0.9;
              inEqLow = toggle ? -0.9 : 0;
              outFilter = Math.sin(localP * Math.PI) * 0.35;
            } else if (trick.action === 'kill-drop-slam') {
              if (localP < 0.72) {
                outKillLow = true;
                outKillHigh = true;
                inEqLow = -0.95;
              } else {
                outKillLow = true;
                inEqLow = 0.08;
                inEqMid = 0;
                inEqHigh = 0;
                xf = endXf * 0.85;
              }
            } else if (trick.action === 'phrase-drop-swap') {
              if (localP < 0.42) {
                const ramp = localP / 0.42;
                outEqLow = -0.35 * ramp;
                inEqLow = -0.92;
                outFilter = 0.38 * ramp;
              } else {
                outEqLow = -0.98;
                outKillLow = true;
                inEqLow = 0.08;
                inEqMid = 0;
                inEqHigh = 0;
                xf = startXf * 0.15 + endXf * 0.85;
              }
            } else if (trick.action === 'lpf-underwater-blend') {
              outFilter = -0.72 * Math.sin(localP * Math.PI * 0.5);
              inEqHigh = 0.15;
            } else if (trick.action === 'filter-sweep') {
              outFilter = Math.sin(localP * Math.PI * 0.5) * 0.72 * trick.intensity;
            } else if (trick.action === 'echo-out') {
              outFx = { enabled: true, type: 'echo', wet: 0.25 + localP * 0.55, beatDiv: 0.5 };
            } else if (trick.action === 'echo-freeze-cut') {
              outFx = { enabled: true, type: 'echo', wet: 0.4 + localP * 0.52, beatDiv: 0.5 };
              if (localP > 0.65) {
                outFilter = 0.55;
                xf = startXf * 0.15 + endXf * 0.85;
              }
            } else if (trick.action === 'reverb-wash') {
              outFx = { enabled: true, type: 'reverb', wet: 0.25 + localP * 0.6, beatDiv: 0.5 };
            } else if (trick.action === 'flanger-riser') {
              outFx = { enabled: true, type: 'flanger', wet: 0.35 + localP * 0.45, beatDiv: 0.25 };
            } else if (trick.action === 'phaser-swirl') {
              outFx = {
                enabled: true,
                type: 'phaser',
                wet: 0.32 + localP * 0.55 * trick.intensity,
                beatDiv: 0.5,
              };
            } else if (trick.action === 'bitcrush-breakdown') {
              outFx = {
                enabled: true,
                type: 'bitcrush',
                wet: 0.25 + localP * 0.65 * trick.intensity,
                beatDiv: 0.5,
              };
              outFilter = 0.22 * localP;
            } else if (trick.action === 'tremolo-gate') {
              outFx = {
                enabled: true,
                type: 'tremolo',
                wet: 0.45 + localP * 0.45 * trick.intensity,
                beatDiv: 0.25,
              };
            } else if (trick.action === 'chorus-shimmer') {
              if (trick.targetDeck === 'incoming') {
                inFx = {
                  enabled: true,
                  type: 'chorus',
                  wet: 0.35 + (1 - localP) * 0.4 * trick.intensity,
                  beatDiv: 0.5,
                };
              } else {
                outFx = {
                  enabled: true,
                  type: 'chorus',
                  wet: 0.35 + localP * 0.4 * trick.intensity,
                  beatDiv: 0.5,
                };
              }
            } else if (trick.action === 'ringmod-morph') {
              outFx = {
                enabled: true,
                type: 'ringmod',
                wet: 0.28 + localP * 0.56 * trick.intensity,
                beatDiv: 0.25 + Math.floor(localP * 3) * 0.25,
              };
            } else if (trick.action === 'autopan-drift') {
              outFx = {
                enabled: true,
                type: 'autopan',
                wet: 0.35 + localP * 0.55 * trick.intensity,
                beatDiv: 0.5,
              };
            } else if (trick.action === 'comb-resonator') {
              outFx = {
                enabled: true,
                type: 'comb',
                wet: 0.3 + localP * 0.52 * trick.intensity,
                beatDiv: 0.25 + Math.floor(localP * 3) * 0.25,
              };
            } else if (trick.action === 'stutter-drop') {
              outFx = {
                enabled: true,
                type: 'stutter',
                wet: 0.44 + localP * 0.48 * trick.intensity,
                beatDiv: 0.25,
              };
            } else if (trick.action === 'subharm-boost') {
              if (trick.targetDeck === 'incoming') {
                inFx = {
                  enabled: true,
                  type: 'subharm',
                  wet: 0.35 + localP * 0.45 * trick.intensity,
                  beatDiv: 0.5,
                };
              } else {
                outFx = {
                  enabled: true,
                  type: 'subharm',
                  wet: 0.35 + localP * 0.45 * trick.intensity,
                  beatDiv: 0.5,
                };
              }
            } else if (trick.action === 'shimmer-lift') {
              if (trick.targetDeck === 'incoming') {
                inFx = {
                  enabled: true,
                  type: 'shimmer',
                  wet: 0.3 + (1 - localP * 0.5) * 0.48 * trick.intensity,
                  beatDiv: 0.5,
                };
              } else {
                outFx = {
                  enabled: true,
                  type: 'shimmer',
                  wet: 0.3 + localP * 0.52 * trick.intensity,
                  beatDiv: 0.5,
                };
              }
            } else if (trick.action === 'lofi-tape-warp') {
              outFx = {
                enabled: true,
                type: 'lofi',
                wet: 0.35 + localP * 0.55 * trick.intensity,
                beatDiv: 0.5,
              };
            } else if (trick.action === 'dubdelay-throw') {
              outFx = {
                enabled: true,
                type: 'dubdelay',
                wet: 0.32 + localP * 0.55 * trick.intensity,
                beatDiv: 0.75,
              };
            } else if (trick.action === 'chop-cut') {
              const gate = Math.floor(localP * 8) % 2 === 0;
              xf = gate ? startXf * 0.2 : endXf * 0.85;
            } else if (trick.action === 'vinyl-brake') {
              outRate = Math.max(0.35, 1 - localP * 0.65);
              if (outDeck.playbackMode === 'webaudio' && !sess.tapeBrakeFired) {
                sess.tapeBrakeFired = true;
                djEngine.triggerDeckTapeBrake(
                  outId,
                  Math.min(1.4, Math.max(0.45, (trick.durationProgress * sess.transitionDurationMs) / 1000))
                );
              }
            }
          }
        });

        // Advance #4: Software PLL "Jog-Wheel Nudge" Anti-Drift Lock for YouTube IFrames
        const hasVinylBrake = sess.plan.tricks.some((t) => t.action === 'vinyl-brake');
        if (
          !hasVinylBrake &&
          sess.staircaseStage < 4 &&
          inDeck.playbackMode === 'youtube-iframe' &&
          outDeck.isPlaying &&
          inDeck.isPlaying
        ) {
          if (sess.pllNudgedDeck === inId && nowMs < sess.pllNudgeUntilMs) {
            inRate = sess.pllBaseRate;
          } else {
            if (sess.pllNudgedDeck === inId && nowMs >= sess.pllNudgeUntilMs) {
              ytPlayersRef.current[inId]?.setPlaybackRate(inRate);
              sess.pllNudgedDeck = null;
            }
            if (nowMs - sess.pllLastCheckMs >= 650 && p > 0.08 && p < 0.88) {
              sess.pllLastCheckMs = nowMs;
              const beatSecNow = 60 / Math.max(70, currentTargetBpm);
              const outBeatSec = 60 / Math.max(60, outDeck.baseBpm);
              const inBeatSec = 60 / Math.max(60, inDeck.baseBpm * fold);
              const outT = getLiveTime(outId);
              const inT = getLiveTime(inId);
              const outFirst = outDeck.track?.firstBeatSec || 0;
              const inFirst = inDeck.track?.firstBeatSec || 0;
              const outPhase =
                ((((outT - outFirst) % outBeatSec) + outBeatSec) % outBeatSec) / outBeatSec;
              const inPhase =
                ((((inT - inFirst) % inBeatSec) + inBeatSec) % inBeatSec) / inBeatSec;
              let phaseDiff = outPhase - inPhase;
              if (phaseDiff > 0.5) phaseDiff -= 1;
              if (phaseDiff < -0.5) phaseDiff += 1;
              const driftMs = phaseDiff * beatSecNow * 1000;
              if (Math.abs(driftMs) > 35) {
                const nudgeFactor = phaseDiff > 0 ? 1.024 : 0.976;
                const nudgeRate = Math.max(0.5, Math.min(1.5, inRate * nudgeFactor));
                ytPlayersRef.current[inId]?.setPlaybackRate(nudgeRate);
                sess.pllNudgedDeck = inId;
                sess.pllBaseRate = nudgeRate;
                sess.pllNudgeUntilMs = nowMs + 460;
                inRate = nudgeRate;
              }
            }
          }
        }

        setMixerState((m) => ({ ...m, crossfader: xf }));

        if (outDeck.playbackMode === 'webaudio') {
          djEngine.setDeckRate(outId, outRate);
        }
        if (inDeck.playbackMode === 'webaudio') {
          djEngine.setDeckRate(inId, inRate);
        }

        setDeckState(outId, (prev) => ({
          ...prev,
          channelVolume: outChannelVolume,
          eqLow: outEqLow,
          eqMid: outEqMid,
          eqHigh: outEqHigh,
          killLow: outKillLow,
          killHigh: outKillHigh,
          filter: outFilter,
          playbackRate: outRate,
          fx: outFx
            ? { ...prev.fx, ...outFx }
            : prev.fx.enabled
            ? { ...prev.fx, enabled: false }
            : prev.fx,
        }));

        setDeckState(inId, (prev) => ({
          ...prev,
          channelVolume: inChannelVolume,
          eqLow: inEqLow,
          eqMid: inEqMid,
          eqHigh: inEqHigh,
          filter: inFilter,
          playbackRate: inRate,
          fx: inFx
            ? { ...prev.fx, ...inFx }
            : prev.fx.enabled
            ? { ...prev.fx, enabled: false }
            : prev.fx,
        }));

        setAutopilotState((prev) => ({
          ...prev,
          transitionProgress: p,
          currentActionLabel: activeLabel,
        }));

        if (p >= 1) {
          // Record Offline Taste Learning positive Q-score reward for completed transition
          const fxUsed = sess.plan.songMoments.map((m) => m.fxType);
          recordAiFeedbackEvent({
            outcome: 'completed',
            outTrackId: outDeck.track?.id,
            inTrackId: inDeck.track?.id,
            mixStyleKey: sess.plan.mixStyleKey,
            fxTypes: fxUsed,
            aggressiveness: state.aggressiveness,
          });

          if (sess.aiAutoBridgeActive) {
            sess.aiAutoBridgeActive = false;
            djEngine.stopGrooveBridge();
          }

          // Wave-3 #1: Capture 1-bar vocal hook from outgoing WebAudio deck into Remix Deck C before it exits
          if (outDeck.playbackMode === 'webaudio') {
            djEngine.captureDeckVocalHook(outId, {
              bpm: outDeck.baseBpm,
              dropCueSec: outDeck.track?.dropCueSec ?? outDeck.detectedDropSec,
              waveform: outDeck.waveform,
              title: outDeck.track?.title,
            });
          }

          // Wave-3 #5: Update rolling Set Tension Score & Peak Mix Streak
          if (sess.plan.isBreatherMix) {
            sess.peakMixStreak = 0;
            sess.setTensionScore = Math.max(25, sess.setTensionScore - 36);
          } else {
            const wasPeak =
              state.aggressiveness >= 60 ||
              state.vibe === 'festival-drop' ||
              state.vibe === 'scratch-chop' ||
              sess.plan.tricks.length >= 4;
            sess.peakMixStreak = wasPeak ? sess.peakMixStreak + 1 : Math.max(0, sess.peakMixStreak - 1);
            sess.setTensionScore = Math.max(
              20,
              Math.min(100, sess.setTensionScore + (wasPeak ? 22 : 8))
            );
          }

          djEngine.setDeckStereoWidth('A', 1);
          djEngine.setDeckStereoWidth('B', 1);
          sess.widthSlamUntilMs = 0;
          sess.tapeBrakeFired = false;
          sess.outroSafetyLoopActive = false;
          sess.rescueLoopActive = false;
          djEngine.setDeckSidechainDuck('A', 1);
          djEngine.setDeckSidechainDuck('B', 1);
          handleExitLoop(outId);

          const carryBars = sess.plan.vocalCarryoverBars || 0;
          const canVocalCarryover =
            carryBars > 0 &&
            outDeck.playbackMode === 'webaudio' &&
            outDeck.isPlaying;

          if (canVocalCarryover) {
            const carryBarSec = (60 / Math.max(70, inDeck.baseBpm)) * 4;
            const carryMs = Math.min(22000, Math.max(8000, carryBars * carryBarSec * 1000));
            sess.carryoverDeck = outId;
            sess.carryoverStartMs = nowMs;
            sess.carryoverUntilMs = nowMs + carryMs;
            setDeckState(outId, (prev) => ({
              ...prev,
              channelVolume: 0.82,
              eqLow: -0.95,
              eqMid: 0.24,
              eqHigh: 0.14,
              killLow: true,
              killMid: false,
              killHigh: false,
              filter: 0.28,
              stemMode: 'vocal-focus',
              isMaster: false,
              fx: { ...prev.fx, enabled: true, type: 'reverb', wet: 0.42, beatDiv: 0.5 },
            }));
            setMixerState((m) => ({ ...m, crossfader: endXf * 0.72 }));
          } else {
            handleTogglePlay(outId, false);
            setDeckState(outId, (prev) => ({
              ...prev,
              channelVolume: 0.9,
              eqLow: 0,
              eqMid: 0,
              eqHigh: 0,
              killLow: false,
              killMid: false,
              killHigh: false,
              filter: 0,
              playbackRate: 1,
              stemMode: 'off',
              isMaster: false,
              fx: { ...prev.fx, enabled: false },
            }));
            if (outDeck.playbackMode === 'webaudio') {
              djEngine.setDeckRate(outId, 1);
            } else if (outDeck.playbackMode === 'youtube-iframe') {
              ytPlayersRef.current[outId]?.setPlaybackRate(1);
            }
            setMixerState((m) => ({ ...m, crossfader: endXf }));
          }

          setDeckState(inId, (prev) => ({
            ...prev,
            channelVolume: 0.9,
            eqLow: 0,
            eqMid: 0,
            eqHigh: 0,
            filter: 0,
            playbackRate: 1,
            semitoneShift: 0,
            isMaster: true,
            syncLocked: false,
            fx: { ...prev.fx, enabled: false },
          }));
          if (inDeck.playbackMode === 'webaudio') {
            djEngine.setDeckRate(inId, 1);
            djEngine.setDeckSemitoneShift(inId, 0);
          } else if (inDeck.playbackMode === 'youtube-iframe') {
            ytPlayersRef.current[inId]?.setPlaybackRate(1);
          }

          sess.plan = null;
          sess.staircaseStage = 0;
          sess.pllNudgedDeck = null;

          if (canVocalCarryover) {
            sess.outgoingDeck = inId;
            sess.incomingDeck = outId;
            setAutopilotState((prev) => ({
              ...prev,
              phase: 'cruising',
              transitionProgress: 0,
              nextTransitionEtaSec: null,
              holdExtraBars: 0,
              currentActionLabel: `Vocal Carryover (+${carryBars}b) over "${inDeck.track?.title || 'Incoming Track'}"`,
            }));
          } else {
            setAutopilotState((prev) => ({
              ...prev,
              phase: 'planning',
              transitionProgress: 0,
              nextTransitionEtaSec: null,
              holdExtraBars: 0,
              currentActionLabel: `Now Playing: ${inDeck.track?.title || 'Incoming Track'}`,
            }));
            requestNextAiPlan(inId, state.vibe, undefined, state.targetPlaylistId, state.remixMode);
          }
        }
      }
    }, 40);

    return () => clearInterval(timer);
  }, [
    autopilot.enabled,
    autopilot.mashupRoutineActive,
    autopilot.grooveBridgePattern,
    beginAiTransitionNow,
    getLiveTime,
    handleBeatJump,
    handleExitLoop,
    handleSeek,
    handleToggleLoop,
    handleTogglePlay,
    isAnyVoiceEnabled,
    playAnyVoiceDrop,
    requestNextAiPlan,
    setAutopilotState,
    setDeckState,
    setMixerState,
  ]);

  const handleImportFiles = useCallback(
    async (files: FileList) => {
      for (const file of Array.from(files)) {
        try {
          const arr = await file.arrayBuffer();
          const buf = await djEngine.decodeAudioData(arr.slice(0));
          const detected = detectBpmAndGrid(buf);
          const tempoMap = buildElasticTempoMap(buf, detected.bpm, detected.firstBeatSec);
          const keyInfo = detectCamelotKey(buf);
          const loudness = estimateTrackLoudnessGain(buf);
          const id = `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
          localFileBuffersRef.current.set(id, arr);

          const cleanTitle = file.name.replace(/\.[^/.]+$/, '');
          const track: TrackItem = {
            id,
            title: cleanTitle,
            artist: 'Local Audio File',
            bpm: detected.bpm,
            musicalKey: keyInfo.confidence >= 0.25 ? keyInfo.musicalKey : '8A',
            durationSec: buf.duration,
            sourceType: 'local',
            firstBeatSec: detected.firstBeatSec,
            tempoMap,
            autoTrimGain: loudness.autoTrimGain,
            addedAt: Date.now(),
          };
          library.addTrack(
            track,
            library.activePlaylistId !== 'all' ? library.activePlaylistId : undefined
          );
        } catch {
          // skip unreadable audio file
        }
      }
    },
    [library]
  );

  const handleStartRecording = async (includeTabAudio: boolean) => {
    await djEngine.startRecording(includeTabAudio);
    setRecordingSec(0);
    setIsRecording(true);
  };

  const handleStopRecording = () => {
    const result = djEngine.stopRecording();
    setIsRecording(false);
    if (result && result.blob.size > 44) {
      const url = URL.createObjectURL(result.blob);
      const count = library.recordings.length + 1;
      library.addRecording({
        id: `rec-${Date.now()}`,
        title: `DeckForge Set #${count}`,
        createdAt: Date.now(),
        durationSec: result.durationSec,
        format: 'wav',
        url,
        sizeBytes: result.blob.size,
      });
    }
  };

  // Upgrade #7: Faster-Than-Real-Time OfflineAudioContext AI Mixtape & 32-Bar Bootleg WAV Renderer
  const handleRenderAiRemixWav = useCallback(
    async (mode: 'mashup-32' | 'ai-transition', onProgress: (pct: number) => void) => {
      const dA = deckARef.current;
      const dB = deckBRef.current;
      if (!dA.track || !dB.track) {
        throw new Error('Load tracks on both Deck A and Deck B first.');
      }

      const resolveDeckAudio = async (id: DeckId, d: DeckState) => {
        const existing = djEngine.getDeckAudioBuffers(id);
        if (existing.buffer) return existing;
        if (d.track?.youtubeId) {
          const resp = await fetch(`/api/yt/stream/${encodeURIComponent(d.track.youtubeId)}`);
          if (resp.ok && resp.headers.get('content-type')?.includes('audio')) {
            const arr = await resp.arrayBuffer();
            const buf = await djEngine.decodeAudioData(arr);
            return { buffer: buf, harmonicBuffer: null, percussiveBuffer: null, bassBuffer: null };
          }
        }
        throw new Error(
          `Deck ${id} ("${d.track?.title}") is playing via cross-origin YouTube IFrame and cannot be offline-decoded.`
        );
      };

      onProgress(4);
      const audioA = await resolveDeckAudio('A', dA);
      const audioB = await resolveDeckAudio('B', dB);

      const res = await renderOfflineAiRemixWav({
        mode,
        deckA: {
          track: dA.track,
          buffer: audioA.buffer!,
          harmonicBuffer: audioA.harmonicBuffer,
          percussiveBuffer: audioA.percussiveBuffer,
          bassBuffer: audioA.bassBuffer,
        },
        deckB: {
          track: dB.track,
          buffer: audioB.buffer!,
          harmonicBuffer: audioB.harmonicBuffer,
          percussiveBuffer: audioB.percussiveBuffer,
          bassBuffer: audioB.bassBuffer,
        },
        vibe: autopilotRef.current.vibe,
        aggressiveness: autopilotRef.current.aggressiveness,
        onProgress,
      });

      const url = URL.createObjectURL(res.blob);
      libraryRef.current.addRecording({
        id: `render-${Date.now()}`,
        title: res.title,
        createdAt: Date.now(),
        durationSec: res.durationSec,
        format: 'wav',
        url,
        sizeBytes: res.blob.size,
      });
    },
    []
  );

  const handleTriggerSoundTrick = (trick: SoundTrickType) => {
    const masterDeck = deckA.isMaster ? deckA : deckB;
    const activeDeck = masterDeck.track ? masterDeck : deckA.track ? deckA : deckB;
    const bpm = activeDeck.track ? activeDeck.baseBpm * activeDeck.playbackRate : 124;
    const pitchRate = activeDeck.playbackMode === 'webaudio' ? activeDeck.playbackRate : 1;
    djEngine.playSoundTrick(trick, bpm, activeDeck.track?.musicalKey, pitchRate);
    if (trick === 'scratch-chirp' && activeDeck.playbackMode === 'webaudio') {
      djEngine.triggerDeckTurntableScratch(activeDeck.deckId, {
        currentSec: getLiveTime(activeDeck.deckId),
        bpm,
        pattern: 'chirp',
        preferHarmonic: true,
      });
    }
  };

  const handleTriggerVoice = (voiceId: DjVoiceDropId) => {
    const masterDeck = deckA.isMaster ? deckA : deckB;
    const activeDeck = masterDeck.track ? masterDeck : deckA.track ? deckA : deckB;
    const bpm = activeDeck.track ? activeDeck.baseBpm * activeDeck.playbackRate : 124;
    const pitchRate = activeDeck.playbackMode === 'webaudio' ? activeDeck.playbackRate : 1;
    djEngine.playVoiceDrop(voiceId, bpm, activeDeck.track?.musicalKey, pitchRate);
    setAutopilotState((prev) => ({
      ...prev,
      currentActionLabel: `Voice Pad · ${VOICE_PRESET_MAP[voiceId].calloutText}`,
    }));
  };

  // Keyboard shortcuts for live performance & drawer toggle
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsCrateOpen(false);
        return;
      }

      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      const key = e.key.toLowerCase();
      if (e.key === 'Tab') {
        e.preventDefault();
        setIsCrateOpen((v) => !v);
      } else if (key === 'q') {
        e.preventDefault();
        handleTogglePlay('A');
      } else if (key === 'p') {
        e.preventDefault();
        handleTogglePlay('B');
      } else if (key === 'a') {
        e.preventDefault();
        handleCue('A');
      } else if (key === 'l') {
        e.preventDefault();
        handleCue('B');
      } else if (key === 's') {
        e.preventDefault();
        handleSync('A');
      } else if (key === 'k') {
        e.preventDefault();
        handleSync('B');
      } else if (e.key === 'ArrowLeft') {
        setMixerState((m) => ({ ...m, crossfader: Math.max(-1, m.crossfader - 0.1) }));
      } else if (e.key === 'ArrowRight') {
        setMixerState((m) => ({ ...m, crossfader: Math.min(1, m.crossfader + 0.1) }));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleCue, handleSync, handleTogglePlay, setMixerState]);

  const deckProps = (deck: DeckState) => ({
    deck,
    getLiveTime,
    onTogglePlay: () => handleTogglePlay(deck.deckId),
    onCue: () => handleCue(deck.deckId),
    onSync: () => handleSync(deck.deckId),
    onSetMaster: () => {
      const other: DeckId = deck.deckId === 'A' ? 'B' : 'A';
      setDeckState(deck.deckId, (p) => ({ ...p, isMaster: true, syncLocked: false }));
      setDeckState(other, (p) => ({ ...p, isMaster: false }));
    },
    onSeek: (t: number) => handleSeek(deck.deckId, t),
    onNudgePitch: (delta: number) => {
      const d = getDeckRef(deck.deckId);
      handlePitchChange(deck.deckId, d.playbackRate + delta);
    },
    onPitchChange: (rate: number) => handlePitchChange(deck.deckId, rate),
    onPitchRangeChange: (pitchRange: 0.08 | 0.16 | 0.5) =>
      setDeckState(deck.deckId, (p) => ({ ...p, pitchRange })),
    onToggleKeyLock: () =>
      setDeckState(deck.deckId, (p) => {
        const nextLock = !p.keyLock;
        if (p.playbackMode === 'webaudio') {
          djEngine.setDeckKeyLock(deck.deckId, nextLock);
        }
        return { ...p, keyLock: nextLock };
      }),
    onHotCueTrigger: (idx: number) => {
      const d = getDeckRef(deck.deckId);
      const hc = d.hotCues[idx];
      if (hc.timeSec === null) {
        const now = getLiveTime(deck.deckId);
        setDeckState(deck.deckId, (prev) => ({
          ...prev,
          hotCues: prev.hotCues.map((c) => (c.index === idx ? { ...c, timeSec: now } : c)),
        }));
      } else {
        handleSeek(deck.deckId, hc.timeSec);
      }
    },
    onHotCueClear: (idx: number) =>
      setDeckState(deck.deckId, (prev) => ({
        ...prev,
        hotCues: prev.hotCues.map((c) => (c.index === idx ? { ...c, timeSec: null } : c)),
      })),
    onToggleLoop: (bars: number) => handleToggleLoop(deck.deckId, bars),
    onExitLoop: () => handleExitLoop(deck.deckId),
    onBeatJump: (beats: number) => handleBeatJump(deck.deckId, beats),
    onFxChange: (patch: Partial<DeckFxState>) =>
      setDeckState(deck.deckId, (prev) => ({
        ...prev,
        fx: { ...prev.fx, ...patch },
      })),
    onTapBpm: (newBpm: number) =>
      setDeckState(deck.deckId, (prev) => {
        if (prev.track) library.updateTrackMeta(prev.track.id, { bpm: newBpm });
        return {
          ...prev,
          baseBpm: newBpm,
          track: prev.track ? { ...prev.track, bpm: newBpm, calibrated: true } : null,
        };
      }),
    onMarkDropCue: () => {
      const d = getDeckRef(deck.deckId);
      if (!d.track) return;
      const nowSec = Math.round(getLiveTime(deck.deckId) * 100) / 100;
      library.updateTrackMeta(d.track.id, { dropCueSec: nowSec });
      setDeckState(deck.deckId, (prev) => ({
        ...prev,
        track: prev.track ? { ...prev.track, dropCueSec: nowSec, calibrated: true } : null,
        hotCues: prev.hotCues.map((c) =>
          c.index === 3 ? { ...c, timeSec: nowSec, label: 'Drop' } : c
        ),
      }));
    },
    onCycleMusicalKey: () => {
      const d = getDeckRef(deck.deckId);
      if (!d.track) return;
      const curIdx = ALL_CAMELOT_KEYS.indexOf(d.track.musicalKey.toUpperCase());
      const nextKey = ALL_CAMELOT_KEYS[(curIdx + 1) % ALL_CAMELOT_KEYS.length];
      library.updateTrackMeta(d.track.id, { musicalKey: nextKey });
      setDeckState(deck.deckId, (prev) => ({
        ...prev,
        track: prev.track ? { ...prev.track, musicalKey: nextKey, calibrated: true } : null,
      }));
    },
    onCycleStemMode: () => {
      const order: StemIsolationMode[] = ['off', 'vocal-focus', 'instrumental', 'drums-only'];
      setDeckState(deck.deckId, (prev) => {
        const next = order[(order.indexOf(prev.stemMode) + 1) % order.length];
        return { ...prev, stemMode: next };
      });
    },
  });

  // Upgrade #7: Interactive AI Remix Markers projected onto DualWaveformDisplay
  const aiMarkers = useMemo<WaveformAiMarker[]>(() => {
    if (!autopilot.enabled || autopilot.phase !== 'cruising' || !autopilot.activePlan) {
      return [];
    }
    const plan = autopilot.activePlan;
    const outId = aiSessionRef.current.outgoingDeck;
    const outDeck = outId === 'A' ? deckA : deckB;
    const dur = Math.max(10, outDeck.duration);
    const barSec = (60 / Math.max(65, outDeck.baseBpm * outDeck.playbackRate)) * 4;
    const mutedSet = new Set(autopilot.mutedMomentIndices || []);
    const markers: WaveformAiMarker[] = [];

    (plan.songMoments || []).forEach((m, idx) => {
      markers.push({
        id: `moment-${idx}`,
        deckId: outId,
        kind: m.isVipDropFakeout ? 'fakeout' : 'moment',
        timeSec: Math.round(m.atPct * dur * 100) / 100,
        label: m.label,
        muted: mutedSet.has(idx),
        momentIndex: idx,
      });
    });

    if (plan.vipSkipEdit) {
      markers.push({
        id: 'vip-skip',
        deckId: outId,
        kind: 'vip-skip',
        timeSec: Math.round(plan.vipSkipEdit.triggerPct * dur * 100) / 100,
        label: plan.vipSkipEdit.label,
      });
    }

    if (plan.teasePreview) {
      markers.push({
        id: 'tease-preview',
        deckId: outId,
        kind: 'tease',
        timeSec: Math.round(plan.teasePreview.triggerPct * dur * 100) / 100,
        label: plan.teasePreview.label,
      });
    }

    const baseThreshold = autopilot.quickMix ? 0.34 : autopilot.remixMode ? 0.48 : 0.62;
    const pocketTargetPct = plan.recommendedOutStartPct
      ? Math.max(baseThreshold * 0.92, Math.min(0.8, plan.recommendedOutStartPct))
      : baseThreshold;
    const mixOutPct = Math.min(0.88, pocketTargetPct + (autopilot.holdExtraBars * barSec) / dur);
    markers.push({
      id: 'mix-out',
      deckId: outId,
      kind: 'mix-out',
      timeSec: Math.round(Math.min(dur - 8, dur * mixOutPct) * 100) / 100,
      label: `Mix Out (${plan.mixStyle})`,
    });

    return markers;
  }, [
    autopilot.enabled,
    autopilot.phase,
    autopilot.activePlan,
    autopilot.mutedMomentIndices,
    autopilot.quickMix,
    autopilot.remixMode,
    autopilot.holdExtraBars,
    deckA,
    deckB,
  ]);

  const handleTriggerAiMarker = useCallback(
    async (marker: WaveformAiMarker) => {
      const plan = aiSessionRef.current.plan;
      if (!plan) return;
      if (marker.kind === 'mix-out') {
        await beginAiTransitionNow(true);
        return;
      }
      if (marker.kind === 'vip-skip' && plan.vipSkipEdit) {
        handleSeek(marker.deckId, plan.vipSkipEdit.targetSec);
        setAutopilotState((p) => ({ ...p, currentActionLabel: `Previewed ${plan.vipSkipEdit!.label}` }));
        return;
      }
      if (marker.kind === 'tease' && plan.teasePreview) {
        handleSeek(marker.deckId, marker.timeSec);
        setAutopilotState((p) => ({ ...p, currentActionLabel: `Seeking to ${plan.teasePreview!.label}` }));
        return;
      }
      if (typeof marker.momentIndex === 'number') {
        const m = plan.songMoments?.[marker.momentIndex];
        const d = getDeckRef(marker.deckId);
        if (!m || !d.track) return;
        const bpm = Math.max(70, d.baseBpm * d.playbackRate);
        const pitchRate = d.playbackMode === 'webaudio' ? d.playbackRate : 1;
        if (m.useSampleAccurateBuild) {
          void djEngine.scheduleBuildUpSequence({
            bpm,
            musicalKey: d.track.musicalKey,
            pitchRate,
            bars: 1,
          });
        } else if (m.soundTrick) {
          djEngine.playSoundTrick(m.soundTrick, bpm, d.track.musicalKey, pitchRate);
        }
        if (m.voiceDropId && autopilotRef.current.voiceFxEnabled && isAnyVoiceEnabled(m.voiceDropId)) {
          void playAnyVoiceDrop(m.voiceDropId, bpm, d.track.musicalKey, pitchRate);
        }
        setAutopilotState((p) => ({ ...p, currentActionLabel: `Auditioned · ${m.label}` }));
      }
    },
    [beginAiTransitionNow, handleSeek, isAnyVoiceEnabled, playAnyVoiceDrop, setAutopilotState]
  );

  const handleToggleMuteAiMarker = useCallback(
    (marker: WaveformAiMarker) => {
      if (typeof marker.momentIndex === 'number') {
        const idx = marker.momentIndex;
        setAutopilotState((prev) => {
          const cur = prev.mutedMomentIndices || [];
          const has = cur.includes(idx);
          const next = has ? cur.filter((x) => x !== idx) : [...cur, idx];
          return {
            ...prev,
            mutedMomentIndices: next,
            currentActionLabel: `${has ? 'Unmuted' : 'Muted'} AI Marker · ${marker.label}`,
          };
        });
      } else if (marker.kind === 'tease') {
        aiSessionRef.current.teaseFired = !aiSessionRef.current.teaseFired;
        setAutopilotState((prev) => ({
          ...prev,
          currentActionLabel: aiSessionRef.current.teaseFired
            ? 'Breakdown Tease muted for this track'
            : 'Breakdown Tease re-enabled',
        }));
      } else if (marker.kind === 'vip-skip') {
        aiSessionRef.current.vipSkipFired = !aiSessionRef.current.vipSkipFired;
        setAutopilotState((prev) => ({
          ...prev,
          currentActionLabel: aiSessionRef.current.vipSkipFired
            ? 'VIP Skip muted for this track'
            : 'VIP Skip re-enabled',
        }));
      }
    },
    [setAutopilotState]
  );

  const handleMoveAiMarker = useCallback(
    (marker: WaveformAiMarker, newTimeSec: number) => {
      const d = getDeckRef(marker.deckId);
      const dur = Math.max(10, d.duration);
      const newPct = Math.round(Math.max(0.05, Math.min(0.88, newTimeSec / dur)) * 1000) / 1000;
      const sessPlan = aiSessionRef.current.plan;
      if (!sessPlan) return;

      let updatedPlan: AiTransitionPlan = sessPlan;
      if (typeof marker.momentIndex === 'number') {
        const nextMoments = (sessPlan.songMoments || []).map((m, i) =>
          i === marker.momentIndex ? { ...m, atPct: newPct } : m
        );
        updatedPlan = { ...sessPlan, songMoments: nextMoments };
      } else if (marker.kind === 'vip-skip' && sessPlan.vipSkipEdit) {
        updatedPlan = {
          ...sessPlan,
          vipSkipEdit: { ...sessPlan.vipSkipEdit, triggerPct: newPct },
        };
      } else if (marker.kind === 'tease' && sessPlan.teasePreview) {
        updatedPlan = {
          ...sessPlan,
          teasePreview: { ...sessPlan.teasePreview, triggerPct: newPct },
        };
      } else if (marker.kind === 'mix-out') {
        updatedPlan = { ...sessPlan, recommendedOutStartPct: newPct };
      }

      aiSessionRef.current.plan = updatedPlan;
      setAutopilotState((prev) => ({
        ...prev,
        holdExtraBars: marker.kind === 'mix-out' ? 0 : prev.holdExtraBars,
        activePlan: updatedPlan,
        currentActionLabel: `Moved ${marker.kind.toUpperCase()} → ${newTimeSec.toFixed(1)}s`,
      }));
    },
    [setAutopilotState]
  );

  const formatRecClock = (sec: number) => {
    const s = Math.floor(sec);
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };

  return (
    <div className="min-h-screen lg:h-screen lg:overflow-hidden bg-[#090B0F] text-slate-100 flex flex-col pb-16 lg:pb-0">
      {/* Compact Top Bar (Strict 3-Zone Contract: Brand | Single-Line Nav | Primary CTA) */}
      <header className="sticky top-0 z-30 h-11 px-4 sm:px-5 bg-[#090B0F]/95 backdrop-blur-md border-b border-white/[0.08] flex items-center justify-between gap-8 shrink-0">
        <a
          href="/"
          onClick={(e) => e.preventDefault()}
          className="font-display text-base font-bold tracking-tight text-white whitespace-nowrap shrink-0"
        >
          DeckForge
        </a>

        <nav className="hidden lg:flex items-center gap-6 text-xs font-medium text-slate-300">
          <button
            type="button"
            onClick={() => setIsCrateOpen((v) => !v)}
            className={`h-7 px-2.5 rounded-md border flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 ${
              isCrateOpen
                ? 'bg-cyan-500 text-[#090B0F] border-cyan-400 font-semibold'
                : 'bg-[#151A24] border-white/15 text-slate-200 hover:border-cyan-400/50 hover:text-cyan-300'
            }`}
            title="Show or hide the Song Chooser & Playlist Sidebar (Tab)"
          >
            <ListMusic className="w-3.5 h-3.5" />
            <span>
              {isCrateOpen ? 'Hide Songs Sidebar' : `Playlists & Songs (${library.tracks.length})`}
            </span>
          </button>

          <button
            type="button"
            onClick={() => {
              setEditingPlaylist(null);
              setBuilderOpen(true);
            }}
            className="h-7 px-2.5 rounded-md bg-[#151A24] border border-white/15 text-slate-200 hover:text-white hover:border-white/30 flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
          >
            <FolderPlus className="w-3.5 h-3.5 text-cyan-400" />
            <span>Playlist Builder</span>
          </button>

          <span className="hidden xl:inline text-slate-400 whitespace-nowrap shrink-0">
            Keys: Tab Crate · Q/P Play · A/L Cue · S/K Sync
          </span>
        </nav>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => {
              if (isRecording) {
                handleStopRecording();
                setRecordingModalOpen(true);
              } else {
                setRecordingModalOpen(true);
              }
            }}
            className={`h-8 px-3 rounded-lg text-xs font-semibold flex items-center gap-1.5 border transition-colors whitespace-nowrap shrink-0 ${
              isRecording
                ? 'bg-red-600 border-red-500 text-white'
                : 'bg-[#151A24] border-white/15 text-slate-200 hover:text-white hover:border-white/30'
            }`}
          >
            {isRecording ? (
              <>
                <Square className="w-3 h-3 fill-current" />
                <span className="font-mono tabular-nums">REC {formatRecClock(recordingSec)}</span>
              </>
            ) : (
              <>
                <Circle className="w-2.5 h-2.5 fill-red-500 text-red-500" />
                <span>Record ({library.recordings.length})</span>
              </>
            )}
          </button>
        </div>
      </header>

      {/* Main 1-Monitor-Screen Cockpit Container */}
      <main className="w-full max-w-[1560px] mx-auto px-2.5 sm:px-4 py-2 flex flex-col gap-2 flex-1 min-h-0">
        {/* Stacked Dual Parallel RGB Waveform Display */}
        <div className={`${mobileTab === 'crate' ? 'hidden lg:block' : ''} shrink-0`}>
          <DualWaveformDisplay
            deckA={deckA}
            deckB={deckB}
            getLiveTime={getLiveTime}
            onScrub={handleSeek}
            aiMarkers={aiMarkers}
            onTriggerAiMarker={handleTriggerAiMarker}
            onToggleMuteAiMarker={handleToggleMuteAiMarker}
            onMoveAiMarker={handleMoveAiMarker}
          />
        </div>

        {/* Mobile Deck Switcher for Decks / FX tabs */}
        {(mobileTab === 'decks' || mobileTab === 'fx') && (
          <div className="flex lg:hidden items-center gap-2 bg-[#11151C] p-1 rounded-xl border border-white/[0.08]">
            <button
              type="button"
              onClick={() => setMobileActiveDeck('A')}
              className={`flex-1 min-h-[40px] rounded-lg text-xs font-display font-bold transition-colors ${
                mobileActiveDeck === 'A'
                  ? 'bg-cyan-500 text-[#090B0F]'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              DECK A · {deckA.track ? `${(deckA.baseBpm * deckA.playbackRate).toFixed(1)} BPM` : 'Empty'}
            </button>
            <button
              type="button"
              onClick={() => setMobileActiveDeck('B')}
              className={`flex-1 min-h-[40px] rounded-lg text-xs font-display font-bold transition-colors ${
                mobileActiveDeck === 'B'
                  ? 'bg-orange-500 text-[#090B0F]'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              DECK B · {deckB.track ? `${(deckB.baseBpm * deckB.playbackRate).toFixed(1)} BPM` : 'Empty'}
            </button>
          </div>
        )}

        {/* Desktop 3-Column Console Grid (Permanently Mounted Decks & Mixer) */}
        <div className="hidden lg:grid lg:grid-cols-[1fr_272px_1fr] gap-2.5 items-stretch shrink-0">
          <DeckPanel {...deckProps(deckA)} allowYoutubeMount={isDesktop} />
          <MixerConsole
            deckA={deckA}
            deckB={deckB}
            mixer={mixer}
            onDeckMixerChange={(id, patch) =>
              setDeckState(id, (prev) => ({ ...prev, ...patch }))
            }
            onMixerChange={(patch) => setMixerState((prev) => ({ ...prev, ...patch }))}
          />
          <DeckPanel {...deckProps(deckB)} allowYoutubeMount={isDesktop} />
        </div>

        {/* Full-Width Below-Deck AI Effects, Offline Randomness & Master Tricks Performance Stage (Desktop) */}
        <div className="hidden lg:flex flex-col flex-1 min-h-0">
          <AiAutopilotPanel
            autopilot={autopilot}
            deckA={deckA}
            deckB={deckB}
            playlists={library.playlists}
            totalTracksCount={library.tracks.length}
            mashupLoading={mashupLoading}
            onToggleAutopilot={handleToggleAutopilot}
            onToggleRemixMode={handleToggleRemixMode}
            onToggleQuickMix={handleToggleQuickMix}
            onEnergyModeChange={handleEnergyModeChange}
            onAggressivenessChange={handleAggressivenessChange}
            onRandomnessChange={handleRandomnessChange}
            onRegenerateTake={handleRegenerateTake}
            onTriggerWildTake={handleTriggerWildTake}
            onTargetPlaylistChange={handleTargetPlaylistChange}
            onVibeChange={(vibe) => setAutopilotState((p) => ({ ...p, vibe }))}
            onMixNow={() => beginAiTransitionNow(true)}
            onDirectAi={handleDirectAi}
            onMashupBlend={handleAiMashupBlend}
            onTriggerTrick={handleTriggerSoundTrick}
            onHoldExtraBars={handleHoldExtraBars}
            onSwapUpcomingStyle={handleSwapUpcomingStyle}
            onToggleMuteSfx={handleToggleMuteSfx}
            onToggleVoiceFx={handleToggleVoiceFx}
            onToggleVoiceItem={handleToggleVoiceItem}
            onSetVoiceCategoryEnabled={handleSetVoiceCategoryEnabled}
            onEnableAllVoices={handleEnableAllVoices}
            onTriggerVoice={handleTriggerVoice}
            customVoiceDrops={customVoiceDrops}
            recordingSlotId={recordingSlotId}
            micError={micError}
            onToggleRecordCustomSlot={handleToggleRecordCustomSlot}
            onUploadCustomSlot={handleUploadCustomSlot}
            onTriggerCustomSlot={handleTriggerCustomSlot}
            onToggleCustomSlotEnabled={handleToggleCustomSlotEnabled}
            onClearCustomSlot={handleClearCustomSlot}
            onCycleGrooveBridge={handleCycleGrooveBridge}
            onOpenCrate={() => setIsCrateOpen(true)}
          />
        </div>

        {/* Mobile Responsive Views (< lg) */}
        <div className="lg:hidden flex flex-col gap-3">
          {!isDesktop && (
            <div
              className="fixed bottom-0 right-0 flex gap-2 pointer-events-none opacity-0 -z-10"
              aria-hidden="true"
            >
              <div className="w-32 h-16">
                <div id="yt-deck-player-A" className="w-full h-full" />
              </div>
              <div className="w-32 h-16">
                <div id="yt-deck-player-B" className="w-full h-full" />
              </div>
            </div>
          )}
          {mobileTab === 'decks' && (
            <DeckPanel
              {...deckProps(mobileActiveDeck === 'A' ? deckA : deckB)}
              compactMobileSection="transport"
            />
          )}
          {mobileTab === 'mixer' && (
            <MixerConsole
              deckA={deckA}
              deckB={deckB}
              mixer={mixer}
              onDeckMixerChange={(id, patch) =>
                setDeckState(id, (prev) => ({ ...prev, ...patch }))
              }
              onMixerChange={(patch) => setMixerState((prev) => ({ ...prev, ...patch }))}
            />
          )}
          {mobileTab === 'fx' && (
            <div className="flex flex-col gap-3">
              <AiAutopilotPanel
                autopilot={autopilot}
                deckA={deckA}
                deckB={deckB}
                playlists={library.playlists}
                totalTracksCount={library.tracks.length}
                mashupLoading={mashupLoading}
                onToggleAutopilot={handleToggleAutopilot}
                onToggleRemixMode={handleToggleRemixMode}
                onToggleQuickMix={handleToggleQuickMix}
                onEnergyModeChange={handleEnergyModeChange}
                onAggressivenessChange={handleAggressivenessChange}
                onRandomnessChange={handleRandomnessChange}
                onRegenerateTake={handleRegenerateTake}
                onTriggerWildTake={handleTriggerWildTake}
                onTargetPlaylistChange={handleTargetPlaylistChange}
                onVibeChange={(vibe) => setAutopilotState((p) => ({ ...p, vibe }))}
                onMixNow={() => beginAiTransitionNow(true)}
                onDirectAi={handleDirectAi}
                onMashupBlend={handleAiMashupBlend}
                onTriggerTrick={handleTriggerSoundTrick}
                onHoldExtraBars={handleHoldExtraBars}
                onSwapUpcomingStyle={handleSwapUpcomingStyle}
                onToggleMuteSfx={handleToggleMuteSfx}
                onToggleVoiceFx={handleToggleVoiceFx}
                onToggleVoiceItem={handleToggleVoiceItem}
                onSetVoiceCategoryEnabled={handleSetVoiceCategoryEnabled}
                onEnableAllVoices={handleEnableAllVoices}
                onTriggerVoice={handleTriggerVoice}
                customVoiceDrops={customVoiceDrops}
                recordingSlotId={recordingSlotId}
                micError={micError}
                onToggleRecordCustomSlot={handleToggleRecordCustomSlot}
                onUploadCustomSlot={handleUploadCustomSlot}
                onTriggerCustomSlot={handleTriggerCustomSlot}
                onToggleCustomSlotEnabled={handleToggleCustomSlotEnabled}
                onClearCustomSlot={handleClearCustomSlot}
                onCycleGrooveBridge={handleCycleGrooveBridge}
                onOpenCrate={() => setMobileTab('crate')}
              />
              <DeckPanel
                {...deckProps(mobileActiveDeck === 'A' ? deckA : deckB)}
                compactMobileSection="fx"
              />
            </div>
          )}
          {mobileTab === 'crate' && (
            <LibraryPanel
              tracks={library.tracks}
              playlists={library.playlists}
              activePlaylistId={library.activePlaylistId}
              onSelectPlaylist={library.setActivePlaylistId}
              onCreatePlaylist={library.createPlaylist}
              onDeletePlaylist={library.deletePlaylist}
              onAddTrack={library.addTrack}
              onAddTracksBatch={library.addTracksBatch}
              onAddTrackToPlaylist={library.addTrackToPlaylist}
              onRemoveTrackFromPlaylist={library.removeTrackFromPlaylist}
              onLoadToDeck={loadTrackToDeck}
              onImportFiles={handleImportFiles}
              onAutoDjPlaylist={(plId, remix) => startPlaylistAutoDj(plId, remix)}
              onOpenPlaylistBuilder={(pl) => {
                setEditingPlaylist(pl || null);
                setBuilderOpen(true);
              }}
              onExportCarloPlaylist={handleExportCarloPlaylist}
              onImportCarloFile={handleImportCarloFile}
              autopilotPlaylistId={autopilot.targetPlaylistId}
              autopilotEnabled={autopilot.enabled}
              autopilotRemixMode={autopilot.remixMode}
              deckATrackId={deckA.track?.id}
              deckBTrackId={deckB.track?.id}
            />
          )}
        </div>
      </main>

      {/* Hideable Desktop Song Chooser & Playlist Builder Sidebar Drawer */}
      {isDesktop && isCrateOpen && (
        <>
          <div
            className="fixed inset-0 top-11 z-40 bg-black/55 backdrop-blur-[1px]"
            onClick={() => setIsCrateOpen(false)}
            aria-hidden="true"
          />
          <aside
            aria-label="Song Chooser and Playlists Sidebar"
            className="fixed top-11 bottom-0 left-0 z-50 w-[430px] max-w-[92vw] shadow-2xl flex flex-col"
          >
            <LibraryPanel
              tracks={library.tracks}
              playlists={library.playlists}
              activePlaylistId={library.activePlaylistId}
              onSelectPlaylist={library.setActivePlaylistId}
              onCreatePlaylist={library.createPlaylist}
              onDeletePlaylist={library.deletePlaylist}
              onAddTrack={library.addTrack}
              onAddTracksBatch={library.addTracksBatch}
              onAddTrackToPlaylist={library.addTrackToPlaylist}
              onRemoveTrackFromPlaylist={library.removeTrackFromPlaylist}
              onLoadToDeck={loadTrackToDeck}
              onImportFiles={handleImportFiles}
              onAutoDjPlaylist={(plId, remix) => startPlaylistAutoDj(plId, remix)}
              onOpenPlaylistBuilder={(pl) => {
                setEditingPlaylist(pl || null);
                setBuilderOpen(true);
              }}
              onExportCarloPlaylist={handleExportCarloPlaylist}
              onImportCarloFile={handleImportCarloFile}
              autopilotPlaylistId={autopilot.targetPlaylistId}
              autopilotEnabled={autopilot.enabled}
              autopilotRemixMode={autopilot.remixMode}
              deckATrackId={deckA.track?.id}
              deckBTrackId={deckB.track?.id}
              sidebarMode
              onCloseDrawer={() => setIsCrateOpen(false)}
            />
          </aside>
        </>
      )}

      {/* Mobile Fixed Bottom Thumb Navigation (< 1024px) */}
      <nav
        aria-label="Mobile DJ Navigation"
        className="lg:hidden fixed bottom-0 left-0 right-0 z-40 h-14 bg-[#0B0E14]/95 backdrop-blur-md border-t border-white/[0.08] grid grid-cols-4 items-center"
      >
        {[
          { id: 'decks' as MobileTab, label: 'Decks', icon: Disc3 },
          { id: 'mixer' as MobileTab, label: 'Mixer', icon: Sliders },
          { id: 'fx' as MobileTab, label: 'FX & AI', icon: Sparkles },
          { id: 'crate' as MobileTab, label: 'Crate', icon: Library },
        ].map((item) => {
          const Icon = item.icon;
          const active = mobileTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setMobileTab(item.id)}
              className={`h-full flex flex-col items-center justify-center gap-0.5 text-[10px] font-medium transition-colors ${
                active ? 'text-cyan-400' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Icon className="w-4 h-4" />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>

      {/* Playlist Builder & Offline AI Remix Configurator */}
      <PlaylistBuilderModal
        isOpen={builderOpen}
        onClose={() => {
          setBuilderOpen(false);
          setEditingPlaylist(null);
        }}
        allTracks={library.tracks}
        editingPlaylist={editingPlaylist}
        onSavePlaylist={handleSavePlaylistFromBuilder}
      />

      {/* Master Recording & Offline Mixtape Export Modal */}
      <RecordingModal
        isOpen={recordingModalOpen}
        onClose={() => setRecordingModalOpen(false)}
        isRecording={isRecording}
        recordingElapsedSec={recordingSec}
        onStartRecording={handleStartRecording}
        onStopRecording={handleStopRecording}
        recordings={library.recordings}
        onDeleteRecording={library.removeRecording}
        canRenderOfflineRemix={
          deckA.playbackMode === 'webaudio' &&
          deckB.playbackMode === 'webaudio' &&
          Boolean(deckA.track && deckB.track)
        }
        offlineRemixPairLabel={
          deckA.track && deckB.track
            ? `${deckA.track.title.split('(')[0].trim()} × ${deckB.track.title.split('(')[0].trim()}`
            : ''
        }
        offlineRenderDisabledReason={
          !deckA.track || !deckB.track
            ? 'Load tracks on both Deck A and Deck B to enable faster-than-real-time WAV rendering.'
            : deckA.playbackMode !== 'webaudio' || deckB.playbackMode !== 'webaudio'
            ? 'Offline Fast-Render requires both decks to be Web Audio / local / streamed tracks (YouTube IFrame audio is cross-origin).'
            : undefined
        }
        onRenderAiRemixWav={handleRenderAiRemixWav}
      />
    </div>
  );
}
