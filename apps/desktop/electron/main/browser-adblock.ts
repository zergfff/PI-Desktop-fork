/**
 * Ad and tracker blocking for the preview browser, driven by one local list.
 *
 * Extensions cannot do this job here: Electron grants a Manifest V3 blocker its
 * `declarativeNetRequest` permission and then never enforces the ruleset (a
 * one-rule probe extension loaded fine and its script still executed), while the
 * host's own `webRequest.onBeforeRequest` does cancel. So the filter lives here.
 *
 * `~/.pi-desktop/adblock.txt` is the whole configuration — there is no online
 * subscription list to merge, by request. It accepts the Adblock Plus syntax that
 * published lists actually use, so EasyList, EasyList China or an AdGuard list can
 * be pasted in as-is:
 *
 *   ||example.com^              host and everything under it
 *   ||example.com/api/*banners* host + path, `*` is any run of characters
 *   ||example.com^$script,third-party   resource types and third-party scope
 *   ||example.com^$domain=a.com|~b.com  only when the page is a.com, not b.com
 *   @@||example.com^            whitelist, wins over any block
 *   @@||example.com^$document   allow a whole document (ad-block walls)
 *   /banner[0-9]+\.gif/         regular expression
 *   |https://cdn.example.com/   anchored to the start of the URL
 *   ##.ad-slot                  hide the element
 *   example.com##.ad-slot       hide it only on that site
 *   #@#.ad-slot                 stop hiding it
 *   ! comment                   ignored
 *
 * `$document` blocks are deliberately not applied to the main frame: a list entry
 * that blocks a whole site would turn the page blank, which reads as "the browser
 * is broken" rather than "this page is ad-free".
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Session } from "electron";

const LIST_FILE = "adblock.txt";
const STATE_FILE = "adblock.json";

/**
 * A conservative starter list: ad exchanges, analytics and the Chinese tracker
 * domains that show up on ordinary pages. Anything aggressive belongs in the
 * reader's own edits, where a false positive is theirs to correct.
 */
const DEFAULT_RULES = [
  "! PI-Desktop 广告拦截规则（Adblock Plus 语法；@@ 开头为白名单，## 开头为元素隐藏）",
  "! 可以直接粘贴 EasyList / EasyList China / AdGuard 列表的内容；保存后右键 → 编辑拦截规则… 再关掉重开页面即生效。",
  "||doubleclick.net^",
  "||googlesyndication.com^",
  "||googleadservices.com^",
  "||google-analytics.com^",
  "||googletagmanager.com^",
  "||adservice.google.com^",
  "||amazon-adsystem.com^",
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
  "||hm.baidu.com^",
  "||pos.baidu.com^",
  "||cpro.baidu.com^",
  "||cbjs.baidu.com^",
  "||eclick.baidu.com^",
  "||tanx.com^",
  "||mmstat.com^",
  "||cnzz.com^",
  "||umeng.com^",
  "||umengcloud.com^",
  "||growingio.com^",
  "||talkingdata.com^",
  "||gdt.qq.com^",
  "||e.qq.com^",
  "||pingjs.qq.com^",
  "||miaozhen.com^",
  "##ins.adsbygoogle",
  "##.adsbygoogle",
  '##div[id^="div-gpt-ad"]',
  '##iframe[src*="doubleclick.net"]',
  '##iframe[src*="googlesyndication.com"]',
];

/** Electron's `resourceType` values mapped onto Adblock Plus type names. */
const TYPE_ALIASES: Record<string, string> = {
  mainFrame: "document",
  subFrame: "subdocument",
  stylesheet: "stylesheet",
  script: "script",
  image: "image",
  font: "font",
  object: "object",
  xhr: "xmlhttprequest",
  ping: "ping",
  cspReport: "other",
  media: "media",
  webSocket: "websocket",
  other: "other",
};

export type AdblockContext = {
  url: string;
  /** Electron resource type: script, image, mainFrame, … */
  resourceType?: string;
  /** Page that initiated the request, when Chromium reports it. */
  initiator?: string;
  /** Host of the pane's own document; used for domain-scoped rules and cosmetics. */
  frameHost?: string;
  frameUrl?: string;
};

