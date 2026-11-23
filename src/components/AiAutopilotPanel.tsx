import React, { useState } from 'react';
import {
  Bot,
  Zap,
  Play,
  Square,
  Loader2,
  Flame,
  Waves,
  Disc,
  ArrowUpRight,
  Layers,
  Send,
  ListMusic,
  Sparkles,
  Crosshair,
  Volume2,
  PowerOff,
  Drum,
  Timer,
  TrendingUp,
  Gauge,
  Shuffle,
  Rewind,
  ArrowDownRight,
  Music2,
  Zap as ZapIcon,
  Dices,
  BellRing,
  Radio,
  Scissors,
  FolderOpen,
  VolumeX,
  Plus,
  RefreshCw,
  Mic,
  MicOff,
  Check,
  Upload,
  Trash2,
  Sliders,
} from 'lucide-react';
import { ALL_VOICE_IDS, DJ_VOICE_CATEGORIES, DJ_VOICE_LIBRARY } from '../audio/djVoices';
import { DEFAULT_AI_FEATURE_TOGGLES } from '../audio/offlineAiDj';
import {
  AiDjVibe,
  AiEnergyMode,
  AiFeatureKey,
  AutopilotState,
  CustomVoiceDropMeta,
  CustomVoiceSlotId,
  DeckState,
  DjVoiceCategory,
  DjVoiceDropId,
  GrooveBridgePattern,
  MashupTemplateId,
  Playlist,
  SoundTrickType,
  VoiceFrequencyMode,
} from '../types/dj';

const BRIDGE_LABELS: Record<GrooveBridgePattern, string> = {
  off: 'Bridge: Off',
  'top-hats': 'Bridge: Hats',
  'house-4x4': 'Bridge: 4x4',
  'sub-808': 'Bridge: 808',
  'afro-perc': 'Bridge: Afro',
  'chord-arp': 'Bridge: Arp',
};

const MASHUP_TEMPLATES: { id: MashupTemplateId; label: string; title: string }[] = [
  { id: 'club-groove-swap', label: 'Club', title: 'Club Groove Swap: Smooth 16-bar vocal ride + dynamic mid carving' },
  { id: 'festival-double-drop', label: 'Fest', title: 'Festival Double-Drop: 8-bar HPF snare build + 1-beat silence + dual slam' },
  { id: 'hiphop-cut', label: 'HipHop', title: 'Hip-Hop Cut: Wordplay cue-juggles + baby-scratch + 2-beat ping-pong' },
  { id: 'dub-echo-flip', label: 'Dub', title: 'Dub & Echo Flip: Dotted dub delays + tape-brake + vocal callbacks' },
];

interface AiAutopilotPanelProps {
  autopilot: AutopilotState;
  deckA: DeckState;
  deckB: DeckState;
  playlists: Playlist[];
  totalTracksCount: number;
  mashupLoading: boolean;
  onToggleAutopilot: () => void;
  onToggleRemixMode: () => void;
  onToggleQuickMix: () => void;
  onEnergyModeChange: (mode: AiEnergyMode) => void;
  onAggressivenessChange: (val: number) => void;
  onRandomnessChange: (val: number) => void;
  onRegenerateTake: () => void;
  onTriggerWildTake: () => void;
  onTargetPlaylistChange: (playlistId: string) => void;
  onVibeChange: (vibe: AiDjVibe) => void;
  onMashupTemplateChange: (template: MashupTemplateId) => void;
  onMixNow: () => void;
  onDirectAi: (direction: string) => void;
  onMashupBlend: () => void;
  onTriggerTrick: (trick: SoundTrickType) => void;
  onHoldExtraBars: () => void;
  onSwapUpcomingStyle: () => void;
  onToggleMuteSfx: () => void;
  onToggleVoiceFx: () => void;
  onVoiceVolumeChange: (vol: number) => void;
  onVoiceFrequencyChange: (freq: VoiceFrequencyMode) => void;
  onToggleVoiceItem: (voiceId: DjVoiceDropId) => void;
  onSetVoiceCategoryEnabled: (category: DjVoiceCategory, enabled: boolean) => void;
  onEnableAllVoices: (enableAll: boolean) => void;
  onTriggerVoice: (voiceId: DjVoiceDropId) => void;
  customVoiceDrops: CustomVoiceDropMeta[];
  recordingSlotId: CustomVoiceSlotId | null;
  micError: string | null;
  onToggleRecordCustomSlot: (slotId: CustomVoiceSlotId) => void;
  onUploadCustomSlot: (slotId: CustomVoiceSlotId, file: File) => void;
  onTriggerCustomSlot: (slotId: CustomVoiceSlotId) => void;
  onToggleCustomSlotEnabled: (slotId: CustomVoiceSlotId) => void;
  onTrimCustomSlot: (slotId: CustomVoiceSlotId) => void;
  onClearCustomSlot: (slotId: CustomVoiceSlotId) => void;
  onToggleFeature: (key: AiFeatureKey) => void;
  onApplyFeaturePreset: (preset: 'all-on' | 'clean-mix') => void;
  onCycleGrooveBridge: () => void;
  onOpenCrate?: () => void;
}

const AI_FEATURE_CONTROLS: {
  key: AiFeatureKey;
  label: string;
  sub: string;
  desc: string;
}[] = [
  {
    key: 'vipSkip',
    label: 'VIP Skip',
    sub: 'Off = full song length',
    desc: 'Allow AI to skip long intros/verses on long tracks (disable to keep full song length)',
  },
  {
    key: 'breakdownTease',
    label: 'Next Tease',
    sub: 'Vocal breakdown peek',
    desc: 'Preview upcoming track vocals during breakdowns before transition',
  },
  {
    key: 'vocalCarryover',
    label: 'Vox Carry',
    sub: 'Float old vocals',
    desc: 'Keep outgoing track vocals floating over incoming track after crossfade',
  },
  {
    key: 'songMoments',
    label: 'Mid FX',
    sub: 'Sweeps & loops',
    desc: 'Trigger beat-quantized sweeps, echoes, filters & loops mid-track',
  },
  {
    key: 'dropFakeouts',
    label: 'Fakeouts',
    sub: 'Drop build rolls',
    desc: 'Trigger VIP loop-roll fakeouts before song drops',
  },
  {
    key: 'beatSliceStutter',
    label: 'Beat Slice',
    sub: 'Stutters & juggles',
    desc: 'Trigger transient beat-slice stutters, chops & hot-cue wordplay juggles',
  },
  {
    key: 'autoGrooveBridge',
    label: 'Auto Drums',
    sub: 'Groove Bridge synth',
    desc: 'Auto-layer Groove Bridge synth drums during transitions & YT takeovers',
  },
  {
    key: 'spectralSidechain',
    label: 'Vox Duck',
    sub: '1.75kHz mid carve',
    desc: 'Automatically dip competing 1.75kHz mids when vocals overlap',
  },
];

