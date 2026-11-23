import {
  CrossfaderCurve,
  DeckFxState,
  DeckId,
  FxType,
  GrooveBridgePattern,
  SoundTrickType,
  StemIsolationMode,
} from '../types/dj';
import { camelotToHarmony } from './aiMemory';
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
  private source: AudioBufferSourceNode | null = null;

  public isPlaying = false;
  private anchorCtxTime = 0;
  private anchorOffsetSec = 0;
  public playbackRate = 1;
  private playToken = 0;

  public loopActive = false;
  public loopStartSec = 0;
  public loopEndSec = 0;

  // DSP nodes
  public trimGain: GainNode;
  private stemBypassGain: GainNode;
  private stemVocalGain: GainNode;
  private stemInstGain: GainNode;
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

  private currentFx: FxType = 'echo';
  private fxEnabled = false;
  private fxWet = 0.35;

  constructor(ctx: AudioContext, destination: AudioNode, reverbImpulse: AudioBuffer) {
    this.ctx = ctx;

    this.trimGain = ctx.createGain();
    this.trimGain.gain.value = 1;

    // Real-Time Mid/Side Stem Isolator Matrix (Advance #1: Vocal Focus vs Instrumental)
    this.stemBypassGain = ctx.createGain();
    this.stemBypassGain.gain.value = 1;
    this.stemVocalGain = ctx.createGain();
    this.stemVocalGain.gain.value = 0;
    this.stemInstGain = ctx.createGain();
    this.stemInstGain.gain.value = 0;

    const splitter = ctx.createChannelSplitter(2);
    this.trimGain.connect(splitter);

    // Mid Stem (Vocal Focus: L + R summed -> 260Hz..3.8kHz presence bandpass)
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
    vocalPeak.connect(this.stemVocalGain);

    // Side-Weighted Stem (Instrumental: (L - R) stereo bed + <175Hz mono bass punch + >5.2kHz hat air)
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

    splitter.connect(sideGainL, 0);
    splitter.connect(sideGainInvR, 1);
    sideGainL.connect(sideHp);
    sideGainInvR.connect(sideHp);
    sideHp.connect(this.stemInstGain);

    splitter.connect(subSumL, 0);
    splitter.connect(subSumR, 1);
    subSumL.connect(subLp);
    subSumR.connect(subLp);
    subLp.connect(this.stemInstGain);

    splitter.connect(airSumL, 0);
    splitter.connect(airSumR, 1);
    airSumL.connect(airHp);
    airSumR.connect(airHp);
    airHp.connect(this.stemInstGain);

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

    // Wire DSP graph
    this.trimGain.connect(this.stemBypassGain);
    this.stemBypassGain.connect(this.eqLow);
    this.stemVocalGain.connect(this.eqLow);
    this.stemInstGain.connect(this.eqLow);
    this.eqLow.connect(this.eqMid);
    this.eqMid.connect(this.eqHigh);
    this.eqHigh.connect(this.sweepFilter);

    this.sweepFilter.connect(this.dryGain);
    this.sweepFilter.connect(this.fxInput);

    this.dryGain.connect(this.channelGain);
    this.wetGain.connect(this.channelGain);

    this.channelGain.connect(this.analyser);
    this.channelGain.connect(destination);
  }

  setBuffer(buffer: AudioBuffer | null) {
    this.playToken++;
    this.stopSource();
    this.buffer = buffer;
    this.isPlaying = false;
    this.anchorOffsetSec = 0;
    this.loopActive = false;
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
        }
      }
    };

    this.source = src;
    this.anchorCtxTime = this.ctx.currentTime;
    this.isPlaying = true;
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
    const safeRate = Math.max(0.25, Math.min(2.5, rate));
    if (this.isPlaying) {
      this.anchorOffsetSec = this.getCurrentTime();
      this.anchorCtxTime = this.ctx.currentTime;
      if (this.source) {
        this.source.playbackRate.setTargetAtTime(safeRate, this.ctx.currentTime, 0.012);
      }
    }
    this.playbackRate = safeRate;
  }

  setScratchRate(rate: number) {
    if (!this.source || !this.isPlaying) return;
    const safeRate = Math.max(0.1, Math.min(3.0, rate));
    this.anchorOffsetSec = this.getCurrentTime();
    this.anchorCtxTime = this.ctx.currentTime;
    this.source.playbackRate.setTargetAtTime(safeRate, this.ctx.currentTime, 0.008);
    this.playbackRate = safeRate;
  }

  setLoop(active: boolean, startSec: number, endSec: number) {
    this.loopActive = active;
    this.loopStartSec = startSec;
    this.loopEndSec = endSec;
    if (this.source) {
      this.source.loop = active && endSec > startSec + 0.02;
      this.source.loopStart = startSec;
      this.source.loopEnd = endSec;
    }
  }

  setStemMode(mode: StemIsolationMode) {
    this.stemMode = mode;
    const t = this.ctx.currentTime;
    this.stemBypassGain.gain.setTargetAtTime(mode === 'off' ? 1 : 0, t, 0.018);
    this.stemVocalGain.gain.setTargetAtTime(mode === 'vocal-focus' ? 1.15 : 0, t, 0.018);
    this.stemInstGain.gain.setTargetAtTime(mode === 'instrumental' ? 1.05 : 0, t, 0.018);
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
    this.channelGain.gain.setTargetAtTime(Math.max(0, Math.min(1.5, gain)), this.ctx.currentTime, 0.012);
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
  }
}

