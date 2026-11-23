import React, { useEffect, useMemo, useState } from 'react';
import {
  X,
  Disc,
  Download,
  Trash2,
  Circle,
  Square,
  Zap,
  Loader2,
  ListMusic,
  Play,
  FileText,
  Sparkles,
  Shuffle,
  Wand2,
  Sliders,
  Mic,
  Copy,
  Check,
  BookOpen,
} from 'lucide-react';
import {
  AiDjVibe,
  BootlegFlipPreset,
  CleanEditMaskMode,
  CueStartMode,
  GrooveBridgePattern,
  GroqDirectorPlan,
  GroqVoicePersona,
  HarmonicSynthLayerMode,
  HotCue,
  MashupTemplateId,
  MasteringProfile,
  MixStoryExport,
  OfflineExportFormat,
  OfflineRenderMode,
  Playlist,
  PlaylistMixPacing,
  RecordingItem,
  StemSwapMode,
  TrackItem,
  VipDropVariation,
  VocalChopSoloPlan,
} from '../types/dj';
import { buildOfflineRemixBlueprint, detectBestChopCueSec } from '../audio/offlineAiDj';
import {
  requestGroqRemixDirector,
  requestMixStory,
  requestVipVariations,
  requestVocalChopSolo,
} from '../audio/groqDirector';

export interface OfflineRenderOptions {
  mode: OfflineRenderMode;
  mashupTemplate: MashupTemplateId;
  stemSwapMode: StemSwapMode;
  reharmonizeSynth: boolean;
  masteringProfile: MasteringProfile;
  exportDjPack: boolean;
  sessionSeedOverride: number;
  mutedPhaseIndices: number[];
  customMixTitle?: string;
  useGroqIntroDrop: boolean;
  groqCalloutScript: string;
  groqVoicePersona: GroqVoicePersona;
  playlistPacing: PlaylistMixPacing;
  flipBridgePattern: GrooveBridgePattern;
  cueAMode: CueStartMode;
  cueBMode: CueStartMode;
  preview8BarsOnly?: boolean;
  exportFormat: OfflineExportFormat;
  includeVoicesAndFx: boolean;
  preservePitch: boolean;
  bootlegFlip?: BootlegFlipPreset;
  harmonicSynthLayer?: HarmonicSynthLayerMode;
  reverseVocalSwell?: boolean;
  tapeStopDropPrep?: boolean;
  filterEnvelope?: 'none' | 'dark-warm' | 'lpf-drop-open' | 'hpf-tension';
  subSwapEnabled?: boolean;
  cleanEditMask?: CleanEditMaskMode;
  vocalChopSolo?: VocalChopSoloPlan | null;
  keyGlideCorrection?: boolean;
}

export interface OfflinePreviewResult {
  previewUrl?: string;
  previewTitle?: string;
}

interface RecordingModalProps {
  isOpen: boolean;
  onClose: () => void;
  isRecording: boolean;
  recordingElapsedSec: number;
  onStartRecording: (includeTabAudio: boolean) => Promise<void>;
  onStopRecording: () => void;
  recordings: RecordingItem[];
  onDeleteRecording: (id: string) => void;
  canRenderOfflineRemix?: boolean;
  canRenderSingleFlip?: boolean;
  offlineRemixPairLabel?: string;
  singleFlipLabel?: string;
  offlineRenderDisabledReason?: string;
  deckATrack?: TrackItem | null;
  deckBTrack?: TrackItem | null;
  playlistTrackItems?: TrackItem[];
  currentVibe?: AiDjVibe;
  currentAggressiveness?: number;
  initialSeed?: number;
  deckACues?: HotCue[];
  deckBCues?: HotCue[];
  deckACurrentTime?: number;
  deckBCurrentTime?: number;
  vipSkipEnabled?: boolean;
  playlists?: Playlist[];
  targetPlaylistId?: string;
  onTargetPlaylistChange?: (id: string) => void;
  canRenderPlaylistMix?: boolean;
  playlistMixLabel?: string;
  defaultMashupTemplate?: MashupTemplateId;
  onSaveRecordingStory?: (recordingId: string, story: MixStoryExport) => void;
  onRenderAiRemixWav?: (
    opts: OfflineRenderOptions,
    onProgress: (pct: number) => void
  ) => Promise<OfflinePreviewResult | void>;
}

const TEMPLATE_OPTIONS: { id: MashupTemplateId; label: string }[] = [
  { id: 'club-groove-swap', label: 'Club Groove Swap' },
  { id: 'festival-double-drop', label: 'Festival Double-Drop' },
  { id: 'hiphop-cut', label: 'Hip-Hop Cut' },
  { id: 'dub-echo-flip', label: 'Dub & Echo Flip' },
];

const STEM_SWAP_OPTIONS: { id: StemSwapMode; label: string }[] = [
  { id: 'auto', label: 'AI Auto' },
  { id: 'a-vocal-b-beat', label: 'A Vox × B Beat' },
  { id: 'b-vocal-a-beat', label: 'B Vox × A Beat' },
  { id: 'dual-hook', label: 'Dual Hook' },
];

const MASTERING_OPTIONS: { id: MasteringProfile; label: string; sub: string }[] = [
  { id: 'clean', label: 'Clean', sub: 'Zero coloration' },
  { id: 'club-punch', label: 'Club Punch', sub: 'Mono sub + M/S' },
  { id: 'festival-loud', label: 'Festival Loud', sub: 'Brickwall slam' },
  { id: 'vinyl-warmth', label: 'Vinyl Warmth', sub: 'Tube + smooth air' },
];

const PACING_OPTIONS: { id: PlaylistMixPacing; label: string; sub: string }[] = [
  { id: 'megamix', label: 'Club Megamix', sub: '8–12 bars / track' },
  { id: 'extended', label: 'Extended Mix', sub: '28–36 bars / track' },
  { id: 'full-songs', label: 'Full Songs', sub: 'Outro/intro blends' },
];

const FLIP_BRIDGE_OPTIONS: { id: GrooveBridgePattern; label: string }[] = [
  { id: 'off', label: 'Auto Vibe' },
  { id: 'house-4x4', label: '4x4 House' },
  { id: 'sub-808', label: '808 Trap' },
  { id: 'afro-perc', label: 'Afro Perc' },
  { id: 'chord-arp', label: 'Chord Arp' },
];

const GROQ_VOICES: { id: GroqVoicePersona; label: string }[] = [
  { id: 'troy', label: 'Troy (Hype Male)' },
  { id: 'daniel', label: 'Daniel (Deep Club)' },
  { id: 'austin', label: 'Austin (Crisp Host)' },
  { id: 'diana', label: 'Diana (Club Female)' },
  { id: 'hannah', label: 'Hannah (Smooth Radio)' },
  { id: 'autumn', label: 'Autumn (Warm Vocal)' },
];

function formatClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const RecordingModal: React.FC<RecordingModalProps> = ({
  isOpen,
  onClose,
  isRecording,
  recordingElapsedSec,
  onStartRecording,
  onStopRecording,
  recordings,
  onDeleteRecording,
  canRenderOfflineRemix = false,
  canRenderSingleFlip = false,
  offlineRemixPairLabel = '',
  singleFlipLabel = '',
  offlineRenderDisabledReason,
  deckATrack = null,
  deckBTrack = null,
  playlistTrackItems = [],
  currentVibe = 'club-blend',
  currentAggressiveness = 55,
  initialSeed = 1337,
  deckACues = [],
  deckBCues = [],
  deckACurrentTime = 0,
  deckBCurrentTime = 0,
  vipSkipEnabled = false,
  playlists = [],
  targetPlaylistId = 'all',
  onTargetPlaylistChange,
  canRenderPlaylistMix = false,
  playlistMixLabel = '',
  defaultMashupTemplate = 'club-groove-swap',
  onSaveRecordingStory,
  onRenderAiRemixWav,
}) => {
  const [captureTabAudio, setCaptureTabAudio] = useState(false);
  const [renderMode, setRenderMode] = useState<OfflineRenderMode>('mashup-32');
  const [mashupTemplate, setMashupTemplate] = useState<MashupTemplateId>(defaultMashupTemplate);
  const [stemSwapMode, setStemSwapMode] = useState<StemSwapMode>('auto');
  const [reharmonizeSynth, setReharmonizeSynth] = useState(false);
  const [masteringProfile, setMasteringProfile] = useState<MasteringProfile>('club-punch');
  const [exportDjPack, setExportDjPack] = useState(false);
  const [renderSeed, setRenderSeed] = useState(initialSeed);
  const [mutedPhaseIndices, setMutedPhaseIndices] = useState<number[]>([]);
  const [playlistPacing, setPlaylistPacing] = useState<PlaylistMixPacing>('megamix');
  const [flipBridgePattern, setFlipBridgePattern] = useState<GrooveBridgePattern>('off');
  const [cueAMode, setCueAMode] = useState<CueStartMode>('auto');
  const [cueBMode, setCueBMode] = useState<CueStartMode>('auto');
  const [exportFormat, setExportFormat] = useState<OfflineExportFormat>('wav');
  const [includeVoicesAndFx, setIncludeVoicesAndFx] = useState(true);
  const [preservePitch, setPreservePitch] = useState(true);
  const [bootlegFlip, setBootlegFlip] = useState<BootlegFlipPreset>('off');
  const [harmonicSynthLayer, setHarmonicSynthLayer] = useState<HarmonicSynthLayerMode>('off');
  const [reverseVocalSwell, setReverseVocalSwell] = useState(false);
  const [tapeStopDropPrep, setTapeStopDropPrep] = useState(false);
  const [filterEnvelope, setFilterEnvelope] = useState<'none' | 'dark-warm' | 'lpf-drop-open' | 'hpf-tension'>('none');
  const [subSwapEnabled, setSubSwapEnabled] = useState(false);
  const [cleanEditMask, setCleanEditMask] = useState<CleanEditMaskMode>('off');
  const [enableVocalChopSolo, setEnableVocalChopSolo] = useState(false);
  const [keyGlideCorrection, setKeyGlideCorrection] = useState(true);

  const [vipVariations, setVipVariations] = useState<
    (VipDropVariation & { previewUrl?: string })[]
  >([]);
  const [vipLoading, setVipLoading] = useState(false);

  const [mixStoryLoadingId, setMixStoryLoadingId] = useState<string | null>(null);
  const [openStoryId, setOpenStoryId] = useState<string | null>(null);
  const [copiedStoryId, setCopiedStoryId] = useState<string | null>(null);

  // Groq AI Remix Director + Spoken Orpheus Intro Drop
  const [directorPrompt, setDirectorPrompt] = useState('');
  const [directorLoading, setDirectorLoading] = useState(false);
  const [directorPlan, setDirectorPlan] = useState<GroqDirectorPlan | null>(null);
  const [useGroqIntroDrop, setUseGroqIntroDrop] = useState(false);
  const [groqCalloutScript, setGroqCalloutScript] = useState(
    "[cheerful] You're locked into DJOne! Let's take this mix higher!"
  );
  const [groqVoicePersona, setGroqVoicePersona] = useState<GroqVoicePersona>('troy');

  const [isRendering, setIsRendering] = useState(false);
  const [renderingPreview, setRenderingPreview] = useState(false);
  const [renderPct, setRenderPct] = useState(0);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [previewAudio, setPreviewAudio] = useState<{ url: string; title: string } | null>(null);
  const [openCueSheetId, setOpenCueSheetId] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (previewAudio?.url) {
        URL.revokeObjectURL(previewAudio.url);
      }
    };
  }, [previewAudio]);

  useEffect(() => {
    setMutedPhaseIndices([]);
  }, [renderMode, mashupTemplate, targetPlaylistId]);

  const blueprintSegments = useMemo(
    () =>
      buildOfflineRemixBlueprint({
        mode: renderMode,
        deckA: deckATrack,
        deckB: deckBTrack,
        playlistTracks: playlistTrackItems,
        mashupTemplate,
        stemSwapMode,
        playlistPacing,
        flipBridgePattern,
        aggressiveness: currentAggressiveness,
        sessionSeed: renderSeed,
        vibe: currentVibe,
      }),
    [
      renderMode,
      deckATrack,
      deckBTrack,
      playlistTrackItems,
      mashupTemplate,
      stemSwapMode,
      playlistPacing,
      flipBridgePattern,
      currentAggressiveness,
      renderSeed,
      currentVibe,
    ]
  );

  if (!isOpen) return null;

  const canRenderCurrentMode =
    renderMode === 'playlist-mix'
      ? canRenderPlaylistMix
      : renderMode === 'single-flip'
      ? canRenderSingleFlip
      : canRenderOfflineRemix;

  const directorTracks =
    renderMode === 'playlist-mix'
      ? playlistTrackItems.slice(0, 12)
      : renderMode === 'single-flip'
      ? deckATrack
        ? [deckATrack]
        : []
      : [deckATrack, deckBTrack].filter((t): t is TrackItem => Boolean(t));

  const applyDirectorPlan = (plan: GroqDirectorPlan) => {
    setDirectorPlan(plan);
    setMashupTemplate(plan.recommendedTemplate);
    setFlipBridgePattern(plan.recommendedBridge);
    setStemSwapMode(plan.stemSwapPreference);
    setMasteringProfile(plan.masteringProfile);
    setReharmonizeSynth(plan.reharmonizeSynth);
    if (plan.bootlegPreset) setBootlegFlip(plan.bootlegPreset);
    if (plan.synthLayerMode) setHarmonicSynthLayer(plan.synthLayerMode);
    if (typeof plan.reverseVocalSwell === 'boolean') setReverseVocalSwell(plan.reverseVocalSwell);
    if (typeof plan.tapeStopDropPrep === 'boolean') setTapeStopDropPrep(plan.tapeStopDropPrep);
    if (plan.filterEnvelope) setFilterEnvelope(plan.filterEnvelope);
    if (plan.calloutScript) {
      setGroqCalloutScript(plan.calloutScript);
      if (plan.configured) setUseGroqIntroDrop(true);
    }
  };

  const handleAskGroqDirector = async () => {
    if (directorTracks.length === 0 || directorLoading) return;
    setDirectorLoading(true);
    setRenderError(null);
    try {
      const plan = await requestGroqRemixDirector({
        mode: renderMode,
        vibe: currentVibe,
        directionPrompt: directorPrompt,
        tracks: directorTracks,
      });
      applyDirectorPlan(plan);
    } catch (err: any) {
      setRenderError(err?.message || 'Unable to reach Groq AI Director.');
    } finally {
      setDirectorLoading(false);
    }
  };

  const toggleBlueprintPhaseMute = (idx: number) => {
    setMutedPhaseIndices((prev) =>
      prev.includes(idx) ? prev.filter((x) => x !== idx) : [...prev, idx]
    );
  };

  const handleTriggerRender = async (
    previewOnly = false,
    overrides?: Partial<OfflineRenderOptions>
  ) => {
    if (!onRenderAiRemixWav || !canRenderCurrentMode || isRendering) return;
    setIsRendering(true);
    setRenderingPreview(previewOnly);
    setRenderPct(4);
    setRenderError(null);
    try {
      let vocalChopSolo: VocalChopSoloPlan | null = null;
      if (enableVocalChopSolo && deckATrack) {
        const aiPlan = await requestVocalChopSolo({
          title: deckATrack.title,
          musicalKey: deckATrack.musicalKey || '8A',
          durationSec: deckATrack.durationSec || 180,
          words: deckATrack.lyricCues?.words,
        });
        const cueSec =
          aiPlan.cueSec > 1 ? aiPlan.cueSec : detectBestChopCueSec(deckATrack);
        vocalChopSolo = { ...aiPlan, cueSec };
      }

      const res = await onRenderAiRemixWav(
        {
          mode: renderMode,
          mashupTemplate,
          stemSwapMode,
          reharmonizeSynth,
          masteringProfile,
          exportDjPack: !previewOnly && renderMode !== 'playlist-mix' ? exportDjPack : false,
          sessionSeedOverride: renderSeed,
          mutedPhaseIndices,
          customMixTitle: directorPlan?.mixTitle,
          useGroqIntroDrop,
          groqCalloutScript,
          groqVoicePersona,
          playlistPacing,
          flipBridgePattern,
          cueAMode,
          cueBMode,
          preview8BarsOnly: previewOnly,
          exportFormat: previewOnly ? 'wav' : exportFormat,
          includeVoicesAndFx,
          preservePitch,
          bootlegFlip,
          harmonicSynthLayer,
          reverseVocalSwell,
          tapeStopDropPrep,
          filterEnvelope,
          subSwapEnabled,
          cleanEditMask,
          vocalChopSolo,
          keyGlideCorrection,
          ...overrides,
        },
        (pct) => setRenderPct(pct)
      );
      if (previewOnly && res?.previewUrl) {
        setPreviewAudio((prev) => {
          if (prev?.url) URL.revokeObjectURL(prev.url);
          return { url: res.previewUrl!, title: res.previewTitle || '8-Bar Audition Preview' };
        });
      }
    } catch (err: any) {
      setRenderError(err?.message || 'Offline render failed.');
    } finally {
      setIsRendering(false);
      setRenderingPreview(false);
    }
  };

  const handleGenerateVipVariations = async () => {
    if (!onRenderAiRemixWav || !canRenderCurrentMode || vipLoading || isRendering) return;
    setVipLoading(true);
    setRenderError(null);
    try {
      const specsResp = await requestVipVariations({
        prompt: directorPrompt || currentVibe,
        titleA: deckATrack?.title || 'Track A',
        titleB: deckBTrack?.title || 'Track B',
      });
      const specs = specsResp.variations;
      const rendered: (VipDropVariation & { previewUrl?: string })[] = [];
      for (let i = 0; i < specs.length; i++) {
        const v = specs[i];
        const previewRes = await onRenderAiRemixWav(
          {
            mode: renderMode,
            mashupTemplate: v.mashupTemplate,
            stemSwapMode,
            reharmonizeSynth: true,
            masteringProfile,
            exportDjPack: false,
            sessionSeedOverride: renderSeed + (i + 1) * 97,
            mutedPhaseIndices,
            useGroqIntroDrop: false,
            groqCalloutScript,
            groqVoicePersona,
            playlistPacing,
            flipBridgePattern: v.flipBridgePattern,
            cueAMode,
            cueBMode,
            preview8BarsOnly: true,
            exportFormat: 'wav',
            includeVoicesAndFx,
            preservePitch,
            bootlegFlip: v.bootlegFlip,
            harmonicSynthLayer: v.harmonicSynthLayer,
            reverseVocalSwell: v.reverseVocalSwell,
            tapeStopDropPrep: v.tapeStopDropPrep,
            filterEnvelope: v.filterEnvelope,
            subSwapEnabled,
            cleanEditMask,
            keyGlideCorrection,
          },
          () => {}
        );
        rendered.push({ ...v, previewUrl: previewRes?.previewUrl });
      }
      setVipVariations(rendered);
    } catch (err: any) {
      setRenderError(err?.message || 'Unable to generate VIP A/B/C variations.');
    } finally {
      setVipLoading(false);
    }
  };

  const applyVipVariation = (v: VipDropVariation) => {
    setMashupTemplate(v.mashupTemplate);
    setFlipBridgePattern(v.flipBridgePattern);
    setBootlegFlip(v.bootlegFlip);
    setHarmonicSynthLayer(v.harmonicSynthLayer);
    setReverseVocalSwell(v.reverseVocalSwell);
    setTapeStopDropPrep(v.tapeStopDropPrep);
    setFilterEnvelope(v.filterEnvelope);
  };

  const handleGenerateMixStory = async (rec: RecordingItem) => {
    if (mixStoryLoadingId) return;
    if (rec.mixStory) {
      setOpenStoryId((cur) => (cur === rec.id ? null : rec.id));
      return;
    }
    setMixStoryLoadingId(rec.id);
    try {
      const story = await requestMixStory({
        title: rec.title,
        durationSec: rec.durationSec,
        cueSheetText: rec.cueSheetText || '',
      });
      onSaveRecordingStory?.(rec.id, story);
      setOpenStoryId(rec.id);
    } finally {
      setMixStoryLoadingId(null);
    }
  };

  const handleOneClickPromptToRemix = async () => {
    if (directorTracks.length === 0 || !canRenderCurrentMode || directorLoading || isRendering) return;
    setDirectorLoading(true);
    setRenderError(null);
    let plan: GroqDirectorPlan | null = null;
    try {
      plan = await requestGroqRemixDirector({
        mode: renderMode,
        vibe: currentVibe,
        directionPrompt: directorPrompt || 'Dark club remix flip with spoken intro drop and reverse swell',
        tracks: directorTracks,
      });
      applyDirectorPlan(plan);
    } catch (err: any) {
      setRenderError(err?.message || 'Unable to reach Groq AI Director.');
    } finally {
      setDirectorLoading(false);
    }
    if (plan) {
      await handleTriggerRender(false, {
        mashupTemplate: plan.recommendedTemplate,
        flipBridgePattern: plan.recommendedBridge,
        stemSwapMode: plan.stemSwapPreference,
        masteringProfile: plan.masteringProfile,
        reharmonizeSynth: plan.reharmonizeSynth,
        customMixTitle: plan.mixTitle,
        useGroqIntroDrop: Boolean(plan.calloutScript && plan.configured),
        groqCalloutScript: plan.calloutScript || groqCalloutScript,
        bootlegFlip: plan.bootlegPreset || bootlegFlip,
        harmonicSynthLayer: plan.synthLayerMode || harmonicSynthLayer,
        reverseVocalSwell: plan.reverseVocalSwell ?? reverseVocalSwell,
        tapeStopDropPrep: plan.tapeStopDropPrep ?? tapeStopDropPrep,
        filterEnvelope: plan.filterEnvelope || filterEnvelope,
      });
    }
  };

  const handleDownloadCueSheet = (rec: RecordingItem) => {
    if (!rec.cueSheetText) return;
    const blob = new Blob([rec.cueSheetText], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${rec.title.replace(/[^\w\-]+/g, '_')}_tracklist.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const renderCueSelect = (
    label: string,
    value: CueStartMode,
    onChange: (v: CueStartMode) => void,
    cues: HotCue[],
    liveTimeSec: number
  ) => (
    <label className="flex items-center gap-1.5 flex-1 min-w-[180px]">
      <span className="text-[10.5px] text-slate-400 shrink-0">{label}:</span>
      <select
        value={value}
        disabled={isRendering}
        onChange={(e) => onChange(e.target.value as CueStartMode)}
        className="flex-1 h-7 px-2 rounded-md bg-[#11151C] border border-white/10 text-[11px] text-white focus:outline-none focus:border-cyan-400"
      >
        <option value="auto" className="bg-[#11151C]">
          Auto Drop Cue
        </option>
        <option value="playhead" className="bg-[#11151C]">
          Playhead ({formatClock(liveTimeSec)})
        </option>
        {[0, 1, 2, 3].map((idx) => {
          const hc = cues[idx];
          const hasTime = typeof hc?.timeSec === 'number';
          return (
            <option key={idx} value={`cue-${idx}`} className="bg-[#11151C]" disabled={!hasTime}>
              {hc?.label || `Hot Cue ${idx + 1}`}{' '}
              {hasTime ? `(${formatClock(hc!.timeSec!)})` : '(Unset)'}
            </option>
          );
        })}
      </select>
    </label>
  );

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-3xl bg-[#11151C] border border-white/10 rounded-2xl overflow-hidden shadow-2xl">
        <div className="px-5 py-3.5 border-b border-white/[0.08] flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Disc className="w-5 h-5 text-red-400" />
            <h3 className="font-display font-semibold text-base text-white">
              DJOne Mixtape Recorder &amp; Offline AI Studio
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/5"
            aria-label="Close recorder"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 flex flex-col gap-4 max-h-[85vh] overflow-y-auto">
          {/* Active Live Recorder Control */}
          <div className="bg-[#0B0E14] border border-white/[0.08] rounded-xl p-3.5 flex flex-col gap-2.5">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-white">
                  {isRecording ? 'Recording Live Master Mix' : 'Record Live Stereo WAV'}
                </p>
                <p className="text-xs text-slate-400 mt-0.5">
                  Captures 16-bit 44.1kHz stereo mix directly from the Master Output bus.
                </p>
              </div>
              <div className="text-xl font-mono font-bold text-white tabular-nums">
                {formatClock(recordingElapsedSec)}
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={captureTabAudio}
                  onChange={(e) => setCaptureTabAudio(e.target.checked)}
                  disabled={isRecording}
                  className="accent-cyan-400"
                />
                <span>Capture browser tab audio (for embedded YouTube decks)</span>
              </label>

              {!isRecording ? (
                <button
                  type="button"
                  onClick={() => onStartRecording(captureTabAudio)}
                  className="h-8 px-3.5 rounded-lg bg-red-600 hover:bg-red-500 text-white font-semibold text-xs flex items-center gap-2 transition-colors"
                >
                  <Circle className="w-3 h-3 fill-current" />
                  <span>Start Live Recording</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={onStopRecording}
                  className="h-8 px-3.5 rounded-lg bg-white text-[#090B0F] hover:bg-slate-200 font-semibold text-xs flex items-center gap-2 transition-colors"
                >
                  <Square className="w-3 h-3 fill-current" />
                  <span>Stop &amp; Save Mix</span>
                </button>
              )}
            </div>
          </div>

          {/* Offline AI Mixtape Engine */}
          {onRenderAiRemixWav && (
            <div className="bg-[#0B0E14] border border-cyan-500/25 rounded-xl p-4 flex flex-col gap-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-medium text-white flex items-center gap-1.5">
                    <Zap className="w-4 h-4 text-cyan-400" />
                    <span>Offline Fast-Render (Tempo-Glide · Stems · Groq Director · Mastering)</span>
                  </p>
                  <p className="text-xs text-slate-400 mt-0.5">
                    {renderMode === 'playlist-mix'
                      ? canRenderPlaylistMix
                        ? `Native BPM bodies + S-curve tempo-glide bridges for ${playlistMixLabel || 'playlist'}.`
                        : 'Select a playlist with at least 2 decodable local or streamed tracks.'
                      : renderMode === 'single-flip'
                      ? canRenderSingleFlip && singleFlipLabel
                        ? `1-Deck Club Flip for ${singleFlipLabel} with HPSS vocal isolation & key-locked reharm.`
                        : 'Load a Web Audio / local / streamed track on Deck A to bounce a 1-Deck Club Flip.'
                      : canRenderOfflineRemix && offlineRemixPairLabel
                      ? `Instant studio render for ${offlineRemixPairLabel} with stem matrix, mastering & BPM glide.`
                      : offlineRenderDisabledReason ||
                        'Load two Web Audio / local / streamed tracks on Deck A & Deck B to fast-render an AI edit.'}
                  </p>
                </div>
              </div>

              {/* 4 Offline Render Modes */}
              <div className="flex flex-wrap items-center gap-1 bg-[#11151C] p-1 rounded-lg border border-white/[0.08]">
                <button
                  type="button"
                  onClick={() => setRenderMode('mashup-32')}
                  disabled={isRendering}
                  className={`px-2.5 py-1 rounded text-[11px] font-semibold transition-colors ${
                    renderMode === 'mashup-32'
                      ? 'bg-purple-500 text-[#090B0F]'
                      : 'text-slate-300 hover:text-white'
                  }`}
                >
                  32-Bar Mashup
                </button>
                <button
                  type="button"
                  onClick={() => setRenderMode('ai-transition')}
                  disabled={isRendering}
                  className={`px-2.5 py-1 rounded text-[11px] font-semibold transition-colors ${
                    renderMode === 'ai-transition'
                      ? 'bg-cyan-500 text-[#090B0F]'
                      : 'text-slate-300 hover:text-white'
                  }`}
                >
                  AI Transition
                </button>
                <button
                  type="button"
                  onClick={() => setRenderMode('single-flip')}
                  disabled={isRendering}
                  className={`px-2.5 py-1 rounded text-[11px] font-semibold flex items-center gap-1 transition-colors ${
                    renderMode === 'single-flip'
                      ? 'bg-amber-400 text-[#090B0F]'
                      : 'text-slate-300 hover:text-white'
                  }`}
                >
                  <Sparkles className="w-3 h-3" />
                  <span>Club Flip (1-Deck)</span>
                </button>
                <button
                  type="button"
                  onClick={() => setRenderMode('playlist-mix')}
                  disabled={isRendering}
                  className={`px-2.5 py-1 rounded text-[11px] font-semibold flex items-center gap-1 transition-colors ${
                    renderMode === 'playlist-mix'
                      ? 'bg-emerald-500 text-[#090B0F]'
                      : 'text-slate-300 hover:text-white'
                  }`}
                >
                  <ListMusic className="w-3 h-3" />
                  <span>Full Playlist Mix</span>
                </button>
              </div>

              {/* Enhancement #3: Groq AI Remix Director + Spoken Orpheus TTS Drop */}
              <div className="bg-[#11151C] border border-white/[0.08] rounded-lg p-2.5 flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Wand2 className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                  <input
                    type="text"
                    value={directorPrompt}
                    onChange={(e) => setDirectorPrompt(e.target.value)}
                    disabled={directorLoading || isRendering}
                    placeholder="Groq AI Director prompt (e.g. dark warehouse build, punchy vocal drop)..."
                    className="flex-1 min-w-[200px] h-7 px-2.5 rounded-md bg-[#0B0E14] border border-white/10 text-[11px] text-white placeholder:text-slate-500 focus:outline-none focus:border-cyan-400"
                  />
                  <button
                    type="button"
                    onClick={handleAskGroqDirector}
                    disabled={directorTracks.length === 0 || directorLoading || isRendering}
                    className="h-7 px-2.5 rounded-md bg-cyan-500/20 hover:bg-cyan-500/30 disabled:opacity-45 border border-cyan-400/40 text-cyan-200 text-[11px] font-semibold flex items-center gap-1.5 transition-colors"
                  >
                    {directorLoading ? (
                      <>
                        <Loader2 className="w-3 h-3 animate-spin" />
                        <span>Directing...</span>
                      </>
                    ) : (
                      <>
                        <Wand2 className="w-3 h-3" />
                        <span>Ask Groq Director</span>
                      </>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={handleOneClickPromptToRemix}
                    disabled={!canRenderCurrentMode || directorTracks.length === 0 || directorLoading || isRendering}
                    className="h-7 px-2.5 rounded-md bg-emerald-500 hover:bg-emerald-400 disabled:opacity-45 text-[#090B0F] text-[11px] font-bold flex items-center gap-1.5 transition-colors"
                    title="Hybrid 1-Click Prompt-to-Remix: Groq plans recipe + Orpheus voices drop + Local DSP bounces remix"
                  >
                    <Zap className="w-3 h-3 fill-current" />
                    <span>1-Click Prompt-to-Remix</span>
                  </button>
                </div>

                {directorPlan && (
                  <div className="text-[11px] bg-[#0B0E14] border border-white/[0.06] rounded-md px-2.5 py-1.5 flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <span className="font-semibold text-white">{directorPlan.mixTitle}</span>
                      <span className="text-slate-400 ml-2">— {directorPlan.directorNotes}</span>
                    </div>
                    <span className="text-[10px] font-mono text-cyan-300 shrink-0">
                      {directorPlan.source === 'groq' ? 'Groq Llama-3.3' : 'Smart Auto'}
                    </span>
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-2 pt-0.5">
                  <label className="flex items-center gap-1.5 text-[11px] text-slate-300 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={useGroqIntroDrop}
                      disabled={isRendering || !includeVoicesAndFx}
                      onChange={(e) => setUseGroqIntroDrop(e.target.checked)}
                      className="accent-cyan-400"
                    />
                    <Mic className="w-3 h-3 text-cyan-400" />
                    <span>Bake Spoken Groq Intro Drop</span>
                  </label>
                  {useGroqIntroDrop && (
                    <>
                      <select
                        value={groqVoicePersona}
                        disabled={isRendering}
                        onChange={(e) => setGroqVoicePersona(e.target.value as GroqVoicePersona)}
                        className="h-6 px-1.5 rounded bg-[#0B0E14] border border-white/10 text-[10.5px] text-slate-200 focus:outline-none"
                      >
                        {GROQ_VOICES.map((v) => (
                          <option key={v.id} value={v.id} className="bg-[#11151C]">
                            {v.label}
                          </option>
                        ))}
                      </select>
                      <input
                        type="text"
                        value={groqCalloutScript}
                        disabled={isRendering}
                        onChange={(e) => setGroqCalloutScript(e.target.value)}
                        maxLength={180}
                        className="flex-1 min-w-[200px] h-6 px-2 rounded bg-[#0B0E14] border border-white/10 text-[10.5px] text-slate-200 focus:outline-none focus:border-cyan-400"
                        placeholder="DJ shoutout script..."
                      />
                    </>
                  )}
                </div>
              </div>

              {/* Mode-Specific Controls */}
              {renderMode === 'mashup-32' && (
                <div className="flex flex-col gap-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[11px] text-slate-400">Style:</span>
                    {TEMPLATE_OPTIONS.map((tpl) => (
                      <button
                        key={tpl.id}
                        type="button"
                        disabled={isRendering}
                        onClick={() => setMashupTemplate(tpl.id)}
                        className={`px-2 py-1 rounded text-[10.5px] font-semibold border transition-colors ${
                          mashupTemplate === tpl.id
                            ? 'bg-purple-500/25 border-purple-400 text-purple-200'
                            : 'bg-[#11151C] border-white/10 text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        {tpl.label}
                      </button>
                    ))}
                  </div>

                  {/* Enhancement #2: Stem Matrix + Key-Locked Synth Reharmonizer */}
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[11px] text-slate-400">Stem Swap:</span>
                      {STEM_SWAP_OPTIONS.map((sw) => (
                        <button
                          key={sw.id}
                          type="button"
                          disabled={isRendering}
                          onClick={() => setStemSwapMode(sw.id)}
                          className={`px-2 py-0.5 rounded text-[10.5px] font-semibold border transition-colors ${
                            stemSwapMode === sw.id
                              ? 'bg-cyan-500/20 border-cyan-400 text-cyan-200'
                              : 'bg-[#11151C] border-white/10 text-slate-400 hover:text-slate-200'
                          }`}
                        >
                          {sw.label}
                        </button>
                      ))}
                    </div>

                    <label className="flex items-center gap-1.5 text-[11px] text-slate-300 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={reharmonizeSynth}
                        disabled={isRendering}
                        onChange={(e) => setReharmonizeSynth(e.target.checked)}
                        className="accent-purple-400"
                      />
                      <span>Key-Locked Synth Bass &amp; Pads</span>
                    </label>
                  </div>
                </div>
              )}

              {renderMode === 'single-flip' && (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[11px] text-slate-400">Flip Drums:</span>
                    {FLIP_BRIDGE_OPTIONS.map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        disabled={isRendering}
                        onClick={() => setFlipBridgePattern(opt.id)}
                        className={`px-2 py-1 rounded text-[10.5px] font-semibold border transition-colors ${
                          flipBridgePattern === opt.id
                            ? 'bg-amber-500/25 border-amber-400 text-amber-200'
                            : 'bg-[#11151C] border-white/10 text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                  <label className="flex items-center gap-1.5 text-[11px] text-slate-300 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={reharmonizeSynth}
                      disabled={isRendering}
                      onChange={(e) => setReharmonizeSynth(e.target.checked)}
                      className="accent-amber-400"
                    />
                    <span>Key-Locked Synth Bass &amp; Pads</span>
                  </label>
                </div>
              )}

              {renderMode === 'playlist-mix' && (
                <div className="flex flex-col gap-2">
                  {playlists.length > 0 && onTargetPlaylistChange && (
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] text-slate-400 shrink-0">Playlist:</span>
                      <select
                        value={targetPlaylistId}
                        disabled={isRendering}
                        onChange={(e) => onTargetPlaylistChange(e.target.value)}
                        className="flex-1 h-8 px-2.5 rounded-lg bg-[#11151C] border border-white/10 text-xs text-white focus:outline-none focus:border-emerald-400"
                      >
                        {playlists.map((pl) => (
                          <option key={pl.id} value={pl.id} className="bg-[#11151C] text-white">
                            {pl.name} {pl.id === 'all' ? '(All Tracks)' : `(${pl.trackIds.length})`}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  <div className="grid grid-cols-3 gap-1.5">
                    {PACING_OPTIONS.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        disabled={isRendering}
                        onClick={() => setPlaylistPacing(p.id)}
                        className={`px-2 py-1.5 rounded-lg border text-left transition-colors ${
                          playlistPacing === p.id
                            ? 'bg-emerald-500/20 border-emerald-400 text-emerald-100'
                            : 'bg-[#11151C] border-white/10 text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        <div className="text-[11px] font-semibold leading-tight">{p.label}</div>
                        <div className="text-[9.5px] opacity-80 leading-tight mt-0.5">
                          {p.id === 'full-songs' && vipSkipEnabled
                            ? 'VIP Skip On (~76%)'
                            : p.id === 'full-songs'
                            ? 'Full track length'
                            : p.sub}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Bootleg Flip Presets, Harmonic Synth Layering & Drop Prep DSP */}
              {renderMode !== 'playlist-mix' && (
                <div className="bg-[#11151C] border border-white/[0.06] rounded-lg px-2.5 py-2 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="flex items-center gap-1 text-[10.5px] text-slate-300">
                      <span className="text-slate-400">Bootleg:</span>
                      <select
                        value={bootlegFlip}
                        disabled={isRendering}
                        onChange={(e) => setBootlegFlip(e.target.value as BootlegFlipPreset)}
                        className="h-6 px-1.5 rounded bg-[#0B0E14] border border-white/10 text-[10.5px] text-emerald-200"
                      >
                        <option value="off">Off</option>
                        <option value="jersey-club">Jersey Club Flip</option>
                        <option value="amapiano">Amapiano Log-Drum</option>
                        <option value="phonk">Phonk 808 Cowbell</option>
                        <option value="slowed-reverb">Slowed + Reverb</option>
                        <option value="nightcore">Nightcore Rave</option>
                      </select>
                    </label>
                    <label className="flex items-center gap-1 text-[10.5px] text-slate-300">
                      <span className="text-slate-400">Synth:</span>
                      <select
                        value={harmonicSynthLayer}
                        disabled={isRendering}
                        onChange={(e) => setHarmonicSynthLayer(e.target.value as HarmonicSynthLayerMode)}
                        className="h-6 px-1.5 rounded bg-[#0B0E14] border border-white/10 text-[10.5px] text-purple-200"
                      >
                        <option value="off">Off</option>
                        <option value="supersaw-pad">Supersaw Pad</option>
                        <option value="acid-303">Acid 303</option>
                        <option value="sidechain-arp">Sidechain Arp</option>
                      </select>
                    </label>
                  </div>
                  <div className="flex flex-wrap items-center gap-3 text-[10.5px] text-slate-300">
                    <label className="flex items-center gap-1 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={reverseVocalSwell}
                        disabled={isRendering}
                        onChange={(e) => setReverseVocalSwell(e.target.checked)}
                        className="accent-cyan-400"
                      />
                      <span>Rev Vocal Swell</span>
                    </label>
                    <label className="flex items-center gap-1 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={tapeStopDropPrep}
                        disabled={isRendering}
                        onChange={(e) => setTapeStopDropPrep(e.target.checked)}
                        className="accent-amber-400"
                      />
                      <span>Tape-Stop Drop</span>
                    </label>
                    <label className="flex items-center gap-1 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={subSwapEnabled}
                        disabled={isRendering}
                        onChange={(e) => setSubSwapEnabled(e.target.checked)}
                        className="accent-amber-400"
                      />
                      <span>808 Sub Swap</span>
                    </label>
                    <label className="flex items-center gap-1 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={enableVocalChopSolo}
                        disabled={isRendering}
                        onChange={(e) => setEnableVocalChopSolo(e.target.checked)}
                        className="accent-emerald-400"
                      />
                      <span>Fred.. Chop Solo</span>
                    </label>
                    <label className="flex items-center gap-1 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={keyGlideCorrection}
                        disabled={isRendering}
                        onChange={(e) => setKeyGlideCorrection(e.target.checked)}
                        className="accent-purple-400"
                      />
                      <span>Key Glide</span>
                    </label>
                    <label className="flex items-center gap-1 text-[10.5px] text-slate-300">
                      <span className="text-slate-400">Clean Edit:</span>
                      <select
                        value={cleanEditMask}
                        disabled={isRendering}
                        onChange={(e) => setCleanEditMask(e.target.value as CleanEditMaskMode)}
                        className="h-5 px-1 rounded bg-[#0B0E14] border border-white/10 text-[10px] text-emerald-200"
                      >
                        <option value="off">Off</option>
                        <option value="mute">Mute</option>
                        <option value="reverse">Vinyl Reverse</option>
                        <option value="chirp">Scratch Chirp</option>
                      </select>
                    </label>
                  </div>
                </div>
              )}

              {/* VIP A/B/C Auditionable Variations */}
              {vipVariations.length > 0 && (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  {vipVariations.map((v) => (
                    <div
                      key={v.id}
                      className="p-2 rounded-lg bg-[#11151C] border border-purple-500/35 flex flex-col gap-1.5"
                    >
                      <div className="flex items-center justify-between gap-1">
                        <span className="text-[11px] font-bold text-purple-200">
                          VIP {v.id}: {v.name}
                        </span>
                        <button
                          type="button"
                          onClick={() => applyVipVariation(v)}
                          className="px-1.5 py-0.5 rounded bg-purple-500 hover:bg-purple-400 text-[#090B0F] text-[9.5px] font-bold"
                        >
                          Apply
                        </button>
                      </div>
                      <p className="text-[9.5px] text-slate-400 truncate">{v.tagline}</p>
                      {v.previewUrl && <audio controls src={v.previewUrl} className="w-full h-7" />}
                    </div>
                  ))}
                </div>
              )}

              {/* Enhancement #4: Interactive Pre-Render Blueprint Strip */}
              {blueprintSegments.length > 0 && (
                <div className="bg-[#11151C] border border-white/[0.06] rounded-lg p-2.5 flex flex-col gap-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10.5px] font-semibold text-slate-300">
                      AI Arrangement Blueprint (click segment to toggle FX)
                    </span>
                    <button
                      type="button"
                      disabled={isRendering}
                      onClick={() => setRenderSeed((s) => s + 137)}
                      className="h-6 px-2 rounded bg-[#171C26] hover:bg-white/10 border border-white/10 text-[10px] font-semibold text-cyan-300 flex items-center gap-1 transition-colors"
                    >
                      <Shuffle className="w-3 h-3" />
                      <span>Shuffle Take #{(renderSeed % 99) + 1}</span>
                    </button>
                  </div>

                  <div className="flex items-stretch gap-1 overflow-x-auto pb-0.5">
                    {blueprintSegments.map((seg) => {
                      const isMuted = mutedPhaseIndices.includes(seg.index);
                      const spanBars = Math.max(2, seg.barEnd - seg.barStart);
                      const colorClass = isMuted
                        ? 'bg-[#0D1016] border-white/10 text-slate-500 line-through'
                        : seg.kind === 'drop'
                        ? 'bg-rose-500/20 border-rose-400/50 text-rose-100'
                        : seg.kind === 'build'
                        ? 'bg-amber-500/20 border-amber-400/50 text-amber-100'
                        : seg.kind === 'ramp'
                        ? 'bg-emerald-500/20 border-emerald-400/50 text-emerald-100'
                        : seg.kind === 'swap'
                        ? 'bg-purple-500/20 border-purple-400/50 text-purple-100'
                        : 'bg-cyan-500/15 border-cyan-400/40 text-cyan-100';
                      return (
                        <button
                          key={seg.index}
                          type="button"
                          disabled={isRendering}
                          onClick={() => toggleBlueprintPhaseMute(seg.index)}
                          style={{ flexGrow: Math.min(8, Math.max(1, Math.round(spanBars / 4))) }}
                          className={`min-w-[82px] px-2 py-1 rounded border text-left transition-colors ${colorClass}`}
                          title={`${seg.label} (Bars ${seg.barStart + 1}–${seg.barEnd}) · Click to ${
                            isMuted ? 'enable' : 'mute'
                          } phase FX`}
                        >
                          <div className="text-[10px] font-semibold truncate">{seg.label}</div>
                          <div className="text-[9px] font-mono opacity-80 truncate">
                            {seg.bpmRampLabel || seg.detail || `Bars ${seg.barStart + 1}-${seg.barEnd}`}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Custom Cue Start Section Pickers */}
              {renderMode !== 'playlist-mix' && (
                <div className="flex flex-wrap items-center gap-2 bg-[#11151C] px-2.5 py-2 rounded-lg border border-white/[0.06]">
                  {renderCueSelect('Deck A Start', cueAMode, setCueAMode, deckACues, deckACurrentTime)}
                  {renderMode !== 'single-flip' &&
                    renderCueSelect('Deck B Start', cueBMode, setCueBMode, deckBCues, deckBCurrentTime)}
                </div>
              )}

              {/* Enhancement #5: Mastering Profiles */}
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-1.5 text-[11px] text-slate-400">
                  <Sliders className="w-3.5 h-3.5 text-cyan-400" />
                  <span>Mastering Chain &amp; Sub-Mono Tightening:</span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
                  {MASTERING_OPTIONS.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      disabled={isRendering}
                      onClick={() => setMasteringProfile(m.id)}
                      className={`px-2 py-1 rounded-md border text-left transition-colors ${
                        masteringProfile === m.id
                          ? 'bg-cyan-500/20 border-cyan-400 text-cyan-100'
                          : 'bg-[#11151C] border-white/10 text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      <div className="text-[10.5px] font-semibold leading-tight">{m.label}</div>
                      <div className="text-[9.5px] opacity-75 leading-tight">{m.sub}</div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Options + Export Format + Enhancement #6 DJ Pack */}
              <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
                <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-300">
                  <label className="flex items-center gap-1.5 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={includeVoicesAndFx}
                      disabled={isRendering}
                      onChange={(e) => setIncludeVoicesAndFx(e.target.checked)}
                      className="accent-emerald-400"
                    />
                    <span>Voices, Bridge &amp; FX</span>
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={preservePitch}
                      disabled={isRendering}
                      onChange={(e) => setPreservePitch(e.target.checked)}
                      className="accent-cyan-400"
                    />
                    <span>Key-Lock Stretch</span>
                  </label>
                  {renderMode !== 'playlist-mix' && (
                    <label
                      className="flex items-center gap-1.5 cursor-pointer select-none text-amber-200"
                      title="Also exports 8-Bar DJ Intro/Outro Edit, Instrumental, and Acapella stems"
                    >
                      <input
                        type="checkbox"
                        checked={exportDjPack}
                        disabled={isRendering}
                        onChange={(e) => setExportDjPack(e.target.checked)}
                        className="accent-amber-400"
                      />
                      <span>DJ Performance Pack (Stems + 8-Bar Edit)</span>
                    </label>
                  )}
                </div>

                <div className="flex items-center gap-1 bg-[#11151C] p-0.5 rounded-md border border-white/10">
                  <button
                    type="button"
                    disabled={isRendering}
                    onClick={() => setExportFormat('wav')}
                    className={`px-2 py-0.5 rounded text-[10px] font-semibold transition-colors ${
                      exportFormat === 'wav'
                        ? 'bg-cyan-500 text-[#090B0F]'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    WAV (Lossless)
                  </button>
                  <button
                    type="button"
                    disabled={isRendering}
                    onClick={() => setExportFormat('ogg')}
                    className={`px-2 py-0.5 rounded text-[10px] font-semibold transition-colors ${
                      exportFormat === 'ogg'
                        ? 'bg-emerald-500 text-[#090B0F]'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    Opus (.ogg ~10x)
                  </button>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex flex-wrap items-center justify-end gap-2">
                {renderMode !== 'playlist-mix' && (
                  <button
                    type="button"
                    onClick={() => void handleGenerateVipVariations()}
                    disabled={!canRenderCurrentMode || isRendering || vipLoading}
                    className="h-8 px-3 rounded-lg bg-purple-500/20 hover:bg-purple-500/30 disabled:opacity-45 border border-purple-400/40 text-purple-200 font-semibold text-xs flex items-center gap-1.5 transition-colors"
                    title="Render 3 contrasting 8-bar VIP drop variations (A, B, C) for instant A/B/C audition"
                  >
                    {vipLoading ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        <span>Baking A/B/C...</span>
                      </>
                    ) : (
                      <>
                        <Sparkles className="w-3.5 h-3.5" />
                        <span>Gen VIP A/B/C</span>
                      </>
                    )}
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => handleTriggerRender(true)}
                  disabled={!canRenderCurrentMode || isRendering}
                  className="h-8 px-3 rounded-lg bg-[#171C26] hover:bg-white/10 disabled:opacity-45 border border-white/15 text-slate-100 font-semibold text-xs flex items-center gap-1.5 transition-colors"
                >
                  {isRendering && renderingPreview ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-cyan-400" />
                      <span>Preview {renderPct}%</span>
                    </>
                  ) : (
                    <>
                      <Play className="w-3.5 h-3.5 text-cyan-400 fill-current" />
                      <span>8-Bar Preview</span>
                    </>
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => handleTriggerRender(false)}
                  disabled={!canRenderCurrentMode || isRendering}
                  className="h-8 px-3.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 disabled:opacity-45 text-[#090B0F] font-semibold text-xs flex items-center gap-1.5 transition-colors"
                >
                  {isRendering && !renderingPreview ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>Rendering {renderPct}%</span>
                    </>
                  ) : (
                    <>
                      <Zap className="w-3.5 h-3.5 fill-current" />
                      <span>
                        {exportDjPack && renderMode !== 'playlist-mix'
                          ? `Render DJ Pack (.${exportFormat.toUpperCase()})`
                          : renderMode === 'playlist-mix'
                          ? `Render Playlist (.${exportFormat.toUpperCase()})`
                          : renderMode === 'single-flip'
                          ? `Render Club Flip (.${exportFormat.toUpperCase()})`
                          : `Render AI Remix (.${exportFormat.toUpperCase()})`}
                      </span>
                    </>
                  )}
                </button>
              </div>

              {isRendering && (
                <div className="w-full h-1.5 rounded-full bg-[#171C26] overflow-hidden">
                  <div
                    className="h-full bg-cyan-400 transition-all duration-150"
                    style={{ width: `${Math.min(100, Math.max(4, renderPct))}%` }}
                  />
                </div>
              )}

              {previewAudio && (
                <div className="p-2.5 rounded-lg bg-[#11151C] border border-cyan-500/35 flex flex-col gap-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-semibold text-cyan-300 truncate">
                      Audition: {previewAudio.title}
                    </span>
                    <button
                      type="button"
                      onClick={() => setPreviewAudio(null)}
                      className="text-slate-400 hover:text-white p-0.5"
                      aria-label="Close audition preview"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <audio controls autoPlay src={previewAudio.url} className="w-full h-7" />
                </div>
              )}

              {renderError && <p className="text-xs text-rose-400">{renderError}</p>}
            </div>
          )}

          {/* Recorded & Rendered Mixes List */}
          <div className="flex flex-col gap-2">
            <h4 className="text-xs font-semibold tracking-wider text-slate-400 uppercase">
              Exported Sets ({recordings.length})
            </h4>

            {recordings.length === 0 ? (
              <div className="py-5 text-center border border-dashed border-white/10 rounded-xl">
                <p className="text-xs text-slate-400">
                  No exported sets yet. Record live or fast-render a mix above.
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-2 max-h-64 overflow-y-auto pr-1">
                {recordings.map((rec) => {
                  const ext = rec.format === 'ogg' ? 'ogg' : rec.format === 'webm' ? 'webm' : 'wav';
                  const isSheetOpen = openCueSheetId === rec.id;
                  return (
                    <div
                      key={rec.id}
                      className="p-3 rounded-xl bg-[#0D1016] border border-white/[0.08] flex flex-col gap-2"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <p className="text-sm font-medium text-white truncate">{rec.title}</p>
                            {rec.packRole && rec.packRole !== 'master' && (
                              <span className="text-[9.5px] font-mono uppercase text-amber-300 border border-amber-400/30 px-1.5 py-0.5 rounded shrink-0">
                                {rec.packRole}
                              </span>
                            )}
                          </div>
                          <p className="text-[11px] font-mono text-slate-400 tabular-nums">
                            {formatClock(rec.durationSec)} · {ext.toUpperCase()} · {formatBytes(rec.sizeBytes)}
                          </p>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <button
                            type="button"
                            disabled={mixStoryLoadingId === rec.id}
                            onClick={() => void handleGenerateMixStory(rec)}
                            className={`h-8 px-2.5 rounded-lg border text-xs font-semibold flex items-center gap-1 transition-colors ${
                              openStoryId === rec.id
                                ? 'bg-purple-500/20 border-purple-400 text-purple-200'
                                : 'bg-[#171C26] border-white/10 text-purple-200 hover:text-white'
                            }`}
                            title="Auto-generate YouTube chapters, Mixcloud tracklist & social caption"
                          >
                            {mixStoryLoadingId === rec.id ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <BookOpen className="w-3.5 h-3.5" />
                            )}
                            <span>Mix Story</span>
                          </button>
                          {rec.cueSheetText && (
                            <>
                              <button
                                type="button"
                                onClick={() => setOpenCueSheetId(isSheetOpen ? null : rec.id)}
                                className={`h-8 px-2.5 rounded-lg border text-xs font-semibold flex items-center gap-1 transition-colors ${
                                  isSheetOpen
                                    ? 'bg-emerald-500/20 border-emerald-400 text-emerald-200'
                                    : 'bg-[#171C26] border-white/10 text-slate-300 hover:text-white'
                                }`}
                                title="View chapter timestamps"
                              >
                                <FileText className="w-3.5 h-3.5" />
                                <span>Chapters</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDownloadCueSheet(rec)}
                                className="h-8 px-2.5 rounded-lg bg-[#171C26] hover:bg-white/10 border border-white/10 text-slate-200 text-xs font-semibold flex items-center gap-1"
                                title="Download timestamped tracklist & CUE sheet (.txt)"
                              >
                                <Download className="w-3 h-3" />
                                <span>.TXT</span>
                              </button>
                            </>
                          )}
                          <a
                            href={rec.url}
                            download={`${rec.title.replace(/[^\w\-]+/g, '_')}.${ext}`}
                            className="h-8 px-3 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-[#090B0F] font-semibold text-xs flex items-center gap-1.5"
                          >
                            <Download className="w-3.5 h-3.5" />
                            <span>{ext.toUpperCase()}</span>
                          </a>
                          <button
                            type="button"
                            onClick={() => onDeleteRecording(rec.id)}
                            className="p-2 rounded-lg text-slate-400 hover:text-red-400 hover:bg-white/5"
                            aria-label={`Delete ${rec.title}`}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                      <audio controls src={rec.url} className="w-full h-8" />
                      {isSheetOpen && rec.cueSheetText && (
                        <pre className="p-2.5 rounded-lg bg-[#080A0E] border border-white/[0.06] text-[10.5px] font-mono text-slate-300 whitespace-pre-wrap max-h-36 overflow-y-auto">
                          {rec.cueSheetText}
                        </pre>
                      )}
                      {openStoryId === rec.id && rec.mixStory && (
                        <div className="p-2.5 rounded-lg bg-[#080A0E] border border-purple-500/25 flex flex-col gap-1.5 text-[11px] text-slate-200">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-semibold text-purple-200">
                              Auto Chapter &amp; Mix-Story Export
                            </span>
                            <button
                              type="button"
                              onClick={() => {
                                const fullText = [
                                  rec.mixStory!.storySummary,
                                  '',
                                  'YOUTUBE CHAPTERS:',
                                  rec.mixStory!.youtubeChapters,
                                  '',
                                  'SOCIAL CAPTION:',
                                  rec.mixStory!.socialCaption,
                                ].join('\n');
                                void navigator.clipboard?.writeText(fullText);
                                setCopiedStoryId(rec.id);
                                setTimeout(() => setCopiedStoryId(null), 1600);
                              }}
                              className="px-2 py-0.5 rounded bg-purple-500/20 hover:bg-purple-500/35 border border-purple-400/40 text-[10px] font-semibold text-purple-200 flex items-center gap-1"
                            >
                              {copiedStoryId === rec.id ? (
                                <>
                                  <Check className="w-3 h-3" />
                                  <span>Copied</span>
                                </>
                              ) : (
                                <>
                                  <Copy className="w-3 h-3" />
                                  <span>Copy Story + Chapters</span>
                                </>
                              )}
                            </button>
                          </div>
                          <p className="text-slate-300">{rec.mixStory.storySummary}</p>
                          <pre className="p-2 rounded bg-[#05070B] border border-white/[0.05] text-[10px] font-mono text-cyan-200 whitespace-pre-wrap max-h-28 overflow-y-auto">
                            {rec.mixStory.youtubeChapters}
                          </pre>
                          <p className="text-[10.5px] text-amber-200">{rec.mixStory.socialCaption}</p>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
