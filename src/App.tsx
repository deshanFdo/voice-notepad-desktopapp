import { useEffect, useMemo, useRef, useState } from 'react';

type VoiceStatus = 'idle' | 'recording' | 'loading' | 'error';

const DRAFT_STORAGE_KEY = 'voice-notepad:draft';
const FILE_STORAGE_KEY = 'voice-notepad:file-path';

type WorkerMessage =
  | { type: 'status'; message: string }
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
  const [workerStatus, setWorkerStatus] = useState('Speech worker idle.');
  const [saveStatus, setSaveStatus] = useState('Draft autosaved locally.');
  const [isModelReady, setIsModelReady] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const chunkCounterRef = useRef(0);
  const processingQueueRef = useRef(Promise.resolve());
  const recordingStartRef = useRef<number | null>(null);
  const version = useMemo(() => 'Voice Notepad', []);

  useEffect(() => {
    const storedDraft = window.localStorage.getItem(DRAFT_STORAGE_KEY);
    const storedFilePath = window.localStorage.getItem(FILE_STORAGE_KEY);

    if (storedDraft) {
      setNoteText(storedDraft);
    }

    if (storedFilePath) {
      setCurrentFilePath(storedFilePath);
    }

    const worker = new Worker(new URL('./transcription.worker.ts', import.meta.url), {
      type: 'module',
    });

    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const message = event.data;

      if (message.type === 'status') {
        setWorkerStatus(message.message);
        if (message.message.toLowerCase().includes('ready')) {
          setIsModelReady(true);
        }
        if (message.message.toLowerCase().includes('loading') || message.message.toLowerCase().includes('downloading')) {
          setVoiceStatus('loading');
        }
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
        setVoiceStatus('error');
        setWorkerStatus(message.message);
        setSaveStatus(message.message);
      }
    };

    worker.onerror = (event) => {
      setVoiceStatus('error');
      setWorkerStatus(event.message || 'Speech worker failed.');
    };

    workerRef.current = worker;

    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

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

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      const preferredMimeType = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/mp4',
      ].find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) || '';

      const recorder = new MediaRecorder(stream, preferredMimeType ? { mimeType: preferredMimeType } : undefined);
      mediaRecorderRef.current = recorder;
      streamRef.current = stream;
      chunkCounterRef.current = 0;
      recordingStartRef.current = Date.now();
      setRecordingSeconds(0);
      setVoiceStatus('recording');
      setWorkerStatus(isModelReady ? 'Recording and transcribing.' : 'Recording while the model loads.');

      recorder.ondataavailable = (event) => {
        if (!event.data || event.data.size === 0) {
          return;
        }

        const chunkId = ++chunkCounterRef.current;
        processingQueueRef.current = processingQueueRef.current.then(async () => {
          const worker = workerRef.current;
          if (!worker) {
            return;
          }

          setWorkerStatus(`Processing phrase ${chunkId}...`);
          const { samples, sampleRate } = await decodeAudioBlob(event.data);
          const transferable = samples.slice().buffer;

          await new Promise<void>((resolve) => {
            const onMessage = (messageEvent: MessageEvent<WorkerMessage>) => {
              const message = messageEvent.data;
              if (message.type === 'result' && message.id === chunkId) {
                worker.removeEventListener('message', onMessage as EventListener);
                setWorkerStatus(message.text ? 'Transcript added.' : 'Silence detected; keeping microphone open.');
                resolve();
              }

              if (message.type === 'error' && message.id === chunkId) {
                worker.removeEventListener('message', onMessage as EventListener);
                setVoiceStatus('error');
                setWorkerStatus(message.message);
                resolve();
              }
            };

            worker.addEventListener('message', onMessage as EventListener);
            worker.postMessage(
              {
                type: 'transcribe',
                id: chunkId,
                samples: new Float32Array(transferable),
                sampleRate,
              },
              [transferable]
            );
          });
        });
      };

      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        mediaRecorderRef.current = null;
        streamRef.current = null;
        recordingStartRef.current = null;
        setVoiceStatus('idle');
        setWorkerStatus('Speech worker idle.');
        setRecordingSeconds(0);
      };

      recorder.start(2500);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to access microphone.';
      setVoiceStatus('error');
      setWorkerStatus(message);
      setSaveStatus(message);
    }
  }

  function stopRecording() {
    const recorder = mediaRecorderRef.current;
    if (!recorder) {
      return;
    }

    if (recorder.state !== 'inactive') {
      recorder.stop();
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
  const statusLabel = voiceStatus === 'recording' ? 'Listening' : voiceStatus === 'loading' ? 'Downloading model' : voiceStatus === 'error' ? 'Attention needed' : 'Ready';

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
          <small>The speech model is free, local, and cached after the first download.</small>
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
          <button className="primary" onClick={toggleVoice} disabled={voiceStatus === 'loading'}>
            {voiceStatus === 'recording' ? 'Stop Dictation' : 'Start Dictation'}
          </button>
          <button onClick={handleOpen}>Open</button>
          <button onClick={() => void handleSave(false)}>Save</button>
          <button onClick={() => void handleSave(true)}>Save As</button>
          <button onClick={clearNote}>Clear</button>
        </div>

        <div className="hint-card">
          <p>Shortcut flow</p>
          <ul>
            <li>Type normally or use the microphone button.</li>
            <li>Voice text is appended automatically in chunks.</li>
            <li>Native spellcheck underlines typed misspellings.</li>
          </ul>
        </div>
      </aside>

      <main className="editor-panel">
        <header className="topbar">
          <div>
            <span className="eyebrow">Local first / offline capable after model download</span>
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
