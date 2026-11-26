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
      const host = line
        .slice(2)
        .split("^")[0]
        .split("/")[0]
        .replace(/^\*\./, "")
        .toLowerCase();
      if (!host || /[*|]/.test(host)) continue;
      (allow ? rules.allowHosts : rules.blockHosts).add(host);
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

/** `||host^` rules from an online list, with cosmetic and path rules skipped. */
export function parseHostRules(text: string, into: Set<string>): void {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("||")) continue;
    const host = line
      .slice(2)
      .split("^")[0]
      .split("/")[0]
      .split("$")[0]
      .replace(/^\*\./, "")
      .toLowerCase();
    if (!host || /[*|#]/.test(host) || host.length > 253) continue;
    into.add(host);
  }
}

/** Merge the cached online lists into a rule set (host rules only). */
export function mergeOnlineLists(dataDir: string, rules: AdblockRuleSet): AdblockRuleSet {
  const dir = listCacheDir(dataDir);
  if (!existsSync(dir)) return rules;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".txt")) continue;
    try {
      parseHostRules(readFileSync(join(dir, name), "utf8"), rules.blockHosts);
    } catch {
      // a corrupt cache entry must not stop the local list from working
    }
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
