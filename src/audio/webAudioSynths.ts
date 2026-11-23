import { DjVoiceDropId, GrooveBridgePattern, SoundTrickType } from '../types/dj';
import { camelotToHarmony } from './aiMemory';

export function makeSynthSaturationCurve(amount = 40): Float32Array<ArrayBuffer> {
  const nSamples = 2048;
  const buffer = new ArrayBuffer(nSamples * 4);
  const curve = new Float32Array(buffer);
  const deg = Math.PI / 180;
  for (let i = 0; i < nSamples; ++i) {
    const x = (i * 2) / nSamples - 1;
    curve[i] = ((3 + amount) * x * 20 * deg) / (Math.PI + amount * Math.abs(x));
  }
  return curve;
}

export function createSynthNoiseBuffer(ctx: BaseAudioContext, durationSec = 0.35): AudioBuffer {
  const len = Math.max(256, Math.floor(ctx.sampleRate * durationSec));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) {
    data[i] = Math.random() * 2 - 1;
  }
  return buf;
}

export function createSynthReverbImpulse(
  ctx: BaseAudioContext,
  duration = 2.2,
  decay = 2.8
): AudioBuffer {
  const rate = ctx.sampleRate;
  const length = Math.max(512, Math.floor(rate * duration));
  const impulse = ctx.createBuffer(2, length, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = impulse.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      const env = Math.pow(1 - i / length, decay);
      data[i] = (Math.random() * 2 - 1) * env;
    }
  }
  return impulse;
}

export function scheduleSoundTrickSynth(params: {
  ctx: BaseAudioContext;
  dest: AudioNode;
  type: SoundTrickType;
  atTime: number;
  bpm?: number;
  musicalKey?: string;
  pitchRate?: number;
}): void {
  const { ctx, dest, type, atTime, bpm = 124, musicalKey, pitchRate = 1 } = params;
  const beatSec = 60 / Math.max(60, bpm);
  const harmony = camelotToHarmony(musicalKey, pitchRate);
  const now = atTime;

  if (type === 'riser') {
    const dur = Math.min(3.5, beatSec * 4);
    const len = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 3.5;
    bp.frequency.setValueAtTime(Math.max(180, harmony.rootHz * 0.9), now);
    bp.frequency.exponentialRampToValueAtTime(6500, now + dur);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.01, now);
    g.gain.exponentialRampToValueAtTime(0.42, now + dur * 0.92);
    g.gain.exponentialRampToValueAtTime(0.001, now + dur);

    src.connect(bp);
    bp.connect(g);
    g.connect(dest);
    src.start(now);
    src.stop(now + dur + 0.02);
    return;
  }

  if (type === 'sub-drop') {
    const dur = Math.min(2.1, Math.max(1.2, beatSec * 3));
    const subTarget = Math.max(30, Math.min(62, harmony.rootHz * 0.165));
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(subTarget * 3.1, now);
    osc.frequency.exponentialRampToValueAtTime(subTarget, now + dur);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.01, now);
    g.gain.linearRampToValueAtTime(0.75, now + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, now + dur);

    osc.connect(g);
    g.connect(dest);
    osc.start(now);
    osc.stop(now + dur + 0.02);
    return;
  }

  if (type === 'dub-siren') {
    const dur = Math.min(2.0, beatSec * 2.5);
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(harmony.rootHz * 2.0, now);

    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.setValueAtTime(7.5, now);
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 165;
    lfo.connect(lfoGain);
    lfoGain.connect(osc.frequency);

    const delay = ctx.createDelay(1.0);
    delay.delayTime.value = beatSec * 0.375;
    const fb = ctx.createGain();
    fb.gain.value = 0.45;
    delay.connect(fb);
    fb.connect(delay);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.01, now);
    g.gain.linearRampToValueAtTime(0.24, now + 0.03);
    g.gain.exponentialRampToValueAtTime(0.001, now + dur);

    osc.connect(g);
    g.connect(dest);
    g.connect(delay);
    delay.connect(dest);

    osc.start(now);
    lfo.start(now);
    osc.stop(now + dur);
    lfo.stop(now + dur);
    return;
  }

  if (type === 'backspin') {
    const dur = 0.75;
    const len = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const p = i / len;
        const freq = 420 + p * 2200;
        d[i] =
          (Math.sin((i / ctx.sampleRate) * Math.PI * 2 * freq) * 0.5 +
            (Math.random() * 2 - 1) * 0.5) *
          (1 - p);
      }
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;

    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 350;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.38, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + dur);

    src.connect(hp);
    hp.connect(g);
    g.connect(dest);
    src.start(now);
    src.stop(now + dur + 0.02);
    return;
  }

  if (type === 'laser') {
    const dur = 0.55;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(2400, now);
    osc.frequency.exponentialRampToValueAtTime(140, now + 0.28);

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 4.5;
    bp.frequency.setValueAtTime(2200, now);
    bp.frequency.exponentialRampToValueAtTime(320, now + 0.28);

    const delay = ctx.createDelay(0.6);
    delay.delayTime.value = Math.min(0.4, beatSec * 0.25);
    const fb = ctx.createGain();
    fb.gain.value = 0.48;
    delay.connect(fb);
    fb.connect(delay);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.36, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.28);

    osc.connect(bp);
    bp.connect(g);
    g.connect(dest);
    g.connect(delay);
    delay.connect(dest);

    osc.start(now);
    osc.stop(now + dur);
    return;
  }

  if (type === 'air-horn') {
    const dur = 0.95;
    const freqs = [harmony.chordHz[0] * 1.5, harmony.chordHz[2] * 1.5, harmony.chordHz[0] * 2.0];
    const masterOut = ctx.createGain();
    masterOut.gain.setValueAtTime(0.001, now);
    masterOut.gain.linearRampToValueAtTime(0.28, now + 0.02);
    masterOut.gain.setValueAtTime(0.26, now + 0.55);
    masterOut.gain.exponentialRampToValueAtTime(0.001, now + dur);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(2900, now);
    lp.Q.value = 1.6;
    lp.connect(masterOut);
    masterOut.connect(dest);

    freqs.forEach((f) => {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(f * 0.96, now);
      osc.frequency.linearRampToValueAtTime(f, now + 0.04);
      osc.connect(lp);
      osc.start(now);
      osc.stop(now + dur + 0.02);
    });
    return;
  }

  if (type === 'vinyl-stop') {
    const dur = 1.1;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(240, now);
    osc.frequency.exponentialRampToValueAtTime(28, now + dur);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.45, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + dur);

    osc.connect(g);
    g.connect(dest);
    osc.start(now);
    osc.stop(now + dur + 0.02);
    return;
  }

  if (type === 'snare-roll') {
    const totalHits = 12;
    const hitInterval = Math.min(0.18, beatSec * 0.25);
    const len = Math.floor(ctx.sampleRate * 0.14);
    const noise = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = noise.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }

    for (let h = 0; h < totalHits; h++) {
      const accelerate = h >= 8 ? 0.5 : 1;
      const startTime =
        now +
        (h < 8
          ? h * hitInterval
          : 8 * hitInterval + (h - 8) * hitInterval * accelerate);

      const src = ctx.createBufferSource();
      src.buffer = noise;

      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(1400 + h * 140, startTime);
      bp.Q.value = 1.2;

      const g = ctx.createGain();
      const peak = 0.12 + (h / totalHits) * 0.34;
      g.gain.setValueAtTime(peak, startTime);
      g.gain.exponentialRampToValueAtTime(0.001, startTime + 0.09);

      src.connect(bp);
      bp.connect(g);
      g.connect(dest);
      src.start(startTime);
      src.stop(startTime + 0.11);
    }
    return;
  }

  if (type === 'tape-rewind') {
    const dur = 0.85;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(160, now);
    osc.frequency.exponentialRampToValueAtTime(2200, now + dur * 0.78);
    osc.frequency.exponentialRampToValueAtTime(520, now + dur);

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 2.8;
    bp.frequency.setValueAtTime(450, now);
    bp.frequency.exponentialRampToValueAtTime(3400, now + dur * 0.8);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.01, now);
    g.gain.linearRampToValueAtTime(0.28, now + 0.08);
    g.gain.exponentialRampToValueAtTime(0.001, now + dur);

    osc.connect(bp);
    bp.connect(g);
    g.connect(dest);
    osc.start(now);
    osc.stop(now + dur + 0.02);
    return;
  }

  if (type === 'sweep-down') {
    const dur = Math.min(2.6, beatSec * 3);
    const len = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 2.5;
    bp.frequency.setValueAtTime(6200, now);
    bp.frequency.exponentialRampToValueAtTime(95, now + dur);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.4, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + dur);

    src.connect(bp);
    bp.connect(g);
    g.connect(dest);
    src.start(now);
    src.stop(now + dur + 0.02);
    return;
  }

  if (type === 'chord-stab') {
    const dur = Math.min(1.6, beatSec * 2.5);
    const notes = harmony.chordHz;
    const stabOut = ctx.createGain();
    stabOut.gain.setValueAtTime(0.001, now);
    stabOut.gain.linearRampToValueAtTime(0.22, now + 0.015);
    stabOut.gain.exponentialRampToValueAtTime(0.001, now + Math.min(0.45, beatSec * 0.8));

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(3800, now);
    lp.frequency.exponentialRampToValueAtTime(650, now + Math.min(0.45, beatSec * 0.85));

    const delay = ctx.createDelay(1.0);
    delay.delayTime.value = beatSec * 0.5;
    const fb = ctx.createGain();
    fb.gain.value = 0.42;
    delay.connect(fb);
    fb.connect(delay);

    lp.connect(stabOut);
    stabOut.connect(dest);
    stabOut.connect(delay);
    delay.connect(dest);

    notes.forEach((f, idx) => {
      const osc = ctx.createOscillator();
      osc.type = idx % 2 === 0 ? 'sawtooth' : 'triangle';
      osc.frequency.setValueAtTime(f, now);
      osc.detune.setValueAtTime((idx - 1.5) * 8, now);
      osc.connect(lp);
      osc.start(now);
      osc.stop(now + dur);
    });
    return;
  }

  if (type === 'scratch-chirp') {
    const bursts = 4;
    const step = Math.min(0.11, beatSec * 0.25);
    for (let b = 0; b < bursts; b++) {
      const st = now + b * step;
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(b % 2 === 0 ? 520 : 880, st);
      osc.frequency.exponentialRampToValueAtTime(b % 2 === 0 ? 1280 : 380, st + step * 0.75);

      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1100;
      bp.Q.value = 2.2;

      const g = ctx.createGain();
      g.gain.setValueAtTime(0.001, st);
      g.gain.linearRampToValueAtTime(0.32, st + 0.012);
      g.gain.exponentialRampToValueAtTime(0.001, st + step * 0.8);

      osc.connect(bp);
      bp.connect(g);
      g.connect(dest);
      osc.start(st);
      osc.stop(st + step * 0.85);
    }
    return;
  }

  if (type === 'drop-alarm') {
    const dur = Math.min(1.6, beatSec * 3.0);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(1100, now);
    bp.Q.value = 2.0;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.001, now);
    g.gain.linearRampToValueAtTime(0.24, now + 0.04);
    g.gain.exponentialRampToValueAtTime(0.001, now + dur);

    const base = harmony.rootHz * 2;
    [base, base * 1.007].forEach((baseFreq) => {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(baseFreq, now);
      osc.frequency.linearRampToValueAtTime(baseFreq * 1.9, now + 0.45);
      osc.frequency.linearRampToValueAtTime(baseFreq * 1.12, now + dur);
      osc.connect(bp);
      osc.start(now);
      osc.stop(now + dur + 0.02);
    });

    bp.connect(g);
    g.connect(dest);
    return;
  }

  if (type === 'tom-fill') {
    const freqs = [210, 175, 148, 122, 98, 76];
    const step = Math.min(0.16, beatSec * 0.25);
    freqs.forEach((f, idx) => {
      const st = now + idx * step;
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(f * 1.65, st);
      osc.frequency.exponentialRampToValueAtTime(f, st + 0.14);

      const g = ctx.createGain();
      g.gain.setValueAtTime(0.001, st);
      g.gain.linearRampToValueAtTime(0.38 + idx * 0.04, st + 0.008);
      g.gain.exponentialRampToValueAtTime(0.001, st + 0.22);

      osc.connect(g);
      g.connect(dest);
      osc.start(st);
      osc.stop(st + 0.24);
    });
    return;
  }

  if (type === 'vinyl-crack') {
    const dur = 0.22;
    const len = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const p = i / len;
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - p, 2.2) * (i % 17 < 3 ? 1.4 : 0.45);
      }
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;

    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1800;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.48, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + dur);

    src.connect(hp);
    hp.connect(g);
    g.connect(dest);
    src.start(now);
    src.stop(now + dur + 0.02);
    return;
  }

  if (type === 'riser-chord') {
    const dur = Math.min(2.8, beatSec * 3.5);
    const root = harmony.chordHz.slice(0, 3);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(320, now);
    lp.frequency.exponentialRampToValueAtTime(6400, now + dur * 0.92);
    lp.Q.value = 3.2;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.001, now);
    g.gain.exponentialRampToValueAtTime(0.24, now + dur * 0.88);
    g.gain.exponentialRampToValueAtTime(0.001, now + dur);

    lp.connect(g);
    g.connect(dest);

    root.forEach((f, idx) => {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(f, now);
      osc.frequency.exponentialRampToValueAtTime(f * 1.498, now + dur);
      osc.detune.setValueAtTime((idx - 1) * 9, now);
      osc.connect(lp);
      osc.start(now);
      osc.stop(now + dur + 0.02);
    });
  }
}

