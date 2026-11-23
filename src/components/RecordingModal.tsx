import React, { useState } from 'react';
import { X, Disc, Download, Trash2, Circle, Square } from 'lucide-react';
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
}) => {
  const [captureTabAudio, setCaptureTabAudio] = useState(false);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-xl bg-[#11151C] border border-white/10 rounded-2xl overflow-hidden shadow-2xl">
        <div className="px-5 py-4 border-b border-white/[0.08] flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Disc className="w-5 h-5 text-red-400" />
            <h3 className="font-display font-semibold text-base text-white">
              Master Set Recorder & Local Export
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

        <div className="p-5 flex flex-col gap-5">
          {/* Active Recorder Control */}
          <div className="bg-[#0B0E14] border border-white/[0.08] rounded-xl p-4 flex flex-col gap-3">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-white">
                  {isRecording ? 'Recording Live Master Mix' : 'Ready to Record Stereo WAV'}
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
                  className="h-10 px-4 rounded-lg bg-red-600 hover:bg-red-500 text-white font-semibold text-xs flex items-center gap-2 transition-colors"
                >
                  <Circle className="w-3.5 h-3.5 fill-current" />
                  <span>Start Recording</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={onStopRecording}
                  className="h-10 px-4 rounded-lg bg-white text-[#090B0F] hover:bg-slate-200 font-semibold text-xs flex items-center gap-2 transition-colors"
                >
                  <Square className="w-3.5 h-3.5 fill-current" />
                  <span>Stop & Save Mix</span>
                </button>
              )}
            </div>
          </div>

          {/* Recorded Mixes List */}
          <div className="flex flex-col gap-2">
            <h4 className="text-xs font-semibold tracking-wider text-slate-400 uppercase">
              Exported Sets ({recordings.length})
            </h4>

            {recordings.length === 0 ? (
              <div className="py-8 text-center border border-dashed border-white/10 rounded-xl">
                <p className="text-xs text-slate-400">
                  No recorded sets yet. Hit Start Recording while mixing to save a WAV file locally.
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-2 max-h-64 overflow-y-auto pr-1">
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
