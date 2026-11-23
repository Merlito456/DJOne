import {
  OverlapClashProfile,
  TempoSegmentPoint,
  TrackSectionLabel,
  TrackSectionSegment,
  WaveformBandSample,
} from '../types/dj';

/**
 * Extracts a 3-band (Low / Mid / High) RGB waveform representation from an AudioBuffer.
 * Uses simple IIR crossover filters per sample window for zero-latency computation.
 */
export function extractRgbWaveform(
  buffer: AudioBuffer,
  targetSamples = 1800
): WaveformBandSample[] {
  const ch0 = buffer.getChannelData(0);
  const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : ch0;
  const totalLen = ch0.length;
  if (totalLen === 0) return [];

  const blockSize = Math.max(1, Math.floor(totalLen / targetSamples));
  const out: WaveformBandSample[] = new Array(targetSamples);

  // Simple 1-pole lowpass / highpass state for band separation
  let lp1 = 0;
  let lp2 = 0;
  const alphaLow = 0.045;  // ~250 Hz at 44.1kHz
  const alphaMid = 0.28;   // ~2.2 kHz at 44.1kHz

  let maxPeak = 0.001;

  for (let i = 0; i < targetSamples; i++) {
    const start = i * blockSize;
    const end = Math.min(totalLen, start + blockSize);
    let lowSum = 0;
    let midSum = 0;
    let highSum = 0;
    let peak = 0;

    // Stride inside large blocks to keep analysis under ~25ms for 4-min tracks
    const stride = Math.max(1, Math.floor((end - start) / 64));
    let count = 0;

    for (let j = start; j < end; j += stride) {
      const s = 0.5 * (ch0[j] + ch1[j]);
      const abs = Math.abs(s);
      if (abs > peak) peak = abs;

      lp1 += alphaLow * (s - lp1);
      lp2 += alphaMid * (s - lp2);
      const low = lp1;
      const mid = lp2 - lp1;
      const high = s - lp2;

      lowSum += low * low;
      midSum += mid * mid;
      highSum += high * high;
      count++;
    }

    const inv = count > 0 ? 1 / count : 1;
    const lowRms = Math.sqrt(lowSum * inv);
    const midRms = Math.sqrt(midSum * inv);
    const highRms = Math.sqrt(highSum * inv);

    if (peak > maxPeak) maxPeak = peak;

    out[i] = {
      low: lowRms,
      mid: midRms,
      high: highRms,
      peak,
    };
  }

  // Normalize cleanly so visual headroom looks balanced
  const norm = 1 / Math.max(0.15, maxPeak);
  for (let i = 0; i < targetSamples; i++) {
    const b = out[i];
    out[i] = {
      low: Math.min(1, b.low * norm * 2.1),
      mid: Math.min(1, b.mid * norm * 2.3),
      high: Math.min(1, b.high * norm * 2.8),
      peak: Math.min(1, b.peak * norm),
    };
  }

  return out;
}

/**
 * Estimates BPM and first downbeat offset from an AudioBuffer using energy onset peaks.
 */
