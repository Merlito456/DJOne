import React, { useRef, useState } from 'react';
import {
  Search,
  Upload,
  Plus,
  Trash2,
  ListMusic,
  Youtube,
  Music,
  Loader2,
  FolderPlus,
  Bot,
  Play,
  Pencil,
  Sparkles,
  Download,
  FolderOpen,
  X,
  Shuffle,
  ArrowLeftRight,
} from 'lucide-react';
import { requestGapFiller, requestGoldenMashups } from '../audio/groqDirector';
import { extractYouTubeId, extractYouTubePlaylistId } from '../store/useLibraryStore';
import {
  DeckId,
  GapFillerResult,
  GoldenMashupPair,
  Playlist,
  TrackItem,
  YouTubeSearchResult,
} from '../types/dj';

interface LibraryPanelProps {
  tracks: TrackItem[];
  playlists: Playlist[];
  activePlaylistId: string;
  onSelectPlaylist: (id: string) => void;
  onCreatePlaylist: (name: string, initialTrackIds?: string[]) => string;
  onDeletePlaylist: (id: string) => void;
  onAddTrack: (track: TrackItem, playlistId?: string) => void;
  onAddTracksBatch: (tracks: TrackItem[], targetPlaylistId?: string) => void;
  onAddTrackToPlaylist: (trackId: string, playlistId: string) => void;
  onRemoveTrackFromPlaylist: (trackId: string, playlistId: string) => void;
  onLoadToDeck: (deckId: DeckId, track: TrackItem) => void;
  onImportFiles: (files: FileList) => Promise<void>;
  onAutoDjPlaylist: (playlistId: string, remixOverride?: boolean) => void;
  onOpenPlaylistBuilder: (playlist?: Playlist | null) => void;
  onExportCarloPlaylist: (playlistId: string) => void;
  onImportCarloFile: (file: File) => Promise<{
    playlistId: string;
    playlistName: string;
    trackCount: number;
    playableCount: number;
  }>;
  autopilotPlaylistId?: string;
  autopilotEnabled?: boolean;
  autopilotRemixMode?: boolean;
  deckATrackId?: string | null;
  deckBTrackId?: string | null;
  sidebarMode?: boolean;
  onCloseDrawer?: () => void;
  onEnrichCrate?: () => void;
  enrichingCrate?: boolean;
  onLoadMashupPair?: (vocalTrack: TrackItem, instTrack: TrackItem, pair: GoldenMashupPair) => void;
}

