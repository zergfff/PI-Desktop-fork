import { lazy, Suspense } from "react";
import { useAppStore } from "../../stores/app-store";

// The dialog carries the Settings destinations and a Markdown renderer; keep
// it out of the startup bundle until it is actually opened.
const SettingsDialog = lazy(() =>
  import("../settings/SettingsDialog").then((module) => ({ default: module.SettingsDialog })),
);

/**
 * Owns the app-level modal overlays.
 *
 * Upstream this host also carried the first-launch guide and the release
 * announcement and picked one overlay by priority. This build ships neither of
 * those surfaces, so what is left is the Settings dialog — which still has to
 * be mounted here, because nothing else renders it: dropping the host entirely
 * makes every "Settings" entry point in the app do nothing.
 */
export function AppOverlayHost({ active }: { active: boolean }) {
  const settingsOpen = useAppStore((s) => s.settingsOpen);
  const closeSettings = useAppStore((s) => s.closeSettings);

  if (!active || !settingsOpen) return null;
  return (
    <Suspense fallback={null}>
      <SettingsDialog onClose={closeSettings} />
    </Suspense>
  );
}
