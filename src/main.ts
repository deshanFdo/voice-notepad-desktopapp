import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';

type SavePayload = {
  content: string;
  filePath?: string | null;
};

type OpenResult = {
  canceled: boolean;
  filePath: string | null;
  content: string;
};

const isMac = process.platform === 'darwin';

// Enable WebGPU access on local origins/all GPUs
app.commandLine.appendSwitch('enable-unsafe-webgpu');

let mainWindow: BrowserWindow | null = null;

function getRendererPath() {
  return path.join(app.getAppPath(), 'dist', 'renderer', 'index.html');
}

async function readTextFile(filePath: string): Promise<string> {
  return fs.readFile(filePath, 'utf8');
}

async function writeTextFile(filePath: string, content: string): Promise<void> {
  await fs.writeFile(filePath, content, 'utf8');
}

async function openFileDialog(): Promise<OpenResult> {
  const result = await dialog.showOpenDialog({
    title: 'Open note',
    properties: ['openFile'],
    filters: [
      { name: 'Text files', extensions: ['txt', 'md', 'rtf'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true, filePath: null, content: '' };
  }

  const filePath = result.filePaths[0];
  const content = await readTextFile(filePath);
  return { canceled: false, filePath, content };
}

async function saveFileDialog(content: string, filePath?: string | null): Promise<{ canceled: boolean; filePath: string | null }> {
  const targetPath = filePath ?? null;

  if (targetPath) {
    await writeTextFile(targetPath, content);
    return { canceled: false, filePath: targetPath };
  }

  const result = await dialog.showSaveDialog({
    title: 'Save note',
    defaultPath: 'voice-note.txt',
    filters: [
      { name: 'Text files', extensions: ['txt'] },
      { name: 'Markdown files', extensions: ['md'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });

  if (result.canceled || !result.filePath) {
    return { canceled: true, filePath: null };
  }

  await writeTextFile(result.filePath, content);
  return { canceled: false, filePath: result.filePath };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1100,
    minHeight: 760,
    backgroundColor: '#0b1020',
    title: 'Voice Notepad',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    console.log(`[Renderer Console] [Level ${level}] ${message} (at ${sourceId}:${line})`);
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void require('electron').shell.openExternal(url);
    return { action: 'deny' };
  });

  void mainWindow.loadFile(getRendererPath());
}

app.whenReady().then(() => {
  ipcMain.handle('note:open', async () => openFileDialog());
  ipcMain.handle('note:save', async (_event, payload: SavePayload) => saveFileDialog(payload.content, payload.filePath));
  ipcMain.handle('app:version', async () => app.getVersion());

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (!isMac) {
    app.quit();
  }
});

process.on('uncaughtException', (error) => {
  console.error('Unhandled main-process error:', error);
});
