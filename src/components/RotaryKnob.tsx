import React, { useRef, useState } from 'react';

interface RotaryKnobProps {
  label: string;
  value: number;
  min: number;
  max: number;
  defaultValue?: number;
  bipolar?: boolean;
  accentColor?: string;
  size?: number;
  formatValue?: (v: number) => string;
  onChange: (value: number) => void;
  disabled?: boolean;
}

export const RotaryKnob: React.FC<RotaryKnobProps> = ({
  label,
  value,
  min,
  max,
  defaultValue = 0,
  bipolar = false,
  accentColor = '#22D3EE',
  size = 48,
  formatValue,
  onChange,
  disabled = false,
}) => {
  const [dragging, setDragging] = useState(false);
  const startY = useRef(0);
  const startVal = useRef(value);

  const norm = Math.max(0, Math.min(1, (value - min) / (max - min)));
  const startAngle = -135;
  const endAngle = 135;
  const angle = startAngle + norm * (endAngle - startAngle);

  const cx = size / 2;
  const cy = size / 2;
  const radius = size * 0.39;

  const polarToCartesian = (deg: number) => {
    const rad = ((deg - 90) * Math.PI) / 180;
    return {
      x: cx + radius * Math.cos(rad),
      y: cy + radius * Math.sin(rad),
    };
  };

  const describeArc = (a1: number, a2: number) => {
    const from = Math.min(a1, a2);
    const to = Math.max(a1, a2);
    if (to - from < 0.5) return '';
    const start = polarToCartesian(to);
    const end = polarToCartesian(from);
    const largeArc = to - from <= 180 ? '0' : '1';
    return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArc} 0 ${end.x} ${end.y}`;
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
    startY.current = e.clientY;
    startVal.current = value;
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging || disabled) return;
    const deltaY = startY.current - e.clientY;
    const range = max - min;
    const sensitivity = e.shiftKey ? 320 : 140;
    const next = Math.max(min, Math.min(max, startVal.current + (deltaY / sensitivity) * range));
    // Snap cleanly to center detent for bipolar knobs
    if (bipolar && Math.abs(next - defaultValue) < range * 0.025) {
      onChange(defaultValue);
    } else {
      onChange(next);
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    setDragging(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  };

  const handleDoubleClick = () => {
    if (!disabled) onChange(defaultValue);
  };

  const pointerTip = polarToCartesian(angle);
  const pointerInner = {
    x: cx + (radius * 0.35) * Math.cos(((angle - 90) * Math.PI) / 180),
    y: cy + (radius * 0.35) * Math.sin(((angle - 90) * Math.PI) / 180),
  };

  const arcPath = bipolar
    ? describeArc(0, angle)
    : describeArc(startAngle, angle);

  const displayStr = formatValue
    ? formatValue(value)
    : bipolar
    ? `${value > 0 ? '+' : ''}${Math.round(value * 100)}%`
    : `${Math.round(norm * 100)}%`;

  return (
    <div
      className={`flex flex-col items-center select-none ${
        disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-ns-resize'
      }`}
    >
      <span className="text-[10px] font-semibold tracking-wider text-slate-400 mb-1 uppercase">
        {label}
      </span>
      <div
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={Number(value.toFixed(2))}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onDoubleClick={handleDoubleClick}
        onKeyDown={(e) => {
          if (disabled) return;
          const step = (max - min) * 0.05;
          if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
            e.preventDefault();
            onChange(Math.min(max, value + step));
          } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
            e.preventDefault();
            onChange(Math.max(min, value - step));
          }
        }}
        className="relative flex items-center justify-center touch-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 rounded-full"
        style={{ width: size, height: size }}
        title="Drag vertically to adjust · Double-click to reset"
      >
        <svg width={size} height={size} className="overflow-visible">
          {/* Background track arc */}
          <path
            d={describeArc(startAngle, endAngle)}
            fill="none"
            stroke="#1E2533"
            strokeWidth={3}
            strokeLinecap="round"
          />
          {/* Active arc */}
          {arcPath && (
            <path
              d={arcPath}
              fill="none"
              stroke={accentColor}
              strokeWidth={3}
              strokeLinecap="round"
            />
          )}
          {/* Machined knob body */}
          <circle
            cx={cx}
            cy={cy}
            r={radius * 0.72}
            fill="#151A24"
            stroke={dragging ? accentColor : 'rgba(255,255,255,0.14)'}
            strokeWidth={1.5}
          />
          {/* Center detent dot for bipolar */}
          {bipolar && (
            <circle cx={cx} cy={cy - radius - 3} r={1.5} fill="#64748B" />
          )}
          {/* Indicator notch */}
          <line
            x1={pointerInner.x}
            y1={pointerInner.y}
            x2={cx + (radius * 0.66) * Math.cos(((angle - 90) * Math.PI) / 180)}
            y2={cy + (radius * 0.66) * Math.sin(((angle - 90) * Math.PI) / 180)}
            stroke={Math.abs(value - defaultValue) < 0.02 && bipolar ? '#94A3B8' : accentColor}
            strokeWidth={2}
            strokeLinecap="round"
          />
          <circle cx={pointerTip.x} cy={pointerTip.y} r={0} />
        </svg>
      </div>
      <span className="mt-0.5 text-[10px] font-mono text-slate-400 tabular-nums leading-none">
        {displayStr}
      </span>
    </div>
  );
};