export function scheduleVoiceDropSynth(params: {
  ctx: BaseAudioContext;
  dest: AudioNode;
  noiseBuf: AudioBuffer;
  reverbImpulse?: AudioBuffer | null;
  voiceId: DjVoiceDropId;
  atTime: number;
  bpm?: number;
  musicalKey?: string;
  pitchRate?: number;
  volumeScale?: number;
  onDuckWindow?: (durSec: number) => void;
}): void {
  const {
    ctx,
    dest,
    noiseBuf,
    reverbImpulse,
    voiceId,
    atTime,
    bpm = 124,
    musicalKey,
    pitchRate = 1,
    volumeScale = 1.0,
    onDuckWindow,
  } = params;

  const safeScale = Math.max(0, Math.min(1.8, volumeScale));
  if (safeScale <= 0.01) return;

  const now = atTime;
  const safeBpm = Math.max(65, Math.min(185, bpm || 124));
  const beatSec = 60 / safeBpm;
  const harmony = camelotToHarmony(musicalKey, pitchRate);

  const VOWELS = {
    a: [730, 1180, 2460],
    e: [510, 1860, 2560],
    i: [300, 2240, 2940],
    o: [470, 850, 2410],
    u: [320, 880, 2230],
    ae: [660, 1740, 2450],
    uh: [620, 1220, 2380],
  } as const;
  type VowelKey = keyof typeof VOWELS;

  const voiceBus = ctx.createGain();
  voiceBus.gain.value = 1.45;

  const hipass = ctx.createBiquadFilter();
  hipass.type = 'highpass';
  hipass.frequency.value = 90;
  hipass.Q.value = 0.7;

  const chestWarmth = ctx.createBiquadFilter();
  chestWarmth.type = 'lowshelf';
  chestWarmth.frequency.value = 215;
  chestWarmth.gain.value = 3.5;

  const presence = ctx.createBiquadFilter();
  presence.type = 'peaking';
  presence.frequency.value = 2350;
  presence.Q.value = 0.95;
  presence.gain.value = 6.5;

  const airShelf = ctx.createBiquadFilter();
  airShelf.type = 'highshelf';
  airShelf.frequency.value = 5200;
  airShelf.gain.value = 4.5;

  const voiceDrive = ctx.createWaveShaper();
  voiceDrive.curve = makeSynthSaturationCurve(18);
  voiceDrive.oversample = '2x';

  const voiceComp = ctx.createDynamicsCompressor();
  voiceComp.threshold.value = -21;
  voiceComp.knee.value = 6;
  voiceComp.ratio.value = 6.5;
  voiceComp.attack.value = 0.002;
  voiceComp.release.value = 0.08;

  const voiceMakeup = ctx.createGain();
  voiceMakeup.gain.value = 2.65 * safeScale;

  onDuckWindow?.(Math.max(0.85, Math.min(2.6, beatSec * 2.5)));

  voiceBus.connect(hipass);
  hipass.connect(chestWarmth);
  chestWarmth.connect(presence);
  presence.connect(airShelf);
  airShelf.connect(voiceDrive);
  voiceDrive.connect(voiceComp);
  voiceComp.connect(voiceMakeup);
  voiceMakeup.connect(dest);

  const attachClubSpace = (slapSec: number, fbAmt: number, verbAmt: number) => {
    if (slapSec > 0.02) {
      const delayL = ctx.createDelay(1.2);
      const delayR = ctx.createDelay(1.2);
      delayL.delayTime.value = Math.min(1.0, slapSec);
      delayR.delayTime.value = Math.min(1.0, slapSec * 1.5);
      const fb = ctx.createGain();
      fb.gain.value = fbAmt;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 3200;
      const panL = ctx.createStereoPanner();
      panL.pan.value = -0.62;
      const panR = ctx.createStereoPanner();
      panR.pan.value = 0.62;
      const wet = ctx.createGain();
      wet.gain.value = 0.4;

      voiceMakeup.connect(lp);
      lp.connect(delayL);
      delayL.connect(fb);
      fb.connect(delayR);
      delayR.connect(delayL);
      delayL.connect(panL);
      delayR.connect(panR);
      panL.connect(wet);
      panR.connect(wet);
      wet.connect(dest);
    }
    if (verbAmt > 0 && reverbImpulse) {
      const conv = ctx.createConvolver();
      conv.buffer = reverbImpulse;
      const vg = ctx.createGain();
      vg.gain.value = verbAmt * 0.9;
      voiceMakeup.connect(conv);
      conv.connect(vg);
      vg.connect(dest);
    }
  };

  const spawnConsonant = (
    cTime: number,
    dur: number,
    freq: number,
    q: number,
    gainAmt: number,
    panVal = 0,
    plosive = true
  ) => {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(freq, cTime);
    bp.Q.value = Math.max(0.8, q * 0.72);
    const g = ctx.createGain();
    const boosted = gainAmt * 1.85;
    g.gain.setValueAtTime(0.001, cTime);
    g.gain.linearRampToValueAtTime(boosted, cTime + Math.min(0.006, dur * 0.22));
    g.gain.exponentialRampToValueAtTime(0.001, cTime + dur);
    const pan = ctx.createStereoPanner();
    pan.pan.value = panVal;
    src.connect(bp);
    bp.connect(g);
    g.connect(pan);
    pan.connect(voiceBus);
    src.start(cTime);
    src.stop(cTime + dur + 0.02);

    if (plosive) {
      const pOsc = ctx.createOscillator();
      pOsc.type = 'triangle';
      pOsc.frequency.setValueAtTime(165, cTime);
      pOsc.frequency.exponentialRampToValueAtTime(68, cTime + 0.032);
      const pg = ctx.createGain();
      pg.gain.setValueAtTime(boosted * 0.55, cTime);
      pg.gain.exponentialRampToValueAtTime(0.001, cTime + 0.036);
      pOsc.connect(pg);
      pg.connect(pan);
      pOsc.start(cTime);
      pOsc.stop(cTime + 0.042);
    }
  };

  const CROWD_STAGGER = [0, 0.011, 0.004, 0.016, 0.008, 0.021];

  const spawnSyllable = (opts: {
    start: number;
    dur: number;
    pitchStart: number;
    pitchMid?: number;
    pitchEnd: number;
    vowelStart: VowelKey;
    vowelEnd?: VowelKey;
    gain?: number;
    crowdCount?: number;
    pan?: number;
    aspirateAmt?: number;
    subPunch?: boolean;
    vibratoHz?: number;
    vibratoDepth?: number;
    grit?: number;
    pitchSnap?: boolean;
  }) => {
    const count = opts.crowdCount ?? 1;
    const gainTotal = (opts.gain ?? 0.65) * 1.45;
    const perVoiceGain = gainTotal / Math.sqrt(count);
    const vStart = VOWELS[opts.vowelStart];
    const vEnd = VOWELS[opts.vowelEnd ?? opts.vowelStart];
    const grit = opts.grit ?? 0.36;
    const useSnap = opts.pitchSnap ?? true;

    for (let v = 0; v < count; v++) {
      const microDelay = count > 1 ? CROWD_STAGGER[v % CROWD_STAGGER.length] : 0;
      const st = opts.start + microDelay;
      const d = opts.dur;
      const detuneRatio =
        count > 1 ? 1 + ((v - (count - 1) / 2) / Math.max(1, count)) * 0.042 : 1;
      const voicePan =
        count > 1
          ? Math.max(-0.85, Math.min(0.85, ((v / Math.max(1, count - 1)) * 2 - 1) * 0.78))
          : opts.pan ?? 0;

      const exc = ctx.createGain();
      exc.gain.value = 1;

      const schedulePitch = (osc: OscillatorNode, mult: number) => {
        if (useSnap && d >= 0.075) {
          osc.frequency.setValueAtTime(opts.pitchStart * detuneRatio * mult * 0.84, st);
          osc.frequency.exponentialRampToValueAtTime(
            Math.max(40, opts.pitchStart * detuneRatio * mult),
            st + 0.022
          );
        } else {
          osc.frequency.setValueAtTime(opts.pitchStart * detuneRatio * mult, st);
        }
        if (opts.pitchMid) {
          osc.frequency.linearRampToValueAtTime(
            opts.pitchMid * detuneRatio * mult,
            st + Math.max(0.03, d * 0.45)
          );
        }
        osc.frequency.linearRampToValueAtTime(opts.pitchEnd * detuneRatio * mult, st + d);
      };

      const osc1 = ctx.createOscillator();
      osc1.type = 'sawtooth';
      schedulePitch(osc1, 1);

      const osc2 = ctx.createOscillator();
      osc2.type = 'sawtooth';
      schedulePitch(osc2, 1.007);

      const o1Gain = ctx.createGain();
      o1Gain.gain.value = 0.64;
      const o2Gain = ctx.createGain();
      o2Gain.gain.value = 0.54;
      osc1.connect(o1Gain);
      osc2.connect(o2Gain);
      o1Gain.connect(exc);
      o2Gain.connect(exc);

      let osc3: OscillatorNode | null = null;
      if (grit > 0.05) {
        osc3 = ctx.createOscillator();
        osc3.type = 'square';
        schedulePitch(osc3, v % 2 === 1 && count > 2 ? 0.5 : 0.996);
        const o3Gain = ctx.createGain();
        o3Gain.gain.value = 0.26 * grit;
        osc3.connect(o3Gain);
        o3Gain.connect(exc);
      }

      if (opts.vibratoHz && opts.vibratoDepth) {
        const lfo = ctx.createOscillator();
        lfo.frequency.value = opts.vibratoHz;
        const lg = ctx.createGain();
        lg.gain.value = opts.vibratoDepth;
        lfo.connect(lg);
        lg.connect(osc1.frequency);
        lg.connect(osc2.frequency);
        lfo.start(st);
        lfo.stop(st + d + 0.03);
      }

      const aspAmt = opts.aspirateAmt ?? 0.22;
      if (aspAmt > 0) {
        const nSrc = ctx.createBufferSource();
        nSrc.buffer = noiseBuf;
        nSrc.loop = true;
        const nHp = ctx.createBiquadFilter();
        nHp.type = 'highpass';
        nHp.frequency.value = 950;
        const nGain = ctx.createGain();
        nGain.gain.value = aspAmt * 1.15;
        nSrc.connect(nHp);
        nHp.connect(nGain);
        nGain.connect(exc);
        nSrc.start(st);
        nSrc.stop(st + d + 0.03);
      }

      const sumFormants = ctx.createGain();
      const formantQ = [3.8, 5.2, 6.8];
      const formantWeights = [1.55, 1.25, 0.95];
      for (let fIdx = 0; fIdx < 3; fIdx++) {
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.Q.value = formantQ[fIdx];
        bp.frequency.setValueAtTime(vStart[fIdx], st);
        bp.frequency.linearRampToValueAtTime(vEnd[fIdx], st + d * 0.85);
        const fg = ctx.createGain();
        fg.gain.value = formantWeights[fIdx];
        exc.connect(bp);
        bp.connect(fg);
        fg.connect(sumFormants);
      }

      const chestLp = ctx.createBiquadFilter();
      chestLp.type = 'lowpass';
      chestLp.frequency.value = 340;
      chestLp.Q.value = 1.1;
      const chestG = ctx.createGain();
      chestG.gain.value = 0.56;
      exc.connect(chestLp);
      chestLp.connect(chestG);
      chestG.connect(sumFormants);

      if (grit > 0.1) {
        const biteBp = ctx.createBiquadFilter();
        biteBp.type = 'bandpass';
        biteBp.frequency.value = 3250;
        biteBp.Q.value = 3.8;
        const biteG = ctx.createGain();
        biteG.gain.value = 0.55 * (0.35 + grit);
        exc.connect(biteBp);
        biteBp.connect(biteG);
        biteG.connect(sumFormants);
      }

      const env = ctx.createGain();
      const atk = Math.min(0.016, d * 0.11);
      env.gain.setValueAtTime(0.001, st);
      env.gain.linearRampToValueAtTime(perVoiceGain, st + atk);
      env.gain.setValueAtTime(perVoiceGain * 0.94, st + Math.max(atk, d * 0.78));
      env.gain.exponentialRampToValueAtTime(0.001, st + d);

      const panNode = ctx.createStereoPanner();
      panNode.pan.value = voicePan;

      sumFormants.connect(env);
      env.connect(panNode);
      panNode.connect(voiceBus);

      if (opts.subPunch && v === 0) {
        const subOsc = ctx.createOscillator();
        subOsc.type = 'sine';
        subOsc.frequency.setValueAtTime(Math.max(58, opts.pitchStart * 0.52), st);
        subOsc.frequency.exponentialRampToValueAtTime(42, st + Math.min(0.24, d));
        const subG = ctx.createGain();
        subG.gain.setValueAtTime(0.46, st);
        subG.gain.exponentialRampToValueAtTime(0.001, st + Math.min(0.28, d));
        subOsc.connect(subG);
        subG.connect(voiceBus);
        subOsc.start(st);
        subOsc.stop(st + d + 0.03);
      }

      osc1.start(st);
      osc2.start(st);
      osc1.stop(st + d + 0.03);
      osc2.stop(st + d + 0.03);
      if (osc3) {
        osc3.start(st);
        osc3.stop(st + d + 0.03);
      }
    }
  };

  const keyRoot = Math.max(130, Math.min(245, harmony.rootHz * 0.72));

  switch (voiceId) {
    case 'hey-chant': {
      attachClubSpace(beatSec * 0.5, 0.34, 0.32);
      for (let i = 0; i < 3; i++) {
        const st = now + i * beatSec * 0.5;
        spawnConsonant(st, 0.055, 2250, 1.3, 0.34, 0, true);
        spawnSyllable({
          start: st + 0.014,
          dur: Math.min(0.3, beatSec * 0.44),
          pitchStart: 225 + i * 16,
          pitchMid: 255 + i * 18,
          pitchEnd: 195 + i * 12,
          vowelStart: 'e',
          vowelEnd: 'i',
          crowdCount: 6,
          gain: 0.72,
          aspirateAmt: 0.28,
          grit: 0.48,
          subPunch: true,
        });
      }
      break;
    }
    case 'lets-go': {
      attachClubSpace(beatSec * 0.375, 0.44, 0.34);
      spawnConsonant(now, 0.045, 3400, 1.6, 0.32, 0, true);
      spawnSyllable({
        start: now + 0.01,
        dur: 0.145,
        pitchStart: 215,
        pitchEnd: 245,
        vowelStart: 'e',
        vowelEnd: 'e',
        crowdCount: 5,
        gain: 0.66,
        grit: 0.45,
      });
      spawnConsonant(now + 0.145, 0.045, 1700, 1.8, 0.36, 0, true);
      spawnSyllable({
        start: now + 0.16,
        dur: 0.45,
        pitchStart: 275,
        pitchMid: 315,
        pitchEnd: 215,
        vowelStart: 'o',
        vowelEnd: 'u',
        crowdCount: 6,
        gain: 0.82,
        grit: 0.5,
        subPunch: true,
      });
      break;
    }
    case 'hands-up': {
      attachClubSpace(beatSec * 0.5, 0.4, 0.36);
      spawnConsonant(now, 0.06, 2150, 1.2, 0.36, 0, true);
      spawnSyllable({
        start: now + 0.018,
        dur: 0.23,
        pitchStart: 195,
        pitchEnd: 248,
        vowelStart: 'ae',
        vowelEnd: 'ae',
        crowdCount: 6,
        gain: 0.68,
        aspirateAmt: 0.32,
        grit: 0.46,
      });
      spawnConsonant(now + 0.225, 0.055, 4200, 2.0, 0.28, 0, true);
      spawnSyllable({
        start: now + 0.25,
        dur: 0.42,
        pitchStart: 268,
        pitchMid: 325,
        pitchEnd: 295,
        vowelStart: 'uh',
        vowelEnd: 'a',
        crowdCount: 6,
        gain: 0.82,
        grit: 0.52,
        subPunch: true,
      });
      break;
    }
    case 'put-em-up': {
      attachClubSpace(beatSec * 0.25, 0.38, 0.28);
      const step = Math.min(0.18, beatSec * 0.33);
      const pts: [VowelKey, number, number][] = [
        ['u', 205, 0.12],
        ['uh', 225, 0.12],
        ['a', 285, 0.36],
      ];
      pts.forEach(([vw, f, d], idx) => {
        const st = now + idx * step;
        spawnConsonant(st, 0.036, 1900 + idx * 600, 1.8, 0.32, 0, true);
        spawnSyllable({
          start: st + 0.01,
          dur: d,
          pitchStart: f,
          pitchEnd: idx === 2 ? f * 1.15 : f * 0.96,
          vowelStart: vw,
          crowdCount: idx === 2 ? 6 : 4,
          gain: idx === 2 ? 0.8 : 0.62,
          grit: 0.45,
          subPunch: idx === 2,
        });
      });
      break;
    }
    case 'make-some-noise': {
      attachClubSpace(beatSec * 0.5, 0.46, 0.44);
      const st1 = now;
      const st2 = now + 0.19;
      const st3 = now + 0.38;
      spawnConsonant(st1, 0.035, 1600, 1.5, 0.28, 0, true);
      spawnSyllable({
        start: st1 + 0.01,
        dur: 0.16,
        pitchStart: 210,
        pitchEnd: 230,
        vowelStart: 'e',
        vowelEnd: 'i',
        crowdCount: 5,
        gain: 0.64,
        grit: 0.42,
      });
      spawnConsonant(st2, 0.055, 5000, 1.8, 0.34, 0, false);
      spawnSyllable({
        start: st2 + 0.02,
        dur: 0.15,
        pitchStart: 230,
        pitchEnd: 252,
        vowelStart: 'uh',
        crowdCount: 5,
        gain: 0.64,
        grit: 0.42,
      });
      spawnConsonant(st3, 0.04, 2400, 1.6, 0.3, 0, true);
      spawnSyllable({
        start: st3 + 0.01,
        dur: 0.56,
        pitchStart: 278,
        pitchMid: 305,
        pitchEnd: 205,
        vowelStart: 'o',
        vowelEnd: 'i',
        crowdCount: 6,
        gain: 0.86,
        aspirateAmt: 0.3,
        grit: 0.52,
        subPunch: true,
      });
      break;
    }
    case 'crowd-roar': {
      attachClubSpace(0.09, 0.24, 0.54);
      const dur = Math.min(1.65, beatSec * 2.5);
      const src = ctx.createBufferSource();
      src.buffer = noiseBuf;
      src.loop = true;
      const f1 = ctx.createBiquadFilter();
      f1.type = 'bandpass';
      f1.Q.value = 2.4;
      f1.frequency.setValueAtTime(540, now);
      f1.frequency.linearRampToValueAtTime(1120, now + dur * 0.48);
      f1.frequency.linearRampToValueAtTime(680, now + dur);

      const f2 = ctx.createBiquadFilter();
      f2.type = 'bandpass';
      f2.Q.value = 2.8;
      f2.frequency.setValueAtTime(1450, now);
      f2.frequency.linearRampToValueAtTime(2400, now + dur * 0.45);
      f2.frequency.linearRampToValueAtTime(1400, now + dur);

      const g = ctx.createGain();
      g.gain.setValueAtTime(0.001, now);
      g.gain.linearRampToValueAtTime(0.75, now + dur * 0.22);
      g.gain.exponentialRampToValueAtTime(0.001, now + dur);

      src.connect(f1);
      src.connect(f2);
      f1.connect(g);
      f2.connect(g);
      g.connect(voiceBus);
      src.start(now);
      src.stop(now + dur + 0.04);

      spawnSyllable({
        start: now + 0.04,
        dur: dur * 0.78,
        pitchStart: 230,
        pitchMid: 290,
        pitchEnd: 195,
        vowelStart: 'o',
        vowelEnd: 'a',
        crowdCount: 6,
        gain: 0.64,
        aspirateAmt: 0.38,
        grit: 0.45,
      });
      break;
    }
    case 'everybody-jump': {
      attachClubSpace(beatSec * 0.5, 0.36, 0.3);
      for (let i = 0; i < 4; i++) {
        const st = now + i * beatSec * 0.5;
        spawnConsonant(st, 0.045, 2500, 1.9, 0.36, 0, true);
        spawnSyllable({
          start: st + 0.01,
          dur: Math.min(0.22, beatSec * 0.38),
          pitchStart: 240 + (i % 2) * 35,
          pitchEnd: 175,
          vowelStart: 'uh',
          vowelEnd: 'uh',
          crowdCount: 6,
          gain: 0.74,
          grit: 0.48,
          subPunch: true,
        });
      }
      break;
    }
    case 'pump-it': {
      attachClubSpace(beatSec * 0.25, 0.35, 0.26);
      const step = Math.min(0.19, beatSec * 0.35);
      spawnConsonant(now, 0.04, 1950, 1.8, 0.34, 0, true);
      spawnSyllable({
        start: now + 0.01,
        dur: 0.145,
        pitchStart: 215,
        pitchEnd: 205,
        vowelStart: 'uh',
        crowdCount: 5,
        gain: 0.66,
        grit: 0.45,
      });
      spawnSyllable({
        start: now + step,
        dur: 0.125,
        pitchStart: 235,
        pitchEnd: 225,
        vowelStart: 'i',
        crowdCount: 5,
        gain: 0.62,
        grit: 0.44,
      });
      spawnConsonant(now + step * 2, 0.04, 2400, 1.7, 0.32, 0, true);
      spawnSyllable({
        start: now + step * 2 + 0.01,
        dur: 0.38,
        pitchStart: 265,
        pitchMid: 315,
        pitchEnd: 280,
        vowelStart: 'a',
        vowelEnd: 'uh',
        crowdCount: 6,
        gain: 0.82,
        grit: 0.52,
        subPunch: true,
      });
      break;
    }
    case 'turn-it-up': {
      attachClubSpace(beatSec * 0.375, 0.4, 0.3);
      spawnConsonant(now, 0.045, 3200, 1.8, 0.32, 0, true);
      spawnSyllable({
        start: now + 0.014,
        dur: 0.16,
        pitchStart: 195,
        pitchEnd: 230,
        vowelStart: 'uh',
        crowdCount: 5,
        gain: 0.64,
        grit: 0.42,
      });
      spawnSyllable({
        start: now + 0.18,
        dur: 0.125,
        pitchStart: 235,
        pitchEnd: 258,
        vowelStart: 'i',
        crowdCount: 5,
        gain: 0.62,
        grit: 0.42,
      });
      spawnConsonant(now + 0.3, 0.04, 2600, 1.8, 0.3, 0, true);
      spawnSyllable({
        start: now + 0.31,
        dur: 0.44,
        pitchStart: 265,
        pitchEnd: 345,
        vowelStart: 'uh',
        vowelEnd: 'a',
        crowdCount: 6,
        gain: 0.82,
        grit: 0.5,
        subPunch: true,
      });
      break;
    }
    case 'oh-my-god': {
      attachClubSpace(beatSec * 0.5, 0.46, 0.4);
      spawnSyllable({
        start: now,
        dur: 0.25,
        pitchStart: 230,
        pitchEnd: 320,
        vowelStart: 'o',
        vowelEnd: 'a',
        crowdCount: 4,
        gain: 0.68,
        grit: 0.44,
      });
      spawnConsonant(now + 0.255, 0.045, 2200, 1.7, 0.34, 0, true);
      spawnSyllable({
        start: now + 0.27,
        dur: 0.56,
        pitchStart: 315,
        pitchMid: 285,
        pitchEnd: 185,
        vowelStart: 'a',
        vowelEnd: 'o',
        crowdCount: 6,
        gain: 0.84,
        grit: 0.52,
        subPunch: true,
      });
      break;
    }
    case 'groove-yeah': {
      attachClubSpace(beatSec * 0.5, 0.46, 0.36);
      spawnSyllable({
        start: now,
        dur: Math.min(0.95, beatSec * 1.5),
        pitchStart: keyRoot * 1.05,
        pitchMid: keyRoot * 1.4,
        pitchEnd: keyRoot * 1.12,
        vowelStart: 'u',
        vowelEnd: 'ae',
        crowdCount: 3,
        gain: 0.68,
        vibratoHz: 5.8,
        vibratoDepth: 7,
        grit: 0.24,
        pitchSnap: false,
      });
      break;
    }
    case 'ah-yeah-chop': {
      attachClubSpace(beatSec * 0.375, 0.46, 0.28);
      const step = Math.min(0.22, beatSec * 0.5);
      const pattern: [VowelKey, number, number][] = [
        ['a', keyRoot * 1.1, -0.38],
        ['a', keyRoot * 1.24, 0.38],
        ['ae', keyRoot * 1.4, 0],
      ];
      pattern.forEach(([vw, f, pan], i) => {
        spawnSyllable({
          start: now + i * step,
          dur: i === 2 ? step * 1.4 : step * 0.76,
          pitchStart: f,
          pitchEnd: i === 2 ? f * 0.94 : f * 1.04,
          vowelStart: vw,
          vowelEnd: i === 2 ? 'a' : vw,
          crowdCount: i === 2 ? 3 : 2,
          gain: i === 2 ? 0.74 : 0.62,
          pan,
          grit: 0.34,
        });
      });
      break;
    }
    case 'funk-woo': {
      attachClubSpace(beatSec * 0.5, 0.44, 0.38);
      spawnConsonant(now, 0.045, 1700, 1.4, 0.24, 0, false);
      spawnSyllable({
        start: now + 0.01,
        dur: Math.min(0.75, beatSec * 1.2),
        pitchStart: 320,
        pitchMid: 580,
        pitchEnd: 460,
        vowelStart: 'u',
        vowelEnd: 'o',
        crowdCount: 3,
        gain: 0.68,
        aspirateAmt: 0.26,
        vibratoHz: 6.4,
        vibratoDepth: 12,
        grit: 0.28,
      });
      break;
    }
    case 'afro-eyy': {
      attachClubSpace(beatSec * 0.375, 0.42, 0.3);
      const step = Math.min(0.26, beatSec * 0.5);
      spawnSyllable({
        start: now,
        dur: step * 0.78,
        pitchStart: keyRoot * 1.32,
        pitchEnd: keyRoot * 1.48,
        vowelStart: 'e',
        vowelEnd: 'a',
        crowdCount: 5,
        gain: 0.68,
        grit: 0.38,
      });
      spawnSyllable({
        start: now + step,
        dur: step * 0.98,
        pitchStart: keyRoot * 1.1,
        pitchEnd: keyRoot * 0.95,
        vowelStart: 'o',
        vowelEnd: 'u',
        crowdCount: 5,
        gain: 0.74,
        grit: 0.4,
        subPunch: true,
      });
      break;
    }
    case 'vocoder-harmony': {
      attachClubSpace(beatSec * 0.5, 0.48, 0.44);
      const dur = Math.min(1.4, beatSec * 2.2);
      harmony.chordHz.slice(0, 3).forEach((freq, idx) => {
        spawnSyllable({
          start: now + idx * 0.014,
          dur,
          pitchStart: freq * 0.5,
          pitchMid: freq * 0.505,
          pitchEnd: freq * 0.5,
          vowelStart: idx === 1 ? 'a' : 'u',
          vowelEnd: 'o',
          gain: 0.48,
          pan: (idx - 1) * 0.48,
          aspirateAmt: 0.16,
          grit: 0.18,
          pitchSnap: false,
        });
      });
      break;
    }
    case 'sunset-breathe': {
      attachClubSpace(beatSec * 0.75, 0.52, 0.55);
      spawnSyllable({
        start: now,
        dur: Math.min(1.6, beatSec * 2.5),
        pitchStart: keyRoot * 1.12,
        pitchEnd: keyRoot * 1.08,
        vowelStart: 'a',
        vowelEnd: 'u',
        gain: 0.54,
        crowdCount: 2,
        aspirateAmt: 0.44,
        vibratoHz: 4.2,
        vibratoDepth: 4,
        grit: 0.1,
        pitchSnap: false,
      });
      break;
    }
    case 'count-1234': {
      attachClubSpace(beatSec * 0.5, 0.36, 0.26);
      const counts: [VowelKey, VowelKey, number][] = [
        ['uh', 'a', 195],
        ['u', 'u', 218],
        ['i', 'i', 245],
        ['o', 'a', 282],
      ];
      counts.forEach(([v1, v2, p], idx) => {
        const st = now + idx * beatSec;
        spawnConsonant(st, 0.045, 2500 + idx * 450, 1.9, 0.34, 0, true);
        spawnSyllable({
          start: st + 0.012,
          dur: Math.min(0.3, beatSec * 0.5),
          pitchStart: p,
          pitchEnd: idx === 3 ? p * 1.18 : p * 0.96,
          vowelStart: v1,
          vowelEnd: v2,
          crowdCount: idx === 3 ? 6 : 4,
          gain: idx === 3 ? 0.82 : 0.66,
          grit: 0.46,
          subPunch: idx === 3,
        });
      });
      break;
    }
    case 'three-two-one': {
      attachClubSpace(beatSec * 0.5, 0.44, 0.36);
      const counts: [VowelKey, number][] = [
        ['i', 210],
        ['u', 245],
        ['uh', 288],
      ];
      counts.forEach(([vw, p], idx) => {
        const st = now + idx * beatSec * 0.75;
        spawnConsonant(st, 0.05, 3000, 1.9, 0.34, 0, true);
        spawnSyllable({
          start: st + 0.01,
          dur: Math.min(0.34, beatSec * 0.54),
          pitchStart: p,
          pitchEnd: p * 1.1,
          vowelStart: vw,
          vowelEnd: idx === 2 ? 'a' : vw,
          crowdCount: idx === 2 ? 6 : 4,
          gain: 0.68 + idx * 0.07,
          grit: 0.48,
          subPunch: idx === 2,
        });
      });
      break;
    }
    case 'bass-drop': {
      attachClubSpace(beatSec * 0.375, 0.42, 0.32);
      spawnConsonant(now, 0.04, 1750, 1.8, 0.34, 0, true);
      spawnSyllable({
        start: now + 0.01,
        dur: 0.22,
        pitchStart: 165,
        pitchEnd: 142,
        vowelStart: 'e',
        vowelEnd: 'ae',
        crowdCount: 4,
        gain: 0.72,
        grit: 0.48,
      });
      spawnConsonant(now + 0.23, 0.05, 2250, 1.6, 0.38, 0, true);
      spawnSyllable({
        start: now + 0.25,
        dur: 0.58,
        pitchStart: 192,
        pitchEnd: 108,
        vowelStart: 'a',
        vowelEnd: 'o',
        crowdCount: 5,
        gain: 0.86,
        grit: 0.52,
        subPunch: true,
      });
      break;
    }
    case 'pull-up': {
      attachClubSpace(beatSec * 0.375, 0.56, 0.38);
      spawnConsonant(now, 0.04, 1900, 1.9, 0.34, 0, true);
      spawnSyllable({
        start: now + 0.01,
        dur: 0.16,
        pitchStart: 215,
        pitchEnd: 245,
        vowelStart: 'u',
        crowdCount: 4,
        gain: 0.68,
        grit: 0.46,
      });
      spawnConsonant(now + 0.165, 0.04, 2400, 1.8, 0.3, 0, true);
      spawnSyllable({
        start: now + 0.175,
        dur: 0.42,
        pitchStart: 255,
        pitchEnd: 355,
        vowelStart: 'uh',
        vowelEnd: 'a',
        crowdCount: 5,
        gain: 0.8,
        grit: 0.5,
        subPunch: true,
      });
      break;
    }
    case 'dj-scratch-aaah': {
      attachClubSpace(beatSec * 0.25, 0.34, 0.2);
      const hits = [0, 0.12, 0.24, 0.39];
      hits.forEach((off, idx) => {
        const isLong = idx === 3;
        spawnSyllable({
          start: now + off,
          dur: isLong ? 0.36 : 0.095,
          pitchStart: idx % 2 === 0 ? 185 : 275,
          pitchMid: isLong ? 295 : undefined,
          pitchEnd: isLong ? 165 : idx % 2 === 0 ? 305 : 175,
          vowelStart: 'ae',
          vowelEnd: 'a',
          crowdCount: isLong ? 3 : 2,
          gain: 0.74,
          grit: 0.46,
        });
      });
      break;
    }
    case 'yo-yo-yo': {
      attachClubSpace(beatSec * 0.375, 0.44, 0.24);
      const step = Math.min(0.14, beatSec * 0.33);
      [0, 1, 2].forEach((i) => {
        spawnConsonant(now + i * step, 0.025, 2200, 1.6, 0.26, 0, true);
        spawnSyllable({
          start: now + i * step + 0.008,
          dur: i === 2 ? 0.3 : step * 0.8,
          pitchStart: 225 + i * 22,
          pitchEnd: i === 2 ? 175 : 205,
          vowelStart: 'i',
          vowelEnd: 'o',
          crowdCount: i === 2 ? 4 : 2,
          gain: 0.72,
          grit: 0.44,
        });
      });
      break;
    }
    case 'check-mic': {
      attachClubSpace(beatSec * 0.25, 0.32, 0.18);
      spawnConsonant(now, 0.05, 3600, 2.0, 0.36, 0, true);
      spawnSyllable({
        start: now + 0.015,
        dur: 0.15,
        pitchStart: 185,
        pitchEnd: 170,
        vowelStart: 'e',
        crowdCount: 2,
        gain: 0.66,
        grit: 0.42,
      });
      spawnSyllable({
        start: now + 0.19,
        dur: 0.14,
        pitchStart: 198,
        pitchEnd: 185,
        vowelStart: 'uh',
        crowdCount: 2,
        gain: 0.64,
        grit: 0.42,
      });
      spawnConsonant(now + 0.34, 0.04, 3200, 1.9, 0.34, 0, true);
      spawnSyllable({
        start: now + 0.355,
        dur: 0.26,
        pitchStart: 215,
        pitchEnd: 175,
        vowelStart: 'u',
        crowdCount: 3,
        gain: 0.74,
        grit: 0.46,
        subPunch: true,
      });
      break;
    }
    case 'vip-remix': {
      attachClubSpace(beatSec * 0.5, 0.48, 0.34);
      const step = Math.min(0.16, beatSec * 0.35);
      const tag: [VowelKey, VowelKey, number, number][] = [
        ['i', 'i', keyRoot * 1.3, 0.12],
        ['a', 'i', keyRoot * 1.56, 0.12],
        ['e', 'i', keyRoot * 1.3, 0.14],
        ['i', 'e', keyRoot * 1.05, 0.36],
      ];
      tag.forEach(([v1, v2, f, d], idx) => {
        spawnConsonant(now + idx * step, 0.032, 2800, 1.8, 0.26, 0, true);
        spawnSyllable({
          start: now + idx * step + 0.008,
          dur: d,
          pitchStart: f,
          pitchEnd: idx === 3 ? f * 0.96 : f * 1.05,
          vowelStart: v1,
          vowelEnd: v2,
          crowdCount: 3,
          gain: 0.66,
          grit: 0.38,
        });
      });
      break;
    }
  }
}

