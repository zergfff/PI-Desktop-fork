/**
 * Network-level ad and tracker blocking for the preview browser.
 *
 * Extensions cannot do this job here. A Manifest V3 blocker such as uBlock Lite
 * loads into the session and then blocks nothing: Electron hands the extension
 * its `declarativeNetRequest` permission but never enforces the static ruleset —
 * measured on Electron 43 with a one-rule extension whose `/blocked.js` still
 * executed. What *is* enforced is the host's own `webRequest.onBeforeRequest`,
 * so the filter runs there instead: one listener on the browser partition, a
 * user-editable list, and a counter the page menu can show.
 *
 * The list file is `<data dir>/adblock.txt`, Adblock Plus syntax as far as it
 * matters for requests:
 *   `||example.com^`   block the host and everything under it
 *   `@@||example.com^` never block it (whitelist, wins over blocks)
 *   `/ads/banner`      block any URL containing the text (`*` works as a wildcard)
 *   `! comment`        ignored, as are cosmetic rules (`##`) — nothing injects CSS
 * Options after `$` are dropped, so `$third-party,script` degrades to a plain
 * block rather than being misread.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Session } from "electron";

const LIST_FILE = "adblock.txt";
const STATE_FILE = "adblock.json";
/** Merged online hosts, written for inspection. */
export const ONLINE_SUMMARY_FILE = "adblock-online.txt";

/**
 * A deliberately conservative starter list: the ad exchanges, analytics and
 * Chinese tracker domains that show up on ordinary pages. Anything aggressive
 * belongs in the user's own list, where a false positive is theirs to correct.
 */
const DEFAULT_RULES = [
  "! PI-Desktop 广告拦截规则（Adblock Plus 语法；@@ 开头为白名单）",
  "! 直接编辑本文件即可生效，重启或重开浏览器页后加载。",
  "||doubleclick.net^",
  "||googlesyndication.com^",
  "||googleadservices.com^",
  "||google-analytics.com^",
  "||googletagmanager.com^",
  "||adservice.google.com^",
  "||amazon-adsystem.com^",
  "||ads.yahoo.com^",
  "||adnxs.com^",
  "||criteo.com^",
  "||criteo.net^",
  "||taboola.com^",
  "||outbrain.com^",
  "||scorecardresearch.com^",
  "||quantserve.com^",
  "||moatads.com^",
  "||pubmatic.com^",
  "||rubiconproject.com^",
  "||openx.net^",
  "||smartadserver.com^",
  "||adform.net^",
  "||bing.com/bat.js",
  "||hm.baidu.com^",
  "||pos.baidu.com^",
  "||cpro.baidu.com^",
  "||cbjs.baidu.com^",
  "||eclick.baidu.com^",
  "||union.baidu.com^",
  "||tanx.com^",
  "||mmstat.com^",
  "||cnzz.com^",
  "||umeng.com^",
  "||umengcloud.com^",
  "||growingio.com^",
  "||talkingdata.com^",
  "||adsmind.apdcdn.tc.qq.com^",
  "||gdt.qq.com^",
  "||e.qq.com^",
  "||pingjs.qq.com^",
  "||miaozhen.com^",
  "||advertising.apple.com^",
  "/ad-banner",
  "/ads/banner",
  "##ins.adsbygoogle",
  "##.adsbygoogle",
  '##div[id^="div-gpt-ad"]',
  '##iframe[src*="doubleclick.net"]',
  '##iframe[src*="googlesyndication.com"]',
];

export type AdblockRuleSet = {
  blockHosts: Set<string>;
  blockPatterns: RegExp[];
  allowHosts: Set<string>;
  allowPatterns: RegExp[];
  /** `##selector` rules: hidden in the page, not blocked on the wire. */
  cosmeticSelectors: string[];
};

