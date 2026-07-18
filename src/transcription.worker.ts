import { pipeline, env } from '@huggingface/transformers';

type TranscribeRequest = {
  type: 'transcribe';
  id: number;
  samples: Float32Array;
  sampleRate: number;
};

type LoadRequest = {
  type: 'load';
  modelId: string;
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

const DEFAULT_MODEL_ID = 'onnx-community/whisper-tiny.en';
const TARGET_SAMPLE_RATE = 16000; // Whisper expects 16 kHz audio

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let transcriberInstance: any | null = null;
let currentModelId = '';

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

async function getTranscriber(modelId: string) {
  const activeModelId = modelId || DEFAULT_MODEL_ID;

  if (!transcriberInstance || currentModelId !== activeModelId) {
    transcriberInstance = null;
    currentModelId = activeModelId;

    // Resolve the path to the directory containing local WASM files (dist/renderer/)
    const workerUrl = self.location.href;
    let wasmPath = './';
    if (workerUrl.includes('/assets/')) {
      // Production build: WASM files are copied to dist/renderer/ via public/
      wasmPath = workerUrl.substring(0, workerUrl.lastIndexOf('/assets/') + 1);
    }
    
    console.log('[Worker] Resolving WASM path to:', wasmPath);
    if (env.backends.onnx.wasm) {
      env.backends.onnx.wasm.wasmPaths = wasmPath;
      env.backends.onnx.wasm.numThreads = Math.max(1, Math.min(4, navigator.hardwareConcurrency || 2));
    }
    
    // Enable caching for offline support
    env.useBrowserCache = true;
    env.allowRemoteModels = true;
    env.allowLocalModels = true;

    postStatus(`Loading ${activeModelId.split('/').pop()} model...`);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const options: any = {
      dtype: 'q8', // 8-bit quantized is compatible and fast
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

    const tryLoad = async (device: 'webgpu' | 'wasm', localOnly: boolean) => {
      const runOptions = {
        ...options,
        device,
      };
      if (localOnly) {
        (runOptions as any).local_files_only = true;
      }
      return pipeline('automatic-speech-recognition', activeModelId, runOptions as any);
    };

    // 1. Try local WebGPU load (cached)
    try {
      console.log(`[Worker] Trying local WebGPU load for ${activeModelId}...`);
      transcriberInstance = await tryLoad('webgpu', true);
      postStatus('Model ready (GPU).');
      console.log('[Worker] WebGPU model loaded from cache.');
      return transcriberInstance;
    } catch (gpuCacheErr) {
      console.warn('[Worker] Local WebGPU load failed, trying local WASM load...', gpuCacheErr);
      
      // 2. Try local WASM load (cached)
      try {
        transcriberInstance = await tryLoad('wasm', true);
        postStatus('Model ready (CPU).');
        console.log('[Worker] WASM model loaded from cache.');
        return transcriberInstance;
      } catch (wasmCacheErr) {
        console.warn('[Worker] Local WASM load failed, checking online network connection...', wasmCacheErr);
        
        // If offline and cache load failed, throw error
        if (!navigator.onLine) {
          transcriberInstance = null;
          const errorMsg = 'Model is not cached locally, and you are offline. Please connect to the internet to download the speech model.';
          postStatus(errorMsg);
          throw new Error(errorMsg);
        }

        // 3. Online download attempt via WebGPU
        postStatus(`Downloading free AI model (first time only)...`);
        try {
          console.log('[Worker] Trying to download model for WebGPU...');
          transcriberInstance = await tryLoad('webgpu', false);
          postStatus('Model ready (GPU).');
          console.log('[Worker] Model downloaded and loaded via WebGPU.');
        } catch (gpuDownloadErr) {
          console.warn('[Worker] WebGPU download/load failed, falling back to WASM download...', gpuDownloadErr);
          
          // 4. Fallback online download attempt via WASM
          try {
            transcriberInstance = await tryLoad('wasm', false);
            postStatus('Model ready (CPU).');
            console.log('[Worker] Model downloaded and loaded via WASM.');
          } catch (wasmDownloadErr) {
            transcriberInstance = null;
            const message = wasmDownloadErr instanceof Error ? wasmDownloadErr.message : 'Download failed.';
            const errorMsg = `Failed to download model: ${message}`;
            postStatus(errorMsg);
            throw new Error(errorMsg);
          }
        }
      }
    }
  }

  return transcriberInstance;
}

self.onmessage = async (event: MessageEvent<TranscribeRequest | LoadRequest>) => {
  const data = event.data;

  if (data.type === 'load') {
    try {
      await getTranscriber(data.modelId);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Model load failed.';
      self.postMessage({ type: 'error', message: `Model load error: ${message}` } satisfies ErrorMessage);
    }
    return;
  }

  if (data.type !== 'transcribe') {
    return;
  }

  try {
    const transcriber = await getTranscriber(currentModelId);

    // Resample to 16 kHz — Whisper's expected sample rate
    const audio16k = resampleTo16kHz(data.samples, data.sampleRate);

    // Pass raw Float32Array directly (transformers.js v3 API)
    const result = await transcriber(audio16k, {
      chunk_length_s: 15,
      stride_length_s: 3,
      return_timestamps: false,
    });

    let text = typeof result?.text === 'string' ? result.text.trim() : '';

    // Clean blank audio and other tags
    text = text
      .replace(/\[blank_audio\]/gi, '')
      .replace(/\(blank_audio\)/gi, '')
      .replace(/\[music\]/gi, '')
      .replace(/\[laughter\]/gi, '')
      .replace(/\[applause\]/gi, '')
      .replace(/\[noise\]/gi, '')
      .replace(/\s+/g, ' ')
      .trim();

    // If text only contains punctuation after filtering, clear it
    if (/^[.,?!\s]+$/.test(text)) {
      text = '';
    }

    self.postMessage({ type: 'result', id: data.id, text } satisfies ResultMessage);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Speech transcription failed.';
    console.error('[Worker] Transcription error:', message);
    self.postMessage({ type: 'error', id: data.id, message: `Transcription error: ${message}` } satisfies ErrorMessage);
  }
};

postStatus('Speech worker initialized. Model will load or download on first use.');
