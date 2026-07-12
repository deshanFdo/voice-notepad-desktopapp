import { pipeline, env } from '@huggingface/transformers';

type TranscribeRequest = {
  type: 'transcribe';
  id: number;
  samples: Float32Array;
  sampleRate: number;
};

type StatusMessage = {
  type: 'status';
  message: string;
};

type ProgressMessage = {
  type: 'progress';
  file: string;
  loaded: number;
  total: number;
};

type ResultMessage = {
  type: 'result';
  id: number;
  text: string;
};

type ErrorMessage = {
  type: 'error';
  id?: number;
  message: string;
};

/* Free, open-source Whisper Tiny English model from Hugging Face.
   ~40 MB one-time download, cached in the browser/Electron cache forever.
   No API keys, no cloud, no cost. Runs 100% locally via ONNX WebAssembly. */
const SPEECH_MODEL_ID = 'Xenova/whisper-tiny.en';

const TARGET_SAMPLE_RATE = 16000; // Whisper expects 16 kHz audio

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let transcriberPromise: Promise<any> | null = null;

function postStatus(message: string) {
  self.postMessage({ type: 'status', message } satisfies StatusMessage);
}

function postProgress(file: string, loaded: number, total: number) {
  self.postMessage({ type: 'progress', file, loaded, total } satisfies ProgressMessage);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(0)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Resample audio from any sample rate down to 16 kHz using linear interpolation. */
function resampleTo16kHz(samples: Float32Array, fromRate: number): Float32Array {
  if (fromRate === TARGET_SAMPLE_RATE) {
    return samples;
  }

  const ratio = fromRate / TARGET_SAMPLE_RATE;
  const newLength = Math.round(samples.length / ratio);
  const result = new Float32Array(newLength);

  for (let i = 0; i < newLength; i++) {
    const srcIndex = i * ratio;
    const low = Math.floor(srcIndex);
    const high = Math.min(low + 1, samples.length - 1);
    const fraction = srcIndex - low;
    result[i] = samples[low] * (1 - fraction) + samples[high] * fraction;
  }

  return result;
}

async function getTranscriber() {
  if (!transcriberPromise) {
    // Configure for remote model download — no API key needed
    env.allowRemoteModels = true;
    env.allowLocalModels = false;

    postStatus('Downloading free AI model (first time only)...');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const options: any = {
      quantized: true,
      progress_callback: (progress: { status: string; file?: string; loaded?: number; total?: number; name?: string }) => {
        if (progress.status === 'progress' && progress.file && progress.loaded != null && progress.total != null && progress.total > 0) {
          postProgress(progress.file, progress.loaded, progress.total);
          postStatus(`Downloading: ${formatBytes(progress.loaded)} / ${formatBytes(progress.total)}`);
        } else if (progress.status === 'download') {
          const fileName = progress.file || progress.name || 'model file';
          postStatus(`Downloading ${fileName}...`);
        } else if (progress.status === 'done') {
          postStatus('Model files downloaded, initializing...');
        }
      },
    };

    transcriberPromise = pipeline('automatic-speech-recognition', SPEECH_MODEL_ID, options);

    try {
      await transcriberPromise;
      postStatus('Model ready.');
    } catch (err) {
      transcriberPromise = null;
      const message = err instanceof Error ? err.message : 'Failed to load speech model.';
      self.postMessage({ type: 'error', message: `Model load failed: ${message}` } satisfies ErrorMessage);
      throw err;
    }
  }

  return transcriberPromise;
}

self.onmessage = async (event: MessageEvent<TranscribeRequest>) => {
  const data = event.data;

  if (data.type !== 'transcribe') {
    return;
  }

  try {
    const transcriber = await getTranscriber();

    // Resample to 16 kHz — Whisper's expected sample rate
    const audio16k = resampleTo16kHz(data.samples, data.sampleRate);

    // Pass raw Float32Array directly (transformers.js v3 API)
    const result = await transcriber(audio16k, {
      chunk_length_s: 15,
      stride_length_s: 3,
      return_timestamps: false,
    });

    const text = typeof result?.text === 'string' ? result.text.trim() : '';
    self.postMessage({ type: 'result', id: data.id, text } satisfies ResultMessage);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Speech transcription failed.';
    self.postMessage({ type: 'error', id: data.id, message: `Transcription error: ${message}` } satisfies ErrorMessage);
  }
};

postStatus('Speech worker initialized. Model will download on first use.');
