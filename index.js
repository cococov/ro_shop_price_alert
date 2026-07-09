import { readFileSync, writeFileSync } from 'fs';
import { createInterface } from 'readline';

// ── Constants ────────────────────────────────────────────────────────

const ITEMS_PER_PAGE = 60;
const MAX_PAGES = 20;
const MIN_INTERVAL_MINUTES = 10;
const DEFAULT_INTERVAL_MINUTES = 15;
const DEFAULT_TOP_N = 5;
const MAX_TOP_N = 50;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 2;
const MAX_ITEMS = 30;

const DELAY = {
  betweenPages: { min: 2000, max: 4000 },
  betweenDetails: { min: 1000, max: 3000 },
  betweenItems: { min: 5000, max: 10000 },
};

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const SHOP_TRADING_URL = 'https://ro.gnjoylatam.com/en/intro/shop-search/trading';
const SHOP_DETAIL_ACTION_FALLBACK = '404ed8774f606f8b1eb689aac3cb179d34321adc53';

let cachedShopDetailAction = null;

// ── ANSI Colors & Styles ────────────────────────────────────────────

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bgBlue: '\x1b[44m',
  magenta: '\x1b[35m',
  eraseLine: '\x1b[2K',
};

// ── CLI Args ─────────────────────────────────────────────────────────

/** Parse CLI arguments. Returns overrides for config values. */
function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--interval' && args[i + 1]) {
      const val = parseInt(args[++i], 10);
      if (isNaN(val) || val < 1) {
        console.error(`${C.red}Error: --interval must be a positive number${C.reset}`);
        process.exit(1);
      }
      parsed.interval = val;
    } else if (args[i] === '--items-file' && args[i + 1]) {
      parsed.itemsFile = args[++i];
    } else if (args[i] === '--top' && args[i + 1]) {
      const val = parseInt(args[++i], 10);
      if (isNaN(val) || val < 1 || val > MAX_TOP_N) {
        console.error(`${C.red}Error: --top must be between 1 and ${MAX_TOP_N}${C.reset}`);
        process.exit(1);
      }
      parsed.topN = val;
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`${C.bold}${C.cyan}RO Shop Price Alert${C.reset}
Monitors Ragnarok Online shop listings and shows the cheapest prices.

${C.bold}Usage:${C.reset}
  node index.js [options]

${C.bold}Options:${C.reset}
  --interval <min>    Polling interval in minutes (min: ${MIN_INTERVAL_MINUTES}, default: 15)
  --items-file <path> Path to items config file (default: ./items.json)
  --top <n>           Number of cheapest shops to show (1-${MAX_TOP_N}, default: ${DEFAULT_TOP_N})
  -h, --help          Show this help

${C.bold}Interactive commands (Tab completion available):${C.reset}
  /add-item <name>         Add an item to track
  /remove-item <name>      Remove an item from tracking
  /change-interval <min>   Change polling interval
  /change-top <n>          Change number of top results
  /list                    Show current config and tracked items
  /check                   Run a price check immediately
  /clear                   Clear the screen
  /help                    Show available commands
  /quit                    Exit the program

${C.bold}Config (items.json):${C.reset}
  {
    "intervalMinutes": 15,        // polling interval (min: ${MIN_INTERVAL_MINUTES})
    "server": "FREYA",            // RO server name
    "storeType": "BUY",           // "BUY" or "SELL"
    "topN": 5,                    // top cheapest shops (1-${MAX_TOP_N})
    "items": ["Item Name", ...]   // items to track (max: ${MAX_ITEMS})
  }
`);
      process.exit(0);
    }
  }
  return parsed;
}

// ── Utilities ────────────────────────────────────────────────────────

/** Sleep for a given number of milliseconds. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Sleep for a random duration within a {min, max} range. */
function randomDelay({ min, max }) {
  return sleep(min + Math.random() * (max - min));
}

/** Truncate a string to `len` chars (with ellipsis) and pad to fixed width. */
function truncPad(str, len) {
  if (str.length > len) return str.slice(0, len - 1) + '\u2026';
  return str.padEnd(len);
}

/** Format a number as Ragnarok zeny (e.g., "1,200,000z"). */
function formatZeny(n) {
  return n.toLocaleString('en-US') + 'z';
}

// ── Spinner ──────────────────────────────────────────────────────────

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * Create an animated spinner that writes to stdout.
 * Call `.update(label)` to change the text, `.stop()` to clear.
 */
function createSpinner(label) {
  let i = 0;
  const id = setInterval(() => {
    const frame = SPINNER_FRAMES[i++ % SPINNER_FRAMES.length];
    process.stdout.write(`${C.eraseLine}\r  ${C.yellow}${frame}${C.reset} ${label}`);
  }, 80);
  return {
    update(newLabel) { label = newLabel; },
    stop() {
      clearInterval(id);
      process.stdout.write(`${C.eraseLine}\r`);
    },
  };
}

