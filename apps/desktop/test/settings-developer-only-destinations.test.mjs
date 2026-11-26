/**
 * Developer-only settings destinations are retained in development builds
 * but omitted from packaged builds. Cloud sync and Remote Hosts are
 * Experimental destinations available in every build. Navigation, search,
 * and stale-page handling must honor the same visibility rules.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  DEFAULT_SETTINGS_TAB,
  SETTINGS_NAV,
  isSettingsDestinationHidden,
  resolveSettingsTab,
  searchSettings,
  visibleSettingsNav,
} from "../src/lib/settings-search.ts";

// The rail lives in SettingsPage; destination bodies in SettingsDestinationContent.
const settingsPage =
  readFileSync(new URL("../src/features/settings/SettingsPage.tsx", import.meta.url), "utf8") +
  readFileSync(
    new URL("../src/features/settings/SettingsDestinationContent.tsx", import.meta.url),
    "utf8",
  );
const searchDialog = readFileSync(
  new URL("../src/components/SearchDialog.tsx", import.meta.url),
  "utf8",
);
const composer = readFileSync(
  new URL("../src/components/Composer.tsx", import.meta.url),
  "utf8",
);
const composerToolbar = readFileSync(
  new URL("../src/features/chat/composer/ComposerToolbar.tsx", import.meta.url),
  "utf8",
);

const liveVoiceSettings = readFileSync(
  new URL(
    "../src/features/settings/voice/LiveVoiceSettings.tsx",
    import.meta.url,
  ),
  "utf8",
);
const settingsPrimitives = readFileSync(
  new URL("../src/features/settings/primitives.tsx", import.meta.url),
  "utf8",
);

const identity = (key) => key;
const developerOnlyIds = SETTINGS_NAV.filter(entry => entry.developerOnly === true).map(entry => entry.id);

test("Live Voice is omitted from packaged builds", () => {
  for (const developerMode of [false, true]) {
    // Fork build: the voice destination exists for development work only.
    assert.equal(visibleSettingsNav(developerMode, false)
      .some((entry) => entry.id === "voice"), false);
    assert.equal(isSettingsDestinationHidden("voice", developerMode, false), true);
    for (const query of ["liveVoice.title", "liveVoice.enable", "liveVoice.provider"]) {
      assert.equal(searchSettings(query, identity, { developerMode, includeDevelopmentOnly: false })
        .some((hit) => hit.tab === "voice"), false);
    }
    // Development builds keep it, so the surface itself stays testable.
    assert.equal(visibleSettingsNav(developerMode, true)
      .some((entry) => entry.id === "voice"), true);
  }
  assert.equal(
    SETTINGS_NAV.find((entry) => entry.id === "voice")?.developmentOnly,
    true,
  );
});

test("Cloud sync is omitted from packaged builds", () => {
  for (const developerMode of [false, true]) {
    // Fork build: cloud sync stays in the source tree but has no packaged
    // entry point, so no screen can start a sync.
    assert.equal(visibleSettingsNav(developerMode, false)
      .some((entry) => entry.id === "sync"), false);
    assert.equal(isSettingsDestinationHidden("sync", developerMode, false), true);
    for (const query of [
      "configSync.experimental",
      "configSync.connectionTitle",
      "configSync.endpoint",
      "configSync.syncNow",
    ]) {
      assert.equal(searchSettings(query, identity, {
        developerMode,
        includeDevelopmentOnly: false,
      }).some((hit) => hit.tab === "sync"), false);
    }
    assert.equal(visibleSettingsNav(developerMode, true)
      .some((entry) => entry.id === "sync"), true);
  }
  assert.equal(SETTINGS_NAV.find((entry) => entry.id === "sync")?.developmentOnly, true);
});

test("Remote Hosts is omitted from packaged builds", () => {
  for (const developerMode of [false, true]) {
    assert.equal(visibleSettingsNav(developerMode, false)
      .some((entry) => entry.id === "remoteHosts"), false);
    assert.equal(isSettingsDestinationHidden("remoteHosts", developerMode, false), true);
    assert.equal(visibleSettingsNav(developerMode, true)
      .some((entry) => entry.id === "remoteHosts"), true);
  }
  assert.equal(
    SETTINGS_NAV.find((entry) => entry.id === "remoteHosts")?.developmentOnly,
    true,
  );
});

test("developer mode retains the developer-only destinations in development", () => {
  const off = visibleSettingsNav(false).map((entry) => entry.id);
  const on = visibleSettingsNav(true).map((entry) => entry.id);

  for (const id of developerOnlyIds) {
    assert.equal(off.includes(id), false);
    assert.equal(on.includes(id), true);
  }
  assert.deepEqual(off, on.filter((id) => !developerOnlyIds.includes(id)));
  assert.deepEqual(
    SETTINGS_NAV.filter((entry) => entry.developerOnly === true).map((entry) => entry.id),
    developerOnlyIds,
  );
  assert.ok(
    SETTINGS_NAV.filter((entry) => entry.developerOnly === true)
      .every((entry) => entry.experimentalBadgeKey),
  );
  // Cloud sync remains in development builds (default includeDevelopmentOnly).
  assert.equal(off.includes("sync"), true);
});

test("packaged builds hide developer-only destinations and retain Experimental surfaces", () => {
  const packaged = visibleSettingsNav(true, false).map((entry) => entry.id);
  for (const id of developerOnlyIds) {
    assert.equal(packaged.includes(id), false);
    assert.equal(isSettingsDestinationHidden(id, true, false), true);
  }
  // Fork build: voice, cloud sync and remote hosts are packaged-out, so a
  // packaged rail carries none of them.
  for (const id of ["voice", "sync", "remoteHosts"]) {
    assert.equal(packaged.includes(id), false);
    assert.equal(isSettingsDestinationHidden(id, true, false), true);
    assert.equal(isSettingsDestinationHidden(id, false, false), true);
  }
  assert.equal(isSettingsDestinationHidden("appearance", true, false), false);
});

test("a destination id retired by the D684 split still opens a page", () => {
  // A stored selection, a native menu, or a link written before the split must
  // not land on an empty content pane.
  assert.equal(resolveSettingsTab("general"), "appearance");
  assert.equal(resolveSettingsTab("ai"), "behavior");
  assert.equal(resolveSettingsTab("nonsense"), DEFAULT_SETTINGS_TAB);
  assert.equal(DEFAULT_SETTINGS_TAB, SETTINGS_NAV[0].id);
  // An id the index still owns is returned unchanged, including a
  // developer-gated one: visibility is decided separately.
  for (const entry of SETTINGS_NAV) {
    assert.equal(resolveSettingsTab(entry.id), entry.id);
  }
});

test("settings search mirrors developer and packaged visibility", () => {
  for (const options of [{ developerMode: false }, { developerMode: true }]) {
    assert.ok(
      searchSettings("configSync.connectionTitle", identity, options)
        .some((hit) => hit.tab === "sync"),
    );
  }

  for (const options of [
    { developerMode: false, includeDevelopmentOnly: false },
    { developerMode: true, includeDevelopmentOnly: false },
  ]) {
    assert.equal(
      searchSettings("configSync.connectionTitle", identity, options)
        .some((hit) => hit.tab === "sync"), false,
    );
  }

  for (const developerMode of [false, true]) {
    for (const includeDevelopmentOnly of [false, true]) {
      const found = searchSettings("remotehosts", identity, { developerMode, includeDevelopmentOnly })
        .some(hit => hit.tab === "remoteHosts");
      assert.equal(found, includeDevelopmentOnly);
    }
  }
  assert.equal(searchSettings("settings", identity, { limit: 2 }).length, 2);
});

test("settings routes, global search, and composer use build visibility", () => {
  assert.match(settingsPage, /const includeDevelopmentOnly = import\.meta\.env\.DEV/);
  assert.match(settingsPage, /visibleSettingsNav\(developerMode, includeDevelopmentOnly\)/);
  assert.match(settingsPage, /isSettingsDestinationHidden\([\s\S]*includeDevelopmentOnly/);
  // A hidden destination falls back to the default one by name, so the
  // fallback cannot drift from the index (D684).
  assert.match(settingsPage, /setSettingsTab\(DEFAULT_SETTINGS_TAB\)/);
  assert.doesNotMatch(settingsPage, /setSettingsTab\("general"\)/);
  assert.match(settingsPage, /tab === "sync" && !tabHidden && <ConfigSyncPage \/>/);
  assert.match(settingsPage, /tab === "remoteHosts" && !tabHidden && <RemoteHostsPage \/>/);
  assert.match(searchDialog, /includeDevelopmentOnly: import\.meta\.env\.DEV/);
  assert.match(composer, /useVoiceInput/);
  assert.doesNotMatch(composer, /VoiceOverlay|voiceEnabled/);
  assert.match(composerToolbar, /<LiveVoiceControls\b/);
  assert.doesNotMatch(composerToolbar, /VoiceMicButton|voicePhase|onVoiceToggle|onVoiceCancel/);
});

test("Live Voice keeps its Model configuration link on the card heading", () => {
  // The link belongs to the enable card's heading line, not to a floating
  // control inside the row stack.
  assert.match(settingsPrimitives, /settings-card-heading-with-action/);
  assert.match(settingsPrimitives, /action\?: ReactNode/);
  assert.match(
    liveVoiceSettings,
    /action=\{[\s\S]*className="settings-text-action"[\s\S]*settings\.configuration/,
  );
  assert.doesNotMatch(liveVoiceSettings, /live-voice-actions/);
});
