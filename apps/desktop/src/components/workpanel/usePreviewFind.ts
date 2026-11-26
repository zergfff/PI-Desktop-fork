import { useCallback, useEffect, useState } from "react";

/**
 * Find inside the preview pane.
 *
 * The pane renders React elements (Markdown, highlighted code, tables), so
 * matching has to happen against the DOM, not the source text. Mutating the
 * tree to wrap matches in <mark> would fight React's reconciliation on the next
 * render, so matches are published through the CSS Custom Highlight API: the
 * ranges live outside the document and only their pseudo-element styling
 * changes. Electron 43 ships Chromium with `CSS.highlights`, and the call sites
 * degrade to "count only, no painting" when it is missing.
 */

type HighlightRegistry = {
  set: (name: string, highlight: unknown) => void;
  delete: (name: string) => void;
};

const ALL_HIGHLIGHT = "pi-preview-find";
const ACTIVE_HIGHLIGHT = "pi-preview-find-active";

function registry(): HighlightRegistry | null {
  const css = (globalThis as unknown as { CSS?: { highlights?: HighlightRegistry } }).CSS;
  return css?.highlights ?? null;
}

function highlightCtor(): (new (...ranges: Range[]) => unknown) | null {
  const ctor = (globalThis as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  return typeof ctor === "function" ? ctor : null;
}

/** Every text node under `root`, in document order. */
function textNodes(root: Node): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    if (text.data.trim()) nodes.push(text);
  }
  return nodes;
}

/**
 * Case-insensitive matches for `query`, as ranges.
 *
 * Comparison happens on the lower-cased value; the few scripts where folding
 * changes length are left slightly conservative rather than misaligned, because
 * an offset that does not exist in the original node would produce a broken
 * range (and a broken range throws out of the highlight constructor).
 */
function collectRanges(root: HTMLElement, query: string): Range[] {
  const needle = query.toLowerCase();
  if (!needle) return [];
  const ranges: Range[] = [];
  for (const node of textNodes(root)) {
    const haystack = node.data.toLowerCase();
    if (haystack.length !== node.data.length) continue;
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(needle, from);
      if (at < 0) break;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + needle.length);
      ranges.push(range);
      from = at + needle.length;
      if (ranges.length > 2000) return ranges;
    }
  }
  return ranges;
}

export type PreviewFind = {
  open: boolean;
  query: string;
  total: number;
  /** 1-based position of the active match, or 0 when there is none. */
  position: number;
  setQuery: (value: string) => void;
  start: () => void;
  close: () => void;
  next: () => void;
  previous: () => void;
  /** Recompute after the preview content changed (auto reload, mode switch). */
  refresh: () => void;
};

export function usePreviewFind(
  containerRef: React.RefObject<HTMLElement | null>,
  enabled: boolean,
): PreviewFind {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [ranges, setRanges] = useState<Range[]>([]);
  const [index, setIndex] = useState(0);
  const [tick, setTick] = useState(0);

  const clearHighlights = useCallback(() => {
    const reg = registry();
    reg?.delete(ALL_HIGHLIGHT);
    reg?.delete(ACTIVE_HIGHLIGHT);
  }, []);

  const recompute = useCallback(() => {
    const root = containerRef.current;
    if (!root || !query.trim()) {
      setRanges([]);
      setIndex(0);
      clearHighlights();
      return;
    }
    const found = collectRanges(root, query.trim());
    setRanges(found);
    setIndex((current) => (found.length ? Math.min(current, found.length - 1) : 0));
  }, [containerRef, query, clearHighlights]);

  // Content changes (reload from disk, mode switch) and query edits both land
  // here; `tick` lets the caller force a pass after the DOM changed.
  useEffect(() => {
    if (!enabled) return;
    recompute();
  }, [enabled, recompute, tick]);

  useEffect(() => {
    const reg = registry();
    const HighlightCtor = highlightCtor();
    if (!reg || !HighlightCtor) return;
    if (!ranges.length) {
      clearHighlights();
      return;
    }
    reg.set(ALL_HIGHLIGHT, new HighlightCtor(...ranges));
    const active = ranges[Math.min(index, ranges.length - 1)];
    reg.set(ACTIVE_HIGHLIGHT, new HighlightCtor(active));
    active.startContainer.parentElement?.scrollIntoView({ block: "nearest", inline: "nearest" });
    return () => clearHighlights();
  }, [ranges, index, clearHighlights]);

  useEffect(() => {
    if (!enabled) {
      setOpen(false);
      setQuery("");
      setRanges([]);
      clearHighlights();
    }
  }, [enabled, clearHighlights]);

  return {
    open,
    query,
    total: ranges.length,
    position: ranges.length ? Math.min(index, ranges.length - 1) + 1 : 0,
    setQuery: (value) => {
      setQuery(value);
      setIndex(0);
    },
    start: () => setOpen(true),
    close: () => {
      setOpen(false);
      setRanges([]);
      clearHighlights();
    },
    next: () => {
      setIndex((current) => (ranges.length ? (current + 1) % ranges.length : 0));
    },
    previous: () => {
      setIndex((current) => (ranges.length ? (current - 1 + ranges.length) % ranges.length : 0));
    },
    refresh: () => setTick((current) => current + 1),
  };
}
