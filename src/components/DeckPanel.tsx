import React, { useEffect, useRef, useState } from 'react';
import {
  Play,
  Pause,
  RotateCcw,
  Sparkles,
  Trash2,
  SkipBack,
  SkipForward,
  Repeat,
  Lock,
} from 'lucide-react';
import {
  BootlegFlipPreset,
  CleanEditMaskMode,
  DeckFxState,
  DeckId,
  DeckState,
  FxType,
  StutterSubdiv,
} from '../types/dj';
import { JogWheel } from './JogWheel';
import { RotaryKnob } from './RotaryKnob';

interface DeckPanelProps {
  deck: DeckState;
  getLiveTime: (deckId: DeckId) => number;
  onTogglePlay: () => void;
  onCue: () => void;
  onSync: () => void;
  onSetMaster: () => void;
  onSeek: (timeSec: number) => void;
  onNudgePitch: (deltaBpmPct: number) => void;
  onPitchChange: (rate: number) => void;
  onPitchRangeChange: (range: 0.08 | 0.16 | 0.5) => void;
  onToggleKeyLock: () => void;
  onHotCueTrigger: (index: number) => void;
  onHotCueClear: (index: number) => void;
  onToggleLoop: (bars: number) => void;
  onExitLoop: () => void;
  onBeatJump: (beats: number) => void;
  onFxChange: (fx: Partial<DeckFxState>) => void;
  onTapBpm: (newBpm: number) => void;
  onMarkDropCue?: () => void;
  onCycleMusicalKey?: () => void;
  onCycleStemMode?: () => void;
  onCycleBootlegFlip?: () => void;
  onTriggerStutterRoll?: (subdiv: StutterSubdiv) => void;
  onTriggerTonePlay?: (semitoneOffset: number) => void;
  onScanWhisperCues?: () => void;
  scanningCues?: boolean;
  onToggleSubSwap?: () => void;
  onTriggerPitchRoll?: (mode: 'escalate-roll' | 'poly-3-8' | 'poly-3-16') => void;
  onTriggerEchoFreeze?: () => void;
  onCycleCleanEditMask?: () => void;
  onTriggerChopSolo?: () => void;
  compactMobileSection?: 'all' | 'transport' | 'fx';
  allowYoutubeMount?: boolean;
}