export type AdblockStats = {
  blocked: number;
  /** Hosts that were blocked most often, for the menu's summary. */
  topHosts: Array<{ host: string; count: number }>;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Absolute path of the user's list. */
export function adblockListPath(dataDir: string): string {
  return join(dataDir, LIST_FILE);
}

/** Create the starter list once, so there is always a file to edit. */
export function ensureAdblockList(dataDir: string): string {
  const file = adblockListPath(dataDir);
  if (!existsSync(file)) {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(file, `${DEFAULT_RULES.join("\n")}\n`, "utf8");
  }
  return file;
}

/**
 * Rewrite `adblock.txt` from `adblock-online.txt`.
 *
 * The two files answer different questions — one is what the reader wrote, the
 * other what the subscriptions currently say — and a reader who wants the
 * subscriptions to *be* the list should not have to paste five thousand lines by
 * hand. Replacing is still destructive, so:
 *
 *  - the previous file is copied to `adblock.txt.bak-<timestamp>` first;
 *  - whitelist (`@@`) and cosmetic (`##`) lines survive, because they are the only
 *    thing in this file the online report cannot carry — dropping them would
 *    silently re-enable ads the reader had exempted and stop hiding their boxes;
 *  - the header says where the body came from and when.
 */
export function rewriteLocalListFromOnline(dataDir: string): {
  written: number;
  kept: number;
  backup?: string;
} {
  const listFile = ensureAdblockList(dataDir);
  const summaryFile = join(dataDir, ONLINE_SUMMARY_FILE);
  if (!existsSync(summaryFile)) return { written: 0, kept: 0 };
  const summary = readFileSync(summaryFile, "utf8");
  const online: string[] = [];
  let stamp = new Date().toISOString();
  for (const line of summary.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("!")) {
      const match = /更新时间：([^，]+)/.exec(trimmed);
      if (match) stamp = match[1].trim();
      continue;
    }
    online.push(trimmed);
  }
  if (!online.length) return { written: 0, kept: 0 };

  const existing = readFileSync(listFile, "utf8");
  const kept = existing
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("@@") || line.includes("##"));
  const backup = `${listFile}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  try {
    writeFileSync(backup, existing, "utf8");
  } catch {
    // no backup is a warning, not a reason to refuse the rewrite
  }

  const body = [
    "! PI-Desktop 广告拦截规则",
    `! 由在线列表重写于 ${new Date().toISOString()}（在线数据时间：${stamp}）`,
    `! 域名规则 ${online.length} 条；本文件里 @@ 白名单与 ## 元素隐藏规则在重写时保留`,
    "! 想保留手写的路径规则（/ads/banner 这类），请写在下面这段注释之前——重写会覆盖其它内容",
    ...kept,
    "",
    ...online.sort(),
    "",
  ].join("\n");
  writeFileSync(listFile, body, "utf8");
  return { written: online.length, kept: kept.length, backup };
}

/**
 * Parse the list.
 *
 * Rules that cannot be expressed as a request filter are skipped rather than
 * guessed at: a cosmetic rule must not turn into a network block.
 */
