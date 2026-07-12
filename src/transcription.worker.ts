import { env, pipeline } from '@xenova/transformers';

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

const SPEECH_MODEL_ID = 'Xenova/whisper-tiny.en';

let transcriberPromise: Promise<(audio: { array: Float32Array; sampling_rate: number }, options?: Record<string, unknown>) => Promise<{ text?: string }>> | null = null;

function postStatus(message: string) {
  self.postMessage({ type: 'status', message } satisfies StatusMessage);
}

async function getTranscriber() {
  if (!transcriberPromise) {
    env.allowRemoteModels = true;
    env.allowLocalModels = false;
    env.useBrowserCache = true;
    env.backends.onnx.wasm.numThreads = Math.max(1, Math.min(4, navigator.hardwareConcurrency || 2));
    postStatus('Downloading and loading the free speech model for first use...');
    transcriberPromise = pipeline('automatic-speech-recognition', SPEECH_MODEL_ID, {
      quantized: true,
    });
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
    const result = await transcriber(
      { array: data.samples, sampling_rate: data.sampleRate },
      {
        chunk_length_s: 15,
        stride_length_s: 3,
        return_timestamps: false,
      }
    );

    const text = typeof result?.text === 'string' ? result.text.trim() : '';
    self.postMessage({ type: 'result', id: data.id, text } satisfies ResultMessage);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Speech transcription failed.';
    self.postMessage({ type: 'error', id: data.id, message } satisfies ErrorMessage);
  }
};

postStatus('Speech worker ready.');
