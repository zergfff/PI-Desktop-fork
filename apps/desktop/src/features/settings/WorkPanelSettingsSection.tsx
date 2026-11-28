import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  DEFAULT_WORK_PANEL_TAB_OPTIONS,
  readDefaultWorkPanelTab,
  writeDefaultWorkPanelTab,
} from "../../lib/work-panel-default-tab";
import { SettingsCard, SettingsRow } from "./primitives";

/**
 * Which tab a new work panel starts on (#2573).
 *
 * Upstream always opened the launcher page; users who live in the browser or the
 * file tree had to click through it on every new session.
 */
export function WorkPanelSettingsSection() {
  const { i18n } = useTranslation();
  const zh = /^zh/i.test(i18n.resolvedLanguage ?? i18n.language ?? "en");
  const [value, setValue] = useState(() => readDefaultWorkPanelTab());

  return (
    <SettingsCard title={zh ? "工作面板" : "Work panel"}>
      <SettingsRow
        title={zh ? "新会话默认打开" : "Open on a new session"}
        description={zh
          ? "打开工作面板时直接进入这个标签，不再停在启动页。"
          : "The panel opens straight into this tab instead of its launcher."}
      >
        <select
          className="settings-select"
          data-testid="work-panel-default-tab"
          value={value}
          onChange={(event) => {
            const next = event.target.value;
            setValue(next);
            writeDefaultWorkPanelTab(next);
          }}
        >
          {DEFAULT_WORK_PANEL_TAB_OPTIONS.map((option) => (
            <option key={option.value || "none"} value={option.value}>
              {zh ? option.zh : option.en}
            </option>
          ))}
        </select>
      </SettingsRow>
    </SettingsCard>
  );
}
