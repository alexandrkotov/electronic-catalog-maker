/**
 * Minimal ambient types for the File System Access API
 * (https://wicg.github.io/file-system-access/, Chromium-only as of writing).
 * Not part of TypeScript's bundled DOM lib — we declare only the narrow
 * slice this app actually uses. Feature-detected at runtime; every call site
 * falls back to a plain download when it's unavailable.
 */

interface FileSystemFileHandle {
  readonly name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<FileSystemWritableFileStream>;
}

interface FileSystemWritableFileStream {
  write(data: BufferSource | Blob | string): Promise<void>;
  close(): Promise<void>;
}

interface FilePickerAcceptType {
  description?: string;
  accept: Record<string, string[]>;
}

interface Window {
  showOpenFilePicker?(options?: {
    types?: FilePickerAcceptType[];
    multiple?: boolean;
  }): Promise<FileSystemFileHandle[]>;
  showSaveFilePicker?(options?: {
    types?: FilePickerAcceptType[];
    suggestedName?: string;
  }): Promise<FileSystemFileHandle>;
}