const VIBES: { id: AiDjVibe; label: string }[] = [
  { id: 'club-blend', label: 'Club' },
  { id: 'festival-drop', label: 'Festival' },
  { id: 'techno-hypnotic', label: 'Techno' },
  { id: 'scratch-chop', label: 'Chop' },
  { id: 'mashup-live', label: 'Mashup' },
  { id: 'chill-sunset', label: 'Sunset' },
];

const QUICK_AI_MOVES: { label: string; prompt: string }[] = [
  { label: 'Staircase Drop', prompt: 'staircase silence gap' },
  { label: 'Cue Juggle', prompt: 'wordplay cue juggle' },
  { label: 'Ping-Pong', prompt: 'ping pong chop seq' },
  { label: 'Transformer', prompt: 'transformer chop seq' },
  { label: 'Drop Swap', prompt: 'drop swap roll' },
  { label: 'Echo Freeze', prompt: 'echo freeze horn' },
  { label: 'Sub Punch', prompt: 'sub bass boost' },
  { label: 'Shimmer Lift', prompt: 'shimmer air euphoric' },
];

const TRICKS: {
  id: SoundTrickType;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  { id: 'riser', label: 'Riser', icon: ArrowUpRight },
  { id: 'sub-drop', label: 'Sub', icon: Flame },
  { id: 'dub-siren', label: 'Siren', icon: Waves },
  { id: 'backspin', label: 'Spin', icon: Disc },
  { id: 'laser', label: 'Laser', icon: Crosshair },
  { id: 'air-horn', label: 'Horn', icon: Volume2 },
  { id: 'vinyl-stop', label: 'Stop', icon: PowerOff },
  { id: 'snare-roll', label: 'Roll', icon: Drum },
  { id: 'tape-rewind', label: 'Rewind', icon: Rewind },
  { id: 'sweep-down', label: 'Down', icon: ArrowDownRight },
  { id: 'chord-stab', label: 'Stab', icon: Music2 },
  { id: 'scratch-chirp', label: 'Chirp', icon: ZapIcon },
  { id: 'drop-alarm', label: 'Alarm', icon: BellRing },
  { id: 'tom-fill', label: 'Toms', icon: Radio },
  { id: 'vinyl-crack', label: 'Whip', icon: Scissors },
  { id: 'riser-chord', label: 'Rise+', icon: TrendingUp },
];

