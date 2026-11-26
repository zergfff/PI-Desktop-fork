import { app, BrowserWindow, crashReporter, Menu, safeStorage } from "electron";
import { bootMark } from "../boot-trace";
import { createScheduledRunner } from "../runtime/scheduled-runner";
import { onConfirmedQuit } from "./confirmed-quit";
import {
  APP_NAME,
  APP_VERSION,
  ErrorCodes,
  IPC,
  type AppMenuCommand,
  type CloseBehavior,
  type KeybindingOverrides,
  type NativeMenuAction,
} from "@pi-desktop/shared";
import { installApplicationMenu } from "../application-menu";
import { installGenUiProtocol } from "../gen-ui-protocol";
import { installPluginAssetProtocol } from "../plugin-asset-protocol";
import { installPluginRendererProtocol } from "../plugin-renderer-protocol";
import { registerPluginSchemes } from "../plugin-schemes";
import {
  resolveStartupAnimation,
  type ResolvedStartupAnimation,
} from "../startup-animation";
import { installStartupAnimationProtocol } from "../startup-animation-protocol";
import { applyNetworkProxyFromAppSettings } from "../network-proxy";
import { readCloseBehavior } from "../window-preferences";
import { createAgentHostBridge, type AgentHostBridge } from "../agent-host-bridge";
import { createBackendRouter, type BackendRouter } from "../remote/backend-router";
import { createRemoteHostsBoot, setActiveRemoteHostsBoot } from "./remote-hosts";
import {
  createMcpControlController,
  McpControlServer,
  mcpControlRendererEvent,
  type McpControlController,
  type McpControlInvokeInput,
} from "../mcp-control";
import type { ModelsDevCatalog } from "../models-dev-catalog";
import type { AppUpdaterController } from "../updater";
import type { HostProcess } from "../host-process";
import type { Logger } from "../logger";
import type { PluginRuntime } from "../plugin-runtime";
import { runSessionListProbe } from "../session-list-probe";
import {
  ensureCrashDumpsDirectory,
  reportPreviousCrashDumps,
} from "../crash-report";

type IpcInvoker = (
  channel: string,
  args?: readonly unknown[],
) => Promise<unknown>;

/**
 * The remote-host modules pass their log `data` as a structured object (e.g.
 * `{hostKey, error}`); a bare `String(data)` prints `[object Object]` and
 * loses the context. Errors keep their `String(error)` shape ("Error: ..."),
 * plain strings pass through, everything else JSON-stringifies.
 */
