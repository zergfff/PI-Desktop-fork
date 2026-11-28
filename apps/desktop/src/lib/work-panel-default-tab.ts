import { pluginWorkPanelTab } from "./work-panel-tabs";
import type { WorkPanelTab } from "../stores/app-store";

/**
 * Which tab a fresh work panel opens with (#2573).
 *
 * The value is the tab's own resource string — `pi.browser/browser`,
 * `pi.file-manager/manager` — so the setting keeps working when a view is
 * renamed in a plugin manifest, and an empty string keeps today's behaviour:
 * the panel opens on its launcher page.
 */
const DEFAULT_TAB_KEY = "pi.workPanel.defaultTab";

export const DEFAULT_WORK_PANEL_TAB_OPTIONS: Array<{
  value: string;
  zh: string;
  en: string;
}> = [
  { value: "", zh: "不自动打开", en: "Launcher" },
  { value: "pi.browser/browser", zh: "浏览器", en: "Browser" },
  { value: "pi.file-manager/manager", zh: "文件管理器", en: "File manager" },
];

export function readDefaultWorkPanelTab(): string {
  try {
    const value = window.localStorage.getItem(DEFAULT_TAB_KEY) ?? "";
    return DEFAULT_WORK_PANEL_TAB_OPTIONS.some((option) => option.value === value)
      ? value
      : "";
  } catch {
    return "";
  }
}

export function writeDefaultWorkPanelTab(value: string): void {
  try {
    if (!value) window.localStorage.removeItem(DEFAULT_TAB_KEY);
    else window.localStorage.setItem(DEFAULT_TAB_KEY, value);
  } catch {
    /* 存不下就只在本次运行有效 */
  }
}

/** The tab to open, or null when the launcher page should stay. */
export function defaultWorkPanelTab(value: string): WorkPanelTab | null {
  const separator = value.indexOf("/");
  if (separator <= 0) return null;
  const pluginId = value.slice(0, separator);
  const viewId = value.slice(separator + 1);
  if (!pluginId || !viewId) return null;
  return pluginWorkPanelTab(pluginId, viewId);
}