// ── Config ───────────────────────────────────────────────────────────

/**
 * @typedef {object} AppConfig
 * @property {number}   intervalMinutes - Polling interval in minutes (min: MIN_INTERVAL_MINUTES).
 * @property {string}   server          - RO server name (e.g., "FREYA").
 * @property {string}   storeType       - Shop type: "BUY" or "SELL".
 * @property {number}   topN            - Number of cheapest shops to display (1-MAX_TOP_N).
 * @property {string[]} items           - Item names to track.
 */

/**
 * Load and validate the items.json config file.
 * @param {string|URL} filePath - Path to config file.
 * @returns {AppConfig} Validated config.
 * @throws {Error} If the file is unreadable or the schema is invalid.
 */
function loadConfig(filePath) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (e) {
    throw new Error(`Could not read config: ${e.message}`);
  }

  if (!raw || typeof raw !== 'object') {
    throw new Error('Config must be a JSON object');
  }
  if (!Array.isArray(raw.items)) {
    throw new Error('"items" must be an array of strings');
  }
  if (!raw.items.every((i) => typeof i === 'string' && i.trim().length > 0)) {
    throw new Error('Each item must be a non-empty string');
  }

  const validStoreTypes = ['BUY', 'SELL'];
  if (raw.storeType && !validStoreTypes.includes(raw.storeType)) {
    throw new Error(`"storeType" must be one of: ${validStoreTypes.join(', ')}`);
  }

  if (raw.intervalMinutes !== undefined) {
    if (typeof raw.intervalMinutes !== 'number' || raw.intervalMinutes < MIN_INTERVAL_MINUTES) {
      throw new Error(`"intervalMinutes" must be a number >= ${MIN_INTERVAL_MINUTES}`);
    }
  }

  if (raw.topN !== undefined) {
    if (typeof raw.topN !== 'number' || raw.topN < 1 || raw.topN > MAX_TOP_N) {
      throw new Error(`"topN" must be a number between 1 and ${MAX_TOP_N}`);
    }
  }

  return {
    intervalMinutes: raw.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES,
    server: raw.server ?? 'FREYA',
    storeType: raw.storeType ?? 'BUY',
    topN: raw.topN ?? DEFAULT_TOP_N,
    items: raw.items,
  };
}

/**
 * Save the current runtime config back to the JSON file.
 * @param {string|URL} filePath - Path to config file.
 * @param {AppConfig} config - Config to persist.
 */
function saveConfig(filePath, config) {
  const data = {
    intervalMinutes: config.intervalMinutes,
    server: config.server,
    storeType: config.storeType,
    topN: config.topN,
    items: config.items,
  };
  writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
}

// ── API Client ───────────────────────────────────────────────────────

/**
 * Parse a Next.js RSC (React Server Component) streaming response.
 * Each line is formatted as `<hex-id>:<json-payload>`.
 * @param {string} text - Raw RSC response body.
 * @param {(parsed: unknown) => T | undefined} predicate - Returns a value to extract, or undefined to skip.
 * @returns {T | null} The first extracted value, or null if none matched.
 */
function parseRscResponse(text, predicate) {
  for (const line of text.split('\n')) {
    const match = line.match(/^[0-9a-f]+:(.+)$/);
    if (!match) continue;
    try {
      const parsed = JSON.parse(match[1]);
      const result = predicate(parsed);
      if (result !== undefined) return result;
    } catch { /* skip non-JSON lines */ }
  }
  return null;
}

const COMMON_HEADERS = {
  'accept-language': 'en,es-ES;q=0.9,es;q=0.8,en-US;q=0.7',
  'cache-control': 'no-cache',
  'pragma': 'no-cache',
  'user-agent': USER_AGENT,
  'sec-ch-ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-site': 'same-origin',
  'sec-fetch-mode': 'cors',
  'sec-fetch-dest': 'empty',
};

/**
 * Fetch with retry, timeout, and HTTP status checking.
 * Throws 'RATE_LIMITED' on 429 or 'BLOCKED' on 403 to abort the cycle.
 * @param {string} url - URL to fetch.
 * @param {RequestInit} options - Fetch options.
 * @param {object} [retryOpts] - Retry configuration.
 * @param {number} [retryOpts.maxRetries=MAX_RETRIES] - Maximum retry attempts.
 * @param {string} [retryOpts.label=''] - Label for error messages.
 * @returns {Promise<Response>}
 */
