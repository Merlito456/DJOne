import { useState, useEffect, useCallback } from 'react';
import { mergeTrackWithCalibration, saveTrackCalibration } from '../audio/aiMemory';
import {
  AiDjVibe,
  CarloPlaylistFile,
  Playlist,
  RecordingItem,
  TrackItem,
} from '../types/dj';

const TRACKS_KEY = 'deckforge_tracks_v1';
const PLAYLISTS_KEY = 'deckforge_playlists_v1';

const DEFAULT_PLAYLISTS: Playlist[] = [
  {
    id: 'all',
    name: 'All Tracks',
    trackIds: [],
    isSystem: true,
  },
  {
    id: 'youtube-crate',
    name: 'YouTube Crate',
    trackIds: [],
  },
];

export function extractYouTubePlaylistId(input: string): string | null {
  try {
    const url = new URL(input.trim());
    if (url.hostname.includes('youtube.com') || url.hostname.includes('youtu.be')) {
      const list = url.searchParams.get('list');
      if (list && /^[a-zA-Z0-9_-]{8,64}$/.test(list)) return list;
    }
  } catch {
    // ignore
  }
  return null;
}

export function extractYouTubeId(input: string): string | null {
  const trimmed = input.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    if (url.hostname.includes('youtu.be')) {
      const id = url.pathname.split('/').filter(Boolean)[0];
      return id && id.length >= 6 ? id : null;
    }
    if (url.hostname.includes('youtube.com') || url.hostname.includes('youtube-nocookie.com')) {
      const v = url.searchParams.get('v');
      if (v) return v;
      const parts = url.pathname.split('/').filter(Boolean);
      const idx = parts.findIndex((p) => p === 'shorts' || p === 'embed' || p === 'live');
      if (idx !== -1 && parts[idx + 1]) return parts[idx + 1];
    }
  } catch {
    // not a valid URL
  }
  return null;
}

const VALID_VIBES: AiDjVibe[] = [
  'club-blend',
  'festival-drop',
  'techno-hypnotic',
  'scratch-chop',
  'mashup-live',
  'chill-sunset',
];