export function scheduleCustomVoiceBufferSynth(params: {
  ctx: BaseAudioContext;
  dest: AudioNode;
  reverbImpulse?: AudioBuffer | null;
  buffer: AudioBuffer;
  atTime: number;
  bpm?: number;
  volumeScale?: number;
  onDuckWindow?: (durSec: number) => void;
}): void {
  const {
    ctx,
    dest,
    reverbImpulse,
    buffer,
    atTime,
    bpm = 124,
    volumeScale = 1.0,
    onDuckWindow,
  } = params;

  const safeScale = Math.max(0, Math.min(1.8, volumeScale));
  if (safeScale <= 0.01) return;

  const safeBpm = Math.max(65, Math.min(185, bpm || 124));
  const beatSec = 60 / safeBpm;
  const dur = Math.min(6.0, buffer.duration);

  const checkFrames = Math.min(buffer.length, Math.floor(buffer.sampleRate * dur));
  let maxPeak = 0;
  for (let ch = 0; ch < Math.min(2, buffer.numberOfChannels); ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < checkFrames; i += 4) {
      const a = Math.abs(data[i]);
      if (a > maxPeak) maxPeak = a;
    }
  }
  const autoGain = maxPeak > 0.01 ? Math.max(1.15, Math.min(4.2, 0.9 / maxPeak)) : 2.0;

  onDuckWindow?.(Math.min(4.4, dur + 0.18));

  const src = ctx.createBufferSource();
  src.buffer = buffer;

  const inputGain = ctx.createGain();
  inputGain.gain.setValueAtTime(autoGain, atTime);

  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 95;

  const chest = ctx.createBiquadFilter();
  chest.type = 'lowshelf';
  chest.frequency.value = 210;
  chest.gain.value = 2.5;

  const presence = ctx.createBiquadFilter();
  presence.type = 'peaking';
  presence.frequency.value = 2500;
  presence.Q.value = 1.0;
  presence.gain.value = 5.5;

  const air = ctx.createBiquadFilter();
  air.type = 'highshelf';
  air.frequency.value = 5400;
  air.gain.value = 3.5;

  const drive = ctx.createWaveShaper();
  drive.curve = makeSynthSaturationCurve(14);
  drive.oversample = '2x';

  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -20;
  comp.knee.value = 6;
  comp.ratio.value = 5.5;
  comp.attack.value = 0.002;
  comp.release.value = 0.08;

  const dryGain = ctx.createGain();
  dryGain.gain.setValueAtTime(1.55 * safeScale, atTime);

  src.connect(inputGain);
  inputGain.connect(hp);
  hp.connect(chest);
  chest.connect(presence);
  presence.connect(air);
  air.connect(drive);
  drive.connect(comp);
  comp.connect(dryGain);
  dryGain.connect(dest);

  const delay = ctx.createDelay(1.2);
  delay.delayTime.value = Math.min(0.8, beatSec * 0.5);
  const fb = ctx.createGain();
  fb.gain.value = 0.34;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 3000;
  const wet = ctx.createGain();
  wet.gain.value = 0.34;

  dryGain.connect(lp);
  lp.connect(delay);
  delay.connect(fb);
  fb.connect(delay);
  delay.connect(wet);
  wet.connect(dest);

  if (reverbImpulse) {
    const conv = ctx.createConvolver();
    conv.buffer = reverbImpulse;
    const vg = ctx.createGain();
    vg.gain.value = 0.24;
    dryGain.connect(conv);
    conv.connect(vg);
    vg.connect(dest);
  }

  src.start(atTime, 0, dur);
}

