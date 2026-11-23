import React, { useEffect, useMemo, useState } from 'react';
import {
  X,
  Plus,
  Check,
  ArrowUp,
  ArrowDown,
  Trash2,
  Wand2,
  Bot,
  Search,
  Music,
  Sparkles,
  Download,
} from 'lucide-react';
import { sortTracksHarmonically } from '../audio/offlineAiDj';
import { downloadCarloPlaylistFile } from '../store/useLibraryStore';
import { AiDjVibe, Playlist, TrackItem } from '../types/dj';

interface PlaylistBuilderModalProps {
  isOpen: boolean;
  onClose: () => void;
  allTracks: TrackItem[];
  editingPlaylist?: Playlist | null;
  onSavePlaylist: (payload: {
    id?: string;
    name: string;
    trackIds: string[];
    preferredVibe: AiDjVibe;
    remixMode: boolean;
    aggressiveness: number;
    launchAutoDj: boolean;
  }) => void;
}

type SourceFilter = 'all' | 'youtube' | 'local';

const VIBES: { id: AiDjVibe; label: string }[] = [
  { id: 'club-blend', label: 'Club Blend' },
  { id: 'festival-drop', label: 'Festival Drop' },
  { id: 'techno-hypnotic', label: 'Techno' },
  { id: 'scratch-chop', label: 'Chop & Scratch' },
  { id: 'mashup-live', label: 'Mashup Live' },
  { id: 'chill-sunset', label: 'Chill Sunset' },
];

