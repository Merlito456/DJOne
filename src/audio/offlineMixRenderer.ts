import {
  AiDjVibe,
  AiFeatureToggles,
  AnyVoiceDropId,
  CustomVoiceDropMeta,
  CustomVoiceSlotId,
  DjVoiceDropId,
  FxType,
  GrooveBridgePattern,
  MashupTemplateId,
  MasteringProfile,
  OfflineExportFormat,
  OfflineRenderMode,
  OfflineRenderVariant,
  PlaylistMixPacing,
  StemIsolationMode,
  StemSwapMode,
  TrackItem,
  VoiceFrequencyMode,
} from '../types/dj';
import { isCustomVoiceDropId, VOICE_PRESET_MAP } from './djVoices';
import { runHpssSeparation } from './hpssWorker';
import {
  analyzeVocalProfile,
  computeOfflineMashupBlend,
  DEFAULT_AI_FEATURE_TOGGLES,
  optimizePlaylistSetlist,
  planOfflineTransition,
  resolveSemitoneSnap,
} from './offlineAiDj';
import { estimateTrackLoudnessGain, timeStretchAudioBuffer } from './waveformAnalyzer';
import {
  createSynthNoiseBuffer,
  createSynthReverbImpulse,
  scheduleBuildUpSequenceSynth,
  scheduleCustomVoiceBufferSynth,
  scheduleGrooveBridgeStepSynth,
  scheduleReharmonizerWindowSynth,
  scheduleSoundTrickSynth,
  scheduleVoiceDropSynth,
} from './webAudioSynths';

export interface OfflineRenderDeckInput {
  track: TrackItem;
  buffer: AudioBuffer;
  harmonicBuffer?: AudioBuffer | null;
  percussiveBuffer?: AudioBuffer | null;
  bassBuffer?: AudioBuffer | null;
}

export interface OfflineRemixRenderResult {
  blob: Blob;
  durationSec: number;
  title: string;
  format: OfflineExportFormat;
  cueSheetText: string;
  tracklistCount: number;
  packRole: OfflineRenderVariant;
  stemmedA?: OfflineRenderDeckInput;
  stemmedB?: OfflineRenderDeckInput;
}

interface CueSheetEntry {
  atSec: number;
  label: string;
  bpm: number;
  key: string;
  note?: string;
}

function formatChapterTimestamp(sec: number): string {
  const total = Math.max(0, Math.floor(sec));
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hrs > 0) {
    return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function buildCueSheetText(mixTitle: string, entries: CueSheetEntry[]): string {
  const lines: string[] = [
    `# ${mixTitle}`,
    `# Exported by DJOne Offline AI Mixer`,
    '',
    '=== CHAPTER TIMESTAMPS (YouTube / Mixcloud) ===',
  ];
  for (const e of entries) {
    const notePart = e.note ? ` · ${e.note}` : '';
    lines.push(
      `${formatChapterTimestamp(e.atSec)} ${e.label} [${e.bpm.toFixed(1)} BPM · ${e.key}${notePart}]`
    );
  }
  lines.push('');
  lines.push('=== CUE SHEET ===');
  lines.push(`TITLE "${mixTitle.replace(/"/g, "'")}"`);
  entries.forEach((e, idx) => {
    const mm = Math.floor(Math.max(0, e.atSec) / 60);
    const ss = Math.floor(Math.max(0, e.atSec) % 60);
    const ff = Math.floor((Math.max(0, e.atSec) % 1) * 75);
    const cueClock = `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}:${String(ff).padStart(2, '0')}`;
    lines.push(`  TRACK ${String(idx + 1).padStart(2, '0')} AUDIO`);
    lines.push(`    TITLE "${e.label.replace(/"/g, "'")}"`);
    lines.push(`    INDEX 01 ${cueClock}`);
  });
  return lines.join('\n');
}

function normalizeAudioBufferPeak(audioBuffer: AudioBuffer): {
  ch0: Float32Array;
  ch1: Float32Array;
  numChannels: number;
  normGain: number;
} {
  const numChannels = Math.min(2, audioBuffer.numberOfChannels);
  const length = audioBuffer.length;
  const ch0 = audioBuffer.getChannelData(0);
  const ch1 = numChannels > 1 ? audioBuffer.getChannelData(1) : ch0;

  let maxPeak = 0;
  for (let i = 0; i < length; i++) {
    const p0 = Math.abs(ch0[i]);
    const p1 = Math.abs(ch1[i]);
    if (p0 > maxPeak) maxPeak = p0;
    if (p1 > maxPeak) maxPeak = p1;
  }
  const normGain = maxPeak > 0.001 ? Math.min(1.4, 0.912 / maxPeak) : 1;
  return { ch0, ch1, numChannels, normGain };
}

export function encodeAudioBufferToWav(audioBuffer: AudioBuffer): Blob {
  const sampleRate = audioBuffer.sampleRate;
  const length = audioBuffer.length;
  const { ch0, ch1, numChannels, normGain } = normalizeAudioBufferPeak(audioBuffer);
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = length * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) {
      view.setUint8(offset + i, s.charCodeAt(i));
    }
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < length; i++) {
    const s0 = Math.max(-1, Math.min(1, ch0[i] * normGain));
    const s1 = Math.max(-1, Math.min(1, ch1[i] * normGain));
    view.setInt16(offset, s0 < 0 ? s0 * 0x8000 : s0 * 0x7fff, true);
    offset += 2;
    if (numChannels > 1) {
      view.setInt16(offset, s1 < 0 ? s1 * 0x8000 : s1 * 0x7fff, true);
      offset += 2;
    }
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

// Standard Ogg non-reflected CRC32 table (polynomial 0x04c11db7)
const OGG_CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) {
      r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    }
    t[i] = r >>> 0;
  }
  return t;
})();

function computeOggCrc32(bytes: Uint8Array): number {
  let crc = 0;
  for (let i = 0; i < bytes.length; i++) {
    crc = ((crc << 8) ^ OGG_CRC_TABLE[((crc >>> 24) ^ bytes[i]) & 0xff]) >>> 0;
  }
  return crc >>> 0;
}

function createOggPage(params: {
  headerType: number;
  granulePos: bigint;
  serial: number;
  pageSeq: number;
  packets: Uint8Array[];
}): Uint8Array {
  const { headerType, granulePos, serial, pageSeq, packets } = params;
  const lacingValues: number[] = [];
  let payloadLen = 0;
  for (const pkt of packets) {
    payloadLen += pkt.length;
    let rem = pkt.length;
    while (rem >= 255) {
      lacingValues.push(255);
      rem -= 255;
    }
    lacingValues.push(rem);
  }
  const headerLen = 27 + lacingValues.length;
  const page = new Uint8Array(headerLen + payloadLen);
  const view = new DataView(page.buffer);

  // 'OggS'
  page[0] = 0x4f;
  page[1] = 0x67;
  page[2] = 0x67;
  page[3] = 0x53;
  page[4] = 0; // version
  page[5] = headerType;
  view.setBigUint64(6, granulePos, true);
  view.setUint32(14, serial >>> 0, true);
  view.setUint32(18, pageSeq >>> 0, true);
  view.setUint32(22, 0, true); // CRC placeholder
  page[26] = lacingValues.length;
  for (let i = 0; i < lacingValues.length; i++) {
    page[27 + i] = lacingValues[i];
  }
  let off = headerLen;
  for (const pkt of packets) {
    page.set(pkt, off);
    off += pkt.length;
  }
  const crc = computeOggCrc32(page);
  view.setUint32(22, crc, true);
  return page;
}

/**
 * Enhancement #5: Offline Mastering Chain & Sub-Bass Mono Tightening (<115Hz mono, M/S width, saturation, brickwall limiter)
 */
function applyMasteringPostProcess(
  audioBuffer: AudioBuffer,
  profile: MasteringProfile = 'club-punch'
): void {
  const numCh = Math.min(2, audioBuffer.numberOfChannels);
  const len = audioBuffer.length;
  const sr = audioBuffer.sampleRate;
  const ch0 = audioBuffer.getChannelData(0);
  const ch1 = numCh > 1 ? audioBuffer.getChannelData(1) : ch0;

  if (profile === 'clean') {
    let peak = 0;
    for (let i = 0; i < len; i++) {
      const p0 = Math.abs(ch0[i]);
      const p1 = Math.abs(ch1[i]);
      if (p0 > peak) peak = p0;
      if (p1 > peak) peak = p1;
    }
    const g = peak > 0.001 ? Math.min(1.35, 0.944 / peak) : 1;
    for (let i = 0; i < len; i++) {
      ch0[i] = Math.max(-0.95, Math.min(0.95, ch0[i] * g));
      if (numCh > 1) ch1[i] = Math.max(-0.95, Math.min(0.95, ch1[i] * g));
    }
    return;
  }

  // Crossover ~115Hz for phase-tight mono sub bass
  const alphaSub = 1 - Math.exp((-2 * Math.PI * 115) / sr);
  // Subtle HF smoothing (~11.5kHz) for vinyl-warmth profile
  const alphaWarm = 1 - Math.exp((-2 * Math.PI * 11500) / sr);

  const stereoWidth = profile === 'club-punch' ? 1.16 : profile === 'festival-loud' ? 1.2 : 1.05;
  const subBoost = profile === 'festival-loud' ? 1.18 : profile === 'vinyl-warmth' ? 1.1 : 1.06;
  const drive = profile === 'festival-loud' ? 1.32 : profile === 'vinyl-warmth' ? 1.18 : 1.14;
  const ceiling = profile === 'festival-loud' ? 0.975 : profile === 'vinyl-warmth' ? 0.93 : 0.96;

  let lpL = 0;
  let lpR = 0;
  let warmL = 0;
  let warmR = 0;

  // RMS check to scale drive nicely across quiet/loud bounces
  let sumSq = 0;
  const step = Math.max(1, Math.floor(len / 80000));
  let count = 0;
  for (let i = 0; i < len; i += step) {
    sumSq += (ch0[i] * ch0[i] + ch1[i] * ch1[i]) * 0.5;
    count++;
  }
  const rms = Math.sqrt(sumSq / Math.max(1, count));
  const targetRms = profile === 'festival-loud' ? 0.27 : profile === 'club-punch' ? 0.22 : 0.19;
  const rmsTrim = rms > 0.01 ? Math.max(0.72, Math.min(1.55, targetRms / rms)) : 1.0;

  for (let i = 0; i < len; i++) {
    const xL = ch0[i] * rmsTrim;
    const xR = ch1[i] * rmsTrim;

    lpL = lpL + alphaSub * (xL - lpL);
    lpR = lpR + alphaSub * (xR - lpR);

    // Mono-summed < 115Hz low end for clean PA sub impact
    const lowMono = (lpL + lpR) * 0.5 * subBoost;
    const hiL = xL - lpL;
    const hiR = xR - lpR;

    const midHi = (hiL + hiR) * 0.5;
    const sideHi = (hiL - hiR) * 0.5 * stereoWidth;

    let outL = lowMono + midHi + sideHi;
    let outR = lowMono + midHi - sideHi;

    if (profile === 'vinyl-warmth') {
      // Gentle asymmetric tube/tape harmonic curve + smooth air roll-off
      outL = Math.tanh(outL * drive + 0.012 * outL * outL) / Math.tanh(drive);
      outR = Math.tanh(outR * drive + 0.012 * outR * outR) / Math.tanh(drive);
      warmL = warmL + alphaWarm * (outL - warmL);
      warmR = warmR + alphaWarm * (outR - warmR);
      outL = warmL;
      outR = warmR;
    } else {
      // Warm soft-clip brickwall limiter
      outL = Math.tanh(outL * drive) / Math.tanh(drive);
      outR = Math.tanh(outR * drive) / Math.tanh(drive);
    }

    ch0[i] = Math.max(-ceiling, Math.min(ceiling, outL * ceiling));
    if (numCh > 1) {
      ch1[i] = Math.max(-ceiling, Math.min(ceiling, outR * ceiling));
    }
  }
}

