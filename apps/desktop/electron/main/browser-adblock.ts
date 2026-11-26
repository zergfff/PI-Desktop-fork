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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  return parseAdblockRules(readFileSync(file, "utf8"));
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

type AdblockState = { enabled: boolean };

/** Persisted on/off switch; blocking is on unless the user turned it off. */
export function readAdblockEnabled(dataDir: string): boolean {
  const file = join(dataDir, STATE_FILE);
  if (!existsSync(file)) return true;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<AdblockState>;
    return parsed.enabled !== false;
  } catch {
    return true;
  }
}

export function writeAdblockEnabled(dataDir: string, enabled: boolean): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    join(dataDir, STATE_FILE),
    `${JSON.stringify({ enabled } satisfies AdblockState, null, 2)}\n`,
    "utf8",
  );
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
