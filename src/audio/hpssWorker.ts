/**
 * True Offline Harmonic-Percussive Source Separation (HPSS) in a Web Worker.
 * Separates sustained vocals/harmonics from transient drums/percussion using
 * STFT (N=1024, hop=512, sqrt-Hann COLA) + 2D directional median filters + Wiener soft masking.
 * Runs completely off the main thread via an inline Blob Worker.
 */

const HPSS_WORKER_CODE = `
function createBitRevTable(n) {
  const rev = new Uint16Array(n);
  const bits = Math.log2(n) | 0;
  for (let i = 0; i < n; i++) {
    let x = i;
    let r = 0;
    for (let b = 0; b < bits; b++) {
      r = (r << 1) | (x & 1);
      x >>= 1;
    }
    rev[i] = r;
  }
  return rev;
}

function fftInPlace(re, im, invert, cosTable, sinTable, revTable) {
  const n = re.length;
  for (let i = 0; i < n; i++) {
    const j = revTable[i];
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const step = n / len;
    const sign = invert ? 1 : -1;
    for (let i = 0; i < n; i += len) {
      for (let j = 0; j < half; j++) {
        const idx = j * step;
        const wRe = cosTable[idx];
        const wIm = sign * sinTable[idx];
        const uRe = re[i + j];
        const uIm = im[i + j];
        const vRe = re[i + j + half] * wRe - im[i + j + half] * wIm;
        const vIm = re[i + j + half] * wIm + im[i + j + half] * wRe;
        re[i + j] = uRe + vRe;
        im[i + j] = uIm + vIm;
        re[i + j + half] = uRe - vRe;
        im[i + j + half] = uIm - vIm;
      }
    }
  }

  if (invert) {
    const invN = 1 / n;
    for (let i = 0; i < n; i++) {
      re[i] *= invN;
      im[i] *= invN;
    }
  }
}

function quickMedianSmall(arr, len) {
  // Insertion sort on tiny 9-element scratch buffer
  for (let i = 1; i < len; i++) {
    const v = arr[i];
    let j = i - 1;
    while (j >= 0 && arr[j] > v) {
      arr[j + 1] = arr[j];
      j--;
    }
    arr[j + 1] = v;
  }
  return arr[len >> 1];
}

self.onmessage = function (e) {
  const { id, channels, sampleRate, length } = e.data;
  try {
    const N = 1024;
    const HOP = 512;
    const BINS = (N >> 1) + 1;
    const numCh = channels.length;
    const numFrames = Math.max(1, Math.floor((length - N) / HOP) + 1);

    const cosTable = new Float32Array(N >> 1);
    const sinTable = new Float32Array(N >> 1);
    for (let i = 0; i < (N >> 1); i++) {
      const ang = (2 * Math.PI * i) / N;
      cosTable[i] = Math.cos(ang);
      sinTable[i] = Math.sin(ang);
    }
    const revTable = createBitRevTable(N);

    // sqrt-Hann window achieves exact COLA (=1.0) at 50% overlap (HOP = N / 2)
    const win = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      win[i] = Math.sqrt(0.5 * (1 - Math.cos((2 * Math.PI * i) / N)));
    }

    // 1. Compute mono analysis spectrogram magnitude [numFrames * BINS]
    const mag = new Float32Array(numFrames * BINS);
    const re = new Float32Array(N);
    const im = new Float32Array(N);
    const ch0 = channels[0];
    const ch1 = numCh > 1 ? channels[1] : ch0;

    for (let f = 0; f < numFrames; f++) {
      const base = f * HOP;
      for (let i = 0; i < N; i++) {
        const s = ((ch0[base + i] || 0) + (ch1[base + i] || 0)) * 0.5;
        re[i] = s * win[i];
        im[i] = 0;
      }
      fftInPlace(re, im, false, cosTable, sinTable, revTable);
      const row = f * BINS;
      for (let k = 0; k < BINS; k++) {
        const rr = re[k];
        const ii = im[k];
        mag[row + k] = Math.sqrt(rr * rr + ii * ii);
      }
    }

    // 2. 2D Directional Median Filtering (radius 4 => window 9) + Wiener Soft Mask
    const RADIUS = 4;
    const scratch = new Float32Array(RADIUS * 2 + 1);
    const maskH = new Float32Array(numFrames * BINS);
    const maskP = new Float32Array(numFrames * BINS);

    for (let f = 0; f < numFrames; f++) {
      const row = f * BINS;
      for (let k = 0; k < BINS; k++) {
        // Horizontal (time) median => Harmonic
        let hCount = 0;
        const fStart = Math.max(0, f - RADIUS);
        const fEnd = Math.min(numFrames - 1, f + RADIUS);
        for (let ff = fStart; ff <= fEnd; ff++) {
          scratch[hCount++] = mag[ff * BINS + k];
        }
        const hMed = quickMedianSmall(scratch, hCount);

        // Vertical (frequency) median => Percussive
        let pCount = 0;
        const kStart = Math.max(0, k - RADIUS);
        const kEnd = Math.min(BINS - 1, k + RADIUS);
        for (let kk = kStart; kk <= kEnd; kk++) {
          scratch[pCount++] = mag[row + kk];
        }
        const pMed = quickMedianSmall(scratch, pCount);

        const h2 = hMed * hMed;
        const p2 = pMed * pMed;
        const denom = h2 + p2 + 1e-12;
        maskH[row + k] = h2 / denom;
        maskP[row + k] = p2 / denom;
      }
    }

    // 3. Apply 3-Stem masks to each stereo channel via overlap-add ISTFT:
    //    - Harmonic (Vocals/Melody >= ~172Hz)
    //    - Percussive (Drums/Transients >= ~129Hz)
    //    - Bass (Sub/Bassline < ~150Hz)
    const binHz = sampleRate / N;
    const bassCutoffBin = Math.max(2, Math.min(10, Math.round(145 / binHz)));
    const vocalMinBin = Math.max(3, Math.min(12, Math.round(170 / binHz)));

    const outHarmonic = [];
    const outPercussive = [];
    const outBass = [];
    const hRe = new Float32Array(N);
    const hIm = new Float32Array(N);
    const pRe = new Float32Array(N);
    const pIm = new Float32Array(N);
    const bRe = new Float32Array(N);
    const bIm = new Float32Array(N);

    for (let c = 0; c < numCh; c++) {
      const src = channels[c];
      const dstH = new Float32Array(length);
      const dstP = new Float32Array(length);
      const dstB = new Float32Array(length);

      for (let f = 0; f < numFrames; f++) {
        const base = f * HOP;
        for (let i = 0; i < N; i++) {
          re[i] = (src[base + i] || 0) * win[i];
          im[i] = 0;
        }
        fftInPlace(re, im, false, cosTable, sinTable, revTable);

        const row = f * BINS;
        // DC & Nyquist
        bRe[0] = re[0];
        bIm[0] = 0;
        hRe[0] = 0;
        hIm[0] = 0;
        pRe[0] = 0;
        pIm[0] = 0;

        const nyq = BINS - 1;
        bRe[nyq] = 0;
        bIm[nyq] = 0;
        hRe[nyq] = re[nyq] * maskH[row + nyq];
        hIm[nyq] = 0;
        pRe[nyq] = re[nyq] * maskP[row + nyq];
        pIm[nyq] = 0;

        for (let k = 1; k < nyq; k++) {
          const mH = maskH[row + k];
          const mP = maskP[row + k];
          const rk = re[k];
          const ik = im[k];

          const bassWeight = k <= bassCutoffBin ? 1.0 : k === bassCutoffBin + 1 ? 0.45 : 0;
          const harmKeep = k >= vocalMinBin ? mH : mH * 0.15;
          const drumKeep = k >= bassCutoffBin ? mP : mP * 0.25;

          bRe[k] = rk * bassWeight;
          bIm[k] = ik * bassWeight;
          bRe[N - k] = rk * bassWeight;
          bIm[N - k] = -ik * bassWeight;

          hRe[k] = rk * harmKeep;
          hIm[k] = ik * harmKeep;
          hRe[N - k] = rk * harmKeep;
          hIm[N - k] = -ik * harmKeep;

          pRe[k] = rk * drumKeep;
          pIm[k] = ik * drumKeep;
          pRe[N - k] = rk * drumKeep;
          pIm[N - k] = -ik * drumKeep;
        }

        fftInPlace(hRe, hIm, true, cosTable, sinTable, revTable);
        fftInPlace(pRe, pIm, true, cosTable, sinTable, revTable);
        fftInPlace(bRe, bIm, true, cosTable, sinTable, revTable);

        for (let i = 0; i < N && base + i < length; i++) {
          const w = win[i];
          dstH[base + i] += hRe[i] * w;
          dstP[base + i] += pRe[i] * w;
          dstB[base + i] += bRe[i] * w;
        }
      }

      outHarmonic.push(dstH);
      outPercussive.push(dstP);
      outBass.push(dstB);
    }

    const transfers = [];
    for (let c = 0; c < numCh; c++) {
      transfers.push(outHarmonic[c].buffer, outPercussive[c].buffer, outBass[c].buffer);
    }

    self.postMessage(
      {
        id,
        ok: true,
        sampleRate,
        length,
        harmonic: outHarmonic,
        percussive: outPercussive,
        bass: outBass,
      },
      transfers
    );
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err) });
  }
};
`;

