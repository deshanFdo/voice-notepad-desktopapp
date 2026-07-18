import { useEffect, useMemo, useRef, useState } from 'react';

type VoiceStatus = 'idle' | 'recording' | 'loading' | 'error';
type Engine = 'fast' | 'offline';

const DRAFT_STORAGE_KEY = 'voice-notepad:draft';
const FILE_STORAGE_KEY = 'voice-notepad:file-path';
const MODEL_STORAGE_KEY = 'voice-notepad:model-id';
const ENGINE_STORAGE_KEY = 'voice-notepad:engine';

const MODELS = [
  { id: 'onnx-community/whisper-tiny.en', name: 'Tiny (Fastest, ~40MB)' },
  { id: 'onnx-community/whisper-base.en', name: 'Base (Balanced, ~77MB)' },
  { id: 'onnx-community/whisper-small.en', name: 'Small (Accurate, ~240MB)' },
];

const ENGINES: { id: Engine; name: string; description: string }[] = [
  { id: 'fast', name: '🌐 Online Mode (Gemini AI)', description: 'Fast transcription via Gemini API. Requires internet + API key in .env file.' },
  { id: 'offline', name: '✈️ Offline Mode (Local Whisper)', description: 'Free local AI model. No internet needed. Slower but fully private.' },
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

function writeString(view: DataView, offset: number, string: string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

function bufferToWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, 'data');
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }

  return buffer;
}