export function detectBpmAndGrid(buffer: AudioBuffer): { bpm: number; firstBeatSec: number } {
  const sampleRate = buffer.sampleRate;
  const ch0 = buffer.getChannelData(0);
  // Analyze up to first 45 seconds for speed
  const maxSamples = Math.min(ch0.length, sampleRate * 45);
  const hop = 512;
  const frames = Math.floor(maxSamples / hop);

  if (frames < 64) {
    return { bpm: 124, firstBeatSec: 0 };
  }

  // Low-frequency energy envelope
  const env = new Float32Array(frames);
  let lp = 0;
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const base = f * hop;
    for (let k = 0; k < hop; k += 4) {
      lp += 0.08 * (ch0[base + k] - lp);
      sum += lp * lp;
    }
    env[f] = Math.sqrt(sum / (hop / 4));
  }

  // Positive onset flux
  const flux = new Float32Array(frames);
  for (let f = 1; f < frames; f++) {
    flux[f] = Math.max(0, env[f] - env[f - 1]);
  }

  const fps = sampleRate / hop;
  const minBpm = 80;
  const maxBpm = 178;
  let bestBpm = 124;
  let bestScore = -1;

  for (let bpm = minBpm; bpm <= maxBpm; bpm += 0.5) {
    const periodFrames = (60 / bpm) * fps;
    let score = 0;
    for (let phase = 0; phase < Math.min(periodFrames, 16); phase += 1) {
      let phaseScore = 0;
      for (let t = phase; t < frames; t += periodFrames) {
        const idx = Math.round(t);
        if (idx < frames) phaseScore += flux[idx];
      }
      if (phaseScore > score) score = phaseScore;
    }
    // Slight preference for common DJ tempo range 110-140 to avoid half/double octave errors
    const weight = bpm >= 108 && bpm <= 145 ? 1.08 : 0.96;
    if (score * weight > bestScore) {
      bestScore = score * weight;
      bestBpm = bpm;
    }
  }

  // Find strongest downbeat within first 2 bars
  const beatSec = 60 / bestBpm;
  const searchFrames = Math.min(frames, Math.round(beatSec * 2 * fps));
  let peakFrame = 0;
  let peakVal = -1;
  for (let f = 0; f < searchFrames; f++) {
    if (flux[f] > peakVal) {
      peakVal = flux[f];
      peakFrame = f;
    }
  }

  const firstBeatSec = (peakFrame / fps) % beatSec;
  return {
    bpm: Math.round(bestBpm * 10) / 10,
    firstBeatSec: Math.round(firstBeatSec * 1000) / 1000,
  };
}

/**
 * Upgrade #5: Dynamic Elastic Phrase Beat-Grid Scanner (< 20ms).
 * Scans every ~16-bar phrase across the full AudioBuffer to capture local BPM
 * refinements & downbeat phase re-anchors for live drummers or tempo switches.
 */
export function buildElasticTempoMap(
  buffer: AudioBuffer,
  baseBpm: number,
  firstBeatSec: number
): TempoSegmentPoint[] {
  const sr = buffer.sampleRate;
  const ch0 = buffer.getChannelData(0);
  const dur = buffer.duration;
  const safeBaseBpm = Math.max(60, Math.min(195, baseBpm || 124));
  const phraseSec = (60 / safeBaseBpm) * 4 * 16; // 16 bars per checkpoint
  if (dur < phraseSec * 1.4 || ch0.length < sr * 20) {
    return [{ startSec: 0, bpm: safeBaseBpm, downbeatSec: firstBeatSec }];
  }

  const points: TempoSegmentPoint[] = [
    { startSec: 0, bpm: safeBaseBpm, downbeatSec: firstBeatSec },
  ];
  const hop = 512;
  const fps = sr / hop;
  const maxCheckpoints = 14;

  for (let startSec = phraseSec; startSec < dur - 12 && points.length < maxCheckpoints; startSec += phraseSec) {
    const winStartSample = Math.floor(startSec * sr);
    const winLenSamples = Math.min(ch0.length - winStartSample, Math.floor(sr * 18));
    const frames = Math.floor(winLenSamples / hop);
    if (frames < 48) break;

    const env = new Float32Array(frames);
    let lp = 0;
    for (let f = 0; f < frames; f++) {
      let sum = 0;
      const base = winStartSample + f * hop;
      for (let k = 0; k < hop; k += 8) {
        lp += 0.1 * (ch0[base + k] - lp);
        sum += lp * lp;
      }
      env[f] = Math.sqrt(sum / (hop / 8));
    }

    // Refine local BPM within ±4 BPM around baseBpm (plus check 0.5x/2x edge shifts lightly)
    let bestLocalBpm = safeBaseBpm;
    let bestScore = -1;
    let bestPhaseSec = 0;
    for (let candBpm = Math.max(60, safeBaseBpm - 4.0); candBpm <= Math.min(195, safeBaseBpm + 4.0); candBpm += 0.5) {
      const periodFrames = (60 / candBpm) * fps;
      for (let p = 0; p < Math.min(periodFrames, 14); p++) {
        let s = 0;
        for (let t = p; t < frames - 1; t += periodFrames) {
          const idx = Math.round(t);
          if (idx > 0 && idx < frames) {
            s += Math.max(0, env[idx] - env[idx - 1]);
          }
        }
        const bias = Math.abs(candBpm - safeBaseBpm) < 0.3 ? 1.04 : 1.0;
        if (s * bias > bestScore) {
          bestScore = s * bias;
          bestLocalBpm = candBpm;
          bestPhaseSec = (p / fps) % (60 / candBpm);
        }
      }
    }

    const downbeatSec = startSec + bestPhaseSec;
    points.push({
      startSec: Math.round(startSec * 100) / 100,
      bpm: Math.round(bestLocalBpm * 10) / 10,
      downbeatSec: Math.round(downbeatSec * 1000) / 1000,
    });
  }

  return points;
}

