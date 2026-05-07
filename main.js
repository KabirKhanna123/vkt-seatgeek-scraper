import { Actor } from 'apify';
import { PlaywrightCrawler } from 'crawlee';
import { createClient } from '@supabase/supabase-js';
import ws from 'ws';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://unypasitbzulafehbqtj.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVueXBhc2l0Ynp1bGFmZWhicXRqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUwMTE2MjAsImV4cCI6MjA5MDU4NzYyMH0.ywGB7ZccbVxcgZDXMOQB9Ui8R-SF4xF0SKkWavDbRGI';
const VKT_API = process.env.VKT_API || 'https://vkt-volume-api.vercel.app';

const RECENT_HOURS = parseInt(process.env.RECENT_HOURS || '20', 10);
const EVENT_LIMIT = parseInt(process.env.EVENT_LIMIT || '104', 10);
const MIN_PRICE = 10;
const MAX_PRICE = 25000;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { realtime: { transport: ws } });

function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function normalizeDateString(value) {
  if (!value) return null;
  const s = String(value).trim();
  const isoMatch = s.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (isoMatch) return isoMatch[1];
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    return [d.getFullYear(), String(d.getMonth()+1).padStart(2,'0'), String(d.getDate()).padStart(2,'0')].join('-');
  }
  return null;
}

function summarizeForAtpCeiling(prices, knownFloor) {
  const threshold = knownFloor ? knownFloor * 0.9 : MIN_PRICE;
  const valid = prices.map(safeNum).filter(v => v >= threshold && v <= MAX_PRICE).sort((a,b) => a-b);
  if (!valid.length) return { avg: null, ceiling: null };
  return {
    avg: Math.round(valid.reduce((a,b) => a+b,0) / valid.length),
    ceiling: Math.round(valid[valid.length-1]),
  };
}

async function getEvents(limit) {
  const today = new Date().toISOString().slice(0,10);
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() + 12);
  const end = cutoff.toISOString().slice(0,10);
  const { data, error } = await supabase
    .from('events')
    .select('id,name,date,venue,platform,seatgeek_url')
    .eq('platform', 'SeatGeek')
    .gte('date', today)
    .lte('date', end)
    .order('date', { ascending: true })
    .limit(limit);
  if (error) { console.error('Events fetch error:', error.message); return []; }
  return data || [];
}

async function scrapedRecently(eventId) {
  const since = new Date(Date.now() - RECENT_HOURS * 3600000).toISOString();
  const { data } = await supabase.from('volume_snapshots').select('id')
    .eq('event_id', eventId).eq('platform', 'SeatGeek').is('section', null).gte('scraped_at', since).limit(1);
  return !!(data && data.length > 0);
}

async function postSnapshot(payload) {
  try {
    const r = await fetch(VKT_API + '/api/snapshot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) { console.error('Snapshot failed:', r.status, await r.text()); return false; }
    return true;
  } catch (e) { console.error('Snapshot error:', e.message); return false; }
}

async function dismissModals(page) {
  for (const sel of [
    'button:has-text("Accept")',
    'button:has-text("Got it")',
    'button:has-text("Close")',
    'button[aria-label="Close"]',
    '[data-testid="modal-close"]',
  ]) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 300 })) {
        await el.click({ timeout: 500 });
        await page.waitForTimeout(200);
      }
    } catch (_) {}
  }
}

async function extractPricesFromPage(page) {
  return await page.evaluate(({ minPrice, maxPrice }) => {
    const prices = new Set();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      try {
        if (!node.parentElement) continue;
        if (node.parentElement.closest('script,style,noscript,svg,header,footer,nav')) continue;
        const style = window.getComputedStyle(node.parentElement);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        for (const match of node.textContent.matchAll(/\$\s*([\d,]+(?:\.\d{2})?)/g)) {
          const value = parseFloat(match[1].replace(/,/g,''));
          if (Number.isFinite(value) && value >= minPrice && value <= maxPrice) prices.add(value);
        }
      } catch (_) { continue; }
    }
    return [...prices].sort((a,b) => a-b);
  }, { minPrice: MIN_PRICE, maxPrice: MAX_PRICE });
}

async function getListingCount(page) {
  return await page.evaluate(() => {
    const bodyText = document.body?.innerText || '';
    // SeatGeek shows "X tickets" or "X listings"
    const matches = [
      ...bodyText.matchAll(/\b(\d[\d,]*)\s+tickets?\b/gi),
      ...bodyText.matchAll(/\b(\d[\d,]*)\s+listings?\b/gi),
    ].map(m => parseInt(m[1].replace(/,/g,''),10)).filter(v => Number.isFinite(v) && v > 0 && v < 50000);
    return matches.length ? Math.max(...matches) : 0;
  });
}

