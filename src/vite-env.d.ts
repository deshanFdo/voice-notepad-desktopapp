/// <reference types="vite/client" />

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

interface NoteApi {
  openNote: () => Promise<OpenResult>;
  saveNote: (payload: SavePayload) => Promise<SaveResult>;
  appVersion: () => Promise<string>;
}

declare global {
  interface Window {
    noteApi: NoteApi;
  }
}

export {};