function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '00:00';
  const mins = Math.floor(sec / 60);
  const secs = Math.floor(sec % 60);
  const tenths = Math.floor((sec % 1) * 10);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${tenths}`;
}

export const DeckPanel: React.FC<DeckPanelProps> = ({
  deck,
  getLiveTime,
  onTogglePlay,
  onCue,
  onSync,
  onSetMaster,
  onSeek,
  onNudgePitch,
  onPitchChange,
  onPitchRangeChange,
  onToggleKeyLock,
  onHotCueTrigger,
  onHotCueClear,
  onToggleLoop,
  onExitLoop,
  onBeatJump,
  onFxChange,
  onTapBpm,
  onMarkDropCue,
  onCycleMusicalKey,
  onCycleStemMode,
  onCycleBootlegFlip,
  onTriggerStutterRoll,
  onTriggerTonePlay,
  onScanWhisperCues,
  scanningCues = false,
  onToggleSubSwap,
  onTriggerPitchRoll,
  onTriggerEchoFreeze,
  onCycleCleanEditMask,
  onTriggerChopSolo,
  compactMobileSection = 'all',
  allowYoutubeMount = false,
}) => {
  const isDeckA = deck.deckId === 'A';
  const accentHex = isDeckA ? '#22D3EE' : '#FB923C';
  const accentText = isDeckA ? 'text-cyan-400' : 'text-orange-400';
  const accentBorder = isDeckA ? 'border-cyan-500/40' : 'border-orange-500/40';
  const accentBg = isDeckA ? 'bg-cyan-500' : 'bg-orange-500';

  const [liveTime, setLiveTime] = useState(deck.currentTime);
  const [showTonePlay, setShowTonePlay] = useState(false);
  const tapTimesRef = useRef<number[]>([]);
  const overviewCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Sync live time readout at ~20fps for crisp tabular clock without needless React thrashing
  useEffect(() => {
    const id = setInterval(() => {
      setLiveTime(getLiveTime(deck.deckId));
    }, 50);
    return () => clearInterval(id);
  }, [deck.deckId, getLiveTime]);

  // Draw mini overview waveform strip
  useEffect(() => {
    const canvas = overviewCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 300;
    const h = canvas.clientHeight || 32;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);

    ctx.fillStyle = '#090B0F';
    ctx.fillRect(0, 0, w, h);

    const wf = deck.waveform;
    if (wf.length > 0) {
      const step = Math.max(1, Math.floor(wf.length / w));
      for (let x = 0; x < w; x++) {
        const idx = Math.min(wf.length - 1, Math.floor((x / w) * wf.length));
        let peak = 0;
        for (let k = 0; k < step && idx + k < wf.length; k++) {
          if (wf[idx + k].peak > peak) peak = wf[idx + k].peak;
        }
        const barH = Math.max(2, peak * (h - 6));
        const progressX = deck.duration > 0 ? (liveTime / deck.duration) * w : 0;
        ctx.fillStyle =
          x < progressX
            ? isDeckA
              ? 'rgba(34, 211, 238, 0.85)'
              : 'rgba(251, 146, 60, 0.85)'
            : 'rgba(148, 163, 184, 0.35)';
        ctx.fillRect(x, (h - barH) / 2, 1, barH);
      }
    }

    // Drop / Chorus Marker indicator
    if (deck.duration > 0 && typeof deck.track?.dropCueSec === 'number') {
      const dx = (deck.track.dropCueSec / deck.duration) * w;
      ctx.fillStyle = '#F59E0B';
      ctx.fillRect(dx - 1, 0, 2, h);
    }

    // Playhead needle
    if (deck.duration > 0) {
      const px = (liveTime / deck.duration) * w;
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(px - 1, 0, 2, h);
    }
  }, [deck.waveform, deck.duration, deck.track?.dropCueSec, liveTime, isDeckA]);

  const effectiveBpm = deck.baseBpm * deck.playbackRate;
  const pitchPct = (deck.playbackRate - 1) * 100;
  const remaining = Math.max(0, deck.duration - liveTime);

  const handleTap = () => {
    const now = performance.now();
    const arr = tapTimesRef.current.filter((t) => now - t < 2500);
    arr.push(now);
    tapTimesRef.current = arr;
    if (arr.length >= 2) {
      let sum = 0;
      for (let i = 1; i < arr.length; i++) sum += arr[i] - arr[i - 1];
      const avgMs = sum / (arr.length - 1);
      const bpm = Math.round((60000 / avgMs) * 10) / 10;
      if (bpm >= 60 && bpm <= 195) {
        onTapBpm(bpm);
      }
    }
  };

  const sourceLabel =
    deck.playbackMode === 'youtube-iframe'
      ? 'YouTube Player'
      : deck.track?.sourceType === 'youtube-stream'
      ? 'YouTube DSP'
      : deck.track?.sourceType === 'local'
      ? 'Local Audio'
      : deck.track
      ? 'Track Loaded'
      : 'Empty Deck';

  const showTransport = compactMobileSection === 'all' || compactMobileSection === 'transport';
  const showFx = compactMobileSection === 'all' || compactMobileSection === 'fx';

  return (
    <section className="bg-[#11151C] border border-white/[0.08] rounded-xl p-2.5 sm:p-3 flex flex-col justify-between gap-2 min-h-0">
      {/* Track Info Header */}
      <div className="flex items-start justify-between gap-2 border-b border-white/[0.06] pb-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[10px] text-slate-400">
            <span className={`font-display font-bold tracking-wider ${accentText}`}>
              DECK {deck.deckId}
            </span>
            <span aria-hidden="true">·</span>
            <span>{sourceLabel}</span>
            {deck.track?.musicalKey && (
              <>
                <span aria-hidden="true">·</span>
                <button
                  type="button"
                  onClick={onCycleMusicalKey}
                  className="font-mono text-slate-300 hover:text-cyan-300 transition-colors"
                  title="Click to calibrate & save Camelot key for in-key sound tricks"
                >
                  {deck.track.musicalKey}
                </button>
              </>
            )}
          </div>
          <h2 className="text-xs sm:text-sm font-semibold text-white truncate">
            {deck.track ? deck.track.title : 'No Track Loaded'}
          </h2>
          <p className="text-[11px] text-slate-400 truncate">
            {deck.track ? deck.track.artist : 'Open Playlists & Songs sidebar to search YouTube'}
          </p>
        </div>

        {/* BPM & Clock Cluster */}
        <div className="flex flex-col items-end shrink-0">
          <div className="flex items-baseline gap-1">
            <span className="text-base sm:text-lg font-mono font-bold text-white tabular-nums leading-tight">
              {deck.track ? effectiveBpm.toFixed(1) : '---.-'}
            </span>
            <span className="text-[9px] font-semibold text-slate-400">BPM</span>
          </div>
          <div className="flex items-center gap-1.5 text-[10px] font-mono text-slate-400 tabular-nums">
            <span>{formatTime(liveTime)}</span>
            <span className="text-slate-600">/</span>
            <span className="text-slate-300">-{formatTime(remaining)}</span>
          </div>
        </div>
      </div>

      {/* Overview Needle-Drop Strip */}
      <div className="flex flex-col gap-0.5">
        <canvas
          ref={overviewCanvasRef}
          onClick={(e) => {
            if (!deck.track || deck.duration <= 0) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            onSeek(pct * deck.duration);
          }}
          className="w-full h-6 rounded border border-white/[0.06] cursor-pointer"
          title="Click anywhere to needle-drop"
        />
        {deck.loadError && (
          <p className="text-[10px] text-amber-400 leading-tight truncate">{deck.loadError}</p>
        )}
      </div>

      {/* Platter + Pitch + Sync Row */}
      {showTransport && (
        <div className="grid grid-cols-[1fr_auto] sm:grid-cols-[auto_1fr_auto] items-center gap-2.5">
          {/* Jog Wheel OR Mounted YouTube Video Container */}
          <div className="flex flex-col items-center gap-1">
            <JogWheel
              deck={deck}
              getLiveTime={getLiveTime}
              onScrub={(t) => onSeek(t)}
              onNudgeEnd={() => {}}
            />
            {allowYoutubeMount && (
              <div
                className={`overflow-hidden rounded border border-white/10 bg-black transition-all ${
                  deck.playbackMode === 'youtube-iframe'
                    ? 'w-32 h-16 opacity-100'
                    : 'w-px h-px opacity-0 pointer-events-none border-0'
                }`}
              >
                <div id={`yt-deck-player-${deck.deckId}`} className="w-full h-full" />
              </div>
            )}
          </div>

          {/* Center Controls: Sync / Master / Tap / Drop Marker / Transport */}
          <div className="flex flex-col gap-1.5">
            <div className="grid grid-cols-4 gap-1">
              <button
                type="button"
                onClick={onSync}
                disabled={!deck.track}
                className={`min-h-[32px] px-1 rounded-md text-[10px] font-semibold border transition-colors whitespace-nowrap ${
                  deck.syncLocked
                    ? 'bg-emerald-500/20 border-emerald-400/60 text-emerald-300'
                    : 'bg-[#171C26] border-white/10 text-slate-300 hover:text-white hover:border-white/25'
                } disabled:opacity-40`}
                title="Auto beat-match BPM & align beat phase with Master deck"
              >
                SYNC
              </button>
              <button
                type="button"
                onClick={onSetMaster}
                disabled={!deck.track}
                className={`min-h-[32px] px-1 rounded-md text-[10px] font-semibold border transition-colors whitespace-nowrap ${
                  deck.isMaster
                    ? `${accentBg} text-[#090B0F] border-transparent`
                    : 'bg-[#171C26] border-white/10 text-slate-300 hover:text-white hover:border-white/25'
                } disabled:opacity-40`}
              >
                MSTR
              </button>
              <button
                type="button"
                onClick={handleTap}
                disabled={!deck.track}
                className="min-h-[32px] px-1 rounded-md text-[10px] font-semibold bg-[#171C26] border border-white/10 text-slate-300 hover:text-white hover:border-white/25 transition-colors whitespace-nowrap disabled:opacity-40"
                title="Tap rhythmically to calibrate & save BPM"
              >
                TAP
              </button>
              <button
                type="button"
                onClick={onMarkDropCue}
                disabled={!deck.track || !onMarkDropCue}
                className={`min-h-[32px] px-1 rounded-md text-[10px] font-semibold border transition-colors whitespace-nowrap disabled:opacity-40 ${
                  typeof deck.track?.dropCueSec === 'number'
                    ? 'bg-amber-500/20 border-amber-400/60 text-amber-300'
                    : 'bg-[#171C26] border-white/10 text-slate-300 hover:text-amber-300 hover:border-amber-400/40'
                }`}
                title={
                  typeof deck.track?.dropCueSec === 'number'
                    ? `Drop marker saved at ${deck.track.dropCueSec.toFixed(1)}s (click to update to current position)`
                    : 'Mark current playback timestamp as Chorus/Drop Cue for offline AI'
                }
              >
                DROP
              </button>
            </div>

            {/* Primary Transport Buttons */}
            <div className="grid grid-cols-2 gap-1.5">
              <button
                type="button"
                onClick={onCue}
                disabled={!deck.track}
                className="min-h-[38px] px-2 rounded-lg bg-[#171C26] border border-amber-500/40 text-amber-300 hover:bg-amber-500/15 font-semibold text-xs tracking-wide transition-colors disabled:opacity-40"
                title="Jump to cue point (or set cue when paused)"
              >
                CUE
              </button>
              <button
                type="button"
                onClick={onTogglePlay}
                disabled={!deck.track || deck.isLoading}
                className={`min-h-[38px] px-2 rounded-lg font-semibold text-xs tracking-wide flex items-center justify-center gap-1 border transition-colors disabled:opacity-40 ${
                  deck.isPlaying
                    ? 'bg-emerald-500 text-[#090B0F] border-emerald-400'
                    : `bg-[#171C26] ${accentBorder} text-white hover:bg-white/10`
                }`}
              >
                {deck.isPlaying ? (
                  <>
                    <Pause className="w-3.5 h-3.5 fill-current" />
                    <span>PAUSE</span>
                  </>
                ) : (
                  <>
                    <Play className="w-3.5 h-3.5 fill-current" />
                    <span>PLAY</span>
                  </>
                )}
              </button>
            </div>

            {/* Beat Jump & Pitch Nudge */}
            <div className="grid grid-cols-4 gap-1">
              <button
                type="button"
                onClick={() => onBeatJump(-4)}
                disabled={!deck.track}
                className="min-h-[30px] rounded bg-[#171C26] border border-white/[0.08] text-[10px] font-mono text-slate-300 hover:text-white flex items-center justify-center gap-0.5 disabled:opacity-40"
                title="Jump back 4 beats"
              >
                <SkipBack className="w-3 h-3" />
                <span>4</span>
              </button>
              <button
                type="button"
                onClick={() => onNudgePitch(-0.015)}
                disabled={!deck.track}
                className="min-h-[30px] rounded bg-[#171C26] border border-white/[0.08] text-[10px] font-mono text-slate-300 hover:text-white disabled:opacity-40"
                title="Nudge tempo slower"
              >
                -NUDGE
              </button>
              <button
                type="button"
                onClick={() => onNudgePitch(0.015)}
                disabled={!deck.track}
                className="min-h-[30px] rounded bg-[#171C26] border border-white/[0.08] text-[10px] font-mono text-slate-300 hover:text-white disabled:opacity-40"
                title="Nudge tempo faster"
              >
                +NUDGE
              </button>
              <button
                type="button"
                onClick={() => onBeatJump(4)}
                disabled={!deck.track}
                className="min-h-[30px] rounded bg-[#171C26] border border-white/[0.08] text-[10px] font-mono text-slate-300 hover:text-white flex items-center justify-center gap-0.5 disabled:opacity-40"
                title="Jump forward 4 beats"
              >
                <span>4</span>
                <SkipForward className="w-3 h-3" />
              </button>
            </div>
          </div>

          {/* Pitch / Tempo Fader Column */}
          <div className="hidden sm:flex flex-col items-center gap-1 pl-1.5 border-l border-white/[0.06]">
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => {
                  const next = deck.pitchRange === 0.08 ? 0.16 : deck.pitchRange === 0.16 ? 0.5 : 0.08;
                  onPitchRangeChange(next);
                }}
                className="px-1 py-0.5 rounded bg-[#171C26] border border-white/10 text-[9px] font-mono text-slate-300 hover:text-white"
                title="Cycle pitch range"
              >
                ±{Math.round(deck.pitchRange * 100)}%
              </button>
              <button
                type="button"
                onClick={onToggleKeyLock}
                className={`p-0.5 rounded border ${
                  deck.keyLock
                    ? `${accentBorder} ${accentText} bg-white/5`
                    : 'border-white/10 text-slate-500'
                }`}
                title="Key Lock / Master Tempo"
              >
                <Lock className="w-2.5 h-2.5" />
              </button>
            </div>

            <input
              type="range"
              aria-label={`Deck ${deck.deckId} Pitch Fader`}
              min={1 - deck.pitchRange}
              max={1 + deck.pitchRange}
              step={0.001}
              value={deck.playbackRate}
              onChange={(e) => onPitchChange(parseFloat(e.target.value))}
              className="dj-fader-vertical h-20"
            />

            <button
              type="button"
              onClick={() => onPitchChange(1)}
              className="flex items-center gap-0.5 text-[10px] font-mono text-slate-300 hover:text-white tabular-nums"
              title="Click to reset pitch to 0.0%"
            >
              <span>{pitchPct >= 0 ? '+' : ''}{pitchPct.toFixed(1)}%</span>
              <RotateCcw className="w-2.5 h-2.5 text-slate-500" />
            </button>
          </div>
        </div>
      )}

      {/* Mobile Pitch Slider */}
      {showTransport && (
        <div className="flex sm:hidden items-center gap-2 bg-[#0C0F15] rounded-lg px-3 py-1.5 border border-white/[0.06]">
          <span className="text-[11px] font-semibold text-slate-400 shrink-0">TEMPO</span>
          <input
            type="range"
            aria-label={`Deck ${deck.deckId} Mobile Tempo`}
            min={1 - deck.pitchRange}
            max={1 + deck.pitchRange}
            step={0.002}
            value={deck.playbackRate}
            onChange={(e) => onPitchChange(parseFloat(e.target.value))}
            className="dj-fader flex-1"
          />
          <button
            type="button"
            onClick={() => onPitchChange(1)}
            className="text-xs font-mono text-slate-300 tabular-nums shrink-0"
          >
            {pitchPct >= 0 ? '+' : ''}{pitchPct.toFixed(1)}%
          </button>
        </div>
      )}

      {/* Hot Cues & Auto-Loop Bar */}
      {showFx && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1.5 border-t border-white/[0.06]">
          {/* 4 Hot Cues */}
          <div className="flex flex-col gap-1">
            <span className="text-[9px] font-semibold tracking-wider text-slate-400 uppercase">
              Hot Cues
            </span>
            <div className="grid grid-cols-4 gap-1">
              {deck.hotCues.map((hc) => {
                const isSet = hc.timeSec !== null;
                return (
                  <div key={hc.index} className="relative group">
                    <button
                      type="button"
                      onClick={() => onHotCueTrigger(hc.index)}
                      disabled={!deck.track}
                      className={`w-full min-h-[32px] rounded-md text-[11px] font-mono font-semibold border transition-all disabled:opacity-40 ${
                        isSet
                          ? 'text-[#090B0F] border-transparent'
                          : 'bg-[#171C26] border-white/10 text-slate-400 hover:text-white'
                      }`}
                      style={isSet ? { backgroundColor: hc.color } : undefined}
                      title={
                        isSet
                          ? `Jump to Cue ${hc.index + 1} (${hc.timeSec!.toFixed(1)}s)`
                          : `Set Hot Cue ${hc.index + 1}`
                      }
                    >
                      {hc.index + 1}
                    </button>
                    {isSet && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onHotCueClear(hc.index);
                        }}
                        className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-[#090B0F] border border-white/20 text-slate-300 hover:text-red-400 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                        aria-label={`Clear Cue ${hc.index + 1}`}
                      >
                        <Trash2 className="w-2.5 h-2.5" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Auto Loop Bars */}
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <span className="text-[9px] font-semibold tracking-wider text-slate-400 uppercase flex items-center gap-1">
                <Repeat className="w-2.5 h-2.5" />
                Auto Loop
              </span>
              {deck.loopActive && (
                <button
                  type="button"
                  onClick={onExitLoop}
                  className="text-[9px] font-semibold text-amber-400 hover:text-amber-300"
                >
                  EXIT
                </button>
              )}
            </div>
            <div className="grid grid-cols-5 gap-1">
              {[0.5, 1, 2, 4, 8].map((bars) => {
                const active = deck.loopActive && deck.loopBars === bars;
                return (
                  <button
                    key={bars}
                    type="button"
                    onClick={() => (active ? onExitLoop() : onToggleLoop(bars))}
                    disabled={!deck.track}
                    className={`min-h-[32px] rounded-md text-[10px] font-mono font-semibold border transition-colors disabled:opacity-40 ${
                      active
                        ? `${accentBg} text-[#090B0F] border-transparent`
                        : 'bg-[#171C26] border-white/10 text-slate-300 hover:text-white'
                    }`}
                  >
                    {bars === 0.5 ? '1/2' : bars}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Real-Time FX Rack (16 Studio DSP Effects + Live Remix Tools) */}
      {showFx && (
        <div className="bg-[#0D1016] border border-white/[0.06] rounded-lg px-2.5 py-2 flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex flex-col gap-1 min-w-0 flex-1">
              <div className="flex items-start gap-1">
                <Sparkles className={`w-3 h-3 mt-1 shrink-0 ${deck.fx.enabled ? accentText : 'text-slate-500'}`} />
                <div className="grid grid-cols-4 sm:grid-cols-8 gap-0.5 flex-1">
                  {(
                    [
                      { id: 'echo', label: 'Echo' },
                      { id: 'reverb', label: 'Verb' },
                      { id: 'flanger', label: 'Flng' },
                      { id: 'phaser', label: 'Phas' },
                      { id: 'chorus', label: 'Chor' },
                      { id: 'tremolo', label: 'Gate' },
                      { id: 'bitcrush', label: 'Crsh' },
                      { id: 'drive', label: 'Driv' },
                      { id: 'ringmod', label: 'Ring' },
                      { id: 'autopan', label: 'Pan' },
                      { id: 'comb', label: 'Comb' },
                      { id: 'stutter', label: 'Stut' },
                      { id: 'subharm', label: 'Sub+' },
                      { id: 'shimmer', label: 'Shim' },
                      { id: 'lofi', label: 'LoFi' },
                      { id: 'dubdelay', label: 'Dub' },
                    ] as { id: FxType; label: string }[]
                  ).map((fxItem) => (
                    <button
                      key={fxItem.id}
                      type="button"
                      onClick={() => onFxChange({ type: fxItem.id })}
                      className={`px-1 py-0.5 rounded text-[9px] font-medium transition-colors truncate ${
                        deck.fx.type === fxItem.id
                          ? 'bg-white/15 text-white'
                          : 'text-slate-400 hover:text-slate-200 hover:bg-white/[0.04]'
                      }`}
                    >
                      {fxItem.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex items-center gap-1.5 flex-wrap">
                <button
                  type="button"
                  onClick={() => onFxChange({ enabled: !deck.fx.enabled })}
                  disabled={!deck.track || deck.playbackMode === 'youtube-iframe'}
                  className={`h-6 px-2 rounded text-[10px] font-semibold border transition-colors disabled:opacity-40 ${
                    deck.fx.enabled
                      ? `${accentBg} text-[#090B0F] border-transparent`
                      : 'bg-[#171C26] border-white/10 text-slate-300 hover:text-white'
                  }`}
                >
                  {deck.fx.enabled ? 'FX ON' : 'FX OFF'}
                </button>

                <div className="flex items-center gap-0.5">
                  {[0.25, 0.5, 0.75, 1].map((div) => (
                    <button
                      key={div}
                      type="button"
                      onClick={() => onFxChange({ beatDiv: div })}
                      className={`px-1.5 py-0.5 rounded text-[10px] font-mono border transition-colors ${
                        deck.fx.beatDiv === div
                          ? `${accentBorder} ${accentText} bg-white/5`
                          : 'border-white/[0.06] text-slate-400 hover:text-white'
                      }`}
                    >
                      {div === 0.25 ? '1/4' : div === 0.5 ? '1/2' : div === 0.75 ? '3/4' : '1/1'}
                    </button>
                  ))}
                </div>

                {onCycleStemMode && (
                  <button
                    type="button"
                    onClick={onCycleStemMode}
                    disabled={!deck.track || deck.playbackMode === 'youtube-iframe'}
                    className={`h-6 px-2 rounded text-[10px] font-semibold border transition-colors whitespace-nowrap shrink-0 disabled:opacity-40 ${
                      deck.stemMode === 'vocal-focus'
                        ? 'bg-purple-500/25 border-purple-400/60 text-purple-200'
                        : deck.stemMode === 'instrumental'
                        ? 'bg-cyan-500/25 border-cyan-400/60 text-cyan-200'
                        : deck.stemMode === 'drums-only'
                        ? 'bg-amber-500/25 border-amber-400/60 text-amber-200'
                        : 'bg-[#171C26] border-white/10 text-slate-300 hover:text-white'
                    }`}
                    title={
                      deck.playbackMode === 'youtube-iframe'
                        ? '3-Stem HPSS / Mid-Side Isolator requires Web Audio decoded audio'
                        : 'Cycle 3-Stem Isolator (Off -> Vocal Focus -> Instrumental -> Drums Only)'
                    }
                  >
                    {deck.stemMode === 'vocal-focus'
                      ? 'Stem: Voc'
                      : deck.stemMode === 'instrumental'
                      ? 'Stem: Inst'
                      : deck.stemMode === 'drums-only'
                      ? 'Stem: Drums'
                      : 'Stem: Off'}
                  </button>
                )}
              </div>
            </div>

            <RotaryKnob
              label="Wet"
              value={deck.fx.wet}
              min={0}
              max={1}
              defaultValue={0.35}
              accentColor={accentHex}
              size={36}
              disabled={deck.playbackMode === 'youtube-iframe'}
              onChange={(wet) => onFxChange({ wet })}
            />
          </div>

          {/* Bootleg Flip, Stutter Slicer, Pitch Roll, Sub Swap, Echo Freeze & Clean Edit Bar */}
          {(onCycleBootlegFlip ||
            onTriggerStutterRoll ||
            onTriggerTonePlay ||
            onScanWhisperCues ||
            onToggleSubSwap ||
            onTriggerPitchRoll ||
            onTriggerEchoFreeze ||
            onCycleCleanEditMask ||
            onTriggerChopSolo) && (
            <div className="flex flex-col gap-1 pt-1 border-t border-white/[0.05]">
              <div className="flex flex-wrap items-center justify-between gap-1.5">
                <div className="flex items-center gap-1 flex-wrap">
                  {onCycleBootlegFlip && (
                    <button
                      type="button"
                      onClick={onCycleBootlegFlip}
                      disabled={!deck.track || deck.playbackMode === 'youtube-iframe'}
                      className={`h-6 px-2 rounded text-[10px] font-semibold border transition-colors whitespace-nowrap disabled:opacity-40 ${
                        deck.bootlegFlip && deck.bootlegFlip !== 'off'
                          ? 'bg-emerald-500/20 border-emerald-400/55 text-emerald-200'
                          : 'bg-[#171C26] border-white/10 text-slate-300 hover:text-white'
                      }`}
                      title="Cycle Live Genre Bootleg Flip (Off -> Jersey Club -> Amapiano -> Phonk -> Slowed+Verb -> Nightcore)"
                    >
                      {
                        (
                          {
                            off: 'Flip: Off',
                            'jersey-club': 'Flip: Jersey',
                            amapiano: 'Flip: Amapiano',
                            phonk: 'Flip: Phonk',
                            'slowed-reverb': 'Flip: Slowed',
                            nightcore: 'Flip: Nightcore',
                          } as Record<BootlegFlipPreset, string>
                        )[deck.bootlegFlip || 'off']
                      }
                    </button>
                  )}

                  {onTriggerStutterRoll && (
                    <div className="flex items-center gap-0.5" title="16-Step Quantized Rhythmic Stutter Roll">
                      <span className="text-[9px] font-mono text-slate-500 mr-0.5">ROLL</span>
                      {(['1/4', '1/8', '1/16', '1/32'] as StutterSubdiv[]).map((sub) => (
                        <button
                          key={sub}
                          type="button"
                          onClick={() => onTriggerStutterRoll(sub)}
                          disabled={!deck.track || deck.playbackMode === 'youtube-iframe'}
                          className="h-6 px-1.5 rounded bg-[#171C26] hover:bg-cyan-500/20 hover:text-cyan-200 border border-white/10 text-[9.5px] font-mono text-slate-300 transition-colors disabled:opacity-40"
                        >
                          {sub}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-1">
                  {onTriggerTonePlay && (
                    <button
                      type="button"
                      onClick={() => setShowTonePlay((s) => !s)}
                      disabled={!deck.track || deck.playbackMode === 'youtube-iframe'}
                      className={`h-6 px-2 rounded text-[10px] font-semibold border transition-colors disabled:opacity-40 ${
                        showTonePlay
                          ? 'bg-purple-500/25 border-purple-400/60 text-purple-200'
                          : 'bg-[#171C26] border-white/10 text-slate-300 hover:text-white'
                      }`}
                      title="Toggle in-key Camelot Tone-Play sampler pads"
                    >
                      Tone
                    </button>
                  )}
                  {onScanWhisperCues && (
                    <button
                      type="button"
                      onClick={onScanWhisperCues}
                      disabled={!deck.track || scanningCues}
                      className={`h-6 px-2 rounded text-[10px] font-semibold border transition-colors whitespace-nowrap disabled:opacity-40 ${
                        deck.track?.lyricCues?.words?.length
                          ? 'bg-cyan-500/15 border-cyan-500/45 text-cyan-200'
                          : 'bg-[#171C26] border-white/10 text-slate-300 hover:text-white'
                      }`}
                      title="Scan audio with Groq Whisper to detect wordplay anchors, explicit words, anti-vocal-clash windows & map chorus hooks to Hot Cues 1-4"
                    >
                      {scanningCues
                        ? 'Scanning...'
                        : deck.track?.lyricCues?.words?.length
                        ? 'Lyrics ✓'
                        : 'Scan Lyrics'}
                    </button>
                  )}
                </div>
              </div>

              {/* Studio DSP Performance Strip: 808 Sub Swap, Pitch Escalate Roll, Poly Repeat, Echo Freeze, Clean Mask & Chop Solo */}
              <div className="flex flex-wrap items-center gap-1">
                {onToggleSubSwap && (
                  <button
                    type="button"
                    onClick={onToggleSubSwap}
                    disabled={!deck.track || deck.playbackMode === 'youtube-iframe'}
                    className={`h-5 px-1.5 rounded text-[9.5px] font-semibold border transition-colors disabled:opacity-40 ${
                      deck.subSwapEnabled
                        ? 'bg-amber-500/25 border-amber-400/60 text-amber-200'
                        : 'bg-[#131720] border-white/10 text-slate-300 hover:text-white'
                    }`}
                    title={`In-Key 808 Sub-Bass Re-Synthesizer (${deck.track?.musicalKey || '8A'}) — HPF 85Hz + phase-locked pure sub`}
                  >
                    808 Sub
                  </button>
                )}

                {onTriggerPitchRoll && (
                  <>
                    <button
                      type="button"
                      onClick={() => onTriggerPitchRoll('escalate-roll')}
                      disabled={!deck.track || deck.playbackMode === 'youtube-iframe'}
                      className="h-5 px-1.5 rounded bg-[#131720] hover:bg-cyan-500/20 hover:text-cyan-200 border border-white/10 text-[9.5px] font-mono text-slate-300 transition-colors disabled:opacity-40"
                      title="Pitch-Escalating Loop Roll (1 → 1/2 → 1/4 → 1/8 → 1/16 rising +1st per step)"
                    >
                      Roll↑
                    </button>
                    <button
                      type="button"
                      onClick={() => onTriggerPitchRoll('poly-3-8')}
                      disabled={!deck.track || deck.playbackMode === 'youtube-iframe'}
                      className="h-5 px-1.5 rounded bg-[#131720] hover:bg-cyan-500/20 hover:text-cyan-200 border border-white/10 text-[9.5px] font-mono text-slate-300 transition-colors disabled:opacity-40"
                      title="Dotted 3/8 Polyrhythmic Beat-Repeat"
                    >
                      3/8
                    </button>
                    <button
                      type="button"
                      onClick={() => onTriggerPitchRoll('poly-3-16')}
                      disabled={!deck.track || deck.playbackMode === 'youtube-iframe'}
                      className="h-5 px-1.5 rounded bg-[#131720] hover:bg-cyan-500/20 hover:text-cyan-200 border border-white/10 text-[9.5px] font-mono text-slate-300 transition-colors disabled:opacity-40"
                      title="Dotted 3/16 Polyrhythmic Beat-Repeat"
                    >
                      3/16
                    </button>
                  </>
                )}

                {onTriggerEchoFreeze && (
                  <button
                    type="button"
                    onClick={onTriggerEchoFreeze}
                    disabled={!deck.track || deck.playbackMode === 'youtube-iframe'}
                    className="h-5 px-1.5 rounded bg-[#131720] hover:bg-purple-500/25 hover:text-purple-200 border border-white/10 text-[9.5px] font-semibold text-slate-300 transition-colors disabled:opacity-40"
                    title="Vocal-Hook Echo Freeze: capture vocal phrase into tempo ping-pong delay tail & free deck"
                  >
                    Vox Freeze
                  </button>
                )}

                {onTriggerChopSolo && (
                  <button
                    type="button"
                    onClick={onTriggerChopSolo}
                    disabled={!deck.track || deck.playbackMode === 'youtube-iframe'}
                    className="h-5 px-1.5 rounded bg-[#131720] hover:bg-emerald-500/25 hover:text-emerald-200 border border-white/10 text-[9.5px] font-semibold text-slate-300 transition-colors disabled:opacity-40"
                    title="Fred again..-Style Auto Vocal-Chop Solo: slices clean lyric phrase across Camelot pentatonic notes"
                  >
                    Chop Solo
                  </button>
                )}

                {onCycleCleanEditMask && (
                  <button
                    type="button"
                    onClick={onCycleCleanEditMask}
                    disabled={!deck.track}
                    className={`h-5 px-1.5 rounded text-[9.5px] font-semibold border transition-colors disabled:opacity-40 ${
                      deck.cleanEditMask && deck.cleanEditMask !== 'off'
                        ? 'bg-emerald-500/20 border-emerald-400/55 text-emerald-200'
                        : 'bg-[#131720] border-white/10 text-slate-400 hover:text-white'
                    }`}
                    title="Whisper Clean / Radio Edit Masking (Off -> Mute -> Vinyl Reverse -> Scratch Chirp)"
                  >
                    {
                      (
                        {
                          off: 'Clean: Off',
                          mute: 'Clean: Mute',
                          reverse: 'Clean: Rev',
                          chirp: 'Clean: Chirp',
                        } as Record<CleanEditMaskMode, string>
                      )[deck.cleanEditMask || 'off']
                    }
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Chromatic In-Key Tone-Play Pad Strip */}
          {showTonePlay && onTriggerTonePlay && (
            <div className="grid grid-cols-8 gap-1 pt-1 border-t border-white/[0.05]">
              {[0, 2, 3, 5, 7, 8, 10, 12].map((semitone, idx) => (
                <button
                  key={semitone}
                  type="button"
                  onClick={() => onTriggerTonePlay(semitone)}
                  disabled={!deck.track || deck.playbackMode === 'youtube-iframe'}
                  className="h-6 rounded bg-purple-500/15 hover:bg-purple-500/35 active:scale-95 border border-purple-400/35 text-[10px] font-mono font-semibold text-purple-100 transition-all disabled:opacity-40"
                  title={`Play scale degree ${idx + 1} (+${semitone} semitones in ${deck.track?.musicalKey || 'key'})`}
                >
                  {idx + 1}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
};