async function encodeAudioBufferToOggOrCompactWav(
  audioBuffer: AudioBuffer,
  desiredFormat: OfflineExportFormat,
  masteringProfile: MasteringProfile = 'club-punch'
): Promise<{ blob: Blob; format: OfflineExportFormat }> {
  applyMasteringPostProcess(audioBuffer, masteringProfile);
  if (desiredFormat === 'wav') {
    return { blob: encodeAudioBufferToWav(audioBuffer), format: 'wav' };
  }

  // Try faster-than-real-time WebCodecs Opus -> Ogg/Opus container (~10x smaller)
  if (typeof AudioEncoder !== 'undefined' && typeof AudioData !== 'undefined') {
    try {
      const config: AudioEncoderConfig = {
        codec: 'opus',
        sampleRate: 48000,
        numberOfChannels: 2,
        bitrate: 128000,
      };
      const support = await AudioEncoder.isConfigSupported(config);
      if (support.supported) {
        let src48 = audioBuffer;
        if (audioBuffer.sampleRate !== 48000) {
          const rsCtx = new OfflineAudioContext(
            2,
            Math.max(960, Math.ceil(audioBuffer.duration * 48000)),
            48000
          );
          const bs = rsCtx.createBufferSource();
          bs.buffer = audioBuffer;
          bs.connect(rsCtx.destination);
          bs.start(0);
          src48 = await rsCtx.startRendering();
        }

        const { ch0, ch1, normGain } = normalizeAudioBufferPeak(src48);
        const totalFrames = src48.length;

        const chunks: { data: Uint8Array; durationUs: number }[] = [];
        const opusHolder: { desc: Uint8Array | null } = { desc: null };
        let encodeErr: Error | null = null;

        const encoder = new AudioEncoder({
          output: (chunk, meta) => {
            const bytes = new Uint8Array(chunk.byteLength);
            chunk.copyTo(bytes);
            chunks.push({ data: bytes, durationUs: chunk.duration ?? 20000 });
            if (!opusHolder.desc && meta?.decoderConfig?.description) {
              const desc = meta.decoderConfig.description;
              if (ArrayBuffer.isView(desc)) {
                const view = new Uint8Array(desc.buffer, desc.byteOffset, desc.byteLength);
                opusHolder.desc = new Uint8Array(view);
              } else {
                opusHolder.desc = new Uint8Array(new Uint8Array(desc));
              }
            }
          },
          error: (err) => {
            encodeErr = err instanceof Error ? err : new Error(String(err));
          },
        });
        encoder.configure(config);

        const blockFrames = 48000; // 1s planar blocks
        for (let off = 0; off < totalFrames; off += blockFrames) {
          const count = Math.min(blockFrames, totalFrames - off);
          const planar = new Float32Array(count * 2);
          for (let i = 0; i < count; i++) {
            planar[i] = Math.max(-1, Math.min(1, ch0[off + i] * normGain));
            planar[count + i] = Math.max(-1, Math.min(1, ch1[off + i] * normGain));
          }
          const audioData = new AudioData({
            format: 'f32-planar',
            sampleRate: 48000,
            numberOfChannels: 2,
            numberOfFrames: count,
            timestamp: Math.round((off / 48000) * 1_000_000),
            data: planar,
          });
          encoder.encode(audioData);
          audioData.close();
          if (off % (48000 * 10) === 0) {
            await new Promise((r) => setTimeout(r, 0));
          }
        }
        await encoder.flush();
        encoder.close();

        if (!encodeErr && chunks.length > 0) {
          const serial = 0x44464f47; // 'DFOG'
          const pages: Uint8Array[] = [];
          let pageSeq = 0;

          // Page 0: OpusHead
          let headBytes: Uint8Array;
          if (opusHolder.desc && opusHolder.desc.length >= 19) {
            headBytes = opusHolder.desc;
          } else {
            headBytes = new Uint8Array(19);
            const hv = new DataView(headBytes.buffer);
            // "OpusHead"
            [0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64].forEach((b, idx) => {
              headBytes[idx] = b;
            });
            headBytes[8] = 1; // version
            headBytes[9] = 2; // channels
            hv.setUint16(10, 312, true); // pre-skip
            hv.setUint32(12, 48000, true); // input rate
            hv.setInt16(16, 0, true); // output gain
            headBytes[18] = 0; // channel mapping family
          }
          pages.push(
            createOggPage({
              headerType: 0x02,
              granulePos: 0n,
              serial,
              pageSeq: pageSeq++,
              packets: [headBytes],
            })
          );

          // Page 1: OpusTags
          const vendor = new TextEncoder().encode('DJOne');
          const tags = new Uint8Array(8 + 4 + vendor.length + 4);
          const tv = new DataView(tags.buffer);
          [0x4f, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73].forEach((b, idx) => {
            tags[idx] = b;
          });
          tv.setUint32(8, vendor.length, true);
          tags.set(vendor, 12);
          tv.setUint32(12 + vendor.length, 0, true);
          pages.push(
            createOggPage({
              headerType: 0x00,
              granulePos: 0n,
              serial,
              pageSeq: pageSeq++,
              packets: [tags],
            })
          );

          // Pack audio packets (~20 frames per page so page segments stays well <= 255)
          let granule = 0n;
          const batchLimit = 20;
          for (let idx = 0; idx < chunks.length; idx += batchLimit) {
            const slice = chunks.slice(idx, idx + batchLimit);
            for (const ch of slice) {
              const samples = BigInt(Math.max(1, Math.round((ch.durationUs / 1_000_000) * 48000)));
              granule += samples;
            }
            const isLast = idx + batchLimit >= chunks.length;
            pages.push(
              createOggPage({
                headerType: isLast ? 0x04 : 0x00,
                granulePos: granule,
                serial,
                pageSeq: pageSeq++,
                packets: slice.map((c) => c.data),
              })
            );
          }

          const totalLen = pages.reduce((acc, p) => acc + p.length, 0);
          const merged = new Uint8Array(totalLen);
          let cursor = 0;
          for (const p of pages) {
            merged.set(p, cursor);
            cursor += p.length;
          }
          return { blob: new Blob([merged], { type: 'audio/ogg; codecs=opus' }), format: 'ogg' };
        }
      }
    } catch {
      // Fallback below to compact 22.05kHz WAV
    }
  }

  // Fallback: compact 22.05kHz 16-bit WAV (~50% smaller than 44.1kHz)
  const compactSr = 22050;
  const dsCtx = new OfflineAudioContext(
    Math.min(2, audioBuffer.numberOfChannels),
    Math.max(2048, Math.ceil(audioBuffer.duration * compactSr)),
    compactSr
  );
  const src = dsCtx.createBufferSource();
  src.buffer = audioBuffer;
  src.connect(dsCtx.destination);
  src.start(0);
  const dsBuf = await dsCtx.startRendering();
  return { blob: encodeAudioBufferToWav(dsBuf), format: 'wav' };
}

interface OfflineDeckNodes {
  lowFilter: BiquadFilterNode;
  midFilter: BiquadFilterNode;
  vocalSidechainFilter: BiquadFilterNode;
  highFilter: BiquadFilterNode;
  sweeperFilter: BiquadFilterNode;
  gain: GainNode;
  fullGain: GainNode;
  harmGain: GainNode;
  percGain: GainNode;
  bassGain: GainNode;
  dryBus: GainNode;
  fxWetGain: GainNode;
  fxDelay: DelayNode;
  fxFeedback: GainNode;
  fxReverbWet: GainNode;
  fxLp: BiquadFilterNode;
}

function createOfflineDeckChain(
  ctx: OfflineAudioContext,
  dest: AudioNode,
  reverbImpulse: AudioBuffer,
  trimGain = 0.92
): OfflineDeckNodes {
  const fullGain = ctx.createGain();
  const harmGain = ctx.createGain();
  const percGain = ctx.createGain();
  const bassGain = ctx.createGain();

  const lowFilter = ctx.createBiquadFilter();
  lowFilter.type = 'lowshelf';
  lowFilter.frequency.value = 250;

  const midFilter = ctx.createBiquadFilter();
  midFilter.type = 'peaking';
  midFilter.frequency.value = 1050;
  midFilter.Q.value = 0.85;

  // Automatic Spectral Sidechain Filter (carves 1-3kHz presence pocket cleanly)
  const vocalSidechainFilter = ctx.createBiquadFilter();
  vocalSidechainFilter.type = 'peaking';
  vocalSidechainFilter.frequency.value = 1750;
  vocalSidechainFilter.Q.value = 0.85;
  vocalSidechainFilter.gain.value = 0;

  const highFilter = ctx.createBiquadFilter();
  highFilter.type = 'highshelf';
  highFilter.frequency.value = 3400;

  const sweeperFilter = ctx.createBiquadFilter();
  sweeperFilter.type = 'allpass';
  sweeperFilter.frequency.value = 1000;

  const gain = ctx.createGain();
  gain.gain.value = Math.max(0.25, Math.min(1.25, trimGain));

  const dryBus = ctx.createGain();
  dryBus.gain.value = 1;

  // Deck-level stereo FX send/return (echo, dubdelay, flanger/chorus comb, reverb, lofi)
  const fxWetGain = ctx.createGain();
  fxWetGain.gain.value = 0;

  const fxLp = ctx.createBiquadFilter();
  fxLp.type = 'lowpass';
  fxLp.frequency.value = 3400;

  const fxDelay = ctx.createDelay(2.0);
  fxDelay.delayTime.value = 0.25;
  const fxFeedback = ctx.createGain();
  fxFeedback.gain.value = 0.35;

  const fxConv = ctx.createConvolver();
  fxConv.buffer = reverbImpulse;
  const fxReverbWet = ctx.createGain();
  fxReverbWet.gain.value = 0;

  fullGain.connect(lowFilter);
  harmGain.connect(lowFilter);
  percGain.connect(lowFilter);
  bassGain.connect(lowFilter);

  lowFilter.connect(midFilter);
  midFilter.connect(vocalSidechainFilter);
  vocalSidechainFilter.connect(highFilter);
  highFilter.connect(sweeperFilter);
  sweeperFilter.connect(gain);

  gain.connect(dryBus);
  dryBus.connect(dest);

  gain.connect(fxWetGain);
  fxWetGain.connect(fxLp);
  fxLp.connect(fxDelay);
  fxDelay.connect(fxFeedback);
  fxFeedback.connect(fxLp);
  fxDelay.connect(dest);

  fxWetGain.connect(fxConv);
  fxConv.connect(fxReverbWet);
  fxReverbWet.connect(dest);

  return {
    lowFilter,
    midFilter,
    vocalSidechainFilter,
    highFilter,
    sweeperFilter,
    gain,
    fullGain,
    harmGain,
    percGain,
    bassGain,
    dryBus,
    fxWetGain,
    fxDelay,
    fxFeedback,
    fxReverbWet,
    fxLp,
  };
}

function scheduleOfflineFxAutomation(
  chain: OfflineDeckNodes,
  atTime: number,
  beatSec: number,
  fx?: { enabled?: boolean; type?: FxType; wet?: number; beatDiv?: number }
) {
  if (!fx || !fx.enabled || (fx.wet ?? 0) <= 0.02) {
    chain.fxWetGain.gain.setTargetAtTime(0, atTime, 0.03);
    chain.fxReverbWet.gain.setTargetAtTime(0, atTime, 0.03);
    chain.fxFeedback.gain.setTargetAtTime(0.15, atTime, 0.03);
    chain.dryBus.gain.setTargetAtTime(1, atTime, 0.03);
    return;
  }

  const type = fx.type || 'echo';
  const wet = Math.max(0, Math.min(0.85, fx.wet ?? 0.32));
  const beatDiv = Math.max(0.125, Math.min(2, fx.beatDiv ?? 0.5));

  if (type === 'reverb' || type === 'shimmer') {
    chain.fxWetGain.gain.setTargetAtTime(wet * 0.75, atTime, 0.04);
    chain.fxReverbWet.gain.setTargetAtTime(type === 'shimmer' ? 0.9 : 0.85, atTime, 0.04);
    chain.fxFeedback.gain.setTargetAtTime(0.12, atTime, 0.04);
    chain.fxLp.frequency.setTargetAtTime(type === 'shimmer' ? 7600 : 3800, atTime, 0.04);
  } else if (type === 'dubdelay' || type === 'echo') {
    const dt = Math.max(0.06, Math.min(1.8, beatSec * beatDiv * (type === 'dubdelay' ? 0.75 : 1)));
    chain.fxDelay.delayTime.setTargetAtTime(dt, atTime, 0.03);
    chain.fxFeedback.gain.setTargetAtTime(type === 'dubdelay' ? 0.54 : 0.42, atTime, 0.03);
    chain.fxLp.frequency.setTargetAtTime(type === 'dubdelay' ? 2200 : 3400, atTime, 0.03);
    chain.fxWetGain.gain.setTargetAtTime(wet * 0.85, atTime, 0.03);
    chain.fxReverbWet.gain.setTargetAtTime(0.16, atTime, 0.03);
  } else if (type === 'flanger' || type === 'chorus' || type === 'phaser' || type === 'comb') {
    chain.fxDelay.delayTime.setTargetAtTime(type === 'chorus' ? 0.022 : 0.009, atTime, 0.02);
    chain.fxFeedback.gain.setTargetAtTime(type === 'comb' ? 0.65 : 0.48, atTime, 0.03);
    chain.fxLp.frequency.setTargetAtTime(4800, atTime, 0.03);
    chain.fxWetGain.gain.setTargetAtTime(wet * 0.65, atTime, 0.03);
    chain.fxReverbWet.gain.setTargetAtTime(0.1, atTime, 0.03);
  } else {
    chain.fxDelay.delayTime.setTargetAtTime(Math.max(0.06, beatSec * 0.25), atTime, 0.02);
    chain.fxFeedback.gain.setTargetAtTime(0.32, atTime, 0.02);
    chain.fxLp.frequency.setTargetAtTime(type === 'lofi' ? 1600 : 3600, atTime, 0.03);
    chain.fxWetGain.gain.setTargetAtTime(wet * 0.55, atTime, 0.03);
    chain.fxReverbWet.gain.setTargetAtTime(0.08, atTime, 0.03);
  }
  chain.dryBus.gain.setTargetAtTime(Math.max(0.55, 1 - wet * 0.35), atTime, 0.03);
}

function prepareWindowBuffer(params: {
  ctx: OfflineAudioContext;
  source: AudioBuffer;
  cueSec: number;
  neededOutputSec: number;
  tempoRatio: number;
  semitoneShift: number;
  preservePitch: boolean;
}): {
  buffer: AudioBuffer;
  offsetSec: number;
  playbackRate: number;
} {
  const { ctx, source, cueSec, neededOutputSec, tempoRatio, semitoneShift, preservePitch } = params;
  const safeTempo = Math.max(0.58, Math.min(1.65, tempoRatio || 1));
  const safeSemi = Math.max(-5, Math.min(5, semitoneShift || 0));
  const pitchMult = Math.pow(2, safeSemi / 12);

  if (!preservePitch) {
    return {
      buffer: source,
      offsetSec: Math.max(0, Math.min(Math.max(0, source.duration - 2), cueSec)),
      playbackRate: Math.max(0.65, Math.min(1.5, safeTempo * pitchMult)),
    };
  }

  const needsStretch = Math.abs(safeTempo - 1) >= 0.008 || safeSemi !== 0;
  if (!needsStretch) {
    return {
      buffer: source,
      offsetSec: Math.max(0, Math.min(Math.max(0, source.duration - 2), cueSec)),
      playbackRate: 1.0,
    };
  }

  const sr = source.sampleRate;
  const numCh = Math.min(2, source.numberOfChannels);
  const neededInSec = Math.min(source.duration, Math.max(12, neededOutputSec * safeTempo + 4));
  const sliceLen = Math.max(Math.floor(sr * 8), Math.floor(neededInSec * sr));
  const sliceBuf = ctx.createBuffer(numCh, sliceLen, sr);

  const safeStartSample = Math.max(
    0,
    Math.min(Math.max(0, source.length - 256), Math.floor(cueSec * sr))
  );

  for (let ch = 0; ch < numCh; ch++) {
    const src = source.getChannelData(ch);
    const dst = sliceBuf.getChannelData(ch);
    for (let i = 0; i < sliceLen; i++) {
      dst[i] = src[(safeStartSample + i) % source.length];
    }
  }

  const stretched = timeStretchAudioBuffer(ctx, sliceBuf, safeTempo, safeSemi);
  return {
    buffer: stretched,
    offsetSec: 0,
    playbackRate: 1.0,
  };
}

