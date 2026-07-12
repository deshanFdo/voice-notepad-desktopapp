# Voice Notepad

A free, local-first desktop app for voice dictation. Speak into your microphone, and the app writes it down — powered by a free AI model that runs entirely on your machine. No cloud, no API keys, no cost.

## Features

- **Voice dictation** — Click a button, speak, and text appears in the notepad
- **Type normally** — It's a full notepad with keyboard input too
- **Free AI model** — Uses OpenAI's Whisper Tiny (via Hugging Face), ~40 MB one-time download
- **100% local** — After the first model download, works completely offline
- **Spellcheck** — Native Chromium spellcheck underlines misspellings
- **Save/Open** — Open and save `.txt` and `.md` files
- **Lightweight** — Runs on low-end PCs (4 GB RAM, any modern CPU)

## How to run

### Prerequisites

- **Node.js 18+** — Download from [nodejs.org](https://nodejs.org/)

### Option 1: Portable EXE (easiest)

1. Download or clone this repository
2. Run `npm install` then `npm run package:win`
3. Open the `release/` folder
4. Double-click **`Voice Notepad 1.0.0.exe`** — that's it!

The portable EXE is a standalone app. Share it with anyone — they double-click and it runs. No Node.js needed.

On first dictation, the free AI model (~40 MB) downloads automatically with a progress bar. After that, everything works offline.

### Option 2: Run from source

```bash
npm install
npm start
```

## How it works

| Component | Technology |
|---|---|
| Desktop shell | Electron |
| UI framework | React + Vite |
| AI speech model | [Whisper Tiny English](https://huggingface.co/onnx-community/whisper-tiny.en) (free, open-source) |
| AI runtime | ONNX Runtime (WebAssembly) via [Transformers.js](https://huggingface.co/docs/transformers.js) |
| Spellcheck | Chromium built-in |

The AI model runs inside a Web Worker so the UI stays smooth while transcription happens in the background.

## System requirements

| | Minimum | Recommended |
|---|---|---|
| OS | Windows 10 | Windows 10/11 |
| RAM | 4 GB | 8 GB |
| CPU | Any x64 | Any modern x64 |
| Disk | 200 MB (app + model) | 200 MB |
| Internet | Required for first model download only | Same |
| Microphone | Any USB/built-in mic | Same |

## FAQ

**Q: Does this send my voice to the cloud?**
No. Everything runs locally on your machine. The AI model is downloaded once and cached forever.

**Q: Do I need an API key?**
No. The Whisper model is free and open-source. No accounts, no keys, no subscriptions.

**Q: What if I have a slow/old computer?**
The app uses the smallest Whisper model (Tiny English, ~40 MB) specifically so it works on low-end hardware. Transcription takes 1–3 seconds per phrase on a basic CPU.

**Q: Can I use this on Mac/Linux?**
The code works cross-platform via Electron. The `start.bat` is Windows-only, but you can run `npm install && npm start` on any OS.

## License

ISC
