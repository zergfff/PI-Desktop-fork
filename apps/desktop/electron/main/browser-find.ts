/**
 * Find-in-page for the preview browser.
 *
 * Electron exposes `webContents.findInPage`, but that API only paints matches
 * Chromium owns and gives the host no surface to type into — the panel's chrome
 * is the plugin's own page, which cannot drive the guest's find session. So the
 * bar is injected into the page itself and does its own matching over text
 * nodes, painted through the CSS Custom Highlight API (no DOM mutation, so the
 * page's framework never sees it).
 *
 * The script is idempotent: a second Ctrl+F focuses the bar that is already
 * there instead of stacking a second one.
 */
export const BROWSER_FIND_SCRIPT = String.raw`(() => {
  const ID = "__pi_find_bar__";
  const existing = document.getElementById(ID);
  if (existing) {
    const field = existing.querySelector("input");
    if (field) { field.focus(); field.select(); }
    return "focused";
  }
  const css = (n) => "https://example.invalid/" + n;
  const host = document.createElement("div");
  host.id = ID;
  host.style.cssText =
    "position:fixed;top:10px;right:10px;z-index:2147483647;display:flex;align-items:center;gap:6px;" +
    "padding:6px 8px;border-radius:8px;background:#1f1f1f;color:#fff;font:12px/1.4 -apple-system,Segoe UI,sans-serif;" +
    "box-shadow:0 8px 28px rgba(0,0,0,.45);border:1px solid #3a3a3a";
  const field = document.createElement("input");
  field.placeholder = "Find on page";
  field.style.cssText =
    "width:180px;height:22px;padding:0 6px;border:1px solid #3a3a3a;border-radius:5px;" +
    "background:#111;color:#fff;font:inherit;outline:none";
  const count = document.createElement("span");
  count.textContent = "";
  count.style.cssText = "min-width:46px;text-align:center;opacity:.75;font-variant-numeric:tabular-nums";
  const button = (label, title) => {
    const el = document.createElement("button");
    el.type = "button";
    el.textContent = label;
    el.title = title;
    el.style.cssText =
      "width:22px;height:22px;border:0;border-radius:4px;background:transparent;color:#ddd;cursor:pointer;font:inherit;line-height:1";
    el.addEventListener("mouseenter", () => { el.style.background = "#333"; });
    el.addEventListener("mouseleave", () => { el.style.background = "transparent"; });
    return el;
  };
  const prev = button("\u2191", "Previous match");
  const next = button("\u2193", "Next match");
  const close = button("\u00d7", "Close");
  host.append(field, count, prev, next, close);
  document.documentElement.appendChild(host);
  field.focus();

  const ALL = "pi-browser-find";
  const ACTIVE = "pi-browser-find-active";
  const registry = CSS && CSS.highlights ? CSS.highlights : null;
  const HighlightCtor = typeof Highlight === "function" ? Highlight : null;
  let ranges = [];
  let index = 0;

  const clear = () => {
    if (registry) { registry.delete(ALL); registry.delete(ACTIVE); }
  };

  const collect = (query) => {
    const needle = query.toLowerCase();
    const found = [];
    if (!needle) return found;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.data.trim()) return NodeFilter.FILTER_REJECT;
        if (host.contains(node)) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        const tag = parent.tagName;
        if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const haystack = node.data.toLowerCase();
      if (haystack.length !== node.data.length) continue;
      let from = 0;
      for (;;) {
        const at = haystack.indexOf(needle, from);
        if (at < 0) break;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + needle.length);
        found.push(range);
        from = at + needle.length;
        if (found.length >= 2000) return found;
      }
    }
    return found;
  };

  const paint = () => {
    if (!registry || !HighlightCtor) return;
    if (!ranges.length) { clear(); return; }
    registry.set(ALL, new HighlightCtor(...ranges));
    registry.set(ACTIVE, new HighlightCtor(ranges[index]));
    const node = ranges[index].startContainer.parentElement;
    if (node && node.scrollIntoView) node.scrollIntoView({ block: "center", inline: "nearest" });
  };

  const update = () => {
    ranges = collect(field.value.trim());
    index = 0;
    count.textContent = field.value.trim() ? (ranges.length ? "1/" + ranges.length : "0/0") : "";
    paint();
  };

  const step = (delta) => {
    if (!ranges.length) return;
    index = (index + delta + ranges.length) % ranges.length;
    count.textContent = index + 1 + "/" + ranges.length;
    paint();
  };

  const teardown = () => {
    clear();
    host.remove();
    document.removeEventListener("keydown", onKey, true);
  };

  function onKey(event) {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); teardown(); }
  }

  field.addEventListener("input", update);
  field.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); step(event.shiftKey ? -1 : 1); }
    else if (event.key === "Escape") { event.preventDefault(); teardown(); }
  });
  prev.addEventListener("click", () => step(-1));
  next.addEventListener("click", () => step(1));
  close.addEventListener("click", teardown);
  document.addEventListener("keydown", onKey, true);
  return "opened";
})()`;

/** Highlight colours; the page's own palette is unknown, so both themes get one. */
export const BROWSER_FIND_STYLE = `
::highlight(pi-browser-find) { background-color: rgba(255, 213, 79, 0.45); color: inherit; }
::highlight(pi-browser-find-active) { background-color: rgba(255, 152, 0, 0.85); color: #1a1200; }
`;
