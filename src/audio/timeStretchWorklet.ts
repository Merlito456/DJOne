/**
 * Offline Dual-Grain SOLA / Hann-Windowed Pitch & Key-Lock AudioWorklet
 * Runs completely in the Web Audio render thread via an inline Blob URL (zero network fetches).
 */

const PITCH_WORKLET_PROCESSOR_CODE = `
class DeckForgePitchShifterProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      {
        name: 'pitchFactor',
        defaultValue: 1.0,
        minValue: 0.5,
        maxValue: 2.0,
        automationRate: 'k-rate',
      },
    ];
  }

  constructor() {
    super();
    this.bufSize = 4096;
    this.grainSize = 1024;
    this.bufL = new Float32Array(this.bufSize);
    this.bufR = new Float32Array(this.bufSize);
    this.writeIdx = 0;
    this.phase = 0.0;
    this.smoothedFactor = 1.0;
  }

  readSample(buf, delaySamples) {
    let pos = this.writeIdx - delaySamples;
    while (pos < 0) pos += this.bufSize;
    while (pos >= this.bufSize) pos -= this.bufSize;
    const i0 = pos | 0;
    const i1 = (i0 + 1) % this.bufSize;
    const frac = pos - i0;
    return buf[i0] * (1.0 - frac) + buf[i1] * frac;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !output || output.length === 0) return true;

    const inL = input[0];
    const inR = input[1] || inL;
    const outL = output[0];
    const outR = output[1];
    if (!inL || !outL) return true;

    const targetFactor = parameters.pitchFactor[0];
    const frames = outL.length;

    for (let i = 0; i < frames; i++) {
      const sL = inL[i] || 0;
      const sR = inR ? (inR[i] || 0) : sL;

      this.bufL[this.writeIdx] = sL;
      this.bufR[this.writeIdx] = sR;

      this.smoothedFactor += (targetFactor - this.smoothedFactor) * 0.0025;
      const factor = this.smoothedFactor;

      if (Math.abs(factor - 1.0) < 0.006) {
        outL[i] = sL;
        if (outR) outR[i] = sR;
      } else {
        const ph0 = this.phase;
        const ph1 = ph0 + 0.5 >= 1.0 ? ph0 - 0.5 : ph0 + 0.5;

        const w0 = 0.5 * (1.0 - Math.cos(6.283185307179586 * ph0));
        const w1 = 0.5 * (1.0 - Math.cos(6.283185307179586 * ph1));

        const d0 = ph0 * this.grainSize + 64.0;
        const d1 = ph1 * this.grainSize + 64.0;

        const yL = this.readSample(this.bufL, d0) * w0 + this.readSample(this.bufL, d1) * w1;
        outL[i] = yL;
        if (outR) {
          const yR = this.readSample(this.bufR, d0) * w0 + this.readSample(this.bufR, d1) * w1;
          outR[i] = yR;
        }

        const step = (1.0 - factor) / this.grainSize;
        this.phase += step;
        if (this.phase >= 1.0) this.phase -= 1.0;
        else if (this.phase < 0.0) this.phase += 1.0;
      }

      this.writeIdx++;
      if (this.writeIdx >= this.bufSize) this.writeIdx = 0;
    }

    return true;
  }
}
registerProcessor('deckforge-pitch-shifter', DeckForgePitchShifterProcessor);
`;

const loadedContexts = new WeakSet<AudioContext>();
const loadingPromises = new WeakMap<AudioContext, Promise<boolean>>();

export async function ensurePitchWorkletLoaded(ctx: AudioContext): Promise<boolean> {
  if (loadedContexts.has(ctx)) return true;
  if (!ctx.audioWorklet || typeof ctx.audioWorklet.addModule !== 'function') {
    return false;
  }

  const existing = loadingPromises.get(ctx);
  if (existing) return existing;

  const p = (async () => {
    let url = '';
    try {
      const blob = new Blob([PITCH_WORKLET_PROCESSOR_CODE], { type: 'application/javascript' });
      url = URL.createObjectURL(blob);
      await ctx.audioWorklet.addModule(url);
      loadedContexts.add(ctx);
      return true;
    } catch {
      return false;
    } finally {
      if (url) {
        try {
          URL.revokeObjectURL(url);
        } catch {
          // ignore
        }
      }
    }
  })();

  loadingPromises.set(ctx, p);
  return p;
}
