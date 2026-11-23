import { AiDjVibe, TrackItem } from '../types/dj';
import { planOfflineTransition } from './offlineAiDj';

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
}

const CAMELOT_TO_ROOT_MIDI: Record<number, number> = {
  1: 56, 2: 51, 3: 58, 4: 53, 5: 60, 6: 55,
  7: 50, 8: 57, 9: 52, 10: 59, 11: 54, 12: 49,
};

function camelotRootMidi(musicalKey?: string): number {
  const m = String(musicalKey || '').trim().toUpperCase().match(/^(\d{1,2})([AB])$/);
  if (!m) return 57; // A minor fallback
  const num = parseInt(m[1], 10);
  const letter = m[2];
  const minorBase = CAMELOT_TO_ROOT_MIDI[num] ?? 57;
  return letter === 'B' ? minorBase - 3 : minorBase;
}

function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function encodeAudioBufferToWav(audioBuffer: AudioBuffer): Blob {
  const numChannels = Math.min(2, audioBuffer.numberOfChannels);
  const sampleRate = audioBuffer.sampleRate;
  const length = audioBuffer.length;
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
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM
  view.setUint16(20, 1, true); // linear PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  const ch0 = audioBuffer.getChannelData(0);
  const ch1 = numChannels > 1 ? audioBuffer.getChannelData(1) : ch0;

  // Normalize slightly below -0.8dB FS so club renders never clip on playback
  let maxPeak = 0;
  for (let i = 0; i < length; i++) {
    const p0 = Math.abs(ch0[i]);
    const p1 = Math.abs(ch1[i]);
    if (p0 > maxPeak) maxPeak = p0;
    if (p1 > maxPeak) maxPeak = p1;
  }
  const normGain = maxPeak > 0.001 ? Math.min(1.4, 0.912 / maxPeak) : 1;

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

function scheduleOfflineNoiseRiser(
  ctx: OfflineAudioContext,
  dest: AudioNode,
  startTime: number,
  durationSec: number,
  gainAmount = 0.24
) {
  if (durationSec <= 0.2) return;
  const len = Math.floor(ctx.sampleRate * durationSec);
  const noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = noiseBuf.getChannelData(0);
  for (let i = 0; i < len; i++) {
    data[i] = Math.random() * 2 - 1;
  }
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;

  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.Q.value = 3.2;
  filter.frequency.setValueAtTime(240, startTime);
  filter.frequency.exponentialRampToValueAtTime(6800, startTime + durationSec);

  const g = ctx.createGain();
  g.gain.setValueAtTime(0.001, startTime);
  g.gain.exponentialRampToValueAtTime(gainAmount, startTime + durationSec * 0.9);
  g.gain.linearRampToValueAtTime(0.0001, startTime + durationSec);

  src.connect(filter);
  filter.connect(g);
  g.connect(dest);
  src.start(startTime);
  src.stop(startTime + durationSec + 0.02);
}

function scheduleOfflineSubDrop(
  ctx: OfflineAudioContext,
  dest: AudioNode,
  atTime: number,
  musicalKey?: string
) {
  const rootMidi = camelotRootMidi(musicalKey) - 12;
  const baseHz = Math.max(36, Math.min(68, midiToHz(rootMidi)));

  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(baseHz * 2.2, atTime);
  osc.frequency.exponentialRampToValueAtTime(baseHz * 0.72, atTime + 0.75);

  const g = ctx.createGain();
  g.gain.setValueAtTime(0.001, atTime);
  g.gain.linearRampToValueAtTime(0.62, atTime + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, atTime + 1.05);

  osc.connect(g);
  g.connect(dest);
  osc.start(atTime);
  osc.stop(atTime + 1.1);
}

function scheduleOfflineSnareBuild(
  ctx: OfflineAudioContext,
  dest: AudioNode,
  startTime: number,
  buildSec: number,
  beatSec: number
) {
  const totalSteps = Math.max(4, Math.floor(buildSec / (beatSec / 4)));
  const len = Math.floor(ctx.sampleRate * 0.14);
  const snareNoise = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = snareNoise.getChannelData(0);
  for (let i = 0; i < len; i++) {
    d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.032));
  }

  for (let i = 0; i < totalSteps; i++) {
    const prog = i / totalSteps;
    // Escalate density: quarter -> eighth -> 16th in final 2 beats
    if (prog < 0.45 && i % 4 !== 0) continue;
    if (prog >= 0.45 && prog < 0.75 && i % 2 !== 0) continue;
    const t = startTime + i * (beatSec / 4);
    const src = ctx.createBufferSource();
    src.buffer = snareNoise;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1100 + prog * 1400;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.12 + prog * 0.24, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.11);
    src.connect(hp);
    hp.connect(g);
    g.connect(dest);
    src.start(t);
  }
}