async function safeFetch(url, options = {}, { maxRetries = MAX_RETRIES, label = '' } = {}) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { ...COMMON_HEADERS, ...options.headers },
      });

      if (res.status === 429) throw new Error('RATE_LIMITED');
      if (res.status === 403) throw new Error('BLOCKED');
      if (res.status >= 500 && attempt < maxRetries) {
        const wait = 30_000 + Math.random() * 30_000;
        process.stderr.write(`\n  ${C.yellow}Server error ${res.status}${label ? ` (${label})` : ''}, retrying in ${Math.round(wait / 1000)}s...${C.reset}\n`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return res;
    } catch (err) {
      if (err.message === 'RATE_LIMITED' || err.message === 'BLOCKED') throw err;
      if (attempt < maxRetries) {
        const wait = 10_000 + Math.random() * 10_000;
        await sleep(wait);
        continue;
      }
      throw err;
    }
  }
  // Unreachable: loop always returns or throws, but satisfy TypeScript/linters
  throw new Error('safeFetch: exhausted retries');
}

/**
 * Fetch a single page of shop search results.
 * @param {object} params
 * @param {string} params.searchWord - Item name to search for.
 * @param {string} params.storeType  - "BUY" or "SELL".
 * @param {string} params.serverType - Server name (e.g., "FREYA").
 * @param {number} [params.page=1]   - Page number.
 * @returns {Promise<{list: object[], totalCount: number} | null>}
 */
async function fetchShopPage({ searchWord, storeType, serverType, page = 1 }) {
  const encodedSearch = encodeURIComponent(searchWord);
  const url = `${SHOP_TRADING_URL}?storeType=${storeType}&serverType=${serverType}&searchWord=${encodedSearch}&p=${page}`;

  const res = await safeFetch(url, {
    headers: {
      'accept': '*/*',
      'next-url': '/en/intro/shop-search/trading',
      'rsc': '1',
      'Referer': `${SHOP_TRADING_URL}?storeType=${storeType}&serverType=${serverType}&searchWord=${encodedSearch}`,
    },
  }, { label: `page ${page}` });

  const text = await res.text();
  // RSC payload: array where index 0 is '$' and index 3 has {list, totalCount}
  return parseRscResponse(text, (parsed) => {
    if (Array.isArray(parsed) && parsed[0] === '$' && parsed[3]?.list) return parsed[3];
  });
}