export function scheduleBuildUpSequenceSynth(params: {
  ctx: BaseAudioContext;
  dest: AudioNode;
  voiceDest?: AudioNode;
  noiseBuf: AudioBuffer;
  reverbImpulse?: AudioBuffer | null;
  startAt: number;
  bpm: number;
  musicalKey?: string;
  pitchRate?: number;
  bars?: number;
  voiceId?: DjVoiceDropId | null;
  customVoiceBuffer?: AudioBuffer | null;
  voiceVolumeScale?: number;
  onVoiceDuckWindow?: (durSec: number) => void;
}): void {
  const {
    ctx,
    dest,
    voiceDest,
    noiseBuf,
    reverbImpulse,
    startAt,
    bpm,
    musicalKey,
    pitchRate = 1,
    bars = 1,
    voiceId,
    customVoiceBuffer,
    voiceVolumeScale = 1.0,
    onVoiceDuckWindow,
  } = params;

  const safeBpm = Math.max(65, Math.min(185, bpm || 124));
  const beatSec = 60 / safeBpm;
  const clampedBars = Math.max(1, Math.min(2, bars));
  const totalBeats = clampedBars * 4;
  const silenceGap = Math.min(0.45, beatSec * 0.72);
  const buildDur = Math.max(0.8, totalBeats * beatSec - silenceGap);
  const dropAt = startAt + totalBeats * beatSec;
  const harmony = camelotToHarmony(musicalKey, pitchRate);

  const hitTimes: number[] = [];
  let t = startAt;
  while (t < startAt + buildDur - 0.02) {
    hitTimes.push(t);
    const progress = (t - startAt) / buildDur;
    const subdiv =
      progress < 0.35
        ? beatSec * 0.5
        : progress < 0.65
        ? beatSec * 0.25
        : progress < 0.86
        ? beatSec * 0.125
        : beatSec * 0.0625;
    t += subdiv;
  }

  hitTimes.forEach((ht, idx) => {
    const p = idx / Math.max(1, hitTimes.length - 1);
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(190 + p * 120, ht);
    osc.frequency.exponentialRampToValueAtTime(115 + p * 45, ht + 0.06);

    const og = ctx.createGain();
    og.gain.setValueAtTime(0.001, ht);
    og.gain.linearRampToValueAtTime(0.14 + p * 0.2, ht + 0.004);
    og.gain.exponentialRampToValueAtTime(0.001, ht + 0.075);
    osc.connect(og);
    og.connect(dest);
    osc.start(ht);
    osc.stop(ht + 0.085);

    const nSrc = ctx.createBufferSource();
    nSrc.buffer = noiseBuf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(1800 + p * 2600, ht);
    bp.Q.value = 1.4;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.001, ht);
    ng.gain.linearRampToValueAtTime(0.16 + p * 0.24, ht + 0.003);
    ng.gain.exponentialRampToValueAtTime(0.001, ht + 0.07);
    nSrc.connect(bp);
    bp.connect(ng);
    ng.connect(dest);
    nSrc.start(ht);
    nSrc.stop(ht + 0.08);
  });

  const riserLp = ctx.createBiquadFilter();
  riserLp.type = 'lowpass';
  riserLp.frequency.setValueAtTime(280, startAt);
  riserLp.frequency.exponentialRampToValueAtTime(7200, startAt + buildDur);
  riserLp.Q.value = 3.0;

  const riserGain = ctx.createGain();
  riserGain.gain.setValueAtTime(0.001, startAt);
  riserGain.gain.exponentialRampToValueAtTime(0.22, startAt + buildDur * 0.92);
  riserGain.gain.exponentialRampToValueAtTime(0.001, startAt + buildDur + 0.03);
  riserLp.connect(riserGain);
  riserGain.connect(dest);

  harmony.chordHz.slice(0, 3).forEach((f, idx) => {
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(f, startAt);
    osc.frequency.exponentialRampToValueAtTime(f * 1.498, startAt + buildDur);
    osc.detune.setValueAtTime((idx - 1) * 10, startAt);
    osc.connect(riserLp);
    osc.start(startAt);
    osc.stop(startAt + buildDur + 0.04);
  });

  const subOsc = ctx.createOscillator();
  subOsc.type = 'sine';
  subOsc.frequency.setValueAtTime(Math.max(92, harmony.rootHz * 0.5), dropAt);
  subOsc.frequency.exponentialRampToValueAtTime(34, dropAt + Math.min(1.1, beatSec * 1.8));
  const subGain = ctx.createGain();
  subGain.gain.setValueAtTime(0.001, dropAt);
  subGain.gain.linearRampToValueAtTime(0.7, dropAt + 0.014);
  subGain.gain.exponentialRampToValueAtTime(0.001, dropAt + Math.min(1.2, beatSec * 2.0));
  subOsc.connect(subGain);
  subGain.connect(dest);
  subOsc.start(dropAt);
  subOsc.stop(dropAt + Math.min(1.25, beatSec * 2.1));

  const crashSrc = ctx.createBufferSource();
  crashSrc.buffer = noiseBuf;
  const crashHp = ctx.createBiquadFilter();
  crashHp.type = 'highpass';
  crashHp.frequency.value = 3200;
  const crashGain = ctx.createGain();
  crashGain.gain.setValueAtTime(0.001, dropAt);
  crashGain.gain.linearRampToValueAtTime(0.28, dropAt + 0.01);
  crashGain.gain.exponentialRampToValueAtTime(0.001, dropAt + Math.min(0.95, beatSec * 1.6));
  crashSrc.connect(crashHp);
  crashHp.connect(crashGain);
  crashGain.connect(dest);
  crashSrc.start(dropAt);
  crashSrc.stop(dropAt + Math.min(1.0, beatSec * 1.7));

  const vOut = voiceDest || dest;
  const voiceStart = Math.max(startAt, dropAt - Math.min(0.68, silenceGap + 0.14));
  if (customVoiceBuffer) {
    scheduleCustomVoiceBufferSynth({
      ctx,
      dest: vOut,
      reverbImpulse,
      buffer: customVoiceBuffer,
      atTime: voiceStart,
      bpm: safeBpm,
      volumeScale: voiceVolumeScale,
      onDuckWindow: onVoiceDuckWindow,
    });
  } else if (voiceId) {
    scheduleVoiceDropSynth({
      ctx,
      dest: vOut,
      noiseBuf,
      reverbImpulse,
      voiceId,
      atTime: voiceStart,
      bpm: safeBpm,
      musicalKey,
      pitchRate,
      volumeScale: voiceVolumeScale,
      onDuckWindow: onVoiceDuckWindow,
    });
  }
}