interface OfflineDeckNodes {
  lowFilter: BiquadFilterNode;
  midFilter: BiquadFilterNode;
  highFilter: BiquadFilterNode;
  sweeperFilter: BiquadFilterNode;
  gain: GainNode;
  fullGain: GainNode;
  harmGain: GainNode;
  percGain: GainNode;
  bassGain: GainNode;
}

function createOfflineDeckChain(
  ctx: OfflineAudioContext,
  dest: AudioNode,
  trimGain = 0.9
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

  const highFilter = ctx.createBiquadFilter();
  highFilter.type = 'highshelf';
  highFilter.frequency.value = 3400;

  const sweeperFilter = ctx.createBiquadFilter();
  sweeperFilter.type = 'allpass';
  sweeperFilter.frequency.value = 1000;

  const gain = ctx.createGain();
  gain.gain.value = Math.max(0.25, Math.min(1.25, trimGain));

  fullGain.connect(lowFilter);
  harmGain.connect(lowFilter);
  percGain.connect(lowFilter);
  bassGain.connect(lowFilter);

  lowFilter.connect(midFilter);
  midFilter.connect(highFilter);
  highFilter.connect(sweeperFilter);
  sweeperFilter.connect(gain);
  gain.connect(dest);

  return {
    lowFilter,
    midFilter,
    highFilter,
    sweeperFilter,
    gain,
    fullGain,
    harmGain,
    percGain,
    bassGain,
  };
}

function scheduleStemSource(
  ctx: OfflineAudioContext,
  buf: AudioBuffer,
  targetNode: AudioNode,
  startAtCtxTime: number,
  offsetSec: number,
  playDurationSec: number,
  playbackRate: number
) {
  const safeOffset = Math.max(0, Math.min(Math.max(0, buf.duration - 2), offsetSec));
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = Math.max(0.65, Math.min(1.45, playbackRate));
  src.loop = true;
  src.loopStart = 0;
  src.loopEnd = Math.max(4, buf.duration - 0.1);
  src.connect(targetNode);
  src.start(startAtCtxTime, safeOffset);
  src.stop(startAtCtxTime + playDurationSec + 0.05);
}

