import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { IPC } from "@pi-desktop/shared";
import { Button } from "../../components/ui";
import { SettingsCard, SettingsRow } from "./primitives";

type PaletteCommand = {
  id: string;
  title: string;
  category?: string;
  source?: string;
  pluginId?: string;
};

/** Raw preload bridge: the palette channels are not on the typed facade. */
const bridge = (window as unknown as {
  piDesktop: { invoke: <T>(channel: string, ...args: unknown[]) => Promise<T> };
}).piDesktop;

const call = async <T,>(channel: string, ...args: unknown[]): Promise<T> => {
  const response = await bridge.invoke<{ ok?: boolean; data?: T } | T>(channel, ...args);
  if (response && typeof response === "object" && "ok" in (response as Record<string, unknown>)) {
    return (response as { data?: T }).data as T;
  }
  return response as T;
};

/**
 * Plugin settings that used to be reachable only through the command palette.
 *
 * A plugin that ships a settings page already registers a command for it
 * (`…openSettings`); listing those commands here gives the settings dialog one
 * place to find every plugin's options instead of asking the user to know that
 * a palette exists.
 */
export function PluginSettingsSection() {
  const { i18n } = useTranslation();
  const zh = /^zh/i.test(i18n.resolvedLanguage ?? i18n.language ?? "en");
  const [entries, setEntries] = useState<PaletteCommand[] | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await call<{ commands?: PaletteCommand[] }>(
        IPC.invoke.commandPaletteSearch,
        "",
      );
      const commands = result?.commands ?? [];
      setEntries(
        commands.filter(
          (command) =>
            command.source === "plugin" &&
            /(^|[./])openSettings$/i.test(command.id),
        ),
      );
    } catch {
      setEntries([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <SettingsCard title={zh ? "插件设置" : "Plugin settings"}>
      {entries && entries.length === 0 && (
        <SettingsRow
          title={zh ? "没有可配置的插件" : "No configurable plugins"}
          description={zh
            ? "插件只有在自带设置页时才会出现在这里。"
            : "A plugin appears here only when it ships a settings page."}
        >
          <span />
        </SettingsRow>
      )}
      {entries === null && (
        <SettingsRow title={zh ? "正在读取…" : "Loading…"}>
          <span />
        </SettingsRow>
      )}
      {(entries ?? []).map((entry) => (
        <SettingsRow
          key={entry.id}
          title={entry.title}
          description={
            (entry.category || entry.pluginId || "") +
            (zh ? " · 会打开工作面板里的设置页" : " · opens its page in the work panel")
          }
        >
          <Button
            variant="secondary"
            data-testid={`plugin-settings-${entry.id}`}
            onClick={() => {
              void call(IPC.invoke.commandPaletteExecute, entry.id).catch(() => {});
            }}
          >
            {zh ? "打开设置" : "Open"}
          </Button>
        </SettingsRow>
      ))}
    </SettingsCard>
  );
}
