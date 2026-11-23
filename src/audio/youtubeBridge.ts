import { DeckId } from '../types/dj';

declare global {
  interface Window {
    YT?: any;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let apiLoadPromise: Promise<void> | null = null;

export function ensureYouTubeIframeApi(): Promise<void> {
  if (window.YT && window.YT.Player) {
    return Promise.resolve();
  }
  if (apiLoadPromise) return apiLoadPromise;

  apiLoadPromise = new Promise<void>((resolve, reject) => {
    let settled = false;
    const finishResolve = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const finishReject = (err: Error) => {
      if (settled) return;
      settled = true;
      apiLoadPromise = null;
      reject(err);
    };

    const prevCallback = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (prevCallback) prevCallback();
      finishResolve();
    };

    const existing = document.querySelector('script[src*="youtube.com/iframe_api"]');
    if (!existing) {
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      tag.async = true;
      tag.onerror = () => finishReject(new Error('Failed to load YouTube IFrame API'));
      document.head.appendChild(tag);
    }

    const poll = setInterval(() => {
      if (window.YT && window.YT.Player) {
        clearInterval(poll);
        finishResolve();
      }
    }, 150);

    setTimeout(() => {
      clearInterval(poll);
      if (window.YT && window.YT.Player) {
        finishResolve();
      } else {
        finishReject(new Error('YouTube IFrame API timed out'));
      }
    }, 8000);
  });

  return apiLoadPromise;
}

export class YouTubeDeckPlayer {
  private player: any = null;
  private ready = false;
  private containerId: string;
  private pendingVolume = 100;
  private pendingRate = 1;
  private pendingSeekSec: number | null = null;
  private desiredPlaying = false;
  private loadSeq = 0;
  private pendingCueDone: ((err?: Error) => void) | null = null;
  private playRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private onStateChangeCb?: (playing: boolean) => void;
  private onDurationCb?: (duration: number) => void;

  constructor(
    deckId: DeckId,
    onStateChange?: (playing: boolean) => void,
    onDuration?: (duration: number) => void
  ) {
    this.containerId = `yt-deck-player-${deckId}`;
    this.onStateChangeCb = onStateChange;
    this.onDurationCb = onDuration;
  }

  private clearPlayRetry() {
    if (this.playRetryTimer) {
      clearTimeout(this.playRetryTimer);
      this.playRetryTimer = null;
    }
  }

  private settlePendingCue(err?: Error) {
    const fn = this.pendingCueDone;
    this.pendingCueDone = null;
    if (fn) fn(err);
  }

  private applyPendingSeekAndPlay() {
    if (!this.ready || !this.player || !this.desiredPlaying) return;
    try {
      this.player.setVolume?.(this.pendingVolume);
      if (this.pendingSeekSec !== null) {
        const target = Math.max(0, this.pendingSeekSec);
        this.pendingSeekSec = null;
        this.player.seekTo?.(target, true);
      }
      this.player.playVideo?.();
    } catch {
      // ignore player transient errors
    }
  }

  async mountAndLoad(videoId: string): Promise<void> {
    const seq = ++this.loadSeq;
    this.desiredPlaying = false;
    this.pendingSeekSec = null;
    this.clearPlayRetry();
    this.settlePendingCue();

    await ensureYouTubeIframeApi();
    if (seq !== this.loadSeq) return;

    // Wait a single animation frame so React layout updates (e.g. w-32 h-16) flush to DOM
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    if (seq !== this.loadSeq) return;

    // Try reusing existing healthy YT.Player cleanly via cueVideoById + event-driven readiness
    if (this.player && this.ready) {
      try {
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const finish = (err?: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(cueTimeout);
            if (this.pendingCueDone === finish) {
              this.pendingCueDone = null;
            }
            if (err) reject(err);
            else resolve();
          };

          const cueTimeout = setTimeout(() => {
            // If player already has metadata / didn't error, allow playback attempt
            finish();
          }, 4500);

          this.pendingCueDone = finish;
          this.player.stopVideo?.();
          this.player.cueVideoById(videoId);
          this.player.setVolume?.(this.desiredPlaying ? this.pendingVolume : 0);
        });
        return;
      } catch (err) {
        // Destroy broken player only if video failed to cue; propagate embed/availability error
        this.destroy();
        throw err;
      }
    }

    // If an unready player instance existed, destroy cleanly before remounting
    if (this.player) {
      this.destroy();
    }

    const el = document.getElementById(this.containerId);
    if (!el) {
      throw new Error(`YouTube container #${this.containerId} is not mounted`);
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const done = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        if (this.pendingCueDone === done) {
          this.pendingCueDone = null;
        }
        if (err) reject(err);
        else resolve();
      };

      this.pendingCueDone = done;

      const timeoutId = setTimeout(() => {
        done(new Error('YouTube player initialization timed out'));
      }, 10000);

      this.player = new window.YT.Player(this.containerId, {
        videoId,
        width: '100%',
        height: '100%',
        playerVars: {
          autoplay: 0,
          controls: 0,
          disablekb: 1,
          enablejsapi: 1,
          fs: 0,
          modestbranding: 1,
          playsinline: 1,
          rel: 0,
          origin: window.location.origin,
        },
        events: {
          onReady: () => {
            this.ready = true;
            if (seq !== this.loadSeq) {
              try {
                this.player?.stopVideo?.();
              } catch {
                // ignore
              }
              done();
              return;
            }
            try {
              this.player.setVolume(this.desiredPlaying ? this.pendingVolume : 0);
              this.player.setPlaybackRate(this.pendingRate);
            } catch {
              // ignore unsupported rates
            }
            const dur = this.player.getDuration?.() || 0;
            if (dur > 0 && this.onDurationCb) this.onDurationCb(dur);

            if (this.desiredPlaying) {
              this.applyPendingSeekAndPlay();
            } else {
              try {
                this.player.pauseVideo?.();
              } catch {
                // ignore
              }
            }
            done();
          },
          onError: () => {
            this.desiredPlaying = false;
            this.clearPlayRetry();
            this.onStateChangeCb?.(false);
            this.settlePendingCue(
              new Error('YouTube video unavailable or blocked from embed playback')
            );
          },
          onStateChange: (ev: any) => {
            const state = ev?.data;
            // -1 = UNSTARTED, 0 = ENDED, 1 = PLAYING, 2 = PAUSED, 3 = BUFFERING, 5 = VIDEO CUED
            if (state === 5) {
              const dur = this.player?.getDuration?.() || 0;
              if (dur > 0 && this.onDurationCb) this.onDurationCb(dur);
              this.settlePendingCue();
              if (this.desiredPlaying) {
                this.applyPendingSeekAndPlay();
              }
            } else if (state === -1) {
              if (this.desiredPlaying) {
                this.applyPendingSeekAndPlay();
              }
            } else if (state === 1) {
              this.settlePendingCue();
              this.clearPlayRetry();
              if (!this.desiredPlaying) {
                try {
                  this.player?.pauseVideo?.();
                } catch {
                  // ignore
                }
                this.onStateChangeCb?.(false);
                return;
              }
              try {
                this.player?.setVolume?.(this.pendingVolume);
                if (this.pendingSeekSec !== null) {
                  const target = Math.max(0, this.pendingSeekSec);
                  this.pendingSeekSec = null;
                  this.player?.seekTo?.(target, true);
                }
              } catch {
                // ignore
              }
              const dur = this.player?.getDuration?.() || 0;
              if (dur > 0 && this.onDurationCb) this.onDurationCb(dur);
              this.onStateChangeCb?.(true);
            } else if (state === 2) {
              this.settlePendingCue();
              if (!this.desiredPlaying) {
                this.onStateChangeCb?.(false);
              }
            } else if (state === 0) {
              this.settlePendingCue();
              this.desiredPlaying = false;
              this.clearPlayRetry();
              this.onStateChangeCb?.(false);
            }
          },
        },
      });
    });
  }

  play() {
    this.desiredPlaying = true;
    this.clearPlayRetry();
    this.applyPendingSeekAndPlay();

    // Retry once shortly after if YouTube player was still settling from cueVideoById
    this.playRetryTimer = setTimeout(() => {
      this.playRetryTimer = null;
      if (!this.desiredPlaying || !this.ready || !this.player) return;
      try {
        const st = this.player.getPlayerState?.();
        if (st !== 1 && st !== 3) {
          this.applyPendingSeekAndPlay();
        }
      } catch {
        // ignore
      }
    }, 350);
  }

  pause() {
    this.desiredPlaying = false;
    this.clearPlayRetry();
    if (this.ready && this.player?.pauseVideo) {
      try {
        this.player.pauseVideo();
      } catch {
        // ignore
      }
    }
  }

  stop() {
    this.loadSeq++;
    this.desiredPlaying = false;
    this.pendingSeekSec = null;
    this.clearPlayRetry();
    this.settlePendingCue();
    if (this.ready && this.player) {
      try {
        this.player.setVolume?.(0);
        this.player.pauseVideo?.();
        this.player.stopVideo?.();
      } catch {
        // ignore
      }
    }
  }

  seekTo(seconds: number) {
    const clamped = Math.max(0, seconds);
    this.pendingSeekSec = clamped;
    if (this.ready && this.player?.seekTo) {
      try {
        this.player.seekTo(clamped, true);
        if (this.player.getPlayerState?.() === 1) {
          this.pendingSeekSec = null;
        }
      } catch {
        // ignore
      }
    }
  }

  setVolume(vol0to100: number) {
    const clamped = Math.max(0, Math.min(100, Math.round(vol0to100)));
    this.pendingVolume = clamped;
    if (this.ready && this.player?.setVolume) {
      try {
        this.player.setVolume(this.desiredPlaying ? clamped : 0);
      } catch {
        // ignore
      }
    }
  }

  setPlaybackRate(rate: number) {
    const clamped = Math.max(0.5, Math.min(2, rate));
    this.pendingRate = clamped;
    if (this.ready && this.player?.setPlaybackRate) {
      try {
        const available: number[] =
          this.player.getAvailablePlaybackRates?.() || [0.5, 0.75, 1, 1.25, 1.5, 2];
        let closest = available[0] ?? 1;
        let minDiff = Infinity;
        for (const r of available) {
          const d = Math.abs(r - clamped);
          if (d < minDiff) {
            minDiff = d;
            closest = r;
          }
        }
        this.player.setPlaybackRate(closest);
      } catch {
        // ignore
      }
    }
  }

  getCurrentTime(): number {
    if (this.ready && this.player?.getCurrentTime) {
      try {
        return Number(this.player.getCurrentTime()) || 0;
      } catch {
        return 0;
      }
    }
    return 0;
  }

  getDuration(): number {
    if (this.ready && this.player?.getDuration) {
      try {
        return Number(this.player.getDuration()) || 0;
      } catch {
        return 0;
      }
    }
    return 0;
  }

  destroy() {
    this.desiredPlaying = false;
    this.pendingSeekSec = null;
    this.clearPlayRetry();
    this.settlePendingCue();
    if (this.player?.destroy) {
      try {
        this.player.destroy();
      } catch {
        // ignore
      }
    }
    this.player = null;
    this.ready = false;
  }
}