export function resolveElasticPhraseAtTime(
  tempoMap: TempoSegmentPoint[] | undefined,
  fallbackBpm: number,
  fallbackFirstBeatSec: number,
  timeSec: number
): { bpm: number; firstBeatSec: number } {
  if (!tempoMap || tempoMap.length === 0) {
    return { bpm: fallbackBpm, firstBeatSec: fallbackFirstBeatSec };
  }
  let active = tempoMap[0];
  for (let i = 1; i < tempoMap.length; i++) {
    if (timeSec >= tempoMap[i].startSec) {
      active = tempoMap[i];
    } else {
      break;
    }
  }
  return {
    bpm: active.bpm || fallbackBpm,
    firstBeatSec: typeof active.downbeatSec === 'number' ? active.downbeatSec : fallbackFirstBeatSec,
  };
}

/**
 * Generates a deterministic, beat-grid-aligned RGB spectral waveform for YouTube IFrame tracks
 * where raw PCM samples aren't directly accessible due to cross-origin iframe isolation.
 */
export function generateDeterministicBeatWaveform(
  seedKey: string,
  durationSec: number,
  bpm: number,
  targetSamples = 1800
): WaveformBandSample[] {
  let seed = 2166136261;
  for (let i = 0; i < seedKey.length; i++) {
    seed ^= seedKey.charCodeAt(i);
    seed = Math.imul(seed, 16777619);
  }
  const rand = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return ((seed >>> 0) % 10000) / 10000;
  };

  const out: WaveformBandSample[] = new Array(targetSamples);
  const beatInterval = 60 / Math.max(60, bpm);
  const totalSec = Math.max(30, durationSec);

  for (let i = 0; i < targetSamples; i++) {
    const t = (i / targetSamples) * totalSec;
    const progress = i / targetSamples;

    // Intro/outro energy envelope
    const intro = Math.min(1, progress / 0.08);
    const outro = Math.min(1, (1 - progress) / 0.08);
    const barIndex = Math.floor(t / (beatInterval * 4));
    const sectionEnergy =
      barIndex % 16 >= 12 && barIndex % 16 < 14
        ? 0.45 // breakdown
        : 0.85 + 0.15 * Math.sin(barIndex * 0.4);

    const beatPhase = (t % beatInterval) / beatInterval;
    const kickPulse = Math.exp(-beatPhase * 7.5);
    const hatPulse = Math.exp(-(((t + beatInterval * 0.5) % beatInterval) / beatInterval) * 10);

    const env = Math.min(intro, outro) * sectionEnergy;
    const jitter = 0.78 + rand() * 0.32;

    const low = Math.min(1, (0.2 + kickPulse * 0.78) * env * jitter);
    const mid = Math.min(1, (0.25 + 0.45 * Math.sin(t * 2.2 + rand()) ** 2) * env * jitter);
    const high = Math.min(1, (0.12 + hatPulse * 0.65) * env * (0.7 + rand() * 0.4));
    const peak = Math.min(1, Math.max(low, mid * 0.9, high * 0.85));

    out[i] = { low, mid, high, peak };
  }

  return out;
}

/**
 * Encodes interleaved stereo Float32 PCM chunks into a downloadable 16-bit PCM WAV Blob.
 */
