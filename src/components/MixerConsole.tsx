import React, { useEffect, useState } from 'react';
import { Headphones, ArrowLeftRight } from 'lucide-react';
import { djEngine } from '../audio/djEngine';
import { CrossfaderCurve, DeckId, DeckState, MixerState } from '../types/dj';
import { RotaryKnob } from './RotaryKnob';

interface MixerConsoleProps {
  deckA: DeckState;
  deckB: DeckState;
  mixer: MixerState;
  onDeckMixerChange: (deckId: DeckId, patch: Partial<DeckState>) => void;
  onMixerChange: (patch: Partial<MixerState>) => void;
}

const MeterColumn: React.FC<{ level: number; colorClass?: string; label: string }> = ({
  level,
  colorClass = 'bg-cyan-400',
  label,
}) => {
  const segments = 9;
  const activeCount = Math.round(level * segments);
  return (
    <div className="flex flex-col items-center gap-0.5">
      <div className="flex flex-col-reverse gap-[1px] bg-[#090B0F] p-0.5 rounded border border-white/[0.06]">
        {Array.from({ length: segments }).map((_, i) => {
          const active = i < activeCount;
          let segColor = colorClass;
          if (i >= 7) segColor = 'bg-red-500';
          else if (i >= 5) segColor = 'bg-amber-400';
          return (
            <div
              key={i}
              className={`w-2 h-1 rounded-[1px] transition-opacity duration-75 ${
                active ? segColor : 'bg-white/[0.07]'
              }`}
            />
          );
        })}
      </div>
      <span className="text-[8px] font-mono text-slate-500">{label}</span>
    </div>
  );
};

