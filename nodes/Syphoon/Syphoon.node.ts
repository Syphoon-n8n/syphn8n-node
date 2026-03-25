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
const MAX_SITEMAP_URLS = 100;
const FETCH_TIMEOUT_MS = 30_000;
const RETRY_DELAY_MS   = 2_000;
const PAGE_DELAY_MS    = 1_200;
const RATE_LIMIT_DELAY = 5_000;
const MAX_RETRIES      = 2;

// ─── Types ────────────────────────────────────────────────────────────────────

type SearchEngine = 'google' | 'bing' | 'amazon';
type PageContext  = 'product' | 'listing' | 'article' | 'generic';

interface PageMeta {
  url:         string;
  title:       string | null;
  h1:          string | null;
  description: string | null;
  canonical:   string | null;
  word_count:  number;
  scraped_at:  string;
}

interface SearchResult {
  position:     number;
  url?:         string;
  asin?:        string;
  title:        string | null;
  snippet?:     string | null;
  price?:       number | null;
  rating?:      number | null;
  image_url?:   string | null;
  product_url?: string;
}

interface ProductData {
  name:          string | null;
  price:         string | null;
  price_numeric: number | null;
  currency:      string | null;
  rating:        number | null;
  review_count:  number | null;
  availability:  string | null;
  brand:         string | null;
  sku:           string | null;
  images:        string[];
  description:   string | null;
}

interface ListingItem {
  title:     string | null;
  url:       string | null;
  price:     string | null;
  image_url: string | null;
  rating:    number | null;
}

interface ArticleData {
  headline:      string | null;
  author:        string | null;
  published_at:  string | null;
  modified_at:   string | null;
  section:       string | null;
  tags:          string[];
  body:          string | null;
  read_time_min: number | null;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function normalizeUrl(url: string): string {
  url = url.trim();
  return url.startsWith('http://') || url.startsWith('https://') ? url : `https://${url}`;
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
  return re.exec(html)?.[1]?.trim() ?? null;
}

function isAmazonUrl(url: string): boolean {
  return /amazon\.(com|co\.uk|in|de|fr|ca|com\.au|co\.jp)/.test(url);
}

// ─── Extractors ───────────────────────────────────────────────────────────────

function extractMeta(html: string, url: string): PageMeta {
  const rawTitle  = reGet(html, /<title[^>]*>([\s\S]{1,200}?)<\/title>/i);
  const cleanTitle = rawTitle ? stripHtml(rawTitle) : null;
  const text       = stripHtml(html);

  // Amazon: h1 is typically a button ("Adding to Cart..."), not the product name.
  // Use #productTitle span if present, otherwise derive from <title> by stripping suffix.
  let h1: string | null;
  if (isAmazonUrl(url)) {
    h1 = reGet(html, /id=["']productTitle["'][^>]*>\s*([\s\S]{3,300}?)\s*<\/span>/i)
      ?? (cleanTitle ? cleanTitle.replace(/\s*[:|]\s*Amazon\.com.*$/i, '').trim() : null);
  } else {
    const rawH1 = reGet(html, /<h1[^>]*>([\s\S]{1,200}?)<\/h1>/i);
    h1 = rawH1 ? stripHtml(rawH1) : null;
  }

  return {
    url,
    title:       cleanTitle,
    h1,
    description: reGet(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']{1,500})["']/i)
                   ?? reGet(html, /<meta[^>]+content=["']([^"']{1,500})["'][^>]+name=["']description["']/i),
    canonical:   reGet(html, /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i),
    word_count:  text.split(/\s+/).filter(Boolean).length,
    scraped_at:  new Date().toISOString(),
  };
}

function extractText(html: string): string {
  return stripHtml(html);
}

function extractMarkdown(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi,            '\n# $1\n')
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi,            '\n## $1\n')
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi,            '\n### $1\n')
    .replace(/<h[4-6][^>]*>([\s\S]*?)<\/h[4-6]>/gi,   '\n#### $1\n')
    .replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi,    '**$1**')
    .replace(/<b[^>]*>([\s\S]*?)<\/b>/gi,              '**$1**')
    .replace(/<em[^>]*>([\s\S]*?)<\/em>/gi,            '*$1*')
    .replace(/<i[^>]*>([\s\S]*?)<\/i>/gi,              '*$1*')
    .replace(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi,            '- $1\n')
    .replace(/<br\s*\/?>/gi,                           '\n')
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi,              '\n$1\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n').trim();
}

