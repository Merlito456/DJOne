import React, { useEffect, useRef } from 'react';
import { X, Disc3 } from 'lucide-react';
import { djEngine } from '../audio/djEngine';
import { DeckId, DeckState } from '../types/dj';

interface ClubVisualizerOverlayProps {
  isOpen: boolean;
  onClose: () => void;
  deckA: DeckState;
  deckB: DeckState;
  getLiveTime: (deckId: DeckId) => number;
}

export const ClubVisualizerOverlay: React.FC<ClubVisualizerOverlayProps> = ({
  isOpen,
  onClose,
  deckA,
  deckB,
  getLiveTime,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [activeLine, setActiveLine] = React.useState<{
    word: string;
    upcoming: string;
    trackLabel: string;
    bpmLabel: string;
  }>({
    word: '',
    upcoming: '',
    trackLabel: '',
    bpmLabel: '',
  });

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!isOpen) return;
    let rafId = 0;

    const tick = () => {
      const activeDeck =
        deckA.isPlaying && !deckB.isPlaying
          ? deckA
          : deckB.isPlaying && !deckA.isPlaying
          ? deckB
          : deckA.isMaster && deckA.track
          ? deckA
          : deckB.track
          ? deckB
          : deckA;

      const curSec = activeDeck.track ? getLiveTime(activeDeck.deckId) : 0;
      const effBpm = activeDeck.track ? activeDeck.baseBpm * activeDeck.playbackRate : 124;
      const beatSec = 60 / Math.max(60, effBpm);
      const firstBeat = activeDeck.track?.firstBeatSec || 0;
      const beatPhase = (((curSec - firstBeat) % beatSec) + beatSec) % beatSec / beatSec;

      const words = activeDeck.track?.lyricCues?.words || [];
      let currentWord = '';
      let upcomingText = '';
      if (words.length > 0) {
        let hitIdx = words.findIndex((w) => curSec >= w.startSec - 0.12 && curSec <= w.endSec + 0.22);
        if (hitIdx < 0) {
          hitIdx = words.findIndex((w) => w.startSec > curSec);
        }
        if (hitIdx >= 0) {
          currentWord = words[hitIdx].word;
          upcomingText = words
            .slice(hitIdx + 1, hitIdx + 6)
            .map((w) => w.word)
            .join(' ');
        }
      }

      setActiveLine({
        word: currentWord,
        upcoming: upcomingText,
        trackLabel: activeDeck.track
          ? `${activeDeck.track.title.split('(')[0].trim()} — ${activeDeck.track.artist}`
          : 'Load & Play a Track for Beat-Synced Club Visualizer',
        bpmLabel: activeDeck.track
          ? `${effBpm.toFixed(1)} BPM · ${activeDeck.track.musicalKey}`
          : '124.0 BPM',
      });

      const canvas = canvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext('2d');
        if (ctx) {
          const dpr = window.devicePixelRatio || 1;
          const w = window.innerWidth;
          const h = window.innerHeight;
          if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
            canvas.width = Math.floor(w * dpr);
            canvas.height = Math.floor(h * dpr);
          }
          ctx.save();
          ctx.scale(dpr, dpr);

          const metrics = djEngine.getVisualizerMetrics();
          const pulse = Math.pow(1 - beatPhase, 2.2) * 0.6 + metrics.sub * 0.9;

          ctx.fillStyle = '#05070B';
          ctx.fillRect(0, 0, w, h);

          const cx = w * 0.5;
          const cy = h * 0.52;
          const baseRadius = Math.min(w, h) * (0.2 + pulse * 0.055);

          // Radial sub glow
          const grad = ctx.createRadialGradient(cx, cy, baseRadius * 0.25, cx, cy, baseRadius * 2.2);
          grad.addColorStop(0, `rgba(34, 211, 238, ${0.14 + metrics.sub * 0.24})`);
          grad.addColorStop(0.5, `rgba(168, 85, 247, ${0.08 + metrics.mid * 0.16})`);
          grad.addColorStop(1, 'rgba(5, 7, 11, 0)');
          ctx.fillStyle = grad;
          ctx.fillRect(0, 0, w, h);

          // Radial FFT bars
          const bins = metrics.wave || new Uint8Array(0);
          const barCount = Math.min(72, bins.length);
          for (let i = 0; i < barCount; i++) {
            const angle = (i / barCount) * Math.PI * 2 - Math.PI / 2;
            const norm = bins[i] / 255;
            const len = 14 + norm * Math.min(w, h) * 0.19;
            const x1 = cx + Math.cos(angle) * baseRadius;
            const y1 = cy + Math.sin(angle) * baseRadius;
            const x2 = cx + Math.cos(angle) * (baseRadius + len);
            const y2 = cy + Math.sin(angle) * (baseRadius + len);

            ctx.strokeStyle = i % 3 === 0 ? '#22D3EE' : i % 3 === 1 ? '#FB923C' : '#C084FC';
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.stroke();
          }

          // Center beat ring
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.32)';
          ctx.lineWidth = 2 + pulse * 3;
          ctx.beginPath();
          ctx.arc(cx, cy, baseRadius * 0.92, 0, Math.PI * 2);
          ctx.stroke();

          ctx.restore();
        }
      }

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [isOpen, deckA, deckB, getLiveTime]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-[#05070B] flex flex-col justify-between overflow-hidden select-none">
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full pointer-events-none" />

      <div className="relative z-10 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <Disc3 className="w-5 h-5 text-cyan-400 animate-spin" style={{ animationDuration: '6s' }} />
          <div>
            <div className="text-xs font-mono uppercase tracking-widest text-cyan-300">
              Club Visualizer · {activeLine.bpmLabel}
            </div>
            <div className="text-sm font-display font-semibold text-white">
              {activeLine.trackLabel}
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={onClose}
          className="h-9 px-3.5 rounded-lg bg-white/10 hover:bg-white/20 border border-white/15 text-xs font-semibold text-white flex items-center gap-1.5 transition-colors"
        >
          <X className="w-4 h-4" />
          <span>Exit Club Mode (Esc)</span>
        </button>
      </div>

      <div className="relative z-10 flex-1 flex flex-col items-center justify-center px-6 text-center pointer-events-none">
        {activeLine.word ? (
          <>
            <div className="text-4xl sm:text-6xl font-display font-extrabold tracking-tight text-white drop-shadow-[0_4px_24px_rgba(34,211,238,0.45)] uppercase">
              {activeLine.word}
            </div>
            {activeLine.upcoming && (
              <div className="mt-3 text-base sm:text-xl font-medium text-slate-300/80">
                {activeLine.upcoming}
              </div>
            )}
          </>
        ) : (
          <div className="text-xs font-mono uppercase tracking-[0.28em] text-slate-400/80">
            Scan Lyrics on Deck to sync live karaoke drops
          </div>
        )}
      </div>

      <div className="relative z-10 px-6 py-4 flex items-center justify-between text-[11px] font-mono text-slate-400">
        <span>DECK A · {deckA.track ? deckA.track.title.split('(')[0].trim() : 'Idle'}</span>
        <span>DECK B · {deckB.track ? deckB.track.title.split('(')[0].trim() : 'Idle'}</span>
      </div>
    </div>
  );
};