function formatRemoteLogData(data: unknown): string | undefined {
  if (data === undefined) return undefined;
  if (typeof data === "string") return data;
  if (data instanceof Error) return String(data);
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

export type StartupState = {
  applicationBooted: boolean;
  closeBehavior: CloseBehavior;
  /**
   * Boot animation this launch resolved, which the `pi-startup:` handler reads
   * per request. Null — the default and every failure — keeps the brand splash.
   */
  startupAnimation: ResolvedStartupAnimation | null;
  agentHostBridge: AgentHostBridge | null;
  backendRouter: BackendRouter | null;
  desktopControl: McpControlController | null;
  mcpControl: McpControlServer | null;
};

export type StartupDependencies = {
  hasSingleInstanceLock: boolean;
  state: StartupState;
  dataDir: string;
  logger: Logger;
  updater: AppUpdaterController;
  modelsDevCatalog: ModelsDevCatalog;
  plugins: PluginRuntime;
  /**
   * Shared busy check from `runtime/session-coordination.ts`. The queue must
   * stay held while a turn's announcement is still running, so this cannot be
   * be derived from the startup state alone.
   */
  isSessionBusy: (sessionId: string) => boolean;
  getHost: () => HostProcess | null;
  getMainWindow: () => BrowserWindow | null;
  sendToRenderer: (channel: string, payload: unknown) => void;
  applyDevelopmentBranding: () => void;
  createTray: () => void;
  dispatchApplicationMenuCommand: (command: AppMenuCommand) => void;
  dispatchNativeMenuAction: (action: NativeMenuAction) => void;
  prewarmPluginLauncher: () => void;
  registerIpc: () => IpcInvoker;
  bootBackends: (options?: { afterHost?: (stored: unknown) => Promise<void> }) => Promise<void>;
  planUiProbe: { install: () => void };
  applyApplicationMenuSettings: (settings?: {
    language?: unknown;
    theme?: unknown;
    keybindings?: unknown;
    developerMode?: unknown;
    fontScale?: unknown;
  } | null) => void;
  applyDeveloperMode: (settings?: { developerMode?: unknown } | null) => void;
  applyMacosWindowTranslucency: (
    settings?: { macosWindowTranslucency?: unknown } | null,
  ) => void;
  applyPreventScreenSleep: (settings?: { preventScreenSleep?: unknown } | null) => void;
  applyKeepAwakeWhileRunning: (settings?: { keepAwakeWhileRunning?: unknown } | null) => void;
  applyPluginLauncherShortcut: (keybindings?: KeybindingOverrides) => void;
  applyToggleWindowShortcut: (keybindings?: KeybindingOverrides) => void;
  ensureWindow: () => Promise<boolean>;
  bootHostStatus: (bootError: unknown) => unknown;
  flushPendingApplicationMenuCommands: () => void;
  getSidecar?: () => unknown;
  invokeSessionCollaboration?: (input: McpControlInvokeInput) => Promise<unknown>;
  onSessionQueueChange?: () => void;
};

/**
 * Register the Electron-ready boot sequence. The sequence remains deliberately
 * ordered here, while its mutable process resources are supplied by the main
 * composition root through `StartupState` and dependency callbacks.
 */
export function registerApplicationStartup(deps: StartupDependencies): void {
  // Electron only accepts scheme privileges before the app is ready, and this
  // runs from the composition root, before the `whenReady` promise can settle.
  registerPluginSchemes();
  // Crashpad ships with Electron, so the reporter needs no native dependency.
  // Dumps stay local (`uploadToServer: false`) under the installation data
  // directory so a `PI_DESKTOP_DATA_DIR` profile does not share them. Started
  // before `ready`, so no crash can happen ahead of the handler. A failure
  // here is a warning: it never blocks boot.
  try {
    app.setPath("crashDumps", ensureCrashDumpsDirectory(deps.dataDir));
    crashReporter.start({ uploadToServer: false, productName: APP_NAME });
  } catch (error) {
    deps.logger.app("diagnostics", "warn", "crash reporter failed to start", {
      event: "crashReporterStartFailed",
      data: String(error),
    });
  }


  void app.whenReady().then(async () => {
    const {
      hasSingleInstanceLock,
      state,
      dataDir,
      logger,
      updater,
      modelsDevCatalog,
      plugins,
      isSessionBusy,
      getHost,
      getMainWindow,
      sendToRenderer,
      applyDevelopmentBranding,
      createTray,
      dispatchApplicationMenuCommand,
      dispatchNativeMenuAction,
      prewarmPluginLauncher,
      registerIpc,
      bootBackends,
      planUiProbe,
      applyApplicationMenuSettings,
      applyDeveloperMode,
      applyMacosWindowTranslucency,
      applyPreventScreenSleep,
      applyKeepAwakeWhileRunning,
      applyPluginLauncherShortcut,
      applyToggleWindowShortcut,
      ensureWindow,
      bootHostStatus,
      flushPendingApplicationMenuCommands,
    } = deps;

    // A launch that lost the single-instance lock is already quitting. Never
    // create a window, a tray, or a child process on top of the running app.
    if (!hasSingleInstanceLock) return;
    applyDevelopmentBranding();

    // A Chromium-process crash from a previous run left a minidump, and nothing
    // else would ever mention it. Report one durable line per new dump set,
    // classified by process type, then advance the marker. Reporting is
    // diagnostics: a failure warns and is dropped rather than holding up the
    // first window.
    reportPreviousCrashDumps({
      dataDir,
      crashDumpsDirectory: app.getPath("crashDumps"),
      logger,
    });

    // Serve declared theme assets before the renderer can ask for one; the
    // scheme itself was reserved in `registerApplicationStartup`.
    installPluginAssetProtocol((pluginId, assetPath) =>
      plugins.resolveThemeAsset(pluginId, assetPath),
    );
    // Serve renderer entry modules the same way — the current load of a
    // plugin that declared `manifest.renderer` and holds `renderer.extension`.
    installPluginRendererProtocol((pluginId, generation, requestPath) =>
      plugins.resolveRendererSource(pluginId, generation, requestPath),
    );
    installGenUiProtocol({ getHost });
    // The animation itself is resolved later, once settings are readable; the
    // handler is installed here so it is already in place when the first
    // window's `<video>` asks for the bytes.
    installStartupAnimationProtocol(() => state.startupAnimation);
    // Load the close-behavior preference before the first window exists: the
    // close handler reads `closeBehavior` synchronously, and a window created
    // while it still held the "ask" default would prompt a user who already
    // chose.
    const storedBehavior = readCloseBehavior(dataDir);
    if (storedBehavior) state.closeBehavior = storedBehavior;
    createTray();
    app.setAboutPanelOptions({
      applicationName: APP_NAME,
      applicationVersion: APP_VERSION,
      version: APP_VERSION,
    });
    installApplicationMenu({
      locale: app.getLocale(),
      dispatch: dispatchApplicationMenuCommand,
      dispatchNative: dispatchNativeMenuAction,
    });
    const invokeIpc = registerIpc();
    bootMark("ipc registered");
    // The backend router is the single seam that forwards a renderer IPC call
    // to a paired remote host; with no remote session registered it returns
    // ROUTE_LOCAL and the local handler runs unchanged. Assigned before the
    // first window can issue IPC. Remote host connections register their
    // sessions here once paired (later stages).
    state.backendRouter = createBackendRouter({
      log: (level, message, data) =>
        logger.app("runtime", level, message, { data: formatRemoteLogData(data) }),
    });
    // Every paired remote `pi-host` opens against the router this boot just
    // created. An empty registry (default install with no user pairing) makes
    // this a full no-op — nothing connects, no backend registers, every
    // renderer call keeps hitting the local handler byte-for-byte.
    const remoteHostsBoot = createRemoteHostsBoot({
      dataDir,
      encryption: {
        // Electron's safeStorage exposes `isEncryptionAvailable`; the port
        // keeps the shorter `isAvailable` name so a Node-side test can drop
        // in a fake without pulling in the Electron type.
        isAvailable: () => safeStorage.isEncryptionAvailable(),
        encryptString: (plain) => safeStorage.encryptString(plain),
        decryptString: (buffer) => safeStorage.decryptString(buffer),
      },
      router: state.backendRouter,
      emit: sendToRenderer,
      getLocalHost: getHost,
      clientInfo: { name: APP_NAME, version: APP_VERSION },
      log: (level, message, data) =>
        logger.app("runtime", level, message, { data: formatRemoteLogData(data) }),
    });
    setActiveRemoteHostsBoot(remoteHostsBoot);
    // Remote hosts are not shipped in this build: the Settings page and the
    // "remote" project source were removed, so no host can be paired from the
    // UI. Opening the registry would only dial SSH for pairings left over from
    // an earlier version — work no screen can reach. Keep the wiring (session
    // routing still asks the router, which answers ROUTE_LOCAL) and skip the
    // contact.
    const REMOTE_HOSTS_ENABLED = false;
    if (REMOTE_HOSTS_ENABLED) {
      void remoteHostsBoot.open().then((opened) => {
        if (opened > 0) {
          logger.app("runtime", "info", "remote hosts connected", { data: String(opened) });
        }
      }).catch((error: unknown) => {
        logger.app("runtime", "warn", "remote host boot failed", { data: String(error) });
      });
    }
    state.agentHostBridge = createAgentHostBridge({
      invoke: invokeIpc,
      channels: IPC.invoke,
      getHost,
      isSessionBusy,
      onQueueChange: (event) => {
        sendToRenderer(IPC.event.agentQueueChanged, event);
        deps.onSessionQueueChange?.();
      },
      log: (level, message, data) => logger.app("runtime", level, message, { data }),
    });
    const control = createMcpControlController({
      invoke: invokeIpc,
      channels: IPC.invoke,
      invokeSessionCollaboration: deps.invokeSessionCollaboration,
      onOperationComplete: async (operation, result, args, source) => {
        const event = mcpControlRendererEvent(operation, result, args, source);
        if (event) sendToRenderer(IPC.event.sessionsChanged, event);
      },
    });
    state.desktopControl = control;
    plugins.setServices({ desktopControl: control });
    // Load the bundled model snapshot at startup without blocking the first
    // window. Startup neither fetches nor rewrites the catalog; the snapshot
    // is refreshed on demand from Settings (see models-dev-catalog / the
    // 13-model-catalog-and-selection spec).
    void modelsDevCatalog.ensureLoaded();
    // Preferences for the boot animation, when settings were readable. An
    // unreadable backend leaves this null and discovery falls back to the
    // defaults, so a launch with no host still plays what the user dropped in.
    let storedStartupAnimationSettings: { startupAnimation?: unknown } | null = null;

    /**
     * Open the shell as soon as host-core answers.
     *
     * Everything after that point in `bootBackends` — the agent sidecar, the
     * restored plugins, MCP registration, the plan drain — is either rendered
     * later or not at all, and the renderer already re-reads plugin surfaces
     * when the `pluginChanged` event arrives. Waiting for all of it before the
     * first window put the whole tail of boot on the user's "it started"
     * clock; here the shell loads its page while that work continues behind
     * it. The splash still waits for `hostStatus`, so nothing is presented as
     * ready before it is.
     */
    let shellOpened = false;
    const openShell = async (stored: unknown): Promise<void> => {
      const settings = stored as {
        language?: unknown;
        theme?: unknown;
        keybindings?: unknown;
        developerMode?: unknown;
        fontScale?: unknown;
        macosWindowTranslucency?: unknown;
        startupAnimation?: unknown;
        preventScreenSleep?: unknown;
        keepAwakeWhileRunning?: unknown;
      } | null;
      if (settings) {
        applyApplicationMenuSettings(settings);
        applyDeveloperMode(settings);
        applyMacosWindowTranslucency(settings);
        applyPreventScreenSleep(settings);
        applyKeepAwakeWhileRunning(settings);
        storedStartupAnimationSettings = settings;
      } else {
        // Keep the OS-locale menu until settings can be read again, while
        // retaining the historical default launcher fallback for this failure.
        applyPluginLauncherShortcut();
        applyToggleWindowShortcut();
      }
      // Resolve the boot animation before the window exists: the descriptor is
      // a renderer creation argument, so it has to be known by
      // `new BrowserWindow`. The capture rig compares deterministic frames, so
      // a user's animation in front of them would break every scene; it is
      // skipped outright. The E2E harnesses need no guard — each runs against
      // a throwaway `PI_DESKTOP_DATA_DIR`, which has no `startup/` directory.
      if (process.env.PI_DESKTOP_CAPTURE !== "1") {
        state.startupAnimation = await resolveStartupAnimation({
          dataDir,
          settings: storedStartupAnimationSettings,
        });
        if (state.startupAnimation) {
          logger.app("lifecycle", "info", "startup animation resolved", {
            data: JSON.stringify({
              fileName: state.startupAnimation.descriptor.fileName,
              byteLength: state.startupAnimation.descriptor.byteLength,
            }),
          });
        }
      }
      bootMark("settings and boot animation resolved");
      await ensureWindow();
      shellOpened = true;
      bootMark("window opened");
      // The retained launcher only has to be warm before the first
      // Option+Space, not before the first window.
      prewarmPluginLauncher();
    };

    let bootError: unknown = null;
    try {
      await bootBackends({ afterHost: openShell });
    } catch (error) {
      bootError = error;
      logger.app("runtime", "error", "backend boot failed", {
        code: ErrorCodes.HOST_UNAVAILABLE,
        data: String(error),
      });
    }
    bootMark(bootError ? "backends failed" : "backends booted");
    if (!shellOpened) {
      // A backend that never answered still owes the user a window.
      await openShell(null);
    }
    if (process.env.PI_DESKTOP_MCP_CONTROL === "1") {
      try {
        state.mcpControl = new McpControlServer({
          dataDir,
          invoke: invokeIpc,
          channels: IPC.invoke,
          version: APP_VERSION,
          port: process.env.PI_DESKTOP_MCP_PORT
            ? Number(process.env.PI_DESKTOP_MCP_PORT)
            : undefined,
          controller: state.desktopControl ?? undefined,
          log: (level, message, data) => logger.app("runtime", level, message, { data }),
        });
        await state.mcpControl.start();
      } catch (error) {
        logger.app("runtime", "warn", "MCP control server failed to start", {
          data: String(error),
        });
        state.mcpControl = null;
      }
    }
    // GitHub discovery is delayed and time-bounded. Never start it before the
    // first window exists: a hung feed used to sit in "checking" for ~60s and
    // compete with boot for the net stack.
    // Adopt legacy NSIS baselines before the delayed feed check can start. The
    // filesystem work runs after the first window exists and never blocks boot.
    void updater
      .reclaimRelocatedUpdateCache()
      .finally(() => updater.startAutoCheck());
    // createWindow awaits the initial load (loadFile resolves on
    // did-finish-load), so the page is up; give React a beat to mount its
    // event subscriptions before pushing the boot outcome.
    setTimeout(() => {
      bootMark("hostStatus sent");
      sendToRenderer(IPC.event.hostStatus, bootHostStatus(bootError));
      state.applicationBooted = true;
      flushPendingApplicationMenuCommands();
    }, 300);

    // Headless boot probe for automated e2e (scripts/e2e-electron-boot.mjs):
    // verifies the preload bridge, IPC round-trips, and Ctrl+R guard, then quits.
    if (process.env.PI_DESKTOP_BOOT_PROBE === "1") {
      setTimeout(() => {
        void (async () => {
          try {
            const window = getMainWindow();
            const probe = await window!.webContents.executeJavaScript(
              `(async () => {
               const api = window.piDesktop;
               if (!api || typeof api.invoke !== "function") {
                 return { ok: false, reason: "preload api missing" };
               }
               const version = await api.invoke(api.channels.invoke.appGetVersion);
               const windowState =
                 api.platform === "darwin"
                   ? null
                   : await api.invoke(api.channels.invoke.windowControl, {
                       action: "getState",
                     });
               // Project removal channel: a path that cannot have a durable row
               // still has to survive preload -> main -> host-core and come back
               // as the documented idempotent no-op.
               const projectRemove = await api.invoke(
                 api.channels.invoke.projectRemove,
                 { path: "pi-desktop-boot-probe-unknown-project" },
               );
               return {
                 ok: version?.ok === true,
                 version: version?.data?.version,
                 hostProtocol: version?.data?.hostProtocolVersion,
                 platform: api.platform,
                 maximized: windowState?.data?.maximized ?? null,
                 projectRemove: {
                   ok: projectRemove?.ok === true,
                   removed: projectRemove?.data?.removed ?? null,
                   sessionsRemoved: projectRemove?.data?.sessionsRemoved ?? null,
                 },
               };
             })()`,
            );
            let ctrlRPrevented = false;
            const observeCtrlR = (
              event: Electron.Event,
              input: Electron.Input,
            ) => {
              if (
                input.type === "keyDown" &&
                input.code === "KeyR" &&
                input.control &&
                !input.meta &&
                !input.alt &&
                !input.shift
              ) {
                ctrlRPrevented = event.defaultPrevented;
              }
            };
            window!.webContents.on("before-input-event", observeCtrlR);
            try {
              window!.webContents.sendInputEvent({
                type: "keyDown",
                keyCode: "R",
                modifiers: ["control"],
              });
              window!.webContents.sendInputEvent({
                type: "keyUp",
                keyCode: "R",
                modifiers: ["control"],
              });
              await new Promise((resolve) => setTimeout(resolve, 100));
            } finally {
              window!.webContents.removeListener(
                "before-input-event",
                observeCtrlR,
              );
            }
            probe.ctrlRBlocked = ctrlRPrevented;
            probe.appName = app.getName();
            probe.menuCount = Menu.getApplicationMenu()?.items.length ?? 0;
            const probeHost = getHost();
            if (!probeHost || !window) throw new Error("session-list probe requires a healthy desktop");
            probe.sessionList = await runSessionListProbe({
              dataDir,
              host: probeHost,
              window,
              catalog: modelsDevCatalog,
            });
            console.log("BOOT_PROBE", JSON.stringify(probe));
          } catch (error) {
            console.log(
              "BOOT_PROBE",
              JSON.stringify({ ok: false, reason: String(error) }),
            );
          } finally {
            app.quit();
          }
        })();
      }, 800);
    }
    // Supervision probe (scripts/e2e-supervision.mjs): SIGKILL our own
    // host-core child, then assert the supervisor brings a fresh one back
    // that answers RPCs. Deterministic crash-recovery e2e without pid hunts.
    if (process.env.PI_DESKTOP_SUPERVISION_PROBE === "1") {
      const initialHost = getHost();
      setTimeout(() => {
        logger.app("runtime", "info", "supervision probe: killing host-core");
        (initialHost as any)?.child?.kill("SIGKILL");
      }, 1500);
      const startedAt = Date.now();
      const poll = setInterval(() => {
        void (async () => {
          if (Date.now() - startedAt > 30_000) {
            clearInterval(poll);
            console.log(
              "SUPERVISION_PROBE",
              JSON.stringify({ ok: false, reason: "timeout" }),
            );
            app.quit();
            return;
          }
          const currentHost = getHost();
          if (!currentHost || currentHost === initialHost) return;
          try {
            const health = await currentHost.call<{ ok: boolean }>("app.health");
            clearInterval(poll);
            console.log(
              "SUPERVISION_PROBE",
              JSON.stringify({ ok: health.ok === true, restarted: true }),
            );
            app.quit();
          } catch {
            // restart still settling; keep polling
          }
        })();
      }, 500);
    }
  });
}