async function getSeatGeekZones(page) {
  // SeatGeek groups listings by zone/section — try to find zone filter buttons
  return await page.evaluate(() => {
    // Look for zone chips or section filters
    const zones = [];
    const chipSelectors = [
      '[data-testid*="zone"]',
      '[data-testid*="section"]',
      '[class*="zone-chip"]',
      '[class*="ZoneChip"]',
      'button[class*="zone"]',
    ];
    for (const sel of chipSelectors) {
      document.querySelectorAll(sel).forEach((el, i) => {
        const text = (el.innerText || '').trim();
        const priceMatch = text.match(/\$\s*([\d,]+)/);
        if (text) zones.push({
          label: text.split('\n')[0].trim(),
          floor: priceMatch ? parseFloat(priceMatch[1].replace(/,/g,'')) : null,
          index: i,
        });
      });
      if (zones.length > 0) break;
    }
    return zones;
  });
}

async function getFloorFromPage(page) {
  return await page.evaluate(({ minPrice, maxPrice }) => {
    // SeatGeek shows cheapest ticket prominently
    const selectors = [
      '[data-testid="listing-price"]',
      '[class*="price"]:not([class*="original"])',
      '[class*="Price"]',
    ];
    const prices = [];
    for (const sel of selectors) {
      document.querySelectorAll(sel).forEach(el => {
        const match = el.innerText?.match(/\$\s*([\d,]+(?:\.\d{2})?)/);
        if (match) {
          const val = parseFloat(match[1].replace(/,/g,''));
          if (val >= minPrice && val <= maxPrice) prices.push(val);
        }
      });
    }
    return prices.length ? Math.min(...prices) : null;
  }, { minPrice: MIN_PRICE, maxPrice: MAX_PRICE });
}

await Actor.init();

const input = await Actor.getInput() || {};
const rawIds = input.eventIds || input.eventId || null;
const manualIds = rawIds
  ? (Array.isArray(rawIds) ? rawIds : String(rawIds).split(',').map(s => s.trim()).filter(Boolean))
  : null;

// Also accept manual URLs
const manualUrls = input.urls || null;

let requests = [];