export function parseAdblockRules(text: string): AdblockRuleSet {
  const rules: AdblockRuleSet = {
    blockHosts: new Set(),
    blockPatterns: [],
    allowHosts: new Set(),
    allowPatterns: [],
    cosmeticSelectors: [],
  };
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith("!") || line.startsWith("[")) continue;
    // Cosmetic rules hide an element instead of cancelling a request. A
    // domain-prefixed rule (`example.com##.ad`) is applied everywhere rather
    // than risk hiding the wrong thing: the panel has one site at a time, and a
    // silent no-op would be worse than a slightly eager hide.
    const cosmetic = line.indexOf("##");
    if (cosmetic >= 0) {
      if (line.includes("#@#") || line.includes("#?#")) continue;
      const selector = line.slice(cosmetic + 2).trim();
      if (selector && !/[{}\\]/.test(selector)) rules.cosmeticSelectors.push(selector);
      continue;
    }
    let allow = false;
    if (line.startsWith("@@")) {
      allow = true;
      line = line.slice(2);
    }
    const dollar = line.indexOf("$");
    if (dollar >= 0) line = line.slice(0, dollar);
    line = line.trim();
    if (!line) continue;

    // `||domain^` — the host and every subdomain of it.
    if (line.startsWith("||")) {
      const body = line
        .slice(2)
        .split("^")[0]
        .replace(/^\*\./, "");
      // A path makes it an address rule, not a host rule: truncating
      // `||zhihu.com/api/*banners/` to `zhihu.com` would block the whole site.
      if (!body.includes("/")) {
        const host = body.toLowerCase();
        if (!host || /[*|]/.test(host)) continue;
        (allow ? rules.allowHosts : rules.blockHosts).add(host);
        continue;
      }
      const asPattern = body
        .split("*")
        .map((part) => escapeRegExp(part))
        .join(".*");
      if (asPattern.length < 6) continue;
      const anchored = new RegExp(asPattern, "i");
      (allow ? rules.allowPatterns : rules.blockPatterns).push(anchored);
      continue;
    }
    // Anchored single-slash rules still work as substrings of the path.
    const pattern = line.replace(/^\|+/, "").replace(/\|+$/, "").replace(/^\/\//, "");
    if (pattern.length < 4) continue;
    const body = pattern
      .split("*")
      .map((part) => escapeRegExp(part))
      .join(".*");
    const regex = new RegExp(body, "i");
    (allow ? rules.allowPatterns : rules.blockPatterns).push(regex);
  }
  return rules;
}

/** Read and parse the list; a missing file yields the starter rules. */
export function loadAdblockRules(dataDir: string): AdblockRuleSet {
  const file = ensureAdblockList(dataDir);
  return mergeOnlineLists(dataDir, parseAdblockRules(readFileSync(file, "utf8")));
}

/**
 * CSS that hides cosmetic matches.
 *
 * `display: none !important` is the only property that reliably wins against a
 * page's own rules; the selectors come from the user's list and are validated in
 * the parser, so nothing here can escape the declaration block.
 */
export function adblockCosmeticCss(rules: AdblockRuleSet): string {
  if (!rules.cosmeticSelectors.length) return "";
  return `${rules.cosmeticSelectors.join(",\n")} { display: none !important; }`;
}

/** How many online host rules are currently merged, for the menu label. */
export function onlineRuleCount(dataDir: string): number {
  const file = join(dataDir, ONLINE_SUMMARY_FILE);
  if (!existsSync(file)) return 0;
  try {
    let count = 0;
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      if (line.trim() && !line.startsWith("!")) count += 1;
    }
    return count;
  } catch {
    return 0;
  }
}

/** True when the URL should be cancelled. Whitelists win. */
export function adblockShouldBlock(rules: AdblockRuleSet, url: string): boolean {
  let host: string;
  let path: string;
  try {
    const parsed = new URL(url);
    host = parsed.hostname.toLowerCase();
    path = `${parsed.pathname}${parsed.search}`;
  } catch {
    return false;
  }
  const hostMatches = (set: Set<string>): boolean => {
    for (const entry of set) {
      if (host === entry || host.endsWith(`.${entry}`)) return true;
    }
    return false;
  };
  if (hostMatches(rules.allowHosts)) return false;
  const allowByPath = rules.allowPatterns.some(
    (pattern) =>
      pattern.test(path) || pattern.test(`${host}${path}`) || pattern.test(url),
  );
  if (allowByPath) return false;
  if (hostMatches(rules.blockHosts)) return true;
  return rules.blockPatterns.some(
    (pattern) =>
      pattern.test(path) || pattern.test(`${host}${path}`) || pattern.test(url),
  );
}

type AdblockState = {
  enabled: boolean;
  /**
   * Online lists to merge in, in Addition to `adblock.txt`. Only `||host^` rules
   * are taken from them: a full EasyList is ~50k lines of path regexes, and
   * compiling those on every load costs more than the blocking is worth. Host
   * rules are a Set lookup and catch the bulk of ad traffic.
   */
  listUrls?: string[];
  /** ISO timestamp of the last successful refresh, for the menu label. */
  listsUpdatedAt?: string;
};

