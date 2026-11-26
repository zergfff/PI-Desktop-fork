import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useTranslation } from "react-i18next";
import type { FsEntry, FsReadResult } from "@pi-desktop/shared";
import { useAppStore } from "../../stores/app-store";
import { api } from "../../lib/api";
import { Markdown } from "../Markdown";
import { ContextMenu, useContextMenu } from "../ContextMenu";
import {
  FILE_MANAGER_PLUGIN_TAB,
  fileManagerPluginTab,
  hasPluginView,
} from "../../lib/work-panel-tabs";
import { CsvPreview } from "./CsvPreview";
import { usePreviewFind } from "./usePreviewFind";
import { fileDirOf } from "../../lib/chat-links";
import { Button, cx } from "../ui";
import { TooltipButton } from "../ui";
import {
  ensureLang,
  getHighlightVersion,
  resolveLang,
  subscribeHighlighter,
  themeForMode,
  tokenizeIncremental,
  type LineCache,
} from "../../lib/shiki";
import {
  IconChevronLeft,
  IconChevronRight,
  IconExternal,
  IconFileText,
  IconFolder,
  IconCopy,
  IconRefresh,
  IconSearch,
} from "../icons";
import { WorkTabEmpty } from "./WorkTabEmpty";

const VIEWER_LINE_CAP = 5000;

/**
 * The host's reader is one-shot: `openFile()` reads the file once and the
 * preview renders that snapshot until the tab closes, so a file rewritten
 * outside the panel — another editor, a `git checkout`, the agent's own
 * tools — left the reader looking at text that no longer exists on disk, with
 * no way to pull the new version in.
 *
 * Poll while the preview is on screen and reload in place. Text only: images
 * and binaries never change content under the same name in practice, and
 * re-reading their bytes on a timer costs more than it saves — the header
 * button covers those. Larger text files get a longer interval because every
 * probe re-reads the whole (capped) body over IPC on the main thread.
 */
const REFRESH_INTERVAL_MS = 2_500;
const REFRESH_LARGE_INTERVAL_MS = 15_000;
const REFRESH_LARGE_BYTES = 1024 * 1024;

const EXT_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  css: "css",
  html: "html",
  md: "markdown",
  rs: "rust",
  py: "python",
  go: "go",
  sh: "shellscript",
  zsh: "shellscript",
  bash: "shellscript",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  sql: "sql",
  swift: "swift",
  kt: "kotlin",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
};

function langForPath(path: string): string | null {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const lang = EXT_LANG[ext] ?? ext;
  return resolveLang(lang);
}

function isMarkdownPath(path: string): boolean {
  return /\.(?:md|markdown|mdx)$/i.test(path);
}

/** CSV/TSV get a table instead of a wall of commas. */
function isDelimitedPath(path: string): boolean {
  return /\.(?:csv|tsv)$/i.test(path);
}

/** PDFs are rendered by the bundled file-manager view, not by this pane. */
function isPdfPath(path: string): boolean {
  return /\.pdf$/i.test(path);
}

/** Office formats are ZIP containers of XML: recognised, not parsed here. */
function isOfficePath(path: string): boolean {
  return /\.(?:docx?|xlsx?|pptx?|odt|ods|odp|rtf|pages|numbers|key)$/i.test(path);
}

/** HTML gets a sandboxed render, with the source one toggle away. */
function isHtmlPath(path: string): boolean {
  return /\.(?:html?|xhtml)$/i.test(path);
}

function isMp4(path: string, mimeType?: string): boolean {
  return /\.mp4$/i.test(path) || (
    /(?:^|[\\/])attachments[\\/][0-9a-f]{64}$/i.test(path) &&
    mimeType?.toLowerCase() === "video/mp4"
  );
}

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function useThemeMode(): "light" | "dark" {
  return useSyncExternalStore(
    (notify) => {
      const observer = new MutationObserver(notify);
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme"],
      });
      return () => observer.disconnect();
    },
    () => (document.documentElement.dataset.theme === "light" ? "light" : "dark"),
  );
}

