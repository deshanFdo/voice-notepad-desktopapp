import { useEffect, useMemo, useRef, useState } from 'react';

type VoiceStatus = 'idle' | 'recording' | 'loading' | 'error';

const DRAFT_STORAGE_KEY = 'voice-notepad:draft';
const FILE_STORAGE_KEY = 'voice-notepad:file-path';
const MODEL_STORAGE_KEY = 'voice-notepad:model-id';

const MODELS = [
  { id: 'onnx-community/whisper-tiny.en', name: 'Tiny (Fastest, ~40MB)' },
  { id: 'onnx-community/whisper-base.en', name: 'Base (Recommended, ~77MB)' },
  { id: 'onnx-community/whisper-small.en', name: 'Small (Accurate, ~240MB)' },
];

type WorkerMessage =
  | { type: 'status'; message: string }
  | { type: 'progress'; file: string; loaded: number; total: number }
  | { type: 'result'; id: number; text: string }
  | { type: 'error'; id?: number; message: string };

function formatFileLabel(filePath: string | null) {
  if (!filePath) {
    return 'Untitled note';
  }

  const parts = filePath.split(/[/\\]/);
  return parts[parts.length - 1] || 'Untitled note';
}

function joinTranscript(current: string, nextText: string) {
  const trimmed = nextText.trim();
  if (!trimmed) {
    return current;
  }

  if (!current.trim()) {
    return trimmed;
  }

  const separator = /[\s\n]$/.test(current) ? '' : ' ';
  return `${current}${separator}${trimmed}`;
}

async function decodeAudioBlob(blob: Blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const audioContext = new AudioContext();
  try {
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer.slice(0));
    const channelData = audioBuffer.getChannelData(0);
    const mono = new Float32Array(channelData.length);
    mono.set(channelData);
    return {
      samples: mono,
      sampleRate: audioBuffer.sampleRate,
      duration: audioBuffer.duration,
    };
  } finally {
    void audioContext.close();
  }
}