export class DjAudioEngine {
  private ctx: AudioContext | null = null;
  private decks: Record<DeckId, DeckChannel> | null = null;
  private masterSum: GainNode | null = null;
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
  private bridgeTimerId: ReturnType<typeof setInterval> | null = null;
  private bridgeStep = 0;
  private bridgeBar = 0;
  private bridgeNextStepTime = 0;
  private bridgeNoiseBuffer: AudioBuffer | null = null;

  private ensureInit() {
    if (this.ctx && this.decks) return;
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    const ctx = new AudioCtx({ latencyHint: 'interactive' });
    this.ctx = ctx;

    const reverbImpulse = createStereoReverbImpulse(ctx, 2.4, 2.7);

    this.masterSum = ctx.createGain();
    this.masterLimiter = ctx.createDynamicsCompressor();
    this.masterLimiter.threshold.value = -3.0;
    this.masterLimiter.knee.value = 4.0;
    this.masterLimiter.ratio.value = 12.0;
    this.masterLimiter.attack.value = 0.002;
    this.masterLimiter.release.value = 0.1;

    this.masterGainNode = ctx.createGain();
    this.masterGainNode.gain.value = 0.9;

    this.masterAnalyser = ctx.createAnalyser();
    this.masterAnalyser.fftSize = 256;
    this.masterData = new Float32Array(new ArrayBuffer(this.masterAnalyser.fftSize * 4));

    this.recordBus = ctx.createGain();
    this.recordBus.gain.value = 1.0;

    this.masterSum.connect(this.masterLimiter);
    this.masterLimiter.connect(this.masterGainNode);
    this.masterGainNode.connect(this.masterAnalyser);
    this.masterGainNode.connect(ctx.destination);
    this.masterGainNode.connect(this.recordBus);

    this.decks = {
      A: new DeckChannel(ctx, this.masterSum, reverbImpulse),
      B: new DeckChannel(ctx, this.masterSum, reverbImpulse),
    };
  }