interface TempoRampSegment {
  startSec: number;
  durationSec: number;
  startRate: number;
  endRate: number;
}

function createCosineTempoCurve(
  startRate: number,
  endRate: number,
  points = 32
): Float32Array<ArrayBuffer> {
  const buf = new ArrayBuffer(points * 4);
  const arr = new Float32Array(buf);
  const s = Math.max(0.55, Math.min(1.65, startRate));
  const e = Math.max(0.55, Math.min(1.65, endRate));
  for (let i = 0; i < points; i++) {
    const u = i / Math.max(1, points - 1);
    const ease = 0.5 * (1 - Math.cos(Math.PI * u));
    arr[i] = s + (e - s) * ease;
  }
  return arr;
}

function scheduleStemSource(
  ctx: OfflineAudioContext,
  buf: AudioBuffer,
  targetNode: AudioNode,
  startAtCtxTime: number,
  offsetSec: number,
  playDurationSec: number,
  playbackRate: number,
  tempoRamps?: TempoRampSegment[]
) {
  const safeOffset = Math.max(0, Math.min(Math.max(0, buf.duration - 0.5), offsetSec));
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const clampedBase = Math.max(0.58, Math.min(1.65, playbackRate));
  src.playbackRate.value = clampedBase;

  if (tempoRamps && tempoRamps.length > 0) {
    let cursor = Math.max(0, startAtCtxTime);
    src.playbackRate.setValueAtTime(clampedBase, cursor);
    for (const ramp of tempoRamps) {
      if (ramp.durationSec <= 0.04) continue;
      const rStart = Math.max(cursor + 0.001, ramp.startSec);
      const rDur = Math.max(0.04, ramp.durationSec - 0.002);
      const curve = createCosineTempoCurve(ramp.startRate, ramp.endRate, 32);
      src.playbackRate.setValueAtTime(curve[0], Math.max(0, rStart - 0.0005));
      src.playbackRate.setValueCurveAtTime(curve, rStart, rDur);
      src.playbackRate.setValueAtTime(curve[curve.length - 1], rStart + rDur + 0.001);
      cursor = rStart + rDur + 0.002;
    }
  }

  src.loop = true;
  src.loopStart = 0;
  src.loopEnd = Math.max(2, buf.duration - 0.06);
  src.connect(targetNode);
  src.start(startAtCtxTime, safeOffset);
  src.stop(startAtCtxTime + playDurationSec + 0.08);
}

function scheduleVoiceDuck(
  voiceDuckGain: GainNode,
  voiceDuckFilter: BiquadFilterNode,
  atTime: number,
  durSec: number
) {
  const dur = Math.max(0.4, Math.min(3.5, durSec));
  voiceDuckGain.gain.setTargetAtTime(0.68, atTime, 0.015);
  voiceDuckFilter.gain.setTargetAtTime(-4.8, atTime, 0.015);
  voiceDuckGain.gain.setTargetAtTime(1.0, atTime + dur, 0.09);
  voiceDuckFilter.gain.setTargetAtTime(0, atTime + dur, 0.09);
}

function scheduleAnyVoiceOffline(params: {
  ctx: OfflineAudioContext;
  voiceDest: AudioNode;
  voiceDuckGain: GainNode;
  voiceDuckFilter: BiquadFilterNode;
  noiseBuf: AudioBuffer;
  reverbImpulse: AudioBuffer;
  voiceId: AnyVoiceDropId;
  customVoiceBuffers?: Partial<Record<CustomVoiceSlotId, AudioBuffer>>;
  atTime: number;
  bpm: number;
  musicalKey: string;
  volumeScale: number;
}) {
  const {
    ctx,
    voiceDest,
    voiceDuckGain,
    voiceDuckFilter,
    noiseBuf,
    reverbImpulse,
    voiceId,
    customVoiceBuffers,
    atTime,
    bpm,
    musicalKey,
    volumeScale,
  } = params;
  if (volumeScale <= 0.01) return;

  if (isCustomVoiceDropId(voiceId)) {
    const buf = customVoiceBuffers?.[voiceId];
    if (!buf) return;
    scheduleCustomVoiceBufferSynth({
      ctx,
      dest: voiceDest,
      reverbImpulse,
      buffer: buf,
      atTime,
      bpm,
      volumeScale,
      onDuckWindow: (d) => scheduleVoiceDuck(voiceDuckGain, voiceDuckFilter, atTime, d),
    });
    return;
  }

  scheduleVoiceDropSynth({
    ctx,
    dest: voiceDest,
    noiseBuf,
    reverbImpulse,
    voiceId,
    atTime,
    bpm,
    musicalKey,
    volumeScale,
    onDuckWindow: (d) => scheduleVoiceDuck(voiceDuckGain, voiceDuckFilter, atTime, d),
  });
}

function scheduleGrooveBridgeWindow(params: {
  ctx: OfflineAudioContext;
  dest: AudioNode;
  noiseBuf: AudioBuffer;
  pattern: GrooveBridgePattern;
  startAt: number;
  bars: number;
  bpm: number;
  musicalKey: string;
}) {
  const { ctx, dest, noiseBuf, pattern, startAt, bars, bpm, musicalKey } = params;
  if (pattern === 'off' || bars <= 0) return;
  const stepSec = 60 / Math.max(65, bpm) / 4;
  const totalSteps = Math.max(16, Math.round(bars * 16));
  for (let s = 0; s < totalSteps; s++) {
    scheduleGrooveBridgeStepSynth({
      ctx,
      dest,
      noiseBuf,
      stepIdx: s,
      barIdx: Math.floor(s / 16) % 4,
      atTime: startAt + s * stepSec,
      pattern,
      bpm,
      musicalKey,
    });
  }
}

function pickOfflineVoice(params: {
  voiceFxEnabled: boolean;
  voiceFrequency: VoiceFrequencyMode;
  enabledVoiceIds: DjVoiceDropId[];
  customVoiceDrops: CustomVoiceDropMeta[];
  customVoiceBuffers: Partial<Record<CustomVoiceSlotId, AudioBuffer>>;
  vibe: AiDjVibe;
  aggressiveness: number;
  seedOffset: number;
}): AnyVoiceDropId | null {
  const {
    voiceFxEnabled,
    voiceFrequency,
    enabledVoiceIds,
    customVoiceDrops,
    customVoiceBuffers,
    vibe,
    aggressiveness,
    seedOffset,
  } = params;
  if (!voiceFxEnabled) return null;

  const customAvailable = customVoiceDrops.filter(
    (c) => c.hasAudio && c.enabled && Boolean(customVoiceBuffers[c.id])
  );
  const presetPool = enabledVoiceIds.filter((id) => {
    const meta = VOICE_PRESET_MAP[id];
    if (!meta) return false;
    if (vibe === 'chill-sunset') return meta.chillSafe;
    return meta.energyMin <= aggressiveness + 20;
  });

  if (customAvailable.length > 0 && (presetPool.length === 0 || seedOffset % 3 === 0)) {
    return customAvailable[seedOffset % customAvailable.length].id;
  }
  const finalPresets = presetPool.length > 0 ? presetPool : enabledVoiceIds;
  if (finalPresets.length === 0) return null;
  if (voiceFrequency === 'rare' && seedOffset % 2 === 1) return null;
  return finalPresets[seedOffset % finalPresets.length];
}

function stemModeFromIsolation(mode?: StemIsolationMode): 'off' | 'vocal' | 'inst' | 'drums' {
  if (mode === 'vocal-focus') return 'vocal';
  if (mode === 'instrumental') return 'inst';
  if (mode === 'drums-only') return 'drums';
  return 'off';
}

function setOfflineStemMix(
  chain: OfflineDeckNodes,
  hasStems: boolean,
  modeSel: 'off' | 'vocal' | 'inst' | 'drums',
  atTime: number
) {
  if (!hasStems) {
    chain.fullGain.gain.setTargetAtTime(1, atTime, 0.025);
    chain.harmGain.gain.setTargetAtTime(0, atTime, 0.025);
    chain.percGain.gain.setTargetAtTime(0, atTime, 0.025);
    chain.bassGain.gain.setTargetAtTime(0, atTime, 0.025);
    return;
  }
  const f = modeSel === 'off' ? 1 : 0;
  const h = modeSel === 'vocal' ? 1.12 : modeSel === 'inst' ? 0.2 : 0;
  const p = modeSel === 'inst' || modeSel === 'drums' ? 1.05 : 0;
  const b = modeSel === 'inst' ? 1.05 : 0;
  chain.fullGain.gain.setTargetAtTime(f, atTime, 0.025);
  chain.harmGain.gain.setTargetAtTime(h, atTime, 0.025);
  chain.percGain.gain.setTargetAtTime(p, atTime, 0.025);
  chain.bassGain.gain.setTargetAtTime(b, atTime, 0.025);
}

function quantizeCueSec(
  track: TrackItem,
  fallbackFrac: number,
  totalDur: number,
  overrideSec?: number | null,
  preferEarlyStart = false
): number {
  const first = track.firstBeatSec || 0;
  const bar = (60 / Math.max(60, track.bpm || 124)) * 4;
  if (typeof overrideSec === 'number' && Number.isFinite(overrideSec) && overrideSec >= 0) {
    const clamped = Math.max(0, Math.min(Math.max(0, totalDur - 6), overrideSec));
    return Math.max(0, first + Math.round((clamped - first) / bar) * bar);
  }
  const baseTarget = preferEarlyStart
    ? totalDur * fallbackFrac
    : track.dropCueSec ?? track.detectedDropSec ?? totalDur * fallbackFrac;
  const rawCue = Math.max(0, Math.min(Math.max(0, totalDur - 12), baseTarget));
  return Math.max(0, first + Math.round((rawCue - first) / bar) * bar);
}

function resolveTrackTrimGain(input: OfflineRenderDeckInput): number {
  if (
    typeof input.track.autoTrimGain === 'number' &&
    Number.isFinite(input.track.autoTrimGain) &&
    input.track.autoTrimGain >= 0.45 &&
    input.track.autoTrimGain <= 1.45
  ) {
    return input.track.autoTrimGain;
  }
  return estimateTrackLoudnessGain(input.buffer).autoTrimGain;
}

async function ensureInputHpssStems(
  input: OfflineRenderDeckInput
): Promise<OfflineRenderDeckInput> {
  if (input.harmonicBuffer && input.percussiveBuffer && input.bassBuffer) {
    return input;
  }
  try {
    if (input.buffer.duration >= 6 && input.buffer.duration <= 480) {
      const tmpCtx = new OfflineAudioContext(
        Math.min(2, input.buffer.numberOfChannels),
        128,
        input.buffer.sampleRate
      );
      const stems = await runHpssSeparation(tmpCtx, input.buffer);
      if (stems) {
        return {
          ...input,
          harmonicBuffer: stems.harmonicBuffer,
          percussiveBuffer: stems.percussiveBuffer,
          bassBuffer: stems.bassBuffer,
        };
      }
    }
  } catch {
    // Graceful fallback to EQ filtering if HPSS fails
  }
  return input;
}