type NetworkRule = {
  block: boolean;
  /** Host rule (`||host^`), matched against the URL host. */
  host?: string;
  /** Everything else is one compiled pattern over the full URL. */
  pattern?: RegExp;
  /** Allowed resource types; empty means every type. */
  types?: Set<string>;
  excludedTypes?: Set<string>;
  /** `$domain=` restriction over the page host. */
  includeDomains?: string[];
  excludeDomains?: string[];
  /** `$third-party` / `$~third-party`. */
  thirdParty?: boolean;
  matchCase?: boolean;
};

type CosmeticRule = {
  selector: string;
  hide: boolean;
  includeDomains?: string[];
  excludeDomains?: string[];
};

export type AdblockRuleSet = {
  network: NetworkRule[];
  cosmetic: CosmeticRule[];
};

export type AdblockStats = {
  blocked: number;
  topHosts: Array<{ host: string; count: number }>;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Absolute path of the list. */
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
 * Compile one network rule, or `undefined` when it cannot be expressed.
 *
 * `^` is Adblock Plus' separator — "a character that is not a letter, digit, `%`,
 * `.` or `-`, or the end of the address" — and is translated rather than dropped,
 * because published lists use it in almost every path rule.
 */
function compileNetworkRule(line: string, block: boolean): NetworkRule | undefined {
  let body = line;
  let options: string[] = [];
  const dollar = body.lastIndexOf("$");
  // A `$` inside a regex or after the address part is an option list; only treat
  // it as such when it looks like one.
  if (dollar > 0 && /^[a-z0-9_.,~=|*-]+$/i.test(body.slice(dollar + 1))) {
    options = body
      .slice(dollar + 1)
      .split(",")
      .map((option) => option.trim().toLowerCase())
      .filter(Boolean);
    body = body.slice(0, dollar);
  }
  if (!body) return undefined;

  const rule: NetworkRule = { block };
  for (const option of options) {
    if (option === "match-case") {
      rule.matchCase = true;
      continue;
    }
    if (option === "third-party") {
      rule.thirdParty = true;
      continue;
    }
    if (option === "~third-party" || option === "first-party") {
      rule.thirdParty = false;
      continue;
    }
    if (option.startsWith("domain=")) {
      const domains = option
        .slice("domain=".length)
        .split("|")
        .map((domain) => domain.trim().replace(/^~/, "~").toLowerCase())
        .filter(Boolean);
      const include = domains.filter((domain) => !domain.startsWith("~"));
      const exclude = domains.filter((domain) => domain.startsWith("~")).map((domain) => domain.slice(1));
      if (include.length) rule.includeDomains = include;
      if (exclude.length) rule.excludeDomains = exclude;
      continue;
    }
    if (option === "popup" || option === "elemhide" || option === "generichide") return undefined;
    if (option === "document") {
      // Blocking a whole document blanks the pane, so a blocking `$document` rule
      // is skipped rather than downgraded. A whitelisting one is the common case
      // ("this site is fine"), and it may only apply to the document itself —
      // otherwise a single `@@||site^$document` would unblock every tracker on it.
      if (block) return undefined;
      rule.types = rule.types ?? new Set();
      rule.types.add("document");
      continue;
    }
    if (option === "important") continue;
    if (option.startsWith("~")) {
      rule.excludedTypes = rule.excludedTypes ?? new Set();
      rule.excludedTypes.add(option.slice(1));
      continue;
    }
    if (KNOWN_TYPES.has(option)) {
      rule.types = rule.types ?? new Set();
      rule.types.add(option);
      continue;
    }
    // Unknown option: keep the rule, ignore the option.
  }

  // Regular expression rule.
  if (body.length > 2 && body.startsWith("/") && body.endsWith("/")) {
    try {
      rule.pattern = new RegExp(body.slice(1, -1), rule.matchCase ? "" : "i");
    } catch {
      return undefined;
    }
    return rule;
  }

  // `||` anchors the *host*, not the URL: it must be consumed before looking for a
  // single `|` URL anchor, otherwise every `||host^` rule compiles into an anchored
  // pattern that can never match a full URL.
  const domainAnchor = body.startsWith("||");
  if (domainAnchor) body = body.slice(2);
  const anchoredStart = body.startsWith("|");
  const anchoredEnd = body.endsWith("|");
  const core = body.replace(/^\|+/, "").replace(/\|+$/, "");

  const hostOnly = /^([^/^*]+)\^?$/.exec(core);
  if (domainAnchor && hostOnly && !anchoredStart && !anchoredEnd) {
    const host = hostOnly[1].toLowerCase().replace(/^\.+/, "");
    if (!host || host.includes("*") || !host.includes(".")) return undefined;
    rule.host = host;
    return rule;
  }

  const separator = "(?:[^\\w\\u00a0-\\u02ff\\u0370-\\u1fff\\u2000-\\u206f\\u2070-\\u2fff\\u3040-\\uffff.%-]|$)";
  const source = core
    .split("*")
    .map((part) => part.split("^").map(escapeRegExp).join(separator))
    .join(".*");
  if (source.length < 3) return undefined;
  const prefix = anchoredStart ? "^" : "";
  const suffix = anchoredEnd ? "$" : "";
  try {
    rule.pattern = new RegExp(`${prefix}${source}${suffix}`, rule.matchCase ? "" : "i");
  } catch {
    return undefined;
  }
  return rule;
}

const KNOWN_TYPES = new Set([
  "document",
  "subdocument",
  "stylesheet",
  "script",
  "image",
  "font",
  "object",
  "xmlhttprequest",
  "ping",
  "media",
  "websocket",
  "other",
]);

/** Compile a cosmetic line (`##selector`, `site##selector`, `#@#selector`). */
function compileCosmeticRule(line: string, hide: boolean): CosmeticRule | undefined {
  const marker = hide ? "##" : "#@#";
  const index = line.indexOf(marker);
  if (index < 0) return undefined;
  const scope = line.slice(0, index).trim().toLowerCase();
  const selector = line.slice(index + marker.length).trim();
  if (!selector || /[{}\\]/.test(selector)) return undefined;
  const rule: CosmeticRule = { selector, hide };
  if (scope) {
    const domains = scope.split(",").map((domain) => domain.trim()).filter(Boolean);
    const include = domains.filter((domain) => !domain.startsWith("~"));
    const exclude = domains.filter((domain) => domain.startsWith("~")).map((domain) => domain.slice(1));
    if (include.length) rule.includeDomains = include;
    if (exclude.length) rule.excludeDomains = exclude;
  }
  return rule;
}

/**
 * Parse the whole list.
 *
 * An unparseable line is skipped, never approximated: a cosmetic selector must not
 * turn into a network block, and a path rule must not decay into a host block.
 */
export function parseAdblockRules(text: string): AdblockRuleSet {
  const rules: AdblockRuleSet = { network: [], cosmetic: [] };
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("!") || line.startsWith("[")) continue;

    const cosmeticIndex = line.indexOf("#@#");
    if (cosmeticIndex >= 0) {
      const rule = compileCosmeticRule(line, false);
      if (rule) rules.cosmetic.push(rule);
      continue;
    }
    if (line.includes("##")) {
      const rule = compileCosmeticRule(line, true);
      if (rule) rules.cosmetic.push(rule);
      continue;
    }
    if (line.includes("#?#")) continue;

    let body = line;
    let block = true;
    if (body.startsWith("@@")) {
      block = false;
      body = body.slice(2);
    }
    const rule = compileNetworkRule(body, block);
    if (rule) rules.network.push(rule);
  }
  return rules;
}