export default function App() {
  const [noteText, setNoteText] = useState('');
  const [currentFilePath, setCurrentFilePath] = useState<string | null>(null);
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>('idle');
  const [workerStatus, setWorkerStatus] = useState('Initializing speech engine...');
  const [saveStatus, setSaveStatus] = useState('Draft autosaved locally.');
  const [isModelReady, setIsModelReady] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<{ loaded: number; total: number } | null>(null);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const [selectedModelId, setSelectedModelId] = useState<string>(() => {
    return window.localStorage.getItem(MODEL_STORAGE_KEY) || MODELS[1].id; // Default to Base model (MODELS[1])!
  });
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const chunkCounterRef = useRef(0);
  const processingQueueRef = useRef(Promise.resolve());
  const recordingStartRef = useRef<number | null>(null);
  const version = useMemo(() => 'Voice Notepad', []);
  const hasFailedRef = useRef(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const audioSamplesAccumulator = useRef<number[]>([]);
  const intervalIdRef = useRef<number | null>(null);

  async function updateDevices() {
    try {
      if (!navigator.mediaDevices?.enumerateDevices) {
        return;
      }
      const devicesList = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = devicesList.filter((d) => d.kind === 'audioinput');
      setDevices(audioInputs);
      
      if (audioInputs.length > 0) {
        setSelectedDeviceId((current) => {
          const exists = audioInputs.some((d) => d.deviceId === current);
          return exists ? current : audioInputs[0].deviceId;
        });
      }
    } catch (err) {
      console.error('Error enumerating audio devices:', err);
    }
  }

  // Handle device permissions and listing on mount
  useEffect(() => {
    if (!navigator.mediaDevices) {
      return;
    }

    void updateDevices();

    navigator.mediaDevices.getUserMedia({ audio: true })
      .then((stream) => {
        stream.getTracks().forEach((track) => track.stop());
        void updateDevices();
      })
      .catch((err) => {
        console.warn('Microphone permission not yet granted:', err);
      });

    navigator.mediaDevices.addEventListener('devicechange', updateDevices);
    return () => {
      navigator.mediaDevices.removeEventListener('devicechange', updateDevices);
    };
  }, []);

  // Initialize worker and load model when selectedModelId changes
  useEffect(() => {
    const storedDraft = window.localStorage.getItem(DRAFT_STORAGE_KEY);
    const storedFilePath = window.localStorage.getItem(FILE_STORAGE_KEY);

    if (storedDraft) {
      setNoteText(storedDraft);
    }

    if (storedFilePath) {
      setCurrentFilePath(storedFilePath);
    }

    setIsModelReady(false);
    setDownloadProgress(null);
    setWorkerStatus('Initializing speech engine...');

    const worker = new Worker(new URL('./transcription.worker.ts', import.meta.url), {
      type: 'module',
    });

    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const message = event.data;

      if (message.type === 'status') {
        setWorkerStatus(message.message);

        const lower = message.message.toLowerCase();
        if (lower.includes('ready')) {
          setIsModelReady(true);
          setVoiceStatus((prev) => (prev === 'loading' ? 'idle' : prev));
          setDownloadProgress(null);
        }

        if (lower.includes('downloading') || lower.includes('loading')) {
          setVoiceStatus((prev) => (prev === 'recording' ? prev : 'loading'));
        }
        return;
      }

      if (message.type === 'progress') {
        setDownloadProgress({ loaded: message.loaded, total: message.total });
        return;
      }

      if (message.type === 'result') {
        if (message.text) {
          setNoteText((current) => joinTranscript(current, message.text));
          setSaveStatus('Transcript inserted.');
        }
        return;
      }

      if (message.type === 'error') {
        console.error('[App] Worker reported error:', message.message);
        hasFailedRef.current = true;
        setVoiceStatus('error');
        setWorkerStatus(message.message);
        setSaveStatus(message.message);
        stopRecording();
      }
    };

    worker.onerror = (event) => {
      console.error('[App] Worker script execution error:', event);
      hasFailedRef.current = true;
      setVoiceStatus('error');
      setWorkerStatus(event.message || 'Speech worker failed.');
      stopRecording();
    };

    workerRef.current = worker;

    // Command the worker to load the active model
    worker.postMessage({ type: 'load', modelId: selectedModelId });

    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, [selectedModelId]);

  // Autosave draft
  useEffect(() => {
    const handle = window.setTimeout(() => {
      window.localStorage.setItem(DRAFT_STORAGE_KEY, noteText);
      if (currentFilePath) {
        window.localStorage.setItem(FILE_STORAGE_KEY, currentFilePath);
      } else {
        window.localStorage.removeItem(FILE_STORAGE_KEY);
      }
    }, 200);

    return () => window.clearTimeout(handle);
  }, [noteText, currentFilePath]);

  // Recording timer
  useEffect(() => {
    if (voiceStatus !== 'recording' || !recordingStartRef.current) {
      setRecordingSeconds(0);
      return undefined;
    }

    const timer = window.setInterval(() => {
      if (recordingStartRef.current) {
        setRecordingSeconds(Math.max(0, Math.round((Date.now() - recordingStartRef.current) / 1000)));
      }
    }, 250);

    return () => window.clearInterval(timer);
  }, [voiceStatus]);

  async function handleOpen() {
    const result = await window.noteApi.openNote();
    if (result.canceled) {
      return;
    }

    setNoteText(result.content);
    setCurrentFilePath(result.filePath);
    setSaveStatus(`Opened ${formatFileLabel(result.filePath)}`);
    textareaRef.current?.focus();
  }

  async function handleSave(saveAs = false) {
    const result = await window.noteApi.saveNote({
      content: noteText,
      filePath: saveAs ? null : currentFilePath,
    });

    if (result.canceled) {
      setSaveStatus('Save canceled.');
      return;
    }

    setCurrentFilePath(result.filePath);
    if (result.filePath) {
      setSaveStatus(`Saved to ${formatFileLabel(result.filePath)}`);
    }
  }

  function clearNote() {
    setNoteText('');
    setSaveStatus('Note cleared.');
    textareaRef.current?.focus();
  }

  async function startRecording() {
    if (voiceStatus === 'recording') {
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setVoiceStatus('error');
      setWorkerStatus('Microphone access is not available in this environment.');
      return;
    }

    hasFailedRef.current = false;

    try {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: selectedDeviceId ? { exact: selectedDeviceId } : undefined,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
      } catch (err) {
        console.warn('Failed to get selected audio input, falling back to default mic:', err);
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
      }

      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      const audioContext = new AudioContextClass({ sampleRate: 16000 });
      audioContextRef.current = audioContext;

      await audioContext.resume();

      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      processor.onaudioprocess = (e) => {
        const inputData = e.inputBuffer.getChannelData(0);
        audioSamplesAccumulator.current.push(...inputData);
      };

      source.connect(processor);
      processor.connect(audioContext.destination);

      chunkCounterRef.current = 0;
      audioSamplesAccumulator.current = [];
      recordingStartRef.current = Date.now();
      setRecordingSeconds(0);
      setVoiceStatus('recording');
      setWorkerStatus(isModelReady ? 'Listening... speak naturally.' : 'Recording — model still loading, will transcribe soon.');

      const intervalId = window.setInterval(() => {
        const samples = audioSamplesAccumulator.current;
        if (samples.length === 0) {
          return;
        }

        audioSamplesAccumulator.current = [];
        const floatSamples = new Float32Array(samples);

        let maxVal = 0;
        for (let i = 0; i < floatSamples.length; i++) {
          const abs = Math.abs(floatSamples[i]);
          if (abs > maxVal) {
            maxVal = abs;
          }
        }

        const chunkId = ++chunkCounterRef.current;

        if (maxVal < 0.01) {
          if (!hasFailedRef.current) {
            setWorkerStatus('Silence detected — keep speaking.');
          }
          return;
        }

        processingQueueRef.current = processingQueueRef.current.then(async () => {
          if (hasFailedRef.current) {
            return;
          }
          const worker = workerRef.current;
          if (!worker) {
            return;
          }

          setWorkerStatus(`Processing phrase ${chunkId}...`);

          const transferable = floatSamples.buffer;

          await new Promise<void>((resolve) => {
            const onMessage = (messageEvent: MessageEvent<WorkerMessage>) => {
              const message = messageEvent.data;
              if (message.type === 'result' && message.id === chunkId) {
                worker.removeEventListener('message', onMessage as EventListener);
                if (!hasFailedRef.current) {
                  setWorkerStatus(message.text ? 'Transcript added.' : 'Silence detected — keep speaking.');
                }
                resolve();
              }

              if (message.type === 'error' && message.id === chunkId) {
                console.error('[App] Transcription error for chunk', chunkId, ':', message.message);
                worker.removeEventListener('message', onMessage as EventListener);
                hasFailedRef.current = true;
                setVoiceStatus('error');
                setWorkerStatus(message.message);
                stopRecording();
                resolve();
              }
            };

            worker.addEventListener('message', onMessage as EventListener);
            worker.postMessage(
              {
                type: 'transcribe',
                id: chunkId,
                samples: new Float32Array(transferable),
                sampleRate: 16000,
              },
              [transferable],
            );
          });
        });
      }, 2500);

      intervalIdRef.current = intervalId;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to access microphone.';
      hasFailedRef.current = true;
      setVoiceStatus('error');
      setWorkerStatus(message);
      setSaveStatus(message);
    }
  }

  function stopRecording() {
    if (intervalIdRef.current) {
      window.clearInterval(intervalIdRef.current);
      intervalIdRef.current = null;
    }

    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }

    if (audioContextRef.current) {
      void audioContextRef.current.close();
      audioContextRef.current = null;
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }

    recordingStartRef.current = null;
    setRecordingSeconds(0);

    if (!hasFailedRef.current) {
      setVoiceStatus('idle');
      setWorkerStatus(isModelReady ? 'Ready — click to dictate again.' : 'Speech worker idle.');
    }
  }

  function toggleVoice() {
    if (voiceStatus === 'recording') {
      stopRecording();
      return;
    }

    void startRecording();
  }

  const characterCount = noteText.length;
  const wordCount = noteText.trim() ? noteText.trim().split(/\s+/).length : 0;

  const statusLabel =
    voiceStatus === 'recording'
      ? '● Listening'
      : voiceStatus === 'loading'
        ? 'Downloading'
        : voiceStatus === 'error'
          ? 'Error'
          : isModelReady
            ? '✓ Ready'
            : 'Initializing';

  const progressPercent =
    downloadProgress && downloadProgress.total > 0
      ? Math.min(100, Math.round((downloadProgress.loaded / downloadProgress.total) * 100))
      : null;

  const dictationButtonLabel =
    voiceStatus === 'recording'
      ? '■  Stop Dictation'
      : isModelReady
        ? '🎙  Start Dictation'
        : voiceStatus === 'loading'
          ? '⏳  Downloading Model...'
          : '🎙  Start Dictation';

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-block">
          <div className="brand-mark">VN</div>
          <div>
            <p className="eyebrow">Desktop dictation</p>
            <h1>Voice Notepad</h1>
          </div>
        </div>

        <div className="status-card">
          <span className={`status-pill status-${voiceStatus}`}>{statusLabel}</span>
          <p>{workerStatus}</p>

          {/* Download progress bar */}
          {progressPercent !== null && voiceStatus === 'loading' && (
            <div className="progress-container">
              <div className="progress-bar" style={{ width: `${progressPercent}%` }} />
              <span className="progress-label">{progressPercent}%</span>
            </div>
          )}

          <small>
            {isModelReady
              ? 'AI model cached locally — works offline.'
              : 'Free AI model downloads on first use (~40 MB, one-time).'}
          </small>
        </div>

        <div className="device-card">
          <label htmlFor="mic-select">🎙️ Audio Input Device</label>
          <select
            id="mic-select"
            className="device-select"
            value={selectedDeviceId}
            onChange={(e) => setSelectedDeviceId(e.target.value)}
            disabled={voiceStatus === 'recording'}
          >
            {devices.length === 0 ? (
              <option value="">No microphones found</option>
            ) : (
              devices.map((device) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label || `Microphone ${device.deviceId.substring(0, 5)}`}
                </option>
              ))
            )}
          </select>
        </div>

        <div className="device-card">
          <label htmlFor="model-select">🤖 Speech Recognition Model</label>
          <select
            id="model-select"
            className="device-select"
            value={selectedModelId}
            onChange={(e) => {
              setSelectedModelId(e.target.value);
              window.localStorage.setItem(MODEL_STORAGE_KEY, e.target.value);
            }}
            disabled={voiceStatus === 'recording'}
          >
            {MODELS.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name}
              </option>
            ))}
          </select>
        </div>

        <div className="metrics-grid">
          <div>
            <strong>{wordCount}</strong>
            <span>Words</span>
          </div>
          <div>
            <strong>{characterCount}</strong>
            <span>Characters</span>
          </div>
          <div>
            <strong>{recordingSeconds}s</strong>
            <span>Recording</span>
          </div>
          <div>
            <strong>{window.noteApi ? 'On' : 'Off'}</strong>
            <span>Bridge</span>
          </div>
        </div>

        <div className="action-stack">
          <button
            className={`primary ${voiceStatus === 'recording' ? 'recording-active' : ''}`}
            onClick={toggleVoice}
            disabled={voiceStatus === 'loading'}
          >
            {dictationButtonLabel}
          </button>
          <button onClick={handleOpen}>📂  Open</button>
          <button onClick={() => void handleSave(false)}>💾  Save</button>
          <button onClick={() => void handleSave(true)}>📄  Save As</button>
          <button onClick={clearNote}>🗑  Clear</button>
        </div>

        <div className="hint-card">
          <p>How it works</p>
          <ul>
            <li>Type normally or click the microphone button.</li>
            <li>Speech is transcribed locally by a free AI model.</li>
            <li>No internet needed after the first model download.</li>
            <li>Native spellcheck underlines misspellings.</li>
          </ul>
        </div>
      </aside>

      <main className="editor-panel">
        <header className="topbar">
          <div>
            <span className="eyebrow">Local first · offline capable · free AI</span>
            <h2>{formatFileLabel(currentFilePath)}</h2>
          </div>
          <div className="topbar-right">
            <span>{version}</span>
            <span>{saveStatus}</span>
          </div>
        </header>

        <textarea
          ref={textareaRef}
          className="notepad"
          placeholder="Type here or press Start Dictation and speak naturally..."
          value={noteText}
          onChange={(event) => setNoteText(event.target.value)}
          spellCheck
          autoCorrect="on"
          autoCapitalize="sentences"
        />
      </main>
    </div>
  );
}
