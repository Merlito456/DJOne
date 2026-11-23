import {
  CrossfaderCurve,
  DeckFxState,
  DeckId,
  DjVoiceDropId,
  FxType,
  GrooveBridgePattern,
  SoundTrickType,
  StemIsolationMode,
  WaveformBandSample,
} from '../types/dj';
import { camelotToHarmony } from './aiMemory';
import { ensurePitchWorkletLoaded } from './timeStretchWorklet';
import { encodeStereoChunksToWav } from './waveformAnalyzer';

function makeSaturationCurve(amount = 40): Float32Array<ArrayBuffer> {
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

function makeBitcrushCurve(steps = 10): Float32Array<ArrayBuffer> {
  const nSamples = 2048;
  const buffer = new ArrayBuffer(nSamples * 4);
  const curve = new Float32Array(buffer);
  for (let i = 0; i < nSamples; ++i) {
    const x = (i * 2) / nSamples - 1;
    curve[i] = Math.round(x * steps) / steps;
  }
  return curve;
}

function createStereoReverbImpulse(ctx: AudioContext, duration = 2.2, decay = 2.8): AudioBuffer {
  const rate = ctx.sampleRate;
  const length = Math.floor(rate * duration);
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

class DeckChannel {
  private ctx: AudioContext;
  public buffer: AudioBuffer | null = null;
  private harmonicBuffer: AudioBuffer | null = null;
  private percussiveBuffer: AudioBuffer | null = null;
  private bassBuffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;
  private harmonicSource: AudioBufferSourceNode | null = null;
  private percussiveSource: AudioBufferSourceNode | null = null;
  private bassSource: AudioBufferSourceNode | null = null;

  public isPlaying = false;
  private anchorCtxTime = 0;
  private anchorOffsetSec = 0;
  public playbackRate = 1;
  private keyLock = true;
  private semitoneShift = 0;
  private playToken = 0;

  public loopActive = false;
  public loopStartSec = 0;
  public loopEndSec = 0;

  // DSP nodes
  public trimGain: GainNode;
  private stemBypassGain: GainNode;
  private stemVocalGain: GainNode;
  private stemInstGain: GainNode;
  private stemDrumsGain: GainNode;
  private midSideStemEnableGain: GainNode;
  private midSideDrumsEnableGain: GainNode;
  private hpssVocalEnableGain: GainNode;
  private hpssInstEnableGain: GainNode;
  private hpssDrumsEnableGain: GainNode;
  private hpssBassEnableGain: GainNode;
  private hpssVocalBus: GainNode;
  private hpssInstBus: GainNode;
  private hpssBassBus: GainNode;
  private preEqSum: GainNode;
  private pitchWorklet: AudioWorkletNode | null = null;
  public stemMode: StemIsolationMode = 'off';
  private activeTrimValue = 1;
  private sliceDuckUntilCtxTime = 0;

  public eqLow: BiquadFilterNode;
  public eqMid: BiquadFilterNode;
  public eqHigh: BiquadFilterNode;
  public sweepFilter: BiquadFilterNode;

  // FX send/return
  private dryGain: GainNode;
  private wetGain: GainNode;
  private fxInput: GainNode;

  private echoDelay: DelayNode;
  private echoFeedback: GainNode;
  private echoDamp: BiquadFilterNode;
  private echoOut: GainNode;

  private reverbConvolver: ConvolverNode;
  private reverbOut: GainNode;

  private flangerDelay: DelayNode;
  private flangerLfo: OscillatorNode;
  private flangerLfoGain: GainNode;
  private flangerFeedback: GainNode;
  private flangerOut: GainNode;

  private driveShaper: WaveShaperNode;
  private driveOut: GainNode;

  // 5. Phaser (4-stage allpass + LFO + feedback)
  private phaserLfo: OscillatorNode;
  private phaserLfoGain: GainNode;
  private phaserFeedback: GainNode;
  private phaserOut: GainNode;

  // 6. Bitcrush
  private crushShaper: WaveShaperNode;
  private crushLp: BiquadFilterNode;
  private crushOut: GainNode;

  // 7. Tremolo (beat-synced VCA chopper)
  private tremoloVca: GainNode;
  private tremoloLfo: OscillatorNode;
  private tremoloDepth: GainNode;
  private tremoloOut: GainNode;

  // 8. Chorus
  private chorusDelay: DelayNode;
  private chorusLfo: OscillatorNode;
  private chorusLfoGain: GainNode;
  private chorusOut: GainNode;

  // 9. Ring Modulator
  private ringmodVca: GainNode;
  private ringmodOsc: OscillatorNode;
  private ringmodDepth: GainNode;
  private ringmodOut: GainNode;

  // 10. Auto-Pan (Stereo Sweeper)
  private autopanNode: StereoPannerNode;
  private autopanLfo: OscillatorNode;
  private autopanDepth: GainNode;
  private autopanOut: GainNode;

  // 11. Metallic Comb Resonator
  private combDelay: DelayNode;
  private combFeedback: GainNode;
  private combHp: BiquadFilterNode;
  private combOut: GainNode;

  // 12. Square-Wave Beat Stutter Gater
  private stutterVca: GainNode;
  private stutterLfo: OscillatorNode;
  private stutterDepth: GainNode;
  private stutterHp: BiquadFilterNode;
  private stutterOut: GainNode;

  // 13. Sub-Harmonic Club Punch
  private subharmLp: BiquadFilterNode;
  private subharmShaper: WaveShaperNode;
  private subharmOut: GainNode;

  // 14. Pitch-Bright Stereo Shimmer
  private shimmerHp: BiquadFilterNode;
  private shimmerDelay: DelayNode;
  private shimmerLfo: OscillatorNode;
  private shimmerLfoGain: GainNode;
  private shimmerVerb: ConvolverNode;
  private shimmerOut: GainNode;

  // 15. Lo-Fi Tape & Vinyl Flutter
  private lofiBp: BiquadFilterNode;
  private lofiDelay: DelayNode;
  private lofiLfo: OscillatorNode;
  private lofiLfoGain: GainNode;
  private lofiShaper: WaveShaperNode;
  private lofiOut: GainNode;

  // 16. Dotted Filtered Dub Delay
  private dubDelayNode: DelayNode;
  private dubFeedback: GainNode;
  private dubBp: BiquadFilterNode;
  private dubOut: GainNode;

  public channelGain: GainNode;
  public analyser: AnalyserNode;
  private analyserData: Float32Array<ArrayBuffer>;
  private analyserFreqData: Uint8Array<ArrayBuffer>;
  private baseOutputGain = 0.85;
  private sidechainDuckMult = 1;
  private stereoWidthGain: GainNode;
  private midSideInstGate!: GainNode;
  private tapeBrakingUntilCtxTime = 0;

  private currentFx: FxType = 'echo';
  private fxEnabled = false;
  private fxWet = 0.35;

  constructor(ctx: AudioContext, destination: AudioNode, reverbImpulse: AudioBuffer) {
    this.ctx = ctx;

    this.trimGain = ctx.createGain();
    this.trimGain.gain.value = 1;

    // Real-Time 3-Stem Isolator Matrix (HPSS Worker stems when ready + Mid/Side instant fallback)
    this.stemBypassGain = ctx.createGain();
    this.stemBypassGain.gain.value = 1;
    this.stemVocalGain = ctx.createGain();
    this.stemVocalGain.gain.value = 0;
    this.stemInstGain = ctx.createGain();
    this.stemInstGain.gain.value = 0;
    this.stemDrumsGain = ctx.createGain();
    this.stemDrumsGain.gain.value = 0;

    this.midSideStemEnableGain = ctx.createGain();
    this.midSideStemEnableGain.gain.value = 1;
    this.midSideDrumsEnableGain = ctx.createGain();
    this.midSideDrumsEnableGain.gain.value = 1;
    this.hpssVocalEnableGain = ctx.createGain();
    this.hpssVocalEnableGain.gain.value = 0;
    this.hpssInstEnableGain = ctx.createGain();
    this.hpssInstEnableGain.gain.value = 0;
    this.hpssDrumsEnableGain = ctx.createGain();
    this.hpssDrumsEnableGain.gain.value = 0;
    this.hpssBassEnableGain = ctx.createGain();
    this.hpssBassEnableGain.gain.value = 0;

    this.hpssVocalBus = ctx.createGain();
    this.hpssVocalBus.gain.value = 1;
    this.hpssInstBus = ctx.createGain();
    this.hpssInstBus.gain.value = 1;
    this.hpssBassBus = ctx.createGain();
    this.hpssBassBus.gain.value = 1;

    this.preEqSum = ctx.createGain();
    this.preEqSum.gain.value = 1;

    const splitter = ctx.createChannelSplitter(2);
    this.trimGain.connect(splitter);

    // Mid Stem (Vocal Focus fallback: L + R summed -> 260Hz..3.8kHz presence bandpass)
    const midSumGainL = ctx.createGain();
    midSumGainL.gain.value = 0.65;
    const midSumGainR = ctx.createGain();
    midSumGainR.gain.value = 0.65;
    const vocalHp = ctx.createBiquadFilter();
    vocalHp.type = 'highpass';
    vocalHp.frequency.value = 260;
    vocalHp.Q.value = 0.8;
    const vocalLp = ctx.createBiquadFilter();
    vocalLp.type = 'lowpass';
    vocalLp.frequency.value = 3800;
    vocalLp.Q.value = 0.85;
    const vocalPeak = ctx.createBiquadFilter();
    vocalPeak.type = 'peaking';
    vocalPeak.frequency.value = 1850;
    vocalPeak.Q.value = 1.1;
    vocalPeak.gain.value = 3.2;

    splitter.connect(midSumGainL, 0);
    splitter.connect(midSumGainR, 1);
    midSumGainL.connect(vocalHp);
    midSumGainR.connect(vocalHp);
    vocalHp.connect(vocalLp);
    vocalLp.connect(vocalPeak);
    vocalPeak.connect(this.midSideStemEnableGain);
    this.midSideStemEnableGain.connect(this.stemVocalGain);

    // Side-Weighted Stem (Instrumental fallback)
    const sideGainL = ctx.createGain();
    sideGainL.gain.value = 0.95;
    const sideGainInvR = ctx.createGain();
    sideGainInvR.gain.value = -0.95;
    const sideHp = ctx.createBiquadFilter();
    sideHp.type = 'highpass';
    sideHp.frequency.value = 190;

    const subSumL = ctx.createGain();
    subSumL.gain.value = 0.56;
    const subSumR = ctx.createGain();
    subSumR.gain.value = 0.56;
    const subLp = ctx.createBiquadFilter();
    subLp.type = 'lowpass';
    subLp.frequency.value = 175;
    subLp.Q.value = 0.9;

    const airSumL = ctx.createGain();
    airSumL.gain.value = 0.36;
    const airSumR = ctx.createGain();
    airSumR.gain.value = 0.36;
    const airHp = ctx.createBiquadFilter();
    airHp.type = 'highpass';
    airHp.frequency.value = 5200;

    const midSideInstSum = ctx.createGain();
    midSideInstSum.gain.value = 1;
    const midSideInstGate = ctx.createGain();
    midSideInstGate.gain.value = 1;

    splitter.connect(sideGainL, 0);
    splitter.connect(sideGainInvR, 1);
    sideGainL.connect(sideHp);
    sideGainInvR.connect(sideHp);
    sideHp.connect(midSideInstSum);

    splitter.connect(subSumL, 0);
    splitter.connect(subSumR, 1);
    subSumL.connect(subLp);
    subSumR.connect(subLp);
    subLp.connect(midSideInstSum);

    splitter.connect(airSumL, 0);
    splitter.connect(airSumR, 1);
    airSumL.connect(airHp);
    airSumR.connect(airHp);
    airHp.connect(midSideInstSum);

    midSideInstSum.connect(midSideInstGate);
    midSideInstGate.connect(this.stemInstGain);
    this.midSideInstGate = midSideInstGate;

    // Drums-Only Fallback (Side transients + 160Hz..9kHz punch without sustained sub)
    const fallbackDrumHp = ctx.createBiquadFilter();
    fallbackDrumHp.type = 'highpass';
    fallbackDrumHp.frequency.value = 140;
    sideGainL.connect(fallbackDrumHp);
    sideGainInvR.connect(fallbackDrumHp);
    fallbackDrumHp.connect(this.midSideDrumsEnableGain);
    this.midSideDrumsEnableGain.connect(this.stemDrumsGain);

    // HPSS 3-Stem Routing (Harmonic Vocals + Percussive Drums + Sub-Bass)
    const hpssVocHp = ctx.createBiquadFilter();
    hpssVocHp.type = 'highpass';
    hpssVocHp.frequency.value = 165;
    hpssVocHp.Q.value = 0.75;
    this.hpssVocalBus.connect(hpssVocHp);
    hpssVocHp.connect(this.hpssVocalEnableGain);
    this.hpssVocalEnableGain.connect(this.stemVocalGain);

    this.hpssInstBus.connect(this.hpssInstEnableGain);
    this.hpssInstEnableGain.connect(this.stemInstGain);

    this.hpssInstBus.connect(this.hpssDrumsEnableGain);
    this.hpssDrumsEnableGain.connect(this.stemDrumsGain);

    this.hpssBassBus.connect(this.hpssBassEnableGain);
    this.hpssBassEnableGain.connect(this.stemInstGain);

    this.eqLow = ctx.createBiquadFilter();
    this.eqLow.type = 'lowshelf';
    this.eqLow.frequency.value = 250;

    this.eqMid = ctx.createBiquadFilter();
    this.eqMid.type = 'peaking';
    this.eqMid.frequency.value = 1000;
    this.eqMid.Q.value = 0.85;

    this.eqHigh = ctx.createBiquadFilter();
    this.eqHigh.type = 'highshelf';
    this.eqHigh.frequency.value = 4000;

    this.sweepFilter = ctx.createBiquadFilter();
    this.sweepFilter.type = 'lowpass';
    this.sweepFilter.frequency.value = 22000;
    this.sweepFilter.Q.value = 1.0;

    this.dryGain = ctx.createGain();
    this.dryGain.gain.value = 1;

    this.wetGain = ctx.createGain();
    this.wetGain.gain.value = 0;

    this.fxInput = ctx.createGain();
    this.fxInput.gain.value = 1;

    // 1. Echo
    this.echoDelay = ctx.createDelay(4.0);
    this.echoDelay.delayTime.value = 0.375;
    this.echoFeedback = ctx.createGain();
    this.echoFeedback.gain.value = 0.44;
    this.echoDamp = ctx.createBiquadFilter();
    this.echoDamp.type = 'lowpass';
    this.echoDamp.frequency.value = 3800;
    this.echoOut = ctx.createGain();
    this.echoOut.gain.value = 1;

    this.fxInput.connect(this.echoDelay);
    this.echoDelay.connect(this.echoDamp);
    this.echoDamp.connect(this.echoFeedback);
    this.echoFeedback.connect(this.echoDelay);
    this.echoDamp.connect(this.echoOut);
    this.echoOut.connect(this.wetGain);

    // 2. Reverb
    this.reverbConvolver = ctx.createConvolver();
    this.reverbConvolver.buffer = reverbImpulse;
    this.reverbOut = ctx.createGain();
    this.reverbOut.gain.value = 0;

    this.fxInput.connect(this.reverbConvolver);
    this.reverbConvolver.connect(this.reverbOut);
    this.reverbOut.connect(this.wetGain);

    // 3. Flanger
    this.flangerDelay = ctx.createDelay(0.05);
    this.flangerDelay.delayTime.value = 0.005;
    this.flangerLfo = ctx.createOscillator();
    this.flangerLfo.type = 'sine';
    this.flangerLfo.frequency.value = 0.35;
    this.flangerLfoGain = ctx.createGain();
    this.flangerLfoGain.gain.value = 0.0035;
    this.flangerFeedback = ctx.createGain();
    this.flangerFeedback.gain.value = 0.58;
    this.flangerOut = ctx.createGain();
    this.flangerOut.gain.value = 0;

    this.flangerLfo.connect(this.flangerLfoGain);
    this.flangerLfoGain.connect(this.flangerDelay.delayTime);
    this.flangerLfo.start();

    this.fxInput.connect(this.flangerDelay);
    this.flangerDelay.connect(this.flangerFeedback);
    this.flangerFeedback.connect(this.flangerDelay);
    this.flangerDelay.connect(this.flangerOut);
    this.flangerOut.connect(this.wetGain);

    // 4. Drive
    this.driveShaper = ctx.createWaveShaper();
    this.driveShaper.curve = makeSaturationCurve(55);
    this.driveShaper.oversample = '2x';
    this.driveOut = ctx.createGain();
    this.driveOut.gain.value = 0;

    this.fxInput.connect(this.driveShaper);
    this.driveShaper.connect(this.driveOut);
    this.driveOut.connect(this.wetGain);

    // 5. Phaser (4 cascaded allpass filters modulated by LFO)
    const ap1 = ctx.createBiquadFilter();
    const ap2 = ctx.createBiquadFilter();
    const ap3 = ctx.createBiquadFilter();
    const ap4 = ctx.createBiquadFilter();
    [ap1, ap2, ap3, ap4].forEach((ap, idx) => {
      ap.type = 'allpass';
      ap.frequency.value = 480 + idx * 320;
      ap.Q.value = 1.4;
    });
    this.phaserLfo = ctx.createOscillator();
    this.phaserLfo.type = 'sine';
    this.phaserLfo.frequency.value = 0.55;
    this.phaserLfoGain = ctx.createGain();
    this.phaserLfoGain.gain.value = 620;
    this.phaserFeedback = ctx.createGain();
    this.phaserFeedback.gain.value = 0.45;
    this.phaserOut = ctx.createGain();
    this.phaserOut.gain.value = 0;

    this.phaserLfo.connect(this.phaserLfoGain);
    [ap1, ap2, ap3, ap4].forEach((ap) => this.phaserLfoGain.connect(ap.frequency));
    this.phaserLfo.start();

    this.fxInput.connect(ap1);
    ap1.connect(ap2);
    ap2.connect(ap3);
    ap3.connect(ap4);
    ap4.connect(this.phaserFeedback);
    this.phaserFeedback.connect(ap1);
    ap4.connect(this.phaserOut);
    this.phaserOut.connect(this.wetGain);

    // 6. Bitcrush
    this.crushShaper = ctx.createWaveShaper();
    this.crushShaper.curve = makeBitcrushCurve(8);
    this.crushLp = ctx.createBiquadFilter();
    this.crushLp.type = 'lowpass';
    this.crushLp.frequency.value = 5400;
    this.crushLp.Q.value = 1.8;
    this.crushOut = ctx.createGain();
    this.crushOut.gain.value = 0;

    this.fxInput.connect(this.crushShaper);
    this.crushShaper.connect(this.crushLp);
    this.crushLp.connect(this.crushOut);
    this.crushOut.connect(this.wetGain);

    // 7. Tremolo (rhythmic beat-synced chopper)
    this.tremoloVca = ctx.createGain();
    this.tremoloVca.gain.value = 0.5;
    this.tremoloLfo = ctx.createOscillator();
    this.tremoloLfo.type = 'sine';
    this.tremoloLfo.frequency.value = 4.0;
    this.tremoloDepth = ctx.createGain();
    this.tremoloDepth.gain.value = 0.48;
    this.tremoloOut = ctx.createGain();
    this.tremoloOut.gain.value = 0;

    this.tremoloLfo.connect(this.tremoloDepth);
    this.tremoloDepth.connect(this.tremoloVca.gain);
    this.tremoloLfo.start();

    this.fxInput.connect(this.tremoloVca);
    this.tremoloVca.connect(this.tremoloOut);
    this.tremoloOut.connect(this.wetGain);

    // 8. Chorus
    this.chorusDelay = ctx.createDelay(0.08);
    this.chorusDelay.delayTime.value = 0.016;
    this.chorusLfo = ctx.createOscillator();
    this.chorusLfo.type = 'sine';
    this.chorusLfo.frequency.value = 0.85;
    this.chorusLfoGain = ctx.createGain();
    this.chorusLfoGain.gain.value = 0.0045;
    this.chorusOut = ctx.createGain();
    this.chorusOut.gain.value = 0;

    this.chorusLfo.connect(this.chorusLfoGain);
    this.chorusLfoGain.connect(this.chorusDelay.delayTime);
    this.chorusLfo.start();

    this.fxInput.connect(this.chorusDelay);
    this.chorusDelay.connect(this.chorusOut);
    this.chorusOut.connect(this.wetGain);

    // 9. Ring Modulator
    this.ringmodVca = ctx.createGain();
    this.ringmodVca.gain.value = 0.35;
    this.ringmodOsc = ctx.createOscillator();
    this.ringmodOsc.type = 'sine';
    this.ringmodOsc.frequency.value = 64;
    this.ringmodDepth = ctx.createGain();
    this.ringmodDepth.gain.value = 0.65;
    this.ringmodOut = ctx.createGain();
    this.ringmodOut.gain.value = 0;

    this.ringmodOsc.connect(this.ringmodDepth);
    this.ringmodDepth.connect(this.ringmodVca.gain);
    this.ringmodOsc.start();

    this.fxInput.connect(this.ringmodVca);
    this.ringmodVca.connect(this.ringmodOut);
    this.ringmodOut.connect(this.wetGain);

    // 10. Auto-Pan (Stereo Sweeper)
    this.autopanNode = ctx.createStereoPanner();
    this.autopanNode.pan.value = 0;
    this.autopanLfo = ctx.createOscillator();
    this.autopanLfo.type = 'sine';
    this.autopanLfo.frequency.value = 1.0;
    this.autopanDepth = ctx.createGain();
    this.autopanDepth.gain.value = 0.9;
    this.autopanOut = ctx.createGain();
    this.autopanOut.gain.value = 0;

    this.autopanLfo.connect(this.autopanDepth);
    this.autopanDepth.connect(this.autopanNode.pan);
    this.autopanLfo.start();

    this.fxInput.connect(this.autopanNode);
    this.autopanNode.connect(this.autopanOut);
    this.autopanOut.connect(this.wetGain);

    // 11. Metallic Comb Resonator
    this.combDelay = ctx.createDelay(0.1);
    this.combDelay.delayTime.value = 0.011;
    this.combFeedback = ctx.createGain();
    this.combFeedback.gain.value = 0.78;
    this.combHp = ctx.createBiquadFilter();
    this.combHp.type = 'highpass';
    this.combHp.frequency.value = 260;
    this.combOut = ctx.createGain();
    this.combOut.gain.value = 0;

    this.fxInput.connect(this.combHp);
    this.combHp.connect(this.combDelay);
    this.combDelay.connect(this.combFeedback);
    this.combFeedback.connect(this.combDelay);
    this.combDelay.connect(this.combOut);
    this.combOut.connect(this.wetGain);

    // 12. Square-Wave Beat Stutter Gater
    this.stutterVca = ctx.createGain();
    this.stutterVca.gain.value = 0.5;
    this.stutterLfo = ctx.createOscillator();
    this.stutterLfo.type = 'square';
    this.stutterLfo.frequency.value = 8.0;
    this.stutterDepth = ctx.createGain();
    this.stutterDepth.gain.value = 0.49;
    this.stutterHp = ctx.createBiquadFilter();
    this.stutterHp.type = 'highpass';
    this.stutterHp.frequency.value = 160;
    this.stutterOut = ctx.createGain();
    this.stutterOut.gain.value = 0;

    this.stutterLfo.connect(this.stutterDepth);
    this.stutterDepth.connect(this.stutterVca.gain);
    this.stutterLfo.start();

    this.fxInput.connect(this.stutterHp);
    this.stutterHp.connect(this.stutterVca);
    this.stutterVca.connect(this.stutterOut);
    this.stutterOut.connect(this.wetGain);

    // 13. Sub-Harmonic Club Punch
    this.subharmLp = ctx.createBiquadFilter();
    this.subharmLp.type = 'lowpass';
    this.subharmLp.frequency.value = 155;
    this.subharmLp.Q.value = 2.4;
    this.subharmShaper = ctx.createWaveShaper();
    this.subharmShaper.curve = makeSaturationCurve(38);
    this.subharmOut = ctx.createGain();
    this.subharmOut.gain.value = 0;

    this.fxInput.connect(this.subharmLp);
    this.subharmLp.connect(this.subharmShaper);
    this.subharmShaper.connect(this.subharmOut);
    this.subharmOut.connect(this.wetGain);

    // 14. Airy Shimmer Diffusion
    this.shimmerHp = ctx.createBiquadFilter();
    this.shimmerHp.type = 'highpass';
    this.shimmerHp.frequency.value = 1050;
    this.shimmerDelay = ctx.createDelay(0.08);
    this.shimmerDelay.delayTime.value = 0.022;
    this.shimmerLfo = ctx.createOscillator();
    this.shimmerLfo.type = 'sine';
    this.shimmerLfo.frequency.value = 2.2;
    this.shimmerLfoGain = ctx.createGain();
    this.shimmerLfoGain.gain.value = 0.004;
    this.shimmerVerb = ctx.createConvolver();
    this.shimmerVerb.buffer = reverbImpulse;
    this.shimmerOut = ctx.createGain();
    this.shimmerOut.gain.value = 0;

    this.shimmerLfo.connect(this.shimmerLfoGain);
    this.shimmerLfoGain.connect(this.shimmerDelay.delayTime);
    this.shimmerLfo.start();

    this.fxInput.connect(this.shimmerHp);
    this.shimmerHp.connect(this.shimmerDelay);
    this.shimmerDelay.connect(this.shimmerVerb);
    this.shimmerVerb.connect(this.shimmerOut);
    this.shimmerOut.connect(this.wetGain);

    // 15. Lo-Fi Tape Flutter
    this.lofiBp = ctx.createBiquadFilter();
    this.lofiBp.type = 'bandpass';
    this.lofiBp.frequency.value = 1250;
    this.lofiBp.Q.value = 0.72;
    this.lofiDelay = ctx.createDelay(0.08);
    this.lofiDelay.delayTime.value = 0.018;
    this.lofiLfo = ctx.createOscillator();
    this.lofiLfo.type = 'sine';
    this.lofiLfo.frequency.value = 1.45;
    this.lofiLfoGain = ctx.createGain();
    this.lofiLfoGain.gain.value = 0.0032;
    this.lofiShaper = ctx.createWaveShaper();
    this.lofiShaper.curve = makeSaturationCurve(22);
    this.lofiOut = ctx.createGain();
    this.lofiOut.gain.value = 0;

    this.lofiLfo.connect(this.lofiLfoGain);
    this.lofiLfoGain.connect(this.lofiDelay.delayTime);
    this.lofiLfo.start();

    this.fxInput.connect(this.lofiBp);
    this.lofiBp.connect(this.lofiDelay);
    this.lofiDelay.connect(this.lofiShaper);
    this.lofiShaper.connect(this.lofiOut);
    this.lofiOut.connect(this.wetGain);

    // 16. Dotted Filtered Dub Delay
    this.dubDelayNode = ctx.createDelay(4.0);
    this.dubDelayNode.delayTime.value = 0.36;
    this.dubFeedback = ctx.createGain();
    this.dubFeedback.gain.value = 0.56;
    this.dubBp = ctx.createBiquadFilter();
    this.dubBp.type = 'bandpass';
    this.dubBp.frequency.value = 1550;
    this.dubBp.Q.value = 1.1;
    this.dubOut = ctx.createGain();
    this.dubOut.gain.value = 0;

    this.fxInput.connect(this.dubDelayNode);
    this.dubDelayNode.connect(this.dubBp);
    this.dubBp.connect(this.dubFeedback);
    this.dubFeedback.connect(this.dubDelayNode);
    this.dubBp.connect(this.dubOut);
    this.dubOut.connect(this.wetGain);

    this.channelGain = ctx.createGain();
    this.channelGain.gain.value = 0.85;

    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyserData = new Float32Array(new ArrayBuffer(this.analyser.fftSize * 4));
    this.analyserFreqData = new Uint8Array(new ArrayBuffer(this.analyser.frequencyBinCount));

    // Real-Time Mid/Side Stereo Width Matrix (width = 0..1.35; 1.0 = identity)
    const widthSplitter = ctx.createChannelSplitter(2);
    const widthMidSum = ctx.createGain();
    widthMidSum.gain.value = 1;
    const wMidL = ctx.createGain();
    wMidL.gain.value = 0.5;
    const wMidR = ctx.createGain();
    wMidR.gain.value = 0.5;
    const widthSidePre = ctx.createGain();
    widthSidePre.gain.value = 1;
    const wSideL = ctx.createGain();
    wSideL.gain.value = 0.5;
    const wSideR = ctx.createGain();
    wSideR.gain.value = -0.5;
    this.stereoWidthGain = ctx.createGain();
    this.stereoWidthGain.gain.value = 1;
    const widthSideInvert = ctx.createGain();
    widthSideInvert.gain.value = -1;
    const widthMerger = ctx.createChannelMerger(2);

    this.sweepFilter.connect(widthSplitter);
    widthSplitter.connect(wMidL, 0);
    widthSplitter.connect(wMidR, 1);
    wMidL.connect(widthMidSum);
    wMidR.connect(widthMidSum);

    widthSplitter.connect(wSideL, 0);
    widthSplitter.connect(wSideR, 1);
    wSideL.connect(widthSidePre);
    wSideR.connect(widthSidePre);
    widthSidePre.connect(this.stereoWidthGain);

    widthMidSum.connect(widthMerger, 0, 0);
    widthMidSum.connect(widthMerger, 0, 1);
    this.stereoWidthGain.connect(widthMerger, 0, 0);
    this.stereoWidthGain.connect(widthSideInvert);
    widthSideInvert.connect(widthMerger, 0, 1);

    // Wire DSP graph through preEqSum (and pitch shifter AudioWorklet once attached)
    this.trimGain.connect(this.stemBypassGain);
    this.stemBypassGain.connect(this.preEqSum);
    this.stemVocalGain.connect(this.preEqSum);
    this.stemInstGain.connect(this.preEqSum);
    this.stemDrumsGain.connect(this.preEqSum);
    this.preEqSum.connect(this.eqLow);
    this.eqLow.connect(this.eqMid);
    this.eqMid.connect(this.eqHigh);
    this.eqHigh.connect(this.sweepFilter);

    widthMerger.connect(this.dryGain);
    widthMerger.connect(this.fxInput);

    this.dryGain.connect(this.channelGain);
    this.wetGain.connect(this.channelGain);

    this.channelGain.connect(this.analyser);
    this.channelGain.connect(destination);
  }

  attachPitchWorklet() {
    if (this.pitchWorklet) return;
    try {
      const node = new AudioWorkletNode(this.ctx, 'deckforge-pitch-shifter', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      this.preEqSum.disconnect(this.eqLow);
      this.preEqSum.connect(node);
      node.connect(this.eqLow);
      this.pitchWorklet = node;
      this.updatePitchShiftParam();
    } catch {
      // keep direct preEqSum -> eqLow path if AudioWorklet unavailable
    }
  }

  private updatePitchShiftParam() {
    if (!this.pitchWorklet) return;
    const param = this.pitchWorklet.parameters.get('pitchFactor');
    if (!param) return;
    const baseComp = this.keyLock ? 1 / Math.max(0.4, this.playbackRate) : 1;
    const semitoneMult = Math.pow(2, this.semitoneShift / 12);
    const factor = Math.max(0.55, Math.min(1.85, baseComp * semitoneMult));
    param.setTargetAtTime(factor, this.ctx.currentTime, 0.018);
  }

  setKeyLock(enabled: boolean) {
    this.keyLock = enabled;
    this.updatePitchShiftParam();
  }

  setSemitoneShift(semitones: number) {
    this.semitoneShift = Math.max(-4, Math.min(4, semitones));
    this.updatePitchShiftParam();
  }

  setHpssBuffers(
    harmonic: AudioBuffer | null,
    percussive: AudioBuffer | null,
    bass: AudioBuffer | null = null
  ) {
    this.harmonicBuffer = harmonic;
    this.percussiveBuffer = percussive;
    this.bassBuffer = bass;
    const hasHpss = Boolean(harmonic && percussive);
    const t = this.ctx.currentTime;
    this.midSideStemEnableGain.gain.setTargetAtTime(hasHpss ? 0 : 1, t, 0.03);
    this.midSideInstGate.gain.setTargetAtTime(hasHpss ? 0 : 1, t, 0.03);
    this.midSideDrumsEnableGain.gain.setTargetAtTime(hasHpss ? 0 : 1, t, 0.03);
    this.hpssVocalEnableGain.gain.setTargetAtTime(hasHpss ? 1.12 : 0, t, 0.03);
    this.hpssInstEnableGain.gain.setTargetAtTime(hasHpss ? 1.05 : 0, t, 0.03);
    this.hpssDrumsEnableGain.gain.setTargetAtTime(hasHpss ? 1.15 : 0, t, 0.03);
    this.hpssBassEnableGain.gain.setTargetAtTime(hasHpss && bass ? 1.02 : 0, t, 0.03);

    // If playing when background HPSS finishes, start synced stem sources cleanly
    if (hasHpss && this.isPlaying && !this.harmonicSource && !this.percussiveSource) {
      this.startHpssSourcesAt(this.getCurrentTime());
    }
  }

  getHarmonicBuffer(): AudioBuffer | null {
    return this.harmonicBuffer;
  }

  getPercussiveBuffer(): AudioBuffer | null {
    return this.percussiveBuffer;
  }

  getBassBuffer(): AudioBuffer | null {
    return this.bassBuffer;
  }

  private startHpssSourcesAt(offset: number) {
    if (!this.harmonicBuffer || !this.percussiveBuffer) return;
    this.stopHpssSources();

    const makeSyncedSrc = (buf: AudioBuffer, dest: AudioNode) => {
      const s = this.ctx.createBufferSource();
      s.buffer = buf;
      s.playbackRate.setValueAtTime(this.playbackRate, this.ctx.currentTime);
      if (this.loopActive && this.loopEndSec > this.loopStartSec + 0.02) {
        s.loop = true;
        s.loopStart = this.loopStartSec;
        s.loopEnd = this.loopEndSec;
      }
      s.connect(dest);
      s.start(0, Math.max(0, Math.min(buf.duration - 0.02, offset)));
      return s;
    };

    this.harmonicSource = makeSyncedSrc(this.harmonicBuffer, this.hpssVocalBus);
    this.percussiveSource = makeSyncedSrc(this.percussiveBuffer, this.hpssInstBus);
    if (this.bassBuffer) {
      this.bassSource = makeSyncedSrc(this.bassBuffer, this.hpssBassBus);
    }
  }

  private stopHpssSources() {
    for (const src of [this.harmonicSource, this.percussiveSource, this.bassSource]) {
      if (!src) continue;
      try {
        src.stop(0);
      } catch {
        // ignore
      }
      try {
        src.disconnect();
      } catch {
        // ignore
      }
    }
    this.harmonicSource = null;
    this.percussiveSource = null;
    this.bassSource = null;
  }

  setBuffer(buffer: AudioBuffer | null) {
    this.playToken++;
    this.stopSource();
    this.buffer = buffer;
    this.harmonicBuffer = null;
    this.percussiveBuffer = null;
    this.bassBuffer = null;
    this.semitoneShift = 0;
    const t = this.ctx.currentTime;
    this.midSideStemEnableGain.gain.setValueAtTime(1, t);
    this.midSideInstGate.gain.setValueAtTime(1, t);
    this.midSideDrumsEnableGain.gain.setValueAtTime(1, t);
    this.hpssVocalEnableGain.gain.setValueAtTime(0, t);
    this.hpssInstEnableGain.gain.setValueAtTime(0, t);
    this.hpssDrumsEnableGain.gain.setValueAtTime(0, t);
    this.hpssBassEnableGain.gain.setValueAtTime(0, t);
    this.isPlaying = false;
    this.anchorOffsetSec = 0;
    this.loopActive = false;
    this.updatePitchShiftParam();
  }

  getPlayToken(): number {
    return this.playToken;
  }

  getCurrentTime(): number {
    if (!this.buffer) return 0;
    if (!this.isPlaying) {
      return Math.max(0, Math.min(this.buffer.duration, this.anchorOffsetSec));
    }
    const elapsed = (this.ctx.currentTime - this.anchorCtxTime) * this.playbackRate;
    let pos = this.anchorOffsetSec + elapsed;

    if (this.loopActive && this.loopEndSec > this.loopStartSec + 0.02) {
      const loopLen = this.loopEndSec - this.loopStartSec;
      if (pos >= this.loopStartSec) {
        pos = this.loopStartSec + ((pos - this.loopStartSec) % loopLen);
      }
    }

    if (pos >= this.buffer.duration) {
      return this.buffer.duration;
    }
    return Math.max(0, pos);
  }

  play(fromOffset?: number, expectedToken?: number) {
    if (!this.buffer) return;
    if (typeof expectedToken === 'number' && expectedToken !== this.playToken) {
      return;
    }
    if (typeof fromOffset === 'number') {
      this.anchorOffsetSec = Math.max(0, Math.min(this.buffer.duration - 0.02, fromOffset));
    } else if (this.anchorOffsetSec >= this.buffer.duration - 0.05) {
      this.anchorOffsetSec = 0;
    }
    this.stopSource();

    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.playbackRate.setValueAtTime(this.playbackRate, this.ctx.currentTime);
    if (this.loopActive && this.loopEndSec > this.loopStartSec + 0.02) {
      src.loop = true;
      src.loopStart = this.loopStartSec;
      src.loopEnd = this.loopEndSec;
    }

    src.connect(this.trimGain);
    const offset = Math.max(0, Math.min(this.buffer.duration - 0.02, this.anchorOffsetSec));
    src.start(0, offset);

    src.onended = () => {
      if (this.source === src && !this.loopActive) {
        const cur = this.getCurrentTime();
        if (this.buffer && cur >= this.buffer.duration - 0.08) {
          this.isPlaying = false;
          this.anchorOffsetSec = this.buffer.duration;
          this.source = null;
          this.stopHpssSources();
        }
      }
    };

    this.source = src;
    this.anchorCtxTime = this.ctx.currentTime;
    this.isPlaying = true;
    this.startHpssSourcesAt(offset);
    this.updatePitchShiftParam();
  }

  pause() {
    this.playToken++;
    if (this.isPlaying) {
      this.anchorOffsetSec = this.getCurrentTime();
    }
    this.stopSource();
    this.isPlaying = false;
  }

  seek(seconds: number) {
    if (!this.buffer) return;
    const clamped = Math.max(0, Math.min(this.buffer.duration - 0.01, seconds));
    this.anchorOffsetSec = clamped;
    if (this.isPlaying) {
      this.play(clamped);
    }
  }

  setPlaybackRate(rate: number) {
    if (this.ctx.currentTime < this.tapeBrakingUntilCtxTime) {
      return;
    }
    const safeRate = Math.max(0.25, Math.min(2.5, rate));
    if (this.isPlaying) {
      this.anchorOffsetSec = this.getCurrentTime();
      this.anchorCtxTime = this.ctx.currentTime;
      for (const s of [this.source, this.harmonicSource, this.percussiveSource, this.bassSource]) {
        if (s) s.playbackRate.setTargetAtTime(safeRate, this.ctx.currentTime, 0.012);
      }
    }
    this.playbackRate = safeRate;
    this.updatePitchShiftParam();
  }

  triggerTapeBrake(durationSec = 0.85) {
    if (!this.source || !this.isPlaying) return;
    const now = this.ctx.currentTime;
    const dur = Math.max(0.3, Math.min(1.8, durationSec));
    this.tapeBrakingUntilCtxTime = now + dur;
    this.anchorOffsetSec = this.getCurrentTime();
    this.anchorCtxTime = now;
    try {
      for (const s of [this.source, this.harmonicSource, this.percussiveSource, this.bassSource]) {
        if (!s) continue;
        s.playbackRate.cancelScheduledValues(now);
        s.playbackRate.setValueAtTime(Math.max(0.25, this.playbackRate), now);
        s.playbackRate.exponentialRampToValueAtTime(0.08, now + dur);
      }
    } catch {
      // ignore scheduling edge cases
    }
  }

  setStereoWidth(width: number) {
    const safeWidth = Math.max(0.15, Math.min(1.35, width));
    this.stereoWidthGain.gain.setTargetAtTime(safeWidth, this.ctx.currentTime, 0.02);
  }

  setScratchRate(rate: number) {
    if (!this.source || !this.isPlaying) return;
    const safeRate = Math.max(0.1, Math.min(3.0, rate));
    this.anchorOffsetSec = this.getCurrentTime();
    this.anchorCtxTime = this.ctx.currentTime;
    for (const s of [this.source, this.harmonicSource, this.percussiveSource, this.bassSource]) {
      if (s) s.playbackRate.setTargetAtTime(safeRate, this.ctx.currentTime, 0.008);
    }
    this.playbackRate = safeRate;
  }

  setLoop(active: boolean, startSec: number, endSec: number) {
    this.loopActive = active;
    this.loopStartSec = startSec;
    this.loopEndSec = endSec;
    for (const s of [this.source, this.harmonicSource, this.percussiveSource, this.bassSource]) {
      if (!s) continue;
      s.loop = active && endSec > startSec + 0.02;
      s.loopStart = startSec;
      s.loopEnd = endSec;
    }
  }

  setStemMode(mode: StemIsolationMode) {
    this.stemMode = mode;
    const t = this.ctx.currentTime;
    this.stemBypassGain.gain.setTargetAtTime(mode === 'off' ? 1 : 0, t, 0.018);
    this.stemVocalGain.gain.setTargetAtTime(mode === 'vocal-focus' ? 1.15 : 0, t, 0.018);
    this.stemInstGain.gain.setTargetAtTime(mode === 'instrumental' ? 1.05 : 0, t, 0.018);
    this.stemDrumsGain.gain.setTargetAtTime(mode === 'drums-only' ? 1.18 : 0, t, 0.018);
  }

  /**
   * Upgrade #3: Real AudioBuffer Turntable Scratch Synthesizer.
   * Slices a short phrase (preferring HPSS vocal harmonic stem when ready) into forward +
   * time-reversed stereo micro-buffers with curved turntable platter rate sweeps & crisp fader cuts.
   */
  triggerTurntableScratch(params: {
    currentSec: number;
    bpm: number;
    pattern: 'baby' | 'chirp' | '2click-flare' | 'crab';
    preferHarmonic?: boolean;
  }) {
    const srcBuf =
      params.preferHarmonic && this.harmonicBuffer ? this.harmonicBuffer : this.buffer;
    if (!srcBuf || srcBuf.duration < 6) return;

    const ctx = this.ctx;
    const now = ctx.currentTime;
    const bpm = Math.max(65, Math.min(185, params.bpm || 124));
    const beatSec = 60 / bpm;
    const sr = srcBuf.sampleRate;

    const sliceSec = Math.max(0.18, Math.min(0.45, beatSec * 0.65));
    const startSec = Math.max(0.2, Math.min(srcBuf.duration - sliceSec - 0.1, params.currentSec));
    const startSample = Math.floor(startSec * sr);
    const frameCount = Math.max(2048, Math.min(srcBuf.length - startSample, Math.floor(sliceSec * sr)));
    if (frameCount < 2048) return;

    const numCh = Math.min(2, srcBuf.numberOfChannels);
    const fwdBuf = ctx.createBuffer(numCh, frameCount, sr);
    const revBuf = ctx.createBuffer(numCh, frameCount, sr);
    for (let ch = 0; ch < numCh; ch++) {
      const sData = srcBuf.getChannelData(ch);
      const fData = fwdBuf.getChannelData(ch);
      const rData = revBuf.getChannelData(ch);
      for (let i = 0; i < frameCount; i++) {
        const sample = sData[startSample + i];
        fData[i] = sample;
        rData[frameCount - 1 - i] = sample;
      }
    }

    // Crisp scratch tone bandpass so vocal/synth phrasing pops above sub
    const scratchHp = ctx.createBiquadFilter();
    scratchHp.type = 'highpass';
    scratchHp.frequency.setValueAtTime(210, now);
    scratchHp.Q.value = 1.1;
    scratchHp.connect(this.sweepFilter);

    type Grain = {
      dir: 'fwd' | 'rev';
      offsetSec: number;
      durSec: number;
      rStart: number;
      rEnd: number;
      faderClosedMid?: boolean;
    };

    const gDur = Math.max(0.06, Math.min(0.16, beatSec * 0.25));
    const grains: Grain[] =
      params.pattern === 'crab'
        ? [
            { dir: 'fwd', offsetSec: 0, durSec: gDur * 0.55, rStart: 1.55, rEnd: 1.15 },
            { dir: 'fwd', offsetSec: 0.02, durSec: gDur * 0.55, rStart: 1.45, rEnd: 1.1 },
            { dir: 'fwd', offsetSec: 0.04, durSec: gDur * 0.55, rStart: 1.6, rEnd: 1.2 },
            { dir: 'rev', offsetSec: 0, durSec: gDur * 1.1, rStart: 1.4, rEnd: 0.85 },
          ]
        : params.pattern === '2click-flare'
        ? [
            { dir: 'fwd', offsetSec: 0, durSec: gDur * 1.15, rStart: 1.45, rEnd: 1.05, faderClosedMid: true },
            { dir: 'rev', offsetSec: 0, durSec: gDur * 1.15, rStart: 1.35, rEnd: 0.9, faderClosedMid: true },
            { dir: 'fwd', offsetSec: 0, durSec: gDur * 1.25, rStart: 1.15, rEnd: 1.0 },
          ]
        : params.pattern === 'chirp'
        ? [
            { dir: 'fwd', offsetSec: 0, durSec: gDur * 0.85, rStart: 1.65, rEnd: 1.1 },
            { dir: 'rev', offsetSec: 0.02, durSec: gDur * 0.9, rStart: 1.5, rEnd: 0.95 },
            { dir: 'fwd', offsetSec: 0, durSec: gDur * 1.1, rStart: 1.35, rEnd: 1.0 },
          ]
        : [
            { dir: 'fwd', offsetSec: 0, durSec: gDur, rStart: 1.35, rEnd: 0.95 },
            { dir: 'rev', offsetSec: 0.01, durSec: gDur, rStart: 1.3, rEnd: 0.9 },
            { dir: 'fwd', offsetSec: 0, durSec: gDur * 1.2, rStart: 1.2, rEnd: 1.0 },
          ];

    let cursor = now;
    const totalDur = grains.reduce((acc, g) => acc + g.durSec, 0);
    this.sliceDuckUntilCtxTime = cursor + totalDur;
    this.trimGain.gain.setValueAtTime(this.activeTrimValue, cursor);
    this.trimGain.gain.linearRampToValueAtTime(this.activeTrimValue * 0.14, cursor + 0.01);
    this.trimGain.gain.setValueAtTime(this.activeTrimValue * 0.14, Math.max(cursor + 0.04, cursor + totalDur - 0.03));
    this.trimGain.gain.linearRampToValueAtTime(this.activeTrimValue, cursor + totalDur + 0.02);

    for (const g of grains) {
      const s = ctx.createBufferSource();
      s.buffer = g.dir === 'fwd' ? fwdBuf : revBuf;
      s.playbackRate.setValueAtTime(g.rStart, cursor);
      s.playbackRate.exponentialRampToValueAtTime(Math.max(0.4, g.rEnd), cursor + g.durSec);

      const vca = ctx.createGain();
      const att = 0.005;
      vca.gain.setValueAtTime(0.001, cursor);
      vca.gain.linearRampToValueAtTime(1.12, cursor + att);
      if (g.faderClosedMid && g.durSec > 0.06) {
        // Sharp transformer click cut inside the flare stroke
        vca.gain.linearRampToValueAtTime(0.04, cursor + g.durSec * 0.44);
        vca.gain.linearRampToValueAtTime(1.1, cursor + g.durSec * 0.56);
      }
      vca.gain.setValueAtTime(1.05, Math.max(cursor + att, cursor + g.durSec - 0.008));
      vca.gain.exponentialRampToValueAtTime(0.001, cursor + g.durSec);

      s.connect(vca);
      vca.connect(scratchHp);
      const maxRead = Math.max(0.01, fwdBuf.duration - g.durSec * Math.max(g.rStart, g.rEnd) - 0.01);
      s.start(cursor, Math.min(maxRead, g.offsetSec), g.durSec * Math.max(g.rStart, g.rEnd) + 0.02);
      cursor += g.durSec;
    }
  }

  /**
   * Advance #6: Track-Native Beat-Slice Re-Sequencer.
   * Extracts quantized 1/4 or 1/2 beat transient slices from the decoded AudioBuffer
   * and fires micro-sliced rhythmic stutters through the deck's EQ/FX sweep bus.
   */
  triggerBeatSlices(params: {
    currentSec: number;
    bpm: number;
    dropCueSec?: number;
    pattern?: number[];
    sliceBeats?: number;
  }) {
    if (!this.buffer || this.buffer.duration < 8) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const bpm = Math.max(65, Math.min(185, params.bpm || 124));
    const beatSec = 60 / bpm;
    const sliceBeats = params.sliceBeats ?? 0.5;
    const sliceDur = Math.max(0.11, Math.min(0.42, beatSec * sliceBeats));
    const seq = params.pattern && params.pattern.length > 0 ? params.pattern : [0, 0, 1, 2, 0, 1, 3, 2];

    const dur = this.buffer.duration;
    const baseAnchor =
      typeof params.dropCueSec === 'number' && params.dropCueSec > 4 && params.dropCueSec < dur - 4
        ? params.dropCueSec
        : Math.max(2, Math.min(dur - 4, params.currentSec));

    const sliceAnchors = [
      Math.max(0.5, Math.min(dur - sliceDur - 0.1, params.currentSec)),
      Math.max(0.5, Math.min(dur - sliceDur - 0.1, params.currentSec + beatSec * 0.5)),
      Math.max(0.5, Math.min(dur - sliceDur - 0.1, baseAnchor)),
      Math.max(0.5, Math.min(dur - sliceDur - 0.1, baseAnchor + beatSec)),
    ];

    const totalSeqDur = seq.length * sliceDur;
    this.sliceDuckUntilCtxTime = now + totalSeqDur;
    // Temporarily dip dry track level so clean beat-slices command the groove
    this.trimGain.gain.setValueAtTime(this.activeTrimValue, now);
    this.trimGain.gain.linearRampToValueAtTime(this.activeTrimValue * 0.18, now + 0.015);
    this.trimGain.gain.setValueAtTime(this.activeTrimValue * 0.18, now + Math.max(0.05, totalSeqDur - 0.04));
    this.trimGain.gain.linearRampToValueAtTime(this.activeTrimValue, now + totalSeqDur + 0.02);

    const fade = Math.min(0.006, sliceDur * 0.12);
    seq.forEach((slotIdx, stepIdx) => {
      const startCtx = now + stepIdx * sliceDur;
      const offset = sliceAnchors[Math.abs(slotIdx) % sliceAnchors.length];
      const src = ctx.createBufferSource();
      src.buffer = this.buffer!;
      src.playbackRate.setValueAtTime(this.playbackRate, startCtx);

      const env = ctx.createGain();
      const accent = stepIdx % 2 === 0 ? 1.05 : 0.84;
      env.gain.setValueAtTime(0.001, startCtx);
      env.gain.linearRampToValueAtTime(accent, startCtx + fade);
      env.gain.setValueAtTime(accent, startCtx + sliceDur - fade);
      env.gain.exponentialRampToValueAtTime(0.001, startCtx + sliceDur);

      src.connect(env);
      env.connect(this.sweepFilter);
      src.start(startCtx, offset, sliceDur + 0.01);
    });
  }

  updateEqAndFilter(params: {
    trim: number;
    low: number;
    mid: number;
    high: number;
    killLow: boolean;
    killMid: boolean;
    killHigh: boolean;
    filter: number;
  }) {
    const t = this.ctx.currentTime;
    this.activeTrimValue = params.trim;
    if (t >= this.sliceDuckUntilCtxTime) {
      this.trimGain.gain.setTargetAtTime(params.trim, t, 0.012);
    }

    const mapEq = (val: number, kill: boolean) => {
      if (kill) return -40;
      if (val < 0) return val * 32; // -32dB full cut
      return val * 12;              // +12dB boost
    };

    this.eqLow.gain.setTargetAtTime(mapEq(params.low, params.killLow), t, 0.015);
    this.eqMid.gain.setTargetAtTime(mapEq(params.mid, params.killMid), t, 0.015);
    this.eqHigh.gain.setTargetAtTime(mapEq(params.high, params.killHigh), t, 0.015);

    // Bipolar sweep filter (-1 LPF .. 0 bypass .. +1 HPF)
    const f = params.filter;
    if (Math.abs(f) < 0.04) {
      this.sweepFilter.type = 'lowpass';
      this.sweepFilter.frequency.setTargetAtTime(22000, t, 0.02);
      this.sweepFilter.Q.setTargetAtTime(0.7, t, 0.02);
    } else if (f < 0) {
      this.sweepFilter.type = 'lowpass';
      const norm = 1 + f; // 0..1
      const freq = 90 * Math.pow(220, norm);
      this.sweepFilter.frequency.setTargetAtTime(freq, t, 0.02);
      this.sweepFilter.Q.setTargetAtTime(1.5 + Math.abs(f) * 3.5, t, 0.02);
    } else {
      this.sweepFilter.type = 'highpass';
      const freq = 35 * Math.pow(180, f);
      this.sweepFilter.frequency.setTargetAtTime(freq, t, 0.02);
      this.sweepFilter.Q.setTargetAtTime(1.5 + f * 3.5, t, 0.02);
    }
  }

  updateFx(fx: DeckFxState, effectiveBpm: number) {
    const t = this.ctx.currentTime;
    this.currentFx = fx.type;
    this.fxEnabled = fx.enabled;
    this.fxWet = fx.wet;

    const beatSec = 60 / Math.max(60, effectiveBpm);
    const delayTime = Math.max(0.04, Math.min(3.5, beatSec * fx.beatDiv));
    this.echoDelay.delayTime.setTargetAtTime(delayTime, t, 0.03);

    const tremHz = Math.max(0.5, Math.min(18, (1 / Math.max(0.125, fx.beatDiv)) / beatSec));
    this.tremoloLfo.frequency.setTargetAtTime(tremHz, t, 0.025);
    const phaserHz = Math.max(0.15, Math.min(4.5, 0.5 / Math.max(0.25, fx.beatDiv)));
    this.phaserLfo.frequency.setTargetAtTime(phaserHz, t, 0.03);
    const autopanHz = Math.max(0.25, Math.min(8, 0.5 / (beatSec * Math.max(0.25, fx.beatDiv))));
    this.autopanLfo.frequency.setTargetAtTime(autopanHz, t, 0.03);
    const stutterHz = Math.max(2, Math.min(24, (2 / Math.max(0.25, fx.beatDiv)) / beatSec));
    this.stutterLfo.frequency.setTargetAtTime(stutterHz, t, 0.02);
    const ringHz = 42 + fx.beatDiv * 56;
    this.ringmodOsc.frequency.setTargetAtTime(ringHz, t, 0.03);
    const combDelaySec = 0.006 + fx.beatDiv * 0.012;
    this.combDelay.delayTime.setTargetAtTime(combDelaySec, t, 0.025);
    const dubTime = Math.max(0.06, Math.min(3.5, beatSec * fx.beatDiv * 0.75));
    this.dubDelayNode.delayTime.setTargetAtTime(dubTime, t, 0.03);
    this.lofiLfo.frequency.setTargetAtTime(1.1 + fx.beatDiv * 0.7, t, 0.03);

    this.echoOut.gain.setTargetAtTime(this.currentFx === 'echo' ? 1 : 0, t, 0.02);
    this.reverbOut.gain.setTargetAtTime(this.currentFx === 'reverb' ? 1.15 : 0, t, 0.02);
    this.flangerOut.gain.setTargetAtTime(this.currentFx === 'flanger' ? 0.95 : 0, t, 0.02);
    this.driveOut.gain.setTargetAtTime(this.currentFx === 'drive' ? 0.72 : 0, t, 0.02);
    this.phaserOut.gain.setTargetAtTime(this.currentFx === 'phaser' ? 0.95 : 0, t, 0.02);
    this.crushOut.gain.setTargetAtTime(this.currentFx === 'bitcrush' ? 0.82 : 0, t, 0.02);
    this.tremoloOut.gain.setTargetAtTime(this.currentFx === 'tremolo' ? 1.05 : 0, t, 0.02);
    this.chorusOut.gain.setTargetAtTime(this.currentFx === 'chorus' ? 0.9 : 0, t, 0.02);
    this.ringmodOut.gain.setTargetAtTime(this.currentFx === 'ringmod' ? 0.85 : 0, t, 0.02);
    this.autopanOut.gain.setTargetAtTime(this.currentFx === 'autopan' ? 1.0 : 0, t, 0.02);
    this.combOut.gain.setTargetAtTime(this.currentFx === 'comb' ? 0.72 : 0, t, 0.02);
    this.stutterOut.gain.setTargetAtTime(this.currentFx === 'stutter' ? 1.08 : 0, t, 0.02);
    this.subharmOut.gain.setTargetAtTime(this.currentFx === 'subharm' ? 1.25 : 0, t, 0.02);
    this.shimmerOut.gain.setTargetAtTime(this.currentFx === 'shimmer' ? 1.2 : 0, t, 0.02);
    this.lofiOut.gain.setTargetAtTime(this.currentFx === 'lofi' ? 1.15 : 0, t, 0.02);
    this.dubOut.gain.setTargetAtTime(this.currentFx === 'dubdelay' ? 1.1 : 0, t, 0.02);

    const wetAmount = this.fxEnabled ? this.fxWet : 0;
    let dryAmount = 1;
    if (this.fxEnabled) {
      if (
        this.currentFx === 'tremolo' ||
        this.currentFx === 'stutter' ||
        this.currentFx === 'autopan' ||
        this.currentFx === 'lofi'
      ) {
        dryAmount = Math.max(0.05, 1 - wetAmount * 0.95);
      } else if (
        this.currentFx === 'drive' ||
        this.currentFx === 'bitcrush' ||
        this.currentFx === 'ringmod'
      ) {
        dryAmount = Math.max(0.18, 1 - wetAmount * 0.76);
      } else if (this.currentFx === 'phaser' || this.currentFx === 'comb') {
        dryAmount = Math.max(0.32, 1 - wetAmount * 0.56);
      } else if (this.currentFx === 'subharm') {
        dryAmount = Math.max(0.65, 1 - wetAmount * 0.25);
      } else {
        dryAmount = Math.max(0.45, 1 - wetAmount * 0.4);
      }
    }

    this.wetGain.gain.setTargetAtTime(wetAmount, t, 0.02);
    this.dryGain.gain.setTargetAtTime(dryAmount, t, 0.02);
  }

  setOutputGain(gain: number) {
    this.baseOutputGain = Math.max(0, Math.min(1.5, gain));
    this.channelGain.gain.setTargetAtTime(
      this.baseOutputGain * this.sidechainDuckMult,
      this.ctx.currentTime,
      0.012
    );
  }

  setSidechainDuck(mult: number) {
    this.sidechainDuckMult = Math.max(0.35, Math.min(1, mult));
    this.channelGain.gain.setTargetAtTime(
      this.baseOutputGain * this.sidechainDuckMult,
      this.ctx.currentTime,
      0.018
    );
  }

  getLowBandEnergy(): number {
    if (!this.isPlaying) return 0;
    this.analyser.getByteFrequencyData(this.analyserFreqData);
    // Bins 0..3 cover sub & kick (< ~350Hz at 44.1kHz / 256 FFT)
    let sum = 0;
    const bins = Math.min(4, this.analyserFreqData.length);
    for (let i = 0; i < bins; i++) {
      sum += this.analyserFreqData[i];
    }
    return Math.min(1, sum / (bins * 255));
  }

  getLevel(): number {
    if (!this.isPlaying) return 0;
    this.analyser.getFloatTimeDomainData(this.analyserData);
    let sum = 0;
    for (let i = 0; i < this.analyserData.length; i++) {
      const s = this.analyserData[i];
      sum += s * s;
    }
    const rms = Math.sqrt(sum / this.analyserData.length);
    return Math.min(1, rms * 2.4);
  }

  private stopSource() {
    if (this.source) {
      const src = this.source;
      this.source = null;
      try {
        src.onended = null;
        src.stop(0);
      } catch {
        // already stopped
      }
      try {
        src.disconnect();
      } catch {
        // already disconnected
      }
    }
    this.stopHpssSources();
  }
}

export class DjAudioEngine {
  private ctx: AudioContext | null = null;
  private decks: Record<DeckId, DeckChannel> | null = null;
  private masterSum: GainNode | null = null;
  private voiceDuckFilter: BiquadFilterNode | null = null;
  private postDuckSum: GainNode | null = null;
  private voiceDuckUntilCtxTime = 0;
  private masterLimiter: DynamicsCompressorNode | null = null;
  private masterGainNode: GainNode | null = null;
  private masterAnalyser: AnalyserNode | null = null;
  private masterData: Float32Array<ArrayBuffer> | null = null;

  // Recording state
  private recordBus: GainNode | null = null;
  private scriptRecorder: ScriptProcessorNode | null = null;
  private leftRecChunks: Float32Array[] = [];
  private rightRecChunks: Float32Array[] = [];
  private isRecording = false;
  private tabStream: MediaStream | null = null;
  private tabSource: MediaStreamAudioSourceNode | null = null;

  // Live In-Key Groove & Drum Bridge Sequencer state
  private bridgePattern: GrooveBridgePattern = 'off';
  private bridgeBpm = 124;
  private bridgeKey = '8A';
  private bridgePitchRate = 1;
  private bridgeTimerId: ReturnType<typeof setInterval> | null = null;
  private bridgeStep = 0;
  private bridgeBar = 0;
  private bridgeNextStepTime = 0;
  private bridgeNoiseBuffer: AudioBuffer | null = null;

  // Remix Deck C: Captured 1-bar Vocal/Hook Micro-Sampler buffer
  private deckCHookBuffer: AudioBuffer | null = null;
  private deckCHookBpm = 124;
  private deckCHookTitle = '';
  private roomReverbImpulse: AudioBuffer | null = null;
  private pitchWorkletReady = false;

  private ensureInit() {
    if (this.ctx && this.decks) return;
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    const ctx = new AudioCtx({ latencyHint: 'interactive' });
    this.ctx = ctx;

    const reverbImpulse = createStereoReverbImpulse(ctx, 2.4, 2.7);
    this.roomReverbImpulse = reverbImpulse;

    this.masterSum = ctx.createGain();
    // Upgrade #1: Master Bus Mid-Pocket Voice Ducker + 3-Band Club Mastering Chain
    this.voiceDuckFilter = ctx.createBiquadFilter();
    this.voiceDuckFilter.type = 'peaking';
    this.voiceDuckFilter.frequency.value = 1100;
    this.voiceDuckFilter.Q.value = 0.65;
    this.voiceDuckFilter.gain.value = 0;

    this.postDuckSum = ctx.createGain();
    this.postDuckSum.gain.value = 1;

    this.masterSum.connect(this.voiceDuckFilter);
    this.voiceDuckFilter.connect(this.postDuckSum);

    // Band 1: Mono-Tightened Club Sub (< 125 Hz)
    const lowLp1 = ctx.createBiquadFilter();
    lowLp1.type = 'lowpass';
    lowLp1.frequency.value = 125;
    lowLp1.Q.value = 0.707;
    const lowSplit = ctx.createChannelSplitter(2);
    const lowMonoSum = ctx.createGain();
    lowMonoSum.gain.value = 0.5;
    const lowMonoMerge = ctx.createChannelMerger(2);
    const lowComp = ctx.createDynamicsCompressor();
    lowComp.threshold.value = -12;
    lowComp.knee.value = 6;
    lowComp.ratio.value = 3.5;
    lowComp.attack.value = 0.008;
    lowComp.release.value = 0.14;
    const lowBandGain = ctx.createGain();
    lowBandGain.gain.value = 1.02;

    this.postDuckSum.connect(lowLp1);
    lowLp1.connect(lowSplit);
    lowSplit.connect(lowMonoSum, 0);
    lowSplit.connect(lowMonoSum, 1);
    lowMonoSum.connect(lowMonoMerge, 0, 0);
    lowMonoSum.connect(lowMonoMerge, 0, 1);
    lowMonoMerge.connect(lowComp);
    lowComp.connect(lowBandGain);

    // Band 2: Punchy Mid Glue (125 Hz .. 3.5 kHz)
    const midHp = ctx.createBiquadFilter();
    midHp.type = 'highpass';
    midHp.frequency.value = 125;
    midHp.Q.value = 0.707;
    const midLp = ctx.createBiquadFilter();
    midLp.type = 'lowpass';
    midLp.frequency.value = 3500;
    midLp.Q.value = 0.707;
    const midComp = ctx.createDynamicsCompressor();
    midComp.threshold.value = -10;
    midComp.knee.value = 6;
    midComp.ratio.value = 2.6;
    midComp.attack.value = 0.006;
    midComp.release.value = 0.12;
    const midBandGain = ctx.createGain();
    midBandGain.gain.value = 1.0;

    this.postDuckSum.connect(midHp);
    midHp.connect(midLp);
    midLp.connect(midComp);
    midComp.connect(midBandGain);

    // Band 3: Crisp Air Highs (> 3.5 kHz)
    const highHp = ctx.createBiquadFilter();
    highHp.type = 'highpass';
    highHp.frequency.value = 3500;
    highHp.Q.value = 0.707;
    const highComp = ctx.createDynamicsCompressor();
    highComp.threshold.value = -11;
    highComp.knee.value = 5;
    highComp.ratio.value = 2.4;
    highComp.attack.value = 0.003;
    highComp.release.value = 0.09;
    const highBandGain = ctx.createGain();
    highBandGain.gain.value = 1.05;

    this.postDuckSum.connect(highHp);
    highHp.connect(highComp);
    highComp.connect(highBandGain);

    const masteringSum = ctx.createGain();
    masteringSum.gain.value = 1.0;
    lowBandGain.connect(masteringSum);
    midBandGain.connect(masteringSum);
    highBandGain.connect(masteringSum);

    this.masterLimiter = ctx.createDynamicsCompressor();
    this.masterLimiter.threshold.value = -1.5;
    this.masterLimiter.knee.value = 2.5;
    this.masterLimiter.ratio.value = 20.0;
    this.masterLimiter.attack.value = 0.001;
    this.masterLimiter.release.value = 0.075;

    this.masterGainNode = ctx.createGain();
    this.masterGainNode.gain.value = 0.9;

    this.masterAnalyser = ctx.createAnalyser();
    this.masterAnalyser.fftSize = 256;
    this.masterData = new Float32Array(new ArrayBuffer(this.masterAnalyser.fftSize * 4));

    this.recordBus = ctx.createGain();
    this.recordBus.gain.value = 1.0;

    masteringSum.connect(this.masterLimiter);
    this.masterLimiter.connect(this.masterGainNode);
    this.masterGainNode.connect(this.masterAnalyser);
    this.masterGainNode.connect(ctx.destination);
    this.masterGainNode.connect(this.recordBus);

    this.decks = {
      A: new DeckChannel(ctx, this.masterSum, reverbImpulse),
      B: new DeckChannel(ctx, this.masterSum, reverbImpulse),
    };

    // Load offline Pitch/Key-Lock AudioWorklet asynchronously without blocking first audio frame
    ensurePitchWorkletLoaded(ctx).then((ok) => {
      this.pitchWorkletReady = ok;
      if (ok && this.decks) {
        this.decks.A.attachPitchWorklet();
        this.decks.B.attachPitchWorklet();
      }
    });
  }

  public async resume(): Promise<AudioContext> {
    this.ensureInit();
    if (this.ctx!.state === 'suspended') {
      await this.ctx!.resume();
    }
    if (!this.pitchWorkletReady) {
      ensurePitchWorkletLoaded(this.ctx!).then((ok) => {
        if (ok && this.decks) {
          this.pitchWorkletReady = true;
          this.decks.A.attachPitchWorklet();
          this.decks.B.attachPitchWorklet();
        }
      });
    }
    return this.ctx!;
  }

  public getSampleRate(): number {
    this.ensureInit();
    return this.ctx!.sampleRate;
  }

  public async decodeAudioData(arrayBuffer: ArrayBuffer): Promise<AudioBuffer> {
    const ctx = await this.resume();
    return ctx.decodeAudioData(arrayBuffer);
  }

  public setDeckBuffer(deckId: DeckId, buffer: AudioBuffer | null) {
    this.ensureInit();
    this.decks![deckId].setBuffer(buffer);
  }

  public async playDeck(deckId: DeckId, offset?: number) {
    this.ensureInit();
    const token = this.decks![deckId].getPlayToken();
    await this.resume();
    this.decks![deckId].play(offset, token);
  }

  public pauseDeck(deckId: DeckId) {
    if (!this.decks) return;
    this.decks[deckId].pause();
  }

  public seekDeck(deckId: DeckId, seconds: number) {
    this.ensureInit();
    this.decks![deckId].seek(seconds);
  }

  public setDeckRate(deckId: DeckId, rate: number) {
    this.ensureInit();
    this.decks![deckId].setPlaybackRate(rate);
  }

  public setDeckScratchRate(deckId: DeckId, rate: number) {
    this.ensureInit();
    this.decks![deckId].setScratchRate(rate);
  }

  public setDeckLoop(deckId: DeckId, active: boolean, startSec: number, endSec: number) {
    this.ensureInit();
    this.decks![deckId].setLoop(active, startSec, endSec);
  }

  public getDeckTime(deckId: DeckId): number {
    if (!this.decks) return 0;
    return this.decks[deckId].getCurrentTime();
  }

  public isDeckPlaying(deckId: DeckId): boolean {
    if (!this.decks) return false;
    return this.decks[deckId].isPlaying;
  }

  public updateDeckEq(
    deckId: DeckId,
    params: {
      trim: number;
      low: number;
      mid: number;
      high: number;
      killLow: boolean;
      killMid: boolean;
      killHigh: boolean;
      filter: number;
    }
  ) {
    this.ensureInit();
    this.decks![deckId].updateEqAndFilter(params);
  }

  public updateDeckFx(deckId: DeckId, fx: DeckFxState, effectiveBpm: number) {
    this.ensureInit();
    this.decks![deckId].updateFx(fx, effectiveBpm);
  }

  public setDeckStemMode(deckId: DeckId, mode: StemIsolationMode) {
    this.ensureInit();
    this.decks![deckId].setStemMode(mode);
  }

  public setDeckKeyLock(deckId: DeckId, enabled: boolean) {
    this.ensureInit();
    this.decks![deckId].setKeyLock(enabled);
  }

  public setDeckSemitoneShift(deckId: DeckId, semitones: number) {
    this.ensureInit();
    this.decks![deckId].setSemitoneShift(semitones);
  }

  public setDeckHpssBuffers(
    deckId: DeckId,
    harmonic: AudioBuffer | null,
    percussive: AudioBuffer | null,
    bass: AudioBuffer | null = null
  ) {
    this.ensureInit();
    this.decks![deckId].setHpssBuffers(harmonic, percussive, bass);
  }

  public getDeckAudioBuffers(deckId: DeckId): {
    buffer: AudioBuffer | null;
    harmonicBuffer: AudioBuffer | null;
    percussiveBuffer: AudioBuffer | null;
    bassBuffer: AudioBuffer | null;
  } {
    if (!this.decks) {
      return { buffer: null, harmonicBuffer: null, percussiveBuffer: null, bassBuffer: null };
    }
    const ch = this.decks[deckId];
    return {
      buffer: ch.buffer,
      harmonicBuffer: ch.getHarmonicBuffer(),
      percussiveBuffer: ch.getPercussiveBuffer(),
      bassBuffer: ch.getBassBuffer(),
    };
  }

  public triggerDeckTurntableScratch(
    deckId: DeckId,
    params: {
      currentSec: number;
      bpm: number;
      pattern: 'baby' | 'chirp' | '2click-flare' | 'crab';
      preferHarmonic?: boolean;
    }
  ) {
    this.ensureInit();
    this.decks![deckId].triggerTurntableScratch(params);
  }

  private duckMasterForVoice(durationSec: number) {
    if (!this.ctx || !this.voiceDuckFilter) return;
    const now = this.ctx.currentTime;
    const holdUntil = Math.max(this.voiceDuckUntilCtxTime, now + Math.max(0.25, Math.min(4.5, durationSec)));
    this.voiceDuckUntilCtxTime = holdUntil;
    const p = this.voiceDuckFilter.gain;
    try {
      p.cancelScheduledValues(now);
      p.setValueAtTime(p.value, now);
      p.linearRampToValueAtTime(-3.2, now + 0.04);
      p.setValueAtTime(-3.2, Math.max(now + 0.06, holdUntil - 0.14));
      p.linearRampToValueAtTime(0, holdUntil);
    } catch {
      // ignore automation overlap
    }
  }

  public triggerDeckBeatSlices(
    deckId: DeckId,
    params: {
      currentSec: number;
      bpm: number;
      dropCueSec?: number;
      pattern?: number[];
      sliceBeats?: number;
    }
  ) {
    this.ensureInit();
    this.decks![deckId].triggerBeatSlices(params);
  }

  public computeCrossfaderGains(
    crossfader: number,
    curve: CrossfaderCurve,
    reverse: boolean
  ): { gainA: number; gainB: number } {
    const xf = reverse ? -crossfader : crossfader; // -1..1
    const norm = (xf + 1) * 0.5; // 0 (full A) .. 1 (full B)

    if (curve === 'cut') {
      const gainA = norm > 0.92 ? Math.max(0, (1 - norm) / 0.08) : 1;
      const gainB = norm < 0.08 ? Math.max(0, norm / 0.08) : 1;
      return { gainA, gainB };
    }
    if (curve === 'blend') {
      // Smooth blend curve
      return {
        gainA: Math.cos(norm * Math.PI * 0.5) * 1.05,
        gainB: Math.sin(norm * Math.PI * 0.5) * 1.05,
      };
    }
    // Constant-power curve
    return {
      gainA: Math.cos(norm * Math.PI * 0.5),
      gainB: Math.sin(norm * Math.PI * 0.5),
    };
  }

  public updateMixVolumes(params: {
    volA: number;
    volB: number;
    crossfader: number;
    curve: CrossfaderCurve;
    reverse: boolean;
    masterGain: number;
  }) {
    this.ensureInit();
    const { gainA, gainB } = this.computeCrossfaderGains(
      params.crossfader,
      params.curve,
      params.reverse
    );
    this.decks!.A.setOutputGain(params.volA * gainA);
    this.decks!.B.setOutputGain(params.volB * gainB);
    this.masterGainNode!.gain.setTargetAtTime(params.masterGain, this.ctx!.currentTime, 0.015);
  }

  public getDeckLevel(deckId: DeckId): number {
    return this.decks ? this.decks[deckId].getLevel() : 0;
  }

  public getDeckLowBandLevel(deckId: DeckId): number {
    return this.decks ? this.decks[deckId].getLowBandEnergy() : 0;
  }

  public setDeckSidechainDuck(deckId: DeckId, mult: number) {
    if (!this.decks) return;
    this.decks[deckId].setSidechainDuck(mult);
  }

  public setDeckStereoWidth(deckId: DeckId, width: number) {
    if (!this.decks) return;
    this.decks[deckId].setStereoWidth(width);
  }

  public triggerDeckTapeBrake(deckId: DeckId, durationSec = 0.85) {
    if (!this.decks) return;
    this.decks[deckId].triggerTapeBrake(durationSec);
  }

  // =========================================================================
  // Remix Deck C: Live Vocal/Hook Micro-Sampler Capture & Ping-Pong Callback
  // =========================================================================

  public captureDeckVocalHook(
    deckId: DeckId,
    params: {
      bpm: number;
      dropCueSec?: number;
      waveform?: WaveformBandSample[];
      title?: string;
    }
  ): boolean {
    if (!this.ctx || !this.decks) return false;
    // Upgrade #2: Prefer separated HPSS Harmonic (Vocal/Synth) buffer over raw full mix
    const hpssHarm = this.decks[deckId].getHarmonicBuffer();
    const srcBuf = hpssHarm || this.decks[deckId].buffer;
    if (!srcBuf || srcBuf.duration < 12) return false;

    const bpm = Math.max(65, Math.min(185, params.bpm || 124));
    const barSec = Math.max(1.2, Math.min(2.8, (60 / bpm) * 4));
    let startSec = srcBuf.duration * 0.35;

    if (
      typeof params.dropCueSec === 'number' &&
      params.dropCueSec > 4 &&
      params.dropCueSec + barSec < srcBuf.duration - 2
    ) {
      startSec = params.dropCueSec;
    } else if (params.waveform && params.waveform.length >= 24) {
      // Find peak vocal/mid-band energy window in [24%..68%] of track
      const wf = params.waveform;
      const startIdx = Math.floor(wf.length * 0.24);
      const endIdx = Math.floor(wf.length * 0.68);
      let bestScore = -1;
      let bestIdx = startIdx;
      for (let i = startIdx; i < endIdx; i++) {
        const s = wf[i];
        const score = s.mid * 1.45 - s.low * 0.35 + s.peak * 0.2;
        if (score > bestScore) {
          bestScore = score;
          bestIdx = i;
        }
      }
      startSec = (bestIdx / wf.length) * srcBuf.duration;
    }

    startSec = Math.max(1, Math.min(srcBuf.duration - barSec - 0.5, startSec));
    const sr = srcBuf.sampleRate;
    const startFrame = Math.floor(startSec * sr);
    const frameCount = Math.max(1024, Math.min(srcBuf.length - startFrame, Math.floor(barSec * sr)));
    if (frameCount < 2048) return false;

    const channels = Math.min(2, srcBuf.numberOfChannels);
    const clip = this.ctx.createBuffer(channels, frameCount, sr);
    const fadeSamples = Math.min(Math.floor(sr * 0.012), Math.floor(frameCount * 0.1));

    for (let ch = 0; ch < channels; ch++) {
      const srcData = srcBuf.getChannelData(ch);
      const dstData = clip.getChannelData(ch);
      for (let i = 0; i < frameCount; i++) {
        let env = 1;
        if (i < fadeSamples) env = i / fadeSamples;
        else if (i > frameCount - fadeSamples) env = (frameCount - i) / fadeSamples;
        dstData[i] = srcData[startFrame + i] * env;
      }
    }

    this.deckCHookBuffer = clip;
    this.deckCHookBpm = bpm;
    this.deckCHookTitle = params.title || 'Previous Track';
    return true;
  }

  public hasDeckCHook(): boolean {
    return Boolean(this.deckCHookBuffer);
  }

  public getDeckCHookLabel(): string {
    return this.deckCHookTitle;
  }

  public clearDeckCHook() {
    this.deckCHookBuffer = null;
    this.deckCHookTitle = '';
  }

  public async triggerDeckCHook(params: {
    pattern: 'quarter' | 'half' | 'full-echo';
    targetBpm: number;
    gainAmt?: number;
  }) {
    if (!this.deckCHookBuffer) return;
    const ctx = await this.resume();
    if (!this.masterSum) return;

    const now = ctx.currentTime;
    const targetBpm = Math.max(65, Math.min(185, params.targetBpm || 124));
    const beatSec = 60 / targetBpm;
    const rate = Math.max(0.76, Math.min(1.32, targetBpm / Math.max(65, this.deckCHookBpm)));
    const gainAmt = Math.max(0.15, Math.min(0.95, params.gainAmt ?? 0.62));

    // Vocal bandpass (260Hz - 3.8kHz) + stereo ping-pong delay bus
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.setValueAtTime(260, now);
    hp.Q.value = 0.85;

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(3800, now);
    lp.Q.value = 0.85;

    const dryBus = ctx.createGain();
    dryBus.gain.value = gainAmt;

    const delayL = ctx.createDelay(2.0);
    delayL.delayTime.value = Math.min(1.5, beatSec * 0.5);
    const delayR = ctx.createDelay(2.0);
    delayR.delayTime.value = Math.min(1.5, beatSec * 0.75);
    const fbL = ctx.createGain();
    fbL.gain.value = 0.36;
    const fbR = ctx.createGain();
    fbR.gain.value = 0.36;
    const panL = ctx.createStereoPanner();
    panL.pan.value = -0.68;
    const panR = ctx.createStereoPanner();
    panR.pan.value = 0.68;
    const wetBus = ctx.createGain();
    wetBus.gain.value = gainAmt * 0.55;

    const voiceOut = this.postDuckSum || this.masterSum;
    hp.connect(lp);
    lp.connect(dryBus);
    dryBus.connect(voiceOut);

    lp.connect(delayL);
    delayL.connect(fbL);
    fbL.connect(delayR);
    delayR.connect(fbR);
    fbR.connect(delayL);

    delayL.connect(panL);
    delayR.connect(panR);
    panL.connect(wetBus);
    panR.connect(wetBus);
    wetBus.connect(voiceOut);

    const bufDur = this.deckCHookBuffer.duration / rate;
    const triggerSlice = (startWhen: number, sliceDur: number, offsetSec = 0) => {
      if (!this.deckCHookBuffer) return;
      const src = ctx.createBufferSource();
      src.buffer = this.deckCHookBuffer;
      src.playbackRate.setValueAtTime(rate, startWhen);
      const env = ctx.createGain();
      const fade = Math.min(0.015, sliceDur * 0.15);
      env.gain.setValueAtTime(0.001, startWhen);
      env.gain.linearRampToValueAtTime(1, startWhen + fade);
      env.gain.setValueAtTime(1, startWhen + Math.max(fade, sliceDur - fade));
      env.gain.exponentialRampToValueAtTime(0.001, startWhen + sliceDur);
      src.connect(env);
      env.connect(hp);
      src.start(startWhen, Math.max(0, Math.min(this.deckCHookBuffer.duration - 0.15, offsetSec)), sliceDur * rate + 0.02);
    };

    if (params.pattern === 'quarter') {
      const slice = Math.min(bufDur * 0.5, beatSec * 0.9);
      this.duckMasterForVoice(beatSec * 1.6);
      triggerSlice(now, slice, 0);
      triggerSlice(now + beatSec, slice, 0);
    } else if (params.pattern === 'half') {
      const slice = Math.min(bufDur * 0.65, beatSec * 1.8);
      this.duckMasterForVoice(beatSec * 3.0);
      triggerSlice(now, slice, 0);
      triggerSlice(now + beatSec * 2, slice, this.deckCHookBuffer.duration * 0.35);
    } else {
      const dur = Math.min(bufDur, beatSec * 3.8);
      this.duckMasterForVoice(dur + 0.2);
      triggerSlice(now, dur, 0);
    }
  }

  public getLevels(): { deckA: number; deckB: number; master: number } {
    if (!this.decks || !this.masterAnalyser || !this.masterData) {
      return { deckA: 0, deckB: 0, master: 0 };
    }
    this.masterAnalyser.getFloatTimeDomainData(this.masterData);
    let sum = 0;
    for (let i = 0; i < this.masterData.length; i++) {
      const s = this.masterData[i];
      sum += s * s;
    }
    const masterRms = Math.min(1, Math.sqrt(sum / this.masterData.length) * 2.5);
    return {
      deckA: this.decks.A.getLevel(),
      deckB: this.decks.B.getLevel(),
      master: masterRms,
    };
  }

  public async startRecording(includeTabAudio = false): Promise<{ tabCaptured: boolean }> {
    const ctx = await this.resume();
    if (this.isRecording) return { tabCaptured: Boolean(this.tabStream) };

    let tabCaptured = false;
    if (includeTabAudio && navigator.mediaDevices?.getDisplayMedia) {
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: true,
        });
        const audioTracks = stream.getAudioTracks();
        if (audioTracks.length > 0) {
          this.tabStream = stream;
          this.tabSource = ctx.createMediaStreamSource(new MediaStream(audioTracks));
          this.tabSource.connect(this.recordBus!);
          tabCaptured = true;
        } else {
          stream.getTracks().forEach((t) => t.stop());
        }
      } catch {
        tabCaptured = false;
      }
    }

    this.leftRecChunks = [];
    this.rightRecChunks = [];

    // Tap master record bus cleanly into PCM Float32 arrays
    const proc = ctx.createScriptProcessor(4096, 2, 2);
    const silentGain = ctx.createGain();
    silentGain.gain.value = 0;

    proc.onaudioprocess = (e) => {
      if (!this.isRecording) return;
      const l = e.inputBuffer.getChannelData(0);
      const r = e.inputBuffer.numberOfChannels > 1 ? e.inputBuffer.getChannelData(1) : l;
      this.leftRecChunks.push(new Float32Array(l));
      this.rightRecChunks.push(new Float32Array(r));
    };

    this.recordBus!.connect(proc);
    proc.connect(silentGain);
    silentGain.connect(ctx.destination);

    this.scriptRecorder = proc;
    this.isRecording = true;

    return { tabCaptured };
  }

  public stopRecording(): { blob: Blob; durationSec: number } | null {
    if (!this.isRecording || !this.ctx) return null;
    this.isRecording = false;

    if (this.scriptRecorder) {
      try {
        this.recordBus?.disconnect(this.scriptRecorder);
        this.scriptRecorder.disconnect();
      } catch {
        // ignore
      }
      this.scriptRecorder = null;
    }

    if (this.tabSource) {
      try {
        this.tabSource.disconnect();
      } catch {
        // ignore
      }
      this.tabSource = null;
    }

    if (this.tabStream) {
      this.tabStream.getTracks().forEach((t) => t.stop());
      this.tabStream = null;
    }

    const totalSamples = this.leftRecChunks.reduce((acc, c) => acc + c.length, 0);
    const durationSec = totalSamples / this.ctx.sampleRate;
    const blob = encodeStereoChunksToWav(
      this.leftRecChunks,
      this.rightRecChunks,
      this.ctx.sampleRate
    );

    this.leftRecChunks = [];
    this.rightRecChunks = [];

    return { blob, durationSec };
  }

  /**
   * Fires a synthesized stereo DJ sound trick directly into the Master Bus
   * (captured by VU meters and WAV Master Recorder).
   */
  public async playSoundTrick(
    type: SoundTrickType,
    bpm = 124,
    musicalKey?: string,
    pitchRate = 1
  ) {
    const ctx = await this.resume();
    if (!this.masterSum) return;
    const now = ctx.currentTime;
    const beatSec = 60 / Math.max(60, bpm);
    const harmony = camelotToHarmony(musicalKey, pitchRate);

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
      g.connect(this.masterSum);
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
      g.connect(this.masterSum);
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
      g.connect(this.masterSum);
      g.connect(delay);
      delay.connect(this.masterSum);

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
      g.connect(this.masterSum);
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
      g.connect(this.masterSum);
      g.connect(delay);
      delay.connect(this.masterSum);

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
      masterOut.connect(this.masterSum);

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
      g.connect(this.masterSum);
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
        g.connect(this.masterSum);
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
      g.connect(this.masterSum);
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
      g.connect(this.masterSum);
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
      stabOut.connect(this.masterSum);
      stabOut.connect(delay);
      delay.connect(this.masterSum);

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
        g.connect(this.masterSum);
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
      g.connect(this.masterSum);
      return;
    }

    if (type === 'tom-fill') {
      const master = this.masterSum;
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
        g.connect(master);
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
      g.connect(this.masterSum);
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
      g.connect(this.masterSum);

      root.forEach((f, idx) => {
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(f, now);
        osc.frequency.exponentialRampToValueAtTime(f * 1.498, now + dur); // climb perfect 5th
        osc.detune.setValueAtTime((idx - 1) * 9, now);
        osc.connect(lp);
        osc.start(now);
        osc.stop(now + dur + 0.02);
      });
    }
  }

  // =========================================================================
  // Offline Multi-Formant DJ Voice, Grooving, Shout & Hype Synth Engine
  // =========================================================================

  public async playVoiceDrop(
    voiceId: DjVoiceDropId,
    bpm = 124,
    musicalKey?: string,
    pitchRate = 1
  ) {
    const ctx = await this.resume();
    if (!this.masterSum) return;
    const now = ctx.currentTime + 0.01;
    const safeBpm = Math.max(65, Math.min(185, bpm || 124));
    const beatSec = 60 / safeBpm;
    const harmony = camelotToHarmony(musicalKey, pitchRate);
    const noiseBuf = this.ensureBridgeNoise(ctx);

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

    // Master Voice Bus with presence comp + optional stereo slapback + club room reverb
    const voiceBus = ctx.createGain();
    voiceBus.gain.value = 0.92;

    const presence = ctx.createBiquadFilter();
    presence.type = 'peaking';
    presence.frequency.value = 2600;
    presence.Q.value = 1.1;
    presence.gain.value = 4.5;

    const hipass = ctx.createBiquadFilter();
    hipass.type = 'highpass';
    hipass.frequency.value = 115;

    const voiceOut = this.postDuckSum || this.masterSum;
    this.duckMasterForVoice(Math.max(0.75, Math.min(2.2, beatSec * 2.2)));

    voiceBus.connect(hipass);
    hipass.connect(presence);
    presence.connect(voiceOut);

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
        lp.frequency.value = 2600;
        const panL = ctx.createStereoPanner();
        panL.pan.value = -0.58;
        const panR = ctx.createStereoPanner();
        panR.pan.value = 0.58;
        const wet = ctx.createGain();
        wet.gain.value = 0.36;

        presence.connect(lp);
        lp.connect(delayL);
        delayL.connect(fb);
        fb.connect(delayR);
        delayR.connect(delayL);
        delayL.connect(panL);
        delayR.connect(panR);
        panL.connect(wet);
        panR.connect(wet);
        wet.connect(voiceOut!);
      }
      if (verbAmt > 0 && this.roomReverbImpulse) {
        const conv = ctx.createConvolver();
        conv.buffer = this.roomReverbImpulse;
        const vg = ctx.createGain();
        vg.gain.value = verbAmt;
        presence.connect(conv);
        conv.connect(vg);
        vg.connect(voiceOut!);
      }
    };

    const spawnConsonant = (
      atTime: number,
      dur: number,
      freq: number,
      q: number,
      gainAmt: number,
      panVal = 0
    ) => {
      const src = ctx.createBufferSource();
      src.buffer = noiseBuf;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(freq, atTime);
      bp.Q.value = q;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.001, atTime);
      g.gain.linearRampToValueAtTime(gainAmt, atTime + Math.min(0.008, dur * 0.25));
      g.gain.exponentialRampToValueAtTime(0.001, atTime + dur);
      const pan = ctx.createStereoPanner();
      pan.pan.value = panVal;
      src.connect(bp);
      bp.connect(g);
      g.connect(pan);
      pan.connect(voiceBus);
      src.start(atTime);
      src.stop(atTime + dur + 0.02);
    };

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
    }) => {
      const count = opts.crowdCount ?? 1;
      const gainTotal = opts.gain ?? 0.36;
      const perVoiceGain = gainTotal / Math.sqrt(count);
      const vStart = VOWELS[opts.vowelStart];
      const vEnd = VOWELS[opts.vowelEnd ?? opts.vowelStart];

      for (let v = 0; v < count; v++) {
        const microDelay = count > 1 ? v * 0.0055 : 0;
        const st = opts.start + microDelay;
        const d = opts.dur;
        const detuneRatio =
          count > 1 ? 1 + ((v - (count - 1) / 2) / Math.max(1, count)) * 0.028 : 1;
        const voicePan =
          count > 1
            ? Math.max(-0.85, Math.min(0.85, ((v / Math.max(1, count - 1)) * 2 - 1) * 0.72))
            : opts.pan ?? 0;

        // Glottal source (saw + slightly detuned saw + breathy whisper noise)
        const exc = ctx.createGain();
        exc.gain.value = 1;

        const osc1 = ctx.createOscillator();
        osc1.type = 'sawtooth';
        osc1.frequency.setValueAtTime(opts.pitchStart * detuneRatio, st);
        if (opts.pitchMid) {
          osc1.frequency.linearRampToValueAtTime(opts.pitchMid * detuneRatio, st + d * 0.45);
        }
        osc1.frequency.linearRampToValueAtTime(opts.pitchEnd * detuneRatio, st + d);

        const osc2 = ctx.createOscillator();
        osc2.type = 'sawtooth';
        osc2.frequency.setValueAtTime(opts.pitchStart * detuneRatio * 1.006, st);
        if (opts.pitchMid) {
          osc2.frequency.linearRampToValueAtTime(opts.pitchMid * detuneRatio * 1.006, st + d * 0.45);
        }
        osc2.frequency.linearRampToValueAtTime(opts.pitchEnd * detuneRatio * 1.006, st + d);

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

        const o1Gain = ctx.createGain();
        o1Gain.gain.value = 0.55;
        const o2Gain = ctx.createGain();
        o2Gain.gain.value = 0.45;
        osc1.connect(o1Gain);
        osc2.connect(o2Gain);
        o1Gain.connect(exc);
        o2Gain.connect(exc);

        if ((opts.aspirateAmt ?? 0.16) > 0) {
          const nSrc = ctx.createBufferSource();
          nSrc.buffer = noiseBuf;
          nSrc.loop = true;
          const nGain = ctx.createGain();
          nGain.gain.value = opts.aspirateAmt ?? 0.16;
          nSrc.connect(nGain);
          nGain.connect(exc);
          nSrc.start(st);
          nSrc.stop(st + d + 0.03);
        }

        // Parallel 3-formant resonant vocal tract filter bank
        const sumFormants = ctx.createGain();
        const formantQ = [6.5, 8.5, 10.5];
        const formantWeights = [0.68, 0.42, 0.24];
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

        const env = ctx.createGain();
        const atk = Math.min(0.028, d * 0.14);
        env.gain.setValueAtTime(0.001, st);
        env.gain.linearRampToValueAtTime(perVoiceGain, st + atk);
        env.gain.setValueAtTime(perVoiceGain * 0.92, st + Math.max(atk, d * 0.72));
        env.gain.exponentialRampToValueAtTime(0.001, st + d);

        const panNode = ctx.createStereoPanner();
        panNode.pan.value = voicePan;

        sumFormants.connect(env);
        env.connect(panNode);
        panNode.connect(voiceBus);

        if (opts.subPunch && v === 0) {
          const subOsc = ctx.createOscillator();
          subOsc.type = 'sine';
          subOsc.frequency.setValueAtTime(Math.max(48, opts.pitchStart * 0.5), st);
          subOsc.frequency.exponentialRampToValueAtTime(38, st + d);
          const subG = ctx.createGain();
          subG.gain.setValueAtTime(0.28, st);
          subG.gain.exponentialRampToValueAtTime(0.001, st + d);
          subOsc.connect(subG);
          subG.connect(voiceBus);
          subOsc.start(st);
          subOsc.stop(st + d + 0.03);
        }

        osc1.start(st);
        osc2.start(st);
        osc1.stop(st + d + 0.03);
        osc2.stop(st + d + 0.03);
      }
    };

    const keyRoot = Math.max(115, Math.min(220, harmony.rootHz * 0.65));

    switch (voiceId) {
      case 'hey-chant': {
        attachClubSpace(beatSec * 0.5, 0.32, 0.28);
        for (let i = 0; i < 3; i++) {
          const st = now + i * beatSec * 0.5;
          spawnConsonant(st, 0.045, 2200, 1.4, 0.25);
          spawnSyllable({
            start: st + 0.015,
            dur: Math.min(0.28, beatSec * 0.42),
            pitchStart: 165 + i * 10,
            pitchEnd: 138 + i * 8,
            vowelStart: 'e',
            vowelEnd: 'i',
            crowdCount: 5,
            gain: 0.42,
            aspirateAmt: 0.24,
          });
        }
        break;
      }
      case 'lets-go': {
        attachClubSpace(beatSec * 0.375, 0.42, 0.32);
        spawnConsonant(now, 0.04, 3400, 1.8, 0.24);
        spawnSyllable({
          start: now + 0.01,
          dur: 0.14,
          pitchStart: 175,
          pitchEnd: 192,
          vowelStart: 'e',
          vowelEnd: 'e',
          crowdCount: 4,
          gain: 0.38,
        });
        spawnConsonant(now + 0.145, 0.035, 1600, 2.2, 0.28);
        spawnSyllable({
          start: now + 0.16,
          dur: 0.42,
          pitchStart: 225,
          pitchMid: 245,
          pitchEnd: 172,
          vowelStart: 'o',
          vowelEnd: 'u',
          crowdCount: 5,
          gain: 0.48,
          subPunch: true,
        });
        break;
      }
      case 'hands-up': {
        attachClubSpace(beatSec * 0.5, 0.38, 0.35);
        spawnConsonant(now, 0.055, 2100, 1.2, 0.28);
        spawnSyllable({
          start: now + 0.02,
          dur: 0.22,
          pitchStart: 155,
          pitchEnd: 195,
          vowelStart: 'ae',
          vowelEnd: 'ae',
          crowdCount: 5,
          gain: 0.4,
          aspirateAmt: 0.28,
        });
        spawnConsonant(now + 0.22, 0.05, 4200, 2.5, 0.2);
        spawnSyllable({
          start: now + 0.25,
          dur: 0.38,
          pitchStart: 215,
          pitchEnd: 265,
          vowelStart: 'uh',
          vowelEnd: 'a',
          crowdCount: 6,
          gain: 0.48,
        });
        break;
      }
      case 'put-em-up': {
        attachClubSpace(beatSec * 0.25, 0.36, 0.26);
        const step = Math.min(0.18, beatSec * 0.33);
        const pts: [VowelKey, number, number][] = [
          ['u', 165, 0.11],
          ['uh', 180, 0.11],
          ['a', 235, 0.32],
        ];
        pts.forEach(([vw, f, d], idx) => {
          const st = now + idx * step;
          spawnConsonant(st, 0.03, 1800 + idx * 600, 2.0, 0.24);
          spawnSyllable({
            start: st + 0.01,
            dur: d,
            pitchStart: f,
            pitchEnd: idx === 2 ? f * 1.12 : f * 0.94,
            vowelStart: vw,
            crowdCount: 4,
            gain: idx === 2 ? 0.48 : 0.36,
          });
        });
        break;
      }
      case 'make-some-noise': {
        attachClubSpace(beatSec * 0.5, 0.44, 0.42);
        const st1 = now;
        const st2 = now + 0.19;
        const st3 = now + 0.38;
        spawnSyllable({
          start: st1,
          dur: 0.16,
          pitchStart: 170,
          pitchEnd: 185,
          vowelStart: 'e',
          vowelEnd: 'i',
          crowdCount: 4,
          gain: 0.36,
        });
        spawnConsonant(st2, 0.05, 5200, 2.2, 0.26);
        spawnSyllable({
          start: st2 + 0.02,
          dur: 0.15,
          pitchStart: 185,
          pitchEnd: 198,
          vowelStart: 'uh',
          crowdCount: 4,
          gain: 0.36,
        });
        spawnSyllable({
          start: st3,
          dur: 0.52,
          pitchStart: 225,
          pitchMid: 242,
          pitchEnd: 175,
          vowelStart: 'o',
          vowelEnd: 'i',
          crowdCount: 6,
          gain: 0.52,
          aspirateAmt: 0.28,
        });
        break;
      }
      case 'crowd-roar': {
        attachClubSpace(0.09, 0.2, 0.52);
        const dur = Math.min(1.6, beatSec * 2.5);
        const src = ctx.createBufferSource();
        src.buffer = noiseBuf;
        src.loop = true;
        const f1 = ctx.createBiquadFilter();
        f1.type = 'bandpass';
        f1.Q.value = 3.2;
        f1.frequency.setValueAtTime(520, now);
        f1.frequency.linearRampToValueAtTime(980, now + dur * 0.5);
        f1.frequency.linearRampToValueAtTime(640, now + dur);

        const f2 = ctx.createBiquadFilter();
        f2.type = 'bandpass';
        f2.Q.value = 3.6;
        f2.frequency.setValueAtTime(1400, now);
        f2.frequency.linearRampToValueAtTime(2100, now + dur * 0.45);
        f2.frequency.linearRampToValueAtTime(1350, now + dur);

        const g = ctx.createGain();
        g.gain.setValueAtTime(0.001, now);
        g.gain.linearRampToValueAtTime(0.45, now + dur * 0.25);
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
          dur: dur * 0.72,
          pitchStart: 190,
          pitchMid: 235,
          pitchEnd: 165,
          vowelStart: 'o',
          vowelEnd: 'a',
          crowdCount: 6,
          gain: 0.34,
          aspirateAmt: 0.35,
        });
        break;
      }
      case 'everybody-jump': {
        attachClubSpace(beatSec * 0.5, 0.34, 0.28);
        for (let i = 0; i < 4; i++) {
          const st = now + i * beatSec * 0.5;
          spawnConsonant(st, 0.035, 2400, 2.4, 0.28);
          spawnSyllable({
            start: st + 0.01,
            dur: Math.min(0.2, beatSec * 0.36),
            pitchStart: 195 + (i % 2) * 28,
            pitchEnd: 145,
            vowelStart: 'uh',
            vowelEnd: 'uh',
            crowdCount: 5,
            gain: 0.42,
            subPunch: true,
          });
        }
        break;
      }
      case 'pump-it': {
        attachClubSpace(beatSec * 0.25, 0.32, 0.24);
        const step = Math.min(0.19, beatSec * 0.35);
        spawnConsonant(now, 0.035, 1900, 2.0, 0.26);
        spawnSyllable({
          start: now + 0.01,
          dur: 0.14,
          pitchStart: 180,
          pitchEnd: 170,
          vowelStart: 'uh',
          crowdCount: 4,
          gain: 0.38,
        });
        spawnSyllable({
          start: now + step,
          dur: 0.12,
          pitchStart: 195,
          pitchEnd: 185,
          vowelStart: 'i',
          crowdCount: 4,
          gain: 0.35,
        });
        spawnSyllable({
          start: now + step * 2,
          dur: 0.34,
          pitchStart: 230,
          pitchEnd: 270,
          vowelStart: 'a',
          vowelEnd: 'uh',
          crowdCount: 5,
          gain: 0.48,
          subPunch: true,
        });
        break;
      }
      case 'turn-it-up': {
        attachClubSpace(beatSec * 0.375, 0.38, 0.28);
        spawnConsonant(now, 0.04, 3200, 2.0, 0.24);
        spawnSyllable({
          start: now + 0.015,
          dur: 0.16,
          pitchStart: 160,
          pitchEnd: 188,
          vowelStart: 'uh',
          crowdCount: 4,
          gain: 0.36,
        });
        spawnSyllable({
          start: now + 0.18,
          dur: 0.12,
          pitchStart: 192,
          pitchEnd: 210,
          vowelStart: 'i',
          crowdCount: 4,
          gain: 0.35,
        });
        spawnSyllable({
          start: now + 0.3,
          dur: 0.42,
          pitchStart: 220,
          pitchEnd: 295,
          vowelStart: 'uh',
          vowelEnd: 'a',
          crowdCount: 5,
          gain: 0.48,
        });
        break;
      }
      case 'oh-my-god': {
        attachClubSpace(beatSec * 0.5, 0.44, 0.38);
        spawnSyllable({
          start: now,
          dur: 0.24,
          pitchStart: 195,
          pitchEnd: 275,
          vowelStart: 'o',
          vowelEnd: 'a',
          crowdCount: 3,
          gain: 0.38,
        });
        spawnSyllable({
          start: now + 0.26,
          dur: 0.54,
          pitchStart: 265,
          pitchMid: 245,
          pitchEnd: 155,
          vowelStart: 'a',
          vowelEnd: 'o',
          crowdCount: 6,
          gain: 0.5,
          subPunch: true,
        });
        break;
      }
      case 'groove-yeah': {
        attachClubSpace(beatSec * 0.5, 0.46, 0.34);
        spawnSyllable({
          start: now,
          dur: Math.min(0.95, beatSec * 1.5),
          pitchStart: keyRoot * 0.9,
          pitchMid: keyRoot * 1.25,
          pitchEnd: keyRoot,
          vowelStart: 'u',
          vowelEnd: 'ae',
          crowdCount: 2,
          gain: 0.38,
          vibratoHz: 5.5,
          vibratoDepth: 6,
        });
        break;
      }
      case 'ah-yeah-chop': {
        attachClubSpace(beatSec * 0.375, 0.45, 0.26);
        const step = Math.min(0.22, beatSec * 0.5);
        const pattern: [VowelKey, number, number][] = [
          ['a', keyRoot, -0.35],
          ['a', keyRoot * 1.12, 0.35],
          ['ae', keyRoot * 1.25, 0],
        ];
        pattern.forEach(([vw, f, pan], i) => {
          spawnSyllable({
            start: now + i * step,
            dur: i === 2 ? step * 1.35 : step * 0.72,
            pitchStart: f,
            pitchEnd: i === 2 ? f * 0.92 : f,
            vowelStart: vw,
            vowelEnd: i === 2 ? 'a' : vw,
            gain: i === 2 ? 0.42 : 0.34,
            pan,
          });
        });
        break;
      }
      case 'funk-woo': {
        attachClubSpace(beatSec * 0.5, 0.42, 0.38);
        spawnConsonant(now, 0.04, 1500, 1.5, 0.16);
        spawnSyllable({
          start: now + 0.01,
          dur: Math.min(0.75, beatSec * 1.2),
          pitchStart: 280,
          pitchMid: 520,
          pitchEnd: 410,
          vowelStart: 'u',
          vowelEnd: 'o',
          crowdCount: 2,
          gain: 0.36,
          aspirateAmt: 0.22,
          vibratoHz: 6.2,
          vibratoDepth: 11,
        });
        break;
      }
      case 'afro-eyy': {
        attachClubSpace(beatSec * 0.375, 0.4, 0.28);
        const step = Math.min(0.26, beatSec * 0.5);
        spawnSyllable({
          start: now,
          dur: step * 0.75,
          pitchStart: keyRoot * 1.2,
          pitchEnd: keyRoot * 1.33,
          vowelStart: 'e',
          vowelEnd: 'a',
          crowdCount: 4,
          gain: 0.38,
        });
        spawnSyllable({
          start: now + step,
          dur: step * 0.95,
          pitchStart: keyRoot * 1.0,
          pitchEnd: keyRoot * 0.88,
          vowelStart: 'o',
          vowelEnd: 'u',
          crowdCount: 4,
          gain: 0.42,
        });
        break;
      }
      case 'vocoder-harmony': {
        attachClubSpace(beatSec * 0.5, 0.48, 0.42);
        const dur = Math.min(1.4, beatSec * 2.2);
        harmony.chordHz.slice(0, 3).forEach((freq, idx) => {
          spawnSyllable({
            start: now + idx * 0.015,
            dur,
            pitchStart: freq * 0.5,
            pitchMid: freq * 0.504,
            pitchEnd: freq * 0.5,
            vowelStart: idx === 1 ? 'a' : 'u',
            vowelEnd: 'o',
            gain: 0.24,
            pan: (idx - 1) * 0.45,
            aspirateAmt: 0.12,
          });
        });
        break;
      }
      case 'sunset-breathe': {
        attachClubSpace(beatSec * 0.75, 0.52, 0.55);
        spawnSyllable({
          start: now,
          dur: Math.min(1.6, beatSec * 2.5),
          pitchStart: keyRoot,
          pitchEnd: keyRoot * 0.98,
          vowelStart: 'a',
          vowelEnd: 'u',
          gain: 0.26,
          crowdCount: 2,
          aspirateAmt: 0.46,
          vibratoHz: 4.2,
          vibratoDepth: 3,
        });
        break;
      }
      case 'count-1234': {
        attachClubSpace(beatSec * 0.5, 0.34, 0.24);
        const counts: [VowelKey, VowelKey, number][] = [
          ['uh', 'a', 155],
          ['u', 'u', 172],
          ['i', 'i', 192],
          ['o', 'a', 222],
        ];
        counts.forEach(([v1, v2, p], idx) => {
          const st = now + idx * beatSec;
          spawnConsonant(st, 0.04, 2400 + idx * 500, 2.2, 0.25);
          spawnSyllable({
            start: st + 0.012,
            dur: Math.min(0.28, beatSec * 0.48),
            pitchStart: p,
            pitchEnd: idx === 3 ? p * 1.15 : p * 0.94,
            vowelStart: v1,
            vowelEnd: v2,
            crowdCount: idx === 3 ? 5 : 3,
            gain: idx === 3 ? 0.48 : 0.36,
          });
        });
        break;
      }
      case 'three-two-one': {
        attachClubSpace(beatSec * 0.5, 0.42, 0.34);
        const counts: [VowelKey, number][] = [
          ['i', 175],
          ['u', 202],
          ['uh', 238],
        ];
        counts.forEach(([vw, p], idx) => {
          const st = now + idx * beatSec * 0.75;
          spawnConsonant(st, 0.045, 2900, 2.2, 0.26);
          spawnSyllable({
            start: st + 0.01,
            dur: Math.min(0.32, beatSec * 0.52),
            pitchStart: p,
            pitchEnd: p * 1.08,
            vowelStart: vw,
            vowelEnd: idx === 2 ? 'a' : vw,
            crowdCount: idx === 2 ? 5 : 3,
            gain: 0.38 + idx * 0.05,
          });
        });
        break;
      }
      case 'bass-drop': {
        attachClubSpace(beatSec * 0.375, 0.4, 0.3);
        spawnConsonant(now, 0.035, 1600, 2.0, 0.26);
        spawnSyllable({
          start: now + 0.01,
          dur: 0.22,
          pitchStart: 135,
          pitchEnd: 118,
          vowelStart: 'e',
          vowelEnd: 'ae',
          crowdCount: 3,
          gain: 0.42,
        });
        spawnConsonant(now + 0.23, 0.045, 2200, 1.8, 0.28);
        spawnSyllable({
          start: now + 0.25,
          dur: 0.55,
          pitchStart: 155,
          pitchEnd: 88,
          vowelStart: 'a',
          vowelEnd: 'o',
          crowdCount: 4,
          gain: 0.52,
          subPunch: true,
        });
        break;
      }
      case 'pull-up': {
        attachClubSpace(beatSec * 0.375, 0.54, 0.36);
        spawnConsonant(now, 0.035, 1800, 2.2, 0.26);
        spawnSyllable({
          start: now + 0.01,
          dur: 0.16,
          pitchStart: 180,
          pitchEnd: 205,
          vowelStart: 'u',
          crowdCount: 3,
          gain: 0.4,
        });
        spawnSyllable({
          start: now + 0.17,
          dur: 0.4,
          pitchStart: 215,
          pitchEnd: 310,
          vowelStart: 'uh',
          vowelEnd: 'a',
          crowdCount: 4,
          gain: 0.46,
        });
        break;
      }
      case 'dj-scratch-aaah': {
        attachClubSpace(beatSec * 0.25, 0.32, 0.18);
        const hits = [0, 0.12, 0.24, 0.39];
        hits.forEach((off, idx) => {
          const isLong = idx === 3;
          spawnSyllable({
            start: now + off,
            dur: isLong ? 0.34 : 0.095,
            pitchStart: idx % 2 === 0 ? 150 : 230,
            pitchMid: isLong ? 245 : undefined,
            pitchEnd: isLong ? 140 : idx % 2 === 0 ? 255 : 145,
            vowelStart: 'ae',
            vowelEnd: 'a',
            gain: 0.44,
          });
        });
        break;
      }
      case 'yo-yo-yo': {
        attachClubSpace(beatSec * 0.375, 0.42, 0.22);
        const step = Math.min(0.14, beatSec * 0.33);
        [0, 1, 2].forEach((i) => {
          spawnSyllable({
            start: now + i * step,
            dur: i === 2 ? 0.28 : step * 0.78,
            pitchStart: 195 + i * 16,
            pitchEnd: i === 2 ? 148 : 175,
            vowelStart: 'i',
            vowelEnd: 'o',
            crowdCount: i === 2 ? 3 : 1,
            gain: 0.42,
          });
        });
        break;
      }
      case 'check-mic': {
        attachClubSpace(beatSec * 0.25, 0.3, 0.16);
        spawnConsonant(now, 0.045, 3600, 2.4, 0.28);
        spawnSyllable({
          start: now + 0.015,
          dur: 0.14,
          pitchStart: 155,
          pitchEnd: 142,
          vowelStart: 'e',
          gain: 0.38,
        });
        spawnSyllable({
          start: now + 0.19,
          dur: 0.13,
          pitchStart: 165,
          pitchEnd: 155,
          vowelStart: 'uh',
          gain: 0.36,
        });
        spawnConsonant(now + 0.34, 0.035, 3200, 2.2, 0.24);
        spawnSyllable({
          start: now + 0.355,
          dur: 0.24,
          pitchStart: 182,
          pitchEnd: 148,
          vowelStart: 'u',
          crowdCount: 2,
          gain: 0.42,
        });
        break;
      }
      case 'vip-remix': {
        attachClubSpace(beatSec * 0.5, 0.48, 0.32);
        const step = Math.min(0.16, beatSec * 0.35);
        const tag: [VowelKey, VowelKey, number, number][] = [
          ['i', 'i', keyRoot * 1.25, 0.12],
          ['a', 'i', keyRoot * 1.5, 0.12],
          ['e', 'i', keyRoot * 1.25, 0.14],
          ['i', 'e', keyRoot, 0.34],
        ];
        tag.forEach(([v1, v2, f, d], idx) => {
          spawnConsonant(now + idx * step, 0.03, 2800, 2.0, 0.18);
          spawnSyllable({
            start: now + idx * step + 0.008,
            dur: d,
            pitchStart: f,
            pitchEnd: idx === 3 ? f * 0.96 : f * 1.04,
            vowelStart: v1,
            vowelEnd: v2,
            crowdCount: 2,
            gain: 0.36,
          });
        });
        break;
      }
    }
  }

  // =========================================================================
  // Upgrade #6: Custom User Mic / Audio Drop Player (through Mastering & Duck)
  // =========================================================================

  public async playCustomVoiceBuffer(buffer: AudioBuffer, bpm = 124, delaySec = 0) {
    const ctx = await this.resume();
    if (!this.masterSum) return;
    const voiceOut = this.postDuckSum || this.masterSum;
    const safeBpm = Math.max(65, Math.min(185, bpm || 124));
    const beatSec = 60 / safeBpm;
    const startAt = ctx.currentTime + Math.max(0.01, delaySec);
    const dur = Math.min(6.0, buffer.duration);

    this.duckMasterForVoice(Math.min(4.2, dur + delaySec + 0.15));

    const src = ctx.createBufferSource();
    src.buffer = buffer;

    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 110;

    const presence = ctx.createBiquadFilter();
    presence.type = 'peaking';
    presence.frequency.value = 2650;
    presence.Q.value = 1.1;
    presence.gain.value = 4.2;

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.ratio.value = 4.5;
    comp.attack.value = 0.004;
    comp.release.value = 0.09;

    const dryGain = ctx.createGain();
    dryGain.gain.setValueAtTime(1.08, startAt);

    src.connect(hp);
    hp.connect(presence);
    presence.connect(comp);
    comp.connect(dryGain);
    dryGain.connect(voiceOut);

    // Subtle club slapback + tail
    const delay = ctx.createDelay(1.2);
    delay.delayTime.value = Math.min(0.8, beatSec * 0.5);
    const fb = ctx.createGain();
    fb.gain.value = 0.32;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2800;
    const wet = ctx.createGain();
    wet.gain.value = 0.24;

    comp.connect(lp);
    lp.connect(delay);
    delay.connect(fb);
    fb.connect(delay);
    delay.connect(wet);
    wet.connect(voiceOut);

    if (this.roomReverbImpulse) {
      const conv = ctx.createConvolver();
      conv.buffer = this.roomReverbImpulse;
      const vg = ctx.createGain();
      vg.gain.value = 0.18;
      comp.connect(conv);
      conv.connect(vg);
      vg.connect(voiceOut);
    }

    src.start(startAt, 0, dur);
  }

  // =========================================================================
  // Upgrade #4: Sample-Accurate Build-Up Escalator on Web Audio Clock
  // =========================================================================

  public async scheduleBuildUpSequence(params: {
    bpm: number;
    musicalKey?: string;
    pitchRate?: number;
    bars?: number;
    voiceId?: DjVoiceDropId | null;
    customVoiceBuffer?: AudioBuffer | null;
  }) {
    const ctx = await this.resume();
    if (!this.masterSum) return;

    const safeBpm = Math.max(65, Math.min(185, params.bpm || 124));
    const beatSec = 60 / safeBpm;
    const bars = Math.max(1, Math.min(2, params.bars ?? 1));
    const totalBeats = bars * 4;
    const silenceGap = Math.min(0.45, beatSec * 0.72);
    const buildDur = Math.max(0.8, totalBeats * beatSec - silenceGap);
    const startAt = ctx.currentTime + 0.02;
    const dropAt = startAt + totalBeats * beatSec;
    const harmony = camelotToHarmony(params.musicalKey, params.pitchRate ?? 1);
    const noiseBuf = this.ensureBridgeNoise(ctx);
    const masterDest = this.masterSum;

    // 1. Sample-accurate escalating snare/clap roll (1/4 -> 1/8 -> 1/16 -> 1/32)
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
      // Snare body tone
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(190 + p * 120, ht);
      osc.frequency.exponentialRampToValueAtTime(115 + p * 45, ht + 0.06);

      const og = ctx.createGain();
      og.gain.setValueAtTime(0.001, ht);
      og.gain.linearRampToValueAtTime(0.14 + p * 0.2, ht + 0.004);
      og.gain.exponentialRampToValueAtTime(0.001, ht + 0.075);
      osc.connect(og);
      og.connect(masterDest);
      osc.start(ht);
      osc.stop(ht + 0.085);

      // Crisp snare/clap noise transient
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
      ng.connect(masterDest);
      nSrc.start(ht);
      nSrc.stop(ht + 0.08);
    });

    // 2. Rising Camelot chord riser sweeping up into the silence gap
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
    riserGain.connect(masterDest);

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

    // 3. Downbeat Sub-Drop Slam right on dropAt (after the 1-beat dead-silence cut)
    const subOsc = ctx.createOscillator();
    subOsc.type = 'sine';
    subOsc.frequency.setValueAtTime(Math.max(92, harmony.rootHz * 0.5), dropAt);
    subOsc.frequency.exponentialRampToValueAtTime(34, dropAt + Math.min(1.1, beatSec * 1.8));
    const subGain = ctx.createGain();
    subGain.gain.setValueAtTime(0.001, dropAt);
    subGain.gain.linearRampToValueAtTime(0.7, dropAt + 0.014);
    subGain.gain.exponentialRampToValueAtTime(0.001, dropAt + Math.min(1.2, beatSec * 2.0));
    subOsc.connect(subGain);
    subGain.connect(masterDest);
    subOsc.start(dropAt);
    subOsc.stop(dropAt + Math.min(1.25, beatSec * 2.1));

    // Downbeat noise crash on dropAt
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
    crashGain.connect(masterDest);
    crashSrc.start(dropAt);
    crashSrc.stop(dropAt + Math.min(1.0, beatSec * 1.7));

    // 4. Optional Drop Voice / Custom Drop landed cleanly inside the pre-drop gap
    const voiceDelaySec = Math.max(0.05, startAt + buildDur - ctx.currentTime);
    if (params.customVoiceBuffer) {
      void this.playCustomVoiceBuffer(params.customVoiceBuffer, safeBpm, voiceDelaySec);
    } else if (params.voiceId) {
      const voiceTimeoutMs = Math.max(0, Math.round(voiceDelaySec * 1000));
      setTimeout(() => {
        if (params.voiceId) {
          void this.playVoiceDrop(params.voiceId, safeBpm, params.musicalKey, params.pitchRate);
        }
      }, voiceTimeoutMs);
    }
  }

  // =========================================================================
  // Advance #3: Live In-Key Groove & Drum Bridge Sequencer (AudioContext Clock)
  // =========================================================================

  private ensureBridgeNoise(ctx: AudioContext): AudioBuffer {
    if (this.bridgeNoiseBuffer && this.bridgeNoiseBuffer.sampleRate === ctx.sampleRate) {
      return this.bridgeNoiseBuffer;
    }
    const len = Math.floor(ctx.sampleRate * 0.25);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this.bridgeNoiseBuffer = buf;
    return buf;
  }

  private scheduleBridgeStep(stepIdx: number, time: number) {
    if (!this.ctx || !this.masterSum || this.bridgePattern === 'off') return;
    const ctx = this.ctx;
    const step16 = stepIdx % 16;
    const harmony = camelotToHarmony(this.bridgeKey, this.bridgePitchRate);
    const subRoot = Math.max(41, Math.min(82, harmony.rootHz * 0.25));
    const pat = this.bridgePattern;
    const noiseBuf = this.ensureBridgeNoise(ctx);

    const playKick = (gainAmt: number, startFreq = 135, endFreq = 44) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(startFreq, time);
      osc.frequency.exponentialRampToValueAtTime(endFreq, time + 0.09);
      const g = ctx.createGain();
      g.gain.setValueAtTime(gainAmt, time);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.16);
      osc.connect(g);
      g.connect(this.masterSum!);
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
      g.connect(this.masterSum!);
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
      g.connect(this.masterSum!);
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
      g.connect(this.masterSum!);
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
      // Sidechain pump breathing on quarter-note beats
      env.gain.linearRampToValueAtTime(gainAmt, time + 0.08);
      env.gain.exponentialRampToValueAtTime(0.001, time + dur);

      lp.connect(env);
      env.connect(this.masterSum!);

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
      env.connect(this.masterSum!);
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
      g.connect(this.masterSum!);
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
      g.connect(this.masterSum!);
      src.start(time);
      src.stop(time + 0.1);
    };

    // 4-bar chord root progression matching Camelot mode: i–VI–III–VII (minor) or I–V–vi–IV (major)
    const progression = harmony.isMinor ? [0, -4, -9, -2] : [0, -5, -3, -7];
    const barSemitone = progression[this.bridgeBar % progression.length];
    const barMult = Math.pow(2, barSemitone / 12);
    const beatSec = 60 / Math.max(65, this.bridgeBpm);
    const isTurnaroundBar = this.bridgeBar === 3;

    // Upgrade #6: Auto Bar-4 Turnaround Drum Fill on final beat (steps 12..15)
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
      // 16-step offbeat In-Key Acid/Sub Groove bassline
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
      // Metric Modulation Bridge feel: 3-against-2 dotted polyrhythm accents in bars 0-1 -> straight drive
      const isPolyrhythmStep = this.bridgeBar < 2 && (step16 === 0 || step16 === 3 || step16 === 6 || step16 === 9 || step16 === 12);
      if (step16 === 0 || step16 === 8) playKick(0.22, 120, 48);
      if (isPolyrhythmStep || (this.bridgeBar >= 2 && (step16 === 3 || step16 === 6 || step16 === 10 || step16 === 12))) {
        const pitchMult = step16 === 6 || step16 === 12 ? 1.25 : 1;
        playSub808(harmony.rootHz * 0.5 * pitchMult * barMult, 0.16, 0.14);
      }
      if (step16 === 4 || step16 === 14) playClap(0.11);
      playHat(step16 % 2 === 0 ? 0.07 : 0.035, 0.03, 5200);
    } else if (pat === 'chord-arp') {
      // Advance #7 + Upgrade #6: In-Key 4-bar Chord Progression + Acid Bass + Rolling 16th Arp
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
        const noteFreq = arpNotes[(step16 + this.bridgeBar) % arpNotes.length] * barMult;
        playArpNote(noteFreq, step16 % 4 === 2 ? 0.12 : 0.075, beatSec * 0.35);
      }
      if (step16 % 4 === 2) playHat(0.07, 0.05, 6800);
    }
  }

  public async startGrooveBridge(
    pattern: GrooveBridgePattern,
    bpm = 124,
    musicalKey = '8A',
    pitchRate = 1
  ) {
    if (pattern === 'off') {
      this.stopGrooveBridge();
      return;
    }
    const ctx = await this.resume();
    this.bridgePattern = pattern;
    this.bridgeBpm = Math.max(65, Math.min(185, bpm));
    this.bridgeKey = musicalKey || '8A';
    this.bridgePitchRate = Math.max(0.5, Math.min(2.0, pitchRate || 1));

    if (this.bridgeTimerId) return;
    this.bridgeStep = 0;
    this.bridgeBar = 0;
    this.bridgeNextStepTime = ctx.currentTime + 0.03;

    this.bridgeTimerId = setInterval(() => {
      if (!this.ctx || this.bridgePattern === 'off') return;
      const stepSec = 60 / Math.max(65, this.bridgeBpm) / 4; // 16th note
      while (this.bridgeNextStepTime < this.ctx.currentTime + 0.12) {
        this.scheduleBridgeStep(this.bridgeStep, this.bridgeNextStepTime);
        this.bridgeNextStepTime += stepSec;
        this.bridgeStep = (this.bridgeStep + 1) % 16;
        if (this.bridgeStep === 0) {
          this.bridgeBar = (this.bridgeBar + 1) % 4;
        }
      }
    }, 25);
  }

  public updateGrooveBridge(bpm: number, musicalKey?: string, pitchRate?: number) {
    this.bridgeBpm = Math.max(65, Math.min(185, bpm));
    if (musicalKey) this.bridgeKey = musicalKey;
    if (typeof pitchRate === 'number' && Number.isFinite(pitchRate) && pitchRate > 0) {
      this.bridgePitchRate = Math.max(0.5, Math.min(2.0, pitchRate));
    }
  }

  public stopGrooveBridge() {
    this.bridgePattern = 'off';
    if (this.bridgeTimerId) {
      clearInterval(this.bridgeTimerId);
      this.bridgeTimerId = null;
    }
  }

  public getGrooveBridgePattern(): GrooveBridgePattern {
    return this.bridgePattern;
  }
}

export const djEngine = new DjAudioEngine();
