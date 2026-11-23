import React, { useEffect, useRef, useState } from 'react';
import { ZoomIn, ZoomOut } from 'lucide-react';
import { DeckId, DeckState } from '../types/dj';

interface DualWaveformDisplayProps {
  deckA: DeckState;
  deckB: DeckState;
  getLiveTime: (deckId: DeckId) => number;
  onScrub: (deckId: DeckId, newTimeSec: number) => void;
}

export const DualWaveformDisplay: React.FC<DualWaveformDisplayProps> = ({
  deckA,
  deckB,
  getLiveTime,
  onScrub,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [windowSec, setWindowSec] = useState<number>(12); // visible time window in seconds
  const dragRef = useRef<{
    deckId: DeckId;
    startX: number;
    startTime: number;
  } | null>(null);

  useEffect(() => {
    let rafId = 0;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const render = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      const width = Math.max(300, Math.floor(rect.width));
      const height = Math.max(120, Math.floor(rect.height));

      if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
        canvas.width = Math.floor(width * dpr);
        canvas.height = Math.floor(height * dpr);
      }

      ctx.save();
      ctx.scale(dpr, dpr);

      // Background
      ctx.fillStyle = '#0A0D12';
      ctx.fillRect(0, 0, width, height);

      const midBarH = 22;
      const laneH = (height - midBarH) / 2;
      const centerX = width * 0.5;

      const timeA = getLiveTime('A');
      const timeB = getLiveTime('B');

      const drawDeckLane = (
        deck: DeckState,
        curTime: number,
        topY: number,
        isDeckA: boolean
      ) => {
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, topY, width, laneH);
        ctx.clip();

        // Subtle lane tint
        ctx.fillStyle = isDeckA ? 'rgba(6, 182, 212, 0.03)' : 'rgba(249, 115, 22, 0.03)';
        ctx.fillRect(0, topY, width, laneH);

        const midY = topY + laneH * 0.5;
        // Center horizontal baseline
        ctx.strokeStyle = 'rgba(255,255,255,0.06)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, midY);
        ctx.lineTo(width, midY);
        ctx.stroke();

        const duration = Math.max(1, deck.duration);
        const effWindow = windowSec * deck.playbackRate;
        const startSec = curTime - effWindow * 0.5;
        const endSec = curTime + effWindow * 0.5;
        const pxPerSec = width / effWindow;

        // Loop region highlight
        if (deck.loopActive && deck.loopEndSec > deck.loopStartSec) {
          const lx1 = centerX + (deck.loopStartSec - curTime) * pxPerSec;
          const lx2 = centerX + (deck.loopEndSec - curTime) * pxPerSec;
          ctx.fillStyle = isDeckA ? 'rgba(34, 211, 238, 0.14)' : 'rgba(251, 146, 60, 0.14)';
          ctx.fillRect(lx1, topY, lx2 - lx1, laneH);
          ctx.strokeStyle = isDeckA ? '#22D3EE' : '#FB923C';
          ctx.lineWidth = 1;
          ctx.strokeRect(lx1, topY + 1, lx2 - lx1, laneH - 2);
        }

        // Waveform bars (3-band RGB style)
        const wf = deck.waveform;
        if (wf.length > 0) {
          const barStepPx = 3;
          const halfH = laneH * 0.44;
          for (let x = 0; x < width; x += barStepPx) {
            const t = startSec + (x / width) * effWindow;
            if (t < 0 || t > duration) continue;
            const idx = Math.min(wf.length - 1, Math.max(0, Math.floor((t / duration) * wf.length)));
            const sample = wf[idx];

            const totalAmp = Math.min(1, sample.peak * 0.95);
            const hPeak = Math.max(1.5, totalAmp * halfH);
            const hMid = Math.max(1, sample.mid * halfH * 0.72);
            const hLow = Math.max(1, sample.low * halfH * 0.58);

            // Outer high-freq sparkle
            ctx.fillStyle = isDeckA ? 'rgba(165, 243, 252, 0.45)' : 'rgba(254, 215, 170, 0.45)';
            ctx.fillRect(x, midY - hPeak, 2, hPeak * 2);

            // Mid body
            ctx.fillStyle = isDeckA ? 'rgba(6, 182, 212, 0.85)' : 'rgba(249, 115, 22, 0.85)';
            ctx.fillRect(x, midY - hMid, 2, hMid * 2);

            // Low bass punch core
            ctx.fillStyle = isDeckA ? '#38BDF8' : '#FB7185';
            ctx.fillRect(x, midY - hLow, 2, hLow * 2);
          }
        } else {
          ctx.fillStyle = '#475569';
          ctx.font = '500 11px "Plus Jakarta Sans", sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(
            deck.isLoading ? `Loading Deck ${deck.deckId}...` : `Load a track onto Deck ${deck.deckId}`,
            centerX,
            midY + 4
          );
        }

        // Beat grid lines
        if (deck.track && deck.baseBpm > 0) {
          const beatSec = 60 / deck.baseBpm;
          const firstBeat = deck.track.firstBeatSec || 0;
          const firstVisibleBeat = Math.floor((Math.max(0, startSec) - firstBeat) / beatSec);
          const lastVisibleBeat = Math.ceil((Math.min(duration, endSec) - firstBeat) / beatSec);

          for (let b = firstVisibleBeat; b <= lastVisibleBeat; b++) {
            const bt = firstBeat + b * beatSec;
            if (bt < 0 || bt > duration) continue;
            const bx = centerX + (bt - curTime) * pxPerSec;
            const isDownbeat = ((b % 4) + 4) % 4 === 0;
            ctx.strokeStyle = isDownbeat
              ? 'rgba(255, 255, 255, 0.48)'
              : 'rgba(255, 255, 255, 0.14)';
            ctx.lineWidth = isDownbeat ? 1.5 : 1;
            ctx.beginPath();
            ctx.moveTo(bx, topY);
            ctx.lineTo(bx, topY + laneH);
            ctx.stroke();

            if (isDownbeat && b >= 0) {
              ctx.fillStyle = 'rgba(226, 232, 240, 0.65)';
              ctx.font = '600 9px "JetBrains Mono", monospace';
              ctx.textAlign = 'left';
              ctx.fillText(`${Math.floor(b / 4) + 1}`, bx + 3, topY + 11);
            }
          }
        }

        // Hot Cues & Main Cue markers
        if (deck.cuePointSec > 0) {
          const cxPos = centerX + (deck.cuePointSec - curTime) * pxPerSec;
          if (cxPos >= 0 && cxPos <= width) {
            ctx.strokeStyle = '#FACC15';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(cxPos, topY);
            ctx.lineTo(cxPos, topY + laneH);
            ctx.stroke();
          }
        }

        deck.hotCues.forEach((hc) => {
          if (hc.timeSec === null) return;
          const hx = centerX + (hc.timeSec - curTime) * pxPerSec;
          if (hx < -10 || hx > width + 10) return;
          ctx.strokeStyle = hc.color;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(hx, topY);
          ctx.lineTo(hx, topY + laneH);
          ctx.stroke();

          ctx.fillStyle = hc.color;
          ctx.fillRect(hx, topY, 14, 12);
          ctx.fillStyle = '#090B0F';
          ctx.font = '700 9px "JetBrains Mono", monospace';
          ctx.textAlign = 'center';
          ctx.fillText(String(hc.index + 1), hx + 7, topY + 9);
        });

        // Deck corner label
        ctx.fillStyle = isDeckA ? '#22D3EE' : '#FB923C';
        ctx.font = '700 10px "Outfit", sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(`DECK ${deck.deckId}`, 10, topY + 14);

        ctx.restore();
      };

      drawDeckLane(deckA, timeA, 0, true);
      drawDeckLane(deckB, timeB, laneH + midBarH, false);

      // Middle Beat-Match Phase Alignment Strip
      const barY = laneH;
      ctx.fillStyle = '#111620';
      ctx.fillRect(0, barY, width, midBarH);
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, barY);
      ctx.lineTo(width, barY);
      ctx.moveTo(0, barY + midBarH);
      ctx.lineTo(width, barY + midBarH);
      ctx.stroke();

      // Phase meter calculation
      const beatSecA = 60 / Math.max(60, deckA.baseBpm);
      const beatSecB = 60 / Math.max(60, deckB.baseBpm);
      const phaseA = (((timeA - (deckA.track?.firstBeatSec || 0)) % beatSecA) + beatSecA) % beatSecA / beatSecA;
      const phaseB = (((timeB - (deckB.track?.firstBeatSec || 0)) % beatSecB) + beatSecB) % beatSecB / beatSecB;
      let phaseDiff = phaseB - phaseA;
      if (phaseDiff > 0.5) phaseDiff -= 1;
      if (phaseDiff < -0.5) phaseDiff += 1;

      const meterW = Math.min(240, width * 0.42);
      const meterX = centerX - meterW / 2;
      ctx.fillStyle = '#090B0F';
      ctx.fillRect(meterX, barY + 4, meterW, midBarH - 8);

      const isPhaseLocked = Math.abs(phaseDiff) < 0.06 && deckA.track && deckB.track;
      const markerX = centerX + phaseDiff * (meterW * 0.85);
      ctx.fillStyle = isPhaseLocked ? '#10B981' : '#F59E0B';
      ctx.fillRect(markerX - 4, barY + 5, 8, midBarH - 10);

      // Center tick
      ctx.strokeStyle = 'rgba(255,255,255,0.4)';
      ctx.beginPath();
      ctx.moveTo(centerX, barY + 3);
      ctx.lineTo(centerX, barY + midBarH - 3);
      ctx.stroke();

      ctx.fillStyle = isPhaseLocked ? '#34D399' : '#94A3B8';
      ctx.font = '600 9px "JetBrains Mono", monospace';
      ctx.textAlign = 'left';
      ctx.fillText(isPhaseLocked ? 'PHASE LOCKED' : 'PHASE ALIGN', 10, barY + 14);

      // Center Playhead hairline across both lanes
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(centerX, 0);
      ctx.lineTo(centerX, height);
      ctx.stroke();

      ctx.restore();
      rafId = requestAnimationFrame(render);
    };

    rafId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(rafId);
  }, [deckA, deckB, getLiveTime, windowSec]);

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const deckId: DeckId = y < rect.height / 2 ? 'A' : 'B';
    const deck = deckId === 'A' ? deckA : deckB;
    if (!deck.track) return;

    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      deckId,
      startX: e.clientX,
      startTime: getLiveTime(deckId),
    };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dragRef.current || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const deck = dragRef.current.deckId === 'A' ? deckA : deckB;
    const dx = e.clientX - dragRef.current.startX;
    const effWindow = windowSec * deck.playbackRate;
    const deltaSec = -(dx / rect.width) * effWindow;
    const nextTime = Math.max(0, Math.min(deck.duration, dragRef.current.startTime + deltaSec));
    onScrub(dragRef.current.deckId, nextTime);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  };

  return (
    <div className="relative w-full bg-[#0A0D12] border border-white/[0.08] rounded-xl overflow-hidden select-none">
      <canvas
        ref={canvasRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        className="w-full h-[110px] lg:h-[96px] block cursor-grab active:cursor-grabbing touch-none"
        title="Drag horizontally on either waveform to scrub or align beats"
      />
      <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1 bg-[#090B0F]/90 border border-white/10 rounded-md px-1 py-0.5">
        <button
          type="button"
          onClick={() => setWindowSec((w) => Math.max(4, w - 4))}
          className="p-1 text-slate-400 hover:text-white transition-colors"
          title="Zoom in waveform"
          aria-label="Zoom in waveform"
        >
          <ZoomIn className="w-3.5 h-3.5" />
        </button>
        <span className="text-[10px] font-mono text-slate-400 px-1 tabular-nums">{windowSec}s</span>
        <button
          type="button"
          onClick={() => setWindowSec((w) => Math.min(32, w + 4))}
          className="p-1 text-slate-400 hover:text-white transition-colors"
          title="Zoom out waveform"
          aria-label="Zoom out waveform"
        >
          <ZoomOut className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
};
