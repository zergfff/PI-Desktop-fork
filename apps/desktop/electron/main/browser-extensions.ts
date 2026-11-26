import { dialog, shell, type BrowserWindow, type Session } from "electron";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { desktopDataDir } from "./data-paths";

/**
 * Browser extensions for the preview browser.
 *
 * Electron cannot run the Chrome Web Store's install flow: `session.loadExtension`
 * only accepts an unpacked directory, and a store `.crx` is a signed package the
 * store's own installer would expand. So an extension arrives the only way it can
 * — as a folder the reader already unpacked — and this module keeps the list of
 * those folders, loads them into the browser partition, and reports failures
 * instead of pretending they worked.
 *
 * Extensions are Chrome's, with Chrome's limits: Manifest V3 backgrounds run,
 * Manifest V2 ones (including the full uBlock Origin) are supported only as far
 * as Electron's Chromium still supports them.
 */

const EXTENSIONS_DIR = "browser-extensions";
const INDEX_FILE = "extensions.json";

export function browserExtensionsDir(): string {
  return join(desktopDataDir(), EXTENSIONS_DIR);
}

function indexFile(): string {
  return join(browserExtensionsDir(), INDEX_FILE);
}

/** Every recorded folder that still exists and still looks like an extension. */
export function readInstalledExtensions(): string[] {
  try {
    const raw = JSON.parse(readFileSync(indexFile(), "utf8")) as { paths?: unknown };
    if (!Array.isArray(raw.paths)) return [];
    return raw.paths.filter(
      (path): path is string =>
        typeof path === "string" && existsSync(join(path, "manifest.json")),
    );
  } catch {
    return [];
  }
}

function writeInstalledExtensions(paths: string[]): void {
  mkdirSync(browserExtensionsDir(), { recursive: true });
  writeFileSync(indexFile(), `${JSON.stringify({ paths }, null, 2)}\n`, "utf8");
}

/**
 * Load every recorded extension into one session.
 *
 * Called on each fresh browser pane instead of once at boot: the pane's session
 * is the `persist:work-browser` partition, and a pane can be created before the
 * first page loads. `getAllExtensions` makes it idempotent.
 */
export async function applyBrowserExtensions(
  session: Session,
  log?: (message: string) => void,
): Promise<void> {
  const paths = readInstalledExtensions();
  if (!paths.length) return;
  for (const path of paths) {
    try {
      if (session.getAllExtensions().some((entry) => entry.path === path)) continue;
      const loaded = await session.loadExtension(path, { allowFileAccess: true });
      log?.(`browser extension loaded: ${loaded.name}`);
    } catch (error) {
      log?.(`browser extension failed to load: ${path}: ${String(error)}`);
    }
  }
}

/** Ask for an unpacked extension folder; returns the path once it is recorded. */
export async function addBrowserExtension(
  window: BrowserWindow | null,
): Promise<{ path: string } | { error: string } | null> {
  const options: Electron.OpenDialogOptions = {
    title: "Load unpacked Chrome extension",
    buttonLabel: "Load extension",
    properties: ["openDirectory"],
  };
  const picked = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options);
  if (picked.canceled || !picked.filePaths.length) return null;
  const path = picked.filePaths[0];
  try {
    if (!statSync(path).isDirectory()) return { error: "choose the extension folder, not a file" };
    if (!existsSync(join(path, "manifest.json"))) {
      return { error: "that folder has no manifest.json — unpack the .crx/.zip first" };
    }
  } catch (error) {
    return { error: String(error) };
  }
  const paths = readInstalledExtensions();
  if (!paths.includes(path)) writeInstalledExtensions([...paths, path]);
  return { path };
}

export async function openBrowserExtensionsFolder(): Promise<void> {
  mkdirSync(browserExtensionsDir(), { recursive: true });
  await shell.openPath(browserExtensionsDir());
}