export const AiAutopilotPanel: React.FC<AiAutopilotPanelProps> = ({
  autopilot,
  deckA,
  deckB,
  playlists,
  totalTracksCount,
  mashupLoading,
  onToggleAutopilot,
  onToggleRemixMode,
  onToggleQuickMix,
  onEnergyModeChange,
  onAggressivenessChange,
  onRandomnessChange,
  onRegenerateTake,
  onTriggerWildTake,
  onTargetPlaylistChange,
  onVibeChange,
  onMashupTemplateChange,
  onMixNow,
  onDirectAi,
  onMashupBlend,
  onTriggerTrick,
  onHoldExtraBars,
  onSwapUpcomingStyle,
  onToggleMuteSfx,
  onToggleVoiceFx,
  onVoiceVolumeChange,
  onVoiceFrequencyChange,
  onToggleVoiceItem,
  onSetVoiceCategoryEnabled,
  onEnableAllVoices,
  onTriggerVoice,
  customVoiceDrops,
  recordingSlotId,
  micError,
  onToggleRecordCustomSlot,
  onUploadCustomSlot,
  onTriggerCustomSlot,
  onToggleCustomSlotEnabled,
  onTrimCustomSlot,
  onClearCustomSlot,
  onToggleFeature,
  onApplyFeaturePreset,
  onCycleGrooveBridge,
  onOpenCrate,
}) => {
  const [directionInput, setDirectionInput] = useState('');
  const [zone3Tab, setZone3Tab] = useState<'tricks' | 'voices' | 'features'>('tricks');
  const [voiceCategoryFilter, setVoiceCategoryFilter] = useState<DjVoiceCategory | 'all'>('all');
  const [dragOverSlotId, setDragOverSlotId] = useState<CustomVoiceSlotId | null>(null);
  const isTransitioning = autopilot.phase === 'transitioning';
  const isPlanning = autopilot.phase === 'planning';
  const enabledFeaturesCount = AI_FEATURE_CONTROLS.filter(
    (f) => autopilot.features?.[f.key] ?? DEFAULT_AI_FEATURE_TOGGLES[f.key]
  ).length;

  const enabledVoiceSet = new Set(autopilot.enabledVoiceIds);
  const filteredVoices =
    voiceCategoryFilter === 'all'
      ? DJ_VOICE_LIBRARY
      : DJ_VOICE_LIBRARY.filter((v) => v.category === voiceCategoryFilter);
  const allFilteredEnabled =
    filteredVoices.length > 0 && filteredVoices.every((v) => enabledVoiceSet.has(v.id));

  const handleSubmitDirection = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = directionInput.trim();
    if (!clean) return;
    onDirectAi(clean);
    setDirectionInput('');
  };

  const nextEnergyMode = (): AiEnergyMode =>
    autopilot.energyMode === 'wave'
      ? 'build'
      : autopilot.energyMode === 'build'
      ? 'chill'
      : 'wave';

  return (
    <section
      className={`bg-[#11151C] border rounded-xl p-2.5 sm:p-3 flex flex-col lg:grid lg:grid-cols-12 gap-3 h-full min-h-0 ${
        autopilot.enabled ? 'border-emerald-500/40' : 'border-white/[0.08]'
      }`}
    >
      {/* ZONE 1 (Left, 4 cols): Offline AI Engine, Aggressiveness, Randomness & Vibes */}
      <div className="lg:col-span-4 flex flex-col justify-between gap-2 lg:border-r lg:border-white/[0.06] lg:pr-3 min-w-0">
        <div className="flex items-center justify-between gap-1.5 shrink-0">
          <div className="flex items-center gap-1.5 min-w-0">
            <Bot
              className={`w-4 h-4 shrink-0 ${
                autopilot.enabled ? 'text-emerald-400' : 'text-cyan-400'
              }`}
            />
            <h3 className="text-xs font-display font-bold tracking-wide text-white truncate">
              AI AUTO-PILOT & FX ENGINE
            </h3>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={onMashupBlend}
              disabled={mashupLoading}
              className={`h-6 px-2 rounded-md border text-[10px] font-semibold flex items-center gap-1 transition-colors whitespace-nowrap shrink-0 disabled:opacity-45 ${
                autopilot.mashupRoutineActive
                  ? 'bg-purple-500 text-[#090B0F] border-purple-400 font-bold'
                  : 'bg-[#171C26] hover:bg-white/10 border-white/15 text-slate-200'
              }`}
              title="Start/Stop 32-Bar Live Bootleg Mashup Routine across Deck A + B"
            >
              {mashupLoading ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <Layers
                  className={`w-3 h-3 ${
                    autopilot.mashupRoutineActive ? 'text-[#090B0F]' : 'text-purple-400'
                  }`}
                />
              )}
              <span>{autopilot.mashupRoutineActive ? 'Stop A+B' : 'Blend A+B'}</span>
            </button>

            {autopilot.enabled && (
              <button
                type="button"
                onClick={onMixNow}
                disabled={isTransitioning || isPlanning}
                className="h-6 px-2 rounded-md bg-cyan-500 hover:bg-cyan-400 text-[#090B0F] text-[10px] font-bold flex items-center gap-1 transition-colors whitespace-nowrap shrink-0 disabled:opacity-45"
                title="Execute AI transition & tricks immediately"
              >
                <Zap className="w-3 h-3 fill-current" />
                <span>Mix Now</span>
              </button>
            )}

            <button
              type="button"
              onClick={onToggleAutopilot}
              className={`h-6 px-2.5 rounded-md text-[10px] font-bold flex items-center gap-1 border transition-colors whitespace-nowrap shrink-0 ${
                autopilot.enabled
                  ? 'bg-emerald-500 text-[#090B0F] border-emerald-400'
                  : 'bg-[#171C26] border-emerald-500/40 text-emerald-300 hover:bg-emerald-500 hover:text-[#090B0F]'
              }`}
            >
              {isPlanning ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : autopilot.enabled ? (
                <Square className="w-2.5 h-2.5 fill-current" />
              ) : (
                <Play className="w-2.5 h-2.5 fill-current" />
              )}
              <span>{autopilot.enabled ? 'STOP AI' : 'AUTO AI'}</span>
            </button>
          </div>
        </div>

        {/* Target Playlist + Offline Mix Modes */}
        <div className="flex items-center gap-1 shrink-0">
          <ListMusic className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
          <select
            aria-label="AI Auto-Pilot Playlist"
            value={autopilot.targetPlaylistId}
            onChange={(e) => onTargetPlaylistChange(e.target.value)}
            className="flex-1 h-7 px-2 rounded bg-[#090B0F] border border-white/10 text-[11px] font-medium text-slate-200 focus:outline-none focus:border-emerald-400 min-w-0 cursor-pointer"
          >
            {playlists.map((pl) => {
              const count = pl.id === 'all' ? totalTracksCount : pl.trackIds.length;
              return (
                <option key={pl.id} value={pl.id} className="bg-[#11151C] text-white">
                  {pl.name} ({count})
                </option>
              );
            })}
          </select>
          {onOpenCrate && (
            <button
              type="button"
              onClick={onOpenCrate}
              className="h-7 px-2 rounded bg-[#171C26] hover:bg-white/10 border border-white/15 text-[10px] font-semibold text-cyan-300 flex items-center gap-1 whitespace-nowrap shrink-0 transition-colors"
              title="Open hideable Song Chooser & Playlist Builder sidebar"
            >
              <FolderOpen className="w-3 h-3" />
              <span>Songs</span>
            </button>
          )}
          <button
            type="button"
            onClick={onToggleRemixMode}
            className={`h-7 px-2 rounded text-[10px] font-semibold border flex items-center gap-1 whitespace-nowrap shrink-0 transition-colors ${
              autopilot.remixMode
                ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-300'
                : 'bg-[#090B0F] border-white/10 text-slate-400 hover:text-slate-200'
            }`}
            title="Toggle Offline AI Live Remix Mode (mid-track fills, stem carving & double drops)"
          >
            <Sparkles className="w-3 h-3" />
            <span>{autopilot.remixMode ? 'Remix' : 'Mix'}</span>
          </button>
          <button
            type="button"
            onClick={onToggleQuickMix}
            className={`h-7 px-2 rounded text-[10px] font-semibold border flex items-center gap-1 whitespace-nowrap shrink-0 transition-colors ${
              autopilot.quickMix
                ? 'bg-cyan-500/20 border-cyan-500/50 text-cyan-300'
                : 'bg-[#090B0F] border-white/10 text-slate-400 hover:text-slate-200'
            }`}
            title="Quick Mix transitions around ~35% of each track vs ~62% Full Club pacing"
          >
            <Timer className="w-3 h-3" />
            <span>{autopilot.quickMix ? 'Fast' : 'Full'}</span>
          </button>
          <button
            type="button"
            onClick={() => onEnergyModeChange(nextEnergyMode())}
            className="h-7 px-2 rounded text-[10px] font-semibold border bg-[#090B0F] border-white/10 text-slate-300 hover:text-white flex items-center gap-1 whitespace-nowrap shrink-0 capitalize"
            title="Cycle Offline AI Energy Curve (Wave / Build / Chill)"
          >
            <TrendingUp className="w-3 h-3 text-amber-400" />
            <span>{autopilot.energyMode}</span>
          </button>
        </div>

        {/* Dual Entropy Controls: Aggressiveness + Randomness */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
          <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-[#0B0E14] border border-white/[0.06]">
            <Gauge className="w-3 h-3 text-amber-400 shrink-0" />
            <span className="text-[10px] font-semibold text-slate-400 shrink-0">Aggr</span>
            <input
              type="range"
              aria-label="AI Remix Aggressiveness"
              min={0}
              max={100}
              step={5}
              value={autopilot.aggressiveness}
              onChange={(e) => onAggressivenessChange(parseInt(e.target.value, 10))}
              className="dj-fader flex-1 h-4"
            />
            <span
              className={`text-[10px] font-mono font-semibold tabular-nums shrink-0 ${
                autopilot.aggressiveness >= 70
                  ? 'text-orange-400'
                  : autopilot.aggressiveness <= 30
                  ? 'text-cyan-300'
                  : 'text-emerald-300'
              }`}
            >
              {autopilot.aggressiveness}%
            </span>
          </div>

          <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-[#0B0E14] border border-white/[0.06]">
            <Dices className="w-3 h-3 text-purple-400 shrink-0" />
            <span className="text-[10px] font-semibold text-slate-400 shrink-0">Rand</span>
            <input
              type="range"
              aria-label="AI Session Randomness"
              min={0}
              max={100}
              step={5}
              value={autopilot.randomness}
              onChange={(e) => onRandomnessChange(parseInt(e.target.value, 10))}
              className="dj-fader flex-1 h-4"
            />
            <span className="text-[10px] font-mono font-semibold tabular-nums text-purple-300 shrink-0">
              {autopilot.randomness}%
            </span>
            <button
              type="button"
              onClick={onRegenerateTake}
              className="h-5 px-1.5 rounded bg-[#171C26] hover:bg-white/10 border border-white/10 text-[9px] font-semibold text-slate-200 hover:text-white flex items-center gap-0.5 shrink-0"
              title="Re-roll unique AI session take seed"
            >
              <Shuffle className="w-2.5 h-2.5 text-cyan-400" />
              <span>Take</span>
            </button>
          </div>
        </div>

        {/* 6 Mixing Vibes */}
        <div className="grid grid-cols-6 gap-1">
          {VIBES.map((v) => (
            <button
              key={v.id}
              type="button"
              onClick={() => onVibeChange(v.id)}
              className={`h-6 px-1 rounded text-[10px] font-medium border transition-colors truncate ${
                autopilot.vibe === v.id
                  ? 'bg-white/15 border-white/25 text-white'
                  : 'bg-[#0D1016] border-white/[0.06] text-slate-400 hover:text-slate-200'
              }`}
            >
              {v.label}
            </button>
          ))}
        </div>

        {/* 4 Selectable 32-Bar Mashup Styles */}
        <div className="flex items-center gap-1">
          <span className="text-[9px] font-mono uppercase tracking-wider text-purple-300/80 shrink-0">
            Style
          </span>
          <div className="grid grid-cols-4 gap-1 flex-1">
            {MASHUP_TEMPLATES.map((tpl) => (
              <button
                key={tpl.id}
                type="button"
                onClick={() => onMashupTemplateChange(tpl.id)}
                title={tpl.title}
                className={`h-5 px-1 rounded text-[9.5px] font-semibold border transition-colors truncate ${
                  autopilot.mashupTemplate === tpl.id
                    ? 'bg-purple-500/25 border-purple-400/60 text-purple-200'
                    : 'bg-[#0B0E14] border-white/[0.06] text-slate-400 hover:text-slate-200'
                }`}
              >
                {tpl.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ZONE 2 (Center, 4 cols): Pre-Transition Blueprint Preview, Overrides & Instant Choreography */}
      <div className="lg:col-span-4 flex flex-col justify-between gap-1.5 lg:border-r lg:border-white/[0.06] lg:pr-3 min-w-0">
        {/* Live Telemetry, Blueprint Preview & Active Dual-Deck FX Routing Display */}
        <div className="bg-[#0B0E14] border border-white/[0.06] rounded-lg px-2.5 py-1.5 flex flex-col gap-0.5 min-w-0">
          <div className="flex items-center justify-between gap-2 text-[11px]">
            <span className="font-medium text-slate-100 truncate">
              {autopilot.errorMessage
                ? autopilot.errorMessage
                : autopilot.activePlan
                ? autopilot.activePlan.mixStyle
                : 'Ready · Auto AI, Wild Take or Blend A+B'}
            </span>
            <span className="font-mono text-[10px] text-emerald-400 uppercase tabular-nums shrink-0">
              {autopilot.phase === 'cruising' && autopilot.nextTransitionEtaSec !== null
                ? `MIX IN ${autopilot.nextTransitionEtaSec}S`
                : autopilot.phase}
            </span>
          </div>

          <p className="text-[10px] text-slate-400 truncate">
            {autopilot.currentActionLabel ||
              autopilot.activePlan?.aiNotes ||
              'Offline AI automates per-song FX, Groove Bridge, PLL sync & 32-bar bootleg mashups.'}
          </p>

          {autopilot.enabled && autopilot.activePlan ? (
            <div className="flex items-center justify-between gap-2 text-[10px] font-mono tabular-nums text-cyan-300/90 truncate">
              <span className="truncate">
                {autopilot.activePlan.grooveRecipeLabel || 'Balanced Blend'}
                {autopilot.activePlan.bpmDeltaLabel ? ` · ${autopilot.activePlan.bpmDeltaLabel}` : ''}
                {autopilot.activePlan.keyTransitionLabel
                  ? ` · Key ${autopilot.activePlan.keyTransitionLabel}`
                  : ''}
                {typeof autopilot.activePlan.doubleDropCueSec === 'number'
                  ? ' · 2xDrop'
                  : ''}
                {autopilot.activePlan.clashProfile
                  ? ` · Clash ${Math.round(autopilot.activePlan.clashProfile.bassClash * 100)}%`
                  : ''}
              </span>
              {autopilot.upcomingQueue.length > 0 && (
                <span className="truncate text-slate-500">
                  {autopilot.upcomingQueue[0].title.split('(')[0].trim()}
                </span>
              )}
            </div>
          ) : (
            <div className="flex items-center justify-between gap-2 text-[10px] font-mono tabular-nums text-slate-400">
              <span className="truncate">
                <span className="text-cyan-400">A:</span>{' '}
                {deckA.fx.enabled ? `${deckA.fx.type} ${Math.round(deckA.fx.wet * 100)}%` : 'dry'}
                {' · '}
                <span className="text-orange-400">B:</span>{' '}
                {deckB.fx.enabled ? `${deckB.fx.type} ${Math.round(deckB.fx.wet * 100)}%` : 'dry'}
              </span>
              {autopilot.upcomingQueue.length > 0 && (
                <span className="truncate text-slate-500">
                  Next: {autopilot.upcomingQueue[0].title.split('(')[0].trim()}
                </span>
              )}
            </div>
          )}

          <div className="w-full h-1 rounded-full bg-[#171C26] overflow-hidden mt-0.5">
            <div
              className={`h-full transition-all duration-100 ${
                isTransitioning ? 'bg-emerald-400' : 'bg-cyan-500/40'
              }`}
              style={{
                width: `${Math.round(
                  (isTransitioning ? autopilot.transitionProgress : autopilot.enabled ? 0.18 : 0) * 100
                )}%`,
              }}
            />
          </div>
        </div>

        {/* Advance #7 & #3: Pre-Transition Micro-Overrides + Live In-Key Groove Bridge */}
        <div className="grid grid-cols-4 gap-1">
          <button
            type="button"
            onClick={onHoldExtraBars}
            disabled={!autopilot.enabled || isTransitioning || isPlanning}
            className={`h-6 px-1.5 rounded text-[10px] font-semibold border flex items-center justify-center gap-1 transition-colors whitespace-nowrap disabled:opacity-40 ${
              autopilot.holdExtraBars > 0
                ? 'bg-cyan-500/20 border-cyan-500/45 text-cyan-300'
                : 'bg-[#151A24] border-white/[0.08] text-slate-300 hover:text-white'
            }`}
            title="Delay the upcoming AI transition by +8 bars"
          >
            <Plus className="w-3 h-3 shrink-0" />
            <span>{autopilot.holdExtraBars > 0 ? `+${autopilot.holdExtraBars}b` : '+8 Bars'}</span>
          </button>

          <button
            type="button"
            onClick={onSwapUpcomingStyle}
            disabled={!autopilot.enabled || isTransitioning || isPlanning}
            className="h-6 px-1.5 rounded text-[10px] font-semibold bg-[#151A24] hover:bg-white/10 border border-white/[0.08] text-slate-300 hover:text-white flex items-center justify-center gap-1 transition-colors whitespace-nowrap disabled:opacity-40"
            title="Re-roll the upcoming transition style & next song pairing (trains Taste Q-Memory)"
          >
            <RefreshCw className="w-2.5 h-2.5 shrink-0" />
            <span>Swap</span>
          </button>

          <button
            type="button"
            onClick={onToggleMuteSfx}
            className={`h-6 px-1.5 rounded text-[10px] font-semibold border flex items-center justify-center gap-1 transition-colors whitespace-nowrap ${
              autopilot.muteSoundTricks
                ? 'bg-amber-500/20 border-amber-500/45 text-amber-300'
                : 'bg-[#151A24] border-white/[0.08] text-slate-300 hover:text-white'
            }`}
            title="Mute or allow AI auto-triggered risers, sirens, and horns during sets"
          >
            <VolumeX className="w-3 h-3 shrink-0" />
            <span>{autopilot.muteSoundTricks ? 'SFX Off' : 'SFX On'}</span>
          </button>

          <button
            type="button"
            onClick={onCycleGrooveBridge}
            className={`h-6 px-1.5 rounded text-[10px] font-semibold border flex items-center justify-center gap-1 transition-colors whitespace-nowrap truncate ${
              autopilot.grooveBridgePattern !== 'off'
                ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-300'
                : 'bg-[#151A24] border-white/[0.08] text-slate-300 hover:text-white'
            }`}
            title="Cycle live AudioContext quantized Drum & Bass Bridge locked to track BPM & Camelot key"
          >
            <Drum className="w-3 h-3 shrink-0" />
            <span className="truncate">{BRIDGE_LABELS[autopilot.grooveBridgePattern]}</span>
          </button>
        </div>

        {/* 8 One-Click AI FX Transition Choreography Triggers (4x2) */}
        <div className="grid grid-cols-4 gap-1">
          {QUICK_AI_MOVES.map((mv) => (
            <button
              key={mv.label}
              type="button"
              disabled={isPlanning}
              onClick={() => onDirectAi(mv.prompt)}
              className="h-6 px-1.5 rounded text-[10px] font-medium bg-[#151A24] hover:bg-cyan-500/20 hover:text-cyan-300 border border-white/[0.08] text-slate-300 transition-colors truncate whitespace-nowrap disabled:opacity-40"
              title={`Command AI to execute ${mv.label} immediately`}
            >
              {mv.label}
            </button>
          ))}
        </div>

        {/* Wild Take Improviser + Custom Offline AI Cue Prompt */}
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onTriggerWildTake}
            className="h-7 px-2.5 rounded-md bg-purple-500/20 hover:bg-purple-500 hover:text-[#090B0F] border border-purple-500/45 text-purple-300 text-[10px] font-bold flex items-center gap-1 transition-colors whitespace-nowrap shrink-0"
            title="Trigger an instant randomized offline FX + stem cut + trick burst on the playing deck"
          >
            <Dices className="w-3.5 h-3.5" />
            <span>Wild Take</span>
          </button>

          <form onSubmit={handleSubmitDirection} className="flex-1 flex items-center gap-1 min-w-0">
            <input
              type="text"
              value={directionInput}
              onChange={(e) => setDirectionInput(e.target.value)}
              placeholder="Cue AI (sub, shimmer, lofi, dub, stutter)..."
              className="flex-1 h-7 px-2 rounded-md bg-[#090B0F] border border-white/10 text-[11px] text-white placeholder:text-slate-500 focus:outline-none focus:border-cyan-400 min-w-0"
            />
            <button
              type="submit"
              disabled={!directionInput.trim() || isPlanning}
              className="h-7 px-2.5 rounded-md bg-cyan-500/20 border border-cyan-500/40 text-cyan-300 hover:bg-cyan-500 hover:text-[#090B0F] text-[10px] font-semibold flex items-center gap-1 transition-colors disabled:opacity-40 shrink-0"
              title="Execute AI transition cue"
            >
              <Send className="w-3 h-3" />
            </button>
          </form>
        </div>
      </div>

      {/* ZONE 3 (Right, 4 cols): Master Sound Tricks (16) & Enable/Disable DJ Voices Studio (24) */}
      <div className="lg:col-span-4 flex flex-col justify-between gap-1.5 min-w-0">
        <div className="flex items-center justify-between gap-1.5 shrink-0">
          <div className="flex items-center gap-1 bg-[#0B0E14] p-0.5 rounded-md border border-white/[0.08]">
            <button
              type="button"
              onClick={() => setZone3Tab('tricks')}
              className={`h-5 px-2 rounded text-[10px] font-display font-bold uppercase tracking-wide transition-colors ${
                zone3Tab === 'tricks'
                  ? 'bg-cyan-500 text-[#090B0F]'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Tricks (16)
            </button>
            <button
              type="button"
              onClick={() => setZone3Tab('voices')}
              className={`h-5 px-2 rounded text-[10px] font-display font-bold uppercase tracking-wide flex items-center gap-1 transition-colors ${
                zone3Tab === 'voices'
                  ? 'bg-emerald-500 text-[#090B0F]'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Mic className="w-2.5 h-2.5 shrink-0" />
              <span>
                Voices ({autopilot.enabledVoiceIds.length}/{ALL_VOICE_IDS.length})
              </span>
            </button>
            <button
              type="button"
              onClick={() => setZone3Tab('features')}
              title="Enable or disable VIP Skip and automatic AI DJ behaviors"
              className={`h-5 px-2 rounded text-[10px] font-display font-bold uppercase tracking-wide flex items-center gap-1 transition-colors ${
                zone3Tab === 'features'
                  ? 'bg-amber-400 text-[#090B0F]'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Sliders className="w-2.5 h-2.5 shrink-0" />
              <span>Auto ({enabledFeaturesCount}/8)</span>
            </button>
          </div>

          <button
            type="button"
            onClick={onToggleVoiceFx}
            className={`h-6 px-2 rounded-md text-[10px] font-semibold border flex items-center gap-1 transition-colors whitespace-nowrap shrink-0 ${
              autopilot.voiceFxEnabled && !autopilot.muteSoundTricks
                ? 'bg-emerald-500/20 border-emerald-500/45 text-emerald-300'
                : 'bg-[#171C26] border-white/10 text-slate-400 hover:text-slate-200'
            }`}
            title="Master toggle: allow or disable DJ voices, grooving chants, and shouts in AI offline remixes"
          >
            {autopilot.voiceFxEnabled ? (
              <Mic className="w-3 h-3 shrink-0" />
            ) : (
              <MicOff className="w-3 h-3 shrink-0" />
            )}
            <span>{autopilot.voiceFxEnabled ? 'AI Vox On' : 'AI Vox Off'}</span>
          </button>
        </div>

        {zone3Tab === 'tricks' ? (
          <div className="grid grid-cols-4 gap-1 flex-1">
            {TRICKS.map((t) => {
              const Icon = t.icon;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => onTriggerTrick(t.id)}
                  className="min-h-[30px] px-1 rounded-md bg-[#171C26] hover:bg-white/10 active:scale-[0.97] border border-white/10 text-[10px] font-semibold text-slate-200 flex items-center justify-center gap-1 transition-all whitespace-nowrap"
                >
                  <Icon className="w-3 h-3 text-cyan-400 shrink-0" />
                  <span className="truncate">{t.label}</span>
                </button>
              );
            })}
          </div>
        ) : zone3Tab === 'voices' ? (
          <div className="flex flex-col gap-1 flex-1 min-h-0">
            {/* Dedicated Voice Mix Level Slider + AI Trigger Frequency */}
            <div className="flex items-center gap-2 px-1.5 py-0.5 rounded bg-[#0B0E14] border border-white/[0.06] shrink-0">
              <div className="flex items-center gap-1 flex-1 min-w-0">
                <Volume2 className="w-3 h-3 text-emerald-400 shrink-0" />
                <span className="text-[9px] font-semibold text-slate-400 shrink-0">Vox</span>
                <input
                  type="range"
                  aria-label="DJ Voice Mix Level"
                  min={0}
                  max={150}
                  step={5}
                  value={Math.round(autopilot.voiceVolume * 100)}
                  onChange={(e) => onVoiceVolumeChange(parseInt(e.target.value, 10) / 100)}
                  className="dj-fader flex-1 h-3.5"
                />
                <span className="text-[9.5px] font-mono tabular-nums text-emerald-300 shrink-0 w-7 text-right">
                  {Math.round(autopilot.voiceVolume * 100)}%
                </span>
              </div>
              <div className="flex items-center gap-0.5 shrink-0">
                {(['rare', 'normal', 'hype'] as VoiceFrequencyMode[]).map((freq) => (
                  <button
                    key={freq}
                    type="button"
                    onClick={() => onVoiceFrequencyChange(freq)}
                    title={`AI DJ Voice trigger frequency: ${freq}`}
                    className={`h-4 px-1.5 rounded text-[8.5px] font-semibold uppercase border transition-colors ${
                      autopilot.voiceFrequency === freq
                        ? 'bg-emerald-500/25 border-emerald-500/50 text-emerald-200'
                        : 'bg-[#121620] border-white/[0.06] text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {freq === 'normal' ? 'Norm' : freq}
                  </button>
                ))}
              </div>
            </div>

            {/* Category Filter + Bulk Enable/Disable Row */}
            <div className="flex items-center justify-between gap-1 shrink-0 overflow-x-auto">
              <div className="flex items-center gap-1 min-w-0">
                <button
                  type="button"
                  onClick={() => setVoiceCategoryFilter('all')}
                  className={`h-5 px-1.5 rounded text-[9px] font-semibold border transition-colors whitespace-nowrap ${
                    voiceCategoryFilter === 'all'
                      ? 'bg-white/15 border-white/25 text-white'
                      : 'bg-[#0B0E14] border-white/[0.06] text-slate-400 hover:text-slate-200'
                  }`}
                >
                  All
                </button>
                {DJ_VOICE_CATEGORIES.map((cat) => (
                  <button
                    key={cat.id}
                    type="button"
                    onClick={() => setVoiceCategoryFilter(cat.id)}
                    className={`h-5 px-1.5 rounded text-[9px] font-semibold border transition-colors whitespace-nowrap ${
                      voiceCategoryFilter === cat.id
                        ? 'bg-emerald-500/20 border-emerald-500/45 text-emerald-300'
                        : 'bg-[#0B0E14] border-white/[0.06] text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {cat.label}
                  </button>
                ))}
              </div>

              <button
                type="button"
                onClick={() => {
                  if (voiceCategoryFilter === 'all') {
                    onEnableAllVoices(!allFilteredEnabled);
                  } else {
                    onSetVoiceCategoryEnabled(voiceCategoryFilter, !allFilteredEnabled);
                  }
                }}
                className="h-5 px-1.5 rounded bg-[#171C26] hover:bg-white/10 border border-white/10 text-[9px] font-semibold text-cyan-300 whitespace-nowrap shrink-0"
                title={
                  allFilteredEnabled
                    ? 'Disable all shown voices from AI offline remixes'
                    : 'Enable all shown voices for AI offline remixes'
                }
              >
                {allFilteredEnabled ? 'Disable Shown' : 'Enable Shown'}
              </button>
            </div>

            {/* Scrollable Voice Pads Grid: Click label to play live, click check to enable/disable for AI */}
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-1 overflow-y-auto max-h-[62px] pr-0.5 flex-1">
              {filteredVoices.map((v) => {
                const isEnabled = enabledVoiceSet.has(v.id);
                return (
                  <div
                    key={v.id}
                    className={`h-[24px] rounded-md border flex items-stretch overflow-hidden transition-colors ${
                      isEnabled && autopilot.voiceFxEnabled
                        ? 'bg-[#171C26] border-emerald-500/40 text-slate-100'
                        : isEnabled
                        ? 'bg-[#151A24] border-white/15 text-slate-300'
                        : 'bg-[#0C0F15] border-white/[0.06] text-slate-500'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => onTriggerVoice(v.id)}
                      title={`${v.calloutText} — ${v.description} (Click to trigger live)`}
                      className="flex-1 px-1.5 text-[9.5px] font-semibold text-left truncate hover:bg-white/10 active:bg-white/15 transition-colors"
                    >
                      {v.label}
                    </button>
                    <button
                      type="button"
                      onClick={() => onToggleVoiceItem(v.id)}
                      aria-label={`${isEnabled ? 'Disable' : 'Enable'} ${v.label} in AI remixes`}
                      title={
                        isEnabled
                          ? `Included in AI remixes — click to disable ${v.label}`
                          : `Disabled in AI remixes — click to enable ${v.label}`
                      }
                      className={`w-5 shrink-0 flex items-center justify-center border-l transition-colors ${
                        isEnabled
                          ? 'border-emerald-500/30 bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/35'
                          : 'border-white/[0.06] bg-transparent text-slate-600 hover:text-slate-300 hover:bg-white/5'
                      }`}
                    >
                      <Check className={`w-2.5 h-2.5 ${isEnabled ? 'opacity-100' : 'opacity-25'}`} />
                    </button>
                  </div>
                );
              })}
            </div>

            {/* Upgrade #6: Compact 4-Slot My Drops (Mic Record / Audio File Upload) */}
            <div className="flex flex-col gap-0.5 shrink-0">
              {micError && (
                <div className="text-[9px] text-rose-400 truncate px-1">{micError}</div>
              )}
              <div className="grid grid-cols-4 gap-1 shrink-0">
                {customVoiceDrops.map((slot) => {
                  const isRec = recordingSlotId === slot.id;
                  const isDragOver = dragOverSlotId === slot.id;
                  return (
                    <div
                      key={slot.id}
                      onDragOver={(e) => {
                        e.preventDefault();
                        e.dataTransfer.dropEffect = 'copy';
                        if (dragOverSlotId !== slot.id) setDragOverSlotId(slot.id);
                      }}
                      onDragLeave={() => {
                        if (dragOverSlotId === slot.id) setDragOverSlotId(null);
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        setDragOverSlotId(null);
                        const files = Array.from(e.dataTransfer.files);
                        const audioFile = files.find(
                          (f) =>
                            f.type.startsWith('audio/') ||
                            /\.(wav|mp3|ogg|flac|m4a|aac|webm)$/i.test(f.name)
                        );
                        if (audioFile) onUploadCustomSlot(slot.id, audioFile);
                      }}
                      className={`h-[26px] rounded-md border flex items-center overflow-hidden transition-colors ${
                        isDragOver
                          ? 'bg-cyan-500/25 border-cyan-400 text-white'
                          : isRec
                          ? 'bg-rose-500/20 border-rose-500 text-rose-200 animate-pulse'
                          : slot.hasAudio && slot.enabled && autopilot.voiceFxEnabled
                          ? 'bg-[#161D28] border-cyan-500/45 text-cyan-100'
                          : slot.hasAudio
                          ? 'bg-[#141822] border-white/15 text-slate-300'
                          : 'bg-[#0B0E14] border-white/[0.07] text-slate-400'
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() =>
                          slot.hasAudio
                            ? onTriggerCustomSlot(slot.id)
                            : onToggleRecordCustomSlot(slot.id)
                        }
                        title={
                          slot.hasAudio
                            ? `${slot.label} (${slot.durationSec.toFixed(1)}s) — Click to fire live or drop audio file`
                            : `Click Mic to record up to 4s or drop/upload .wav/.mp3 into ${slot.label}`
                        }
                        className="flex-1 h-full px-1 text-[9px] font-semibold text-left truncate hover:bg-white/10 transition-colors"
                      >
                        {isRec ? 'REC...' : slot.hasAudio ? slot.label : `Drop ${slot.id.slice(-1)}`}
                      </button>

                      <button
                        type="button"
                        onClick={() => onToggleRecordCustomSlot(slot.id)}
                        title={isRec ? 'Stop mic recording' : 'Record mic drop (max 4s)'}
                        aria-label={isRec ? 'Stop recording drop' : `Record mic into ${slot.label}`}
                        className={`w-4 h-full flex items-center justify-center border-l border-white/[0.06] ${
                          isRec
                            ? 'bg-rose-500 text-white'
                            : 'text-slate-400 hover:text-rose-300 hover:bg-white/5'
                        }`}
                      >
                        <Mic className="w-2.5 h-2.5" />
                      </button>

                      <label
                        title={`Upload or drop .wav/.mp3 to ${slot.label}`}
                        className="w-4 h-full flex items-center justify-center border-l border-white/[0.06] text-slate-400 hover:text-cyan-300 hover:bg-white/5 cursor-pointer"
                      >
                        <Upload className="w-2.5 h-2.5" />
                        <input
                          type="file"
                          accept="audio/*"
                          className="hidden"
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) onUploadCustomSlot(slot.id, f);
                            e.currentTarget.value = '';
                          }}
                        />
                      </label>

                      {slot.hasAudio && (
                        <>
                          <button
                            type="button"
                            onClick={() => onTrimCustomSlot(slot.id)}
                            title="Auto-trim silence, fade & normalize"
                            aria-label={`Trim and fade ${slot.label}`}
                            className="w-4 h-full flex items-center justify-center border-l border-white/[0.06] text-amber-300/80 hover:text-amber-200 hover:bg-white/5"
                          >
                            <Scissors className="w-2.5 h-2.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => onToggleCustomSlotEnabled(slot.id)}
                            title={
                              slot.enabled
                                ? 'Included in AI offline remixes (click to disable)'
                                : 'Excluded from AI offline remixes (click to enable)'
                            }
                            aria-label={`Toggle ${slot.label} in AI remixes`}
                            className={`w-4 h-full flex items-center justify-center border-l border-white/[0.06] ${
                              slot.enabled
                                ? 'bg-cyan-500/20 text-cyan-300'
                                : 'text-slate-600 hover:text-slate-300'
                            }`}
                          >
                            <Check className="w-2.5 h-2.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => onClearCustomSlot(slot.id)}
                            title={`Clear ${slot.label}`}
                            aria-label={`Clear ${slot.label}`}
                            className="w-4 h-full flex items-center justify-center border-l border-white/[0.06] text-slate-500 hover:text-rose-400 hover:bg-white/5"
                          >
                            <Trash2 className="w-2.5 h-2.5" />
                          </button>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5 flex-1 min-h-0">
            <div className="flex items-center justify-between gap-1.5 px-1.5 py-0.5 rounded bg-[#0B0E14] border border-white/[0.06] shrink-0">
              <span className="text-[9.5px] font-semibold text-slate-300 truncate">
                AI Auto Behaviors (Live &amp; Offline WAV)
              </span>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  onClick={() => onApplyFeaturePreset('all-on')}
                  className="h-4.5 px-1.5 rounded bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/40 text-[9px] font-semibold text-emerald-200 transition-colors"
                  title="Enable all 8 AI DJ features"
                >
                  All On
                </button>
                <button
                  type="button"
                  onClick={() => onApplyFeaturePreset('clean-mix')}
                  className="h-4.5 px-1.5 rounded bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/35 text-[9px] font-semibold text-amber-200 transition-colors"
                  title="Play full songs with clean transitions (disables VIP Skip, Tease, Mid FX, Fakeouts, Beat Slice & Auto Drums)"
                >
                  Clean Mix
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-1 flex-1 min-h-0 overflow-y-auto pr-0.5">
              {AI_FEATURE_CONTROLS.map((feat) => {
                const enabled = autopilot.features?.[feat.key] ?? DEFAULT_AI_FEATURE_TOGGLES[feat.key];
                return (
                  <button
                    key={feat.key}
                    type="button"
                    onClick={() => onToggleFeature(feat.key)}
                    title={feat.desc}
                    aria-pressed={enabled}
                    className={`min-h-[30px] px-2 py-1 rounded-md border flex items-center justify-between gap-1.5 text-left transition-colors ${
                      enabled
                        ? 'bg-[#171C26] border-amber-400/40 text-slate-100 hover:bg-white/10'
                        : 'bg-[#0C0F15] border-white/[0.06] text-slate-500 hover:text-slate-300 hover:border-white/15'
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-[10px] font-semibold leading-tight truncate">
                        {feat.label}
                      </div>
                      <div className="text-[8.5px] text-slate-400 leading-tight truncate">
                        {feat.sub}
                      </div>
                    </div>
                    <span
                      className={`px-1.5 py-0.5 rounded text-[8.5px] font-mono font-bold uppercase shrink-0 ${
                        enabled
                          ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/35'
                          : 'bg-white/5 text-slate-500 border border-white/10'
                      }`}
                    >
                      {enabled ? 'ON' : 'OFF'}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </section>
  );
};
