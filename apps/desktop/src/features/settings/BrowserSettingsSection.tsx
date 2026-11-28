import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { IPC } from "@pi-desktop/shared";
import { Button } from "../../components/ui";
import { SettingsCard, SettingsRow } from "./primitives";

type BrowserState = { enabled: boolean; downloadsDir: string };

/** Raw preload bridge: these channels are newer than the typed api facade. */
const bridge = (window as unknown as {
  piDesktop: { invoke: <T>(channel: string, ...args: unknown[]) => Promise<T> };
}).piDesktop;

/** Main answers invoke channels with an { ok, data } envelope; unwrap it. */
const call = async <T,>(channel: string, ...args: unknown[]): Promise<T> => {
  const response = await bridge.invoke<{ ok?: boolean; data?: T } | T>(channel, ...args);
  if (response && typeof response === "object" && "ok" in (response as Record<string, unknown>)) {
    return (response as { data?: T }).data as T;
  }
  return response as T;
};

/**
 * Browser behaviour that used to hide in the browser's own page context menu.
 *
 * The context menu is for whatever is under the pointer; the download folder and
 * the block list describe the whole browser, so they belong next to the other
 * machine-level settings.
 */
export function BrowserSettingsSection() {
  const { i18n } = useTranslation();
  const zh = /^zh/i.test(i18n.resolvedLanguage ?? i18n.language ?? "en");
  const [state, setState] = useState<BrowserState | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setState(await call<BrowserState>(IPC.invoke.browserSettingsGet));
    } catch {
      setState(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async () => {
    if (!state || busy) return;
    setBusy(true);
    try {
      const next = await call<BrowserState>(IPC.invoke.browserSettingsSet, {
        enabled: !state.enabled,
      });
      setState((current) => (current ? { ...current, ...next } : next));
    } finally {
      setBusy(false);
    }
  };

  const chooseFolder = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await call<{ directory: string | null }>(
        IPC.invoke.browserDownloadsFolderChoose,
      );
      if (result?.directory) setState((current) => (current ? { ...current, downloadsDir: result.directory! } : current));
      else await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsCard title={zh ? "浏览器" : "Browser"}>
      <SettingsRow
        title={zh ? "广告拦截" : "Block ads"}
        description={zh
          ? "宿主进程在请求发出前拦截；开关立刻生效，已打开的页面需要刷新。"
          : "The host blocks matching requests before they are sent. Takes effect immediately; open pages need a reload."}
      >
        <button
          type="button"
          className="settings-inline-toggle"
          data-testid="browser-adblock-toggle"
          data-enabled={state?.enabled === true ? "true" : "false"}
          role="switch"
          aria-checked={state?.enabled === true}
          disabled={!state || busy}
          onClick={() => void toggle()}
        >
          {state?.enabled ? (zh ? "已开启" : "On") : (zh ? "已关闭" : "Off")}
        </button>
      </SettingsRow>

      <SettingsRow
        title={zh ? "下载文件夹" : "Download folder"}
        description={state?.downloadsDir ?? (zh ? "正在读取…" : "Loading…")}
      >
        <div className="settings-inline-actions">
          <Button variant="secondary" onClick={() => void chooseFolder()} disabled={busy}>
            {zh ? "更改…" : "Change…"}
          </Button>
          <Button
            variant="ghost"
            onClick={() => void call(IPC.invoke.browserDownloadsFolderOpen).catch(() => {})}
          >
            {zh ? "打开" : "Open"}
          </Button>
        </div>
      </SettingsRow>

      <SettingsRow
        title={zh ? "拦截规则" : "Block list"}
        description={zh
          ? "纯文本规则文件，改完保存后由插件重新加载。"
          : "A plain-text rules file; saving it reloads the list."}
      >
        <Button
          variant="secondary"
          onClick={() => void call(IPC.invoke.browserBlockListOpen).catch(() => {})}
        >
          {zh ? "编辑规则…" : "Edit rules…"}
        </Button>
      </SettingsRow>
    </SettingsCard>
  );
}