export function encodeStereoChunksToWav(
  leftChunks: Float32Array[],
  rightChunks: Float32Array[],
  sampleRate: number
): Blob {
  let totalFrames = 0;
  for (let i = 0; i < leftChunks.length; i++) {
    totalFrames += leftChunks[i].length;
  }

  const numChannels = 2;
  const bytesPerSample = 2;
  const dataSize = totalFrames * numChannels * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true);  // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * bytesPerSample, true);
  view.setUint16(32, numChannels * bytesPerSample, true);
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let c = 0; c < leftChunks.length; c++) {
    const l = leftChunks[c];
    const r = rightChunks[c] || l;
    for (let i = 0; i < l.length; i++) {
      const ls = Math.max(-1, Math.min(1, l[i]));
      const rs = Math.max(-1, Math.min(1, r[i]));
      view.setInt16(offset, ls < 0 ? ls * 0x8000 : ls * 0x7fff, true);
      view.setInt16(offset + 2, rs < 0 ? rs * 0x8000 : rs * 0x7fff, true);
      offset += 4;
    }
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

/**
 * Offline MIR #1: Fast (< 5ms) Structure & Auto-Drop Segmentation from 3-band RGB waveform.
 * Identifies Intro, Verse, Build, Drop (strongest bass-return after breakdown), Breakdown, and Outro.
 */
export function segmentTrackStructure(
  waveform: WaveformBandSample[],
  durationSec: number,
  bpm: number
): { segments: TrackSectionSegment[]; autoDropSec: number } {
  const dur = Math.max(20, durationSec || 180);
  if (!waveform || waveform.length < 32) {
    return {
      segments: [
        { label: 'intro', startSec: 0, endSec: dur * 0.14, energy: 0.45 },
        { label: 'verse', startSec: dur * 0.14, endSec: dur * 0.45, energy: 0.68 },
        { label: 'build', startSec: dur * 0.45, endSec: dur * 0.56, energy: 0.78 },
        { label: 'drop', startSec: dur * 0.56, endSec: dur * 0.84, energy: 0.94 },
        { label: 'outro', startSec: dur * 0.84, endSec: dur, energy: 0.4 },
      ],
      autoDropSec: Math.round(dur * 0.56 * 100) / 100,
    };
  }

  const barSec = (60 / Math.max(60, bpm || 124)) * 4;
  const windowSec = Math.max(barSec * 4, dur / 18);
  const numWins = Math.max(6, Math.min(20, Math.round(dur / windowSec)));
  const samplesPerWin = Math.max(1, Math.floor(waveform.length / numWins));

  const winLow: number[] = [];
  const winTotal: number[] = [];
  for (let w = 0; w < numWins; w++) {
    const start = w * samplesPerWin;
    const end = w === numWins - 1 ? waveform.length : Math.min(waveform.length, start + samplesPerWin);
    let lSum = 0;
    let eSum = 0;
    let count = 0;
    for (let i = start; i < end; i++) {
      const s = waveform[i];
      lSum += s.low;
      eSum += s.low * 0.55 + s.mid * 0.25 + s.high * 0.2;
      count++;
    }
    const inv = count > 0 ? 1 / count : 1;
    winLow.push(lSum * inv);
    winTotal.push(eSum * inv);
  }

  // Locate loudest bass-return drop between 22% and 78% of track duration
  let bestDropWin = Math.floor(numWins * 0.55);
  let bestDropContrast = -Infinity;
  const startSearch = Math.max(1, Math.floor(numWins * 0.22));
  const endSearch = Math.min(numWins - 2, Math.floor(numWins * 0.78));
  for (let w = startSearch; w <= endSearch; w++) {
    const jump = winLow[w] - winLow[w - 1] * 0.85;
    const sustain = winTotal[w] * 0.7 + (winTotal[w + 1] ?? winTotal[w]) * 0.3;
    const score = jump * 1.45 + sustain;
    if (score > bestDropContrast) {
      bestDropContrast = score;
      bestDropWin = w;
    }
  }

  const avgEnergy = winTotal.reduce((a, b) => a + b, 0) / numWins;
  const segments: TrackSectionSegment[] = [];

  for (let w = 0; w < numWins; w++) {
    const sSec = Math.round(((w / numWins) * dur) * 100) / 100;
    const eSec = Math.round((((w + 1) / numWins) * dur) * 100) / 100;
    const energy = Math.round(winTotal[w] * 100) / 100;

    let label: TrackSectionLabel = 'verse';
    if (w === 0) {
      label = 'intro';
    } else if (w >= numWins - 2 && energy <= avgEnergy * 0.95) {
      label = 'outro';
    } else if (w === bestDropWin - 1) {
      label = 'build';
    } else if (w === bestDropWin || (w === bestDropWin + 1 && energy >= avgEnergy * 0.92)) {
      label = 'drop';
    } else if (winLow[w] < avgEnergy * 0.65 && w > 1 && w < numWins - 2) {
      label = 'breakdown';
    } else if (energy >= avgEnergy * 1.12 && w > 1) {
      label = 'drop';
    }

    const prev = segments[segments.length - 1];
    if (prev && prev.label === label) {
      prev.endSec = eSec;
      prev.energy = Math.round(((prev.energy + energy) * 0.5) * 100) / 100;
    } else {
      segments.push({ label, startSec: sSec, endSec: eSec, energy });
    }
  }

  const rawDropSec = (bestDropWin / numWins) * dur;
  const qBar = Math.round(rawDropSec / barSec) * barSec;
  const autoDropSec = Math.round(Math.max(8, Math.min(dur - 8, qBar)) * 100) / 100;

  return { segments, autoDropSec };
}

// Krumhansl-Schmuckler major & minor pitch profiles (C=0 .. B=11)
const KS_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KS_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

// Camelot wheel codes indexed by tonic pitch class 0=C .. 11=B
const PITCH_TO_CAMELOT_MAJOR = ['8B', '3B', '10B', '5B', '12B', '7B', '2B', '9B', '4B', '11B', '6B', '1B'];
const PITCH_TO_CAMELOT_MINOR = ['5A', '12A', '7A', '2A', '9A', '4A', '11A', '6A', '1A', '8A', '3A', '10A'];

/**
 * Offline MIR #2: Fast (< 15ms) 12-Bin Goertzel Chromagram & Krumhansl-Schmuckler Camelot Key Detector.
 * Runs entirely in-browser on decoded AudioBuffers with zero external APIs.
 */
export function detectCamelotKey(buffer: AudioBuffer): { musicalKey: string; confidence: number } {
  const sampleRate = buffer.sampleRate;
  const ch0 = buffer.getChannelData(0);
  if (ch0.length < 4096) return { musicalKey: '8A', confidence: 0 };

  const chroma = new Float64Array(12);
  const frameLen = 2048;
  const numFrames = 10;
  const stride = Math.max(frameLen, Math.floor((ch0.length - frameLen) / numFrames));

  // Probe MIDI notes 36 (C2 = 65.4Hz) .. 71 (B4 = 493.88Hz) across 3 musical octaves
  const probeOmegas: { pc: number; coeff: number }[] = [];
  for (let midi = 36; midi <= 71; midi++) {
    const freq = 440 * Math.pow(2, (midi - 69) / 12);
    const omega = (2 * Math.PI * freq) / sampleRate;
    probeOmegas.push({ pc: midi % 12, coeff: 2 * Math.cos(omega) });
  }

  for (let f = 0; f < numFrames; f++) {
    const offset = f * stride;
    if (offset + frameLen >= ch0.length) break;

    for (let p = 0; p < probeOmegas.length; p++) {
      const { pc, coeff } = probeOmegas[p];
      let s0 = 0;
      let s1 = 0;
      let s2 = 0;
      // Downsample stride-2 inside frame for < 10ms analysis
      for (let i = 0; i < frameLen; i += 2) {
        s0 = ch0[offset + i] + coeff * s1 - s2;
        s2 = s1;
        s1 = s0;
      }
      const magSq = Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2);
      chroma[pc] += Math.sqrt(magSq);
    }
  }

  let chromaSum = 0;
  for (let i = 0; i < 12; i++) chromaSum += chroma[i];
  if (chromaSum <= 1e-6) return { musicalKey: '8A', confidence: 0 };
  const chromaMean = chromaSum / 12;

  const pearson = (profile: number[], shift: number) => {
    let pMean = 0;
    for (let i = 0; i < 12; i++) pMean += profile[i];
    pMean /= 12;

    let num = 0;
    let denA = 0;
    let denB = 0;
    for (let i = 0; i < 12; i++) {
      const a = chroma[(i + shift) % 12] - chromaMean;
      const b = profile[i] - pMean;
      num += a * b;
      denA += a * a;
      denB += b * b;
    }
    const den = Math.sqrt(denA * denB);
    return den > 0 ? num / den : 0;
  };

  let bestScore = -1;
  let secondScore = -1;
  let bestKey = '8A';

  for (let tonic = 0; tonic < 12; tonic++) {
    const maj = pearson(KS_MAJOR, tonic);
    if (maj > bestScore) {
      secondScore = bestScore;
      bestScore = maj;
      bestKey = PITCH_TO_CAMELOT_MAJOR[tonic];
    } else if (maj > secondScore) {
      secondScore = maj;
    }

    const min = pearson(KS_MINOR, tonic);
    if (min > bestScore) {
      secondScore = bestScore;
      bestScore = min;
      bestKey = PITCH_TO_CAMELOT_MINOR[tonic];
    } else if (min > secondScore) {
      secondScore = min;
    }
  }

  const confidence = Math.max(0, Math.min(1, bestScore - Math.max(0, secondScore) + 0.35));
  return {
    musicalKey: bestKey,
    confidence: Math.round(confidence * 100) / 100,
  };
}

