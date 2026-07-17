# Voice Notepad

A free desktop app for voice dictation. Speak into your microphone and the app writes it down — instantly. Choose between **Online Mode** (real-time, like ChatGPT) or **Offline Mode** (powered by a free local AI model). No API keys, no subscriptions, no cost.

## Features

- **Two speech engines** — Online (instant real-time) or Offline (local AI, no internet needed)
- **Voice dictation** — Click a button, speak, and text appears in the notepad
- **Type normally** — Full notepad with keyboard input, spellcheck, and auto-save
- **Microphone selection** — Choose which mic to use from the sidebar
- **Free AI model** — Offline mode uses OpenAI's Whisper (via Hugging Face), downloaded once
- **Multiple model sizes** — Tiny (~40 MB), Base (~77 MB), or Small (~240 MB) for offline mode
- **100% local** — Offline mode works completely without internet after the first model download
- **Save/Open** — Open and save `.txt` and `.md` files
- **Lightweight** — Runs on low-end PCs

---

## How to Run

### Prerequisites

- **Node.js 18+** — Download from [nodejs.org](https://nodejs.org/)
- **Git** — Download from [git-scm.com](https://git-scm.com/)

### Option 1: Download the Portable EXE (Easiest — No Setup)

If someone has already built the app and shared the `release/` folder:

1. Open the `release/` folder
2. Double-click **`Voice Notepad 1.0.0.exe`**
3. That's it! No Node.js or Git needed.

> **Note:** Windows may show a SmartScreen warning since the app isn't code-signed. Click **"More info"** → **"Run anyway"**.

---

### Option 2: Clone and Build from Source

```bash
# 1. Clone the repository
git clone https://github.com/deshanFdo/voice-notepad-desktopapp.git
cd voice-notepad-desktopapp

# 2. Install dependencies
npm install

# 3. Run the app in development mode
npm start
```

The app will open in a window. You're ready to go!

---

### Option 3: Build a Portable EXE / Installer

```bash
# 1. Clone and install (same as above)
git clone https://github.com/deshanFdo/voice-notepad-desktopapp.git
cd voice-notepad-desktopapp
npm install

# 2. Build the Windows executable
npm run package:win
```

This creates two files in the `release/` folder:

| File | Description |
|---|---|
| `Voice Notepad 1.0.0.exe` | Portable app — double-click and run, no installation |
| `Voice Notepad Setup 1.0.0.exe` | Installer — installs to your PC with a shortcut |

Share either file with anyone — they can run it without Node.js.

---

## Using the App

### 1. Choose your Speech Engine

In the sidebar, use the **"🚀 Speech Engine"** dropdown:

| Mode | Speed | Internet | Best for |
|---|---|---|---|
| **🌐 Online Mode** | Instant (real-time) | Required | Fast dictation with internet |
| **✈️ Offline Mode** | ~5-15s per phrase | Not needed | Privacy, no internet access |

**Online Mode** is selected by default. Words appear instantly as you speak (same technology as ChatGPT's voice input).

**Offline Mode** downloads a free AI model on first use. After that, it works completely without internet.

### 2. Start Dictating

1. Click **"🎙 Start Dictation"**
2. Allow microphone access when prompted
3. Speak naturally — your words appear in the notepad
4. Click **"■ Stop Dictation"** when done

### 3. Other Features

- **Type normally** in the notepad at any time
- **Choose your microphone** from the "🎙️ Audio Input Device" dropdown
- **Choose AI model size** (Offline Mode only) — Tiny is fastest, Small is most accurate
- **Save / Open / Save As** — manage your text files
- **Auto-save** — your draft is saved automatically and restored when you reopen the app

---

## How it Works

| Component | Technology |
|---|---|
| Desktop shell | Electron |
| UI framework | React + Vite + TypeScript |
| Online speech engine | Web Speech API (Chromium built-in) |
| Offline AI model | [Whisper](https://huggingface.co/onnx-community/whisper-tiny.en) (free, open-source) |
| AI runtime | ONNX Runtime (WebAssembly / WebGPU) via [Transformers.js](https://huggingface.co/docs/transformers.js) |
| Spellcheck | Chromium built-in |

---

## System Requirements

| | Minimum | Recommended |
|---|---|---|
| OS | Windows 10 | Windows 10/11 |
| RAM | 4 GB | 8 GB |
| CPU | Any x64 | Any modern x64 |
| Disk | 200 MB (app + model) | 500 MB |
| Internet | Required for Online Mode; Offline Mode needs internet only for first model download | Same |
| Microphone | Any USB/built-in mic | Same |

---

## FAQ

**Q: Does this send my voice to the cloud?**
In **Online Mode**, yes — it uses your browser's built-in speech recognition service (same as Chrome/ChatGPT). In **Offline Mode**, no — everything runs 100% locally on your machine.

**Q: Do I need an API key?**
No. Both modes are completely free. No accounts, no keys, no subscriptions.

**Q: What if I have no internet?**
Switch to **Offline Mode** in the sidebar dropdown. It uses a free AI model that runs entirely on your computer. The model downloads once on first use (~40 MB for Tiny), then works forever without internet.

**Q: What if I have a slow/old computer?**
Use **Online Mode** for instant results (it offloads the work to the cloud). Or in Offline Mode, select the **Tiny** model (~40 MB) which is optimized for low-end hardware.

**Q: Can I use this on Mac/Linux?**
The code works cross-platform via Electron. Run `npm install && npm start` on any OS. For packaging, replace `package:win` with the appropriate electron-builder flag for your platform.

**Q: The Online Mode isn't working / gives an error?**
Online Mode requires an active internet connection. If you're getting errors, check your connection or switch to Offline Mode.

---

## Scripts

| Command | Description |
|---|---|
| `npm install` | Install all dependencies |
| `npm start` | Run the app in development mode |
| `npm run build` | Build the app for production |
| `npm run package:win` | Build + package as Windows EXE and installer |

---

## License

ISC