export function scheduleGrooveBridgeStepSynth(params: {
  ctx: BaseAudioContext;
  dest: AudioNode;
  noiseBuf: AudioBuffer;
  stepIdx: number;
  barIdx: number;
  atTime: number;
  pattern: GrooveBridgePattern;
  bpm: number;
  musicalKey: string;
  pitchRate?: number;
}): void {
  const {
    ctx,
    dest,
    noiseBuf,
    stepIdx,
    barIdx,
    atTime: time,
    pattern: pat,
    bpm,
    musicalKey,
    pitchRate = 1,
  } = params;
  if (pat === 'off') return;

  const step16 = ((stepIdx % 16) + 16) % 16;
  const safeBar = ((barIdx % 4) + 4) % 4;
  const harmony = camelotToHarmony(musicalKey, pitchRate);
  const subRoot = Math.max(41, Math.min(82, harmony.rootHz * 0.25));

  const playKick = (gainAmt: number, startFreq = 135, endFreq = 44) => {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(startFreq, time);
    osc.frequency.exponentialRampToValueAtTime(endFreq, time + 0.09);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gainAmt, time);
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.16);
    osc.connect(g);
    g.connect(dest);
    osc.start(time);
    osc.stop(time + 0.18);
  };

  const playHat = (gainAmt: number, decay: number, hpFreq = 5800) => {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.setValueAtTime(hpFreq, time);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gainAmt, time);
    g.gain.exponentialRampToValueAtTime(0.001, time + decay);
    src.connect(hp);
    hp.connect(g);
    g.connect(dest);
    src.start(time);
    src.stop(time + decay + 0.02);
  };

  const playClap = (gainAmt: number) => {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(1950, time);
    bp.Q.setValueAtTime(1.4, time);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gainAmt, time);
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.12);
    src.connect(bp);
    bp.connect(g);
    g.connect(dest);
    src.start(time);
    src.stop(time + 0.14);
  };

  const playSub808 = (freq: number, gainAmt: number, dur: number) => {
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq * 1.4, time);
    osc.frequency.exponentialRampToValueAtTime(freq, time + 0.035);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(190, time);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gainAmt, time);
    g.gain.exponentialRampToValueAtTime(0.001, time + dur);
    osc.connect(lp);
    lp.connect(g);
    g.connect(dest);
    osc.start(time);
    osc.stop(time + dur + 0.02);
  };

  const playChordPad = (semitones: number, gainAmt: number, dur: number) => {
    const ratio = Math.pow(2, semitones / 12);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(1650, time);
    lp.frequency.exponentialRampToValueAtTime(480, time + dur);
    lp.Q.value = 1.6;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.001, time);
    env.gain.linearRampToValueAtTime(gainAmt, time + 0.08);
    env.gain.exponentialRampToValueAtTime(0.001, time + dur);

    lp.connect(env);
    env.connect(dest);

    harmony.chordHz.slice(0, 3).forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      osc.type = idx === 0 ? 'triangle' : 'sawtooth';
      osc.frequency.setValueAtTime(freq * ratio, time);
      osc.detune.setValueAtTime((idx - 1) * 7, time);
      osc.connect(lp);
      osc.start(time);
      osc.stop(time + dur + 0.02);
    });
  };

  const playArpNote = (freq: number, gainAmt: number, decay: number) => {
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, time);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(2400, time);
    lp.frequency.exponentialRampToValueAtTime(520, time + decay);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.001, time);
    env.gain.linearRampToValueAtTime(gainAmt, time + 0.006);
    env.gain.exponentialRampToValueAtTime(0.001, time + decay);
    osc.connect(lp);
    lp.connect(env);
    env.connect(dest);
    osc.start(time);
    osc.stop(time + decay + 0.02);
  };

  const playAcidBass = (freq: number, gainAmt: number, dur: number, accent = false) => {
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(freq, time);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.setValueAtTime(accent ? 5.2 : 3.2, time);
    lp.frequency.setValueAtTime(accent ? 1950 : 980, time);
    lp.frequency.exponentialRampToValueAtTime(165, time + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.001, time);
    g.gain.linearRampToValueAtTime(gainAmt, time + 0.008);
    g.gain.exponentialRampToValueAtTime(0.001, time + dur);
    osc.connect(lp);
    lp.connect(g);
    g.connect(dest);
    osc.start(time);
    osc.stop(time + dur + 0.02);
  };

  const playSnareFill = (gainAmt: number) => {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(2350, time);
    bp.Q.value = 1.6;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gainAmt, time);
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.09);
    src.connect(bp);
    bp.connect(g);
    g.connect(dest);
    src.start(time);
    src.stop(time + 0.1);
  };

  const progression = harmony.isMinor ? [0, -4, -9, -2] : [0, -5, -3, -7];
  const barSemitone = progression[safeBar % progression.length];
  const barMult = Math.pow(2, barSemitone / 12);
  const beatSec = 60 / Math.max(65, bpm);
  const isTurnaroundBar = safeBar === 3;

  if (isTurnaroundBar && step16 >= 12 && pat !== 'top-hats') {
    playSnareFill(0.11 + (step16 - 12) * 0.032);
  }

  if (pat === 'top-hats') {
    if (step16 % 2 === 0) playHat(step16 % 4 === 2 ? 0.16 : 0.09, step16 % 4 === 2 ? 0.09 : 0.04, 6200);
    if (step16 === 4 || step16 === 12) playClap(0.15);
    if (step16 === 14 || (isTurnaroundBar && step16 >= 13)) playHat(0.09, 0.04, 7200);
  } else if (pat === 'house-4x4') {
    if (step16 % 4 === 0) playKick(0.28);
    if (step16 % 4 === 2) playHat(0.13, 0.08, 5600);
    else playHat(0.045, 0.03, 7400);
    if (step16 === 4 || step16 === 12) playClap(0.16);
    if (step16 === 2 || step16 === 6 || step16 === 10 || step16 === 14 || step16 === 15) {
      const acidFreq =
        harmony.rootHz * 0.5 * barMult * (step16 === 14 ? 1.498 : step16 === 15 ? 1.189 : 1);
      playAcidBass(acidFreq, step16 === 14 ? 0.13 : 0.095, beatSec * 0.28, step16 === 14);
    }
    if (isTurnaroundBar && (step16 === 12 || step16 === 14)) {
      playArpNote(harmony.chordHz[step16 === 12 ? 1 : 2] * barMult, 0.085, 0.14);
    }
  } else if (pat === 'sub-808') {
    if (step16 === 0 || step16 === 6 || step16 === 10) {
      const fifth = step16 === 10 ? subRoot * 1.498 : subRoot;
      playSub808(fifth * barMult, 0.28, 0.34);
    }
    if (step16 === 0 || step16 === 10) playKick(0.22, 110, 42);
    if (step16 === 8) playClap(0.16);
    if (step16 % 2 === 0 || step16 === 13 || step16 === 15) playHat(0.075, 0.035, 6800);
    if (isTurnaroundBar && (step16 === 13 || step16 === 15)) {
      playAcidBass(harmony.rootHz * 0.5 * barMult * 1.498, 0.11, beatSec * 0.24, true);
    }
  } else if (pat === 'afro-perc') {
    const isPolyrhythmStep =
      safeBar < 2 &&
      (step16 === 0 || step16 === 3 || step16 === 6 || step16 === 9 || step16 === 12);
    if (step16 === 0 || step16 === 8) playKick(0.22, 120, 48);
    if (
      isPolyrhythmStep ||
      (safeBar >= 2 && (step16 === 3 || step16 === 6 || step16 === 10 || step16 === 12))
    ) {
      const pitchMult = step16 === 6 || step16 === 12 ? 1.25 : 1;
      playSub808(harmony.rootHz * 0.5 * pitchMult * barMult, 0.16, 0.14);
    }
    if (step16 === 4 || step16 === 14) playClap(0.11);
    playHat(step16 % 2 === 0 ? 0.07 : 0.035, 0.03, 5200);
  } else if (pat === 'chord-arp') {
    if (step16 === 0 || step16 === 8) {
      playChordPad(barSemitone, 0.11, beatSec * 1.75);
      playSub808(subRoot * barMult, 0.18, beatSec * 0.65);
    }
    if (step16 === 3 || step16 === 6 || step16 === 11 || step16 === 14) {
      playAcidBass(
        harmony.rootHz * 0.5 * barMult * (step16 === 14 ? 1.498 : 1),
        0.095,
        beatSec * 0.25,
        step16 === 14
      );
    }
    const arpNotes = [
      harmony.chordHz[0],
      harmony.chordHz[1],
      harmony.chordHz[2],
      harmony.chordHz[0] * 2,
    ];
    if (step16 % 2 === 0 || (isTurnaroundBar && step16 >= 8)) {
      const noteFreq = arpNotes[(step16 + safeBar) % arpNotes.length] * barMult;
      playArpNote(noteFreq, step16 % 4 === 2 ? 0.12 : 0.075, beatSec * 0.35);
    }
    if (step16 % 4 === 2) playHat(0.07, 0.05, 6800);
  }
}