async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      const base64 = result.substring(result.indexOf(',') + 1);
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export default function App() {
  const [noteText, setNoteText] = useState('');
  const [currentFilePath, setCurrentFilePath] = useState<string | null>(null);
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>('idle');
  const [workerStatus, setWorkerStatus] = useState('Ready.');
  const [saveStatus, setSaveStatus] = useState('Draft autosaved locally.');
  const [isModelReady, setIsModelReady] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<{ loaded: number; total: number } | null>(null);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const [selectedModelId, setSelectedModelId] = useState<string>(() => {
    return window.localStorage.getItem(MODEL_STORAGE_KEY) || MODELS[0].id;
  });
  const [selectedEngine, setSelectedEngine] = useState<Engine>(() => {
    const stored = window.localStorage.getItem(ENGINE_STORAGE_KEY) as Engine | null;
    if (stored === 'fast' || stored === 'offline') return stored;
    // Default to online (Gemini API) — fast and accurate
    return 'fast';
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

  const initialNoteTextRef = useRef('');

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

    navigator.mediaDevices
      .getUserMedia({ audio: true })
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

  // Initialize worker for offline engine when selectedModelId changes
  useEffect(() => {
    const storedDraft = window.localStorage.getItem(DRAFT_STORAGE_KEY);
    const storedFilePath = window.localStorage.getItem(FILE_STORAGE_KEY);

    if (storedDraft) {
      setNoteText(storedDraft);
    }

    if (storedFilePath) {
      setCurrentFilePath(storedFilePath);
    }

    // Only spawn worker if offline engine is selected
    if (selectedEngine !== 'offline') {
      setIsModelReady(false);
      setWorkerStatus('Ready — using real-time speech engine.');
      return;
    }

    setIsModelReady(false);
    setDownloadProgress(null);
    setWorkerStatus('Initializing offline AI engine...');

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
        stopOfflineRecording();
      }
    };

    worker.onerror = (event) => {
      console.error('[App] Worker script execution error:', event);
      hasFailedRef.current = true;
      setVoiceStatus('error');
      setWorkerStatus(event.message || 'Speech worker failed.');
      stopOfflineRecording();
    };

    workerRef.current = worker;

    // Command the worker to load the active model
    worker.postMessage({ type: 'load', modelId: selectedModelId });

    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, [selectedModelId, selectedEngine]);

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

  // ─────────────────────────────────────────────────────────────────
  // FAST ENGINE: Gemini API (sends each chunk independently)
  // ─────────────────────────────────────────────────────────────────

  async function startFastRecording() {
    if (voiceStatus === 'recording') {
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setVoiceStatus('error');
      setWorkerStatus('Microphone access is not available in this environment.');
      return;
    }

    hasFailedRef.current = false;
    audioSamplesAccumulator.current = [];
    chunkCounterRef.current = 0;

    try {
      const apiKey = await window.noteApi.getGeminiKey();
      if (!apiKey || apiKey.trim() === 'your-api-key-here' || apiKey.trim() === '') {
        setWorkerStatus('No API key found. Add GOOGLE_API_KEY to your .env file and restart.');
        setVoiceStatus('error');
        hasFailedRef.current = true;
        return;
      }

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
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      }

      streamRef.current = stream;

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

      recordingStartRef.current = Date.now();
      setRecordingSeconds(0);
      setVoiceStatus('recording');
      setWorkerStatus('Listening... speak naturally.');

      // Send each 3-second chunk independently to Gemini for fast turnaround
      const intervalId = window.setInterval(() => {
        const samples = audioSamplesAccumulator.current;
        if (samples.length === 0) return;

        // Grab and clear the accumulator (only send new audio)
        audioSamplesAccumulator.current = [];
        const floatSamples = new Float32Array(samples);

        // Skip silence
        let maxVal = 0;
        for (let i = 0; i < floatSamples.length; i++) {
          const abs = Math.abs(floatSamples[i]);
          if (abs > maxVal) maxVal = abs;
        }
        if (maxVal < 0.01) return;

        const chunkId = ++chunkCounterRef.current;

        // Fire-and-forget: don't queue, send in parallel for speed
        (async () => {
          if (hasFailedRef.current) return;
          setWorkerStatus(`Transcribing chunk ${chunkId}...`);

          try {
            const wavBuffer = bufferToWav(floatSamples, 16000);
            const wavBlob = new Blob([wavBuffer], { type: 'audio/wav' });
            const base64Audio = await blobToBase64(wavBlob);

            const response = await fetch(
              `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${apiKey}`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  contents: [{
                    parts: [
                      { inlineData: { mimeType: 'audio/wav', data: base64Audio } },
                      { text: 'Transcribe this audio clip verbatim. Output ONLY the spoken words, nothing else. If silence or noise only, output nothing.' },
                    ],
                  }],
                }),
              }
            );

            if (!response.ok) {
              const errJson = await response.json().catch(() => ({}));
              throw new Error(errJson?.error?.message || `HTTP ${response.status}`);
            }

            const result = await response.json();
            let text = result.candidates?.[0]?.content?.parts?.[0]?.text || '';
            text = text.trim();

            // Strip wrapping quotes Gemini sometimes adds
            if (text.startsWith('"') && text.endsWith('"')) {
              text = text.slice(1, -1).trim();
            }

            if (text && !hasFailedRef.current) {
              setNoteText((current) => joinTranscript(current, text));
              setSaveStatus('Transcript updated.');
              setWorkerStatus('Listening... speak naturally.');
            }
          } catch (err) {
            console.error(`[Gemini] Chunk ${chunkId} error:`, err);
            if (!hasFailedRef.current) {
              setWorkerStatus(`Gemini error: ${err instanceof Error ? err.message : err}`);
              setVoiceStatus('error');
              hasFailedRef.current = true;
              stopFastRecording();
            }
          }
        })();
      }, 3000);

      intervalIdRef.current = intervalId;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to access microphone.';
      hasFailedRef.current = true;
      setVoiceStatus('error');
      setWorkerStatus(message);
      setSaveStatus(message);
    }
  }

  function stopFastRecording() {
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
      setWorkerStatus('Ready — click to dictate again.');
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // OFFLINE ENGINE: Whisper AI via Web Worker
  // ─────────────────────────────────────────────────────────────────

  async function startOfflineRecording() {
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

      streamRef.current = stream;

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
      setWorkerStatus(
        isModelReady ? 'Listening... speak naturally (offline AI).' : 'Recording — model still loading, will transcribe soon.'
      );

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
                stopOfflineRecording();
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

  function stopOfflineRecording() {
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

  // ─────────────────────────────────────────────────────────────────
  // UNIFIED TOGGLE
  // ─────────────────────────────────────────────────────────────────

  function toggleVoice() {
    if (voiceStatus === 'recording') {
      if (selectedEngine === 'fast') {
        stopFastRecording();
      } else {
        stopOfflineRecording();
      }
      return;
    }

    if (selectedEngine === 'fast') {
      startFastRecording();
    } else {
      void startOfflineRecording();
    }
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
          : selectedEngine === 'fast'
            ? '✓ Ready'
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
      : selectedEngine === 'fast'
        ? '🎙  Start Dictation'
        : isModelReady
          ? '🎙  Start Dictation'
          : voiceStatus === 'loading'
            ? '⏳  Downloading Model...'
            : '🎙  Start Dictation';

  const canStartDictation = selectedEngine === 'fast' || voiceStatus !== 'loading';

  const activeEngineInfo = ENGINES.find((e) => e.id === selectedEngine);

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
            {activeEngineInfo?.description || ''}
          </small>
        </div>

        <div className="device-card">
          <label htmlFor="engine-select">🚀 Speech Engine</label>
          <select
            id="engine-select"
            className="device-select"
            value={selectedEngine}
            onChange={(e) => {
              const engine = e.target.value as Engine;
              setSelectedEngine(engine);
              window.localStorage.setItem(ENGINE_STORAGE_KEY, engine);
              hasFailedRef.current = false;
              setVoiceStatus('idle');
              if (engine === 'fast') {
                setWorkerStatus('Ready — using real-time speech engine.');
              } else {
                setWorkerStatus('Initializing offline AI engine...');
              }
            }}
            disabled={voiceStatus === 'recording'}
          >
            {ENGINES.map((engine) => (
              <option key={engine.id} value={engine.id}>
                {engine.name}
              </option>
            ))}
          </select>
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

        {/* Only show model selector for offline engine */}
        {selectedEngine === 'offline' && (
          <div className="device-card">
            <label htmlFor="model-select">🤖 Whisper Model Size</label>
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
        )}

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
            <strong>{selectedEngine === 'fast' ? 'Live' : 'AI'}</strong>
            <span>Engine</span>
          </div>
        </div>

        <div className="action-stack">
          <button
            className={`primary ${voiceStatus === 'recording' ? 'recording-active' : ''}`}
            onClick={toggleVoice}
            disabled={!canStartDictation}
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
            {selectedEngine === 'fast' ? (
              <>
                <li>Speech is transcribed in real-time using your browser engine.</li>
                <li>Words appear instantly as you speak.</li>
                <li>Requires internet connection.</li>
              </>
            ) : (
              <>
                <li>Speech is transcribed locally by a free AI model.</li>
                <li>No internet needed after the first model download.</li>
                <li>Processing may take a few seconds per phrase.</li>
              </>
            )}
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