/**
 * Offline MIR #3 (Advance #4): Fast (< 8ms) K-weighted RMS / Perceived LUFS Auto-Gain estimator.
 * Targets consistent club loudness (~ -11 LUFS) across quiet rips and hot masters.
 */
export function estimateTrackLoudnessGain(buffer: AudioBuffer): {
  estimatedLufs: number;
  autoTrimGain: number;
} {
  const ch0 = buffer.getChannelData(0);
  const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : ch0;
  const totalLen = ch0.length;
  if (totalLen < 2048) return { estimatedLufs: -11, autoTrimGain: 1 };

  const numWins = 12;
  const winLen = Math.min(4096, Math.floor(totalLen / numWins));
  const step = Math.max(1, Math.floor(totalLen / numWins));

  let activeRmsSum = 0;
  let activeCount = 0;
  let hp = 0;

  for (let w = 0; w < numWins; w++) {
    const start = w * step;
    const end = Math.min(totalLen, start + winLen);
    let sqSum = 0;
    let count = 0;
    for (let i = start; i < end; i += 4) {
      const mono = 0.5 * (ch0[i] + ch1[i]);
      // Gentle K-weighting high-pass shelf simulation (~120Hz rolloff + presence boost)
      hp += 0.14 * (mono - hp);
      const weighted = mono - hp * 0.45;
      sqSum += weighted * weighted;
      count++;
    }
    const rms = count > 0 ? Math.sqrt(sqSum / count) : 0;
    if (rms > 0.015) {
      activeRmsSum += rms;
      activeCount++;
    }
  }

  const avgRms = activeCount > 0 ? activeRmsSum / activeCount : 0.18;
  const lufs = Math.max(-28, Math.min(-3, 20 * Math.log10(Math.max(0.001, avgRms)) - 0.8));
  const deltaDb = Math.max(-6.5, Math.min(4.2, -11.0 - lufs));
  const linearGain = Math.pow(10, deltaDb / 20);
  const clampedGain = Math.round(Math.max(0.55, Math.min(1.38, linearGain)) * 100) / 100;

  return {
    estimatedLufs: Math.round(lufs * 10) / 10,
    autoTrimGain: clampedGain,
  };
}