function formatTotalTime(totalSec: number): string {
  const s = Math.max(0, Math.round(totalSec));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${String(rem).padStart(2, '0')}s`;
}

function formatTrackDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export const PlaylistBuilderModal: React.FC<PlaylistBuilderModalProps> = ({
  isOpen,
  onClose,
  allTracks,
  editingPlaylist,
  onSavePlaylist,
}) => {
  const [name, setName] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [preferredVibe, setPreferredVibe] = useState<AiDjVibe>('club-blend');
  const [remixMode, setRemixMode] = useState<boolean>(true);
  const [aggressiveness, setAggressiveness] = useState<number>(60);
  const [searchQuery, setSearchQuery] = useState('');
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');

  useEffect(() => {
    if (!isOpen) return;
    if (editingPlaylist) {
      setName(editingPlaylist.name);
      setSelectedIds(editingPlaylist.trackIds);
      setPreferredVibe(editingPlaylist.preferredVibe || 'club-blend');
      setRemixMode(editingPlaylist.remixMode ?? true);
      setAggressiveness(editingPlaylist.aggressiveness ?? 60);
    } else {
      setName('Custom Remix Set');
      setSelectedIds([]);
      setPreferredVibe('festival-drop');
      setRemixMode(true);
      setAggressiveness(60);
    }
    setSearchQuery('');
    setSourceFilter('all');
  }, [isOpen, editingPlaylist]);

  const trackMap = useMemo(() => {
    const map = new Map<string, TrackItem>();
    allTracks.forEach((t) => map.set(t.id, t));
    return map;
  }, [allTracks]);

  const selectedTracks = useMemo(
    () => selectedIds.map((id) => trackMap.get(id)).filter((t): t is TrackItem => Boolean(t)),
    [selectedIds, trackMap]
  );

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  const filteredCatalog = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return allTracks.filter((t) => {
      if (sourceFilter === 'local' && t.sourceType !== 'local') return false;
      if (sourceFilter === 'youtube' && !t.sourceType.startsWith('youtube')) return false;
      if (!q) return true;
      return (
        t.title.toLowerCase().includes(q) ||
        t.artist.toLowerCase().includes(q) ||
        t.musicalKey.toLowerCase().includes(q) ||
        String(Math.round(t.bpm)).includes(q)
      );
    });
  }, [allTracks, searchQuery, sourceFilter]);

  const totalSec = useMemo(
    () => selectedTracks.reduce((acc, t) => acc + (t.durationSec || 0), 0),
    [selectedTracks]
  );

  const bpmSpan = useMemo(() => {
    if (selectedTracks.length === 0) return '—';
    const bpms = selectedTracks.map((t) => t.bpm);
    const min = Math.round(Math.min(...bpms));
    const max = Math.round(Math.max(...bpms));
    return min === max ? `${min} BPM` : `${min}–${max} BPM`;
  }, [selectedTracks]);

  if (!isOpen) return null;

  const handleToggleTrack = (trackId: string) => {
    setSelectedIds((prev) =>
      prev.includes(trackId) ? prev.filter((id) => id !== trackId) : [...prev, trackId]
    );
  };

  const handleAddAllFiltered = () => {
    setSelectedIds((prev) => {
      const existing = new Set(prev);
      const additions = filteredCatalog.map((t) => t.id).filter((id) => !existing.has(id));
      return [...prev, ...additions];
    });
  };

  const handleMove = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= selectedIds.length) return;
    setSelectedIds((prev) => {
      const copy = [...prev];
      const [moved] = copy.splice(index, 1);
      copy.splice(target, 0, moved);
      return copy;
    });
  };

  const handleHarmonicSort = () => {
    const sorted = sortTracksHarmonically(selectedTracks);
    setSelectedIds(sorted.map((t) => t.id));
  };

  const canSave = name.trim().length > 0 && selectedTracks.length > 0;

  const submit = (launchAutoDj: boolean) => {
    if (!canSave) return;
    onSavePlaylist({
      id: editingPlaylist?.id,
      name: name.trim(),
      trackIds: selectedTracks.map((t) => t.id),
      preferredVibe,
      remixMode,
      aggressiveness,
      launchAutoDj,
    });
    onClose();
  };

  const handleExportCarloNow = () => {
    if (!canSave) return;
    downloadCarloPlaylistFile({
      format: 'deckforge.carlo',
      version: 1,
      exportedAt: new Date().toISOString(),
      playlist: {
        name: name.trim(),
        preferredVibe,
        remixMode,
        aggressiveness,
        trackIds: selectedTracks.map((t) => t.id),
      },
      tracks: selectedTracks.map((t) => ({ ...t, fileUrl: undefined })),
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-3 sm:p-5"
      role="dialog"
      aria-modal="true"
      aria-labelledby="playlist-builder-title"
    >
      <div className="w-full max-w-4xl max-h-[90vh] bg-[#11151C] border border-white/15 rounded-xl flex flex-col overflow-hidden">
        {/* Modal Header */}
        <div className="px-4 py-3 border-b border-white/[0.08] flex items-center justify-between gap-3 bg-[#0E1218] shrink-0">
          <div>
            <h2
              id="playlist-builder-title"
              className="text-sm font-display font-bold text-white"
            >
              {editingPlaylist ? 'Edit Playlist & Offline Remix Setup' : 'Playlist Builder'}
            </h2>
            <p className="text-xs text-slate-400">
              Assemble your track order and configure Offline AI Remix behavior
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-cyan-400"
            aria-label="Close playlist builder"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Configuration Bar: Playlist Name + AI Remix Mode + Vibe */}
        <div className="px-4 py-3 border-b border-white/[0.08] bg-[#0B0E14] grid grid-cols-1 md:grid-cols-[1fr_auto] gap-3 items-end shrink-0">
          <div className="flex flex-col sm:flex-row gap-3">
            <label className="flex-1 flex flex-col gap-1 min-w-0">
              <span className="text-[11px] font-medium text-slate-400">Playlist Name</span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Late Night House Remixes"
                className="h-9 px-3 rounded-lg bg-[#151A24] border border-white/15 text-xs text-white focus:outline-none focus:border-cyan-400"
              />
            </label>

            <div className="flex flex-col gap-1 shrink-0">
              <span className="text-[11px] font-medium text-slate-400">Offline AI Vibe</span>
              <div className="flex items-center gap-1 p-1 bg-[#151A24] border border-white/10 rounded-lg h-9">
                {VIBES.map((v) => (
                  <button
                    key={v.id}
                    type="button"
                    onClick={() => setPreferredVibe(v.id)}
                    className={`h-7 px-2.5 rounded-md text-[11px] font-medium whitespace-nowrap shrink-0 transition-colors ${
                      preferredVibe === v.id
                        ? 'bg-white/15 text-white'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {v.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row items-stretch sm:items-end gap-2 shrink-0">
            <div className="flex flex-col gap-1 min-w-[140px]">
              <div className="flex items-center justify-between text-[11px] text-slate-400">
                <span>AI Aggressiveness</span>
                <span className="font-mono text-amber-300 font-semibold">{aggressiveness}%</span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={aggressiveness}
                onChange={(e) => setAggressiveness(parseInt(e.target.value, 10))}
                className="dj-fader h-9"
              />
            </div>

            <button
              type="button"
              onClick={() => setRemixMode((r) => !r)}
              className={`h-9 px-3 rounded-lg border text-xs font-semibold flex items-center gap-2 whitespace-nowrap shrink-0 transition-colors ${
                remixMode
                  ? 'bg-emerald-500/15 border-emerald-500/50 text-emerald-300'
                  : 'bg-[#151A24] border-white/15 text-slate-300 hover:text-white'
              }`}
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>{remixMode ? 'Offline AI Remix: ON' : 'Standard Mix'}</span>
            </button>
          </div>
        </div>

        {/* 2-Column Picker Body */}
        <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-white/[0.08] flex-1 min-h-0 overflow-hidden">
          {/* Left Column: Library Catalog */}
          <div className="flex flex-col min-h-[220px] min-w-0 overflow-hidden">
            <div className="p-3 border-b border-white/[0.06] flex flex-col gap-2 bg-[#0E1218] shrink-0">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-slate-200">
                  Available Songs · <span className="font-mono text-slate-400 tabular-nums">{filteredCatalog.length}</span>
                </span>
                <button
                  type="button"
                  onClick={handleAddAllFiltered}
                  disabled={filteredCatalog.length === 0}
                  className="text-[11px] font-semibold text-cyan-300 hover:text-cyan-200 disabled:opacity-40 whitespace-nowrap shrink-0"
                >
                  + Add All Shown
                </button>
              </div>

              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Filter title, artist, BPM, key..."
                    className="w-full h-8 pl-8 pr-2.5 rounded-md bg-[#090B0F] border border-white/10 text-xs text-white placeholder:text-slate-500 focus:outline-none focus:border-cyan-400"
                  />
                </div>
                <div className="flex items-center gap-1 p-0.5 bg-[#090B0F] border border-white/10 rounded-md shrink-0">
                  {(['all', 'youtube', 'local'] as SourceFilter[]).map((src) => (
                    <button
                      key={src}
                      type="button"
                      onClick={() => setSourceFilter(src)}
                      className={`px-2 py-1 rounded text-[11px] font-medium capitalize whitespace-nowrap shrink-0 transition-colors ${
                        sourceFilter === src
                          ? 'bg-white/15 text-white'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {src}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto divide-y divide-white/[0.05]">
              {filteredCatalog.length === 0 ? (
                <div className="p-6 text-center text-xs text-slate-500">
                  No matching tracks in your library. Search YouTube or import audio first.
                </div>
              ) : (
                filteredCatalog.map((track) => {
                  const isAdded = selectedSet.has(track.id);
                  return (
                    <div
                      key={track.id}
                      className="px-3 py-2 flex items-center justify-between gap-2 hover:bg-white/[0.03]"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div className="w-7 h-7 rounded bg-[#171C26] border border-white/[0.08] flex items-center justify-center shrink-0 overflow-hidden">
                          {track.thumbnail ? (
                            <img
                              src={track.thumbnail}
                              alt={track.title}
                              referrerPolicy="no-referrer"
                              className="w-full h-full object-cover"
                            />
                          ) : (
                            <Music className="w-3.5 h-3.5 text-slate-400" />
                          )}
                        </div>
                        <div className="min-w-0">
                          <p className="text-xs font-medium text-slate-100 truncate">
                            {track.title}
                          </p>
                          <p className="text-[11px] text-slate-400 truncate font-mono tabular-nums">
                            {track.artist} · {track.bpm.toFixed(0)} BPM · {track.musicalKey} ·{' '}
                            {formatTrackDuration(track.durationSec)}
                          </p>
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={() => handleToggleTrack(track.id)}
                        className={`h-7 px-2.5 rounded-md text-[11px] font-semibold flex items-center gap-1 border whitespace-nowrap shrink-0 transition-colors ${
                          isAdded
                            ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                            : 'bg-[#171C26] border-white/10 text-slate-200 hover:border-cyan-400 hover:text-cyan-300'
                        }`}
                      >
                        {isAdded ? (
                          <>
                            <Check className="w-3 h-3" />
                            <span>Added</span>
                          </>
                        ) : (
                          <>
                            <Plus className="w-3 h-3" />
                            <span>Add</span>
                          </>
                        )}
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Right Column: Ordered Playlist Queue */}
          <div className="flex flex-col min-h-[220px] min-w-0 overflow-hidden bg-[#0C1016]">
            <div className="p-3 border-b border-white/[0.06] flex items-center justify-between gap-2 bg-[#0E1218] shrink-0">
              <div className="min-w-0">
                <span className="text-xs font-semibold text-slate-200">
                  Your Playlist ·{' '}
                  <span className="font-mono text-slate-400 tabular-nums">
                    {selectedTracks.length} songs · {bpmSpan} · {formatTotalTime(totalSec)}
                  </span>
                </span>
              </div>

              <button
                type="button"
                onClick={handleHarmonicSort}
                disabled={selectedTracks.length < 2}
                className="h-7 px-2.5 rounded-md bg-[#171C26] hover:bg-white/10 border border-white/15 text-[11px] font-semibold text-cyan-300 flex items-center gap-1 whitespace-nowrap shrink-0 disabled:opacity-40 transition-colors"
                title="Offline AI sorts your playlist by Camelot key and BPM progression"
              >
                <Wand2 className="w-3 h-3" />
                <span>AI Sort</span>
              </button>
            </div>

            <div className="flex-1 overflow-y-auto divide-y divide-white/[0.05]">
              {selectedTracks.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center p-6 text-center">
                  <Music className="w-6 h-6 text-slate-600 mb-1.5" />
                  <p className="text-xs font-medium text-slate-300">No songs added yet</p>
                  <p className="text-[11px] text-slate-500 mt-0.5 max-w-xs">
                    Click Add on tracks from the left column to assemble your custom playlist.
                  </p>
                </div>
              ) : (
                selectedTracks.map((track, idx) => (
                  <div
                    key={track.id}
                    className="px-3 py-2 flex items-center justify-between gap-2 hover:bg-white/[0.03]"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span className="w-5 text-right font-mono text-[11px] text-slate-500 tabular-nums shrink-0">
                        {idx + 1}.
                      </span>
                      <div className="min-w-0">
                        <p className="text-xs font-medium text-white truncate">{track.title}</p>
                        <p className="text-[11px] text-slate-400 truncate font-mono tabular-nums">
                          {track.bpm.toFixed(0)} BPM · {track.musicalKey} ·{' '}
                          {formatTrackDuration(track.durationSec)}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        onClick={() => handleMove(idx, -1)}
                        disabled={idx === 0}
                        className="p-1 rounded text-slate-400 hover:text-white disabled:opacity-25"
                        aria-label={`Move ${track.title} up`}
                      >
                        <ArrowUp className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleMove(idx, 1)}
                        disabled={idx === selectedTracks.length - 1}
                        className="p-1 rounded text-slate-400 hover:text-white disabled:opacity-25"
                        aria-label={`Move ${track.title} down`}
                      >
                        <ArrowDown className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleToggleTrack(track.id)}
                        className="p-1 rounded text-slate-500 hover:text-red-400"
                        aria-label={`Remove ${track.title}`}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="px-4 py-3 border-t border-white/[0.08] bg-[#0E1218] flex flex-wrap items-center justify-between gap-2 shrink-0">
          <span className="text-[11px] text-slate-400">
            Runs 100% offline with beat-synced EQ carving, stems &amp; FX tricks.
          </span>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={onClose}
              className="h-9 px-3 rounded-lg bg-[#171C26] hover:bg-white/10 border border-white/10 text-xs font-medium text-slate-300 whitespace-nowrap shrink-0"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!canSave}
              onClick={handleExportCarloNow}
              className="h-9 px-3 rounded-lg bg-[#171C26] hover:bg-white/10 border border-amber-500/40 text-xs font-semibold text-amber-300 flex items-center gap-1.5 disabled:opacity-40 whitespace-nowrap shrink-0"
              title="Download this playlist as a .carlo file"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Export .carlo</span>
            </button>
            <button
              type="button"
              disabled={!canSave}
              onClick={() => submit(false)}
              className="h-9 px-3.5 rounded-lg bg-[#1B2230] hover:bg-[#242D3F] border border-white/15 text-xs font-semibold text-white disabled:opacity-40 whitespace-nowrap shrink-0"
            >
              Save Playlist
            </button>
            <button
              type="button"
              disabled={!canSave}
              onClick={() => submit(true)}
              className="h-9 px-4 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-[#090B0F] text-xs font-bold flex items-center gap-1.5 disabled:opacity-40 whitespace-nowrap shrink-0 transition-colors"
            >
              <Bot className="w-4 h-4" />
              <span>{remixMode ? 'Save & AI Offline Remix' : 'Save & AI Mix'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
