/**
 * Page capture for the agent: an element, the article body, or the console.
 *
 * The three captures exist because the agent cannot see the pane. Each one is
 * produced inside the guest, written to the session scratch as markdown so it can
 * be referenced as a file, and copied to the clipboard so it can be pasted into
 * the composer and sent.
 *
 * A direct `@` mention in the composer is the better UX and is deliberately *not*
 * attempted here: the composer owns its draft in the chat renderer, the plugin
 * chrome has no channel into it, and faking one would mean touching the draft
 * model from a second surface. Clipboard plus a file on disk is the honest
 * version of the same handoff until that channel exists.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clipboard } from "electron";
import type { WebContents } from "electron";

export type CaptureResult = { path: string; text: string; summary: string };

/** Written when a capture happens; small enough to keep, unique enough to find. */
function capturePath(scratchDir: string, kind: string): string {
  const dir = join(scratchDir, "browser-capture");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(dir, `${kind}-${stamp}.md`);
}

function persist(scratchDir: string, kind: string, header: string, body: string): CaptureResult {
  const path = capturePath(scratchDir, kind);
  const text = `${header}\n\n${body}\n`;
  writeFileSync(path, text, "utf8");
  clipboard.writeText(text);
  return { path, text, summary: header };
}

/** Overlay that lets the reader click one element, then reports it back. */
export const ELEMENT_PICKER_SCRIPT = `(() => new Promise((resolve) => {
  if (window.__piPicker) { resolve(null); return; }
  window.__piPicker = true;
  const box = document.createElement("div");
  Object.assign(box.style, {
    position: "fixed", zIndex: "2147483647", pointerEvents: "none",
    border: "2px solid #3b82f6", background: "rgba(59,130,246,0.12)",
    borderRadius: "3px", transition: "all 60ms linear", left: "0", top: "0",
    width: "0", height: "0",
  });
  document.documentElement.appendChild(box);
  const path = (node) => {
    const parts = [];
    let el = node;
    while (el && el.nodeType === 1 && parts.length < 6) {
      let part = el.tagName.toLowerCase();
      if (el.id) { part += "#" + el.id; parts.unshift(part); break; }
      const cls = (el.className || "").toString().trim().split(/\\s+/).filter(Boolean).slice(0, 2);
      if (cls.length) part += "." + cls.join(".");
      const parent = el.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
        if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(el) + 1) + ")";
      }
      parts.unshift(part);
      el = el.parentElement;
    }
    return parts.join(" > ");
  };
  const describe = (el) => {
    const rect = el.getBoundingClientRect();
    const text = (el.innerText || el.value || "").trim().replace(/\\s+/g, " ").slice(0, 400);
    return {
      selector: path(el),
      tag: el.tagName.toLowerCase(),
      text,
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      url: location.href,
      title: document.title,
    };
  };
  let current = null;
  const onMove = (event) => {
    const el = event.target;
    if (!el || el === box || el === document.documentElement) return;
    current = el;
    const rect = el.getBoundingClientRect();
    Object.assign(box.style, {
      left: rect.left + "px", top: rect.top + "px",
      width: rect.width + "px", height: rect.height + "px",
    });
  };
  const onClick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    const el = event.target;
    finish(el ? describe(el) : null);
  };
  const onKey = (event) => { if (event.key === "Escape") finish(null); };
  const finish = (value) => {
    window.removeEventListener("mousemove", onMove, true);
    window.removeEventListener("click", onClick, true);
    window.removeEventListener("keydown", onKey, true);
    box.remove();
    window.__piPicker = false;
    resolve(value);
  };
  window.addEventListener("mousemove", onMove, true);
  window.addEventListener("click", onClick, true);
  window.addEventListener("keydown", onKey, true);
}))()`;

/** Article text: the densest content container, capped for a prompt. */
export const ARTICLE_EXTRACT_SCRIPT = `(() => {
  const pick = () => {
    const candidates = Array.from(document.querySelectorAll("article, main, [role=main], .article, .content, #content"));
    if (!candidates.length) candidates.push(document.body);
    let best = null;
    let bestScore = 0;
    for (const el of candidates) {
      const text = (el.innerText || "").trim();
      const links = el.querySelectorAll("a").length;
      // Long text with few links is prose; a link farm is navigation.
      const score = text.length - links * 60;
      if (score > bestScore) { bestScore = score; best = el; }
    }
    return best || document.body;
  };
  const el = pick();
  const text = (el.innerText || "").replace(/\\n{3,}/g, "\\n\\n").trim();
  return { title: document.title, url: location.href, text: text.slice(0, 20000) };
})()`;

/** Ask the guest for one element; `undefined` when the reader cancels. */
export async function pickElement(
  wc: WebContents,
  scratchDir: string,
): Promise<CaptureResult | undefined> {
  const picked = (await wc.executeJavaScript(ELEMENT_PICKER_SCRIPT, true)) as
    | {
        selector: string;
        tag: string;
        text: string;
        rect: { x: number; y: number; width: number; height: number };
        url: string;
        title: string;
      }
    | null;
  if (!picked) return undefined;
  const header = `# 页面元素：\`${picked.selector}\``;
  const body = [
    `- 页面：${picked.title} — ${picked.url}`,
    `- 元素：\`<${picked.tag}>\` 选择器 \`${picked.selector}\``,
    `- 尺寸：${picked.rect.width}×${picked.rect.height}，位置 (${picked.rect.x}, ${picked.rect.y})`,
    `- 文本：${picked.text ? `「${picked.text}」` : "（无文本）"}`,
  ].join("\n");
  return persist(scratchDir, "element", header, body);
}

/** Article text of the current page. */
export async function captureArticle(
  wc: WebContents,
  scratchDir: string,
): Promise<CaptureResult> {
  const page = (await wc.executeJavaScript(ARTICLE_EXTRACT_SCRIPT, true)) as {
    title: string;
    url: string;
    text: string;
  };
  const header = `# 页面正文：${page.title || page.url}`;
  const body = [`来源：${page.url}`, "", page.text || "（没有取到正文）"].join("\n");
  return persist(scratchDir, "article", header, body);
}

/** Recent console output, errors first. */
export function captureConsole(
  scratchDir: string,
  messages: ReadonlyArray<{ level: string; message: string }>,
): CaptureResult {
  const errors = messages.filter((entry) => entry.level === "error");
  const rest = messages.filter((entry) => entry.level !== "error");
  const header = `# 控制台输出（错误 ${errors.length} 条 / 共 ${messages.length} 条）`;
  const body = [...errors, ...rest].map((entry) => `[${entry.level}] ${entry.message}`).join("\n");
  return persist(scratchDir, "console", header, body || "（控制台没有输出）");
}