export const MixerConsole: React.FC<MixerConsoleProps> = ({
  deckA,
  deckB,
  mixer,
  onDeckMixerChange,
  onMixerChange,
}) => {
  const [levels, setLevels] = useState({ deckA: 0, deckB: 0, master: 0 });

  useEffect(() => {
    let rafId = 0;
    let lastUpdate = 0;
    const tick = (now: number) => {
      if (now - lastUpdate > 45) {
        setLevels(djEngine.getLevels());
        lastUpdate = now;
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, []);

  const renderChannelStrip = (deck: DeckState) => {
    const isA = deck.deckId === 'A';
    const accent = isA ? '#22D3EE' : '#FB923C';
    const isIframe = deck.playbackMode === 'youtube-iframe';

    return (
      <div className="flex flex-col items-center gap-1.5 px-1.5 py-1.5 bg-[#0D1016] border border-white/[0.06] rounded-lg">
        <div className="flex items-center justify-between w-full px-1">
          <span
            className={`text-[11px] font-display font-bold tracking-wider ${
              isA ? 'text-cyan-400' : 'text-orange-400'
            }`}
          >
            CH {deck.deckId}
          </span>
          <button
            type="button"
            onClick={() => onDeckMixerChange(deck.deckId, { pflCue: !deck.pflCue })}
            className={`px-1.5 py-0.5 rounded text-[9px] font-semibold flex items-center gap-0.5 border transition-colors ${
              deck.pflCue
                ? 'bg-amber-500/20 border-amber-400 text-amber-300'
                : 'bg-[#171C26] border-white/10 text-slate-400 hover:text-white'
            }`}
            title="Headphone Pre-Fader Listen Cue"
          >
            <Headphones className="w-2.5 h-2.5" />
            <span>CUE</span>
          </button>
        </div>

        {/* 3-Band EQ + Kill Buttons */}
        <div className="flex flex-col items-center gap-1 w-full border-t border-white/[0.06] pt-1">
          <div className="flex items-center gap-1">
            <RotaryKnob
              label="High"
              value={deck.eqHigh}
              min={-1}
              max={1}
              defaultValue={0}
              bipolar
              accentColor={accent}
              size={32}
              disabled={isIframe}
              onChange={(eqHigh) => onDeckMixerChange(deck.deckId, { eqHigh })}
            />
            <button
              type="button"
              onClick={() => onDeckMixerChange(deck.deckId, { killHigh: !deck.killHigh })}
              disabled={isIframe}
              className={`w-5 h-5 rounded text-[9px] font-mono font-bold border transition-colors ${
                deck.killHigh
                  ? 'bg-red-500/80 border-red-400 text-white'
                  : 'bg-[#171C26] border-white/10 text-slate-400 hover:text-white'
              } disabled:opacity-35`}
              title="Kill High frequencies"
            >
              K
            </button>
          </div>

          <div className="flex items-center gap-1">
            <RotaryKnob
              label="Mid"
              value={deck.eqMid}
              min={-1}
              max={1}
              defaultValue={0}
              bipolar
              accentColor={accent}
              size={32}
              disabled={isIframe}
              onChange={(eqMid) => onDeckMixerChange(deck.deckId, { eqMid })}
            />
            <button
              type="button"
              onClick={() => onDeckMixerChange(deck.deckId, { killMid: !deck.killMid })}
              disabled={isIframe}
              className={`w-5 h-5 rounded text-[9px] font-mono font-bold border transition-colors ${
                deck.killMid
                  ? 'bg-red-500/80 border-red-400 text-white'
                  : 'bg-[#171C26] border-white/10 text-slate-400 hover:text-white'
              } disabled:opacity-35`}
              title="Kill Mid frequencies"
            >
              K
            </button>
          </div>

          <div className="flex items-center gap-1">
            <RotaryKnob
              label="Low"
              value={deck.eqLow}
              min={-1}
              max={1}
              defaultValue={0}
              bipolar
              accentColor={accent}
              size={32}
              disabled={isIframe}
              onChange={(eqLow) => onDeckMixerChange(deck.deckId, { eqLow })}
            />
            <button
              type="button"
              onClick={() => onDeckMixerChange(deck.deckId, { killLow: !deck.killLow })}
              disabled={isIframe}
              className={`w-5 h-5 rounded text-[9px] font-mono font-bold border transition-colors ${
                deck.killLow
                  ? 'bg-red-500/80 border-red-400 text-white'
                  : 'bg-[#171C26] border-white/10 text-slate-400 hover:text-white'
              } disabled:opacity-35`}
              title="Kill Low / Bass frequencies"
            >
              K
            </button>
          </div>
        </div>

        {/* Bipolar Sweep Filter + Channel Volume Fader */}
        <div className="flex items-center justify-between gap-1 border-t border-white/[0.06] pt-1.5 w-full px-1">
          <RotaryKnob
            label="Filter"
            value={deck.filter}
            min={-1}
            max={1}
            defaultValue={0}
            bipolar
            accentColor="#A855F7"
            size={34}
            disabled={isIframe}
            formatValue={(v) =>
              Math.abs(v) < 0.04 ? 'OFF' : v < 0 ? `LP` : `HP`
            }
            onChange={(filter) => onDeckMixerChange(deck.deckId, { filter })}
          />

          <div className="flex flex-col items-center gap-0.5">
            <input
              type="range"
              aria-label={`Channel ${deck.deckId} Volume Fader`}
              min={0}
              max={1}
              step={0.01}
              value={deck.channelVolume}
              onChange={(e) =>
                onDeckMixerChange(deck.deckId, { channelVolume: parseFloat(e.target.value) })
              }
              className="dj-fader-vertical h-14"
            />
            <span className="text-[9px] font-mono text-slate-400 tabular-nums">
              {Math.round(deck.channelVolume * 100)}%
            </span>
          </div>
        </div>
      </div>
    );
  };

  return (
    <section className="bg-[#11151C] border border-white/[0.08] rounded-xl p-2.5 flex flex-col justify-between gap-2 min-h-0">
      {/* Top Mixer Header + Master Gain & VU Meters */}
      <div className="flex items-center justify-between gap-2 pb-1.5 border-b border-white/[0.06]">
        <RotaryKnob
          label="Master"
          value={mixer.masterGain}
          min={0}
          max={1.2}
          defaultValue={0.9}
          accentColor="#10B981"
          size={36}
          onChange={(masterGain) => onMixerChange({ masterGain })}
        />

        <div className="flex items-end gap-1.5">
          <MeterColumn level={levels.deckA} colorClass="bg-cyan-400" label="A" />
          <MeterColumn level={levels.master} colorClass="bg-emerald-400" label="MST" />
          <MeterColumn level={levels.deckB} colorClass="bg-orange-400" label="B" />
        </div>
      </div>

      {/* Dual Channel Strips */}
      <div className="grid grid-cols-2 gap-2">
        {renderChannelStrip(deckA)}
        {renderChannelStrip(deckB)}
      </div>

      {/* Crossfader Section */}
      <div className="bg-[#0D1016] border border-white/[0.06] rounded-lg px-2.5 py-2 flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-1">
          <span className="text-[9px] font-semibold tracking-wider text-slate-400 uppercase">
            Crossfader
          </span>
          <div className="flex items-center gap-0.5">
            {(['blend', 'power', 'cut'] as CrossfaderCurve[]).map((curve) => (
              <button
                key={curve}
                type="button"
                onClick={() => onMixerChange({ crossfaderCurve: curve })}
                className={`px-1.5 py-0.5 rounded text-[9px] font-medium capitalize transition-colors ${
                  mixer.crossfaderCurve === curve
                    ? 'bg-white/15 text-white'
                    : 'text-slate-500 hover:text-slate-300'
                }`}
              >
                {curve}
              </button>
            ))}
            <button
              type="button"
              onClick={() => onMixerChange({ crossfaderReverse: !mixer.crossfaderReverse })}
              className={`p-0.5 rounded border transition-colors ${
                mixer.crossfaderReverse
                  ? 'border-amber-400 text-amber-300 bg-amber-500/10'
                  : 'border-white/10 text-slate-500 hover:text-white'
              }`}
              title="Reverse crossfader (Hamster switch)"
              aria-label="Reverse crossfader"
            >
              <ArrowLeftRight className="w-2.5 h-2.5" />
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onMixerChange({ crossfader: -1 })}
            className="text-xs font-display font-bold text-cyan-400 hover:text-cyan-300 px-1"
          >
            A
          </button>
          <input
            type="range"
            aria-label="Master Crossfader"
            min={-1}
            max={1}
            step={0.01}
            value={mixer.crossfader}
            onChange={(e) => onMixerChange({ crossfader: parseFloat(e.target.value) })}
            onDoubleClick={() => onMixerChange({ crossfader: 0 })}
            className="dj-fader flex-1"
            title="Double-click to center crossfader"
          />
          <button
            type="button"
            onClick={() => onMixerChange({ crossfader: 1 })}
            className="text-xs font-display font-bold text-orange-400 hover:text-orange-300 px-1"
          >
            B
          </button>
        </div>
      </div>
    </section>
  );
};