async function resolveShopDetailAction({ storeType, serverType }) {
  if (cachedShopDetailAction) return cachedShopDetailAction;

  try {
    const pageUrl = `${SHOP_TRADING_URL}?storeType=${storeType}&serverType=${serverType}&searchWord=&p=1`;
    const res = await safeFetch(pageUrl, {
      headers: {
        'accept': '*/*',
        'next-url': '/en/intro/shop-search/trading',
        'rsc': '1',
        'Referer': pageUrl,
      },
    }, { label: 'shop detail action discovery', maxRetries: 0 });
    const text = await res.text();
    const chunkPaths = [...new Set(
      [...text.matchAll(/static\/chunks\/[^"\\]+?\.js/g)].map((match) => match[0])
    )];

    for (const path of chunkPaths) {
      const chunkUrl = new URL(`/_next/${path}`, SHOP_TRADING_URL).href;
      const chunkRes = await safeFetch(chunkUrl, {
        headers: {
          'accept': 'application/javascript,*/*;q=0.8',
          'Referer': pageUrl,
        },
      }, { label: 'shop detail action chunk', maxRetries: 0 });
      const chunk = await chunkRes.text();
      const match = chunk.match(/createServerReference\("([a-f0-9]{40,})"[\s\S]{0,300}?"getDetail"/);
      if (match) {
        cachedShopDetailAction = match[1];
        return cachedShopDetailAction;
      }
    }
  } catch {
    // Fall back to the latest known action id below.
  }

  cachedShopDetailAction = SHOP_DETAIL_ACTION_FALLBACK;
  return cachedShopDetailAction;
}

/**
 * Fetch shop location details (map, coordinates).
 * Uses the current Next.js server action id, discovered from the page chunks.
 */
async function fetchShopDetails({ svrId, mapId, ssi, storeType, serverType }) {
  const params = { svrId, mapId, ssi };
  const firstAction = cachedShopDetailAction ?? SHOP_DETAIL_ACTION_FALLBACK;
  const firstDetails = await fetchShopDetailsWithAction({
    action: firstAction,
    params,
    storeType,
    serverType,
  });
  if (firstDetails || cachedShopDetailAction) return firstDetails;

  const discoveredAction = await resolveShopDetailAction({ storeType, serverType });
  if (discoveredAction === firstAction) return firstDetails;

  return fetchShopDetailsWithAction({
    action: discoveredAction,
    params,
    storeType,
    serverType,
  });
}

async function fetchShopDetailsWithAction({ action, params, storeType, serverType }) {
  const url = `${SHOP_TRADING_URL}?storeType=${storeType}&serverType=${serverType}&searchWord=&p=1&limit=40`;

  const res = await safeFetch(url, {
    method: 'POST',
    headers: {
      'accept': 'text/x-component',
      'content-type': 'text/plain;charset=UTF-8',
      'next-action': action,
    },
    body: JSON.stringify([{ type: 'store', params }]),
  }, { label: 'shop details' });

  const text = await res.text();
  return parseRscResponse(text, (parsed) => {
    if (parsed?.data?.mapName) return parsed.data;
  });
}

/**
 * Fetch all pages of search results for an item, with delays between pages.
 * @param {object} params
 * @param {string} params.searchWord - Item name to search.
 * @param {string} params.storeType  - "BUY" or "SELL".
 * @param {string} params.serverType - Server name.
 * @param {(page: number, total: number) => void} [params.onProgress] - Progress callback.
 * @returns {Promise<{list: object[], totalCount: number} | null>}
 */
async function fetchAllPages({ searchWord, storeType, serverType, onProgress }) {
  const firstPage = await fetchShopPage({ searchWord, storeType, serverType, page: 1 });
  if (!firstPage?.list) return null;

  const allItems = [...firstPage.list];
  const totalPages = Math.min(Math.ceil(firstPage.totalCount / ITEMS_PER_PAGE), MAX_PAGES);

  for (let page = 2; page <= totalPages; page++) {
    await randomDelay(DELAY.betweenPages);
    onProgress?.(page, totalPages);
    const pageData = await fetchShopPage({ searchWord, storeType, serverType, page });
    if (pageData?.list) allItems.push(...pageData.list);
  }

  return { list: allItems, totalCount: firstPage.totalCount };
}

// ── Display ──────────────────────────────────────────────────────────

const BOX_W = 90;
const INNER = BOX_W - 2;

// Column widths must sum to INNER-1 (87) including 5 spaces between 6 columns:
// 3 + 1 + 14 + 1 + 6 + 1 + 20 + 1 + 16 + 1 + 23 = 87
const COL = { rank: 3, price: 14, qty: 6, shop: 20, seller: 16, navi: 23 };

/**
 * Wrap a plain-text line inside box borders, padding to INNER width.
 * Structure: "  │ {text}{pad}│" — the space after │ is part of INNER.
 */
function boxLine(text, plainLen) {
  const pad = Math.max(0, INNER - 1 - plainLen);
  return `  ${C.cyan}\u2502${C.reset} ${text}${' '.repeat(pad)}${C.cyan}\u2502${C.reset}`;
}

function printBanner(config) {
  console.log(`${C.bold}${C.cyan}RO Shop Price Alert${C.reset}`);
  console.log(`${C.dim}${'─'.repeat(40)}${C.reset}`);
  console.log(
    `${C.dim}Server:${C.reset} ${config.server}  ${C.dim}Type:${C.reset} ${config.storeType}  ${C.dim}Interval:${C.reset} ${config.intervalMinutes} min  ${C.dim}Top:${C.reset} ${config.topN}`
  );
  console.log(`${C.dim}Tracking:${C.reset} ${config.items.join(', ') || '(none)'}`);
  console.log('');
}

function printItemHeader(itemName, totalCount) {
  const title = ` ${itemName} (${totalCount} listings) `;
  const left = Math.floor((INNER - title.length) / 2);
  const right = INNER - left - title.length;

  console.log(`  ${C.cyan}\u250c${'\u2500'.repeat(INNER)}\u2510${C.reset}`);
  console.log(`  ${C.cyan}\u2502${C.reset}${' '.repeat(left)}${C.bold}${C.white}${title}${C.reset}${' '.repeat(right)}${C.cyan}\u2502${C.reset}`);
  console.log(`  ${C.cyan}\u251c${'\u2500'.repeat(INNER)}\u2524${C.reset}`);
}

function printColumnHeaders() {
  const rank = '#'.padEnd(COL.rank);
  const price = 'Price'.padEnd(COL.price);
  const qty = 'Qty'.padEnd(COL.qty);
  const shop = 'Shop'.padEnd(COL.shop);
  const seller = 'Seller'.padEnd(COL.seller);
  const navi = 'Location'.padEnd(COL.navi);
  const headerText = `${rank} ${price} ${qty} ${shop} ${seller} ${navi}`;
  console.log(boxLine(`${C.dim}${headerText}${C.reset}`, headerText.length));
  console.log(boxLine(`${C.dim}${'\u2500'.repeat(INNER - 1)}${C.reset}`, INNER - 1));
}

function printItemRow(i, item, navi) {
  const priceColor = i === 0 ? `${C.bold}${C.green}` : C.yellow;
  const rank = `#${i + 1}`.padEnd(COL.rank);
  const price = formatZeny(item.itemPrice).padEnd(COL.price);
  const qty = `x${item.itemCnt}`.padEnd(COL.qty);
  const shop = truncPad(item.storeName, COL.shop);
  const seller = truncPad(item.itemSellerCharName, COL.seller);
  const loc = truncPad(navi, COL.navi);

  const plainLen = rank.length + 1 + price.length + 1 + qty.length + 1 + shop.length + 1 + seller.length + 1 + loc.length;
  const coloredText = `${C.bold}${rank}${C.reset} ${priceColor}${price}${C.reset} ${C.dim}${qty}${C.reset} ${C.dim}${shop}${C.reset} ${C.dim}${seller}${C.reset} ${C.cyan}${loc}${C.reset}`;
  console.log(boxLine(coloredText, plainLen));
}

function printItemFooter(min, max, avg) {
  console.log(boxLine('', 0));
  const statsText = `min: ${formatZeny(min)}  |  avg: ${formatZeny(avg)}  |  max: ${formatZeny(max)}`;
  const coloredStats = `${C.green}min: ${formatZeny(min)}${C.reset}  ${C.dim}|${C.reset}  ${C.yellow}avg: ${formatZeny(avg)}${C.reset}  ${C.dim}|${C.reset}  ${C.red}max: ${formatZeny(max)}${C.reset}`;
  console.log(boxLine(` ${coloredStats}`, statsText.length + 1));
  console.log(`  ${C.cyan}\u2514${'\u2500'.repeat(INNER)}\u2518${C.reset}`);
}

// ── Item Check ───────────────────────────────────────────────────────

/** Fetch and display the top cheapest shops for a single item. */
async function checkItem(itemName, storeType, serverType, topN) {
  const spin = createSpinner(`Fetching ${C.bold}${itemName}${C.reset}...`);

  try {
    const data = await fetchAllPages({
      searchWord: itemName,
      storeType,
      serverType,
      onProgress(page, total) {
        spin.update(`Fetching ${C.bold}${itemName}${C.reset}... page ${page}/${total}`);
      },
    });

    spin.stop();

    if (!data || data.list.length === 0) {
      console.log(`  ${C.red}[${itemName}] No listings found.${C.reset}\n`);
      return;
    }

    const sorted = [...data.list].sort((a, b) => a.itemPrice - b.itemPrice);
    const top = sorted.slice(0, topN);
    const allPrices = data.list.map((i) => i.itemPrice);
    const min = allPrices.reduce((a, b) => Math.min(a, b), Infinity);
    const max = allPrices.reduce((a, b) => Math.max(a, b), -Infinity);
    const avg = Math.round(allPrices.reduce((a, b) => a + b, 0) / allPrices.length);

    // Fetch locations sequentially with delays
    const details = [];
    for (const item of top) {
      try {
        details.push(await fetchShopDetails({
          svrId: item.svrId, mapId: item.mapId, ssi: item.ssi,
          storeType, serverType,
        }));
      } catch {
        details.push(null);
      }
      if (details.length < top.length) await randomDelay(DELAY.betweenDetails);
    }

    printItemHeader(itemName, data.totalCount);
    printColumnHeaders();

    for (let i = 0; i < top.length; i++) {
      const loc = details[i];
      const navi = loc
        ? `/navi ${loc.mapName.replace('.gat', '')} ${loc.xpos}/${loc.ypos}`
        : 'unknown';
      printItemRow(i, top[i], navi);
    }

    printItemFooter(min, max, avg);
    console.log('');
  } catch (err) {
    spin.stop();
    if (err.message === 'RATE_LIMITED') {
      console.error(`  ${C.bold}${C.red}Rate limited (429)! Aborting cycle. Try increasing the interval with /change-interval.${C.reset}`);
      throw err;
    }
    if (err.message === 'BLOCKED') {
      console.error(`  ${C.bold}${C.red}Blocked (403)! The server may have banned this IP. Try again later or check if the API changed.${C.reset}`);
      throw err;
    }
    console.error(`  ${C.red}Error fetching "${itemName}": ${err.message}${C.reset}\n`);
  }
}

// ── Interactive Command Line ─────────────────────────────────────────

const PROMPT = `${C.cyan}>${C.reset} `;

const COMMANDS = {
  '/add-item': {
    usage: '/add-item <item name>',
    desc: 'Add an item to track',
    group: 'Items',
  },
  '/remove-item': {
    usage: '/remove-item <item name>',
    desc: 'Remove an item from tracking',
    group: 'Items',
  },
  '/change-interval': {
    usage: `/change-interval <minutes>`,
    desc: `Change polling interval (min: ${MIN_INTERVAL_MINUTES})`,
    group: 'Config',
    aliases: ['/interval'],
  },
  '/change-top': {
    usage: `/change-top <n>`,
    desc: `Change number of top results (1-${MAX_TOP_N})`,
    group: 'Config',
    aliases: ['/top'],
  },
  '/list': {
    usage: '/list',
    desc: 'Show current config and tracked items',
    group: 'Actions',
  },
  '/check': {
    usage: '/check',
    desc: 'Run a price check immediately',
    group: 'Actions',
  },
  '/clear': {
    usage: '/clear',
    desc: 'Clear the screen',
    group: 'Actions',
  },
  '/help': {
    usage: '/help',
    desc: 'Show available commands',
    group: 'Actions',
  },
  '/quit': {
    usage: '/quit',
    desc: 'Exit the program',
    group: 'Actions',
    aliases: ['/exit'],
  },
};

/** Build a map of alias -> canonical command name. */
const ALIASES = {};
for (const [name, cmd] of Object.entries(COMMANDS)) {
  if (cmd.aliases) {
    for (const alias of cmd.aliases) {
      ALIASES[alias] = name;
    }
  }
}

function printHelp(config) {
  console.log('');
  console.log(`  ${C.bold}${C.cyan}Available commands${C.reset}  ${C.dim}(Tab to autocomplete)${C.reset}`);

  const groups = ['Items', 'Config', 'Actions'];
  for (const group of groups) {
    console.log(`\n  ${C.dim}${group}${C.reset}`);
    console.log(`  ${C.dim}${'─'.repeat(50)}${C.reset}`);
    for (const [, cmd] of Object.entries(COMMANDS)) {
      if (cmd.group !== group) continue;
      let desc = cmd.desc;
      // Show current values for config commands
      if (cmd === COMMANDS['/change-interval']) desc += ` ${C.dim}(current: ${config.intervalMinutes})${C.reset}`;
      if (cmd === COMMANDS['/change-top']) desc += ` ${C.dim}(current: ${config.topN})${C.reset}`;
      const aliases = cmd.aliases ? `${C.dim}  (${cmd.aliases.join(', ')})${C.reset}` : '';
      console.log(`  ${C.green}${cmd.usage.padEnd(32)}${C.reset} ${desc}${aliases}`);
    }
  }
  console.log('');
}

function printList(app) {
  console.log('');
  console.log(`  ${C.bold}${C.cyan}Current Configuration${C.reset}`);
  console.log(`  ${C.dim}${'─'.repeat(40)}${C.reset}`);
  console.log(`  ${C.dim}Server:${C.reset}   ${app.config.server}`);
  console.log(`  ${C.dim}Type:${C.reset}     ${app.config.storeType}`);
  console.log(`  ${C.dim}Interval:${C.reset} ${app.config.intervalMinutes} min`);
  console.log(`  ${C.dim}Top:${C.reset}      ${app.config.topN}`);
  console.log('');
  console.log(`  ${C.bold}${C.cyan}Tracked Items${C.reset} (${app.config.items.length}/${MAX_ITEMS})`);
  console.log(`  ${C.dim}${'─'.repeat(40)}${C.reset}`);
  if (app.config.items.length === 0) {
    console.log(`  ${C.dim}(none) Use /add-item <name> to start tracking.${C.reset}`);
  } else {
    app.config.items.forEach((item, i) => {
      console.log(`  ${C.dim}${String(i + 1).padStart(2)}.${C.reset} ${item}`);
    });
  }
  const remaining = getTimeRemaining(app);
  if (remaining) {
    console.log('');
    console.log(`  ${C.dim}Next check in ${remaining}${C.reset}`);
  }
  if (app.lastCheckAt) {
    console.log(`  ${C.dim}Last check: ${new Date(app.lastCheckAt).toLocaleTimeString('en-GB')}${C.reset}`);
  }
  console.log('');
}

function getTimeRemaining(app) {
  if (!app.nextCheckAt) return null;
  const diff = app.nextCheckAt - Date.now();
  if (diff <= 0) return 'soon...';
  const min = Math.floor(diff / 60_000);
  const sec = Math.floor((diff % 60_000) / 1000);
  if (min > 0) return `${min}m ${sec}s`;
  return `${sec}s`;
}

/**
 * Handle a single command line input. Returns false to quit.
 * @param {string} input - Raw user input.
 * @param {object} app   - Application state.
 * @returns {Promise<boolean>} true to continue, false to quit.
 */
async function handleCommand(input, app) {
  const trimmed = input.trim();
  if (!trimmed) return true;

  // Parse command and argument
  const spaceIdx = trimmed.indexOf(' ');
  let cmd = spaceIdx === -1 ? trimmed.toLowerCase() : trimmed.slice(0, spaceIdx).toLowerCase();
  const arg = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();

  // Resolve aliases
  if (ALIASES[cmd]) cmd = ALIASES[cmd];

  switch (cmd) {
    case '/help': {
      printHelp(app.config);
      return true;
    }

    case '/quit': {
      return false;
    }

    case '/clear': {
      console.clear();
      printBanner(app.config);
      return true;
    }

    case '/add-item': {
      if (!arg) {
        console.log(`  ${C.red}Usage: /add-item <item name>${C.reset}`);
        return true;
      }
      if (app.config.items.length >= MAX_ITEMS) {
        console.log(`  ${C.yellow}Maximum of ${MAX_ITEMS} items reached. Remove an item first.${C.reset}`);
        return true;
      }
      const exists = app.config.items.some((i) => i.toLowerCase() === arg.toLowerCase());
      if (exists) {
        console.log(`  ${C.yellow}"${arg}" is already being tracked.${C.reset}`);
        return true;
      }
      app.config.items.push(arg);
      saveConfig(app.configPath, app.config);
      console.log(`  ${C.green}\u2713${C.reset} Added ${C.bold}"${arg}"${C.reset} to tracking. (${app.config.items.length} item(s) total)`);
      return true;
    }

    case '/remove-item': {
      if (!arg) {
        console.log(`  ${C.red}Usage: /remove-item <item name>${C.reset}`);
        return true;
      }
      const idx = app.config.items.findIndex((i) => i.toLowerCase() === arg.toLowerCase());
      if (idx === -1) {
        console.log(`  ${C.yellow}"${arg}" is not being tracked.${C.reset}`);
        return true;
      }
      const removed = app.config.items.splice(idx, 1)[0];
      saveConfig(app.configPath, app.config);
      console.log(`  ${C.green}\u2713${C.reset} Removed ${C.bold}"${removed}"${C.reset}. (${app.config.items.length} item(s) remaining)`);
      return true;
    }

    case '/change-interval': {
      const minutes = parseInt(arg, 10);
      if (!arg || isNaN(minutes) || minutes < 1) {
        console.log(`  ${C.red}Usage: /change-interval <minutes>  (min: ${MIN_INTERVAL_MINUTES})${C.reset}`);
        return true;
      }
      const clamped = Math.max(minutes, MIN_INTERVAL_MINUTES);
      app.config.intervalMinutes = clamped;
      saveConfig(app.configPath, app.config);
      rescheduleCheck(app);
      if (clamped !== minutes) {
        console.log(`  ${C.green}\u2713${C.reset} Interval changed to ${C.bold}${clamped} min${C.reset} (requested ${minutes}, minimum is ${MIN_INTERVAL_MINUTES})`);
      } else {
        console.log(`  ${C.green}\u2713${C.reset} Interval changed to ${C.bold}${clamped} min${C.reset}`);
      }
      return true;
    }

    case '/change-top': {
      const n = parseInt(arg, 10);
      if (!arg || isNaN(n) || n < 1 || n > MAX_TOP_N) {
        console.log(`  ${C.red}Usage: /change-top <n>  (1-${MAX_TOP_N})${C.reset}`);
        return true;
      }
      app.config.topN = n;
      saveConfig(app.configPath, app.config);
      console.log(`  ${C.green}\u2713${C.reset} Showing top ${C.bold}${n}${C.reset} results per item.`);
      return true;
    }

    case '/list': {
      printList(app);
      return true;
    }

    case '/check': {
      if (app.checking) {
        console.log(`  ${C.yellow}A check is already in progress...${C.reset}`);
        return true;
      }
      // Cancel pending timer, run now, then reschedule
      if (app.timerId) clearTimeout(app.timerId);
      app.timerId = null;
      await runCheckCycle(app);
      scheduleNextCheck(app);
      return true;
    }

    default: {
      if (cmd.startsWith('/')) {
        console.log(`  ${C.red}Unknown command: ${cmd}${C.reset}  ${C.dim}Type /help for available commands.${C.reset}`);
      } else {
        console.log(`  ${C.dim}Commands start with /. Type /help for available commands.${C.reset}`);
      }
      return true;
    }
  }
}

// ── Check Cycle & Scheduling ─────────────────────────────────────────

/** Run a full check cycle for all tracked items. */
async function runCheckCycle(app) {
  app.checking = true;
  app.rl.pause();

  const ts = new Date().toLocaleTimeString('en-GB');
  console.log(`\n${C.dim}[ ${ts} ] Running check...${C.reset}\n`);

  let aborted = false;

  if (app.config.items.length === 0) {
    console.log(`  ${C.yellow}No items to track. Use /add-item <name> to add one.${C.reset}\n`);
  } else {
    // Snapshot items to avoid race conditions if the list is modified mid-check
    const itemsSnapshot = [...app.config.items];

    for (let i = 0; i < itemsSnapshot.length; i++) {
      try {
        await checkItem(itemsSnapshot[i], app.config.storeType, app.config.server, app.config.topN);
      } catch (err) {
        if (err.message === 'RATE_LIMITED' || err.message === 'BLOCKED') {
          aborted = true;
          break;
        }
      }
      if (i < itemsSnapshot.length - 1) {
        await randomDelay(DELAY.betweenItems);
      }
    }
  }

  app.lastCheckAt = Date.now();

  if (aborted) {
    app.consecutiveFailures++;
  } else {
    app.consecutiveFailures = 0;
    const remaining = getTimeRemaining(app);
    console.log(`${C.dim}Check complete.${remaining ? ` Next in ${app.config.intervalMinutes} min.` : ''} Type /help for commands.${C.reset}`);
  }

  app.checking = false;
  app.rl.resume();
  app.rl.prompt();
}

/**
 * Schedule the next check cycle with exponential backoff on consecutive failures.
 * Backoff formula: base * 2^failures, capped at 60 min, plus 0-20% random jitter.
 */
function scheduleNextCheck(app) {
  // Always clear any existing timer to prevent dual timers
  if (app.timerId) clearTimeout(app.timerId);

  const baseMs = app.config.intervalMinutes * 60_000;
  const backoffMs = Math.min(baseMs * Math.pow(2, app.consecutiveFailures), 60 * 60_000);
  const jitter = Math.random() * 0.2 * backoffMs;
  const waitMs = backoffMs + jitter;

  app.nextCheckAt = Date.now() + waitMs;

  if (app.consecutiveFailures > 0) {
    console.log(`  ${C.yellow}Backoff active (${app.consecutiveFailures} failure(s)): next check in ${Math.round(waitMs / 60_000)} min${C.reset}`);
  }

  app.timerId = setTimeout(async () => {
    try {
      await runCheckCycle(app);
    } catch (err) {
      console.error(`  ${C.red}Check cycle error: ${err.message}${C.reset}`);
    }
    scheduleNextCheck(app);
  }, waitMs);
}

/** Cancel and re-create the check timer (e.g., after interval change). */
function rescheduleCheck(app) {
  if (app.timerId) clearTimeout(app.timerId);
  app.timerId = null;
  scheduleNextCheck(app);
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const cliArgs = parseArgs();
  const configPath = cliArgs.itemsFile || new URL('./items.json', import.meta.url);

  let config;
  try {
    config = loadConfig(configPath);
  } catch (err) {
    console.error(`${C.red}Config error: ${err.message}${C.reset}`);
    process.exit(1);
  }

  // Apply CLI overrides
  if (cliArgs.interval) config.intervalMinutes = cliArgs.interval;
  if (cliArgs.topN) config.topN = cliArgs.topN;
  config.intervalMinutes = Math.max(config.intervalMinutes, MIN_INTERVAL_MINUTES);

  // All command names + aliases for tab completion
  const allCommandNames = [
    ...Object.keys(COMMANDS),
    ...Object.keys(ALIASES),
  ];

  // Setup readline with tab completion
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: PROMPT,
    completer(line) {
      // Only complete the first token (the command name)
      const firstToken = line.split(' ')[0];
      if (line.includes(' ')) {
        // If typing args for /remove-item, complete with tracked item names
        const cmd = firstToken.toLowerCase();
        const resolvedCmd = ALIASES[cmd] || cmd;
        if (resolvedCmd === '/remove-item') {
          const partial = line.slice(line.indexOf(' ') + 1).toLowerCase();
          const hits = config.items.filter((i) => i.toLowerCase().startsWith(partial));
          return [hits.map((h) => `${firstToken} ${h}`), line];
        }
        return [[], line];
      }
      const hits = allCommandNames.filter((c) => c.startsWith(firstToken));
      return [hits.length ? hits : [], firstToken];
    },
  });

  const app = {
    config,
    configPath,
    rl,
    timerId: null,
    nextCheckAt: null,
    lastCheckAt: null,
    checking: false,
    consecutiveFailures: 0,
    quitting: false,
  };

  // Print initial banner and help
  printBanner(config);
  printHelp(config);

  // Handle input — wrap async handler to catch unhandled rejections
  rl.on('line', (line) => {
    handleCommand(line, app).then((shouldContinue) => {
      if (!shouldContinue) {
        app.quitting = true;
        if (app.timerId) clearTimeout(app.timerId);
        rl.close();
        return;
      }
      if (!app.checking) rl.prompt();
    }).catch((err) => {
      console.error(`  ${C.red}Command error: ${err.message}${C.reset}`);
      if (!app.checking) rl.prompt();
    });
  });

  // Graceful shutdown
  rl.on('close', () => {
    if (app.timerId) clearTimeout(app.timerId);
    if (!app.quitting) {
      // Ctrl+C / EOF, not /quit
      console.log(`\n${C.dim}Stopped.${C.reset}`);
    }
    process.exit(0);
  });

  // Run first check, then start the loop
  await runCheckCycle(app);
  scheduleNextCheck(app);
}

main().catch((err) => {
  console.error(`${C.red}Fatal: ${err.message}${C.reset}`);
  process.exit(1);
});