export function downloadCarloPlaylistFile(payload: CarloPlaylistFile) {
  const safeBase =
    payload.playlist.name
      .toLowerCase()
      .replace(/[^a-z0-9-_]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'deckforge-playlist';
  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${safeBase}.carlo`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function parseCarloPlaylistText(rawText: string): CarloPlaylistFile {
  let parsed: any;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new Error('Invalid .carlo file: unable to parse playlist data.');
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid .carlo playlist format.');
  }

  const plRaw = parsed.playlist;
  const tracksRaw = parsed.tracks;
  if (!plRaw || typeof plRaw !== 'object' || !Array.isArray(tracksRaw)) {
    throw new Error('Invalid .carlo file: missing playlist or tracks list.');
  }

  const sanitizedTracks: TrackItem[] = [];
  for (const item of tracksRaw) {
    if (!item || typeof item !== 'object') continue;
    const id = String(item.id || '').trim();
    const title = String(item.title || '').trim();
    if (!id || !title) continue;
    const sourceType =
      item.sourceType === 'local' ||
      item.sourceType === 'youtube-stream' ||
      item.sourceType === 'youtube-iframe'
        ? item.sourceType
        : item.youtubeId
        ? 'youtube-iframe'
        : null;
    if (!sourceType) continue;

    sanitizedTracks.push({
      id,
      title: title.slice(0, 180),
      artist: String(item.artist || 'Unknown Artist').slice(0, 120),
      bpm:
        typeof item.bpm === 'number' && Number.isFinite(item.bpm)
          ? Math.max(60, Math.min(200, item.bpm))
          : 124,
      musicalKey: String(item.musicalKey || '8A').slice(0, 8),
      durationSec:
        typeof item.durationSec === 'number' && Number.isFinite(item.durationSec)
          ? Math.max(10, item.durationSec)
          : 180,
      sourceType,
      youtubeId: typeof item.youtubeId === 'string' ? item.youtubeId : undefined,
      thumbnail: typeof item.thumbnail === 'string' ? item.thumbnail : undefined,
      firstBeatSec:
        typeof item.firstBeatSec === 'number' && Number.isFinite(item.firstBeatSec)
          ? item.firstBeatSec
          : 0,
      dropCueSec:
        typeof item.dropCueSec === 'number' && Number.isFinite(item.dropCueSec) && item.dropCueSec >= 0
          ? item.dropCueSec
          : undefined,
      autoTrimGain:
        typeof item.autoTrimGain === 'number' &&
        Number.isFinite(item.autoTrimGain) &&
        item.autoTrimGain >= 0.45 &&
        item.autoTrimGain <= 1.5
          ? item.autoTrimGain
          : undefined,
      calibrated: Boolean(item.calibrated || typeof item.dropCueSec === 'number'),
      addedAt: typeof item.addedAt === 'number' ? item.addedAt : Date.now(),
    });
  }

  if (sanitizedTracks.length === 0) {
    throw new Error('This .carlo file contains no valid tracks.');
  }

  const validTrackIds = new Set(sanitizedTracks.map((t) => t.id));
  const rawOrder = Array.isArray(plRaw.trackIds) ? plRaw.trackIds.map(String) : [];
  const trackIds = rawOrder.filter((id: string) => validTrackIds.has(id));
  for (const t of sanitizedTracks) {
    if (!trackIds.includes(t.id)) trackIds.push(t.id);
  }

  const preferredVibe = VALID_VIBES.includes(plRaw.preferredVibe)
    ? (plRaw.preferredVibe as AiDjVibe)
    : 'club-blend';
  const aggressiveness =
    typeof plRaw.aggressiveness === 'number' && Number.isFinite(plRaw.aggressiveness)
      ? Math.max(0, Math.min(100, Math.round(plRaw.aggressiveness)))
      : 55;

  return {
    format: 'deckforge.carlo',
    version: 1,
    exportedAt: String(parsed.exportedAt || new Date().toISOString()),
    playlist: {
      name:
        String(plRaw.name || 'Imported .carlo Set')
          .trim()
          .slice(0, 80) || 'Imported .carlo Set',
      preferredVibe,
      remixMode: Boolean(plRaw.remixMode),
      aggressiveness,
      trackIds,
    },
    tracks: sanitizedTracks,
  };
}

export function useLibraryStore() {
  const [tracks, setTracks] = useState<TrackItem[]>(() => {
    try {
      const raw = localStorage.getItem(TRACKS_KEY);
      if (raw) {
        const parsed: any[] = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          return parsed
            .filter(
              (t) =>
                t &&
                typeof t.id === 'string' &&
                !t.id.startsWith('studio-') &&
                t.sourceType !== 'studio' &&
                t.sourceType !== 'local'
            )
            .map((t) => mergeTrackWithCalibration(t));
        }
      }
    } catch {
      // ignore storage errors
    }
    return [];
  });

  const [playlists, setPlaylists] = useState<Playlist[]>(() => {
    try {
      const raw = localStorage.getItem(PLAYLISTS_KEY);
      if (raw) {
        const parsed: Playlist[] = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const cleaned = parsed
            .map((pl) => ({
              ...pl,
              trackIds: (pl.trackIds || []).filter((id) => !id.startsWith('studio-')),
            }))
            .filter(
              (pl) =>
                (pl.id !== 'club-warmup' && pl.id !== 'peak-time') || pl.trackIds.length > 0
            );
          if (cleaned.length > 0) return cleaned;
        }
      }
    } catch {
      // ignore
    }
    return DEFAULT_PLAYLISTS;
  });

  const [activePlaylistId, setActivePlaylistId] = useState<string>('all');
  const [recordings, setRecordings] = useState<RecordingItem[]>([]);

  useEffect(() => {
    try {
      const persistable = tracks.filter((t) => t.sourceType !== 'local');
      localStorage.setItem(TRACKS_KEY, JSON.stringify(persistable));
    } catch {
      // ignore quota errors
    }
  }, [tracks]);

  useEffect(() => {
    try {
      localStorage.setItem(PLAYLISTS_KEY, JSON.stringify(playlists));
    } catch {
      // ignore
    }
  }, [playlists]);

  const addTrack = useCallback((rawTrack: TrackItem, targetPlaylistId?: string) => {
    const track = mergeTrackWithCalibration(rawTrack);
    setTracks((prev) => {
      if (prev.some((t) => t.id === track.id)) return prev;
      return [track, ...prev];
    });
    setPlaylists((prev) =>
      prev.map((pl) => {
        if (
          pl.id === 'all' ||
          pl.id === targetPlaylistId ||
          (track.sourceType.startsWith('youtube') && pl.id === 'youtube-crate')
        ) {
          if (pl.trackIds.includes(track.id)) return pl;
          return { ...pl, trackIds: [track.id, ...pl.trackIds] };
        }
        return pl;
      })
    );
  }, []);

  const addTracksBatch = useCallback((rawNewTracks: TrackItem[], targetPlaylistId?: string) => {
    if (rawNewTracks.length === 0) return;
    const newTracks = rawNewTracks.map((t) => mergeTrackWithCalibration(t));
    setTracks((prev) => {
      const existingIds = new Set(prev.map((t) => t.id));
      const toAdd = newTracks.filter((t) => !existingIds.has(t.id));
      return [...toAdd, ...prev];
    });
    const batchIds = newTracks.map((t) => t.id);
    setPlaylists((prev) =>
      prev.map((pl) => {
        const shouldInclude =
          pl.id === 'all' ||
          pl.id === targetPlaylistId ||
          (newTracks.some((t) => t.sourceType.startsWith('youtube')) && pl.id === 'youtube-crate');
        if (!shouldInclude) return pl;
        const existing = new Set(pl.trackIds);
        const merged = [...pl.trackIds, ...batchIds.filter((id) => !existing.has(id))];
        return { ...pl, trackIds: merged };
      })
    );
  }, []);

  const updateTrackMeta = useCallback((trackId: string, patch: Partial<TrackItem>) => {
    setTracks((prev) =>
      prev.map((t) => {
        if (t.id !== trackId) return t;
        const next: TrackItem = { ...t, ...patch };
        if (
          patch.bpm !== undefined ||
          patch.musicalKey !== undefined ||
          patch.firstBeatSec !== undefined ||
          patch.dropCueSec !== undefined ||
          patch.autoTrimGain !== undefined
        ) {
          if (
            patch.bpm !== undefined ||
            patch.musicalKey !== undefined ||
            patch.firstBeatSec !== undefined ||
            patch.dropCueSec !== undefined
          ) {
            next.calibrated = true;
          }
          saveTrackCalibration(next, {
            bpm: next.bpm,
            musicalKey: next.musicalKey,
            firstBeatSec: next.firstBeatSec,
            dropCueSec: next.dropCueSec,
            autoTrimGain: next.autoTrimGain,
          });
        }
        return next;
      })
    );
  }, []);

  const removeTrack = useCallback((trackId: string) => {
    setTracks((prev) => prev.filter((t) => t.id !== trackId));
    setPlaylists((prev) =>
      prev.map((pl) => ({
        ...pl,
        trackIds: pl.trackIds.filter((id) => id !== trackId),
      }))
    );
  }, []);

  const createPlaylist = useCallback(
    (
      name: string,
      initialTrackIds: string[] = [],
      options?: { preferredVibe?: AiDjVibe; remixMode?: boolean; aggressiveness?: number }
    ): string => {
      const clean = name.trim();
      const id = `pl-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
      if (!clean) return id;
      setPlaylists((prev) => [
        ...prev,
        {
          id,
          name: clean,
          trackIds: initialTrackIds,
          preferredVibe: options?.preferredVibe,
          remixMode: options?.remixMode,
          aggressiveness: options?.aggressiveness,
        },
      ]);
      setActivePlaylistId(id);
      return id;
    },
    []
  );

  const updatePlaylist = useCallback(
    (
      playlistId: string,
      patch: {
        name?: string;
        trackIds?: string[];
        preferredVibe?: AiDjVibe;
        remixMode?: boolean;
        aggressiveness?: number;
      }
    ) => {
      setPlaylists((prev) =>
        prev.map((pl) => {
          if (pl.id !== playlistId) return pl;
          return {
            ...pl,
            name: patch.name !== undefined ? patch.name.trim() || pl.name : pl.name,
            trackIds: patch.trackIds !== undefined ? patch.trackIds : pl.trackIds,
            preferredVibe:
              patch.preferredVibe !== undefined ? patch.preferredVibe : pl.preferredVibe,
            remixMode: patch.remixMode !== undefined ? patch.remixMode : pl.remixMode,
            aggressiveness:
              patch.aggressiveness !== undefined ? patch.aggressiveness : pl.aggressiveness,
          };
        })
      );
    },
    []
  );

  const deletePlaylist = useCallback((playlistId: string) => {
    setPlaylists((prev) => prev.filter((p) => p.id !== playlistId || p.isSystem));
    setActivePlaylistId((cur) => (cur === playlistId ? 'all' : cur));
  }, []);

  const addTrackToPlaylist = useCallback((trackId: string, playlistId: string) => {
    setPlaylists((prev) =>
      prev.map((pl) => {
        if (pl.id !== playlistId) return pl;
        if (pl.trackIds.includes(trackId)) return pl;
        return { ...pl, trackIds: [...pl.trackIds, trackId] };
      })
    );
  }, []);

  const removeTrackFromPlaylist = useCallback(
    (trackId: string, playlistId: string) => {
      if (playlistId === 'all') {
        removeTrack(trackId);
        return;
      }
      setPlaylists((prev) =>
        prev.map((pl) =>
          pl.id === playlistId
            ? { ...pl, trackIds: pl.trackIds.filter((id) => id !== trackId) }
            : pl
        )
      );
    },
    [removeTrack]
  );

  const addRecording = useCallback((rec: RecordingItem) => {
    setRecordings((prev) => [rec, ...prev]);
  }, []);

  const removeRecording = useCallback((id: string) => {
    setRecordings((prev) => {
      const target = prev.find((r) => r.id === id);
      if (target) URL.revokeObjectURL(target.url);
      return prev.filter((r) => r.id !== id);
    });
  }, []);

  const exportPlaylistToCarlo = useCallback(
    (playlistId: string): CarloPlaylistFile | null => {
      const pl = playlists.find((p) => p.id === playlistId) || playlists[0];
      if (!pl) return null;
      const trackMap = new Map(tracks.map((t) => [t.id, t]));
      const plTracks =
        pl.id === 'all'
          ? tracks
          : pl.trackIds
              .map((id) => trackMap.get(id))
              .filter((t): t is TrackItem => Boolean(t));

      const exportableTracks: TrackItem[] = plTracks.map((t) => ({
        ...t,
        fileUrl: undefined,
      }));

      return {
        format: 'deckforge.carlo',
        version: 1,
        exportedAt: new Date().toISOString(),
        playlist: {
          name: pl.name,
          preferredVibe: pl.preferredVibe,
          remixMode: pl.remixMode,
          aggressiveness: pl.aggressiveness,
          trackIds: exportableTracks.map((t) => t.id),
        },
        tracks: exportableTracks,
      };
    },
    [playlists, tracks]
  );

  const importCarloPlaylist = useCallback(
    (carlo: CarloPlaylistFile): { playlistId: string; playlistName: string; trackCount: number; playableCount: number } => {
      // Only import playable YouTube tracks or existing cached local tracks matching ID
      const existingMap = new Map(tracks.map((t) => [t.id, t]));
      const resolvedTracks: TrackItem[] = [];

      for (const incoming of carlo.tracks) {
        if (incoming.calibrated || incoming.dropCueSec !== undefined) {
          saveTrackCalibration(incoming, {
            bpm: incoming.bpm,
            musicalKey: incoming.musicalKey,
            firstBeatSec: incoming.firstBeatSec,
            dropCueSec: incoming.dropCueSec,
          });
        }
        const existing = existingMap.get(incoming.id);
        if (existing) {
          resolvedTracks.push(mergeTrackWithCalibration(existing));
        } else if (incoming.sourceType.startsWith('youtube')) {
          resolvedTracks.push(mergeTrackWithCalibration(incoming));
        }
      }

      const toInsert = resolvedTracks.filter((t) => !existingMap.has(t.id));
      if (toInsert.length > 0) {
        setTracks((prev) => [...toInsert, ...prev]);
      }

      const finalIds = resolvedTracks.map((t) => t.id);
      const newPlId = `pl-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;

      setPlaylists((prev) => {
        const youtubeAdditions = resolvedTracks
          .filter((t) => t.sourceType.startsWith('youtube'))
          .map((t) => t.id);

        const updated = prev.map((pl) => {
          if (pl.id === 'all') {
            const cur = new Set(pl.trackIds);
            return {
              ...pl,
              trackIds: [...pl.trackIds, ...finalIds.filter((id) => !cur.has(id))],
            };
          }
          if (pl.id === 'youtube-crate' && youtubeAdditions.length > 0) {
            const cur = new Set(pl.trackIds);
            return {
              ...pl,
              trackIds: [...pl.trackIds, ...youtubeAdditions.filter((id) => !cur.has(id))],
            };
          }
          return pl;
        });

        return [
          ...updated,
          {
            id: newPlId,
            name: carlo.playlist.name,
            trackIds: finalIds,
            preferredVibe: carlo.playlist.preferredVibe,
            remixMode: carlo.playlist.remixMode,
            aggressiveness: carlo.playlist.aggressiveness,
          },
        ];
      });

      setActivePlaylistId(newPlId);
      return {
        playlistId: newPlId,
        playlistName: carlo.playlist.name,
        trackCount: carlo.tracks.length,
        playableCount: finalIds.length,
      };
    },
    [tracks]
  );

  return {
    tracks,
    playlists,
    activePlaylistId,
    setActivePlaylistId,
    recordings,
    addTrack,
    addTracksBatch,
    updateTrackMeta,
    removeTrack,
    createPlaylist,
    updatePlaylist,
    deletePlaylist,
    addTrackToPlaylist,
    removeTrackFromPlaylist,
    exportPlaylistToCarlo,
    importCarloPlaylist,
    addRecording,
    removeRecording,
  };
}
