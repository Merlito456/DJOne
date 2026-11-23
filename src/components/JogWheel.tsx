import React, { useEffect, useRef, useState } from 'react';
import { Disc3 } from 'lucide-react';
import { DeckId, DeckState } from '../types/dj';

interface JogWheelProps {
  deck: DeckState;
  getLiveTime: (deckId: DeckId) => number;
  onScrub: (newTimeSec: number) => void;
  onNudgeEnd: () => void;
}

export const JogWheel: React.FC<JogWheelProps> = ({
  deck,
  getLiveTime,
  onScrub,
  onNudgeEnd,
}) => {
  const platterRef = useRef<HTMLDivElement | null>(null);
  const ringRef = useRef<HTMLDivElement | null>(null);
  const [isScratching, setIsScratching] = useState(false);
  const dragState = useRef<{ lastAngle: number; active: boolean }>({
    lastAngle: 0,
    active: false,
  });

  const isDeckA = deck.deckId === 'A';
  const accent = isDeckA ? '#22D3EE' : '#FB923C';

  // Smooth 60fps rotation of platter marker synced to track time (33.3 RPM style = 1.8s per revolution)
  useEffect(() => {
    let rafId = 0;
    const tick = () => {
      if (ringRef.current && deck.track) {
        const t = getLiveTime(deck.deckId);
        const deg = (t / 1.8) * 360;
        ringRef.current.style.transform = `rotate(${deg}deg)`;
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [deck.deckId, deck.track, getLiveTime]);

  const getPointerAngle = (clientX: number, clientY: number) => {
    if (!platterRef.current) return 0;
    const rect = platterRef.current.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    return Math.atan2(clientY - cy, clientX - cx);
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!deck.track) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setIsScratching(true);
    dragState.current = {
      active: true,
      lastAngle: getPointerAngle(e.clientX, e.clientY),
    };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragState.current.active || !deck.track) return;
    const nextAngle = getPointerAngle(e.clientX, e.clientY);
    let delta = nextAngle - dragState.current.lastAngle;
    if (delta > Math.PI) delta -= Math.PI * 2;
    if (delta < -Math.PI) delta += Math.PI * 2;
    dragState.current.lastAngle = nextAngle;

    // 1 full revolution = 1.8 seconds of audio
    const deltaSec = (delta / (Math.PI * 2)) * 1.8;
    const cur = getLiveTime(deck.deckId);
    const next = Math.max(0, Math.min(deck.duration, cur + deltaSec));
    onScrub(next);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragState.current.active) return;
    dragState.current.active = false;
    setIsScratching(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    onNudgeEnd();
  };

  return (
    <div className="flex flex-col items-center">
      <div
        ref={platterRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        className={`relative w-28 h-28 sm:w-32 sm:h-32 rounded-full select-none touch-none flex items-center justify-center cursor-grab active:cursor-grabbing transition-shadow ${
          isScratching ? 'ring-2' : 'ring-1 ring-white/10'
        }`}
        style={{
          background:
            'radial-gradient(circle at center, #181E2A 0%, #0E1219 52%, #1C2331 54%, #0B0E14 100%)',
          boxShadow: isScratching
            ? `0 0 24px ${isDeckA ? 'rgba(34,211,238,0.28)' : 'rgba(251,146,60,0.28)'}`
            : 'inset 0 2px 12px rgba(0,0,0,0.8)',
          borderColor: isScratching ? accent : undefined,
        }}
        title="Drag platter to scrub or beat-nudge"
      >
        {/* Outer machined strobe dots ring */}
        <div
          className="absolute inset-1 rounded-full border border-dashed border-white/15 pointer-events-none"
        />

        {/* Rotating vinyl marker ring */}
        <div
          ref={ringRef}
          className="absolute inset-2 rounded-full pointer-events-none"
          style={{ willChange: 'transform' }}
        >
          {/* Vinyl grooves */}
          <div className="absolute inset-2.5 rounded-full border border-white/[0.05]" />
          <div className="absolute inset-5 rounded-full border border-white/[0.05]" />
          {/* Playhead needle marker */}
          <div
            className="absolute top-0 left-1/2 -translate-x-1/2 w-1.5 h-3.5 rounded-full"
            style={{ backgroundColor: accent }}
          />
        </div>

        {/* Center artwork / vinyl label */}
        <div className="relative w-12 h-12 sm:w-14 sm:h-14 rounded-full overflow-hidden border border-white/15 bg-[#090B0F] flex items-center justify-center pointer-events-none">
          {deck.track?.thumbnail ? (
            <img
              src={deck.track.thumbnail}
              alt={deck.track.title}
              referrerPolicy="no-referrer"
              className="w-full h-full object-cover opacity-85"
            />
          ) : (
            <Disc3
              className={`w-8 h-8 ${isDeckA ? 'text-cyan-400/70' : 'text-orange-400/70'}`}
            />
          )}
          {/* Spindle dot */}
          <div className="absolute w-3 h-3 rounded-full bg-[#090B0F] border border-white/30" />
        </div>
      </div>
    </div>
  );
};