/**
 * Computes consistent trim gain directly from a track's RGB waveform when PCM is isolated (YouTube IFrame).
 */
export function computeWaveformLoudnessGain(waveform: WaveformBandSample[]): number {
  if (!waveform || waveform.length < 16) return 1;
  let sum = 0;
  let active = 0;
  const stride = Math.max(1, Math.floor(waveform.length / 180));
  for (let i = 0; i < waveform.length; i += stride) {
    const s = waveform[i];
    const e = s.low * 0.45 + s.mid * 0.35 + s.high * 0.2;
    if (e > 0.12) {
      sum += e;
      active++;
    }
  }
  const avg = active > 0 ? sum / active : 0.45;
  const gain = 0.46 / Math.max(0.24, avg);
  return Math.round(Math.max(0.75, Math.min(1.22, gain)) * 100) / 100;
}

/**
 * Offline MIR #4 (Advance #2): Overlap Window RGB Clash Matrix (< 2ms).
 * Compares outgoing & incoming 3-band spectral density across the exact mix window
 * to carve Bass/Mid pockets only where collisions actually happen.
 */
export function analyzeOverlapClash(
  wfOut: WaveformBandSample[] | undefined,
  wfIn: WaveformBandSample[] | undefined,
  outStartPct = 0.55,
  inStartPct = 0.06,
  overlapPct = 0.12
): OverlapClashProfile {
  if (!wfOut || wfOut.length < 24 || !wfIn || wfIn.length < 24) {
    return {
      bassClash: 0.45,
      midClash: 0.4,
      recommendedOutLowCut: -0.78,
      recommendedOutMidCut: -0.35,
      recommendedInMidCut: -0.15,
      summary: 'Standard harmonic pocket carve',
    };
  }

  const steps = 24;
  let bassProdSum = 0;
  let midProdSum = 0;

  for (let i = 0; i < steps; i++) {
    const t = i / steps;
    const oIdx = Math.min(
      wfOut.length - 1,
      Math.max(0, Math.floor((outStartPct + t * overlapPct) * wfOut.length))
    );
    const iIdx = Math.min(
      wfIn.length - 1,
      Math.max(0, Math.floor((inStartPct + t * overlapPct) * wfIn.length))
    );
    const o = wfOut[oIdx];
    const n = wfIn[iIdx];
    bassProdSum += Math.min(1, o.low * n.low * 1.45);
    midProdSum += Math.min(1, o.mid * n.mid * 1.45);
  }

  const bassClash = Math.round((bassProdSum / steps) * 100) / 100;
  const midClash = Math.round((midProdSum / steps) * 100) / 100;

  // Compute adaptive EQ targets: heavy collision -> steep pocket; sparse breakdown -> warm blend
  const recommendedOutLowCut =
    bassClash >= 0.55 ? -0.98 : bassClash >= 0.32 ? -0.82 : -0.45;
  const recommendedOutMidCut =
    midClash >= 0.55 ? -0.78 : midClash >= 0.32 ? -0.45 : -0.18;
  const recommendedInMidCut =
    midClash >= 0.55 ? -0.42 : midClash >= 0.32 ? -0.2 : -0.05;

  const summary =
    bassClash >= 0.55 && midClash >= 0.5
      ? 'Dense low+mid collision: deep pocket carve'
      : bassClash >= 0.52
      ? 'Sub collision guard: steep bass swap'
      : midClash >= 0.52
      ? 'Mid vocal/synth density: mid carve active'
      : 'Sparse breakdown window: warm wide blend';

  return {
    bassClash,
    midClash,
    recommendedOutLowCut,
    recommendedOutMidCut,
    recommendedInMidCut,
    summary,
  };
}

