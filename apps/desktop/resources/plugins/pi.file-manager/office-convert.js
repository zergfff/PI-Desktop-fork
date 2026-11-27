"use strict";

/**
 * Office 文档转 PDF，交给现有的 PDF 预览器显示。
 *
 * docx/pptx 没有现成的浏览器端渲染器（xlsx 插件自己会解析单元格），而这台机器上装了
 * Office：Word/PowerPoint/Excel 都能把文档导成 PDF，保真度和用户在 Office 里看到的一样，
 * 而且转换完复用 PDF.js —— 缩放、查找、标注全都免费。
 *
 * 转换慢（Word 冷启动十几秒），所以按「路径 + mtime + 大小」缓存，命中就不再启动 Office。
 * 失败时返回 null，调用方退回二进制提示，不会把预览卡死。
 */

const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const OFFICE_EXTENSIONS = new Set([
  ".docx",
  ".doc",
  ".rtf",
  ".odt",
  ".pptx",
  ".ppt",
  ".xlsx",
  ".xls",
]);

const CACHE_DIR = "office-pdf-cache";
const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 7;

function cacheKey(abs, stat) {
  return crypto
    .createHash("sha1")
    .update(`${abs}|${Math.round(stat.mtimeMs)}|${stat.size}`)
    .digest("hex")
    .slice(0, 24);
}

function runPowerShell(scriptPath, input, output, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-In", input, "-Out", output],
        { windowsHide: true },
      );
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      finish(false);
    }, timeoutMs);
    child.on("error", () => finish(false));
    child.on("exit", (code) => finish(code === 0));
  });
}

/**
 * 返回转换后的 PDF 绝对路径；不可转换或失败时返回 null。
 * `stat` 是源文件的 stat，用来做缓存键。
 */
async function convertOfficeToPdf({ abs, stat, dataPath, scriptPath, timeoutMs = 120000 }) {
  const extension = path.extname(abs).toLowerCase();
  if (!OFFICE_EXTENSIONS.has(extension)) return null;

  const dir = path.join(dataPath, CACHE_DIR);
  const target = path.join(dir, `${cacheKey(abs, stat)}.pdf`);

  try {
    const cached = await fs.stat(target);
    if (cached.size > 0 && Date.now() - cached.mtimeMs < CACHE_TTL_MS) return target;
  } catch {
    /* not cached yet */
  }

  await fs.mkdir(dir, { recursive: true });
  const temp = `${target}.${Date.now().toString(36)}.tmp.pdf`;
  const ok = await runPowerShell(scriptPath, abs, temp, timeoutMs);
  if (!ok) {
    await fs.rm(temp, { force: true }).catch(() => {});
    return null;
  }
  try {
    const produced = await fs.stat(temp);
    if (produced.size === 0) throw new Error("empty conversion");
    await fs.rename(temp, target);
    return target;
  } catch {
    await fs.rm(temp, { force: true }).catch(() => {});
    return null;
  }
}

/** 缓存目录会随文档反复修改而增长，顺手清掉过期条目。 */
async function pruneOfficeCache(dataPath) {
  const dir = path.join(dataPath, CACHE_DIR);
  const entries = await fs.readdir(dir).catch(() => []);
  const now = Date.now();
  for (const name of entries) {
    if (!name.endsWith(".pdf")) continue;
    const full = path.join(dir, name);
    const stat = await fs.stat(full).catch(() => null);
    if (stat && now - stat.mtimeMs > CACHE_TTL_MS) await fs.rm(full, { force: true }).catch(() => {});
  }
}

module.exports = { OFFICE_EXTENSIONS, convertOfficeToPdf, pruneOfficeCache };