function HighlightedText({ path, content }: { path: string; content: string }) {
  const mode = useThemeMode();
  const highlightVersion = useSyncExternalStore(
    subscribeHighlighter,
    getHighlightVersion,
  );
  const lang = langForPath(path);
  const lines = useMemo(() => content.split("\n"), [content]);
  const capped = lines.length > VIEWER_LINE_CAP;
  const visible = useMemo(
    () => (capped ? lines.slice(0, VIEWER_LINE_CAP).join("\n") : content),
    [capped, lines, content],
  );

  const tokens = useMemo<LineCache | null>(() => {
    void highlightVersion;
    if (!lang) return null;
    ensureLang(lang);
    return tokenizeIncremental(null, visible, lang, themeForMode(mode));
  }, [lang, visible, mode, highlightVersion]);

  return (
    <pre className="file-viewer-code">
      {tokens
        ? tokens.tokens.map((row, i) => (
            <div className="file-viewer-line" data-line={i + 1} key={i}>
              {row.length === 0
                ? "\n"
                : row.map((token, j) => (
                    <span key={j} style={{ color: token.color }}>
                      {token.content}
                    </span>
                  ))}
            </div>
          ))
        : visible.split("\n").map((line, i) => (
            <div className="file-viewer-line" data-line={i + 1} key={i}>
              {line || "\n"}
            </div>
          ))}
      {capped && <div className="file-viewer-cap">…</div>}
    </pre>
  );
}

type DirState = { entries: FsEntry[]; error?: boolean };

// Module-level so a chat preview request fires once, not again on every
// files-tab remount (the tab unmounts when another tool is selected).
let handledFileRequestSeq = 0;