if (manualUrls && manualUrls.length > 0) {
  // Direct URL mode — paste SeatGeek event URLs directly
  requests = manualUrls.map(url => ({
    url,
    userData: { event: { id: url.match(/\/(\d+)\//)?.[1] || url, name: 'Manual Event', date: null, venue: null, platform: 'SeatGeek', seatgeek_url: url } }
  }));
} else if (manualIds && manualIds.length > 0) {
  console.log(`Manual event IDs: ${manualIds.join(', ')}`);
  const { data } = await supabase.from('events')
    .select('id,name,date,venue,platform,seatgeek_url')
    .in('id', manualIds);
  const found = data || [];
  const evts = manualIds.map(id => found.find(e => e.id === id) || {
    id, name: 'Manual Event', date: null, venue: null, platform: 'SeatGeek', seatgeek_url: null,
  });
  requests = evts.map(event => ({ url: event.seatgeek_url || `https://seatgeek.com/event/${event.id}`, userData: { event } }));
} else {
  const events = await getEvents(EVENT_LIMIT);
  console.log(`SeatGeek events fetched: ${events.length}`);
  for (const event of events) {
    if (await scrapedRecently(event.id)) {
      console.log(`Skipping recent: ${event.name} (${event.id})`);
      continue;
    }
    if (event.seatgeek_url) {
      requests.push({ url: event.seatgeek_url, userData: { event } });
    }
  }
}

console.log(`SeatGeek URLs to scrape: ${requests.length}`);

const crawler = new PlaywrightCrawler({
  proxyConfiguration: await Actor.createProxyConfiguration({
    groups: ['RESIDENTIAL'],
    countryCode: 'US',
  }),
  launchContext: {
    launchOptions: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
      ],
    },
  },
  maxConcurrency: 1,
  maxRequestRetries: 3,
  requestHandlerTimeoutSecs: 180,
  navigationTimeoutSecs: 60,
  browserPoolOptions: { useFingerprints: true },
  useSessionPool: true,
  persistCookiesPerSession: true,

  preNavigationHooks: [
    async ({ page, request }) => {
      // Override navigation to warm cookies first
      request.skipNavigation = false;

      // Set realistic browser headers to avoid 403
      await page.setExtraHTTPHeaders({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
      });

      await page.route('**/*', async route => {
        try {
          const req = route.request();
          const type = req.resourceType();
          const url = req.url();
          if (
            type === 'image' || type === 'media' || type === 'font' ||
            url.includes('google-analytics') || url.includes('googletagmanager') ||
            url.includes('doubleclick') || url.includes('facebook') ||
            url.includes('hotjar') || url.includes('intercom')
          ) { await route.abort(); return; }
          await route.continue();
        } catch (_) { try { await route.continue(); } catch (_) {} }
      });

      await page.addInitScript(() => {
        // Stealth overrides
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US','en'] });
        window.chrome = { runtime: {} };
        Object.defineProperty(navigator, 'permissions', {
          get: () => ({ query: () => Promise.resolve({ state: 'granted' }) })
        });
      });
    },
  ],

  async requestHandler({ page, request }) {
    const { event } = request.userData;
    const eventId = event.id;
    const originalName = event.name || `Event ${eventId}`;
    console.log(`\nScraping SeatGeek: ${originalName} (${eventId})`);

    // Navigate with ignoreHTTPSErrors — handled by preNavHook
    // requestHandler only runs if navigation succeeded

    const title = await page.title().catch(() => '');
    console.log(`  Title: ${title.slice(0,80)}`);

    // Check if blocked
    if (title.toLowerCase().includes('access denied') || title.toLowerCase().includes('captcha') || title === '') {
      console.log('  Blocked — skipping');
      return;
    }

    await dismissModals(page);

    // Wait for listings to load
    console.log('  Waiting for listings...');
    try {
      await page.waitForFunction(
        () => /\$\s*\d+/.test(document.body?.innerText||'') && /ticket/i.test(document.body?.innerText||''),
        { timeout: 15000 }
      );
    } catch (_) { await page.waitForTimeout(3000); }

    await page.waitForTimeout(1500);
    await dismissModals(page);

    // Debug: log all visible text containing key data points
    const pageText = await page.evaluate(() => document.body?.innerText?.slice(0, 2000) || '');
    console.log('  Page preview:', pageText.replace(/\n+/g, ' ').slice(0, 200));

    // Get total listing count
    const totalListings = await getListingCount(page);
    console.log(`  Total listings: ${totalListings}`);

    // Get all prices from page
    const prices = await extractPricesFromPage(page);
    const validPrices = prices.filter(p => p >= MIN_PRICE && p <= MAX_PRICE).sort((a,b) => a-b);

    if (!validPrices.length) {
      console.log('  No pricing data found — skipping');
      return;
    }

    const floor = Math.round(validPrices[0]);
    const { avg, ceiling } = summarizeForAtpCeiling(validPrices, floor);
    console.log(`  ${originalName} | floor=$${floor}, atp=$${avg}, ceiling=$${ceiling}, listings=${totalListings}`);

    // Try to get zone/section breakdown
    const zones = await getSeatGeekZones(page);
    console.log(`  Zones found: ${zones.length}`);

    // Extract event metadata from page
    const meta = await page.evaluate(() => {
      let name = null, date = null, venue = null;
      // Try JSON-LD
      for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
        try {
          const data = JSON.parse(script.textContent);
          const items = Array.isArray(data) ? data : [data];
          for (const item of items) {
            if (!item['@type'] || !['Event','SportsEvent','MusicEvent'].includes(item['@type'])) continue;
            if (!name && item.name) name = item.name;
            if (!date && item.startDate) date = item.startDate;
            if (!venue && item.location?.name) {
              const city = item.location.address?.addressLocality || '';
              const state = item.location.address?.addressRegion || '';
              venue = [item.location.name, city, state].filter(Boolean).join(', ');
            }
          }
        } catch (_) {}
      }
      return { name, date, venue };
    });

    const name = meta.name || originalName;
    const date = normalizeDateString(meta.date) || event.date || null;
    const venue = meta.venue || event.venue || null;

    // Save main event snapshot
    await postSnapshot({
      eventId,
      eventName: name,
      eventDate: date,
      venue,
      platform: 'SeatGeek',
      totalListings,
      section: null,
      sectionListings: 0,
      eventFloor: floor,
      eventAvg: avg,
      eventCeiling: ceiling,
      source: 'apify-seatgeek',
    });

    // Save zone snapshots if available
    for (const zone of zones) {
      if (!zone.floor) continue;
      await postSnapshot({
        eventId,
        eventName: name,
        eventDate: date,
        venue,
        platform: 'SeatGeek',
        totalListings: 0,
        section: zone.label,
        sectionListings: 0,
        sectionFloor: zone.floor,
        sectionAvg: null,
        sectionCeiling: null,
        eventFloor: floor,
        eventAvg: avg,
        eventCeiling: ceiling,
        source: 'apify-seatgeek',
      });
      console.log(`  Saved zone ${zone.label}: floor=$${zone.floor}`);
    }

    // Update event record
    const updates = {};
    if (name !== originalName) updates.name = name;
    if (venue && venue !== event.venue) updates.venue = venue;
    if (date && date !== event.date) updates.date = date;
    if (Object.keys(updates).length) {
      await supabase.from('events').update(updates).eq('id', eventId);
    }
  },

  errorHandler: async ({ request, page }, error) => {
    // If 403, try navigating to homepage first then retry
    if (error.message.includes('403') || error.message.includes('blocked')) {
      console.log('  Got 403 — warming cookies via homepage...');
      try {
        await page.goto('https://seatgeek.com', { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(3000);
      } catch (_) {}
    }
  },

  failedRequestHandler({ request, error }) {
    console.error(`Failed: ${request.url} — ${error.message}`);
  },
});

await crawler.addRequests(requests);
await crawler.run();

console.log('\nDone.');
await Actor.exit();