export async function renderOfflineAiRemixWav(params: {
  mode: 'mashup-32' | 'ai-transition';
  deckA: OfflineRenderDeckInput;
  deckB: OfflineRenderDeckInput;
  vibe: AiDjVibe;
  aggressiveness: number;
  transitionBars?: number;
  onProgress?: (pct: number) => void;
}): Promise<OfflineRemixRenderResult> {
  const {
    mode,
    deckA,
    deckB,
    vibe,
    aggressiveness,
    transitionBars = 8,
    onProgress,
  } = params;

  onProgress?.(6);

  const sampleRate = 44100;
  const masterBpm = Math.max(72, Math.min(176, deckA.track.bpm || 124));
  const beatSec = 60 / masterBpm;
  const barSec = beatSec * 4;

  // Match Deck B speed cleanly (supports half/double time)
  const bBpm = Math.max(60, deckB.track.bpm || 124);
  let rateB = masterBpm / bBpm;
  if (rateB > 1.45) rateB *= 0.5;
  if (rateB < 0.65) rateB *= 2;
  rateB = Math.max(0.68, Math.min(1.42, rateB));

  const aStartCue = Math.max(
    0,
    Math.min(
      Math.max(0, deckA.buffer.duration - 24),
      deckA.track.dropCueSec ?? deckA.track.detectedDropSec ?? deckA.buffer.duration * 0.22
    )
  );
  const bStartCue = Math.max(
    0,
    Math.min(
      Math.max(0, deckB.buffer.duration - 24),
      deckB.track.dropCueSec ?? deckB.track.detectedDropSec ?? deckB.buffer.duration * 0.18
    )
  );

  // Align cues to track bar-1 beats
  const aFirst = deckA.track.firstBeatSec || 0;
  const aBar = (60 / masterBpm) * 4;
  const qCueA = Math.max(0, aFirst + Math.round((aStartCue - aFirst) / aBar) * aBar);

  const bFirst = deckB.track.firstBeatSec || 0;
  const bBar = (60 / bBpm) * 4;
  const qCueB = Math.max(0, bFirst + Math.round((bStartCue - bFirst) / bBar) * bBar);

  const totalBars = mode === 'mashup-32' ? 32 : Math.max(20, Math.min(32, 8 + transitionBars + 8));
  const totalSec = Math.max(24, Math.min(110, totalBars * barSec + 1.2));

  const offlineCtx = new OfflineAudioContext(2, Math.ceil(totalSec * sampleRate), sampleRate);

  // Club -11 LUFS Mastering Chain
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
  masterMakeup.gain.value = 1.18;

  subTightHp.connect(masterWarmth);
  masterWarmth.connect(masterComp);
  masterComp.connect(masterLimiter);
  masterLimiter.connect(masterMakeup);
  masterMakeup.connect(offlineCtx.destination);

  const chainA = createOfflineDeckChain(offlineCtx, subTightHp, deckA.track.autoTrimGain ?? 0.92);
  const chainB = createOfflineDeckChain(offlineCtx, subTightHp, deckB.track.autoTrimGain ?? 0.92);

  const hasStemsA = Boolean(deckA.harmonicBuffer && deckA.percussiveBuffer && deckA.bassBuffer);
  const hasStemsB = Boolean(deckB.harmonicBuffer && deckB.percussiveBuffer && deckB.bassBuffer);

  // Wire source buffers cleanly for stems + full
  if (hasStemsA) {
    scheduleStemSource(offlineCtx, deckA.buffer, chainA.fullGain, 0, qCueA, totalSec, 1);
    scheduleStemSource(offlineCtx, deckA.harmonicBuffer!, chainA.harmGain, 0, qCueA, totalSec, 1);
    scheduleStemSource(offlineCtx, deckA.percussiveBuffer!, chainA.percGain, 0, qCueA, totalSec, 1);
    scheduleStemSource(offlineCtx, deckA.bassBuffer!, chainA.bassGain, 0, qCueA, totalSec, 1);
  } else {
    scheduleStemSource(offlineCtx, deckA.buffer, chainA.fullGain, 0, qCueA, totalSec, 1);
  }

  if (hasStemsB) {
    scheduleStemSource(offlineCtx, deckB.buffer, chainB.fullGain, 0, qCueB, totalSec, rateB);
    scheduleStemSource(offlineCtx, deckB.harmonicBuffer!, chainB.harmGain, 0, qCueB, totalSec, rateB);
    scheduleStemSource(offlineCtx, deckB.percussiveBuffer!, chainB.percGain, 0, qCueB, totalSec, rateB);
    scheduleStemSource(offlineCtx, deckB.bassBuffer!, chainB.bassGain, 0, qCueB, totalSec, rateB);
  } else {
    scheduleStemSource(offlineCtx, deckB.buffer, chainB.fullGain, 0, qCueB, totalSec, rateB);
  }

  onProgress?.(22);

  const setStemMix = (
    chain: OfflineDeckNodes,
    hasStems: boolean,
    modeSel: 'off' | 'vocal' | 'inst' | 'drums',
    atTime: number
  ) => {
    if (!hasStems) {
      chain.fullGain.gain.setTargetAtTime(1, atTime, 0.02);
      chain.harmGain.gain.setTargetAtTime(0, atTime, 0.02);
      chain.percGain.gain.setTargetAtTime(0, atTime, 0.02);
      chain.bassGain.gain.setTargetAtTime(0, atTime, 0.02);
      return;
    }
    const f = modeSel === 'off' ? 1 : 0;
    const h = modeSel === 'vocal' || modeSel === 'inst' ? (modeSel === 'vocal' ? 1.12 : 0.2) : 0;
    const p = modeSel === 'inst' || modeSel === 'drums' ? 1.05 : 0;
    const b = modeSel === 'inst' ? 1.05 : 0;
    chain.fullGain.gain.setTargetAtTime(f, atTime, 0.025);
    chain.harmGain.gain.setTargetAtTime(h, atTime, 0.025);
    chain.percGain.gain.setTargetAtTime(p, atTime, 0.025);
    chain.bassGain.gain.setTargetAtTime(b, atTime, 0.025);
  };

  if (mode === 'mashup-32') {
    // Continuous 32-Bar Bootleg Mashup Choreography
    // Bars 0..8: Deck A Vocals x Deck B Beat/Sub
    setStemMix(chainA, hasStemsA, 'vocal', 0);
    setStemMix(chainB, hasStemsB, 'inst', 0);
    chainA.lowFilter.gain.setValueAtTime(hasStemsA ? -2 : -18, 0);
    chainA.midFilter.gain.setValueAtTime(3.2, 0);
    chainB.lowFilter.gain.setValueAtTime(1.5, 0);
    chainB.midFilter.gain.setValueAtTime(-3.5, 0);

    // Bars 8..16: Stem Swap (Deck B Vocals x Deck A Beat/Sub)
    const t8 = 8 * barSec;
    setStemMix(chainA, hasStemsA, 'inst', t8);
    setStemMix(chainB, hasStemsB, 'vocal', t8);
    chainA.lowFilter.gain.setTargetAtTime(1.5, t8, 0.03);
    chainA.midFilter.gain.setTargetAtTime(-3.5, t8, 0.03);
    chainB.lowFilter.gain.setTargetAtTime(hasStemsB ? -2 : -18, t8, 0.03);
    chainB.midFilter.gain.setTargetAtTime(3.2, t8, 0.03);
    scheduleOfflineSubDrop(offlineCtx, subTightHp, t8, deckB.track.musicalKey);

    // Bars 16..20: 1-Bar A <-> B Ping-Pong Call & Response
    const t16 = 16 * barSec;
    setStemMix(chainA, hasStemsA, 'off', t16);
    setStemMix(chainB, hasStemsB, 'off', t16);
    chainA.lowFilter.gain.setTargetAtTime(0, t16, 0.03);
    chainA.midFilter.gain.setTargetAtTime(0, t16, 0.03);
    chainB.lowFilter.gain.setTargetAtTime(0, t16, 0.03);
    chainB.midFilter.gain.setTargetAtTime(0, t16, 0.03);
    for (let bar = 16; bar < 20; bar++) {
      const tb = bar * barSec;
      const aLead = bar % 2 === 0;
      chainA.gain.gain.setTargetAtTime(aLead ? 0.96 : 0.14, tb, 0.015);
      chainB.gain.gain.setTargetAtTime(aLead ? 0.14 : 0.96, tb, 0.015);
    }

    // Bars 20..24: Tension Pre-Drop Build (Snare roll + White-noise Riser + Low Kill)
    const t20 = 20 * barSec;
    const t24 = 24 * barSec;
    chainA.gain.gain.setTargetAtTime(0.84, t20, 0.03);
    chainB.gain.gain.setTargetAtTime(0.84, t20, 0.03);
    chainA.lowFilter.gain.setTargetAtTime(-16, t20, 0.05);
    chainB.lowFilter.gain.setTargetAtTime(-16, t20, 0.05);
    chainA.sweeperFilter.type = 'highpass';
    chainB.sweeperFilter.type = 'highpass';
    chainA.sweeperFilter.frequency.setValueAtTime(120, t20);
    chainA.sweeperFilter.frequency.exponentialRampToValueAtTime(1450, t24 - beatSec * 0.5);
    chainB.sweeperFilter.frequency.setValueAtTime(120, t20);
    chainB.sweeperFilter.frequency.exponentialRampToValueAtTime(1450, t24 - beatSec * 0.5);
    scheduleOfflineNoiseRiser(offlineCtx, subTightHp, t20, 4 * barSec - beatSec * 0.35, 0.22);
    scheduleOfflineSnareBuild(offlineCtx, subTightHp, t20, 4 * barSec - beatSec * 0.25, beatSec);

    // 1/2-beat breath before double-drop slam
    const silenceAt = t24 - beatSec * 0.35;
    chainA.gain.gain.setValueAtTime(0.05, silenceAt);
    chainB.gain.gain.setValueAtTime(0.05, silenceAt);

    // Bars 24..32: Double-Drop Slam + Sub-Drop + Alternating Bass Lock
    setStemMix(chainA, hasStemsA, hasStemsA ? 'vocal' : 'off', t24);
    setStemMix(chainB, hasStemsB, hasStemsB ? 'inst' : 'off', t24);
    chainA.sweeperFilter.frequency.setValueAtTime(20, t24);
    chainB.sweeperFilter.frequency.setValueAtTime(20, t24);
    chainA.gain.gain.setValueAtTime(0.95, t24);
    chainB.gain.gain.setValueAtTime(0.95, t24);
    chainA.lowFilter.gain.setValueAtTime(hasStemsA ? -2 : -18, t24);
    chainB.lowFilter.gain.setValueAtTime(2.0, t24);
    chainA.midFilter.gain.setValueAtTime(2.5, t24);
    chainB.midFilter.gain.setValueAtTime(-2.5, t24);
    scheduleOfflineSubDrop(offlineCtx, subTightHp, t24, deckB.track.musicalKey);
  } else {
    // Quantized AI Transition Edit: 8 bars Outgoing Solo -> transitionBars Crossfade + Bass Swap -> 8 bars Incoming Solo
    const plan = planOfflineTransition({
      outgoingTrack: deckA.track,
      currentBpm: masterBpm,
      vibe,
      candidates: [deckB.track],
      aggressiveness,
      remixMode: true,
    });
    const tBars = Math.max(4, Math.min(16, plan.transitionBars || transitionBars));
    const mixStart = 8 * barSec;
    const mixEnd = mixStart + tBars * barSec;
    const midMix = (mixStart + mixEnd) * 0.5;

    setStemMix(chainA, hasStemsA, 'off', 0);
    setStemMix(chainB, hasStemsB, 'off', 0);
    chainA.gain.gain.setValueAtTime(0.96, 0);
    chainB.gain.gain.setValueAtTime(0, 0);
    chainB.lowFilter.gain.setValueAtTime(-20, 0);

    // Build tension entering mixStart -> midMix
    scheduleOfflineNoiseRiser(offlineCtx, subTightHp, Math.max(0, midMix - 2 * barSec), 2 * barSec, 0.2);
    scheduleOfflineSnareBuild(offlineCtx, subTightHp, Math.max(0, midMix - 2 * barSec), 2 * barSec, beatSec);

    chainB.gain.gain.setValueAtTime(0.001, mixStart);
    chainB.gain.gain.linearRampToValueAtTime(0.95, midMix);
    // Bass swap right on downbeat of midMix!
    chainA.lowFilter.gain.setValueAtTime(0, mixStart);
    chainA.lowFilter.gain.setTargetAtTime(-22, midMix, 0.03);
    chainB.lowFilter.gain.setValueAtTime(-20, mixStart);
    chainB.lowFilter.gain.setTargetAtTime(1.2, midMix, 0.03);
    scheduleOfflineSubDrop(offlineCtx, subTightHp, midMix, deckB.track.musicalKey);

    chainA.gain.gain.setValueAtTime(0.95, mixStart);
    chainA.gain.gain.linearRampToValueAtTime(0.76, midMix);
    chainA.gain.gain.linearRampToValueAtTime(0.0001, mixEnd);
  }

  // Smooth fade-out on final 1.2s of render
  const fadeStart = Math.max(1, totalSec - 1.2);
  masterMakeup.gain.setValueAtTime(1.18, fadeStart);
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
  const blob = encodeAudioBufferToWav(rendered);
  onProgress?.(100);

  const shortA = deckA.track.title.split('(')[0].trim().slice(0, 22);
  const shortB = deckB.track.title.split('(')[0].trim().slice(0, 22);
  const label = mode === 'mashup-32' ? '32-Bar Bootleg' : 'AI Remix Edit';

  return {
    blob,
    durationSec: rendered.duration,
    title: `${label} — ${shortA} × ${shortB}`,
  };
}