/**
 * Enhancement #2: Key-Locked Synth Bass & Warm Club Pad Re-Harmonizer.
 * Generates bass pulses + sidechained harmonic pads aligned to the track's Camelot key.
 */
export function scheduleReharmonizerWindowSynth(params: {
  ctx: BaseAudioContext;
  dest: AudioNode;
  startAt: number;
  bars: number;
  bpm: number;
  musicalKey?: string;
  pitchRate?: number;
  intensity?: number;
}): void {
  const {
    ctx,
    dest,
    startAt,
    bars,
    bpm,
    musicalKey = '8A',
    pitchRate = 1,
    intensity = 0.72,
  } = params;
  if (bars <= 0) return;

  const beatSec = 60 / Math.max(60, bpm);
  const barSec = beatSec * 4;
  const harmony = camelotToHarmony(musicalKey, pitchRate);
  const progressionSemi = harmony.isMinor ? [0, -4, -2, -5] : [0, -5, -3, -7];

  for (let b = 0; b < bars; b++) {
    const semi = progressionSemi[b % progressionSemi.length];
    const barMult = Math.pow(2, semi / 12);
    const barTime = startAt + b * barSec;

    // Warm sidechained chord pad every bar
    for (let v = 0; v < 3; v++) {
      const freq = Math.max(110, Math.min(920, harmony.chordHz[v] * barMult));
      const osc = ctx.createOscillator();
      osc.type = v === 0 ? 'triangle' : 'sawtooth';
      osc.frequency.setValueAtTime(freq, barTime);
      osc.detune.setValueAtTime((v - 1) * 7, barTime);

      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(1150, barTime);
      lp.Q.setValueAtTime(0.8, barTime);

      const g = ctx.createGain();
      g.gain.setValueAtTime(0.001, barTime);
      g.gain.linearRampToValueAtTime(0.036 * intensity, barTime + beatSec * 0.45);
      g.gain.exponentialRampToValueAtTime(0.001, barTime + barSec * 0.92);

      osc.connect(lp);
      lp.connect(g);
      g.connect(dest);
      osc.start(barTime);
      osc.stop(barTime + barSec);
    }

    // Pumping off-beat / syncopated key-locked bassline
    const bassRoot = Math.max(38, Math.min(78, harmony.rootHz * 0.25 * barMult));
    const hits = [0.5, 1.5, 2.5, 3.25, 3.75];
    for (let hIdx = 0; hIdx < hits.length; hIdx++) {
      const hitAt = barTime + hits[hIdx] * beatSec;
      const pitchStep = hIdx === 3 ? bassRoot * 1.498 : hIdx === 4 ? bassRoot * 1.189 : bassRoot;
      const dur = hIdx >= 3 ? beatSec * 0.35 : beatSec * 0.42;

      const sub = ctx.createOscillator();
      sub.type = 'triangle';
      sub.frequency.setValueAtTime(pitchStep * 1.25, hitAt);
      sub.frequency.exponentialRampToValueAtTime(pitchStep, hitAt + 0.03);

      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(220, hitAt);

      const g = ctx.createGain();
      g.gain.setValueAtTime(0.001, hitAt);
      g.gain.linearRampToValueAtTime(0.16 * intensity, hitAt + 0.015);
      g.gain.exponentialRampToValueAtTime(0.001, hitAt + dur);

      sub.connect(lp);
      lp.connect(g);
      g.connect(dest);
      sub.start(hitAt);
      sub.stop(hitAt + dur + 0.02);
    }
  }
}