/** Read and compile the list; a missing file yields the starter rules. */
export function loadAdblockRules(dataDir: string): AdblockRuleSet {
  const file = ensureAdblockList(dataDir);
  return parseAdblockRules(readFileSync(file, "utf8"));
}

function hostMatchesDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

function domainAllowed(rule: NetworkRule | CosmeticRule, pageHost: string): boolean {
  if (rule.includeDomains?.length) {
    if (!rule.includeDomains.some((domain) => hostMatchesDomain(pageHost, domain))) return false;
  }
  if (rule.excludeDomains?.length) {
    if (rule.excludeDomains.some((domain) => hostMatchesDomain(pageHost, domain))) return false;
  }
  return true;
}

function typesMatch(rule: NetworkRule, type: string): boolean {
  if (rule.types?.size && !rule.types.has(type)) return false;
  if (rule.excludedTypes?.has(type)) return false;
  return true;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isThirdParty(requestHost: string, pageHost: string): boolean {
  if (!requestHost || !pageHost) return false;
  return !hostMatchesDomain(requestHost, pageHost);
}

/**
 * Should this request be cancelled?
 *
 * Whitelists win: one matching `@@` rule beats any number of blocks, which is how
 * Adblock Plus behaves and what a reader expects after adding an exception.
 */
export function adblockShouldBlock(
  rules: AdblockRuleSet,
  context: AdblockContext | string,
  legacyPageHost?: string,
): boolean {
  const ctx: AdblockContext =
    typeof context === "string" ? { url: context, frameHost: legacyPageHost } : context;
  const url = ctx.url;
  const host = hostOf(url);
  if (!host) return false;
  // The page host decides third-party and `$domain=`. Prefer the tracked
  // main-frame host, fall back to the reported initiator, then assume first-party.
  const pageHost = ctx.frameHost || (ctx.initiator ? hostOf(ctx.initiator) : "") || host;
  const type = TYPE_ALIASES[ctx.resourceType ?? ""] ?? "other";
  const thirdParty = isThirdParty(host, pageHost);

  const matches = (rule: NetworkRule): boolean => {
    if (!typesMatch(rule, type)) return false;
    if (rule.thirdParty !== undefined && rule.thirdParty !== thirdParty) return false;
    if (!domainAllowed(rule, pageHost)) return false;
    if (rule.host) return hostMatchesDomain(host, rule.host);
    if (rule.pattern) return rule.pattern.test(url);
    return false;
  };

  if (rules.network.some((rule) => !rule.block && matches(rule))) return false;
  return rules.network.some((rule) => rule.block && matches(rule));
}

/** Cosmetic selectors that apply to `pageHost`, with `#@#` exceptions honoured. */
export function adblockCosmeticSelectors(rules: AdblockRuleSet, pageHost: string): string[] {
  const hidden = new Set<string>();
  const exceptions = new Set<string>();
  for (const rule of rules.cosmetic) {
    if (!domainAllowed(rule, pageHost)) continue;
    if (rule.hide) hidden.add(rule.selector);
    else exceptions.add(rule.selector);
  }
  for (const selector of exceptions) hidden.delete(selector);
  return [...hidden];
}

/** CSS that hides the cosmetic matches for one page. */
export function adblockCosmeticCss(rules: AdblockRuleSet, pageHost: string): string {
  const selectors = adblockCosmeticSelectors(rules, pageHost);
  if (!selectors.length) return "";
  return `${selectors.join(",\n")} { display: none !important; }`;
}

type AdblockState = { enabled: boolean };

/** Persisted on/off switch; blocking is on unless the reader turned it off. */
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
  writeFileSync(join(dataDir, STATE_FILE), `${JSON.stringify({ enabled }, null, 2)}\n`, "utf8");
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
 * `webRequest` allows one listener per event per session, so this must run once for
 * the browser partition, never per view. The page host is tracked from main-frame
 * requests, which is what makes `$domain=`, third-party and domain-scoped cosmetic
 * rules behave.
 */
export function installAdblock(
  session: Session,
  resolve: () => { enabled: boolean; rules: AdblockRuleSet },
  runtime: AdblockRuntime,
): void {
  const frameHosts = new Map<number, string>();
  session.webRequest.onBeforeRequest(
    { urls: ["http://*/*", "https://*/*"] },
    (details, callback) => {
      const host = hostOf(details.url);
      if (details.resourceType === "mainFrame") {
        frameHosts.set(details.webContentsId ?? -1, host);
        runtime.reset();
        callback({});
        return;
      }
      const { enabled, rules } = resolve();
      if (!enabled) {
        callback({});
        return;
      }
      // Chromium reports the initiating page on some (not all) builds and it is
      // absent from Electron's typings; the tracked main-frame host covers the rest.
      const initiator = (details as { initiator?: string }).initiator;
      const frameHost = frameHosts.get(details.webContentsId ?? -1) ?? hostOf(initiator ?? "");
      if (adblockShouldBlock(rules, {
        url: details.url,
        resourceType: details.resourceType,
        ...(initiator ? { initiator } : {}),
        frameHost,
      })) {
        runtime.note(host);
        callback({ cancel: true });
        return;
      }
      callback({});
    },
  );
}