/**
 * Sliding-Window "Sparsest Pocket" Mashup Cue Finder (< 2ms).
 * Scans Track A's back half × Track B's first 38% to find the exact bar-quantized
 * overlap window with minimal bass+mid collision while preserving incoming melodic presence.
 */
export function findSparsestMashupPocket(params: {
  wfOut: WaveformBandSample[] | undefined;
  wfIn: WaveformBandSample[] | undefined;
  outBpm?: number;
  outDurationSec?: number;
  inBpm?: number;
  inDurationSec?: number;
  minOutPct?: number;
  maxOutPct?: number;
  preferredBars?: number;
}): {
  outStartPct: number;
  inStartPct: number;
  recommendedBars: 4 | 8 | 12 | 16;
  clashProfile: OverlapClashProfile;
  pocketSummary: string;
} {
  const {
    wfOut,
    wfIn,
    outBpm = 124,
    outDurationSec = 180,
    inBpm = 124,
    inDurationSec = 180,
    minOutPct = 0.34,
    maxOutPct = 0.72,
    preferredBars = 8,
  } = params;

  const fallbackOutPct = Math.max(minOutPct, Math.min(maxOutPct, 0.52));
  const fallbackInPct = 0.08;
  const clampedFallbackBars: 4 | 8 | 12 | 16 =
    preferredBars <= 4 ? 4 : preferredBars <= 8 ? 8 : preferredBars <= 12 ? 12 : 16;

  if (!wfOut || wfOut.length < 24 || !wfIn || wfIn.length < 24) {
    return {
      outStartPct: fallbackOutPct,
      inStartPct: fallbackInPct,
      recommendedBars: clampedFallbackBars,
      clashProfile: analyzeOverlapClash(wfOut, wfIn, fallbackOutPct, fallbackInPct, 0.12),
      pocketSummary: 'Standard bar-quantized pocket',
    };
  }

  const outDur = Math.max(30, outDurationSec);
  const inDur = Math.max(30, inDurationSec);
  const outBarSec = (60 / Math.max(60, outBpm)) * 4;
  const inBarSec = (60 / Math.max(60, inBpm)) * 4;

  const candidateBarCounts: (8 | 12 | 16)[] =
    preferredBars <= 8 ? [8, 12] : [8, 12, 16];

  let bestScore = Infinity;
  let bestOutPct = fallbackOutPct;
  let bestInPct = fallbackInPct;
  let bestBars: 4 | 8 | 12 | 16 = clampedFallbackBars;

  const safeMinOut = Math.max(0.28, Math.min(0.75, minOutPct));
  const safeMaxOut = Math.max(safeMinOut + 0.04, Math.min(0.84, maxOutPct));

  for (const bars of candidateBarCounts) {
    const outOverlapPct = Math.min(0.24, Math.max(0.06, (bars * outBarSec) / outDur));
    const inOverlapPct = Math.min(0.24, Math.max(0.06, (bars * inBarSec) / inDur));

    for (let oPct = safeMinOut; oPct <= safeMaxOut; oPct += 0.04) {
      if (oPct + outOverlapPct > 0.94) continue;
      for (let iPct = 0.02; iPct <= 0.34; iPct += 0.03) {
        if (iPct + inOverlapPct > 0.55) continue;

        let bassOverlap = 0;
        let midOverlap = 0;
        let inEnergy = 0;
        const steps = 10;

        for (let k = 0; k < steps; k++) {
          const frac = k / steps;
          const oIdx = Math.min(
            wfOut.length - 1,
            Math.max(0, Math.floor((oPct + frac * outOverlapPct) * wfOut.length))
          );
          const iIdx = Math.min(
            wfIn.length - 1,
            Math.max(0, Math.floor((iPct + frac * inOverlapPct) * wfIn.length))
          );
          const o = wfOut[oIdx];
          const n = wfIn[iIdx];
          bassOverlap += o.low * n.low;
          midOverlap += o.mid * n.mid;
          inEnergy += n.low * 0.35 + n.mid * 0.45 + n.high * 0.2;
        }

        const avgBass = bassOverlap / steps;
        const avgMid = midOverlap / steps;
        const avgIn = inEnergy / steps;
        // Penalize completely silent incoming cue regions slightly so blend enters with groove
        const silencePenalty = avgIn < 0.14 ? (0.14 - avgIn) * 1.4 : 0;
        const barBias = Math.abs(bars - preferredBars) * 0.008;
        const score = avgBass * 1.35 + avgMid * 1.15 + silencePenalty + barBias;

        if (score < bestScore) {
          bestScore = score;
          bestOutPct = oPct;
          bestInPct = iPct;
          bestBars = bars;
        }
      }
    }
  }

  // Quantize bestOutPct and bestInPct cleanly to nearest bar
  const outBars = Math.round((bestOutPct * outDur) / outBarSec);
  const inBars = Math.round((bestInPct * inDur) / inBarSec);
  const qOutPct = Math.max(
    safeMinOut,
    Math.min(safeMaxOut, Math.round(((outBars * outBarSec) / outDur) * 1000) / 1000)
  );
  const qInPct = Math.max(
    0.02,
    Math.min(0.32, Math.round(((inBars * inBarSec) / inDur) * 1000) / 1000)
  );
  const qOverlapPct = Math.min(0.22, Math.max(0.08, (bestBars * outBarSec) / outDur));
  const clashProfile = analyzeOverlapClash(wfOut, wfIn, qOutPct, qInPct, qOverlapPct);

  return {
    outStartPct: qOutPct,
    inStartPct: qInPct,
    recommendedBars: preferredBars <= 4 ? 4 : bestBars,
    clashProfile,
    pocketSummary: `Pocket @ ${Math.round(qOutPct * 100)}%→${Math.round(qInPct * 100)}% (${bestBars}b · ${Math.round((1 - (clashProfile.bassClash + clashProfile.midClash) * 0.5) * 100)}% clean)`,
  };
}

