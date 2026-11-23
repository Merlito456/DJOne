import React, { useState } from 'react';
import { X, Disc, Download, Trash2, Circle, Square, Zap, Loader2 } from 'lucide-react';
import { RecordingItem } from '../types/dj';

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
  offlineRemixPairLabel?: string;
  offlineRenderDisabledReason?: string;
  onRenderAiRemixWav?: (
    mode: 'mashup-32' | 'ai-transition',
    onProgress: (pct: number) => void
  ) => Promise<void>;
}

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
  offlineRemixPairLabel = '',
  offlineRenderDisabledReason,
  onRenderAiRemixWav,
}) => {
  const [captureTabAudio, setCaptureTabAudio] = useState(false);
  const [renderMode, setRenderMode] = useState<'mashup-32' | 'ai-transition'>('mashup-32');
  const [isRendering, setIsRendering] = useState(false);
  const [renderPct, setRenderPct] = useState(0);
  const [renderError, setRenderError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleTriggerRender = async () => {
    if (!onRenderAiRemixWav || !canRenderOfflineRemix || isRendering) return;
    setIsRendering(true);
    setRenderPct(4);
    setRenderError(null);
    try {
      await onRenderAiRemixWav(renderMode, (pct) => setRenderPct(pct));
    } catch (err: any) {
      setRenderError(err?.message || 'Offline render failed.');
    } finally {
      setIsRendering(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-xl bg-[#11151C] border border-white/10 rounded-2xl overflow-hidden shadow-2xl">
        <div className="px-5 py-4 border-b border-white/[0.08] flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Disc className="w-5 h-5 text-red-400" />
            <h3 className="font-display font-semibold text-base text-white">
              Master Set Recorder & Offline Mixtape Renderer
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

        <div className="p-5 flex flex-col gap-4 max-h-[82vh] overflow-y-auto">
          {/* Active Live Recorder Control */}
          <div className="bg-[#0B0E14] border border-white/[0.08] rounded-xl p-4 flex flex-col gap-3">
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

            <label className="flex items-start gap-2.5 text-xs text-slate-300 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={captureTabAudio}
                onChange={(e) => setCaptureTabAudio(e.target.checked)}
                disabled={isRecording}
                className="mt-0.5 accent-cyan-400"
              />
              <span>
                Also capture browser tab audio (enable when mixing embedded YouTube players to include them in the exported WAV)
              </span>
            </label>

            <div className="flex items-center gap-2 pt-1">
              {!isRecording ? (
                <button
                  type="button"
                  onClick={() => onStartRecording(captureTabAudio)}
                  className="h-9 px-4 rounded-lg bg-red-600 hover:bg-red-500 text-white font-semibold text-xs flex items-center gap-2 transition-colors"
                >
                  <Circle className="w-3.5 h-3.5 fill-current" />
                  <span>Start Live Recording</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={onStopRecording}
                  className="h-9 px-4 rounded-lg bg-white text-[#090B0F] hover:bg-slate-200 font-semibold text-xs flex items-center gap-2 transition-colors"
                >
                  <Square className="w-3.5 h-3.5 fill-current" />
                  <span>Stop & Save Mix</span>
                </button>
              )}
            </div>
          </div>

          {/* Upgrade #7: Faster-Than-Real-Time OfflineAudioContext Mixtape Renderer */}
          {onRenderAiRemixWav && (
            <div className="bg-[#0B0E14] border border-cyan-500/25 rounded-xl p-4 flex flex-col gap-2.5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-white flex items-center gap-1.5">
                    <Zap className="w-4 h-4 text-cyan-400" />
                    <span>Offline Fast-Render (.WAV via OfflineAudioContext)</span>
                  </p>
                  <p className="text-xs text-slate-400 mt-0.5">
                    {canRenderOfflineRemix && offlineRemixPairLabel
                      ? `Instant studio render for ${offlineRemixPairLabel} with HPSS stems, builds & -11 LUFS limiter.`
                      : offlineRenderDisabledReason ||
                        'Load two Web Audio / local / streamed tracks on Deck A & Deck B to fast-render an AI edit.'}
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <div className="flex items-center gap-1 bg-[#11151C] p-1 rounded-lg border border-white/[0.08]">
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
                    32-Bar Bootleg Mashup
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
                    AI Transition Edit
                  </button>
                </div>

                <button
                  type="button"
                  onClick={handleTriggerRender}
                  disabled={!canRenderOfflineRemix || isRendering}
                  className="h-8 px-3.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 disabled:opacity-45 text-[#090B0F] font-semibold text-xs flex items-center gap-1.5 transition-colors"
                >
                  {isRendering ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>Rendering {renderPct}%</span>
                    </>
                  ) : (
                    <>
                      <Zap className="w-3.5 h-3.5 fill-current" />
                      <span>Render AI Remix (.WAV)</span>
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

              {renderError && <p className="text-xs text-rose-400">{renderError}</p>}
            </div>
          )}

          {/* Recorded & Rendered Mixes List */}
          <div className="flex flex-col gap-2">
            <h4 className="text-xs font-semibold tracking-wider text-slate-400 uppercase">
              Exported Sets ({recordings.length})
            </h4>

            {recordings.length === 0 ? (
              <div className="py-6 text-center border border-dashed border-white/10 rounded-xl">
                <p className="text-xs text-slate-400">
                  No exported sets yet. Record live or fast-render a 32-Bar Bootleg WAV above.
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-2 max-h-60 overflow-y-auto pr-1">
                {recordings.map((rec) => (
                  <div
                    key={rec.id}
                    className="p-3 rounded-xl bg-[#0D1016] border border-white/[0.08] flex flex-col gap-2"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-white truncate">{rec.title}</p>
                        <p className="text-[11px] font-mono text-slate-400 tabular-nums">
                          {formatClock(rec.durationSec)} · WAV · {formatBytes(rec.sizeBytes)}
                        </p>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <a
                          href={rec.url}
                          download={`${rec.title.replace(/\s+/g, '_')}.wav`}
                          className="h-8 px-3 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-[#090B0F] font-semibold text-xs flex items-center gap-1.5"
                        >
                          <Download className="w-3.5 h-3.5" />
                          <span>Download WAV</span>
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
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

