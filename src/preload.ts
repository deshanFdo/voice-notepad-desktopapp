import { contextBridge, ipcRenderer } from 'electron';

type OpenResult = {
  canceled: boolean;
  filePath: string | null;
  content: string;
};

type SaveResult = {
  canceled: boolean;
  filePath: string | null;
};

type SavePayload = {
  content: string;
  filePath?: string | null;
};

const noteApi = {
  openNote: (): Promise<OpenResult> => ipcRenderer.invoke('note:open'),
  saveNote: (payload: SavePayload): Promise<SaveResult> => ipcRenderer.invoke('note:save', payload),
  appVersion: (): Promise<string> => ipcRenderer.invoke('app:version'),
  getGeminiKey: (): Promise<string> => ipcRenderer.invoke('app:getGeminiKey'),
};

contextBridge.exposeInMainWorld('noteApi', noteApi);
