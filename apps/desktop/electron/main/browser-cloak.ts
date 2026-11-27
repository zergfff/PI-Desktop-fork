/**
 * Anti-detection helpers for the preview browser.
 *
 * Two different blocks are common and both are fought here:
 *
 *  - **Bot / browser fingerprinting.** The pane runs Electron, so its default
 *    user agent ends with `PI-Desktop/0.24.0 Electron/43.6.0 Chrome/…`, which a
 *    growing number of sites treat as "not a real browser" and answer with a
 *    challenge page or a 403. The UA is rewritten to the plain Chrome string for
 *    the bundled Chromium, and the `User-Agent` request header with it, since
 *    some sites read the header rather than the JS property.
 *
 *  - **Anti-adblock walls.** A detector typically plants a bait element with an
 *    ad-like class and checks whether it still has a size; with `display: none`
 *    cosmetics the bait collapses, the page decides a blocker is installed and
 *    hides the content. So cosmetics *cloak* instead of removing: the node keeps
 *    a 1×1 box off-screen, which passes `offsetHeight`/`display` checks while
 *    staying invisible, and small off-screen bait elements matching the common
 *    names are seeded so a detector looking for "our" bait finds it intact.
 *
 * What this does **not** do — and cannot honestly claim — is defeat a real
 * anti-bot gate (Cloudflare Turnstile, Kasada, Akamai). Those weigh TLS
 * fingerprints, CDP presence and behaviour that a hosted `WebContentsView` does
 * not let us alter from JavaScript. Tools such as CloakBrowser solve them with a
 * patched Chromium binary driven by Playwright, which is a separate 200 MB
 * browser with its own licence key and cannot be embedded in this panel.
 */

/** Chrome-major-true user agent for the bundled Chromium, without Electron tokens. */
export function browserUserAgent(): string {
  const chrome = process.versions.chrome ?? "130.0.0.0";
  const major = chrome.split(".")[0];
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

/**
 * Seed bait elements an ad-block detector looks for.
 *
 * Each is laid out for real (so its size is non-zero) but parked off-screen, and
 * a MutationObserver restores them if the page removes them.
 */
export const BROWSER_CLOAK_SCRIPT = `(() => {
  if (window.__piCloak) return;
  window.__piCloak = true;
  const NAMES = [
    "ad-banner", "ad-banner-300x250", "adsbox", "ad-slot", "ad-placement",
    "pub_300x250", "banner_ad", "advert", "adsbygoogle",
  ];
  const seed = () => {
    for (const name of NAMES) {
      if (document.querySelector("." + name)) continue;
      const bait = document.createElement("div");
      bait.className = name;
      bait.setAttribute("aria-hidden", "true");
      bait.setAttribute("data-pi-bait", "1");
      // Real layout box so "is it still visible?" answers yes, parked off-screen
      // so it never reaches the reader.
      Object.assign(bait.style, {
        position: "fixed",
        left: "-10000px",
        top: "0",
        width: "300px",
        height: "250px",
        opacity: "0",
        pointerEvents: "none",
      });
      (document.body || document.documentElement).appendChild(bait);
    }
  };
  seed();
  new MutationObserver(seed).observe(document.documentElement, { childList: true, subtree: true });
})();`;
