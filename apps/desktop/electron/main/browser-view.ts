import { app, BrowserWindow, clipboard, dialog, Menu, shell, View, WebContentsView, type ContextMenuParams, type MenuItemConstructorOptions, type WebContents } from "electron";
import { appendFileSync, existsSync, mkdirSync, realpathSync, statSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { BrowserState } from "@pi-desktop/shared";
import { isAllowedHttpUrl, parseAllowedExternalUrl } from "./safe-open-external";
import { BrowserBackingHost } from "./browser-backing-host";
import { BROWSER_FIND_SCRIPT, BROWSER_FIND_STYLE } from "./browser-find";
import {
  adblockCosmeticCss,
  adblockListPath,
  createAdblockRuntime,
  ensureAdblockList,
  installAdblock,
  loadAdblockRules,
  readAdblockEnabled,
  readAdblockSettings,
  onlineRuleCount,
  refreshOnlineLists,
  writeAdblockEnabled,
  writeAdblockSettings,
  type AdblockRuleSet,
} from "./browser-adblock";
import { desktopDataDir } from "./data-paths";
import { activeDownloadsDir, downloadRegistry } from "./browser-downloads";

/**
 * Work panel embedded preview browser (D100, ADR 0019).
 *
 * A single WebContentsView owned by the main process, clipped by a native
 * presentation View positioned from renderer-measured bounds. The renderer is the
 * visibility authority: it hides the view whenever the browser tab is not
 * the active panel surface or a blocking overlay opens (the view always
 * composites above renderer content).
 *
 * Besides http(s) URLs, the pane renders existing local HTML files with live
 * reload: the loaded file's directory is watched so edits to the page or its
 * sibling assets refresh the preview.
 */

const PARTITION = "persist:work-browser";

/**
 * Ad blocking runs in the host, not through the loaded extensions: Electron
 * grants an extension `declarativeNetRequest` but never enforces its static
 * rules (measured — a one-rule blocker left `/blocked.js` executing), while
 * `webRequest.onBeforeRequest` does cancel. One listener per session, so this
 * installs once and re-reads the user's list on demand.
 */
const adblockRuntime = createAdblockRuntime();
const adblockSessions = new WeakSet<object>();
let adblockRules: AdblockRuleSet | null = null;

function adblockDir(): string {
  return desktopDataDir();
}

function reloadAdblockRules(): AdblockRuleSet {
  adblockRules = loadAdblockRules(adblockDir());
  return adblockRules;
}

/** Where the pane drops downloaded files; the OS default, not a private folder. */
function ensureAdblock(session: Electron.Session): void {
  if (adblockSessions.has(session)) return;
  adblockSessions.add(session);
  installAdblock(
    session,
    () => ({
      enabled: readAdblockEnabled(adblockDir()),
      rules: adblockRules ?? reloadAdblockRules(),
    }),
    adblockRuntime,
  );
}
const LIVE_RELOAD_DEBOUNCE_MS = 250;

export function normalizeUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed);
  // A dotted hostname or localhost followed by a numeric port is an HTTP
  // address, not a custom scheme. Keep other schemes subject to the allowlist.
  const hasHostPort =
    /^(?:localhost|(?:[a-zA-Z0-9-]+\.)+[a-zA-Z0-9-]+):\d+(?:[/?#]|$)/i.test(trimmed);
  const withScheme = hasScheme && !hasHostPort
    ? trimmed
    : `http://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function rootBoundary(root: string): string {
  return root.endsWith(sep) ? root : root + sep;
}

function isWithinRoot(path: string, root: string): boolean {
  try {
    const realRoot = realpathSync(resolve(root));
    const realPath = realpathSync(resolve(path));
    return realPath === realRoot || realPath.startsWith(rootBoundary(realRoot));
  } catch {
    const resolvedRoot = resolve(root);
    const resolvedPath = resolve(path);
    return resolvedPath === resolvedRoot || resolvedPath.startsWith(rootBoundary(resolvedRoot));
  }
}

function resolveExistingFile(candidate: string): string | null {
  try {
    const real = realpathSync(resolve(candidate));
    return statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

function fileUrlToLocalPath(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "file:" || (url.hostname && url.hostname !== "localhost")) return null;
    return fileURLToPath(url);
  } catch {
    return null;
  }
}

/**
 * Resolve a BrowserPreview input to a previewable file inside the workspace.
 * It accepts a file:// URL, absolute path, or workspace-relative path. This
 * stays workspace-scoped for the Agent BrowserPreview tool and sidecar.
 */
export function resolveLocalFile(raw: string, root: string | null): string | null {
  const trimmed = raw.trim();
  if (!trimmed || !root) return null;
  let candidate: string | null = null;
  if (/^file:/i.test(trimmed)) {
    try {
      candidate = fileURLToPath(trimmed);
    } catch {
      return null;
    }
  } else if (isAbsolute(trimmed)) {
    candidate = trimmed;
  } else if (/^\.{1,2}\//.test(trimmed) || /\.[a-zA-Z0-9]+$/.test(trimmed)) {
    candidate = resolve(root, trimmed);
  }
  if (!candidate) return null;
  if (!isWithinRoot(candidate, root)) return null;
  const real = resolveExistingFile(candidate);
  return real && isWithinRoot(real, root) ? real : null;
}

/**
 * Resolve a file requested by the embedded browser. Explicit file URLs and
 * absolute paths may target any existing local file; relative inputs remain
 * rooted in the current workspace. BrowserPreview uses resolveLocalFile.
 */
function resolveBrowserLocalFile(raw: string, root: string | null): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^file:/i.test(trimmed)) {
    const candidate = fileUrlToLocalPath(trimmed);
    return candidate ? resolveExistingFile(candidate) : null;
  }
  if (isAbsolute(trimmed)) return resolveExistingFile(trimmed);
  return resolveLocalFile(trimmed, root);
}

export class BrowserPane {
  private static readonly sharedBackingHost = new BrowserBackingHost();
  private view: WebContentsView | null = null;
  private surface: View | null = null;
  private window: BrowserWindow | null = null;
  private attachedWindow: BrowserWindow | null = null;
  private visible = false;
  private bounds = { x: 0, y: 0, width: 0, height: 0 };
  private viewportPinned = false;
  private operationTail: Promise<void> = Promise.resolve();
  private onState: (state: BrowserState) => void;
  private fileRoot: string | null = null;
  private watcher: FSWatcher | null = null;
  private watchedDir: string | null = null;
  private reloadTimer: NodeJS.Timeout | null = null;
  private navigationEpoch = 0;
  private stateEventsEpoch: number | null = null;
  private stateUrl: string | null = null;
  private nativeNavigationPending = false;
  private pendingTarget: string | null = null;
  private loadError: { url: string; message: string } | null = null;
  private cancelPending: (() => void) | null = null;
  /** Per-pane page zoom; the panel keeps its own factor. */
  private zoomFactor = 1;
  private findStylesInjected = false;
  /** Key of the inserted cosmetic CSS, so a toggle can remove it again. */
  private cosmeticKey: string | null = null;
  private downloadsSubscribed = false;

  private readonly onOpenUrl?: (url: string) => void;
  /** Ask the host for another browser tab showing `url`. */
  private readonly onNewTab?: (url: string) => void;
  private readonly backingHost: BrowserBackingHost;

  constructor(
    onState: (state: BrowserState) => void,
    onOpenUrl?: (url: string) => void,
    backingHost = BrowserPane.sharedBackingHost,
    onNewTab?: (url: string) => void,
  ) {
    this.onState = onState;
    this.onOpenUrl = onOpenUrl;
    this.backingHost = backingHost;
    this.onNewTab = onNewTab;
  }

  setWindow(window: BrowserWindow | null): void {
    if (this.window === window) return;
    this.detach();
    this.window = window;
  }

  getState(): BrowserState | null {
    const wc = this.view?.webContents;
    if (!wc || wc.isDestroyed()) {
      return this.loadError ? {
        url: this.loadError.url,
        title: "",
        isLoading: false,
        loadError: this.loadError.message,
        canGoBack: false,
        canGoForward: false,
      } : null;
    }
    return {
      url: this.loadError?.url ?? this.pendingTarget ?? wc.getURL(),
      title: wc.getTitle(),
      isLoading: !this.loadError && (this.pendingTarget !== null || wc.isLoading()),
      ...(this.loadError ? { loadError: this.loadError.message } : {}),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      ...(readAdblockEnabled(adblockDir())
        ? { blocked: adblockRuntime.snapshot().blocked }
        : {}),
      ...(this.downloads.length
        ? {
            downloads: this.downloads.map((item) => ({
              id: item.id,
              filename: item.filename,
              state: item.state,
              receivedBytes: item.receivedBytes,
              totalBytes: item.totalBytes,
            })),
          }
        : {}),
    };
  }

  /** Newest-first download list, mirrored into the state the chrome reads. */
  get downloads() {
    return downloadRegistry.list();
  }

  getWebContents() {
    const wc = this.view?.webContents;
    if (!wc || wc.isDestroyed()) return null;
    return wc;
  }

  /** Captures and pointer input share one page-local viewport owner. */
  captureScreenshot<T>(capture: (wc: WebContents) => Promise<T>): Promise<T> {
    return this.withStableViewport(capture);
  }

  withStableViewport<T>(operation: (wc: WebContents) => Promise<T>): Promise<T> {
    // Pin identity before queueing; a replacement cannot receive old work.
    const wc = this.getWebContents();
    const task = this.operationTail.then(async () => {
      if (!wc || wc.isDestroyed() || this.getWebContents() !== wc) {
        throw Object.assign(new Error("browser guest is not available"), { code: "UNAVAILABLE" });
      }
      const throttled = wc.getBackgroundThrottling();
      this.viewportPinned = true;
      wc.setBackgroundThrottling(false);
      try {
        return await operation(wc);
      } finally {
        this.viewportPinned = false;
        if (!wc.isDestroyed()) wc.setBackgroundThrottling(throttled);
        this.applyBounds();
      }
    });
    // The caller still receives capture errors; a failure must not block the
    // next independent capture.
    this.operationTail = task.then(() => undefined, () => undefined);
    return task;
  }

  /**
   * Stop native WebContents events from publishing state for the document
   * that belonged to the previous session. The next completed managed
   * navigation establishes a new event scope.
   */
  invalidateNavigation(): void {
    this.cancelPending?.();
    this.cancelPending = null;
    this.pendingTarget = null;
    this.loadError = null;
    this.navigationEpoch += 1;
    this.stateEventsEpoch = null;
    this.stateUrl = null;
    this.nativeNavigationPending = false;
  }

  navigate(raw: string, fileRoot: string | null = null): BrowserState | null {
    void this.navigateAndWait(raw, fileRoot);
    return this.getState();
  }

  async navigateAndWait(
    raw: string,
    fileRoot: string | null = null,
    timeoutMs = 15_000,
  ): Promise<BrowserState | null> {
    if (fileRoot) this.fileRoot = fileRoot;
    const localPath = resolveBrowserLocalFile(raw, this.fileRoot);
    const trimmed = raw.trim();
    const localInput = /^file:/i.test(trimmed) || isAbsolute(trimmed) || /^\.{1,2}\//.test(trimmed);
    const target = localPath
      ? pathToFileURL(localPath).toString()
      : localInput ? null : normalizeUrl(raw);
    if (!target) {
      this.beginManagedNavigation();
      this.loadError = { url: raw, message: localInput ? "LOCAL_FILE_NOT_ALLOWED" : "INVALID_URL" };
      const state = this.getState();
      if (state) this.onState(state);
      return null;
    }
    const epoch = this.beginManagedNavigation();
    this.pendingTarget = target;
    this.loadError = null;
    if (localPath) this.watchDirForReload(dirname(localPath));
    else this.clearLiveReload();
    const view = this.ensureView();
    const wc = view.webContents;
    const loading = this.getState();
    if (loading) this.onState(loading);
    if (this.visible) this.attach();
    return new Promise<BrowserState | null>((resolve) => {
      let settled = false;
      let started = false;
      const destinations = new Set([target]);
      const finish = (committed: boolean, error?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        wc.removeListener("did-start-navigation", onStart);
        wc.removeListener("did-navigate", onCommit);
        wc.removeListener("did-redirect-navigation", onRedirect);
        wc.removeListener("did-fail-load", onFailure);
        if (epoch !== this.navigationEpoch) { resolve(null); return; }
        this.cancelPending = null;
        this.pendingTarget = null;
        if (error) this.loadError = { url: target, message: error };
        const state = this.getState();
        if (committed && state) this.enableStateEvents(epoch, state.url);
        if (error && state) this.onState(state);
        resolve(committed ? state : null);
      };
      const onStart = (_event: unknown, url: string, inPlace: boolean, mainFrame: boolean) => {
        if (mainFrame && !inPlace && url === target) started = true;
      };
      const onRedirect = (_event: unknown, url: string, inPlace: boolean, mainFrame: boolean) => {
        if (started && mainFrame && !inPlace && epoch === this.navigationEpoch) destinations.add(url);
      };
      const onFailure = (_event: unknown, code: number, description: string, url: string, mainFrame: boolean) => {
        if (mainFrame !== false && code !== -3 && destinations.has(url)) finish(false, description);
      };
      const onCommit = (_event: unknown, url: string) => {
        // A current main-frame commit is ready to display even if images or
        // subframes are still loading. Old-session events cannot satisfy it.
        if (started && epoch === this.navigationEpoch && destinations.has(url) && url === wc.getURL()) finish(true);
      };
      const timer = setTimeout(() => finish(false, "ERR_TIMED_OUT"), Math.max(1, timeoutMs));
      this.cancelPending = () => finish(false);
      wc.on("did-start-navigation", onStart);
      wc.on("did-navigate", onCommit);
      wc.on("did-redirect-navigation", onRedirect);
      wc.on("did-fail-load", onFailure);
      void wc.loadURL(target).then(
        () => { if (destinations.has(wc.getURL())) finish(true); },
        (error: unknown) => finish(false, error instanceof Error ? error.message : String(error)),
      );
    });
  }

  action(action: "back" | "forward" | "reload" | "stop"): void {
    const wc = this.view?.webContents;
    if (!wc || wc.isDestroyed()) return;
    if (action === "stop" && this.pendingTarget) {
      const url = this.pendingTarget;
      this.cancelPending?.();
      this.loadError = { url, message: "ERR_ABORTED" };
      wc.stop();
      const state = this.getState();
      if (state) this.onState(state);
      return;
    }
    if (action === "back" && wc.navigationHistory.canGoBack()) {
      this.nativeNavigationPending = this.hasCurrentStateEventScope();
      wc.navigationHistory.goBack();
    } else if (action === "forward" && wc.navigationHistory.canGoForward()) {
      this.nativeNavigationPending = this.hasCurrentStateEventScope();
      wc.navigationHistory.goForward();
    } else if (action === "reload") {
      this.nativeNavigationPending = this.hasCurrentStateEventScope();
      wc.reload();
    } else if (action === "stop") {
      wc.stop();
    }
  }

  setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
    const safe = {
      x: Math.max(0, Math.round(Number(bounds.x) || 0)),
      y: Math.max(0, Math.round(Number(bounds.y) || 0)),
      width: Math.max(0, Math.round(Number(bounds.width) || 0)),
      height: Math.max(0, Math.round(Number(bounds.height) || 0)),
    };
    this.bounds = safe;
    this.applyBounds();
  }

  private applyBounds(): void {
    // Move and clip the presentation surface immediately, even while Chromium
    // pins its capture-time viewport. A pending screenshot must not leave the
    // guest over the conversation when the window or work panel moves.
    if (this.visible) this.surface?.setBounds(this.bounds);
    if (this.view && this.visible && !this.viewportPinned && this.getWebContents()) {
      this.view.setBounds({ x: 0, y: 0, width: this.bounds.width, height: this.bounds.height });
    }
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (!this.view) return;
    if (visible) this.attach();
    else this.park();
  }

  openExternal(): void {
    const url = this.getWebContents()?.getURL();
    if (!url) return;
    const allowed = parseAllowedExternalUrl(url);
    if (allowed) {
      void shell.openExternal(allowed);
      return;
    }
    if (this.isAllowedFileUrl(url)) {
      try {
        void shell.openPath(fileURLToPath(url));
      } catch {
        // Invalid file URL — leave the preview in place.
      }
    }
  }

  dispose(): void {
    this.invalidateNavigation();
    this.clearLiveReload();
    this.detach();
    if (this.view) {
      const wc = this.getWebContents();
      this.surface?.removeChildView(this.view);
      this.view = null;
      this.surface = null;
      wc?.close();
    }
  }

  private attach(): void {
    if (!this.window || this.window.isDestroyed() || !this.surface) return;
    if (this.attachedWindow !== this.window) this.detach();
    const children = this.window.contentView.children;
    // Keep the guest above its plugin chrome, but confined to the measured hole.
    if (children.includes(this.surface) && children[children.length - 1] !== this.surface) {
      this.window.contentView.removeChildView(this.surface);
    }
    if (!this.window.contentView.children.includes(this.surface)) this.window.contentView.addChildView(this.surface);
    this.attachedWindow = this.window;
    this.surface.setVisible(true);
    this.view?.setVisible(true);
    this.applyBounds();
  }

  /** A hidden native host keeps Chromium input/capture independent of the UI. */
  private park(): void {
    if (!this.surface || !this.view || !this.getWebContents()) return;
    if (this.attachedWindow && this.attachedWindow !== this.window && !this.attachedWindow.isDestroyed()) return;
    this.detach();
    const bounds = this.view.getBounds();
    const size = { width: bounds.width || 1024, height: bounds.height || 768 };
    if (!bounds.width || !bounds.height) this.view.setBounds({ x: 0, y: 0, ...size });
    this.surface.setBounds({ x: 0, y: 0, ...size });
    this.surface.setVisible(true);
    this.view.setVisible(true);
    this.attachedWindow = this.backingHost.attach(this.surface, size);
  }

  private detach(): void {
    if (!this.surface) return;
    const owner = this.attachedWindow;
    if (owner && !owner.isDestroyed() && owner.contentView.children.includes(this.surface)) {
      owner.contentView.removeChildView(this.surface);
    }
    this.attachedWindow = null;
    this.backingHost.detach(this.surface);
  }

  /** Watch the previewed file's directory so page + asset edits re-render. */
  private watchDirForReload(dir: string): void {
    if (this.watcher && this.watchedDir === dir) return;
    this.clearLiveReload();
    try {
      this.watcher = watch(dir, { persistent: false }, () => this.scheduleReload());
      this.watchedDir = dir;
    } catch {
      this.watcher = null;
      this.watchedDir = null;
    }
  }

  private scheduleReload(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null;
      const wc = this.view?.webContents;
      if (wc && !wc.isDestroyed() && wc.getURL().startsWith("file:")) {
        wc.reloadIgnoringCache();
      }
    }, LIVE_RELOAD_DEBOUNCE_MS);
  }

  private clearLiveReload(): void {
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }
    this.watcher?.close();
    this.watcher = null;
    this.watchedDir = null;
  }

  private isAllowedFileUrl(url: string): boolean {
    const localPath = resolveBrowserLocalFile(url, this.fileRoot);
    if (!localPath) return false;
    if (this.fileRoot && isWithinRoot(localPath, this.fileRoot)) return true;
    // Preserve workspace-file links from web pages, but only let a local
    // document navigate to files outside that workspace.
    return this.view?.webContents.getURL().startsWith("file:") === true;
  }

  /**
   * Page-level affordances the panel chrome does not own: a right-click menu,
   * zoom (keyboard and menu) and find.
   *
   * The page is a guest WebContentsView, so the renderer's own context menu
   * never sees it — right-clicking a page did nothing at all. Chromium's native
   * menu is built here from the click parameters, which is the only place that
   * knows whether the pointer was over a link, an image or an editable field.
   */
  private installPageChrome(wc: WebContents): void {
    this.applyZoom(wc);
    wc.on("dom-ready", () => {
      this.applyZoom(wc);
      this.applyCosmeticFilter(wc);
    });
    wc.on("context-menu", (_event, params) => this.showPageMenu(wc, params));
    // Ctrl/Cmd + wheel, exactly like a browser: Chromium reports the gesture,
    // the pane owns the factor it has been keeping all along.
    wc.on("zoom-changed", (_event, direction) => this.zoomBy(wc, direction === "in" ? 0.1 : -0.1));
    // Pinch is a different gesture with its own limits; the panel zoom above is
    // the only one that persists per pane.
    wc.setVisualZoomLevelLimits(1, 1).catch(() => undefined);
    wc.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown") return;
      if (!(input.control || input.meta)) return;
      if (input.key === "=" || input.key === "+") {
        event.preventDefault();
        this.zoomBy(wc, 0.1);
      } else if (input.key === "-") {
        event.preventDefault();
        this.zoomBy(wc, -0.1);
      } else if (input.key === "0") {
        event.preventDefault();
        if (input.shift) void this.fitToWidth(wc);
        else this.resetZoom(wc);
      } else if (input.key.toLowerCase() === "f" && !input.shift) {
        event.preventDefault();
        void this.openFind(wc);
      }
    });
  }

  /**
   * Hide what the list marks cosmetic.
   *
   * Network blocking leaves the ad's empty box behind, which still reads as a
   * broken page; the selector list from `adblock.txt` is inserted as page CSS on
   * every document, and dropped when the switch is off.
   */
  private applyCosmeticFilter(wc: WebContents): void {
    if (wc.isDestroyed()) return;
    if (this.cosmeticKey) {
      void wc.removeInsertedCSS(this.cosmeticKey).catch(() => undefined);
      this.cosmeticKey = null;
    }
    if (!readAdblockEnabled(adblockDir())) return;
    const css = adblockCosmeticCss(adblockRules ?? reloadAdblockRules());
    if (!css) return;
    void wc
      .insertCSS(css)
      .then((key) => {
        this.cosmeticKey = key;
      })
      .catch(() => undefined);
  }

  private applyZoom(wc: WebContents): void {
    if (wc.isDestroyed()) return;
    wc.setZoomFactor(this.zoomFactor);
  }

  private zoomBy(wc: WebContents, delta: number): void {
    const next = Math.round((this.zoomFactor + delta) * 100) / 100;
    this.zoomFactor = Math.min(5, Math.max(0.25, next));
    this.applyZoom(wc);
  }

  private resetZoom(wc: WebContents): void {
    this.zoomFactor = 1;
    this.applyZoom(wc);
  }

  /**
   * Fit to width: shrink until the document's layout width fills the view.
   *
   * The previous version divided viewport by content and used that as the new
   * factor, which forgot that both numbers are measured *at the current zoom* —
   * so the result depended on what the zoom happened to be and needed repeating.
   * Both CSS widths scale with the factor, so the correction is
   * `currentFactor × viewport / content`, and it only ever shrinks: enlarging a
   * narrow article to fill a wide pane is not what "fit to width" means.
   *
   * A second pass runs after reflow (webfonts, lazy images) because the width
   * measured at `dom-ready` is often not the final one.
   */
  private async fitToWidth(wc: WebContents): Promise<void> {
    const measure = async (): Promise<{ content: number; viewport: number } | null> => {
      try {
        const value = (await wc.executeJavaScript(
          "(() => { const d = document.documentElement;" +
            " const body = document.body;" +
            " const content = Math.max(d.scrollWidth, body ? body.scrollWidth : 0);" +
            " const viewport = d.clientWidth || window.innerWidth || 0;" +
            " return { content, viewport }; })()",
          true,
        )) as unknown;
        if (
          value &&
          typeof value === "object" &&
          Number.isFinite((value as { content?: number }).content) &&
          Number.isFinite((value as { viewport?: number }).viewport)
        ) {
          const { content, viewport } = value as { content: number; viewport: number };
          if (content > 0 && viewport > 0) return { content, viewport };
        }
      } catch {
        // the page navigated away or refused evaluation
      }
      return null;
    };

    const apply = (measured: { content: number; viewport: number } | null) => {
      if (!measured) return;
      // Read the zoom the page is actually rendered at: Chromium restores a
      // per-origin zoom on navigation, so the pane's own factor can be stale and
      // the correction would then be applied to the wrong baseline (this is why
      // the old version seemed to need two attempts).
      const current = wc.isDestroyed() ? this.zoomFactor : wc.getZoomFactor();
      // Three decimals: rounding to whole percent leaves a fixed-width layout a
      // few pixels wider than the pane, i.e. a horizontal scrollbar that the
      // feature was supposed to remove.
      const rounded = Math.round(current * (measured.viewport / measured.content) * 1000) / 1000;
      const next = Math.min(1, Math.max(0.25, rounded));
      if (Math.abs(next - current) < 0.005) return;
      this.zoomFactor = next;
      if (!wc.isDestroyed()) wc.setZoomFactor(next);
    };

    const first = await measure();
    if (!first) return;
    // Already fits (or the content is narrower than the view): stay at 100%.
    if (first.content <= first.viewport + 2) {
      if (wc.getZoomFactor() < 1) {
        this.zoomFactor = 1;
        wc.setZoomFactor(1);
      }
      return;
    }
    apply(first);
    setTimeout(() => {
      if (wc.isDestroyed()) return;
      void measure().then((second) => {
        if (second && second.content > second.viewport + 2) apply(second);
      });
    }, 400);
  }

  private async openFind(wc: WebContents): Promise<void> {
    try {
      if (!this.findStylesInjected) {
        await wc.insertCSS(BROWSER_FIND_STYLE);
        this.findStylesInjected = true;
      }
      await wc.executeJavaScript(BROWSER_FIND_SCRIPT, true);
    } catch {
      /* the page navigated away or refused evaluation */
    }
  }

  private showPageMenu(wc: WebContents, params: ContextMenuParams): void {
    const chinese = app.getLocale().toLowerCase().startsWith("zh");
    const label = (zh: string, en: string) => (chinese ? zh : en);
    const items: MenuItemConstructorOptions[] = [];
    if (params.isEditable) {
      items.push(
        { role: "cut", label: label("剪切", "Cut") },
        { role: "copy", label: label("复制", "Copy") },
        { role: "paste", label: label("粘贴", "Paste") },
        { role: "selectAll", label: label("全选", "Select All") },
        { type: "separator" },
      );
    } else if (params.selectionText.trim()) {
      items.push({ role: "copy", label: label("复制", "Copy") }, { type: "separator" });
    }
    if (params.linkURL) {
      items.push(
        {
          label: label("复制链接地址", "Copy link address"),
          click: () => clipboard.writeText(params.linkURL),
        },
        {
          label: label("在默认浏览器打开", "Open in default browser"),
          click: () => void shell.openExternal(params.linkURL),
        },
        { type: "separator" },
      );
    }
    if (params.mediaType === "image" && params.hasImageContents) {
      items.push(
        { label: label("复制图片", "Copy image"), click: () => wc.copyImageAt(params.x, params.y) },
        { type: "separator" },
      );
    }
    items.push(
      { label: label("后退", "Back"), enabled: wc.navigationHistory.canGoBack(), click: () => this.action("back") },
      { label: label("前进", "Forward"), enabled: wc.navigationHistory.canGoForward(), click: () => this.action("forward") },
      { label: label("重新加载", "Reload"), click: () => this.action("reload") },
      { type: "separator" },
      { label: label("放大", "Zoom in"), accelerator: "CommandOrControl+=", click: () => this.zoomBy(wc, 0.1) },
      { label: label("缩小", "Zoom out"), accelerator: "CommandOrControl+-", click: () => this.zoomBy(wc, -0.1) },
      { label: label("实际大小", "Actual size"), click: () => this.resetZoom(wc) },
      { label: label("适合宽度", "Fit to width"), click: () => void this.fitToWidth(wc) },
      { type: "separator" },
      { label: label("在页面中查找", "Find on page"), accelerator: "CommandOrControl+F", click: () => void this.openFind(wc) },
      { type: "separator" },
      {
        label: label("拦截广告", "Block ads"),
        type: "checkbox",
        checked: readAdblockEnabled(adblockDir()),
        click: (item) => {
          writeAdblockEnabled(adblockDir(), item.checked);
          reloadAdblockRules();
          if (!wc.isDestroyed()) wc.reload();
        },
      },
      {
        label: label("编辑拦截规则…", "Edit block list…"),
        click: () => void shell.openPath(ensureAdblockList(adblockDir())),
      },
      {
        label: label(
          (() => {
            const settings = readAdblockSettings(adblockDir());
            const count = settings.listUrls?.length ?? 0;
            const when = settings.listsUpdatedAt
              ? new Date(settings.listsUpdatedAt).toLocaleDateString()
              : "从未";
            if (!count) return "更新在线规则（未配置）";
            const merged = onlineRuleCount(adblockDir());
            return `更新在线规则（${count} 个源，在线域名 ${merged} 条，上次 ${when}）`;
          })(),
          "Update online lists",
        ),
        enabled: Boolean(readAdblockSettings(adblockDir()).listUrls?.length),
        click: () => {
          void (async () => {
            const result = await refreshOnlineLists(adblockDir());
            reloadAdblockRules();
            if (!wc.isDestroyed()) wc.reload();
            await dialog.showMessageBox({
              type: result.failed.length ? "warning" : "info",
              message: `在线规则：成功 ${result.updated} 个来源`,
              detail: result.failed.length
                ? result.failed.map((item) => `${item.url}\n  ${item.error}`).join("\n")
                : "规则已重新加载，页面已刷新。",
            });
          })();
        },
      },
      {
        label: label("规则来源设置…", "Rule sources…"),
        click: () => void shell.openPath(join(adblockDir(), "adblock.json")),
      },
      {
        label: label("查看合并后的在线规则", "Show merged online rules"),
        click: () => void shell.openPath(join(adblockDir(), "adblock-online.txt")),
      },
      {
        label: label("在新标签页打开", "Open in new tab"),
        enabled: Boolean(this.onNewTab) && isAllowedHttpUrl(wc.getURL()),
        click: () => {
          const target = wc.getURL();
          if (target && this.onNewTab) this.onNewTab(target);
        },
      },
      { type: "separator" },
      {
        label: label("开发者工具", "Developer tools"),
        click: () => {
          if (!wc.isDestroyed()) wc.openDevTools({ mode: "detach" });
        },
      },
      {
        label: label("更改下载文件夹…", "Change download folder…"),
        click: () => void downloadRegistry.chooseDirectory(),
      },
      {
        label: label("打开下载目录", "Open downloads folder"),
        click: () => void shell.openPath(activeDownloadsDir()),
      },
      // Extension loading is gone on purpose: Electron hands a Manifest V3
      // blocker its declarativeNetRequest permission and then never enforces the
      // ruleset, so the only extension UI it could offer was a list of things
      // that do nothing. Ad blocking lives in the host instead.
      { type: "separator" },
      { label: label("检查元素", "Inspect element"), click: () => wc.inspectElement(params.x, params.y) },
    );
    const window = this.window ?? BrowserWindow.getFocusedWindow();
    Menu.buildFromTemplate(items).popup({ window: window ?? undefined });
  }

  private ensureView(): WebContentsView {
    if (this.view && this.getWebContents()) return this.view;
    this.detach();
    if (this.view) this.surface?.removeChildView(this.view);
    const view = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: true,
        partition: PARTITION,
      },
    });
    const surface = new View();
    surface.addChildView(view);
    surface.setVisible(this.visible);
    surface.setBounds(this.bounds);
    this.surface = surface;
    const wc = view.webContents;
    ensureAdblock(wc.session);
    downloadRegistry.attach(wc.session);
    downloadRegistry.setWindowProvider(() => this.window ?? BrowserWindow.getFocusedWindow());
    if (!this.downloadsSubscribed) {
      this.downloadsSubscribed = true;
      // Progress arrives outside the page's own events; re-publish so the chrome
      // can render a bar instead of a frozen number.
      downloadRegistry.subscribe(() => {
        const state = this.getState();
        if (state) this.onState(state);
      });
    }
    this.installPageChrome(wc);
    // A link that asks for a new window is the page's own navigation intent;
    // handing it to the OS browser drops the reader out of the panel mid-read.
    // It opens as another workspace browser tab instead.
    wc.setWindowOpenHandler(({ url }) => {
      const allowed = parseAllowedExternalUrl(url);
      if (allowed) {
        if (this.onNewTab) this.onNewTab(allowed);
        else if (this.onOpenUrl) this.onOpenUrl(allowed);
        else void shell.openExternal(allowed);
      }
      return { action: "deny" };
    });
    wc.session.setPermissionRequestHandler((_wc, _permission, callback) => {
      callback(false);
    });
    wc.on("will-navigate", (event, url) => {
      if (isAllowedHttpUrl(url)) {
        this.nativeNavigationPending = this.hasCurrentStateEventScope();
        return;
      }
      // Keep web pages inside the existing workspace-file allowance. A local
      // file page may follow links to any other existing local file.
      if (/^file:/i.test(url) && this.isAllowedFileUrl(url)) {
        this.nativeNavigationPending = this.hasCurrentStateEventScope();
        return;
      }
      event.preventDefault();
    });
    wc.on("did-navigate", (_event, url) => {
      if (!this.acceptNativeNavigation(url)) return;
      if (!/^file:/i.test(url)) return;
      try {
        this.watchDirForReload(dirname(fileURLToPath(url)));
      } catch {
        // Non-path file URL — keep the previous watcher.
      }
    });
    const push = () => {
      if (!this.hasCurrentStateEventScope()) return;
      const url = wc.getURL();
      if (this.stateUrl !== url) return;
      const state = this.getState();
      if (state) this.onState(state);
    };
    wc.on("did-start-loading", push);
    wc.on("did-stop-loading", push);
    wc.on("did-navigate", (_event, url) => {
      if (this.acceptNativeNavigation(url)) push();
    });
    wc.on("did-navigate-in-page", (_event, url, isMainFrame, processId, routingId) => {
      // Same-document navigation has no will-navigate event. Accept only the
      // active main frame's current URL, without reopening invalidated sessions.
      if (
        !isMainFrame ||
        !this.hasCurrentStateEventScope() ||
        url !== wc.getURL() ||
        processId !== wc.mainFrame.processId ||
        routingId !== wc.mainFrame.routingId
      ) return;
      this.enableStateEvents(this.navigationEpoch, url);
      push();
    });
    wc.on("page-title-updated", push);
    wc.on(
      "did-fail-load",
      (_event, _errorCode, _errorDescription, validatedUrl, isMainFrame) => {
        // Replacing a still-loading document aborts its old request. That
        // event must not consume the pending navigation to the new document.
        if (isMainFrame === false || _errorCode === -3) return;
        if (this.acceptNativeNavigation(validatedUrl)) push();
      },
    );
    this.view = view;
    if (this.visible) this.attach();
    else this.park();
    return view;
  }

  private beginManagedNavigation(): number {
    this.cancelPending?.();
    this.cancelPending = null;
    this.pendingTarget = null;
    this.loadError = null;
    const epoch = ++this.navigationEpoch;
    this.stateEventsEpoch = null;
    this.stateUrl = null;
    this.nativeNavigationPending = false;
    return epoch;
  }

  private enableStateEvents(epoch: number, url: string): void {
    if (epoch !== this.navigationEpoch) return;
    this.stateEventsEpoch = epoch;
    this.stateUrl = url;
    this.nativeNavigationPending = false;
  }

  private hasCurrentStateEventScope(): boolean {
    return this.stateEventsEpoch === this.navigationEpoch && this.stateUrl !== null;
  }

  private acceptNativeNavigation(url: string): boolean {
    if (!this.hasCurrentStateEventScope()) return false;
    if (url === this.stateUrl) {
      this.nativeNavigationPending = false;
      return true;
    }
    if (!this.nativeNavigationPending) return false;
    this.stateUrl = url;
    this.nativeNavigationPending = false;
    return true;
  }
}