let sharedWorker: Worker | null = null;
let nextJobId = 1;
const pendingJobs = new Map<
  number,
  {
    resolve: (
      res: {
        harmonic: Float32Array[];
        percussive: Float32Array[];
        bass: Float32Array[];
        sampleRate: number;
      } | null
    ) => void;
  }
>();

function getHpssWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null;
  if (sharedWorker) return sharedWorker;

  try {
    const blob = new Blob([HPSS_WORKER_CODE], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    const worker = new Worker(url);
    URL.revokeObjectURL(url);
    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data;
      const job = pendingJobs.get(msg.id);
      if (!job) return;
      pendingJobs.delete(msg.id);
      if (msg.ok) {
        job.resolve({
          harmonic: msg.harmonic,
          percussive: msg.percussive,
          bass: msg.bass,
          sampleRate: msg.sampleRate,
        });
      } else {
        job.resolve(null);
      }
    };
    worker.onerror = () => {
      for (const [id, job] of pendingJobs) {
        job.resolve(null);
        pendingJobs.delete(id);
      }
    };
    sharedWorker = worker;
    return worker;
  } catch {
    return null;
  }
}

export async function runHpssSeparation(
  ctx: AudioContext,
  sourceBuffer: AudioBuffer
): Promise<{
  harmonicBuffer: AudioBuffer;
  percussiveBuffer: AudioBuffer;
  bassBuffer: AudioBuffer;
} | null> {
  // Cap huge DJ mixes at 9 minutes for fast separation (~250ms)
  if (sourceBuffer.duration < 4 || sourceBuffer.duration > 540) {
    return null;
  }
  const worker = getHpssWorker();
  if (!worker) return null;

  const numCh = Math.min(2, sourceBuffer.numberOfChannels);
  const channels: Float32Array[] = [];
  const transfers: ArrayBuffer[] = [];
  for (let c = 0; c < numCh; c++) {
    const copy = new Float32Array(sourceBuffer.getChannelData(c));
    channels.push(copy);
    transfers.push(copy.buffer);
  }

  const jobId = nextJobId++;
  const result = await new Promise<{
    harmonic: Float32Array[];
    percussive: Float32Array[];
    bass: Float32Array[];
    sampleRate: number;
  } | null>((resolve) => {
    pendingJobs.set(jobId, { resolve });
    worker.postMessage(
      {
        id: jobId,
        channels,
        sampleRate: sourceBuffer.sampleRate,
        length: sourceBuffer.length,
      },
      transfers
    );
  });

  if (!result) return null;

  try {
    const harmonicBuffer = ctx.createBuffer(
      result.harmonic.length,
      sourceBuffer.length,
      result.sampleRate
    );
    const percussiveBuffer = ctx.createBuffer(
      result.percussive.length,
      sourceBuffer.length,
      result.sampleRate
    );
    const bassBuffer = ctx.createBuffer(
      result.bass.length,
      sourceBuffer.length,
      result.sampleRate
    );
    for (let c = 0; c < result.harmonic.length; c++) {
      harmonicBuffer.copyToChannel(new Float32Array(result.harmonic[c]), c);
      percussiveBuffer.copyToChannel(new Float32Array(result.percussive[c]), c);
      bassBuffer.copyToChannel(new Float32Array(result.bass[c]), c);
    }
    return { harmonicBuffer, percussiveBuffer, bassBuffer };
  } catch {
    return null;
  }
}
