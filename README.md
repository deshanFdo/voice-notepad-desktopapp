# Voice Notepad

Electron desktop note app with live typing, local speech-to-text, and native spellcheck.

## What it uses

- Electron for the desktop shell
- React + Vite for the interface
- Xenova Transformers for free local speech recognition based on a tiny Whisper model
- Chromium spellcheck in the note editor

## Run it

```bash
npm install
npm run build
npm start
```

The first time you use dictation, the app downloads a small free model from Hugging Face and caches it locally. That is why the UI shows a loading message on first use. After the first download, startup and dictation are much faster.

If you want to publish the repository, users only need Node.js and this project. They can install dependencies, run it, or package it themselves.

## Build a double-clickable Windows app

```bash
npm run package:win
```

That produces Windows artifacts in the `release/` folder, including a portable executable and an installer. The portable EXE is the easiest double-click run option for end users.

## Notes

- The speech model is intentionally small so it runs better on low-end machines.
- Bigger models like Qwen-style audio models are not a good fit for potato PCs.
- Voice transcription depends on microphone access in the OS and browser engine.
