/**
 * Downloads for the preview browser.
 *
 * A browser asks where to save the first time and then stops asking. This
 * registry does the same: the first download opens a folder picker, the choice is
 * persisted, and every later download goes straight into that folder with a
 * numeric suffix on collision. A download that arrives while the picker is open is
 * paused until it resolves, so no file is written to a folder the reader never
 * chose.
 *
 * Progress is kept as a short capped list (newest first) that the browser chrome
 * renders, so a slow file shows a bar instead of silence.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  app,
  dialog,
  type BrowserWindow,
  type DownloadItem,
  type Session,
} from "electron";
import { homedir } from "node:os";
import { desktopDataDir } from "./data-paths";

const SETTINGS_FILE = "browser-downloads.json";
const MAX_RECORDS = 20;

export type BrowserDownloadState = "progressing" | "completed" | "cancelled" | "interrupted";

export type BrowserDownload = {
  id: string;
  filename: string;
  /** Absolute path the file is being written to. */
  path: string;
  state: BrowserDownloadState;
  receivedBytes: number;
  totalBytes: number;
  startedAt: number;
  doneAt?: number;
};

type Entry = {
  item: DownloadItem;
  record: BrowserDownload;
};

type Settings = { directory?: string };

function settingsPath(): string {
  return join(desktopDataDir(), SETTINGS_FILE);
}

/** Remembered download folder, when the reader has chosen one. */
export function readDownloadDirectory(): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(settingsPath(), "utf8")) as Settings;
    return typeof parsed.directory === "string" && parsed.directory.trim()
      ? parsed.directory.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

export function writeDownloadDirectory(directory: string): void {
  try {
    mkdirSync(desktopDataDir(), { recursive: true });
    writeFileSync(settingsPath(), `${JSON.stringify({ directory }, null, 2)}\n`, "utf8");
  } catch {
    // a failed write only means the next download asks again
  }
}

/** Fallback shown in the picker before a folder has been chosen. */
export function defaultDownloadsDir(): string {
  try {
    return app.getPath("downloads");
  } catch {
    return join(homedir(), "Downloads");
  }
}

/** Where new files land right now: the chosen folder, else the OS default. */
export function activeDownloadsDir(): string {
  return readDownloadDirectory() ?? defaultDownloadsDir();
}

/** `report.pdf`, then `report (1).pdf`, … so nothing is silently overwritten. */
function uniquePath(dir: string, name: string): string {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  let target = join(dir, name);
  for (let index = 1; existsSync(target) && index < 1000; index += 1) {
    target = join(dir, `${stem} (${index})${extension}`);
  }
  return target;
}

export class DownloadRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly order: string[] = [];
  private readonly listeners = new Set<(items: BrowserDownload[]) => void>();
  private readonly attached = new WeakSet<object>();
  private windowProvider: (() => BrowserWindow | null) | null = null;
  /** Serialises the "ask once" flow when several downloads start together. */
  private chooser: Promise<string | null> | null = null;
  private asking = false;

  /** The window the folder picker is parented to. */
  setWindowProvider(provider: () => BrowserWindow | null): void {
    this.windowProvider = provider;
  }

  subscribe(listener: (items: BrowserDownload[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Snapshot for `BrowserState`; newest first. */
  list(): BrowserDownload[] {
    return this.order
      .map((id) => this.entries.get(id)?.record)
      .filter((record): record is BrowserDownload => Boolean(record))
      .slice(0, MAX_RECORDS);
  }

  cancel(id: string): boolean {
    const entry = this.entries.get(id.trim());
    if (!entry || entry.record.state !== "progressing") return false;
    entry.item.cancel();
    return true;
  }

  /** Ask for a folder now, and use it for every later download. */
  async chooseDirectory(): Promise<string | null> {
    if (this.asking) return null;
    this.asking = true;
    try {
      const window = this.windowProvider?.() ?? null;
      const options: Electron.OpenDialogOptions = {
        title: "选择下载保存的文件夹",
        buttonLabel: "保存到此文件夹",
        defaultPath: activeDownloadsDir(),
        properties: ["openDirectory", "createDirectory"],
      };
      const picked = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options);
      if (picked.canceled || !picked.filePaths.length) return null;
      const directory = picked.filePaths[0];
      writeDownloadDirectory(directory);
      return directory;
    } finally {
      this.asking = false;
    }
  }

  /** One `will-download` tap per session. */
  attach(session: Session): void {
    if (this.attached.has(session)) return;
    this.attached.add(session);
    session.on("will-download", (_event, item) => {
      void this.track(item);
    });
  }

  private async track(item: DownloadItem): Promise<void> {
    const filename = item.getFilename() || "download";
    const known = readDownloadDirectory();
    const id = randomUUID();
    const record: BrowserDownload = {
      id,
      filename,
      path: "",
      state: "progressing",
      receivedBytes: 0,
      totalBytes: item.getTotalBytes(),
      startedAt: Date.now(),
    };
    this.entries.set(id, { item, record });
    this.order.unshift(id);
    this.evict();
    this.emit();
    this.watch(item, record);

    let directory: string | undefined = known;
    if (!directory) {
      // Hold the bytes until the reader answers: Chromium would otherwise start
      // writing into whichever default it happened to have.
      item.pause();
      // Cancelling the picker is not cancelling the download: the OS Downloads
      // folder is the documented default, so that is where it goes.
      directory = (await this.askOnce()) ?? defaultDownloadsDir();
      item.resume();
    }
    try {
      mkdirSync(directory, { recursive: true });
    } catch {
      item.cancel();
      return;
    }
    const target = uniquePath(directory, filename);
    record.path = target;
    item.setSavePath(target);
    this.emit();
  }

  /** The picker runs once even when several downloads start together. */
  private async askOnce(): Promise<string> {
    const existing = readDownloadDirectory();
    if (existing) return existing;
    if (!this.chooser) {
      this.chooser = this.chooseDirectory().finally(() => {
        this.chooser = null;
      });
    }
    const picked = await this.chooser;
    // Asked once: whether or not the reader picked, later downloads are silent.
    const resolved = picked ?? defaultDownloadsDir();
    writeDownloadDirectory(resolved);
    return resolved;
  }

  private watch(item: DownloadItem, record: BrowserDownload): void {
    let lastEmit = 0;
    item.on("updated", (_event, state) => {
      record.receivedBytes = item.getReceivedBytes();
      record.totalBytes = item.getTotalBytes();
      // Progress fires many times a second; the chrome polls at its own pace.
      const now = Date.now();
      if (now - lastEmit < 400) return;
      lastEmit = now;
      record.state = state === "interrupted" ? "interrupted" : "progressing";
      this.emit();
    });
    item.once("done", (_event, state) => {
      record.state =
        state === "completed" ? "completed" : state === "cancelled" ? "cancelled" : "interrupted";
      record.receivedBytes = item.getReceivedBytes();
      record.totalBytes = item.getTotalBytes() || record.receivedBytes;
      record.doneAt = Date.now();
      this.emit();
    });
  }

  private evict(): void {
    while (this.order.length > MAX_RECORDS) {
      const reversed = [...this.order].reverse();
      const index = reversed.findIndex((id) => this.entries.get(id)?.record.state !== "progressing");
      if (index < 0) return;
      const id = reversed[index];
      this.order.splice(this.order.indexOf(id), 1);
      this.entries.delete(id);
    }
  }

  private emit(): void {
    const snapshot = this.list();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // a broken listener must not stop the others
      }
    }
  }
}

/** One registry for the whole app: the browser partition is shared. */
export const downloadRegistry = new DownloadRegistry();