export function FilesTab() {
  const { t } = useTranslation();
  const workspace = useAppStore((s) => s.workspace);
  const fileRequest = useAppStore((s) => s.workPanelFileRequest);
  const showToast = useAppStore((s) => s.showToast);
  const sessionId = useAppStore((state) => state.activeSessionId);
  const remote = workspace?.remote;
  const root = workspace?.path ?? null;
  const scopeRef = useRef({ root, sessionId });
  scopeRef.current = { root, sessionId };

  const [dirs, setDirs] = useState<Record<string, DirState>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedMimeType, setSelectedMimeType] = useState<string | undefined>();
  const [selectedLine, setSelectedLine] = useState<number | undefined>();
  const [file, setFile] = useState<FsReadResult | null>(null);
  const [fileError, setFileError] = useState(false);
  const viewerBodyRef = useRef<HTMLDivElement>(null);
  const fileGeneration = useRef(0);
  const viewerMenu = useContextMenu();
  const [htmlSource, setHtmlSource] = useState(false);
  // Find works over the rendered DOM, so it is only meaningful for text
  // previews (Markdown, code, CSV tables, HTML).
  const find = usePreviewFind(viewerBodyRef, selected !== null && file?.kind === "text");
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selected;

  // Workspace switches reset all browsing state. Guarded so it only fires on
  // an actual root change: an unconditional [root] effect also runs on the
  // StrictMode remount, wiping the selection a chat file request just made
  // (first click landed on the tree instead of the file).
  const prevRoot = useRef(root);
  useEffect(() => {
    if (prevRoot.current === root) return;
    prevRoot.current = root;
    setDirs({});
    setExpanded(new Set());
    setSelected(null);
    setSelectedMimeType(undefined);
    setSelectedLine(undefined);
    setFile(null);
    setFileError(false);
  }, [root]);

  const loadDir = useCallback(
    async (rel: string) => {
      if (!root) return;
      try {
        const res = await api.fsList(rel, sessionId);
        if (scopeRef.current.root !== root || scopeRef.current.sessionId !== sessionId) return;
        setDirs((prev) => ({ ...prev, [rel]: { entries: res.entries } }));
      } catch {
        if (scopeRef.current.root !== root || scopeRef.current.sessionId !== sessionId) return;
        setDirs((prev) => ({ ...prev, [rel]: { entries: [], error: true } }));
      }
    },
    [root, sessionId],
  );

  useEffect(() => {
    if (root && !dirs[""]) void loadDir("");
  }, [root, dirs, loadDir]);

  const toggleDir = useCallback(
    (rel: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(rel)) {
          next.delete(rel);
        } else {
          next.add(rel);
        }
        return next;
      });
      if (!dirs[rel]) void loadDir(rel);
    },
    [dirs, loadDir],
  );

  /**
   * PDF hand-off.
   *
   * This pane cannot render a PDF: it has no parser, so the file used to land
   * in the generic text path and print its own bytes. The bundled file-manager
   * view ships PDF.js (continuous scroll, page layout, zoom, text layer,
   * thumbnails, find), so the PDF is opened there instead — one renderer for
   * PDFs in the whole app, and its upgrades come with the plugin.
   *
   * Local sessions only: a remote workspace has no plugin view, and the
   * fallback below still explains itself.
   */
  const handOffPdf = useCallback((rel: string): boolean => {
    if (!isPdfPath(rel) || remote) return false;
    if (!hasPluginView(useAppStore.getState().pluginViews, FILE_MANAGER_PLUGIN_TAB)) return false;
    useAppStore.getState().openWorkPanelTab(fileManagerPluginTab(rel));
    return true;
  }, [remote]);

  const openFile = useCallback(
    async (rel: string, mimeType?: string, position?: { line?: number; column?: number }) => {
      if (handOffPdf(rel)) return;
      const request = ++fileGeneration.current;
      setSelected(rel);
      setSelectedMimeType(mimeType);
      setSelectedLine(position?.line);
      setFile(null);
      setFileError(false);
      try {
        const result = await api.fsRead(rel, mimeType, sessionId);
        if (request !== fileGeneration.current || scopeRef.current.root !== root || scopeRef.current.sessionId !== sessionId) return;
        setFile(result);
      } catch {
        if (request !== fileGeneration.current || scopeRef.current.root !== root || scopeRef.current.sessionId !== sessionId) return;
        setFileError(true);
      }
    },
    [root, sessionId, handOffPdf],
  );

  useEffect(() => {
    if (!file || selectedLine == null) return;
    const frame = requestAnimationFrame(() => {
      const lineNode = viewerBodyRef.current?.querySelector(
        `[data-line="${selectedLine}"]`,
      );
      lineNode?.scrollIntoView({ block: "center" });
    });
    return () => cancelAnimationFrame(frame);
  }, [file, selectedLine]);

  // Swap in a freshly read file without throwing the reader back to the top.
  const applyFile = useCallback((next: FsReadResult) => {
    const body = viewerBodyRef.current;
    const scrollTop = body?.scrollTop ?? 0;
    setFile(next);
    setFileError(false);
    find.refresh();
    if (!body) return;
    requestAnimationFrame(() => {
      if (viewerBodyRef.current === body) body.scrollTop = scrollTop;
    });
  }, []);

  // Manual reload: the header button, and the only path for images/binary
  // previews, which the timer below deliberately skips.
  const reloadFile = useCallback(async () => {
    const path = selected;
    if (!path) return;
    try {
      const next = await api.fsRead(path, selectedMimeType, sessionId);
      if (selectedRef.current !== path) return;
      if (scopeRef.current.root !== root || scopeRef.current.sessionId !== sessionId) return;
      applyFile(next);
    } catch {
      showToast(t("panel.files.error"), { variant: "error" });
    }
  }, [selected, selectedMimeType, sessionId, root, applyFile, showToast, t]);

  /**
   * The work panel keeps one file tab per session, but this pane's own
   * selection does not survive a session switch: the panel remounts and the
   * preview came back empty, so the reader had to find the file again. The tab
   * still names the path, so restore from it on mount — and only then, so
   * "back to files" stays a deliberate choice instead of being undone by the
   * next render.
   */
  const activeFileTabPath = useAppStore((state) => {
    const tab = state.workPanelTabs.find((item) => item.id === state.activeWorkPanelTabId);
    return tab?.kind === "file" && tab.resource ? tab.resource : null;
  });
  const restoredTabPath = useRef<string | null>(null);
  useEffect(() => {
    if (!activeFileTabPath || selectedRef.current !== null) return;
    if (restoredTabPath.current === activeFileTabPath) return;
    restoredTabPath.current = activeFileTabPath;
    void openFile(activeFileTabPath);
  }, [activeFileTabPath, openFile]);



  /**
   * Right-click inside the preview.
   *
   * The pane is a read-only renderer, so the platform menu has nothing to offer
   * (no input, no editable text) and used to come up empty. These items are the
   * actions the pane actually owns: re-read from disk, copy what is on screen,
   * and hand the file to the OS. A live text selection appends its own copy
   * action through the primitive that snapshots the range before focus moves.
   */
  const openViewerMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (!selected) return;
      const path = selected;
      viewerMenu.openContextMenu(
        event,
        {
          label: t("panel.files.actions"),
          items: [
            {
              id: "refresh",
              label: t("panel.files.refresh"),
              icon: <IconRefresh size={14} />,
              onSelect: () => void reloadFile(),
            },
            {
              id: "find",
              label: t("panel.files.find"),
              icon: <IconSearch size={14} />,
              disabled: file?.kind !== "text",
              onSelect: () => find.start(),
            },
            {
              id: "open-external",
              label: t("panel.files.openExternal"),
              icon: <IconExternal size={14} />,
              separatorBefore: true,
              disabled: Boolean(remote),
              onSelect: () => void api.fsOpen(path, selectedMimeType, sessionId),
            },
            {
              id: "reveal",
              label: t("panel.files.reveal"),
              icon: <IconFolder size={14} />,
              disabled: Boolean(remote),
              onSelect: () => void api.fsReveal(path, sessionId),
            },
          ],
        },
        (selection) =>
          selection.trim()
            ? [
                {
                  id: "copy-selection",
                  label: t("panel.files.copySelection"),
                  icon: <IconCopy size={14} />,
                  separatorBefore: true,
                  onSelect: () => void navigator.clipboard.writeText(selection),
                },
              ]
            : [],
      );
    },
    [selected, selectedMimeType, sessionId, remote, file, reloadFile, viewerMenu, t],
  );

  // Auto-reload while the preview is on screen. Polling beats a watcher here
  // because the renderer has no filesystem access and adding a channel for it
  // would mean touching the IPC contract, the preload bridge and the remote
  // backend for a panel that is only visible part of the time.
  useEffect(() => {
    if (!selected || !file || file.kind !== "text") return;
    const path = selected;
    const interval =
      file.size > REFRESH_LARGE_BYTES ? REFRESH_LARGE_INTERVAL_MS : REFRESH_INTERVAL_MS;
    let stopped = false;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void (async () => {
        try {
          const next = await api.fsRead(path, selectedMimeType, sessionId);
          if (stopped || selectedRef.current !== path) return;
          if (scopeRef.current.root !== root || scopeRef.current.sessionId !== sessionId) return;
          if (next.kind !== "text" || next.content === file.content) return;
          applyFile(next);
        } catch {
          // A read that lands mid-write keeps the last good preview on screen.
        }
      })();
    }, interval);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [selected, selectedMimeType, sessionId, root, file, applyFile]);

  // Ctrl/Cmd+F finds inside the preview while it is the surface in use; the
  // chat's own search keeps the shortcut everywhere else.
  useEffect(() => {
    if (selected === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key !== "f" || event.altKey || event.shiftKey) return;
      if (!event.ctrlKey && !event.metaKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(?:INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      event.preventDefault();
      find.start();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selected, find]);

  const openMp4 = useCallback(async () => {
    if (!selected || remote) return;
    try {
      await api.fsOpen(selected, selectedMimeType, sessionId);
    } catch {
      showToast(t("panel.files.openFailed"), { variant: "error" });
    }
  }, [selected, selectedMimeType, sessionId, showToast, t]);

  // Chat-initiated previews: open the file and expand its ancestor folders
  // so "back" lands on a tree that reveals it. Attachment blobs and absolute
  // scratch paths live outside the workspace tree.
  useEffect(() => {
    if (!fileRequest) return;
    if (fileRequest.seq === handledFileRequestSeq) return;
    handledFileRequestSeq = fileRequest.seq;
    const path = fileRequest.path;
    const isExternal =
      path.startsWith("attachments/") ||
      path.startsWith("/") ||
      /^[A-Za-z]:[\\/]/.test(path) ||
      path.startsWith("\\\\");
    if (root && !isExternal) {
      const parts = path.split("/").slice(0, -1);
      const ancestors: string[] = [];
      let acc = "";
      for (const part of parts) {
        acc = acc ? `${acc}/${part}` : part;
        ancestors.push(acc);
      }
      setExpanded((prev) => new Set([...prev, ...ancestors]));
      for (const dir of ancestors) void loadDir(dir);
    }
    void openFile(path, fileRequest.mimeType, {
      line: fileRequest.line,
      column: fileRequest.column,
    });
  }, [fileRequest, root, loadDir, openFile]);

  const renderDir = (rel: string, depth: number): React.ReactNode => {
    const state = dirs[rel];
    if (!state) {
      return (
        <div
          className="file-tree-note"
          style={{ paddingLeft: 12 + depth * 14 }}
          key={`${rel}:loading`}
        >
          {t("panel.files.loading")}
        </div>
      );
    }
    if (state.entries.length === 0) {
      return (
        <div
          className="file-tree-note"
          style={{ paddingLeft: 12 + depth * 14 }}
          key={`${rel}:empty`}
        >
          {state.error ? t("panel.files.error") : t("panel.files.empty")}
        </div>
      );
    }
    return state.entries.map((entry) => {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.kind === "dir") {
        const open = expanded.has(childRel);
        return (
          <div key={childRel}>
            <button
              type="button"
              className="file-tree-row"
              style={{ paddingLeft: 12 + depth * 14 }}
              onClick={() => toggleDir(childRel)}
            >
              <span className={cx("file-tree-caret", open && "open")} aria-hidden>
                <IconChevronRight size={12} />
              </span>
              <IconFolder size={14} />
              <span className="file-tree-name">{entry.name}</span>
            </button>
            {open && renderDir(childRel, depth + 1)}
          </div>
        );
      }
      return (
        <button
          key={childRel}
          type="button"
          className={cx("file-tree-row", selected === childRel && "active")}
          style={{ paddingLeft: 12 + depth * 14 + 16 }}
          onClick={() => void openFile(childRel)}
          title={childRel}
        >
          <IconFileText size={14} />
          <span className="file-tree-name">{entry.name}</span>
        </button>
      );
    });
  };

  if (selected !== null) {
    return (
      <div className="file-viewer">
        <div className="file-viewer-header">
          <TooltipButton
            type="button"
            className="icon-btn icon-btn-square"
            tooltip={t("panel.files.back")}
            ariaLabel={t("panel.files.back")}
            onClick={() => {
              setSelected(null);
              setSelectedMimeType(undefined);
              setSelectedLine(undefined);
              setFile(null);
            }}
          >
            <IconChevronLeft size={14} />
          </TooltipButton>
          <span className="file-viewer-path" title={selected}>
            {selected}
          </span>
          {file && <span className="file-viewer-size">{formatSize(file.size)}</span>}
          <TooltipButton
            type="button"
            className="icon-btn icon-btn-square"
            tooltip={t("panel.files.reload")}
            ariaLabel={t("panel.files.reload")}
            onClick={() => void reloadFile()}
          >
            <IconRefresh size={14} />
          </TooltipButton>
          <TooltipButton
            type="button"
            className="icon-btn icon-btn-square"
            tooltip={t("panel.files.find")}
            ariaLabel={t("panel.files.find")}
            disabled={file?.kind !== "text"}
            onClick={find.start}
          >
            <IconSearch size={14} />
          </TooltipButton>
          {file?.kind === "text" && isHtmlPath(selected) ? (
            <button
              type="button"
              className="file-viewer-mode"
              onClick={() => setHtmlSource((current) => !current)}
            >
              {htmlSource ? t("panel.files.htmlPreview") : t("panel.files.htmlSource")}
            </button>
          ) : null}
          {!remote ? <TooltipButton
            type="button"
            className="icon-btn icon-btn-square"
            tooltip={t("panel.files.reveal")}
            ariaLabel={t("panel.files.reveal")}
            onClick={() => void api.fsReveal(selected, sessionId)}
          >
            <IconExternal size={14} />
          </TooltipButton> : null}
        </div>
        {find.open ? (
          <div className="file-viewer-find" role="search">
            <input
              autoFocus
              value={find.query}
              placeholder={t("panel.files.findPlaceholder")}
              aria-label={t("panel.files.find")}
              onChange={(event) => find.setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  if (event.shiftKey) find.previous();
                  else find.next();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  find.close();
                }
              }}
            />
            <span className="file-viewer-find-count" role="status">
              {!find.query.trim() ? "" : find.total ? `${find.position}/${find.total}` : t("panel.files.findNoResults")}
            </span>
            <button type="button" onClick={find.previous} aria-label={t("panel.files.findPrevious")} title={t("panel.files.findPrevious")}>↑</button>
            <button type="button" onClick={find.next} aria-label={t("panel.files.findNext")} title={t("panel.files.findNext")}>↓</button>
            <button type="button" onClick={find.close} aria-label={t("panel.files.findClose")} title={t("panel.files.findClose")}>×</button>
          </div>
        ) : null}
        <div className="file-viewer-body" ref={viewerBodyRef} onContextMenu={openViewerMenu}>
          {fileError ? (
            <WorkTabEmpty icon={IconFileText} title={t("panel.files.error")} />
          ) : !file ? (
            <div className="file-tree-note">{t("panel.files.loading")}</div>
          ) :
          file.kind === "text" && isDelimitedPath(selected) ? (
            <CsvPreview
              content={file.content ?? ""}
              delimiter={/\.tsv$/i.test(selected) ? "\t" : ","}
              t={t}
            />
          ) : file.kind === "text" && isHtmlPath(selected) && !htmlSource ? (
            /* No scripts, no same-origin: a preview, not a browser tab. */
            <iframe
              className="file-viewer-html"
              title={selected}
              sandbox=""
              referrerPolicy="no-referrer"
              srcDoc={file.content ?? ""}
            />
          ) : file.kind === "text" &&
          isMarkdownPath(selected) &&
          selectedLine === undefined ? (
            <div className="file-viewer-markdown prose-chat">
              <Markdown source={file.content ?? ""} baseDir={fileDirOf(selected)} />
            </div>
          ) : file.kind === "text" ? (
            <HighlightedText path={selected} content={file.content ?? ""} />
          ) : file.kind === "image" ? (
            <div className="file-viewer-image">
              <img src={file.dataUrl} alt={selected} />
            </div>
          ) : (
            <WorkTabEmpty
              icon={IconFileText}
              title={
                isPdfPath(selected)
                  ? t("panel.files.pdfHint")
                  : isOfficePath(selected)
                    ? t("panel.files.officeHint")
                    : file.kind === "tooLarge"
                      ? t("panel.files.tooLarge")
                      : t("panel.files.binary")
                  }
                  >
                  {!remote &&
                  (isMp4(selected, selectedMimeType) || isOfficePath(selected) || isPdfPath(selected)) && (
                <Button type="button" onClick={() => void openMp4()}>
                  {t("chat.openFile")}
                </Button>
              )}
            </WorkTabEmpty>
          )}
        </div>
        <ContextMenu state={viewerMenu.contextMenu} onClose={viewerMenu.closeContextMenu} />
      </div>
    );
  }

  if (!root) {
    return (
      <WorkTabEmpty
        icon={IconFolder}
        title={t("panel.files.noWorkspace")}
        body={t("panel.files.noWorkspaceHint")}
      />
    );
  }

  return <div className="file-tree">{renderDir("", 0)}</div>;
}