/** Persisted on/off switch; blocking is on unless the user turned it off. */
export function readAdblockEnabled(dataDir: string): boolean {
  return readAdblockSettings(dataDir).enabled;
}

export function writeAdblockEnabled(dataDir: string, enabled: boolean): void {
  writeAdblockSettings(dataDir, { ...readAdblockSettings(dataDir), enabled });
}

/** Whole settings record: the switch, the online sources and their timestamp. */
export function readAdblockSettings(dataDir: string): Required<Pick<AdblockState, "enabled">> &
  Pick<AdblockState, "listUrls" | "listsUpdatedAt"> {
  const file = join(dataDir, STATE_FILE);
  if (!existsSync(file)) return { enabled: true };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<AdblockState>;
    const listUrls = Array.isArray(parsed.listUrls)
      ? parsed.listUrls.filter((url): url is string => typeof url === "string" && /^https?:\/\//i.test(url.trim()))
      : undefined;
    return {
      enabled: parsed.enabled !== false,
      ...(listUrls?.length ? { listUrls } : {}),
      ...(typeof parsed.listsUpdatedAt === "string" ? { listsUpdatedAt: parsed.listsUpdatedAt } : {}),
    };
  } catch {
    return { enabled: true };
  }
}

export function writeAdblockSettings(
  dataDir: string,
  next: Required<Pick<AdblockState, "enabled">> & Pick<AdblockState, "listUrls" | "listsUpdatedAt">,
): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, STATE_FILE), `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

/** Where downloaded lists are cached, one file per source URL. */
function listCacheDir(dataDir: string): string {
  return join(dataDir, "adblock-cache");
}

function listCacheFile(dataDir: string, url: string): string {
  const hash = createHash("sha1").update(url).digest("hex").slice(0, 16);
  return join(listCacheDir(dataDir), `${hash}.txt`);
}

const MAX_LIST_BYTES = 12_000_000;

/**
 * Download every configured source into the cache.
 *
 * A failure of one source never discards another's cache: the caller reports
 * which URLs failed and the old copy keeps working.
 */
export async function refreshOnlineLists(
  dataDir: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<{ updated: number; failed: Array<{ url: string; error: string }> }> {
  const urls = readAdblockSettings(dataDir).listUrls ?? [];
  const failed: Array<{ url: string; error: string }> = [];
  let updated = 0;
  if (!urls.length) return { updated, failed };
  const fetchImpl = options.fetchImpl ?? fetch;
  mkdirSync(listCacheDir(dataDir), { recursive: true });
  for (const url of urls) {
    try {
      const response = await fetchImpl(url, {
        signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
        headers: { "User-Agent": "PI-Desktop adblock" },
      });
      if (!response.ok) {
        failed.push({ url, error: `HTTP ${response.status}` });
        continue;
      }
      const text = await response.text();
      if (!text.trim()) {
        failed.push({ url, error: "empty list" });
        continue;
      }
      if (text.length > MAX_LIST_BYTES) {
        failed.push({ url, error: `list too large (${text.length} bytes)` });
        continue;
      }
      writeFileSync(listCacheFile(dataDir, url), text, "utf8");
      updated += 1;
    } catch (error) {
      failed.push({ url, error: (error as Error).message ?? String(error) });
    }
  }
  writeAdblockSettings(dataDir, {
    ...readAdblockSettings(dataDir),
    listsUpdatedAt: new Date().toISOString(),
  });
  return { updated, failed };
}

/**
 * `||host^` rules from an online list.
 *
 * Only whole-host rules are taken. A rule with a path — `||zhihu.com/api/*banners/`
 * is one — must **not** be truncated to its host: doing that blocks the entire
 * site, which is exactly how a filter list turns a page blank. Path matching for
 * online lists is out of scope, so those lines are skipped; `$` options are
 * allowed only when they narrow resource types, never when they change the scope
 * (`$document`, `$domain=`, `$elemhide` would block documents or specific sites).
 */
