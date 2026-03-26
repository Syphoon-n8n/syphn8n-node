import {
  IExecuteFunctions,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
  NodeOperationError,
  NodeApiError,
  IDataObject,
  JsonObject,
} from 'n8n-workflow';

// ─── Constants ────────────────────────────────────────────────────────────────

const SYPHOON_API      = 'https://api.syphoon.com/';
const FETCH_TIMEOUT_MS = 30_000;
const RETRY_DELAY_MS   = 2_000;
const PAGE_DELAY_MS    = 1_200;
const RATE_LIMIT_DELAY = 5_000;
const MAX_RETRIES      = 3;

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Edg/123.0.0.0',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
];

// ─── Output shape ─────────────────────────────────────────────────────────────

interface ScrapedOutput {
  url:           string;
  source:        string;
  scraped_at:    string;
  name:          string | null;
  brand:         string | null;
  sku:           string | null;
  price:         string | null;
  price_numeric: number | null;
  currency:      string | null;
  availability:  string | null;
  rating:        number | null;
  review_count:  number | null;
  images:        string[];
  description:   string | null;
  similar_urls:  string[];
}

// ─── Utilities ────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const jitteredDelay = (base: number) =>
  sleep(base + Math.floor((Math.random() - 0.5) * base * 0.6));

function randomUA(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function normalizeUrl(url: string): string {
  url = url.trim();
  return url.startsWith('http://') || url.startsWith('https://') ? url : `https://${url}`;
}

function hostname(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

function getOrigin(url: string): string {
  try { return new URL(url).origin; } catch { return url; }
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ').trim();
}

function reGet(html: string, re: RegExp): string | null {
  const m = re.exec(html);
  if (!m) return null;
  return (m[1] ?? m[2] ?? m[3])?.trim() ?? null;
}

function truncate(s: string | null, max = 1000): string | null {
  if (!s) return null;
  return s.length > max ? s.slice(0, max) + '...' : s;
}

function isAmazonUrl(url: string): boolean {
  return /amazon\.(com|co\.uk|in|de|fr|ca|com\.au|co\.jp)/.test(url);
}

function isProductImage(src: string): boolean {
  return (
    /\.(jpg|jpeg|png|webp|avif)(\?|$)/i.test(src) &&
    !/sprite|icon|logo|badge|pixel|blank|spacer|nav|header|footer|tracking/i.test(src) &&
    !src.startsWith('data:')
  );
}

// ─── Schema.org ───────────────────────────────────────────────────────────────

function extractStructuredData(html: string): IDataObject[] {
  const blocks: IDataObject[] = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(m[1].trim());
      if (Array.isArray(parsed)) blocks.push(...(parsed as IDataObject[]));
      else blocks.push(parsed as IDataObject);
    } catch { /* skip malformed */ }
  }
  return blocks;
}

function findProductSchema(blocks: IDataObject[]): IDataObject | null {
  const direct = blocks.find(b =>
    ((b['@type'] as string | undefined) ?? '').toLowerCase() === 'product'
  );
  if (direct) return direct;
  for (const block of blocks) {
    const graph = block['@graph'];
    if (Array.isArray(graph)) {
      const found = (graph as IDataObject[]).find(b =>
        ((b['@type'] as string | undefined) ?? '').toLowerCase() === 'product'
      );
      if (found) return found;
    }
    if (Array.isArray(block)) {
      const found = (block as unknown as IDataObject[]).find(b =>
        ((b['@type'] as string | undefined) ?? '').toLowerCase() === 'product'
      );
      if (found) return found;
    }
  }
  return null;
}

// ─── Amazon image extractor ───────────────────────────────────────────────────

function extractAmazonImages(html: string): string[] {
  const images = new Set<string>();
  const colorM = html.match(/'colorImages'\s*:\s*\{[^}]*'initial'\s*:\s*(\[[\s\S]*?\])\s*\}/);
  if (colorM) {
    try {
      const arr = JSON.parse(colorM[1]) as Array<{ hiRes?: string; large?: string }>;
      for (const img of arr) {
        const src = img.hiRes ?? img.large;
        if (src && typeof src === 'string' && isProductImage(src)) images.add(src);
      }
    } catch { /* fallback */ }
  }
  if (images.size === 0) {
    const re = /https:\/\/m\.media-amazon\.com\/images\/I\/([A-Za-z0-9%-]+\.(jpg|jpeg|png|webp))/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      if (!/_SX\d+_|_SY\d+_|_CR,|sprites/.test(m[0])) images.add(m[0]);
    }
  }
  return [...images].slice(0, 10);
}