export async function renderOfflineAiRemixWav(params: {
  mode: OfflineRenderMode;
  deckA: OfflineRenderDeckInput;
  deckB?: OfflineRenderDeckInput;
  playlistTracks?: OfflineRenderDeckInput[];
  vibe: AiDjVibe;
  aggressiveness: number;
  randomness?: number;
  sessionSeed?: number;
  transitionBars?: number;
  mashupTemplate?: MashupTemplateId;
  stemSwapMode?: StemSwapMode;
  reharmonizeSynth?: boolean;
  masteringProfile?: MasteringProfile;
  renderVariant?: OfflineRenderVariant;
  customIntroVoiceBuffer?: AudioBuffer | null;
  customMixTitle?: string;
  mutedPhaseIndices?: number[];
  playlistPacing?: PlaylistMixPacing;
  flipBridgePattern?: GrooveBridgePattern;
  cueASecOverride?: number | null;
  cueBSecOverride?: number | null;
  preview8BarsOnly?: boolean;
  exportFormat?: OfflineExportFormat;
  includeVoicesAndFx?: boolean;
  preservePitch?: boolean;
  voiceFxEnabled?: boolean;
  voiceVolume?: number;
  voiceFrequency?: VoiceFrequencyMode;
  enabledVoiceIds?: DjVoiceDropId[];
  customVoiceDrops?: CustomVoiceDropMeta[];
  customVoiceBuffers?: Partial<Record<CustomVoiceSlotId, AudioBuffer>>;
  features?: Partial<AiFeatureToggles>;
  onProgress?: (pct: number) => void;
}): Promise<OfflineRemixRenderResult> {
  const {
    mode,
    deckA,
    deckB,
    playlistTracks,
    vibe,
    aggressiveness,
    randomness = 55,
    sessionSeed = 1337,
    transitionBars = 8,
    mashupTemplate = 'club-groove-swap',
    stemSwapMode = 'auto',
    reharmonizeSynth = false,
    masteringProfile = 'club-punch',
    renderVariant = 'master',
    customIntroVoiceBuffer = null,
    customMixTitle,
    mutedPhaseIndices = [],
    playlistPacing = 'megamix',
    flipBridgePattern = 'off',
    cueASecOverride = null,
    cueBSecOverride = null,
    preview8BarsOnly = false,
    exportFormat = 'wav',
    includeVoicesAndFx = true,
    preservePitch = true,
    voiceFxEnabled = true,
    voiceVolume = 1.0,
    voiceFrequency = 'normal',
    enabledVoiceIds = ['lets-go', 'hands-up', 'three-two-one', 'bass-drop', 'groove-yeah', 'vip-remix'],
    customVoiceDrops = [],
    customVoiceBuffers = {},
    features: featureOverrides = {},
    onProgress,
  } = params;

  const features: AiFeatureToggles = {
    ...DEFAULT_AI_FEATURE_TOGGLES,
    ...featureOverrides,
  };
  const mutedPhaseSet = new Set<number>(mutedPhaseIndices);
  const variantStemOverride: 'inst' | 'vocal' | null =
    renderVariant === 'instrumental' ? 'inst' : renderVariant === 'acapella' ? 'vocal' : null;
  const effectiveVoicesAndFx =
    includeVoicesAndFx && renderVariant !== 'instrumental' && renderVariant !== 'acapella';

  onProgress?.(5);

  const safeDeckB = deckB || playlistTracks?.[1] || deckA;

  // =========================================================================
  // MODE C: Full-Playlist Continuous Offline Mixdown (2..20 Tracks)
  // =========================================================================
  if (mode === 'playlist-mix') {
    const rawList = (
      playlistTracks && playlistTracks.length >= 2 ? playlistTracks : [deckA, safeDeckB]
    ).slice(0, preview8BarsOnly ? 2 : 20);

    const orderedInputs = preview8BarsOnly
      ? rawList.map((entry) => ({ ...entry.track, id: entry.track.id }))
      : optimizePlaylistSetlist({
          tracks: rawList.map((entry) => ({
            ...entry.track,
            id: entry.track.id,
          })),
          anchorTrack: rawList[0].track,
          energyMode: 'wave',
          randomness,
          sessionSeed,
          maxLength: 20,
        });

    const inputById = new Map<string, OfflineRenderDeckInput>();
    for (const item of rawList) inputById.set(item.track.id, item);
    const baseSequence = orderedInputs
      .map((t) => inputById.get(t.id))
      .filter((x): x is OfflineRenderDeckInput => Boolean(x));

    // Upgrade #4: Auto HPSS separation + LUFS loudness check for every playlist track missing stems
    const sequence: OfflineRenderDeckInput[] = [];
    for (let i = 0; i < baseSequence.length; i++) {
      const stemmed = await ensureInputHpssStems(baseSequence[i]);
      sequence.push(stemmed);
      onProgress?.(6 + Math.round(((i + 1) / baseSequence.length) * 14));
    }

    const xfadeBars = preview8BarsOnly ? 4 : Math.max(4, Math.min(8, transitionBars));

    interface PlaylistTimelineEntry {
      input: OfflineRenderDeckInput;
      startSec: number;
      playDurSec: number;
      nativeBpm: number;
      rawBpm: number;
      baseRate: number;
      semitoneShift: number;
      cueSec: number;
      mixInStartSec: number;
      mixInEndSec: number;
      inOverlapSec: number;
      outOverlapSec: number;
      outNextBpm: number;
      trimGain: number;
      plan?: ReturnType<typeof planOfflineTransition>;
      rampLabel?: string;
    }

    const timeline: PlaylistTimelineEntry[] = [];
    let cursorSec = 0;

    for (let i = 0; i < sequence.length; i++) {
      const cur = sequence[i];
      const prev = i > 0 ? timeline[i - 1] : null;
      const curRawBpm = Math.max(64, Math.min(182, cur.track.bpm || 124));

      // Enhancement #1: Keep each track near its native BPM during its body, using 0.5x/2x folding only if huge
      let nativeBpm = curRawBpm;
      let semitoneShift = 0;
      let plan: ReturnType<typeof planOfflineTransition> | undefined;

      if (prev) {
        const candidates = [curRawBpm, curRawBpm * 2, curRawBpm * 0.5].filter((b) => b >= 68 && b <= 176);
        nativeBpm = candidates.reduce(
          (best, cand) =>
            Math.abs(cand - prev.nativeBpm) < Math.abs(best - prev.nativeBpm) ? cand : best,
          curRawBpm
        );

        plan = planOfflineTransition({
          outgoingTrack: prev.input.track,
          currentBpm: prev.nativeBpm,
          vibe,
          candidates: [cur.track],
          aggressiveness,
          randomness,
          remixMode: true,
          quickMix: playlistPacing === 'megamix',
          sessionSeed: sessionSeed + i * 97,
          voiceFxEnabled: effectiveVoicesAndFx && voiceFxEnabled,
          voiceFrequency,
          enabledVoiceIds,
          enabledCustomDrops: customVoiceDrops,
          features,
        });
        const snap = resolveSemitoneSnap(
          prev.input.track.musicalKey,
          cur.track.musicalKey,
          nativeBpm,
          curRawBpm
        );
        semitoneShift = snap.semitones;
      }

      const baseRate = Math.max(0.68, Math.min(1.42, nativeBpm / curRawBpm));
      const nativeBarSec = (60 / nativeBpm) * 4;

      const tBars = prev
        ? preview8BarsOnly
          ? 4
          : Math.max(4, Math.min(8, plan?.transitionBars || xfadeBars))
        : 0;
      const transAvgBpm = prev ? (prev.nativeBpm + nativeBpm) * 0.5 : nativeBpm;
      const transBarSec = (60 / transAvgBpm) * 4;
      const overlapSec = prev ? tBars * transBarSec : 0;

      // Upgrade #1: Set Pacing controls segment length (Megamix vs Extended vs Full Songs)
      const preferEarlyCue = playlistPacing === 'extended' || playlistPacing === 'full-songs';
      const fallbackFrac =
        playlistPacing === 'full-songs'
          ? 0.02
          : playlistPacing === 'extended'
          ? 0.06
          : i === 0
          ? 0.14
          : plan?.incomingStartPct ?? 0.16;

      const cueSec = quantizeCueSec(
        cur.track,
        fallbackFrac,
        cur.buffer.duration,
        i === 0 ? cueASecOverride : null,
        preferEarlyCue
      );

      let soloSec: number;
      if (preview8BarsOnly) {
        soloSec = 2 * nativeBarSec;
      } else if (playlistPacing === 'full-songs') {
        const playableNativeSec = Math.max(24, (cur.buffer.duration - cueSec) / Math.max(0.68, baseRate));
        const vipScale = features.vipSkip !== false ? 0.76 : 0.96;
        const targetBodySec = Math.max(16 * nativeBarSec, playableNativeSec * vipScale - 1.2);
        soloSec = Math.max(10 * nativeBarSec, targetBodySec - overlapSec - xfadeBars * nativeBarSec);
      } else if (playlistPacing === 'extended') {
        const extendedBars = sequence.length <= 6 ? 36 : 28;
        const maxPossible = Math.max(
          16 * nativeBarSec,
          (cur.buffer.duration - cueSec) / Math.max(0.68, baseRate) - 1.5
        );
        soloSec = Math.min(
          extendedBars * nativeBarSec,
          Math.max(12 * nativeBarSec, maxPossible - overlapSec - xfadeBars * nativeBarSec)
        );
      } else {
        const megaBars = sequence.length <= 4 ? 12 : sequence.length <= 10 ? 8 : 6;
        soloSec = megaBars * nativeBarSec;
      }

      const startSec = prev ? Math.max(0, cursorSec - overlapSec) : 0;
      if (prev) {
        // Outgoing track stays alive across the full S-curve glide window with Track i
        prev.outOverlapSec = overlapSec;
        prev.outNextBpm = nativeBpm;
        prev.playDurSec = Math.max(prev.playDurSec, startSec + overlapSec - prev.startSec);
      }

      const rampLabel =
        prev && Math.abs(prev.nativeBpm - nativeBpm) >= 2
          ? `Tempo Ramp ${Math.round(prev.nativeBpm)}→${Math.round(nativeBpm)} BPM`
          : undefined;

      timeline.push({
        input: cur,
        startSec,
        playDurSec: overlapSec + soloSec + 0.5,
        nativeBpm,
        rawBpm: curRawBpm,
        baseRate,
        semitoneShift,
        cueSec,
        mixInStartSec: startSec,
        mixInEndSec: startSec + overlapSec,
        inOverlapSec: overlapSec,
        outOverlapSec: 0,
        outNextBpm: nativeBpm,
        trimGain: resolveTrackTrimGain(cur),
        plan,
        rampLabel,
      });

      cursorSec = startSec + overlapSec + soloSec;
    }

    const totalSec = Math.max(14, cursorSec + 2.4);
    const sampleRate = totalSec > 480 || sequence.length >= 10 ? 32000 : 44100;
    const offlineCtx = new OfflineAudioContext(2, Math.ceil(totalSec * sampleRate), sampleRate);
    const noiseBuf = createSynthNoiseBuffer(offlineCtx, 0.35);
    const reverbImpulse = createSynthReverbImpulse(offlineCtx, 2.2, 2.7);

    // Master Chain + Voice Duck Pocket + Bus Compression
    const masterSum = offlineCtx.createGain();
    const voiceDuckGain = offlineCtx.createGain();
    voiceDuckGain.gain.value = 1;
    const voiceDuckFilter = offlineCtx.createBiquadFilter();
    voiceDuckFilter.type = 'peaking';
    voiceDuckFilter.frequency.value = 1450;
    voiceDuckFilter.Q.value = 0.65;
    voiceDuckFilter.gain.value = 0;
    const postDuckSum = offlineCtx.createGain();

    const subTightHp = offlineCtx.createBiquadFilter();
    subTightHp.type = 'highpass';
    subTightHp.frequency.value = 26;
    const masterComp = offlineCtx.createDynamicsCompressor();
    masterComp.threshold.value = -11.5;
    masterComp.knee.value = 10;
    masterComp.ratio.value = 3.6;
    masterComp.attack.value = 0.004;
    masterComp.release.value = 0.14;
    const masterLimiter = offlineCtx.createDynamicsCompressor();
    masterLimiter.threshold.value = -1.2;
    masterLimiter.knee.value = 0;
    masterLimiter.ratio.value = 18;
    const masterMakeup = offlineCtx.createGain();
    masterMakeup.gain.value = 1.15;

    masterSum.connect(voiceDuckGain);
    voiceDuckGain.connect(voiceDuckFilter);
    voiceDuckFilter.connect(postDuckSum);
    postDuckSum.connect(subTightHp);
    subTightHp.connect(masterComp);
    masterComp.connect(masterLimiter);
    masterLimiter.connect(masterMakeup);
    masterMakeup.connect(offlineCtx.destination);

    onProgress?.(24);

    const chains: [OfflineDeckNodes, OfflineDeckNodes] = [
      createOfflineDeckChain(offlineCtx, masterSum, reverbImpulse, 0.92),
      createOfflineDeckChain(offlineCtx, masterSum, reverbImpulse, 0.92),
    ];

    const cueEntries: CueSheetEntry[] = [];

    for (let i = 0; i < timeline.length; i++) {
      const entry = timeline[i];
      const chainIdx = i % 2;
      const otherChainIdx = (i + 1) % 2;
      const chain = chains[chainIdx];
      const prevChain = chains[otherChainIdx];

      const hasStems = Boolean(
        entry.input.harmonicBuffer && entry.input.percussiveBuffer && entry.input.bassBuffer
      );

      cueEntries.push({
        atSec: i === 0 ? 0 : entry.mixInStartSec,
        label: `${entry.input.track.title}${entry.input.track.artist ? ` — ${entry.input.track.artist}` : ''}`,
        bpm: entry.nativeBpm,
        key: entry.input.track.musicalKey || '8A',
        note:
          i === 0
            ? 'Opening Track'
            : entry.rampLabel || entry.plan?.mixStyle || 'AI Transition',
      });

      // Build dual-ended S-curve tempo glide ramps for phase-locked multi-genre BPM bridges
      const ramps: TempoRampSegment[] = [];
      if (i > 0 && entry.inOverlapSec > 0.1) {
        const prevBpm = timeline[i - 1].nativeBpm;
        if (Math.abs(prevBpm - entry.nativeBpm) >= 1.5) {
          ramps.push({
            startSec: entry.mixInStartSec,
            durationSec: entry.inOverlapSec,
            startRate: prevBpm / entry.rawBpm,
            endRate: entry.baseRate,
          });
        }
      }
      if (entry.outOverlapSec > 0.1 && i + 1 < timeline.length) {
        if (Math.abs(entry.nativeBpm - entry.outNextBpm) >= 1.5) {
          const outStart = entry.startSec + entry.playDurSec - entry.outOverlapSec;
          ramps.push({
            startSec: Math.max(entry.mixInEndSec + 0.05, outStart),
            durationSec: entry.outOverlapSec,
            startRate: entry.baseRate,
            endRate: entry.outNextBpm / entry.rawBpm,
          });
        }
      }

      const prepFull = prepareWindowBuffer({
        ctx: offlineCtx,
        source: entry.input.buffer,
        cueSec: entry.cueSec,
        neededOutputSec: entry.playDurSec,
        tempoRatio: entry.baseRate,
        semitoneShift: entry.semitoneShift,
        preservePitch,
      });

      const effectiveBaseRate = prepFull.buffer !== entry.input.buffer ? 1.0 : prepFull.playbackRate;
      const adjustedRamps =
        prepFull.buffer !== entry.input.buffer
          ? ramps.map((r) => ({
              ...r,
              startRate: r.startRate / Math.max(0.55, entry.baseRate),
              endRate: r.endRate / Math.max(0.55, entry.baseRate),
            }))
          : ramps;

      scheduleStemSource(
        offlineCtx,
        prepFull.buffer,
        chain.fullGain,
        entry.startSec,
        prepFull.offsetSec,
        entry.playDurSec,
        effectiveBaseRate,
        adjustedRamps
      );

      if (hasStems) {
        const prepHarm = prepareWindowBuffer({
          ctx: offlineCtx,
          source: entry.input.harmonicBuffer!,
          cueSec: entry.cueSec,
          neededOutputSec: entry.playDurSec,
          tempoRatio: entry.baseRate,
          semitoneShift: entry.semitoneShift,
          preservePitch,
        });
        const prepPerc = prepareWindowBuffer({
          ctx: offlineCtx,
          source: entry.input.percussiveBuffer!,
          cueSec: entry.cueSec,
          neededOutputSec: entry.playDurSec,
          tempoRatio: entry.baseRate,
          semitoneShift: entry.semitoneShift,
          preservePitch,
        });
        const prepBass = prepareWindowBuffer({
          ctx: offlineCtx,
          source: entry.input.bassBuffer!,
          cueSec: entry.cueSec,
          neededOutputSec: entry.playDurSec,
          tempoRatio: entry.baseRate,
          semitoneShift: entry.semitoneShift,
          preservePitch,
        });

        scheduleStemSource(
          offlineCtx,
          prepHarm.buffer,
          chain.harmGain,
          entry.startSec,
          prepHarm.offsetSec,
          entry.playDurSec,
          effectiveBaseRate,
          adjustedRamps
        );
        scheduleStemSource(
          offlineCtx,
          prepPerc.buffer,
          chain.percGain,
          entry.startSec,
          prepPerc.offsetSec,
          entry.playDurSec,
          effectiveBaseRate,
          adjustedRamps
        );
        scheduleStemSource(
          offlineCtx,
          prepBass.buffer,
          chain.bassGain,
          entry.startSec,
          prepBass.offsetSec,
          entry.playDurSec,
          effectiveBaseRate,
          adjustedRamps
        );
      }

      const trim = entry.trimGain;
      setOfflineStemMix(chain, hasStems, variantStemOverride || 'off', entry.startSec);

      if (i === 0) {
        chain.gain.gain.setValueAtTime(0.001, 0);
        chain.gain.gain.linearRampToValueAtTime(trim, 0.35);
        chain.lowFilter.gain.setValueAtTime(0, 0);
        chain.midFilter.gain.setValueAtTime(0, 0);
        chain.vocalSidechainFilter.gain.setValueAtTime(0, 0);
        scheduleOfflineFxAutomation(chain, 0, 60 / entry.nativeBpm, { enabled: false });

        // Bake Groq Spoken Intro Drop over Bar 1 when supplied
        if (effectiveVoicesAndFx && customIntroVoiceBuffer && !mutedPhaseSet.has(0)) {
          scheduleCustomVoiceBufferSynth({
            ctx: offlineCtx,
            dest: postDuckSum,
            reverbImpulse,
            buffer: customIntroVoiceBuffer,
            atTime: 0.45,
            bpm: entry.nativeBpm,
            volumeScale: Math.max(0.85, voiceVolume),
            onDuckWindow: (d) => scheduleVoiceDuck(voiceDuckGain, voiceDuckFilter, 0.45, d),
          });
        }
      } else {
        const mixStart = entry.mixInStartSec;
        const mixEnd = entry.mixInEndSec;
        const midMix = (mixStart + mixEnd) * 0.5;
        const avgRampBpm = (timeline[i - 1].nativeBpm + entry.nativeBpm) * 0.5;
        const beatSec = 60 / avgRampBpm;
        const phaseMuted = mutedPhaseSet.has(i);

        chain.gain.gain.setValueAtTime(0.001, mixStart);
        chain.gain.gain.linearRampToValueAtTime(trim, midMix);
        chain.lowFilter.gain.setValueAtTime(-20, mixStart);
        chain.lowFilter.gain.setTargetAtTime(1.0, midMix, 0.03);
        scheduleOfflineFxAutomation(chain, mixStart, beatSec, { enabled: false });

        if (!variantStemOverride && hasStems && entry.plan?.mixStyleKey === 'stem-vocal-swap') {
          setOfflineStemMix(prevChain, Boolean(timeline[i - 1].input.harmonicBuffer), 'inst', mixStart);
          setOfflineStemMix(chain, true, 'vocal', mixStart);
          setOfflineStemMix(chain, true, 'off', midMix);
        }

        const inVoc = analyzeVocalProfile(entry.input.track.title, entry.input.track.artist, {
          detectedVocalDensity: entry.input.track.detectedVocalDensity,
          vocalPockets: entry.input.track.vocalPockets,
          durationSec: entry.input.track.durationSec,
          bpm: entry.input.track.bpm,
        });
        if (
          features.spectralSidechain !== false &&
          (inVoc.density === 'vocal-dense' || inVoc.density === 'acapella')
        ) {
          prevChain.vocalSidechainFilter.gain.setTargetAtTime(-4.4, mixStart, 0.05);
          prevChain.vocalSidechainFilter.gain.setTargetAtTime(0, mixEnd, 0.08);
        }

        prevChain.lowFilter.gain.setTargetAtTime(-22, midMix, 0.03);
        prevChain.gain.gain.setTargetAtTime(0.75 * timeline[i - 1].trimGain, mixStart, 0.04);
        prevChain.gain.gain.linearRampToValueAtTime(0.0001, mixEnd);

        if (effectiveVoicesAndFx && !phaseMuted) {
          const buildStart = Math.max(0, midMix - beatSec * 8);
          const voiceChoice = pickOfflineVoice({
            voiceFxEnabled,
            voiceFrequency,
            enabledVoiceIds,
            customVoiceDrops,
            customVoiceBuffers,
            vibe,
            aggressiveness,
            seedOffset: sessionSeed + i * 17,
          });
          const customBuf =
            voiceChoice && isCustomVoiceDropId(voiceChoice)
              ? customVoiceBuffers[voiceChoice] || null
              : null;
          const presetVoice =
            voiceChoice && !isCustomVoiceDropId(voiceChoice) ? voiceChoice : null;

          if (i % 2 === 1 || aggressiveness >= 55) {
            scheduleBuildUpSequenceSynth({
              ctx: offlineCtx,
              dest: masterSum,
              voiceDest: postDuckSum,
              noiseBuf,
              reverbImpulse,
              startAt: buildStart,
              bpm: avgRampBpm,
              musicalKey: entry.input.track.musicalKey,
              bars: 2,
              voiceId: presetVoice,
              customVoiceBuffer: customBuf,
              voiceVolumeScale: voiceFxEnabled ? voiceVolume : 0,
              onVoiceDuckWindow: (d) =>
                scheduleVoiceDuck(
                  voiceDuckGain,
                  voiceDuckFilter,
                  Math.max(buildStart, midMix - 0.55),
                  d
                ),
            });
          } else if (voiceChoice) {
            scheduleAnyVoiceOffline({
              ctx: offlineCtx,
              voiceDest: postDuckSum,
              voiceDuckGain,
              voiceDuckFilter,
              noiseBuf,
              reverbImpulse,
              voiceId: voiceChoice,
              customVoiceBuffers,
              atTime: Math.max(0.05, midMix - 0.45),
              bpm: avgRampBpm,
              musicalKey: entry.input.track.musicalKey,
              volumeScale: voiceVolume,
            });
          }

          if (
            features.autoGrooveBridge !== false &&
            entry.plan?.recommendedBridge &&
            entry.plan.recommendedBridge !== 'off'
          ) {
            scheduleGrooveBridgeWindow({
              ctx: offlineCtx,
              dest: masterSum,
              noiseBuf,
              pattern: entry.plan.recommendedBridge,
              startAt: mixStart,
              bars: Math.min(4, Math.max(2, Math.floor((mixEnd - mixStart) / (beatSec * 4)))),
              bpm: avgRampBpm,
              musicalKey: entry.input.track.musicalKey,
            });
          }

          scheduleOfflineFxAutomation(prevChain, midMix, beatSec, {
            enabled: true,
            type: 'dubdelay',
            wet: 0.42,
            beatDiv: 0.75,
          });
        }
      }

      // Final track clean echo-tail fade-out
      if (i === timeline.length - 1) {
        const tailAt = Math.max(1, totalSec - 3.0);
        scheduleOfflineFxAutomation(chain, tailAt, 60 / entry.nativeBpm, {
          enabled: true,
          type: 'reverb',
          wet: 0.55,
          beatDiv: 0.5,
        });
      }

      onProgress?.(25 + Math.round(((i + 1) / timeline.length) * 32));
    }

    const fadeStart = Math.max(1, totalSec - 2.2);
    masterMakeup.gain.setValueAtTime(1.15, fadeStart);
    masterMakeup.gain.linearRampToValueAtTime(0.0001, totalSec);

    let fakePct = 58;
    const ticker = setInterval(() => {
      fakePct = Math.min(91, fakePct + 3);
      onProgress?.(fakePct);
    }, 180);

    let rendered: AudioBuffer;
    try {
      rendered = await offlineCtx.startRendering();
    } finally {
      clearInterval(ticker);
    }

    onProgress?.(94);
    const encoded = await encodeAudioBufferToOggOrCompactWav(
      rendered,
      exportFormat,
      masteringProfile
    );
    onProgress?.(100);

    const pacingTag =
      playlistPacing === 'full-songs'
        ? 'Full Songs'
        : playlistPacing === 'extended'
        ? 'Extended Mix'
        : 'Club Megamix';
    const baseTitle = preview8BarsOnly
      ? `8-Bar Mix Preview (${sequence[0].track.title.slice(0, 16)} -> ${sequence[1].track.title.slice(0, 16)})`
      : customMixTitle || `Playlist ${pacingTag} (${sequence.length} Tracks)`;
    const roleTag =
      renderVariant === 'instrumental'
        ? ' [Instrumental]'
        : renderVariant === 'acapella'
        ? ' [Acapella]'
        : renderVariant === 'dj-edit'
        ? ' [DJ Edit]'
        : '';
    const mixTitle = `${baseTitle}${roleTag}`;

    return {
      blob: encoded.blob,
      durationSec: rendered.duration,
      title: mixTitle,
      format: encoded.format,
      cueSheetText: buildCueSheetText(mixTitle, cueEntries),
      tracklistCount: cueEntries.length,
      packRole: renderVariant,
    };
  }

  // =========================================================================
  // MODE D: Single-Track "AI Club Flip" (1-Deck Offline Remix)
  // =========================================================================
  if (mode === 'single-flip') {
    const stemmedA = await ensureInputHpssStems(deckA);
    onProgress?.(20);

    const sampleRate = 44100;
    const aBpm = Math.max(72, Math.min(176, stemmedA.track.bpm || 124));
    const beatSec = 60 / aBpm;
    const barSec = beatSec * 4;
    const qCueA = quantizeCueSec(stemmedA.track, 0.14, stemmedA.buffer.duration, cueASecOverride);

    const fullTotalBars = 32;
    const barOffset = preview8BarsOnly ? 12 : 0; // Preview bars 12..20 (Vocal flip -> Buildup -> Drop slam!)
    const activeBars = preview8BarsOnly ? 8 : fullTotalBars;
    const isDjEdit = !preview8BarsOnly && renderVariant === 'dj-edit';
    const djIntroBars = isDjEdit ? 8 : 0;
    const djOutroBars = isDjEdit ? 8 : 0;
    const totalSec = Math.max(10, (activeBars + djIntroBars + djOutroBars) * barSec + 1.8);

    const offlineCtx = new OfflineAudioContext(2, Math.ceil(totalSec * sampleRate), sampleRate);
    const noiseBuf = createSynthNoiseBuffer(offlineCtx, 0.35);
    const reverbImpulse = createSynthReverbImpulse(offlineCtx, 2.2, 2.7);

    const masterSum = offlineCtx.createGain();
    const voiceDuckGain = offlineCtx.createGain();
    voiceDuckGain.gain.value = 1;
    const voiceDuckFilter = offlineCtx.createBiquadFilter();
    voiceDuckFilter.type = 'peaking';
    voiceDuckFilter.frequency.value = 1450;
    voiceDuckFilter.Q.value = 0.65;
    voiceDuckFilter.gain.value = 0;
    const postDuckSum = offlineCtx.createGain();

    const subTightHp = offlineCtx.createBiquadFilter();
    subTightHp.type = 'highpass';
    subTightHp.frequency.value = 26;
    const masterWarmth = offlineCtx.createBiquadFilter();
    masterWarmth.type = 'lowshelf';
    masterWarmth.frequency.value = 85;
    masterWarmth.gain.value = 0.9;
    const masterComp = offlineCtx.createDynamicsCompressor();
    masterComp.threshold.value = -11.5;
    masterComp.knee.value = 10;
    masterComp.ratio.value = 3.6;
    masterComp.attack.value = 0.004;
    masterComp.release.value = 0.14;
    const masterLimiter = offlineCtx.createDynamicsCompressor();
    masterLimiter.threshold.value = -1.2;
    masterLimiter.knee.value = 0;
    masterLimiter.ratio.value = 18;
    const masterMakeup = offlineCtx.createGain();
    masterMakeup.gain.value = 1.15;

    masterSum.connect(voiceDuckGain);
    voiceDuckGain.connect(voiceDuckFilter);
    voiceDuckFilter.connect(postDuckSum);
    postDuckSum.connect(subTightHp);
    subTightHp.connect(masterWarmth);
    masterWarmth.connect(masterComp);
    masterComp.connect(masterLimiter);
    masterLimiter.connect(masterMakeup);
    masterMakeup.connect(offlineCtx.destination);

    const trimA = resolveTrackTrimGain(stemmedA);
    const chainA = createOfflineDeckChain(offlineCtx, masterSum, reverbImpulse, trimA);
    const hasStemsA = Boolean(
      stemmedA.harmonicBuffer && stemmedA.percussiveBuffer && stemmedA.bassBuffer
    );

    const introDurSec = djIntroBars * barSec;
    const mainEndSec = introDurSec + activeBars * barSec;
    const sourceStartSec = qCueA + barOffset * barSec;
    scheduleStemSource(offlineCtx, stemmedA.buffer, chainA.fullGain, introDurSec, sourceStartSec, activeBars * barSec + djOutroBars * barSec + 1.4, 1);
    if (hasStemsA) {
      scheduleStemSource(offlineCtx, stemmedA.harmonicBuffer!, chainA.harmGain, introDurSec, sourceStartSec, activeBars * barSec + djOutroBars * barSec + 1.4, 1);
      scheduleStemSource(offlineCtx, stemmedA.percussiveBuffer!, chainA.percGain, introDurSec, sourceStartSec, activeBars * barSec + djOutroBars * barSec + 1.4, 1);
      scheduleStemSource(offlineCtx, stemmedA.bassBuffer!, chainA.bassGain, introDurSec, sourceStartSec, activeBars * barSec + djOutroBars * barSec + 1.4, 1);
    }

    const chosenBridge: GrooveBridgePattern =
      flipBridgePattern && flipBridgePattern !== 'off'
        ? flipBridgePattern
        : vibe === 'festival-drop' || vibe === 'techno-hypnotic'
        ? 'house-4x4'
        : vibe === 'scratch-chop'
        ? 'sub-808'
        : vibe === 'chill-sunset'
        ? 'chord-arp'
        : 'afro-perc';

    const tAtBar = (b: number) => introDurSec + (b - barOffset) * barSec;

    // 8-Bar Quantized DJ Intro & Outro Beat Loops when DJ Edit Pack is rendered
    if (isDjEdit) {
      scheduleGrooveBridgeWindow({
        ctx: offlineCtx,
        dest: masterSum,
        noiseBuf,
        pattern: chosenBridge,
        startAt: 0,
        bars: 8,
        bpm: aBpm,
        musicalKey: stemmedA.track.musicalKey,
      });
      scheduleGrooveBridgeWindow({
        ctx: offlineCtx,
        dest: masterSum,
        noiseBuf,
        pattern: chosenBridge,
        startAt: mainEndSec,
        bars: 8,
        bpm: aBpm,
        musicalKey: stemmedA.track.musicalKey,
      });
    }

    if (effectiveVoicesAndFx && customIntroVoiceBuffer && !mutedPhaseSet.has(0)) {
      scheduleCustomVoiceBufferSynth({
        ctx: offlineCtx,
        dest: postDuckSum,
        reverbImpulse,
        buffer: customIntroVoiceBuffer,
        atTime: Math.max(0.25, introDurSec + 0.35),
        bpm: aBpm,
        volumeScale: Math.max(0.85, voiceVolume),
        onDuckWindow: (d) =>
          scheduleVoiceDuck(voiceDuckGain, voiceDuckFilter, Math.max(0.25, introDurSec + 0.35), d),
      });
    }

    if (!preview8BarsOnly) {
      setOfflineStemMix(chainA, hasStemsA, variantStemOverride || 'off', introDurSec);
      chainA.gain.gain.setValueAtTime(0.001, introDurSec);
      chainA.gain.gain.linearRampToValueAtTime(trimA, introDurSec + 0.25);
      if (effectiveVoicesAndFx && !mutedPhaseSet.has(0) && features.autoGrooveBridge !== false) {
        scheduleGrooveBridgeWindow({
          ctx: offlineCtx,
          dest: masterSum,
          noiseBuf,
          pattern: 'top-hats',
          startAt: tAtBar(4),
          bars: 4,
          bpm: aBpm,
          musicalKey: stemmedA.track.musicalKey,
        });
      }
    } else {
      setOfflineStemMix(chainA, hasStemsA, variantStemOverride || 'vocal', 0);
      chainA.gain.gain.setValueAtTime(trimA, 0);
    }

    // Bars 8..16: Vocal/Harmonic Flip riding over Groove Bridge drums!
    const flipStart = Math.max(introDurSec, tAtBar(8));
    const buildStart = Math.max(introDurSec, tAtBar(14));
    const dropAt = Math.max(introDurSec + 0.1, tAtBar(16));

    setOfflineStemMix(chainA, hasStemsA, variantStemOverride || 'vocal', flipStart);
    if (!hasStemsA) {
      chainA.lowFilter.gain.setTargetAtTime(renderVariant === 'acapella' ? -22 : -16, flipStart, 0.04);
      chainA.midFilter.gain.setTargetAtTime(2.5, flipStart, 0.04);
    }

    if (effectiveVoicesAndFx && !mutedPhaseSet.has(1) && features.autoGrooveBridge !== false) {
      const bridgeStart = Math.max(introDurSec, tAtBar(8));
      const bridgeBars = preview8BarsOnly ? 4 : 8;
      scheduleGrooveBridgeWindow({
        ctx: offlineCtx,
        dest: masterSum,
        noiseBuf,
        pattern: chosenBridge,
        startAt: bridgeStart,
        bars: bridgeBars,
        bpm: aBpm,
        musicalKey: stemmedA.track.musicalKey,
      });
    }

    // Enhancement #2: Key-Locked Synth Bass & Warm Club Pad Re-Harmonizer
    if (reharmonizeSynth && renderVariant !== 'acapella') {
      scheduleReharmonizerWindowSynth({
        ctx: offlineCtx,
        dest: masterSum,
        startAt: Math.max(introDurSec, tAtBar(8)),
        bars: preview8BarsOnly ? 4 : 6,
        bpm: aBpm,
        musicalKey: stemmedA.track.musicalKey,
        intensity: 0.72,
      });
      scheduleReharmonizerWindowSynth({
        ctx: offlineCtx,
        dest: masterSum,
        startAt: dropAt,
        bars: preview8BarsOnly ? 4 : 8,
        bpm: aBpm,
        musicalKey: stemmedA.track.musicalKey,
        intensity: 0.85,
      });
    }

    // HPF tension rise during bars 14..16 + Beat-Slice / Fakeout Stutter
    chainA.sweeperFilter.type = 'highpass';
    chainA.sweeperFilter.frequency.setValueAtTime(140, buildStart);
    chainA.sweeperFilter.frequency.exponentialRampToValueAtTime(
      1450,
      Math.max(buildStart + 0.3, dropAt - beatSec * 0.5)
    );

    if (effectiveVoicesAndFx && !mutedPhaseSet.has(2)) {
      const vId = pickOfflineVoice({
        voiceFxEnabled,
        voiceFrequency,
        enabledVoiceIds,
        customVoiceDrops,
        customVoiceBuffers,
        vibe,
        aggressiveness,
        seedOffset: sessionSeed + 19,
      });
      scheduleBuildUpSequenceSynth({
        ctx: offlineCtx,
        dest: masterSum,
        voiceDest: postDuckSum,
        noiseBuf,
        reverbImpulse,
        startAt: buildStart,
        bpm: aBpm,
        musicalKey: stemmedA.track.musicalKey,
        bars: 2,
        voiceId: vId && !isCustomVoiceDropId(vId) ? vId : null,
        customVoiceBuffer: vId && isCustomVoiceDropId(vId) ? customVoiceBuffers[vId] || null : null,
        voiceVolumeScale: voiceFxEnabled ? voiceVolume : 0,
        onVoiceDuckWindow: (d) =>
          scheduleVoiceDuck(voiceDuckGain, voiceDuckFilter, Math.max(buildStart, dropAt - 0.5), d),
      });

      if (features.beatSliceStutter !== false || features.dropFakeouts !== false) {
        const sStart = Math.max(buildStart + 0.1, dropAt - barSec);
        for (let k = 0; k < 6; k++) {
          const kt = sStart + k * (beatSec * 0.5);
          chainA.gain.gain.setValueAtTime(k % 2 === 0 ? trimA : 0.12, kt);
        }
      }
      chainA.gain.gain.setValueAtTime(0.04, Math.max(0.05, dropAt - beatSec * 0.65));
    }

    // Bars 16..28: Club Flip Drop Slam!
    setOfflineStemMix(chainA, hasStemsA, variantStemOverride || 'off', dropAt);
    chainA.lowFilter.gain.setTargetAtTime(renderVariant === 'acapella' ? -18 : 1.5, dropAt, 0.02);
    chainA.midFilter.gain.setTargetAtTime(0, dropAt, 0.02);
    chainA.gain.gain.setValueAtTime(Math.min(1.12, trimA * 1.05), dropAt);
    chainA.sweeperFilter.type = 'allpass';
    chainA.sweeperFilter.frequency.setTargetAtTime(1000, dropAt, 0.02);

    if (effectiveVoicesAndFx && !mutedPhaseSet.has(3)) {
      scheduleSoundTrickSynth({
        ctx: offlineCtx,
        dest: masterSum,
        type: 'sub-drop',
        atTime: dropAt,
        bpm: aBpm,
        musicalKey: stemmedA.track.musicalKey,
      });
      if (features.autoGrooveBridge !== false) {
        scheduleGrooveBridgeWindow({
          ctx: offlineCtx,
          dest: masterSum,
          noiseBuf,
          pattern: chosenBridge,
          startAt: dropAt,
          bars: preview8BarsOnly ? 4 : 8,
          bpm: aBpm,
          musicalKey: stemmedA.track.musicalKey,
        });
      }
    }

    if (!preview8BarsOnly && effectiveVoicesAndFx && !mutedPhaseSet.has(4)) {
      scheduleOfflineFxAutomation(chainA, tAtBar(28), beatSec, {
        enabled: true,
        type: 'dubdelay',
        wet: 0.46,
        beatDiv: 0.75,
      });
    }

    if (isDjEdit) {
      chainA.gain.gain.setValueAtTime(trimA, mainEndSec);
      chainA.gain.gain.linearRampToValueAtTime(0.001, mainEndSec + 1.2);
    }

    const fadeStart = Math.max(1, totalSec - 1.5);
    masterMakeup.gain.setValueAtTime(1.15, fadeStart);
    masterMakeup.gain.linearRampToValueAtTime(0.0001, totalSec);

    onProgress?.(45);
    let fakePct = 48;
    const ticker = setInterval(() => {
      fakePct = Math.min(90, fakePct + 5);
      onProgress?.(fakePct);
    }, 130);

    let rendered: AudioBuffer;
    try {
      rendered = await offlineCtx.startRendering();
    } finally {
      clearInterval(ticker);
    }

    onProgress?.(94);
    const encoded = await encodeAudioBufferToOggOrCompactWav(
      rendered,
      exportFormat,
      masteringProfile
    );
    onProgress?.(100);

    const shortA = stemmedA.track.title.split('(')[0].trim().slice(0, 26);
    const roleTag =
      renderVariant === 'instrumental'
        ? ' [Instrumental]'
        : renderVariant === 'acapella'
        ? ' [Acapella]'
        : renderVariant === 'dj-edit'
        ? ' [DJ 8-Bar Intro/Outro]'
        : '';
    const mixTitle = preview8BarsOnly
      ? `8-Bar Club Flip Preview — ${shortA}`
      : `${customMixTitle || `AI Club Flip (${chosenBridge}) — ${shortA}`}${roleTag}`;
    const cueEntries: CueSheetEntry[] = preview8BarsOnly
      ? [
          { atSec: 0, label: `${shortA} (Flip Build)`, bpm: aBpm, key: stemmedA.track.musicalKey },
          { atSec: dropAt, label: `${shortA} (Drop Slam)`, bpm: aBpm, key: stemmedA.track.musicalKey },
        ]
      : [
          ...(isDjEdit
            ? [{ atSec: 0, label: `8-Bar Quantized DJ Intro`, bpm: aBpm, key: stemmedA.track.musicalKey }]
            : []),
          { atSec: introDurSec, label: `${shortA} — Groove Intro`, bpm: aBpm, key: stemmedA.track.musicalKey },
          { atSec: flipStart, label: `${shortA} — Vocal Flip + ${chosenBridge}`, bpm: aBpm, key: stemmedA.track.musicalKey },
          { atSec: dropAt, label: `${shortA} — Club Flip Drop`, bpm: aBpm, key: stemmedA.track.musicalKey },
          { atSec: tAtBar(28), label: `${shortA} — Dub Echo Out`, bpm: aBpm, key: stemmedA.track.musicalKey },
        ];

    return {
      blob: encoded.blob,
      durationSec: rendered.duration,
      title: mixTitle,
      format: encoded.format,
      cueSheetText: buildCueSheetText(mixTitle, cueEntries),
      tracklistCount: 1,
      packRole: renderVariant,
      stemmedA,
    };
  }

  // =========================================================================
  // MODES A & B: 32-Bar Bootleg Mashup (4 Templates) & AI Transition Edit
  // =========================================================================
  const stemmedA = await ensureInputHpssStems(deckA);
  const stemmedB = await ensureInputHpssStems(safeDeckB);
  onProgress?.(14);

  const sampleRate = 44100;
  const aBpm = Math.max(72, Math.min(176, stemmedA.track.bpm || 124));
  const bBpm = Math.max(60, Math.min(176, stemmedB.track.bpm || 124));
  const beatSec = 60 / aBpm;
  const barSec = beatSec * 4;

  let rateB = aBpm / bBpm;
  if (rateB > 1.45) rateB *= 0.5;
  if (rateB < 0.65) rateB *= 2;
  rateB = Math.max(0.68, Math.min(1.42, rateB));

  const semitoneSnap = resolveSemitoneSnap(
    stemmedA.track.musicalKey,
    stemmedB.track.musicalKey,
    aBpm,
    bBpm
  );

  const qCueA = quantizeCueSec(stemmedA.track, 0.22, stemmedA.buffer.duration, cueASecOverride);
  const qCueB = quantizeCueSec(stemmedB.track, 0.18, stemmedB.buffer.duration, cueBSecOverride);

  const mashupBarOffset = mode === 'mashup-32' && preview8BarsOnly ? 16 : 0;
  const totalBars = preview8BarsOnly
    ? 8
    : mode === 'mashup-32'
    ? 32
    : Math.max(20, Math.min(32, 8 + transitionBars + 8));
  const isDjEdit = !preview8BarsOnly && renderVariant === 'dj-edit';
  const djIntroBars = isDjEdit ? 8 : 0;
  const djOutroBars = isDjEdit ? 8 : 0;
  const introDurSec = djIntroBars * barSec;
  const mainDurSec = totalBars * barSec;
  const totalSec = Math.max(preview8BarsOnly ? 10 : 24, Math.min(145, introDurSec + mainDurSec + djOutroBars * barSec + 1.4));

  const offlineCtx = new OfflineAudioContext(2, Math.ceil(totalSec * sampleRate), sampleRate);
  const noiseBuf = createSynthNoiseBuffer(offlineCtx, 0.35);
  const reverbImpulse = createSynthReverbImpulse(offlineCtx, 2.2, 2.7);

  // Master Chain + Voice Duck Pocket + Mastering Bus
  const masterSum = offlineCtx.createGain();
  const voiceDuckGain = offlineCtx.createGain();
  voiceDuckGain.gain.value = 1;
  const voiceDuckFilter = offlineCtx.createBiquadFilter();
  voiceDuckFilter.type = 'peaking';
  voiceDuckFilter.frequency.value = 1450;
  voiceDuckFilter.Q.value = 0.65;
  voiceDuckFilter.gain.value = 0;
  const postDuckSum = offlineCtx.createGain();

  const subTightHp = offlineCtx.createBiquadFilter();
  subTightHp.type = 'highpass';
  subTightHp.frequency.value = 26;

  const masterWarmth = offlineCtx.createBiquadFilter();
  masterWarmth.type = 'lowshelf';
  masterWarmth.frequency.value = 85;
  masterWarmth.gain.value = 0.8;

  const masterComp = offlineCtx.createDynamicsCompressor();
  masterComp.threshold.value = -11.5;
  masterComp.knee.value = 10;
  masterComp.ratio.value = 3.6;
  masterComp.attack.value = 0.004;
  masterComp.release.value = 0.14;

  const masterLimiter = offlineCtx.createDynamicsCompressor();
  masterLimiter.threshold.value = -1.2;
  masterLimiter.knee.value = 0;
  masterLimiter.ratio.value = 18;
  masterLimiter.attack.value = 0.001;
  masterLimiter.release.value = 0.08;

  const masterMakeup = offlineCtx.createGain();
  masterMakeup.gain.value = 1.15;

  masterSum.connect(voiceDuckGain);
  voiceDuckGain.connect(voiceDuckFilter);
  voiceDuckFilter.connect(postDuckSum);
  postDuckSum.connect(subTightHp);
  subTightHp.connect(masterWarmth);
  masterWarmth.connect(masterComp);
  masterComp.connect(masterLimiter);
  masterLimiter.connect(masterMakeup);
  masterMakeup.connect(offlineCtx.destination);

  onProgress?.(20);

  const trimA = resolveTrackTrimGain(stemmedA);
  const trimB = resolveTrackTrimGain(stemmedB);
  const chainA = createOfflineDeckChain(offlineCtx, masterSum, reverbImpulse, trimA);
  const chainB = createOfflineDeckChain(offlineCtx, masterSum, reverbImpulse, trimB);

  const hasStemsA = Boolean(stemmedA.harmonicBuffer && stemmedA.percussiveBuffer && stemmedA.bassBuffer);
  const hasStemsB = Boolean(stemmedB.harmonicBuffer && stemmedB.percussiveBuffer && stemmedB.bassBuffer);

  const prepBFull = prepareWindowBuffer({
    ctx: offlineCtx,
    source: stemmedB.buffer,
    cueSec: qCueB,
    neededOutputSec: mainDurSec + djOutroBars * barSec,
    tempoRatio: mode === 'ai-transition' ? 1.0 : rateB,
    semitoneShift: semitoneSnap.semitones,
    preservePitch,
  });

  scheduleStemSource(offlineCtx, stemmedA.buffer, chainA.fullGain, introDurSec, qCueA, mainDurSec + djOutroBars * barSec, 1);
  if (hasStemsA) {
    scheduleStemSource(offlineCtx, stemmedA.harmonicBuffer!, chainA.harmGain, introDurSec, qCueA, mainDurSec + djOutroBars * barSec, 1);
    scheduleStemSource(offlineCtx, stemmedA.percussiveBuffer!, chainA.percGain, introDurSec, qCueA, mainDurSec + djOutroBars * barSec, 1);
    scheduleStemSource(offlineCtx, stemmedA.bassBuffer!, chainA.bassGain, introDurSec, qCueA, mainDurSec + djOutroBars * barSec, 1);
  }

  // In AI Transition mode, allow smooth S-curve BPM glide from Deck A native BPM to Deck B native BPM across transition!
  const bTransitionRamps: TempoRampSegment[] = [];
  if (mode === 'ai-transition' && Math.abs(aBpm - bBpm) >= 1.5) {
    const tBarsLocal = preview8BarsOnly ? 6 : Math.max(4, Math.min(16, transitionBars));
    const leadBarsLocal = preview8BarsOnly ? 1 : 8;
    const rampStart = introDurSec + leadBarsLocal * barSec;
    const rampDur = tBarsLocal * barSec;
    bTransitionRamps.push({
      startSec: rampStart,
      durationSec: rampDur,
      startRate: rateB,
      endRate: 1.0,
    });
  }

  scheduleStemSource(
    offlineCtx,
    prepBFull.buffer,
    chainB.fullGain,
    introDurSec,
    prepBFull.offsetSec,
    mainDurSec + djOutroBars * barSec,
    prepBFull.playbackRate,
    bTransitionRamps
  );
  if (hasStemsB) {
    const pBH = prepareWindowBuffer({
      ctx: offlineCtx,
      source: stemmedB.harmonicBuffer!,
      cueSec: qCueB,
      neededOutputSec: mainDurSec + djOutroBars * barSec,
      tempoRatio: mode === 'ai-transition' ? 1.0 : rateB,
      semitoneShift: semitoneSnap.semitones,
      preservePitch,
    });
    const pBP = prepareWindowBuffer({
      ctx: offlineCtx,
      source: stemmedB.percussiveBuffer!,
      cueSec: qCueB,
      neededOutputSec: mainDurSec + djOutroBars * barSec,
      tempoRatio: mode === 'ai-transition' ? 1.0 : rateB,
      semitoneShift: semitoneSnap.semitones,
      preservePitch,
    });
    const pBB = prepareWindowBuffer({
      ctx: offlineCtx,
      source: stemmedB.bassBuffer!,
      cueSec: qCueB,
      neededOutputSec: mainDurSec + djOutroBars * barSec,
      tempoRatio: mode === 'ai-transition' ? 1.0 : rateB,
      semitoneShift: semitoneSnap.semitones,
      preservePitch,
    });
    scheduleStemSource(offlineCtx, pBH.buffer, chainB.harmGain, introDurSec, pBH.offsetSec, mainDurSec + djOutroBars * barSec, pBH.playbackRate, bTransitionRamps);
    scheduleStemSource(offlineCtx, pBP.buffer, chainB.percGain, introDurSec, pBP.offsetSec, mainDurSec + djOutroBars * barSec, pBP.playbackRate, bTransitionRamps);
    scheduleStemSource(offlineCtx, pBB.buffer, chainB.bassGain, introDurSec, pBB.offsetSec, mainDurSec + djOutroBars * barSec, pBB.playbackRate, bTransitionRamps);
  }

  onProgress?.(34);

  const cueEntries: CueSheetEntry[] = [];
  const shortA = stemmedA.track.title.split('(')[0].trim().slice(0, 22);
  const shortB = stemmedB.track.title.split('(')[0].trim().slice(0, 22);

  if (isDjEdit) {
    const djPattern: GrooveBridgePattern = mashupTemplate === 'hiphop-cut' ? 'sub-808' : 'house-4x4';
    scheduleGrooveBridgeWindow({
      ctx: offlineCtx,
      dest: masterSum,
      noiseBuf,
      pattern: djPattern,
      startAt: 0,
      bars: 8,
      bpm: aBpm,
      musicalKey: stemmedA.track.musicalKey,
    });
    scheduleGrooveBridgeWindow({
      ctx: offlineCtx,
      dest: masterSum,
      noiseBuf,
      pattern: djPattern,
      startAt: introDurSec + mainDurSec,
      bars: 8,
      bpm: mode === 'ai-transition' ? bBpm : aBpm,
      musicalKey: stemmedB.track.musicalKey,
    });
    cueEntries.push({
      atSec: 0,
      label: '8-Bar Quantized DJ Intro Loop',
      bpm: aBpm,
      key: stemmedA.track.musicalKey || '8A',
    });
  }

  if (effectiveVoicesAndFx && customIntroVoiceBuffer && !mutedPhaseSet.has(0)) {
    scheduleCustomVoiceBufferSynth({
      ctx: offlineCtx,
      dest: postDuckSum,
      reverbImpulse,
      buffer: customIntroVoiceBuffer,
      atTime: Math.max(0.25, introDurSec + 0.35),
      bpm: aBpm,
      volumeScale: Math.max(0.85, voiceVolume),
      onDuckWindow: (d) =>
        scheduleVoiceDuck(voiceDuckGain, voiceDuckFilter, Math.max(0.25, introDurSec + 0.35), d),
    });
  }

  if (mode === 'mashup-32') {
    const advice = computeOfflineMashupBlend({
      deckA: stemmedA.track,
      deckB: stemmedB.track,
      aggressiveness,
      sessionSeed,
      template: mashupTemplate,
      stemSwapMode,
    });
    const phases = advice.phases || [];

    for (let idx = 0; idx < phases.length; idx++) {
      const ph = phases[idx];
      if (preview8BarsOnly && (ph.barEnd <= mashupBarOffset || ph.barStart >= mashupBarOffset + 8)) {
        continue;
      }
      const effStartBar = Math.max(0, ph.barStart - mashupBarOffset);
      const effEndBar = preview8BarsOnly ? Math.min(8, ph.barEnd - mashupBarOffset) : ph.barEnd;
      const tStart = introDurSec + effStartBar * barSec;
      const tEnd = introDurSec + effEndBar * barSec;
      const phaseMuted = mutedPhaseSet.has(idx);

      cueEntries.push({
        atSec: tStart,
        label: ph.label || `Phase ${idx + 1}: ${shortA} × ${shortB}`,
        bpm: aBpm,
        key: stemmedA.track.musicalKey || '8A',
      });

      const aStem = variantStemOverride || stemModeFromIsolation(ph.deckAStemMode);
      const bStem = variantStemOverride || stemModeFromIsolation(ph.deckBStemMode);
      setOfflineStemMix(chainA, hasStemsA, aStem, tStart);
      setOfflineStemMix(chainB, hasStemsB, bStem, tStart);

      chainA.lowFilter.gain.setTargetAtTime(renderVariant === 'acapella' ? -18 : ph.deckAEqLow * 16, tStart, 0.03);
      chainA.midFilter.gain.setTargetAtTime(ph.deckAEqMid * 10, tStart, 0.03);
      chainA.highFilter.gain.setTargetAtTime(ph.deckAEqHigh * 10, tStart, 0.03);

      chainB.lowFilter.gain.setTargetAtTime(renderVariant === 'acapella' ? -18 : ph.deckBEqLow * 16, tStart, 0.03);
      chainB.midFilter.gain.setTargetAtTime(ph.deckBEqMid * 10, tStart, 0.03);
      chainB.highFilter.gain.setTargetAtTime(ph.deckBEqHigh * 10, tStart, 0.03);

      if (features.spectralSidechain !== false) {
        const aIsVoc = ph.deckAStemMode === 'vocal-focus';
        const bIsVoc = ph.deckBStemMode === 'vocal-focus';
        chainA.vocalSidechainFilter.gain.setTargetAtTime(bIsVoc && !aIsVoc ? -4.5 : 0, tStart, 0.04);
        chainB.vocalSidechainFilter.gain.setTargetAtTime(aIsVoc && !bIsVoc ? -4.5 : 0, tStart, 0.04);
      }

      const fA = ph.deckAFilter ?? 0;
      const fB = ph.deckBFilter ?? 0;
      if (!phaseMuted && fA > 0.05) {
        chainA.sweeperFilter.type = 'highpass';
        chainA.sweeperFilter.frequency.setValueAtTime(160, tStart);
        chainA.sweeperFilter.frequency.exponentialRampToValueAtTime(
          150 + fA * 1800,
          Math.max(tStart + 0.2, tEnd - beatSec * 0.5)
        );
      } else {
        chainA.sweeperFilter.type = 'allpass';
        chainA.sweeperFilter.frequency.setTargetAtTime(1000, tStart, 0.03);
      }

      if (!phaseMuted && fB > 0.05) {
        chainB.sweeperFilter.type = 'highpass';
        chainB.sweeperFilter.frequency.setValueAtTime(160, tStart);
        chainB.sweeperFilter.frequency.exponentialRampToValueAtTime(
          150 + fB * 1800,
          Math.max(tStart + 0.2, tEnd - beatSec * 0.5)
        );
      } else {
        chainB.sweeperFilter.type = 'allpass';
        chainB.sweeperFilter.frequency.setTargetAtTime(1000, tStart, 0.03);
      }

      if (effectiveVoicesAndFx && !phaseMuted) {
        scheduleOfflineFxAutomation(chainA, tStart, beatSec, ph.deckAFx);
        scheduleOfflineFxAutomation(chainB, tStart, beatSec, ph.deckBFx);
      } else {
        scheduleOfflineFxAutomation(chainA, tStart, beatSec, { enabled: false });
        scheduleOfflineFxAutomation(chainB, tStart, beatSec, { enabled: false });
      }

      if (ph.focusDeck === 'alternate' && ph.pingPongBars) {
        const segDur = Math.max(beatSec * 0.5, ph.pingPongBars * barSec);
        const totalSegs = Math.max(1, Math.floor((tEnd - tStart) / segDur));
        for (let s = 0; s < totalSegs; s++) {
          const ts = tStart + s * segDur;
          const aLead = s % 2 === 0;
          chainA.gain.gain.setTargetAtTime(aLead ? trimA : 0.14, ts, 0.014);
          chainB.gain.gain.setTargetAtTime(aLead ? 0.14 : trimB, ts, 0.014);
        }
      } else {
        const gainA = ph.crossfader > 0.35 ? 0.42 * trimA : trimA;
        const gainB = ph.crossfader < -0.35 ? 0.42 * trimB : trimB;
        chainA.gain.gain.setTargetAtTime(gainA, tStart, 0.025);
        chainB.gain.gain.setTargetAtTime(gainB, tStart, 0.025);
      }

      if (
        reharmonizeSynth &&
        renderVariant !== 'acapella' &&
        (ph.isDoubleDrop || idx === 0)
      ) {
        scheduleReharmonizerWindowSynth({
          ctx: offlineCtx,
          dest: masterSum,
          startAt: tStart,
          bars: Math.max(2, effEndBar - effStartBar),
          bpm: aBpm,
          musicalKey: stemmedA.track.musicalKey,
          intensity: ph.isDoubleDrop ? 0.78 : 0.56,
        });
      }

      if (
        effectiveVoicesAndFx &&
        !phaseMuted &&
        features.beatSliceStutter !== false &&
        (ph.scratchDeck || ph.cueJuggleDeck)
      ) {
        const targetChain = ph.scratchDeck === 'A' || ph.cueJuggleDeck === 'A' ? chainA : chainB;
        const baseTrim = targetChain === chainA ? trimA : trimB;
        const burstAt = Math.min(tEnd - beatSec * 1.2, tStart + barSec * 1.5);
        for (let k = 0; k < 4; k++) {
          const kt = burstAt + k * (beatSec * 0.25);
          targetChain.gain.gain.setValueAtTime(k % 2 === 0 ? baseTrim : 0.12, kt);
        }
        targetChain.gain.gain.setTargetAtTime(baseTrim, burstAt + beatSec * 1.1, 0.02);
        scheduleSoundTrickSynth({
          ctx: offlineCtx,
          dest: masterSum,
          type: 'scratch-chirp',
          atTime: burstAt,
          bpm: aBpm,
          musicalKey: stemmedA.track.musicalKey,
        });
      }

      if (effectiveVoicesAndFx && !phaseMuted && ph.tapeBrakeDeck) {
        const brakeAt = Math.max(tStart + 0.5, tEnd - beatSec * 1.5);
        scheduleSoundTrickSynth({
          ctx: offlineCtx,
          dest: masterSum,
          type: 'tape-rewind',
          atTime: brakeAt,
          bpm: aBpm,
          musicalKey: stemmedA.track.musicalKey,
        });
      }

      if (ph.silenceGapBeats && ph.silenceGapBeats > 0 && !phaseMuted) {
        const silenceAt = Math.max(tStart + 0.5, tEnd - beatSec * Math.min(1.1, ph.silenceGapBeats * 0.65));
        chainA.gain.gain.setValueAtTime(0.04, silenceAt);
        chainB.gain.gain.setValueAtTime(0.04, silenceAt);

        if (effectiveVoicesAndFx) {
          const buildStart = Math.max(tStart, tEnd - barSec * 2);
          const vId = pickOfflineVoice({
            voiceFxEnabled,
            voiceFrequency,
            enabledVoiceIds,
            customVoiceDrops,
            customVoiceBuffers,
            vibe,
            aggressiveness,
            seedOffset: sessionSeed + idx * 13,
          });
          scheduleBuildUpSequenceSynth({
            ctx: offlineCtx,
            dest: masterSum,
            voiceDest: postDuckSum,
            noiseBuf,
            reverbImpulse,
            startAt: buildStart,
            bpm: aBpm,
            musicalKey: stemmedA.track.musicalKey,
            bars: 2,
            voiceId: vId && !isCustomVoiceDropId(vId) ? vId : null,
            customVoiceBuffer: vId && isCustomVoiceDropId(vId) ? customVoiceBuffers[vId] || null : null,
            voiceVolumeScale: voiceFxEnabled ? voiceVolume : 0,
            onVoiceDuckWindow: (d) =>
              scheduleVoiceDuck(voiceDuckGain, voiceDuckFilter, Math.max(buildStart, tEnd - 0.55), d),
          });
        }
      }

      if (effectiveVoicesAndFx && !phaseMuted && ph.isDoubleDrop) {
        scheduleSoundTrickSynth({
          ctx: offlineCtx,
          dest: masterSum,
          type: 'sub-drop',
          atTime: tStart,
          bpm: aBpm,
          musicalKey: stemmedB.track.musicalKey,
        });
        if (
          features.autoGrooveBridge !== false &&
          (mashupTemplate === 'club-groove-swap' || mashupTemplate === 'festival-double-drop')
        ) {
          scheduleGrooveBridgeWindow({
            ctx: offlineCtx,
            dest: masterSum,
            noiseBuf,
            pattern: mashupTemplate === 'festival-double-drop' ? 'house-4x4' : 'top-hats',
            startAt: tStart,
            bars: 4,
            bpm: aBpm,
            musicalKey: stemmedA.track.musicalKey,
          });
        }
      } else if (effectiveVoicesAndFx && !phaseMuted && idx === 1) {
        const vId = pickOfflineVoice({
          voiceFxEnabled,
          voiceFrequency,
          enabledVoiceIds,
          customVoiceDrops,
          customVoiceBuffers,
          vibe,
          aggressiveness,
          seedOffset: sessionSeed + 7,
        });
        if (vId && voiceFrequency !== 'rare') {
          scheduleAnyVoiceOffline({
            ctx: offlineCtx,
            voiceDest: postDuckSum,
            voiceDuckGain,
            voiceDuckFilter,
            noiseBuf,
            reverbImpulse,
            voiceId: vId,
            customVoiceBuffers,
            atTime: Math.max(0.1, tStart - 0.25),
            bpm: aBpm,
            musicalKey: stemmedA.track.musicalKey,
            volumeScale: voiceVolume,
          });
        }
      }
    }
  } else {
    // AI Transition Edit (with S-curve BPM ramp from aBpm -> bBpm across transition window!)
    const plan = planOfflineTransition({
      outgoingTrack: stemmedA.track,
      currentBpm: aBpm,
      vibe,
      candidates: [stemmedB.track],
      aggressiveness,
      randomness,
      remixMode: true,
      sessionSeed,
      voiceFxEnabled: effectiveVoicesAndFx && voiceFxEnabled,
      voiceFrequency,
      enabledVoiceIds,
      enabledCustomDrops: customVoiceDrops,
      features,
    });

    const tBars = preview8BarsOnly ? 6 : Math.max(4, Math.min(16, plan.transitionBars || transitionBars));
    const leadSoloBars = preview8BarsOnly ? 1 : 8;
    const mixStart = introDurSec + leadSoloBars * barSec;
    const mixEnd = mixStart + tBars * barSec;
    const midMix = (mixStart + mixEnd) * 0.5;

    cueEntries.push(
      { atSec: introDurSec, label: shortA, bpm: aBpm, key: stemmedA.track.musicalKey || '8A', note: 'Outgoing Solo' },
      {
        atSec: mixStart,
        label: `${shortA} -> ${shortB}`,
        bpm: aBpm,
        key: stemmedB.track.musicalKey || '8A',
        note: Math.abs(aBpm - bBpm) >= 2 ? `Tempo Ramp ${Math.round(aBpm)}→${Math.round(bBpm)} BPM` : plan.mixStyle,
      },
      { atSec: mixEnd, label: shortB, bpm: bBpm, key: stemmedB.track.musicalKey || '8A', note: 'Incoming Native Solo' }
    );

    setOfflineStemMix(chainA, hasStemsA, variantStemOverride || 'off', introDurSec);
    setOfflineStemMix(chainB, hasStemsB, variantStemOverride || 'off', introDurSec);
    chainA.gain.gain.setValueAtTime(trimA, introDurSec);
    chainB.gain.gain.setValueAtTime(0, introDurSec);
    chainB.lowFilter.gain.setValueAtTime(-20, introDurSec);

    if (effectiveVoicesAndFx && !mutedPhaseSet.has(2)) {
      const buildVoice =
        plan.voiceDrops?.[0]?.voiceId ||
        pickOfflineVoice({
          voiceFxEnabled,
          voiceFrequency,
          enabledVoiceIds,
          customVoiceDrops,
          customVoiceBuffers,
          vibe,
          aggressiveness,
          seedOffset: sessionSeed + 3,
        });
      scheduleBuildUpSequenceSynth({
        ctx: offlineCtx,
        dest: masterSum,
        voiceDest: postDuckSum,
        noiseBuf,
        reverbImpulse,
        startAt: Math.max(introDurSec, midMix - 2 * barSec),
        bpm: aBpm,
        musicalKey: stemmedB.track.musicalKey,
        bars: 2,
        voiceId: buildVoice && !isCustomVoiceDropId(buildVoice) ? buildVoice : null,
        customVoiceBuffer:
          buildVoice && isCustomVoiceDropId(buildVoice) ? customVoiceBuffers[buildVoice] || null : null,
        voiceVolumeScale: voiceFxEnabled ? voiceVolume : 0,
        onVoiceDuckWindow: (d) =>
          scheduleVoiceDuck(voiceDuckGain, voiceDuckFilter, Math.max(introDurSec, midMix - 0.55), d),
      });

      if (
        features.autoGrooveBridge !== false &&
        plan.recommendedBridge &&
        plan.recommendedBridge !== 'off'
      ) {
        scheduleGrooveBridgeWindow({
          ctx: offlineCtx,
          dest: masterSum,
          noiseBuf,
          pattern: plan.recommendedBridge,
          startAt: mixStart,
          bars: Math.min(8, tBars),
          bpm: (aBpm + bBpm) * 0.5,
          musicalKey: stemmedA.track.musicalKey,
        });
      }

      if (features.beatSliceStutter !== false && plan.useBeatSliceStutter) {
        const sStart = Math.max(introDurSec + 0.5, midMix - barSec);
        for (let k = 0; k < 6; k++) {
          const kt = sStart + k * (beatSec * 0.5);
          chainA.gain.gain.setValueAtTime(k % 2 === 0 ? trimA : 0.1, kt);
        }
      }

      scheduleOfflineFxAutomation(chainA, midMix, beatSec, {
        enabled: true,
        type: 'dubdelay',
        wet: 0.48,
        beatDiv: 0.75,
      });
    }

    const bVoc = analyzeVocalProfile(stemmedB.track.title, stemmedB.track.artist, {
      detectedVocalDensity: stemmedB.track.detectedVocalDensity,
      vocalPockets: stemmedB.track.vocalPockets,
      durationSec: stemmedB.track.durationSec,
      bpm: bBpm,
    });
    if (
      features.spectralSidechain !== false &&
      (bVoc.density === 'vocal-dense' || bVoc.density === 'acapella')
    ) {
      chainA.vocalSidechainFilter.gain.setTargetAtTime(-4.6, mixStart, 0.05);
      chainA.vocalSidechainFilter.gain.setTargetAtTime(0, mixEnd, 0.08);
    }

    chainB.gain.gain.setValueAtTime(0.001, mixStart);
    chainB.gain.gain.linearRampToValueAtTime(trimB, midMix);

    chainA.lowFilter.gain.setValueAtTime(0, mixStart);
    chainA.lowFilter.gain.setTargetAtTime(-22, midMix, 0.03);
    chainB.lowFilter.gain.setValueAtTime(-20, mixStart);
    chainB.lowFilter.gain.setTargetAtTime(renderVariant === 'acapella' ? -18 : 1.2, midMix, 0.03);

    chainA.gain.gain.setValueAtTime(trimA, mixStart);
    chainA.gain.gain.linearRampToValueAtTime(0.76 * trimA, midMix);
    chainA.gain.gain.linearRampToValueAtTime(0.0001, mixEnd);
  }

  if (isDjEdit) {
    chainA.gain.gain.setTargetAtTime(0.0001, introDurSec + mainDurSec, 0.18);
    chainB.gain.gain.setTargetAtTime(0.0001, introDurSec + mainDurSec, 0.18);
  }

  const fadeStart = Math.max(1, totalSec - 1.2);
  masterMakeup.gain.setValueAtTime(1.15, fadeStart);
  masterMakeup.gain.linearRampToValueAtTime(0.0001, totalSec);

  onProgress?.(45);

  let fakePct = 46;
  const ticker = setInterval(() => {
    fakePct = Math.min(89, fakePct + 4);
    onProgress?.(fakePct);
  }, 140);

  let rendered: AudioBuffer;
  try {
    rendered = await offlineCtx.startRendering();
  } finally {
    clearInterval(ticker);
  }

  onProgress?.(94);
  const encoded = await encodeAudioBufferToOggOrCompactWav(
    rendered,
    exportFormat,
    masteringProfile
  );
  onProgress?.(100);

  const tplLabels: Record<MashupTemplateId, string> = {
    'club-groove-swap': 'Club Groove',
    'festival-double-drop': 'Festival Drop',
    'hiphop-cut': 'Hip-Hop Cut',
    'dub-echo-flip': 'Dub Echo Flip',
  };
  const label = preview8BarsOnly
    ? mode === 'mashup-32'
      ? `8-Bar ${tplLabels[mashupTemplate]} Preview`
      : '8-Bar Transition Preview'
    : customMixTitle ||
      (mode === 'mashup-32' ? `32-Bar ${tplLabels[mashupTemplate]}` : 'AI Remix Edit');
  const roleTag =
    renderVariant === 'instrumental'
      ? ' [Instrumental]'
      : renderVariant === 'acapella'
      ? ' [Acapella]'
      : renderVariant === 'dj-edit'
      ? ' [DJ 8-Bar Intro/Outro]'
      : '';
  const mixTitle = `${customMixTitle ? label : `${label} — ${shortA} × ${shortB}`}${roleTag}`;

  return {
    blob: encoded.blob,
    durationSec: rendered.duration,
    title: mixTitle,
    format: encoded.format,
    cueSheetText: buildCueSheetText(mixTitle, cueEntries),
    tracklistCount: 2,
    packRole: renderVariant,
    stemmedA,
    stemmedB,
  };
}
