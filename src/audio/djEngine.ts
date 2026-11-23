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
import { ensurePitchWorkletLoaded } from './timeStretchWorklet';
import { encodeStereoChunksToWav } from './waveformAnalyzer';
import {
  createSynthNoiseBuffer,
  scheduleBuildUpSequenceSynth,
  scheduleCustomVoiceBufferSynth,
  scheduleGrooveBridgeStepSynth,
  scheduleSoundTrickSynth,
  scheduleVoiceDropSynth,
} from './webAudioSynths';

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
  private vocalSidechainFilter: BiquadFilterNode;
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

    this.vocalSidechainFilter = ctx.createBiquadFilter();
    this.vocalSidechainFilter.type = 'peaking';
    this.vocalSidechainFilter.frequency.value = 1750;
    this.vocalSidechainFilter.Q.value = 0.85;
    this.vocalSidechainFilter.gain.value = 0;

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
    this.eqHigh.connect(this.vocalSidechainFilter);
    this.vocalSidechainFilter.connect(this.sweepFilter);

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

  setVocalPresenceDuck(dbDuck: number) {
    const safeDb = Math.max(-6, Math.min(0, dbDuck));
    this.vocalSidechainFilter.gain.setTargetAtTime(safeDb, this.ctx.currentTime, 0.04);
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

  getMidBandEnergy(): number {
    if (!this.isPlaying) return 0;
    this.analyser.getByteFrequencyData(this.analyserFreqData);
    // Bins 2..20 cover ~344 Hz..3.44 kHz (vocal presence band) at 44.1kHz / 256 FFT
    let sum = 0;
    const startBin = 2;
    const endBin = Math.min(20, this.analyserFreqData.length - 1);
    const count = Math.max(1, endBin - startBin + 1);
    for (let i = startBin; i <= endBin; i++) {
      sum += this.analyserFreqData[i];
    }
    return Math.min(1, sum / (count * 255));
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
  private voiceDuckGain: GainNode | null = null;
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
  private voiceMixVolume = 1.0;

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
    // Upgrade #1: Master Bus Gain + Mid-Pocket Voice Ducker + 3-Band Club Mastering Chain
    this.voiceDuckGain = ctx.createGain();
    this.voiceDuckGain.gain.value = 1;

    this.voiceDuckFilter = ctx.createBiquadFilter();
    this.voiceDuckFilter.type = 'peaking';
    this.voiceDuckFilter.frequency.value = 1450;
    this.voiceDuckFilter.Q.value = 0.6;
    this.voiceDuckFilter.gain.value = 0;

    this.postDuckSum = ctx.createGain();
    this.postDuckSum.gain.value = 1;

    this.masterSum.connect(this.voiceDuckGain);
    this.voiceDuckGain.connect(this.voiceDuckFilter);
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
    const holdUntil = Math.max(this.voiceDuckUntilCtxTime, now + Math.max(0.28, Math.min(4.5, durationSec)));
    this.voiceDuckUntilCtxTime = holdUntil;
    const p = this.voiceDuckFilter.gain;
    try {
      p.cancelScheduledValues(now);
      p.setValueAtTime(p.value, now);
      p.linearRampToValueAtTime(-4.8, now + 0.025);
      p.setValueAtTime(-4.8, Math.max(now + 0.05, holdUntil - 0.16));
      p.linearRampToValueAtTime(0, holdUntil);
    } catch {
      // ignore automation overlap
    }
    if (this.voiceDuckGain) {
      const g = this.voiceDuckGain.gain;
      try {
        g.cancelScheduledValues(now);
        g.setValueAtTime(g.value, now);
        g.linearRampToValueAtTime(0.5, now + 0.025);
        g.setValueAtTime(0.5, Math.max(now + 0.05, holdUntil - 0.16));
        g.linearRampToValueAtTime(1, holdUntil);
      } catch {
        // ignore automation overlap
      }
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

  public getDeckMidBandLevel(deckId: DeckId): number {
    return this.decks ? this.decks[deckId].getMidBandEnergy() : 0;
  }

  public setDeckSidechainDuck(deckId: DeckId, mult: number) {
    if (!this.decks) return;
    this.decks[deckId].setSidechainDuck(mult);
  }

  public setDeckVocalPresenceDuck(deckId: DeckId, dbDuck: number) {
    if (!this.decks) return;
    this.decks[deckId].setVocalPresenceDuck(dbDuck);
  }

  public setVoiceVolume(volume: number) {
    this.voiceMixVolume = Math.max(0, Math.min(1.5, volume));
  }

  public getVoiceVolume(): number {
    return this.voiceMixVolume;
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
    scheduleSoundTrickSynth({
      ctx,
      dest: this.masterSum,
      type,
      atTime: ctx.currentTime,
      bpm,
      musicalKey,
      pitchRate,
    });
  }

  // =========================================================================
  // Offline Multi-Formant DJ Voice, Grooving, Shout & Hype Synth Engine
  // =========================================================================

  public async playVoiceDrop(
    voiceId: DjVoiceDropId,
    bpm = 124,
    musicalKey?: string,
    pitchRate = 1,
    delaySec = 0
  ) {
    const ctx = await this.resume();
    if (!this.masterSum) return;
    const now = ctx.currentTime + Math.max(0.01, delaySec);
    const safeBpm = Math.max(65, Math.min(185, bpm || 124));
    const beatSec = 60 / safeBpm;
    const noiseBuf = this.ensureBridgeNoise(ctx);
    const voiceOut = this.postDuckSum || this.masterSum;
    scheduleVoiceDropSynth({
      ctx,
      dest: voiceOut,
      noiseBuf,
      reverbImpulse: this.roomReverbImpulse,
      voiceId,
      atTime: now,
      bpm: safeBpm,
      musicalKey,
      pitchRate,
      volumeScale: this.voiceMixVolume,
      onDuckWindow: (d) =>
        this.duckMasterForVoice(Math.max(0.85, Math.min(2.6, Math.max(d, beatSec * 2.5) + delaySec))),
    });
  }

  // =========================================================================
  // Upgrade #6: Custom User Mic / Audio Drop Player (through Mastering & Duck)
  // =========================================================================

  public async playCustomVoiceBuffer(buffer: AudioBuffer, bpm = 124, delaySec = 0) {
    const ctx = await this.resume();
    if (!this.masterSum) return;
    const voiceOut = this.postDuckSum || this.masterSum;
    const startAt = ctx.currentTime + Math.max(0.01, delaySec);
    scheduleCustomVoiceBufferSynth({
      ctx,
      dest: voiceOut,
      reverbImpulse: this.roomReverbImpulse,
      buffer,
      atTime: startAt,
      bpm,
      volumeScale: this.voiceMixVolume,
      onDuckWindow: (d) => this.duckMasterForVoice(Math.min(4.4, d + delaySec)),
    });
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
    const startAt = ctx.currentTime + 0.02;
    const noiseBuf = this.ensureBridgeNoise(ctx);
    scheduleBuildUpSequenceSynth({
      ctx,
      dest: this.masterSum,
      voiceDest: this.postDuckSum || this.masterSum,
      noiseBuf,
      reverbImpulse: this.roomReverbImpulse,
      startAt,
      bpm: params.bpm,
      musicalKey: params.musicalKey,
      pitchRate: params.pitchRate,
      bars: params.bars,
      voiceId: params.voiceId,
      customVoiceBuffer: params.customVoiceBuffer,
      voiceVolumeScale: this.voiceMixVolume,
      onVoiceDuckWindow: (d) => this.duckMasterForVoice(d),
    });
  }

  // =========================================================================
  // Advance #3: Live In-Key Groove & Drum Bridge Sequencer (AudioContext Clock)
  // =========================================================================

  private ensureBridgeNoise(ctx: AudioContext): AudioBuffer {
    if (this.bridgeNoiseBuffer && this.bridgeNoiseBuffer.sampleRate === ctx.sampleRate) {
      return this.bridgeNoiseBuffer;
    }
    const buf = createSynthNoiseBuffer(ctx, 0.35);
    this.bridgeNoiseBuffer = buf;
    return buf;
  }

  private scheduleBridgeStep(stepIdx: number, time: number) {
    if (!this.ctx || !this.masterSum || this.bridgePattern === 'off') return;
    const noiseBuf = this.ensureBridgeNoise(this.ctx);
    scheduleGrooveBridgeStepSynth({
      ctx: this.ctx,
      dest: this.masterSum,
      noiseBuf,
      stepIdx,
      barIdx: this.bridgeBar,
      atTime: time,
      pattern: this.bridgePattern,
      bpm: this.bridgeBpm,
      musicalKey: this.bridgeKey,
      pitchRate: this.bridgePitchRate,
    });
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