  public async resume(): Promise<AudioContext> {
    this.ensureInit();
    if (this.ctx!.state === 'suspended') {
      await this.ctx!.resume();
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
  public async playSoundTrick(type: SoundTrickType, bpm = 124, musicalKey?: string) {
    const ctx = await this.resume();
    if (!this.masterSum) return;
    const now = ctx.currentTime;
    const beatSec = 60 / Math.max(60, bpm);
    const harmony = camelotToHarmony(musicalKey);

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
    const harmony = camelotToHarmony(this.bridgeKey);
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

    // 4-bar chord root progression matching Camelot mode: i–VI–III–VII (minor) or I–V–vi–IV (major)
    const progression = harmony.isMinor ? [0, -4, -9, -2] : [0, -5, -3, -7];
    const barSemitone = progression[this.bridgeBar % progression.length];
    const barMult = Math.pow(2, barSemitone / 12);

    if (pat === 'top-hats') {
      if (step16 % 2 === 0) playHat(step16 % 4 === 2 ? 0.16 : 0.09, step16 % 4 === 2 ? 0.09 : 0.04, 6200);
      if (step16 === 4 || step16 === 12) playClap(0.15);
      if (step16 === 14) playHat(0.08, 0.04, 7200);
    } else if (pat === 'house-4x4') {
      if (step16 % 4 === 0) playKick(0.28);
      if (step16 % 4 === 2) playHat(0.13, 0.08, 5600);
      else playHat(0.045, 0.03, 7400);
      if (step16 === 4 || step16 === 12) playClap(0.16);
      if (step16 === 3 || step16 === 11) {
        playSub808(harmony.rootHz * 0.5 * barMult, 0.08, 0.11);
      }
      if (this.bridgeBar === 3 && (step16 === 12 || step16 === 14)) {
        playArpNote(harmony.chordHz[step16 === 12 ? 1 : 2] * barMult, 0.08, 0.14);
      }
    } else if (pat === 'sub-808') {
      if (step16 === 0 || step16 === 6 || step16 === 10) {
        const fifth = step16 === 10 ? subRoot * 1.498 : subRoot;
        playSub808(fifth * barMult, 0.28, 0.34);
      }
      if (step16 === 0 || step16 === 10) playKick(0.22, 110, 42);
      if (step16 === 8) playClap(0.16);
      if (step16 % 2 === 0 || step16 === 13 || step16 === 15) playHat(0.075, 0.035, 6800);
    } else if (pat === 'afro-perc') {
      if (step16 === 0 || step16 === 8) playKick(0.22, 120, 48);
      if (step16 === 0 || step16 === 3 || step16 === 6 || step16 === 10 || step16 === 12) {
        const pitchMult = step16 === 6 || step16 === 12 ? 1.25 : 1;
        playSub808(harmony.rootHz * 0.5 * pitchMult * barMult, 0.16, 0.14);
      }
      if (step16 === 4 || step16 === 14) playClap(0.11);
      playHat(step16 % 2 === 0 ? 0.07 : 0.035, 0.03, 5200);
    } else if (pat === 'chord-arp') {
      // Advance #7: In-Key 4-bar Chord Progression + Sidechained Pulse + Rolling 16th Arp
      const beatSec = 60 / Math.max(65, this.bridgeBpm);
      if (step16 === 0 || step16 === 8) {
        playChordPad(barSemitone, 0.11, beatSec * 1.75);
        playSub808(subRoot * barMult, 0.18, beatSec * 0.65);
      }
      const arpNotes = [
        harmony.chordHz[0],
        harmony.chordHz[1],
        harmony.chordHz[2],
        harmony.chordHz[0] * 2,
      ];
      if (step16 % 2 === 0 || (this.bridgeBar === 3 && step16 >= 8)) {
        const noteFreq = arpNotes[(step16 + this.bridgeBar) % arpNotes.length] * barMult;
        playArpNote(noteFreq, step16 % 4 === 2 ? 0.12 : 0.075, beatSec * 0.35);
      }
      if (step16 % 4 === 2) playHat(0.07, 0.05, 6800);
    }
  }

  public async startGrooveBridge(
    pattern: GrooveBridgePattern,
    bpm = 124,
    musicalKey = '8A'
  ) {
    if (pattern === 'off') {
      this.stopGrooveBridge();
      return;
    }
    const ctx = await this.resume();
    this.bridgePattern = pattern;
    this.bridgeBpm = Math.max(65, Math.min(185, bpm));
    this.bridgeKey = musicalKey || '8A';

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

  public updateGrooveBridge(bpm: number, musicalKey?: string) {
    this.bridgeBpm = Math.max(65, Math.min(185, bpm));
    if (musicalKey) this.bridgeKey = musicalKey;
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
