"use strict";

/**
 * 标注草稿：先记下来，点保存才写进 PDF。
 *
 * 直接写回文件的做法有两个问题：误点一下就改了用户的原件；来回试几种划线会把文件
 * 重写好几遍。草稿放在插件数据目录里（不动用户的文件夹），保存时才合并成 PDF 注释
 * 对象，放弃就删掉。草稿按绝对路径索引，标签关掉、应用重启后仍在，所以重开文件能
 * 接着上次的改动继续。
 */

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const DRAFT_DIR = "pdf-annotations";
const MAX_OPS = 400;

function draftStore(dataPath) {
  const dir = path.join(dataPath, DRAFT_DIR);
  const fileFor = (abs) => {
    const digest = crypto.createHash("sha1").update(abs).digest("hex").slice(0, 24);
    return path.join(dir, `${digest}.json`);
  };

  return {
    async read(abs) {
      try {
        const raw = await fs.readFile(fileFor(abs), "utf8");
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed?.ops) ? parsed.ops : [];
      } catch {
        return [];
      }
    },

    async append(abs, ops) {
      const existing = await this.read(abs);
      const merged = [...existing, ...ops].slice(-MAX_OPS);
      await fs.mkdir(dir, { recursive: true });
      const payload = { path: abs, ops: merged, updatedAt: new Date().toISOString() };
      const tmp = `${fileFor(abs)}.${Date.now().toString(36)}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(payload), "utf8");
      await fs.rename(tmp, fileFor(abs));
      return merged;
    },

    async clear(abs) {
      await fs.rm(fileFor(abs), { force: true });
    },

    /** 有草稿的文件数量，供「有没有忘保存的东西」这类总览使用。 */
    async count() {
      const entries = await fs.readdir(dir).catch(() => []);
      return entries.filter((name) => name.endsWith(".json")).length;
    },
  };
}

module.exports = { draftStore };