async function parseApiJson<T = any>(res: Response): Promise<T> {
  const text = await res.text();
  const trimmed = text.trim();
  if (trimmed.startsWith('<')) {
    throw new Error(
      'YouTube API returned HTML instead of JSON. Ensure Cloudflare Pages Functions (/functions) are deployed or run the Node server.'
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Invalid JSON response from API (HTTP ${res.status}).`);
  }
}

function formatDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${String(rem).padStart(2, '0')}`;
}

export const LibraryPanel: React.FC<LibraryPanelProps> = ({
  tracks,
  playlists,
  activePlaylistId,
  onSelectPlaylist,
  onCreatePlaylist,
  onDeletePlaylist,
  onAddTrack,
  onAddTracksBatch,
  onAddTrackToPlaylist,
  onRemoveTrackFromPlaylist,
  onLoadToDeck,
  onImportFiles,
  onAutoDjPlaylist,
  onOpenPlaylistBuilder,
  onExportCarloPlaylist,
  onImportCarloFile,
  autopilotPlaylistId,
  autopilotEnabled = false,
  autopilotRemixMode = false,
  deckATrackId,
  deckBTrackId,
  sidebarMode = false,
  onCloseDrawer,
  onEnrichCrate,
  enrichingCrate = false,
  onLoadMashupPair,
}) => {
  const [ytQuery, setYtQuery] = useState('');
  const [ytSearching, setYtSearching] = useState(false);
  const [ytResults, setYtResults] = useState<YouTubeSearchResult[]>([]);
  const [ytError, setYtError] = useState<string | null>(null);
  const [ytNotice, setYtNotice] = useState<string | null>(null);

  const [crateFilter, setCrateFilter] = useState('');
  const [mashupsOpen, setMashupsOpen] = useState(false);
  const [mashupsLoading, setMashupsLoading] = useState(false);
  const [goldenPairs, setGoldenPairs] = useState<GoldenMashupPair[]>([]);
  const [bridgeOpen, setBridgeOpen] = useState(false);
  const [bridgePrompt, setBridgePrompt] = useState('');
  const [bridgeLoading, setBridgeLoading] = useState(false);
  const [bridgeResult, setBridgeResult] = useState<GapFillerResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const carloInputRef = useRef<HTMLInputElement | null>(null);

  const activePlaylist = playlists.find((p) => p.id === activePlaylistId) || playlists[0];
  const activePlaylistTrackCount =
    activePlaylist.id === 'all' ? tracks.length : activePlaylist.trackIds.length;
  const isAiRunningHere = autopilotEnabled && autopilotPlaylistId === activePlaylist.id;

  const visibleTracks = tracks.filter((t) => {
    const inPlaylist =
      activePlaylist.id === 'all' || activePlaylist.trackIds.includes(t.id);
    if (!inPlaylist) return false;
    if (!crateFilter.trim()) return true;
    const q = crateFilter.toLowerCase();
    return (
      t.title.toLowerCase().includes(q) ||
      t.artist.toLowerCase().includes(q) ||
      t.musicalKey.toLowerCase().includes(q) ||
      String(t.bpm).includes(q)
    );
  });

  const toTrackItem = (yt: YouTubeSearchResult): TrackItem => ({
    id: `yt-${yt.videoId}`,
    title: yt.title,
    artist: yt.author,
    bpm: yt.bpmHint || 124,
    musicalKey: '8A',
    durationSec: yt.durationSec || 210,
    sourceType: 'youtube-iframe',
    youtubeId: yt.videoId,
    thumbnail: yt.thumbnail,
    firstBeatSec: 0,
    addedAt: Date.now(),
  });

  const handleYouTubeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = ytQuery.trim();
    if (!q) return;
    setYtError(null);
    setYtNotice(null);
    setYtSearching(true);

    try {
      const ytListId = extractYouTubePlaylistId(q);
      const directId = extractYouTubeId(q);

      if (ytListId && (q.includes('/playlist') || !directId)) {
        const res = await fetch(`/api/yt/playlist?list=${encodeURIComponent(ytListId)}`);
        const data = await parseApiJson<{ title?: string; tracks?: YouTubeSearchResult[]; error?: string }>(res);
        if (!res.ok) throw new Error(data.error || 'Could not import YouTube playlist');

        const rawTracks: YouTubeSearchResult[] = data.tracks || [];
        if (rawTracks.length === 0) {
          throw new Error('No playable tracks found in that YouTube playlist.');
        }

        const mapped = rawTracks.map(toTrackItem);
        const plName = String(data.title || 'YouTube Playlist').trim() || 'YouTube Playlist';
        const newPlId = onCreatePlaylist(
          plName,
          mapped.map((t) => t.id)
        );
        onAddTracksBatch(mapped, newPlId);
        setYtResults([]);
        setYtQuery('');
        setYtNotice(`Imported "${plName}" (${mapped.length} tracks) — ready for AI DJ.`);
      } else if (directId) {
        let data: {
          title?: string;
          author?: string;
          durationSec?: number;
          thumbnail?: string;
          bpmHint?: number | null;
          error?: string;
        } = {};
        try {
          const res = await fetch(`/api/yt/info?id=${encodeURIComponent(directId)}`);
          data = await parseApiJson(res);
          if (!res.ok) throw new Error(data.error || 'Could not load YouTube URL');
        } catch {
          data = {
            title: `YouTube Track (${directId})`,
            author: 'YouTube',
            durationSec: 210,
            thumbnail: `https://i.ytimg.com/vi/${directId}/hqdefault.jpg`,
            bpmHint: null,
          };
        }

        const newTrack: TrackItem = {
          id: `yt-${directId}`,
          title: data.title || `YouTube (${directId})`,
          artist: data.author || 'YouTube',
          bpm: data.bpmHint || 124,
          musicalKey: '8A',
          durationSec: data.durationSec || 210,
          sourceType: 'youtube-iframe',
          youtubeId: directId,
          thumbnail: data.thumbnail,
          firstBeatSec: 0,
          addedAt: Date.now(),
        };
        onAddTrack(newTrack, activePlaylistId !== 'all' ? activePlaylistId : 'youtube-crate');
        setYtResults([
          {
            videoId: directId,
            title: newTrack.title,
            author: newTrack.artist,
            durationSec: newTrack.durationSec,
            durationText: formatDuration(newTrack.durationSec),
            thumbnail: newTrack.thumbnail || '',
            bpmHint: data.bpmHint || null,
          },
        ]);
      } else {
        const res = await fetch(`/api/yt/search?q=${encodeURIComponent(q)}`);
        const data = await parseApiJson<{ results?: YouTubeSearchResult[]; error?: string }>(res);
        if (!res.ok) throw new Error(data.error || 'YouTube search failed');
        setYtResults(data.results || []);
        if (!data.results?.length) {
          setYtError('No YouTube tracks found for that search.');
        }
      }
    } catch (err: any) {
      setYtError(err?.message || 'Unable to query YouTube right now.');
    } finally {
      setYtSearching(false);
    }
  };

  const runDirectYtSearch = async (queryStr: string) => {
    const trimmed = queryStr.trim();
    if (!trimmed) return;
    setYtError(null);
    setYtSearching(true);
    try {
      const res = await fetch(`/api/yt/search?q=${encodeURIComponent(trimmed)}`);
      const data = await parseApiJson<{ results?: YouTubeSearchResult[]; error?: string }>(res);
      if (!res.ok) throw new Error(data.error || 'YouTube search failed');
      setYtResults(data.results || []);
      if (!data.results?.length) setYtError('No YouTube tracks found for that search.');
    } catch (err: any) {
      setYtError(err?.message || 'Unable to query YouTube right now.');
    } finally {
      setYtSearching(false);
    }
  };

  const handleScanMashups = async () => {
    const sourceTracks = visibleTracks.length >= 2 ? visibleTracks : tracks;
    if (sourceTracks.length < 2 || mashupsLoading) return;
    setMashupsOpen(true);
    setMashupsLoading(true);
    try {
      const res = await requestGoldenMashups({ tracks: sourceTracks });
      setGoldenPairs(res.pairs);
    } finally {
      setMashupsLoading(false);
    }
  };

  const handleBridgeSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!bridgePrompt.trim() || bridgeLoading) return;
    setBridgeLoading(true);
    try {
      const res = await requestGapFiller({
        query: bridgePrompt,
        tracks: visibleTracks.length > 0 ? visibleTracks : tracks,
      });
      setBridgeResult(res);
      if (res.searchQueries[0]) {
        setYtQuery(res.searchQueries[0]);
        await runDirectYtSearch(res.searchQueries[0]);
      }
    } finally {
      setBridgeLoading(false);
    }
  };

  return (
    <section
      className={`bg-[#11151C] flex flex-col h-full min-h-0 overflow-hidden ${
        sidebarMode
          ? 'border-r border-white/[0.1] rounded-none'
          : 'border border-white/[0.08] rounded-xl'
      }`}
    >
      {/* Drawer Header Bar */}
      {sidebarMode && (
        <div className="px-3.5 py-2.5 border-b border-white/[0.08] bg-[#0B0E14] flex items-center justify-between gap-2 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <ListMusic className="w-4 h-4 text-cyan-400 shrink-0" />
            <h2 className="font-display text-sm font-bold tracking-tight text-white truncate">
              Song Chooser & Playlists
            </h2>
          </div>
          {onCloseDrawer && (
            <button
              type="button"
              onClick={onCloseDrawer}
              className="h-7 px-2 rounded-md bg-[#171C26] hover:bg-white/10 border border-white/10 text-xs font-medium text-slate-300 hover:text-white flex items-center gap-1 transition-colors whitespace-nowrap shrink-0"
              aria-label="Hide Sidebar"
            >
              <X className="w-3.5 h-3.5" />
              <span>Hide</span>
            </button>
          )}
        </div>
      )}

      {/* Search YouTube / Import Audio */}
      <div className="px-3 py-2.5 border-b border-white/[0.08] flex flex-col gap-2 bg-[#0E1218] shrink-0">
        <form onSubmit={handleYouTubeSubmit} className="flex items-center gap-1.5">
          <div className="relative flex-1 min-w-0">
            <Youtube className="w-4 h-4 text-red-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={ytQuery}
              onChange={(e) => setYtQuery(e.target.value)}
              placeholder="Search YouTube or paste URL / ?list=..."
              className="w-full h-8 pl-8 pr-2.5 rounded-lg bg-[#090B0F] border border-white/10 text-xs text-white placeholder:text-slate-500 focus:outline-none focus:border-cyan-400"
            />
          </div>
          <button
            type="submit"
            disabled={ytSearching || !ytQuery.trim()}
            className="h-8 px-2.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-[#090B0F] font-semibold text-xs flex items-center gap-1 transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
          >
            {ytSearching ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Search className="w-3.5 h-3.5" />
            )}
            <span>Search</span>
          </button>
        </form>

        <div className="flex items-center justify-between gap-1.5">
          <input
            ref={fileInputRef}
            type="file"
            accept="audio/*"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) {
                onImportFiles(e.target.files);
                e.target.value = '';
              }
            }}
          />
          <input
            ref={carloInputRef}
            type="file"
            accept=".carlo,.json"
            className="hidden"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              try {
                setYtError(null);
                const info = await onImportCarloFile(file);
                setYtNotice(
                  `Loaded "${info.playlistName}.carlo" (${info.playableCount}/${info.trackCount} playable tracks)`
                );
              } catch (err: any) {
                setYtError(err?.message || 'Failed to load .carlo playlist file.');
              }
            }}
          />

          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="h-7 px-2.5 rounded-md bg-[#171C26] hover:bg-[#1E2533] border border-white/10 text-slate-200 text-[11px] font-medium flex items-center gap-1 transition-colors whitespace-nowrap shrink-0"
          >
            <Upload className="w-3 h-3 text-cyan-400" />
            <span>Audio File</span>
          </button>

          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={() => carloInputRef.current?.click()}
              className="h-7 px-2 rounded-md bg-[#171C26] hover:bg-white/10 border border-white/15 text-[11px] font-semibold text-slate-200 flex items-center gap-1 transition-colors whitespace-nowrap shrink-0"
              title="Load saved .carlo playlist file"
            >
              <FolderOpen className="w-3 h-3 text-amber-400" />
              <span>Load .carlo</span>
            </button>
            <button
              type="button"
              onClick={() => onOpenPlaylistBuilder(null)}
              className="h-7 px-2.5 rounded-md bg-cyan-500/15 hover:bg-cyan-500 hover:text-[#090B0F] border border-cyan-500/40 text-[11px] font-semibold text-cyan-300 flex items-center gap-1 transition-colors whitespace-nowrap shrink-0"
              title="Open Offline Playlist Builder"
            >
              <FolderPlus className="w-3 h-3" />
              <span>Build Set</span>
            </button>
          </div>
        </div>
      </div>

      {ytNotice && (
        <div className="px-3 py-1.5 bg-emerald-500/10 border-b border-emerald-500/25 flex items-center justify-between gap-2 text-xs text-emerald-300 shrink-0">
          <span className="truncate">{ytNotice}</span>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => {
                onAutoDjPlaylist(activePlaylist.id);
                setYtNotice(null);
              }}
              className="px-2 py-0.5 rounded bg-emerald-500 text-[#090B0F] font-bold text-[11px] hover:bg-emerald-400 whitespace-nowrap"
            >
              AI DJ Now
            </button>
            <button
              type="button"
              onClick={() => setYtNotice(null)}
              className="text-slate-400 hover:text-white text-[11px]"
            >
              Close
            </button>
          </div>
        </div>
      )}

      {/* YouTube Search Results Strip (when populated) */}
      {(ytResults.length > 0 || ytError) && (
        <div className="p-2.5 border-b border-white/[0.08] bg-[#0B0E14] shrink-0">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[11px] font-semibold text-slate-300">
              YouTube Results {ytResults.length > 0 ? `(${ytResults.length})` : ''}
            </span>
            <button
              type="button"
              onClick={() => {
                setYtResults([]);
                setYtError(null);
              }}
              className="text-[11px] text-slate-400 hover:text-white"
            >
              Clear
            </button>
          </div>
          {ytError ? (
            <p className="text-xs text-amber-400">{ytError}</p>
          ) : (
            <div className="flex flex-col gap-1.5 max-h-48 overflow-y-auto pr-1">
              {ytResults.map((yt) => {
                const trackObj = toTrackItem(yt);
                return (
                  <div
                    key={yt.videoId}
                    className="flex items-center gap-2 p-1.5 rounded-lg bg-[#131822] border border-white/[0.06] hover:border-white/15"
                  >
                    <img
                      src={yt.thumbnail}
                      alt={yt.title}
                      referrerPolicy="no-referrer"
                      className="w-10 h-8 rounded object-cover shrink-0 bg-[#090B0F]"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium text-white truncate">{yt.title}</p>
                      <p className="text-[10px] text-slate-400 truncate">
                        {yt.author} · <span className="font-mono tabular-nums">{yt.durationText}</span>
                      </p>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        onClick={() => {
                          onAddTrack(trackObj, activePlaylistId);
                          onLoadToDeck('A', trackObj);
                        }}
                        className="px-1.5 py-1 rounded bg-cyan-500/15 border border-cyan-500/40 text-cyan-300 hover:bg-cyan-500 hover:text-[#090B0F] text-[10px] font-bold transition-colors"
                        title="Load onto Deck A"
                      >
                        A
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          onAddTrack(trackObj, activePlaylistId);
                          onLoadToDeck('B', trackObj);
                        }}
                        className="px-1.5 py-1 rounded bg-orange-500/15 border border-orange-500/40 text-orange-300 hover:bg-orange-500 hover:text-[#090B0F] text-[10px] font-bold transition-colors"
                        title="Load onto Deck B"
                      >
                        B
                      </button>
                      <button
                        type="button"
                        onClick={() => onAddTrack(trackObj, activePlaylistId)}
                        className="p-1 rounded bg-[#1A202C] border border-white/10 text-slate-300 hover:text-white"
                        title="Save to Playlist"
                        aria-label="Save to Playlist"
                      >
                        <Plus className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Playlists List Strip */}
      <div className="border-b border-white/[0.08] p-2.5 bg-[#0D1016] shrink-0">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
            Playlists ({playlists.length})
          </span>
          <button
            type="button"
            disabled={activePlaylistTrackCount === 0}
            onClick={() => {
              onExportCarloPlaylist(activePlaylist.id);
              setYtNotice(`Saved "${activePlaylist.name}.carlo" to downloads.`);
            }}
            className="h-6 px-2 rounded bg-[#171C26] hover:bg-white/10 border border-white/15 text-[10px] font-semibold text-amber-300 flex items-center gap-1 transition-colors whitespace-nowrap shrink-0 disabled:opacity-40"
            title="Save active playlist to a .carlo file"
          >
            <Download className="w-3 h-3" />
            <span>Save .carlo</span>
          </button>
        </div>

        <div className="flex flex-col gap-1 max-h-36 overflow-y-auto pr-0.5">
          {playlists.map((pl) => {
            const active = pl.id === activePlaylistId;
            const count = pl.id === 'all' ? tracks.length : pl.trackIds.length;
            const isAiActive = autopilotEnabled && autopilotPlaylistId === pl.id;
            return (
              <div
                key={pl.id}
                className={`flex items-center justify-between gap-1.5 px-2 py-1.5 rounded-lg text-xs cursor-pointer transition-colors ${
                  active
                    ? 'bg-white/10 text-white font-medium'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-white/[0.04]'
                }`}
                onClick={() => onSelectPlaylist(pl.id)}
              >
                <span
                  className={`truncate min-w-0 ${
                    isAiActive ? 'text-emerald-300 font-semibold' : ''
                  }`}
                >
                  {pl.name}
                </span>
                <div className="flex items-center gap-1 shrink-0">
                  <span className="font-mono text-[11px] text-slate-500 tabular-nums mr-0.5">
                    {count}
                  </span>
                  {count > 0 && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onAutoDjPlaylist(pl.id);
                      }}
                      className={`p-1 rounded transition-colors ${
                        isAiActive
                          ? 'text-emerald-400 bg-emerald-500/15'
                          : 'text-slate-400 hover:text-emerald-300 hover:bg-white/10'
                      }`}
                      title={`AI DJ "${pl.name}" offline`}
                      aria-label={`AI DJ ${pl.name}`}
                    >
                      <Play className="w-3 h-3 fill-current" />
                    </button>
                  )}
                  {!pl.isSystem && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenPlaylistBuilder(pl);
                      }}
                      className="p-1 text-slate-500 hover:text-cyan-300"
                      title={`Edit ${pl.name}`}
                      aria-label={`Edit ${pl.name}`}
                    >
                      <Pencil className="w-3 h-3" />
                    </button>
                  )}
                  {!pl.isSystem && pl.id !== 'youtube-crate' && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeletePlaylist(pl.id);
                      }}
                      className="p-1 text-slate-500 hover:text-red-400"
                      aria-label={`Delete ${pl.name}`}
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Active Playlist Actions + Track Filter */}
      <div className="px-3 py-2 border-b border-white/[0.06] flex flex-col gap-1.5 bg-[#0F131A] shrink-0">
        <div className="flex items-center justify-between gap-1.5">
          <span className="text-[11px] font-medium text-slate-300 truncate">
            {activePlaylist.name} ·{' '}
            <span className="font-mono text-slate-400 tabular-nums">
              {visibleTracks.length} tracks
            </span>
          </span>
          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              disabled={tracks.length < 2 || mashupsLoading}
              onClick={() => (mashupsOpen ? setMashupsOpen(false) : void handleScanMashups())}
              className={`h-6 px-2 rounded border text-[10px] font-semibold flex items-center gap-1 transition-colors disabled:opacity-40 ${
                mashupsOpen
                  ? 'bg-purple-500/25 border-purple-400 text-purple-200'
                  : 'bg-[#171C26] hover:bg-white/10 border-white/15 text-purple-200'
              }`}
              title="Golden Mashup Finder: scan crate for top Vocal-over-Instrumental pairs"
            >
              {mashupsLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Shuffle className="w-3 h-3" />}
              <span>Mashups</span>
            </button>
            <button
              type="button"
              onClick={() => setBridgeOpen((v) => !v)}
              className={`h-6 px-2 rounded border text-[10px] font-semibold flex items-center gap-1 transition-colors ${
                bridgeOpen
                  ? 'bg-amber-500/25 border-amber-400 text-amber-200'
                  : 'bg-[#171C26] hover:bg-white/10 border-white/15 text-amber-200'
              }`}
              title="Crate Gap-Filler & Smart Bridge Search (e.g. 116 BPM Afrobeats -> 128 BPM Tech House)"
            >
              <ArrowLeftRight className="w-3 h-3" />
              <span>Bridge</span>
            </button>
            {onEnrichCrate && (
              <button
                type="button"
                disabled={visibleTracks.length === 0 || enrichingCrate}
                onClick={onEnrichCrate}
                className="h-6 px-2 rounded bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-500/40 text-[10px] font-semibold text-cyan-200 flex items-center gap-1 transition-colors disabled:opacity-40"
                title="Enrich playlist with Groq Llama-3.1 sub-genre, crowd moment, mood & energy ratings"
              >
                {enrichingCrate ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <Sparkles className="w-3 h-3" />
                )}
                <span>{enrichingCrate ? 'Enriching...' : 'AI Enrich'}</span>
              </button>
            )}
            <input
              type="text"
              value={crateFilter}
              onChange={(e) => setCrateFilter(e.target.value)}
              placeholder="Filter..."
              className="h-6 w-20 px-2 rounded bg-[#090B0F] border border-white/10 text-[11px] text-white placeholder:text-slate-500 focus:outline-none focus:border-cyan-400"
            />
          </div>
        </div>

        {/* Golden Mashup Finder Drawer */}
        {mashupsOpen && (
          <div className="bg-[#0B0E14] border border-purple-500/30 rounded-lg p-2 flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10.5px] font-semibold text-purple-200">
                Golden Mashup Finder ({goldenPairs.length})
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => void handleScanMashups()}
                  disabled={mashupsLoading}
                  className="text-[10px] text-purple-300 hover:text-white"
                >
                  {mashupsLoading ? 'Scanning...' : 'Rescan'}
                </button>
                <button
                  type="button"
                  onClick={() => setMashupsOpen(false)}
                  className="text-[10px] text-slate-400 hover:text-white"
                >
                  Close
                </button>
              </div>
            </div>
            {mashupsLoading ? (
              <div className="text-[10.5px] text-slate-400 py-1">Analyzing BPM, Camelot keys & vocal pockets...</div>
            ) : goldenPairs.length === 0 ? (
              <div className="text-[10.5px] text-slate-400 py-1">Add at least 2 tracks to find mashup pairs.</div>
            ) : (
              <div className="flex flex-col gap-1 max-h-36 overflow-y-auto">
                {goldenPairs.map((pair, idx) => {
                  const vTrack = tracks.find((t) => t.id === pair.vocalTrackId);
                  const iTrack = tracks.find((t) => t.id === pair.instTrackId);
                  if (!vTrack || !iTrack) return null;
                  return (
                    <div
                      key={`${pair.vocalTrackId}-${pair.instTrackId}-${idx}`}
                      className="p-1.5 rounded bg-[#121620] border border-white/[0.06] flex items-center justify-between gap-2"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="text-[10.5px] font-semibold text-white truncate">
                          <span className="text-purple-300">{Math.round(pair.compatibilityScore)}%</span>{' '}
                          · {vTrack.title.split('(')[0].trim()} × {iTrack.title.split('(')[0].trim()}
                        </div>
                        <div className="text-[9.5px] text-slate-400 truncate">
                          {pair.reason} · {pair.template}
                        </div>
                      </div>
                      {onLoadMashupPair && (
                        <button
                          type="button"
                          onClick={() => onLoadMashupPair(vTrack, iTrack, pair)}
                          className="h-6 px-2 rounded bg-purple-500 hover:bg-purple-400 text-[#090B0F] text-[10px] font-bold shrink-0"
                        >
                          Load A+B
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Crate Gap-Filler & Smart Bridge Search Drawer */}
        {bridgeOpen && (
          <div className="bg-[#0B0E14] border border-amber-500/30 rounded-lg p-2 flex flex-col gap-1.5">
            <form onSubmit={handleBridgeSearch} className="flex items-center gap-1.5">
              <input
                type="text"
                value={bridgePrompt}
                onChange={(e) => setBridgePrompt(e.target.value)}
                placeholder="Bridge e.g. 116 BPM Afro into 128 BPM House..."
                className="flex-1 min-w-0 h-6 px-2 rounded bg-[#121620] border border-white/10 text-[10.5px] text-white placeholder:text-slate-500 focus:outline-none focus:border-amber-400"
              />
              <button
                type="submit"
                disabled={bridgeLoading || !bridgePrompt.trim()}
                className="h-6 px-2 rounded bg-amber-400 hover:bg-amber-300 text-[#090B0F] text-[10px] font-bold flex items-center gap-1 shrink-0 disabled:opacity-45"
              >
                {bridgeLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Search className="w-3 h-3" />}
                <span>Find</span>
              </button>
            </form>
            {bridgeResult && (
              <div className="flex flex-col gap-1 text-[10px] text-slate-300">
                <div className="text-amber-200 font-semibold">
                  Target {bridgeResult.targetBpmMin}–{bridgeResult.targetBpmMax} BPM · Keys{' '}
                  {bridgeResult.targetKeys.join(', ')}
                </div>
                <div className="text-slate-400">
                  {bridgeResult.summary}
                  {bridgeResult.vibeNote ? ` — ${bridgeResult.vibeNote}` : ''}
                </div>
                <div className="flex flex-wrap gap-1 pt-0.5">
                  {bridgeResult.searchQueries.map((q) => (
                    <button
                      key={q}
                      type="button"
                      onClick={() => {
                        setYtQuery(q);
                        void runDirectYtSearch(q);
                      }}
                      className="px-1.5 py-0.5 rounded bg-[#171C26] hover:bg-amber-500/20 border border-white/10 text-[9.5px] text-amber-200"
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        <div className="grid grid-cols-2 gap-1.5">
          <button
            type="button"
            disabled={activePlaylistTrackCount === 0}
            onClick={() => onAutoDjPlaylist(activePlaylist.id, false)}
            className={`h-7 px-2 rounded-md text-[11px] font-semibold flex items-center justify-center gap-1 border transition-colors whitespace-nowrap disabled:opacity-40 ${
              isAiRunningHere && !autopilotRemixMode
                ? 'bg-emerald-500 text-[#090B0F] border-emerald-400'
                : 'bg-[#171C26] border-white/15 text-slate-200 hover:border-emerald-500/50 hover:text-emerald-300'
            }`}
            title="Offline AI mixes this playlist smoothly from track to track"
          >
            <Bot className="w-3.5 h-3.5" />
            <span>{isAiRunningHere && !autopilotRemixMode ? 'Stop AI Mix' : 'AI Mix Set'}</span>
          </button>
          <button
            type="button"
            disabled={activePlaylistTrackCount === 0}
            onClick={() => onAutoDjPlaylist(activePlaylist.id, true)}
            className={`h-7 px-2 rounded-md text-[11px] font-semibold flex items-center justify-center gap-1 border transition-colors whitespace-nowrap disabled:opacity-40 ${
              isAiRunningHere && autopilotRemixMode
                ? 'bg-emerald-500 text-[#090B0F] border-emerald-400'
                : 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300 hover:bg-emerald-500 hover:text-[#090B0F]'
            }`}
            title="Offline AI performs live stem-carved remixes, beat chops & drop swaps across this playlist"
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>
              {isAiRunningHere && autopilotRemixMode ? 'Stop AI Remix' : 'AI Offline Remix'}
            </span>
          </button>
        </div>
      </div>

      {/* Track Chooser List */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {visibleTracks.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 px-4 text-center">
            <Music className="w-6 h-6 text-slate-600 mb-1.5" />
            <p className="text-xs font-medium text-slate-300">No songs in this playlist</p>
            <p className="text-[11px] text-slate-500 mt-0.5 max-w-xs">
              Search YouTube above or import audio files to populate your crate.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-white/[0.05]">
            {visibleTracks.map((track) => {
              const onA = deckATrackId === track.id;
              const onB = deckBTrackId === track.id;
              const srcLabel = track.sourceType.startsWith('youtube') ? 'YT' : 'File';
              const customPlaylists = playlists.filter((p) => p.id !== 'all');

              return (
                <div
                  key={track.id}
                  className="px-3 py-2 flex items-center justify-between gap-2 hover:bg-white/[0.03] transition-colors"
                >
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    {track.thumbnail ? (
                      <img
                        src={track.thumbnail}
                        alt={track.title}
                        referrerPolicy="no-referrer"
                        className="w-8 h-8 rounded object-cover shrink-0 bg-[#090B0F]"
                      />
                    ) : (
                      <div className="w-8 h-8 rounded bg-[#171C26] border border-white/[0.08] flex items-center justify-center shrink-0">
                        <Music className="w-3.5 h-3.5 text-slate-400" />
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium text-slate-100 truncate">{track.title}</p>
                      <p className="text-[10px] text-slate-400 truncate font-mono tabular-nums">
                        {track.artist} · {track.bpm.toFixed(0)} BPM · {track.musicalKey} ·{' '}
                        {formatDuration(track.durationSec)} · {srcLabel}
                      </p>
                      {(track.enrichment || track.lyricCues?.words?.length) && (
                        <p className="text-[9.5px] text-cyan-300/85 truncate font-mono mt-0.5">
                          {track.enrichment
                            ? `${track.enrichment.subGenre} · ${track.enrichment.crowdMoment} · E${track.enrichment.energyScore}`
                            : ''}
                          {track.enrichment && track.lyricCues?.words?.length ? ' · ' : ''}
                          {track.lyricCues?.words?.length ? 'Lyrics✓' : ''}
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => onLoadToDeck('A', track)}
                      className={`min-w-[26px] h-7 px-1.5 rounded text-[11px] font-bold border transition-colors ${
                        onA
                          ? 'bg-cyan-500 text-[#090B0F] border-cyan-400'
                          : 'bg-[#171C26] border-cyan-500/40 text-cyan-300 hover:bg-cyan-500/20'
                      }`}
                      title="Load onto Deck A"
                    >
                      A
                    </button>
                    <button
                      type="button"
                      onClick={() => onLoadToDeck('B', track)}
                      className={`min-w-[26px] h-7 px-1.5 rounded text-[11px] font-bold border transition-colors ${
                        onB
                          ? 'bg-orange-500 text-[#090B0F] border-orange-400'
                          : 'bg-[#171C26] border-orange-500/40 text-orange-300 hover:bg-orange-500/20'
                      }`}
                      title="Load onto Deck B"
                    >
                      B
                    </button>
                    <select
                      aria-label={`Add ${track.title} to playlist`}
                      defaultValue=""
                      onChange={(e) => {
                        if (e.target.value) {
                          onAddTrackToPlaylist(track.id, e.target.value);
                          e.target.value = '';
                        }
                      }}
                      className="h-7 w-6 rounded bg-[#171C26] border border-white/10 text-slate-300 text-xs text-center cursor-pointer"
                      title="Add to playlist"
                    >
                      <option value="" disabled>
                        +
                      </option>
                      {customPlaylists.map((pl) => (
                        <option key={pl.id} value={pl.id} className="bg-[#11151C] text-white">
                          + {pl.name}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() =>
                        onRemoveTrackFromPlaylist(track.id, activePlaylistId)
                      }
                      className="p-1 rounded text-slate-500 hover:text-red-400"
                      title="Remove from crate"
                      aria-label="Remove from crate"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
};