function extractLinks(html: string, baseUrl: string): string[] {
  const origin = getOrigin(baseUrl);
  const links  = new Set<string>();
  const re     = /href=["']([^"'#?]+)/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = m[1].trim();
    if (!href || /^(mailto:|tel:|javascript:)/.test(href)) continue;
    const full = href.startsWith('http') ? href
               : href.startsWith('/')   ? `${origin}${href}`
               : `${origin}/${href}`;
    if (full.startsWith(origin)) links.add(full);
  }
  return [...links];
}

function extractImages(html: string): string[] {
  const imgs = new Set<string>();
  const re   = /<img[^>]+src=["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) imgs.add(m[1]);
  return [...imgs];
}

function extractStructuredData(html: string): IDataObject[] {
  const blocks: IDataObject[] = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try { blocks.push(JSON.parse(m[1].trim()) as IDataObject); } catch { /* skip malformed */ }
  }
  return blocks;
}

function extractOpenGraph(html: string): IDataObject {
  const og: IDataObject = {};
  const re = /<meta[^>]+property=["'](og:[^"']+)["'][^>]+content=["']([^"']*)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) og[m[1].replace('og:', '')] = m[2];
  return og;
}

// ─── Amazon-specific extractors ───────────────────────────────────────────────

/**
 * Amazon buries the full price across two separate spans:
 *   <span class="a-price-whole">3</span><span class="a-price-fraction">25</span>
 * We must join them. Also handles Subscribe & Save price and plain text price.
 */
function extractAmazonPrice(html: string): { raw: string | null; numeric: number | null; currency: string | null } {
  // 1. Whole + fraction spans (most common)
  const wholeM    = html.match(/class="a-price-whole"[^>]*>\s*([\d,]+)\s*</);
  const fracM     = html.match(/class="a-price-fraction"[^>]*>\s*(\d{2})\s*</);
  if (wholeM) {
    const whole   = wholeM[1].replace(/,/g, '');
    const frac    = fracM?.[1] ?? '00';
    const raw     = `$${whole}.${frac}`;
    return { raw, numeric: parseFloat(`${whole}.${frac}`), currency: '$' };
  }

  // 2. data-a-price attribute (compact format)
  const dataPrice = reGet(html, /data-a-price=["']([\d.]+)["']/);
  if (dataPrice) {
    return { raw: `$${dataPrice}`, numeric: parseFloat(dataPrice), currency: '$' };
  }

  // 3. Plain text price pattern near price-related elements
  const plainM = html.match(/id=["']priceblock_ourprice["'][^>]*>\s*\$?([\d,]+\.?\d{0,2})/);
  if (plainM) {
    const n = parseFloat(plainM[1].replace(/,/g, ''));
    return { raw: `$${plainM[1]}`, numeric: n, currency: '$' };
  }

  return { raw: null, numeric: null, currency: null };
}

/**
 * Amazon's main product images are in a JS variable 'colorImages' or 'ImageBlockATF'.
 * Thumbnail <img> tags are tiny (SX38, SY50) — we want the hi-res versions.
 * Strategy: grab all image IDs from thumbnails, reconstruct hi-res URLs.
 */
function extractAmazonImages(html: string): string[] {
  const images = new Set<string>();

  // 1. Parse 'colorImages' JS block — most reliable source
  const colorImagesM = html.match(/'colorImages'\s*:\s*\{[^}]*'initial'\s*:\s*(\[[\s\S]*?\])\s*\}/);
  if (colorImagesM) {
    try {
      const arr = JSON.parse(colorImagesM[1]) as Array<{ hiRes?: string; large?: string; main?: { [k: string]: unknown } }>;
      for (const img of arr) {
        const src = img.hiRes ?? img.large;
        if (src && typeof src === 'string') images.add(src);
      }
    } catch { /* fallback below */ }
  }

  // 2. ImageBlockATF data block
  if (images.size === 0) {
    const ibM = html.match(/var\s+data\s*=\s*\{[\s\S]*?"colorImages"\s*:\s*\{"initial"\s*:\s*(\[[\s\S]*?\])/);
    if (ibM) {
      try {
        const arr = JSON.parse(ibM[1]) as Array<{ hiRes?: string; large?: string }>;
        for (const img of arr) {
          const src = img.hiRes ?? img.large;
          if (src && typeof src === 'string') images.add(src);
        }
      } catch { /* fallback below */ }
    }
  }

  // 3. Fallback: grab only non-thumbnail, non-sprite product images
  // Amazon product images have IDs like /images/I/XXXXXXXX. and no size suffix like _SX38_ or _CR,
  if (images.size === 0) {
    const re = /https:\/\/m\.media-amazon\.com\/images\/I\/([A-Za-z0-9%-]+\.[a-z]+)/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      const url = m[0];
      // Skip thumbnails (contain size codes like _SX38_, _SY50_, _CR,)
      if (!/_SX\d+_|_SY\d+_|_CR,|sprites|gno\/sprites/.test(url)) {
        // Reconstruct to get largest version by stripping size suffix
        const hiRes = url.replace(/_[A-Z]{2}\d+[^.]*(\.[a-z]+)$/, '$1')
                         .replace(/_[A-Z]+_\.[a-z]+$/, '');
        images.add(hiRes.endsWith('.jpg') || hiRes.endsWith('.png') ? hiRes : url);
      }
    }
  }

  return [...images].slice(0, 10);
}

/** Pull brand from #bylineInfo link or "by BrandName" text near the title */
function extractAmazonBrand(html: string): string | null {
  return reGet(html, /id=["']bylineInfo["'][^>]*>\s*(?:Brand:|Visit the)?\s*<[^>]*>\s*([^<]{2,80})/)
    ?? reGet(html, /id=["']bylineInfo["'][^>]*>\s*(?:Brand:|by\s+)([^<\n]{2,60})/)
    ?? reGet(html, /class=["'][^"']*bylineInfo[^"']*["'][^>]*>\s*(?:Brand:|Visit the\s+)?([^<\n]{2,60})/)
    ?? null;
}

/** ASIN is the SKU on Amazon — in the URL or a hidden input */
function extractAmazonSku(html: string, url: string): string | null {
  // From URL: /dp/ASIN or /product/ASIN
  const urlM = url.match(/\/(?:dp|product|gp\/product)\/([A-Z0-9]{10})/);
  if (urlM) return urlM[1];
  return reGet(html, /name=["']ASIN["'][^>]+value=["']([A-Z0-9]{10})["']/)
    ?? reGet(html, /"ASIN"\s*:\s*"([A-Z0-9]{10})"/)
    ?? null;
}

/** #productDescription or #feature-bullets for description */
function extractAmazonDescription(html: string): string | null {
  const descM = html.match(/id=["']productDescription["'][^>]*>([\s\S]{20,2000}?)<\/div>/i);
  if (descM) return stripHtml(descM[1]).slice(0, 1000).trim() || null;

  // Fallback: feature bullets
  const bulletsM = html.match(/id=["']feature-bullets["'][^>]*>([\s\S]{20,2000}?)<\/div>/i);
  if (bulletsM) return stripHtml(bulletsM[1]).slice(0, 1000).trim() || null;

  return null;
}

/** #productTitle span — the real product name */
function extractAmazonName(html: string, url: string, meta: PageMeta): string | null {
  const fromSpan = reGet(html, /id=["']productTitle["'][^>]*>\s*([\s\S]{3,300}?)\s*<\/span>/i);
  if (fromSpan) return stripHtml(fromSpan).trim();

  // Derive from <title> by stripping " : Amazon.com : ..." suffix
  if (meta.title) return meta.title.replace(/\s*[:|]\s*Amazon\.com.*$/i, '').trim() || null;

  return null;
}

// ─── Page context detection ───────────────────────────────────────────────────

function detectPageContext(html: string, url: string): PageContext {
  const ldBlocks = extractStructuredData(html);
  for (const block of ldBlocks) {
    const t = ((block['@type'] as string | undefined) ?? '').toLowerCase();
    if (['product', 'offer'].some(k => t.includes(k)))                               return 'product';
    if (['newsarticle', 'article', 'blogposting', 'review'].some(k => t.includes(k))) return 'article';
    if (['itemlist', 'offerlist', 'productgroup'].some(k => t.includes(k)))           return 'listing';
  }

  const og = extractOpenGraph(html);
  if (og['type'] === 'product') return 'product';
  if (og['type'] === 'article') return 'article';

  const path = url.toLowerCase();
  if (/\/(product|item|dp|gp|sku|p)\b|\/p-\d|\/\d{5,}/.test(path))         return 'product';
  if (/\/(search|results|listing|category|shop|store|browse)/.test(path))    return 'listing';
  if (/\/(blog|news|article|post|story|press)\b/.test(path))                 return 'article';

  const hasPriceEl  = /<[^>]+(itemprop=["']price|class="[^"]*price[^"]*")[^>]*>/i.test(html);
  const hasAddCart  = /add.to.cart|buy.now|add.to.bag/i.test(html);
  const hasMultiImg = (html.match(/<img\s/gi) ?? []).length > 8;
  const hasLongBody = stripHtml(html).split(/\s+/).length > 600;
  const hasAuthor   = /itemprop=["']author|class="[^"]*author[^"]*"/i.test(html);
  const hasArticle  = /<article[\s>]/i.test(html);

  if (hasPriceEl && hasAddCart)                  return 'product';
  if (hasPriceEl && hasMultiImg)                 return 'listing';
  if ((hasAuthor || hasArticle) && hasLongBody)  return 'article';

  return 'generic';
}

// ─── Structured extractors ────────────────────────────────────────────────────

function extractProductData(html: string, url: string): ProductData {
  const meta      = extractMeta(html, url);
  const isAmazon  = isAmazonUrl(url);

  // ── Amazon fast-path ──────────────────────────────────────────────────────
  if (isAmazon) {
    const { raw: price, numeric: priceNumeric, currency } = extractAmazonPrice(html);
    const ldBlocks  = extractStructuredData(html);
    const ldProduct = ldBlocks.find(b =>
      ((b['@type'] as string | undefined) ?? '').toLowerCase().includes('product')
    );
    const ldAggRating = ldProduct?.['aggregateRating'] as IDataObject | undefined;

    return {
      name:          extractAmazonName(html, url, meta),
      price,
      price_numeric: priceNumeric,
      currency,
      rating:        ldAggRating?.['ratingValue'] != null
                       ? parseFloat(String(ldAggRating['ratingValue']))
                       : parseFloat(reGet(html, /(\d\.\d)\s+out of 5/) ?? '') || null,
      review_count:  ldAggRating?.['reviewCount'] != null
                       ? parseInt(String(ldAggRating['reviewCount']), 10)
                       : parseInt((reGet(html, /([\d,]+)\s+(?:global\s+)?ratings?/i) ?? '').replace(/,/g, ''), 10) || null,
      availability:  html.match(/id=["']availability["'][^>]*>[\s\S]*?In Stock/i)
                       ? 'InStock'
                       : html.match(/out.of.stock|currently.unavailable/i)
                       ? 'OutOfStock' : 'InStock',
      brand:         extractAmazonBrand(html),
      sku:           extractAmazonSku(html, url),
      images:        extractAmazonImages(html),
      description:   extractAmazonDescription(html),
    };
  }

  // ── Generic product page ──────────────────────────────────────────────────
  const ldBlocks  = extractStructuredData(html);
  const ldProduct = ldBlocks.find(b =>
    ((b['@type'] as string | undefined) ?? '').toLowerCase().includes('product')
  );

  const ldOffers = ldProduct?.['offers'] as IDataObject | IDataObject[] | undefined;
  const ldOffer  = Array.isArray(ldOffers) ? ldOffers[0] : ldOffers;

  const rawPrice: string | null =
    (ldOffer?.['price']   != null ? String(ldOffer['price'])   : null) ??
    (ldProduct?.['price'] != null ? String(ldProduct['price']) : null) ??
    reGet(html, /<meta[^>]+itemprop=["']price["'][^>]+content=["']([^"']+)["']/i) ??
    reGet(html, /itemprop=["']price["'][^>]*>\s*([£$€¥₹]?[\d,]+\.?\d{0,2})/) ??
    reGet(html, /class="[^"]*(?:price|Price)[^"]*"[^>]*>\s*([£$€¥₹]?[\d,]+\.?\d{0,2})/) ??
    null;

  const priceNumeric = rawPrice ? parseFloat(rawPrice.replace(/[^0-9.]/g, '')) || null : null;

  const currency: string | null =
    rawPrice?.match(/[£$€¥₹]/)?.[0] ??
    reGet(html, /<meta[^>]+itemprop=["']priceCurrency["'][^>]+content=["']([^"']+)["']/i) ??
    (ldOffer?.['priceCurrency'] != null ? String(ldOffer['priceCurrency']) : null) ??
    null;

  const ldAggRating = ldProduct?.['aggregateRating'] as IDataObject | undefined;

  const ratingRaw: string | null =
    (ldAggRating?.['ratingValue'] != null ? String(ldAggRating['ratingValue']) : null) ??
    reGet(html, /itemprop=["']ratingValue["'][^>]*content=["']([^"']+)["']/i) ??
    reGet(html, /class="[^"]*(?:rating|stars?)[^"]*"[^>]*>\s*([\d.]+)/i) ??
    null;

  const reviewRaw: string | null =
    (ldAggRating?.['reviewCount'] != null ? String(ldAggRating['reviewCount']) : null) ??
    reGet(html, /itemprop=["']reviewCount["'][^>]*content=["']([^"']+)["']/i) ??
    reGet(html, /([\d,]+)\s+(?:reviews?|ratings?)/i) ??
    null;

  const images = new Set<string>();
  const imgRe  = /<img[^>]+src=["']([^"']+)["']/gi;
  let imgM;
  while ((imgM = imgRe.exec(html)) !== null) {
    const src = imgM[1];
    if (/\.(jpg|jpeg|png|webp)/i.test(src) && !/icon|logo|sprite/i.test(src)) images.add(src);
  }
  const og = extractOpenGraph(html);
  if (og['image']) images.add(og['image'] as string);

  const ldBrand = ldProduct?.['brand'] as IDataObject | string | undefined;
  const brandName: string | null =
    ldBrand != null
      ? (typeof ldBrand === 'object' ? String((ldBrand as IDataObject)['name'] ?? '') : String(ldBrand))
      : null;

  const ldName: string | null = ldProduct?.['name'] != null ? String(ldProduct['name']) : null;

  const availability: string | null =
    (ldOffer?.['availability'] != null ? String(ldOffer['availability']) : null) ??
    reGet(html, /itemprop=["']availability["'][^>]*content=["']([^"']+)["']/i) ??
    (html.match(/in.stock/i) ? 'InStock' : html.match(/out.of.stock|sold.out/i) ? 'OutOfStock' : null);

  const sku: string | null =
    (ldProduct?.['sku'] != null ? String(ldProduct['sku']) : null) ??
    (ldProduct?.['mpn'] != null ? String(ldProduct['mpn']) : null) ??
    reGet(html, /itemprop=["'](?:sku|mpn)["'][^>]*content=["']([^"']+)["']/i) ??
    null;

  const description: string | null =
    (ldProduct?.['description'] != null ? String(ldProduct['description']) : null) ??
    reGet(html, /itemprop=["']description["'][^>]*>\s*([\s\S]{20,1000}?)<\//i) ??
    null;

  return {
    name:          ldName || reGet(html, /itemprop=["']name["'][^>]*>\s*([^<]{3,200})/) || meta.h1,
    price:         rawPrice,
    price_numeric: priceNumeric,
    currency,
    rating:        ratingRaw ? parseFloat(ratingRaw) : null,
    review_count:  reviewRaw ? parseInt(reviewRaw.replace(/[^0-9]/g, ''), 10) : null,
    availability,
    brand:         brandName || reGet(html, /itemprop=["']brand["'][^>]*>\s*([^<]{2,80})/) || null,
    sku,
    images:        [...images].slice(0, 10),
    description,
  };
}

function extractListingItems(html: string, baseUrl: string): ListingItem[] {
  const ldBlocks = extractStructuredData(html);
  const ldList   = ldBlocks.find(b =>
    ['itemlist', 'offerlist'].some(k =>
      ((b['@type'] as string | undefined) ?? '').toLowerCase().includes(k)
    )
  );
  if (ldList?.['itemListElement']) {
    const els = ldList['itemListElement'] as IDataObject[];
    return els.slice(0, 50).map(el => {
      const item = (el['item'] as IDataObject) ?? el;
      return {
        title:     item['name'] != null ? String(item['name']) : null,
        url:       item['url']  != null ? String(item['url'])  : null,
        price:     null,
        image_url: null,
        rating:    null,
      };
    });
  }

  const items  : ListingItem[] = [];
  const seen    = new Set<string>();
  const origin  = getOrigin(baseUrl);
  const blockRe = /<(?:li|article|div)[^>]*class="[^"]*(?:product|item|card|result)[^"]*"[^>]*>([\s\S]{100,3000}?)<\/(?:li|article|div)>/gi;
  let bm;
  while ((bm = blockRe.exec(html)) !== null && items.length < 50) {
    const block  = bm[1];
    const linkM  = block.match(/href=["']([^"']+)["']/);
    const titleM = block.match(/<(?:h[1-6]|a)[^>]*>\s*([^<]{5,200})\s*<\/(?:h[1-6]|a)>/);
    const priceM = block.match(/([£$€¥₹]\s*[\d,]+\.?\d{0,2}|[\d,]+\.?\d{0,2}\s*(?:USD|EUR|GBP|INR))/i);
    const imgM   = block.match(/<img[^>]+src=["']([^"']+)["']/);
    const rateM  = block.match(/([\d.]+)\s*(?:\/\s*5|out of 5|\bstars?\b)/i);

    const href = linkM?.[1];
    if (!href) continue;
    const fullUrl = href.startsWith('http') ? href
                  : href.startsWith('/')    ? `${origin}${href}`
                  : `${origin}/${href}`;
    if (seen.has(fullUrl)) continue;
    seen.add(fullUrl);

    items.push({
      title:     titleM ? stripHtml(titleM[1]) : null,
      url:       fullUrl,
      price:     priceM?.[1]?.trim() ?? null,
      image_url: imgM?.[1] ?? null,
      rating:    rateM ? parseFloat(rateM[1]) : null,
    });
  }
  return items;
}

function extractArticleData(html: string): ArticleData {
  const ldBlocks = extractStructuredData(html);
  const ldArt    = ldBlocks.find(b =>
    ['article', 'newsarticle', 'blogposting', 'review'].some(k =>
      ((b['@type'] as string | undefined) ?? '').toLowerCase().includes(k)
    )
  );

  const ldAuthor = ldArt?.['author'] as IDataObject | string | undefined;
  const authorName: string | null =
    ldAuthor != null
      ? (typeof ldAuthor === 'object' ? String((ldAuthor as IDataObject)['name'] ?? '') : String(ldAuthor))
      : null;

  const articleMatch = html.match(/<article[^>]*>([\s\S]+?)<\/article>/i);
  const bodyText     = stripHtml(articleMatch?.[1] ?? html).slice(0, 5000);
  const wordCount    = bodyText.split(/\s+/).filter(Boolean).length;

  const keywordsRaw = reGet(html, /<meta[^>]+name=["']keywords["'][^>]+content=["']([^"']+)["']/i) ?? '';
  const tags        = keywordsRaw.split(',').map(t => t.trim()).filter(Boolean).slice(0, 10);

  return {
    headline:
      (ldArt?.['headline'] != null ? String(ldArt['headline']) : null) ??
      reGet(html, /<h1[^>]*>([\s\S]{5,200}?)<\/h1>/i) ??
      null,
    author:
      authorName ||
      reGet(html, /(?:itemprop=["']author["']|class="[^"]*author[^"]*")[^>]*>\s*([^<]{3,80})/) ||
      null,
    published_at:
      (ldArt?.['datePublished'] != null ? String(ldArt['datePublished']) : null) ??
      reGet(html, /<(?:time|meta)[^>]+(?:datetime|content)=["']([^"']+T[^"']+)["']/i) ??
      reGet(html, /<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i) ??
      null,
    modified_at:
      (ldArt?.['dateModified'] != null ? String(ldArt['dateModified']) : null) ??
      reGet(html, /<meta[^>]+property=["']article:modified_time["'][^>]+content=["']([^"']+)["']/i) ??
      null,
    section:
      (ldArt?.['articleSection'] != null ? String(ldArt['articleSection']) : null) ??
      reGet(html, /<meta[^>]+property=["']article:section["'][^>]+content=["']([^"']+)["']/i) ??
      null,
    tags,
    body:          bodyText || null,
    read_time_min: wordCount > 0 ? Math.ceil(wordCount / 200) : null,
  };
}

// ─── Sitemap ──────────────────────────────────────────────────────────────────

function isSitemapUrl(url: string): boolean {
  return url.endsWith('sitemap.xml') || (url.includes('sitemap') && url.endsWith('.xml'));
}

function parseSitemapUrls(xml: string): string[] {
  const urls: string[] = [];
  const re = /<loc>([\s\S]*?)<\/loc>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const u = m[1].trim();
    if (u) urls.push(u);
  }
  return urls;
}

// ─── Search ───────────────────────────────────────────────────────────────────

function detectSearchEngine(url: string): SearchEngine | null {
  if (url.includes('google.com/search'))  return 'google';
  if (url.includes('bing.com/search'))    return 'bing';
  if (/amazon\.(com|co\.uk|in|de|fr|ca|com\.au|co\.jp)\/s\?/.test(url)) return 'amazon';
  return null;
}

function parseSearchResults(html: string, engine: SearchEngine): SearchResult[] {
  const results: SearchResult[] = [];
  const seen = new Set<string>();

  if (engine === 'google') {
    const re = /href="(https?:\/\/(?!(?:www\.)?google\.[^"]+)[^"&]{10,300})"/g;
    let m;
    while ((m = re.exec(html)) !== null && results.length < 10) {
      const url = m[1];
      if (seen.has(url)) continue;
      seen.add(url);
      const ctx   = html.slice(Math.max(0, m.index - 800), m.index + 800);
      const title = ctx.match(/<h3[^>]*>([\s\S]{5,200}?)<\/h3>/)?.[1];
      const snip  = ctx.match(/class="[^"]*(?:VwiC3b|IsZvec)[^"]*"[^>]*>([\s\S]{10,400}?)<\/(?:div|span)>/)?.[1];
      results.push({ position: results.length + 1, url, title: title ? stripHtml(title) : null, snippet: snip ? stripHtml(snip) : null });
    }
  } else if (engine === 'bing') {
    const re = /href="(https?:\/\/(?!(?:www\.)?(?:bing|microsoft)\.[^"]+)[^"&]{10,300})"/g;
    let m;
    while ((m = re.exec(html)) !== null && results.length < 10) {
      const url = m[1];
      if (seen.has(url)) continue;
      seen.add(url);
      const ctx   = html.slice(Math.max(0, m.index - 600), m.index + 600);
      const title = ctx.match(/<h2[^>]*>([\s\S]{5,200}?)<\/h2>/)?.[1];
      results.push({ position: results.length + 1, url, title: title ? stripHtml(title) : null });
    }
  } else if (engine === 'amazon') {
    const re = /data-asin="([A-Z0-9]{10})"/g;
    let m;
    while ((m = re.exec(html)) !== null && results.length < 20) {
      const asin = m[1];
      if (seen.has(asin) || asin === '0000000000') continue;
      seen.add(asin);
      const block  = html.slice(m.index, m.index + 3000);
      const t1     = block.match(/class="a-size-medium[^"]*"[^>]*>\s*([^<]{10,200})/)?.[1];
      const t2     = block.match(/class="a-size-base-plus[^"]*"[^>]*>\s*([^<]{10,200})/)?.[1];
      const title  = [t1, t2].find(t => t && t.length > 8) ?? null;
      if (!title) continue;
      const priceW = block.match(/class="a-price-whole"[^>]*>\s*([\d,]+)/)?.[1];
      const priceF = block.match(/class="a-price-fraction"[^>]*>\s*(\d{2})/)?.[1];
      const rateM  = block.match(/(\d\.\d) out of 5/);
      results.push({
        position:    results.length + 1,
        asin,
        title:       title.trim(),
        price:       priceW ? parseFloat(priceW.replace(/,/g, '') + '.' + (priceF ?? '00')) : null,
        rating:      rateM ? parseFloat(rateM[1]) : null,
        image_url:   block.match(/class="s-image"[^>]*src="([^"]+)"/)?.[1] ?? null,
        product_url: `https://www.amazon.com/dp/${asin}`,
      });
    }
  }

  return results;
}

// ─── API ──────────────────────────────────────────────────────────────────────

async function syphoonFetch(
  ctx:       IExecuteFunctions,
  apiKey:    string,
  url:       string,
  itemIndex: number,
): Promise<string> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(attempt * RETRY_DELAY_MS);
    try {
      const res = await ctx.helpers.request({
        method:  'POST',
        url:     SYPHOON_API,
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ url, key: apiKey, method: 'GET' }),
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
      if (e.statusCode === 402) throw new NodeOperationError(ctx.getNode(), 'Syphoon trial exhausted.', { itemIndex });
      if (e.statusCode === 401 || e.statusCode === 403) throw new NodeOperationError(ctx.getNode(), 'Invalid Syphoon API key.', { itemIndex });
      if (e.statusCode === 429 && attempt < MAX_RETRIES) { await sleep(RATE_LIMIT_DELAY); continue; }
      if (attempt === MAX_RETRIES) throw new NodeApiError(ctx.getNode(), err as JsonObject, { itemIndex });
    }
  }
  throw new NodeOperationError(ctx.getNode(), `Failed to fetch after retries: ${url}`, { itemIndex });
}

// ─── Output builders ──────────────────────────────────────────────────────────

function buildPageOutput(html: string, url: string): IDataObject {
  const context = detectPageContext(html, url);
  const base: IDataObject = {
    type:       'page',
    context,
    ...extractMeta(html, url),
    open_graph: extractOpenGraph(html),
    links:      extractLinks(html, url),
  };

  if (context === 'product') return { ...base, product: extractProductData(html, url) };
  if (context === 'listing') return { ...base, items:   extractListingItems(html, url) };
  if (context === 'article') return { ...base, article: extractArticleData(html) };

  return { ...base, text: extractText(html), markdown: extractMarkdown(html) };
}

function buildSerpOutput(engine: SearchEngine, url: string, results: SearchResult[]): IDataObject[] {
  if (!results.length) {
    return [{ type: 'serp', engine, url, results: [], scraped_at: new Date().toISOString() }];
  }
  return results.map(r => ({ type: 'serp', engine, scraped_at: new Date().toISOString(), ...r }));
}

function buildSitemapPageOutput(
  html: string, url: string, index: number, total: number, sitemapSource: string,
): IDataObject {
  return {
    type:           'sitemap_page',
    index,
    total,
    sitemap_source: sitemapSource,
    ...extractMeta(html, url),
    text:           extractText(html),
    markdown:       extractMarkdown(html),
  };
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

async function handleSitemap(
  ctx:       IExecuteFunctions,
  apiKey:    string,
  url:       string,
  html:      string,
  itemIndex: number,
): Promise<INodeExecutionData[]> {
  let urls = parseSitemapUrls(html);

  const nested: string[] = [];
  for (const sub of urls.filter(u => u.endsWith('.xml'))) {
    try {
      const subXml = await syphoonFetch(ctx, apiKey, sub, itemIndex);
      nested.push(...parseSitemapUrls(subXml));
      await sleep(PAGE_DELAY_MS);
    } catch { /* skip broken sub-sitemaps */ }
  }
  urls = [...urls.filter(u => !u.endsWith('.xml')), ...nested].slice(0, MAX_SITEMAP_URLS);

  const items: INodeExecutionData[] = [];
  for (let idx = 0; idx < urls.length; idx++) {
    const pageUrl = urls[idx];
    try {
      const pageHtml = await syphoonFetch(ctx, apiKey, pageUrl, itemIndex);
      items.push({ json: buildSitemapPageOutput(pageHtml, pageUrl, idx + 1, urls.length, url), pairedItem: itemIndex });
    } catch (err) {
      items.push({ json: { type: 'sitemap_page', index: idx + 1, url: pageUrl, error: (err as Error).message }, pairedItem: itemIndex });
    }
    if (idx < urls.length - 1) await sleep(PAGE_DELAY_MS);
  }
  return items;
}

async function handleSerp(
  engine: SearchEngine, url: string, html: string, itemIndex: number,
): Promise<INodeExecutionData[]> {
  const results = parseSearchResults(html, engine);
  return buildSerpOutput(engine, url, results).map(json => ({ json, pairedItem: itemIndex }));
}

async function handlePage(html: string, url: string, itemIndex: number): Promise<INodeExecutionData[]> {
  return [{ json: buildPageOutput(html, url), pairedItem: itemIndex }];
}

// ─── Node ─────────────────────────────────────────────────────────────────────

export class Syphoon implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Syphoon',
    name:        'syphoon',
    icon:        'file:icon.svg',
    group:       ['transform'],
    version:     1,
    documentationUrl: 'https://docs.syphoon.com'
    description: 'Scrape any URL and get back structured data auto-detected by page type: product, listing, article, or generic.',
    defaults:    { name: 'Syphoon' },
    inputs:      ['main'],
    outputs:     ['main'],
    credentials: [{ name: 'syphoonApi', required: true }],
    properties: [
      {
        displayName:  'URL',
        name:         'url',
        type:         'string',
        default:      '',
        required:     true,
        placeholder:  'https://example.com',
        description:  'Any URL: regular page, sitemap.xml, or a Google/Bing/Amazon search URL.',
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
        const engine = detectSearchEngine(url);

        const results = isSitemapUrl(url) ? await handleSitemap(this, apiKey, url, html, i)
                      : engine !== null   ? await handleSerp(engine, url, html, i)
                      :                    await handlePage(html, url, i);

        returnData.push(...results);
      } catch (error) {
        if (this.continueOnFail()) {
          returnData.push({ json: { url, error: (error as Error).message }, pairedItem: i });
          continue;
        }
        throw error;
      }
    }

    return [returnData];
  }
}