export function parseHostRules(text: string, into: Set<string>): void {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("||")) continue;
    const match = /^\|\|([^/^$#|*]+)\^?((?:\$[a-z0-9_.,~-]+)?)$/i.exec(line);
    if (!match) continue;
    const options = (match[2] ?? "").toLowerCase();
    if (/document|popup|elemhide|generichide|domain=|third-party/.test(options)) continue;
    const host = match[1].trim().toLowerCase().replace(/^\*\./, "");
    if (!host || host.includes("*") || host.length > 253 || !host.includes(".")) continue;
    if (host.startsWith(".") || host.endsWith(".")) continue;
    into.add(host);
  }
}

/**
 * Merge the cached online lists into a rule set (host rules only).
 *
 * The merged hosts are also written to `adblock-online.txt` beside the local
 * list: without that file "更新在线规则" had no visible effect, and a reader had no
 * way to tell a successful download from a silent failure.
 */
export function mergeOnlineLists(dataDir: string, rules: AdblockRuleSet): AdblockRuleSet {
  const dir = listCacheDir(dataDir);
  if (!existsSync(dir)) return rules;
  const files = readdirSync(dir).filter((name) => name.endsWith(".txt"));
  if (!files.length) return rules;
  const online = new Set<string>();
  for (const name of files) {
    try {
      parseHostRules(readFileSync(join(dir, name), "utf8"), online);
    } catch {
      // a corrupt cache entry must not stop the local list from working
    }
  }
  for (const host of online) rules.blockHosts.add(host);
  try {
    const summary = join(dataDir, ONLINE_SUMMARY_FILE);
    const stamp = readAdblockSettings(dataDir).listsUpdatedAt ?? new Date().toISOString();
    writeFileSync(
      summary,
      [
        `! 由在线规则合并生成，供查看；修改请改 adblock.txt 或 adblock.json 的 listUrls`,
        `! 更新时间：${stamp}，域名规则：${online.size} 条（在线列表只取整域名规则）`,
        ...[...online].sort(),
        "",
      ].join("\n"),
      "utf8",
    );
  } catch {
    // the summary is a convenience; failing to write it must not break blocking
  }
  return rules;
}

/** Counters for the page menu; one instance per session. */
export function createAdblockRuntime() {
  let stats = { blocked: 0, hosts: new Map<string, number>() };
  return {
    note(host: string): void {
      stats.blocked += 1;
      stats.hosts.set(host, (stats.hosts.get(host) ?? 0) + 1);
    },
    snapshot(): AdblockStats {
      const topHosts = [...stats.hosts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([host, count]) => ({ host, count }));
      return { blocked: stats.blocked, topHosts };
    },
    reset(): void {
      stats = { blocked: 0, hosts: new Map() };
    },
  };
}

export type AdblockRuntime = ReturnType<typeof createAdblockRuntime>;

/**
 * Install the blocker on a session.
 *
 * `webRequest` allows one listener per event per session, so this must be called
 * once for the browser partition and never per view. Rules are re-read on each
 * navigation's first request via the resolver, which lets the menu reload an
 * edited list without recreating the session.
 */
export function installAdblock(
  session: Session,
  resolve: () => { enabled: boolean; rules: AdblockRuleSet },
  runtime: AdblockRuntime,
): void {
  session.webRequest.onBeforeRequest(
    { urls: ["http://*/*", "https://*/*"] },
    (details, callback) => {
      if (details.resourceType === "mainFrame") {
        runtime.reset();
        callback({});
        return;
      }
      const { enabled, rules } = resolve();
      if (!enabled) {
        callback({});
        return;
      }
      try {
        if (adblockShouldBlock(rules, details.url)) {
          runtime.note(new URL(details.url).hostname);
          callback({ cancel: true });
          return;
        }
      } catch {
        // a malformed URL is not worth blocking
      }
      callback({});
    },
  );
}