// ─── Universal extractor ──────────────────────────────────────────────────────

function extractData(html: string, url: string): ScrapedOutput {
  const source    = hostname(url);
  const isAmazon  = isAmazonUrl(url);
  const ldBlocks  = extractStructuredData(html);
  const ldProduct = findProductSchema(ldBlocks);

  // ── Open Graph ────────────────────────────────────────────────────────────
  const og: Record<string, string> = {};
  const ogRe = /<meta[^>]+property=["'](og:[^"']+)["'][^>]+content=["']([^"']*)["']/gi;
  let ogM;
  while ((ogM = ogRe.exec(html)) !== null) og[ogM[1].replace('og:', '')] = ogM[2];

  // ── Name ──────────────────────────────────────────────────────────────────
  const h1    = reGet(html, /<h1[^>]*>([\s\S]{1,300}?)<\/h1>/i);
  const title = reGet(html, /<title[^>]*>([\s\S]{1,200}?)<\/title>/i);
  const name  =
    (ldProduct?.['name'] != null ? String(ldProduct['name']) : null) ??
    og['title'] ??
    (h1 ? stripHtml(h1).trim() : null) ??
    (title ? stripHtml(title).split(/[|\-–—]/)[0].trim() : null) ??
    null;

  // ── Brand ─────────────────────────────────────────────────────────────────
  const ldBrand   = ldProduct?.['brand'] as IDataObject | string | undefined;
  const brandName = ldBrand != null
    ? (typeof ldBrand === 'object'
        ? String((ldBrand as IDataObject)['name'] ?? '')
        : String(ldBrand))
    : null;
  const brand =
    brandName ??
    (isAmazon
      ? (reGet(html, /id=["']bylineInfo["'][^>]*>[\s\S]*?<[^>]*>\s*([^<]{2,80})/) ??
         reGet(html, /id=["']bylineInfo["'][^>]*>\s*(?:Brand:|by\s+)([^<\n]{2,60})/))
      : null) ??
    reGet(html, /(?:itemprop=["']brand["']|class="[^"]*brand[^"]*")[^>]*>\s*([^<]{2,80})/) ??
    reGet(html, /<meta[^>]+name=["']author["'][^>]+content=["']([^"']+)["']/i) ??
    null;

  // ── SKU ───────────────────────────────────────────────────────────────────
  const urlSku =
    url.match(/\/(?:rooms?|dp|p|item|product|listing|gp\/product|itm)\/([A-Za-z0-9_-]{4,})/)?.[1] ??
    url.match(/[?&](?:id|pid|item_id|listing_id|product_id)=([A-Za-z0-9_-]+)/)?.[1] ??
    null;
  const sku =
    (ldProduct?.['sku']       != null ? String(ldProduct['sku'])       : null) ??
    (ldProduct?.['mpn']       != null ? String(ldProduct['mpn'])       : null) ??
    (ldProduct?.['productID'] != null ? String(ldProduct['productID']) : null) ??
    reGet(html, /itemprop=["'](?:sku|mpn|productID)["'][^>]*content=["']([^"']+)["']/i) ??
    (isAmazon
      ? (url.match(/\/(?:dp|product|gp\/product)\/([A-Z0-9]{10})/)?.[1] ??
         reGet(html, /"ASIN"\s*:\s*"([A-Z0-9]{10})"/))
      : null) ??
    urlSku ??
    null;

  // ── Price ─────────────────────────────────────────────────────────────────
  const ldOffers = ldProduct?.['offers'] as IDataObject | IDataObject[] | undefined;
  const ldOffer  = Array.isArray(ldOffers) ? ldOffers[0] : ldOffers;

  const jsonPriceStr =
    html.match(/"price_string"\s*:\s*"([^"]+)"/)?.[1] ??
    html.match(/"displayPrice"\s*:\s*"([^"]+)"/)?.[1] ??
    html.match(/"formattedPrice"\s*:\s*"([^"]+)"/)?.[1] ??
    html.match(/"price"\s*:\s*"([£$€¥₹][^"]{1,20})"/)?.[1] ??
    null;

  const jsonPriceNum =
    (parseFloat(html.match(/"amount"\s*:\s*([\d.]+)/)?.[1] ?? '') || null) ??
    (parseFloat(html.match(/"price"\s*:\s*([\d.]+)/)?.[1] ?? '') || null) ??
    null;

  const currencyStr =
    (ldOffer?.['priceCurrency'] != null ? String(ldOffer['priceCurrency']) : null) ??
    html.match(/"currency"\s*:\s*"([A-Z]{3})"/)?.[1] ??
    html.match(/"priceCurrency"\s*:\s*"([A-Z]{3})"/)?.[1] ??
    null;

  let amazonPrice: string | null = null;
  if (isAmazon) {
    const wholeM = html.match(/class="a-price-whole"[^>]*>\s*([\d,]+)\s*</);
    const fracM  = html.match(/class="a-price-fraction"[^>]*>\s*(\d{2})\s*</);
    if (wholeM) {
      const whole = wholeM[1].replace(/,/g, '');
      const frac  = fracM?.[1] ?? '00';
      amazonPrice = `$${whole}.${frac}`;
    }
    if (!amazonPrice) {
      const dp = reGet(html, /data-a-price=["']([\d.]+)["']/);
      if (dp) amazonPrice = `$${dp}`;
    }
  }

  const rawPrice: string | null =
    amazonPrice ??
    (ldOffer?.['price'] != null ? String(ldOffer['price']) : null) ??
    jsonPriceStr ??
    reGet(html, /itemprop=["']price["'][^>]*content=["']([^"']+)["']/i) ??
    reGet(html, /itemprop=["']price["'][^>]*>\s*([£$€¥₹][\d,.]+)/) ??
    reGet(html, /class="[^"]*(?:price|rate|cost|fare)[^"]*"[^>]*>\s*([£$€¥₹][\d,. ]+)/) ??
    null;

  const currency =
    currencyStr ??
    (rawPrice?.match(/[£$€¥₹]/)?.[0] ?? null) ??
    reGet(html, /itemprop=["']priceCurrency["'][^>]*content=["']([^"']+)["']/i) ??
    null;

  const priceNumeric =
    (rawPrice ? (parseFloat(rawPrice.replace(/[^0-9.]/g, '')) || null) : null) ??
    jsonPriceNum ??
    null;

  // Format price string: prefix currency code if no symbol present
  const priceFormatted = rawPrice
    ? (currency && !rawPrice.includes(currency) && !/[£$€¥₹]/.test(rawPrice)
        ? `${currency} ${rawPrice}`
        : rawPrice)
    : (priceNumeric ? String(priceNumeric) : null);

  // ── Availability ──────────────────────────────────────────────────────────
  const availRaw =
    (ldOffer?.['availability'] != null ? String(ldOffer['availability']) : null) ??
    reGet(html, /itemprop=["']availability["'][^>]*content=["']([^"']+)["']/i) ??
    null;

  const availability = availRaw
    ? (availRaw.toLowerCase().includes('instock') || availRaw.toLowerCase().includes('available')
        ? 'Available' : 'Unavailable')
    : html.match(/\b(in stock|available now|book now|reserve now|add to cart|buy now)\b/i)
        ? 'Available'
    : html.match(/\b(out of stock|sold out|unavailable|fully booked|not available)\b/i)
        ? 'Unavailable'
    : null;

  // ── Rating ────────────────────────────────────────────────────────────────
  const ldAgg = ldProduct?.['aggregateRating'] as IDataObject | undefined;

  const ratingRaw =
    (ldAgg?.['ratingValue'] != null ? parseFloat(String(ldAgg['ratingValue'])) : null) ??
    (parseFloat(reGet(html, /itemprop=["']ratingValue["'][^>]*content=["']([^"']+)["']/i) ?? '') || null) ??
    (parseFloat(reGet(html, /"ratingValue"\s*:\s*([\d.]+)/) ?? '') || null) ??
    (parseFloat(reGet(html, /"rating"\s*:\s*([\d.]+)/) ?? '') || null) ??
    (parseFloat(reGet(html, /(\d\.\d)\s+out of 5/) ?? '') || null) ??
    (parseFloat(reGet(html, /class="[^"]*(?:rating|stars?)[^"]*"[^>]*>\s*([\d.]+)/i) ?? '') || null) ??
    null;

  // Sanity check: valid ratings are between 1.5 and 5 on a 5-point scale
  // Values of exactly 1 or below are almost always parsing errors
  const rating = (ratingRaw && !isNaN(ratingRaw) && ratingRaw >= 1.5 && ratingRaw <= 5)
    ? ratingRaw
    : null;

  // ── Review count ──────────────────────────────────────────────────────────
  const reviewRaw =
    (ldAgg?.['reviewCount'] != null ? parseInt(String(ldAgg['reviewCount']), 10) : null) ??
    (ldAgg?.['ratingCount']  != null ? parseInt(String(ldAgg['ratingCount']),  10) : null) ??
    (parseInt((reGet(html, /itemprop=["']reviewCount["'][^>]*content=["']([^"']+)["']/i) ?? '').replace(/[^0-9]/g, ''), 10) || null) ??
    (parseInt((reGet(html, /([\d,]+)\s+(?:reviews?|ratings?|opinions?)/i) ?? '').replace(/[^0-9]/g, ''), 10) || null) ??
    null;

  const review_count = (reviewRaw && !isNaN(reviewRaw)) ? reviewRaw : null;

  // ── Images ────────────────────────────────────────────────────────────────
  const imgSet = new Set<string>();

  if (isAmazon) {
    for (const src of extractAmazonImages(html)) imgSet.add(src);
  }

  if (imgSet.size === 0) {
    const ldImages = ldProduct?.['image'] as string[] | string | undefined;
    const schemaImgs: string[] = Array.isArray(ldImages)
      ? ldImages.filter(isProductImage).slice(0, 10)
      : ldImages && isProductImage(ldImages) ? [ldImages] : [];
    for (const s of schemaImgs) imgSet.add(s);
  }

  if (og['image'] && isProductImage(og['image'])) imgSet.add(og['image']);

  if (imgSet.size < 5) {
    const re = /<img[^>]+src=["']([^"']+)["']/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      if (isProductImage(m[1])) { imgSet.add(m[1]); if (imgSet.size >= 10) break; }
    }
  }

  // ── Description ───────────────────────────────────────────────────────────
  let description: string | null = null;
  if (isAmazon) {
    const descM = html.match(/id=["']productDescription["'][^>]*>([\s\S]{20,2000}?)<\/div>/i);
    const bulM  = html.match(/id=["']feature-bullets["'][^>]*>([\s\S]{20,2000}?)<\/div>/i);
    description = descM ? truncate(stripHtml(descM[1])) : bulM ? truncate(stripHtml(bulM[1])) : null;
  }
  if (!description) {
    description =
      (ldProduct?.['description'] != null ? truncate(String(ldProduct['description'])) : null) ??
      (og['description'] ? truncate(og['description']) : null) ??
      truncate(reGet(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']{20,})["']/i)) ??
      truncate(reGet(html, /itemprop=["']description["'][^>]*>\s*([\s\S]{20,1000}?)<\//i)) ??
      null;
  }

  // ── Similar URLs ──────────────────────────────────────────────────────────
  const similarSeen = new Set<string>();
  const similar_urls: string[] = [];
  const origin = getOrigin(url);
  const host   = hostname(url);
  const linkRe = /href=["']([^"'#?]+)/gi;
  let lm;
  while ((lm = linkRe.exec(html)) !== null) {
    const href = lm[1].trim();
    if (!href) continue;
    const full = href.startsWith('http') ? href
               : href.startsWith('/')    ? `${origin}${href}`
               : null;
    if (!full || !full.includes(host)) continue;
    const path = full.toLowerCase();
    const looksLikeListing =
      /\/(rooms?|listing|product|item|dp|p|sku|property|hotel|stay|rent|buy|shop|itm[a-z0-9]+)\/[a-z0-9_-]{3,}/i.test(path) ||
      /\/p\/itm[a-z0-9]+/i.test(path) ||
      /\/[a-z0-9-]+-\d{5,}/i.test(path);
    const isNoise =
      /\/(cart|signin|login|logout|account|wishlist|register|returns|help|contact|privacy|terms|sitemap|search|static|assets|fonts)\b/i.test(path) ||
      /\.(css|js|svg|gif|ico|woff|ttf|pdf)(\?|$)/i.test(path) ||
      path.includes('/itemid') ||
      path.includes('callout') ||
      path.endsWith('/p');
    if (looksLikeListing && !isNoise && !similarSeen.has(full)) {
      similarSeen.add(full);
      similar_urls.push(full);
      if (similar_urls.length >= 20) break;
    }
  }

  return {
    url,
    source,
    scraped_at:    new Date().toISOString(),
    name,
    brand:         brand || null,
    sku,
    price:         priceFormatted,
    price_numeric: priceNumeric,
    currency,
    availability,
    rating,
    review_count,
    images:        [...imgSet].slice(0, 10),
    description,
    similar_urls,
  };
}

// ─── Syphoon API ──────────────────────────────────────────────────────────────

async function syphoonFetch(
  ctx: IExecuteFunctions, apiKey: string, url: string, itemIndex: number,
): Promise<string> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(attempt * RETRY_DELAY_MS);
    try {
      const res = await ctx.helpers.request({
        method:  'POST',
        url:     SYPHOON_API,
        headers: { 'Content-Type': 'application/json', 'User-Agent': randomUA() },
        body:    JSON.stringify({ url, key: apiKey, method: 'GET', render: true }),
        timeout: FETCH_TIMEOUT_MS,
      });
      if (typeof res === 'string') return res;
      const r = res as IDataObject;
      for (const k of ['data', 'html', 'body', 'result']) {
        if (r[k] && typeof r[k] === 'string') return r[k] as string;
      }
      throw new NodeOperationError(ctx.getNode(), `Unexpected Syphoon response for: ${url}`, { itemIndex });
    } catch (err: unknown) {
      const e = err as { statusCode?: number };
      if (e.statusCode === 402) throw new NodeOperationError(ctx.getNode(), 'Syphoon trial exhausted. Upgrade at syphoon.com.', { itemIndex });
      if (e.statusCode === 401 || e.statusCode === 403) throw new NodeOperationError(ctx.getNode(), 'Invalid Syphoon API key. Get your key at syphoon.com → Dashboard → API Keys.', { itemIndex });
      if (e.statusCode === 429 && attempt < MAX_RETRIES) { await sleep(RATE_LIMIT_DELAY * (attempt + 1)); continue; }
      if (attempt === MAX_RETRIES) throw new NodeApiError(ctx.getNode(), err as JsonObject, { itemIndex });
    }
  }
  throw new NodeOperationError(ctx.getNode(), `Failed after retries: ${url}`, { itemIndex });
}

// ─── Node ─────────────────────────────────────────────────────────────────────

export class Syphoon implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Syphoon',
    name:        'syphoon',
    icon:        'file:icon.svg',
    group:       ['input'],
    version:     1,
    documentationUrl: 'https://docs.syphoon.com',
    description: 'Scrape any URL and extract structured data. Works on e-commerce (Amazon, Flipkart), travel (Airbnb, Booking.com), restaurants, real estate, job listings, and any website. Returns: name, brand, SKU, price, rating, images, description, availability, and similar page links. To get your API key: visit syphoon.com → Sign Up → Dashboard → API Keys.',
    defaults:    { name: 'Syphoon' },
    inputs:      ['main'],
    outputs:     ['main'],
    credentials: [{ name: 'syphoonApi', required: true }],
    properties: [
      {
        displayName: 'URL',
        name:        'url',
        type:        'string',
        default:     '',
        required:    true,
        placeholder: 'https://amazon.com/dp/... or https://airbnb.com/rooms/...',
        description: 'Any URL to scrape. Works on product pages, hotel listings, restaurant pages, job postings, real estate listings, and more.',
      },
      {
        displayName: '🔑 Need an API key? Go to syphoon.com → Sign Up → Dashboard → API Keys. Then add it via Credentials → New → Syphoon API.',
        name:        'apiKeyNotice',
        type:        'notice',
        default:     '',
      },
    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items      = this.getInputData();
    const returnData: INodeExecutionData[] = [];
    const { apiKey } = await this.getCredentials('syphoonApi') as { apiKey: string };

    for (let i = 0; i < items.length; i++) {
      const url = normalizeUrl(this.getNodeParameter('url', i) as string);
      try {
        const html   = await syphoonFetch(this, apiKey, url, i);
        const output = extractData(html, url);
        returnData.push({ json: output as unknown as IDataObject, pairedItem: i });
      } catch (error) {
        if (this.continueOnFail()) {
          returnData.push({
            json: {
              url,
              source:     hostname(url),
              scraped_at: new Date().toISOString(),
              error:      (error as Error).message,
            },
            pairedItem: i,
          });
          continue;
        }
        throw error;
      }
      if (i < items.length - 1) await jitteredDelay(PAGE_DELAY_MS);
    }

    return [returnData];
  }
}
