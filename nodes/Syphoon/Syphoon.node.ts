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
const MAX_RETRIES      = 3;

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Edg/123.0.0.0',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
];

// ─── Page type detection ──────────────────────────────────────────────────────

type PageType =
  | 'article'
  | 'product'
  | 'recipe'
  | 'job'
  | 'profile'
  | 'video'
  | 'event'
  | 'real_estate'
  | 'forum'
  | 'documentation'
  | 'generic';

// ─── Output shape ─────────────────────────────────────────────────────────────

interface ScrapedOutput {
  // Universal fields — always populated when detectable
  url:          string;
  source:       string;
  scraped_at:   string;
  page_type:    PageType;

  // Core content
  title:        string | null;
  description:  string | null;  // meta description / lead paragraph
  body_text:    string | null;  // main readable content, stripped of nav/footer noise
  author:       string | null;
  published_at: string | null;
  modified_at:  string | null;
  language:     string | null;
  images:       string[];       // all meaningful images found on page
  links:        PageLink[];     // outbound links with anchor text

  // Structured data — populated when schema.org blocks are present
  schema_types: string[];       // e.g. ["Article", "BreadcrumbList"]
  schema_raw:   IDataObject[];  // full parsed ld+json blocks for power users

  // Type-specific enriched fields
  // These are non-null only when the relevant page_type is detected
  product:    ProductFields | null;
  recipe:     RecipeFields  | null;
  job:        JobFields     | null;
  event:      EventFields   | null;
  video:      VideoFields   | null;
}

interface PageLink {
  url:  string;
  text: string;
}

interface ProductFields {
  name:          string | null;
  brand:         string | null;
  sku:           string | null;
  price:         string | null;
  price_numeric: number | null;
  currency:      string | null;
  availability:  string | null;
  rating:        number | null;
  review_count:  number | null;
  category:      string | null;
}

interface RecipeFields {
  name:            string | null;
  cuisine:         string | null;
  cook_time:       string | null;
  prep_time:       string | null;
  total_time:      string | null;
  yield:           string | null;
  ingredients:     string[];
  instructions:    string[];
  rating:          number | null;
  review_count:    number | null;
  calories:        string | null;
}

interface JobFields {
  title:            string | null;
  company:          string | null;
  location:         string | null;
  employment_type:  string | null;
  remote:           boolean | null;
  salary:           string | null;
  date_posted:      string | null;
  valid_through:    string | null;
  description:      string | null;
}

interface EventFields {
  name:        string | null;
  start_date:  string | null;
  end_date:    string | null;
  location:    string | null;
  organizer:   string | null;
  price:       string | null;
  status:      string | null;
}

interface VideoFields {
  name:         string | null;
  duration:     string | null;
  upload_date:  string | null;
  thumbnail:    string | null;
  embed_url:    string | null;
  channel:      string | null;
  view_count:   number | null;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

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

function resolveUrl(href: string, base: string): string | null {
  try {
    return new URL(href, base).href;
  } catch { return null; }
}

/**
 * Strip HTML tags, collapse whitespace.
 * Converts block elements to newlines so prose structure is preserved.
 */
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    // Block-level tags → newline
    .replace(/<\/?(p|div|section|article|aside|header|footer|h[1-6]|li|tr|blockquote|pre|br)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    // HTML entities
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    // Collapse whitespace but keep paragraph breaks
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function reGet(html: string, re: RegExp): string | null {
  const m = re.exec(html);
  if (!m) return null;
  return (m[1] ?? m[2] ?? m[3])?.trim() ?? null;
}

function truncate(s: string | null, max = 2000): string | null {
  if (!s) return null;
  s = s.trim();
  return s.length > max ? s.slice(0, max) + '...' : s;
}

function coerceString(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

function coerceNumber(v: unknown): number | null {
  if (v == null) return null;
  const n = parseFloat(String(v));
  return isNaN(n) ? null : n;
}

function coerceInt(v: unknown): number | null {
  if (v == null) return null;
  const n = parseInt(String(v).replace(/[^0-9]/g, ''), 10);
  return isNaN(n) ? null : n;
}

// ─── Schema.org parsing ───────────────────────────────────────────────────────

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

/** Flatten @graph arrays and normalize to a flat list of typed schema blocks */
function flattenSchemaBlocks(blocks: IDataObject[]): IDataObject[] {
  const flat: IDataObject[] = [];
  for (const b of blocks) {
    if (Array.isArray(b['@graph'])) {
      flat.push(...(b['@graph'] as IDataObject[]));
    } else {
      flat.push(b);
    }
  }
  return flat;
}

function findSchemaByType(blocks: IDataObject[], ...types: string[]): IDataObject | null {
  const typeSet = new Set(types.map(t => t.toLowerCase()));
  return blocks.find(b => {
    const t = b['@type'];
    if (typeof t === 'string') return typeSet.has(t.toLowerCase());
    if (Array.isArray(t)) return (t as string[]).some(x => typeSet.has(x.toLowerCase()));
    return false;
  }) ?? null;
}

function schemaTypes(blocks: IDataObject[]): string[] {
  const seen = new Set<string>();
  for (const b of blocks) {
    const t = b['@type'];
    if (typeof t === 'string' && t) seen.add(t);
    if (Array.isArray(t)) (t as string[]).forEach(x => x && seen.add(x));
  }
  return [...seen];
}

// ─── Page type detection ──────────────────────────────────────────────────────

function detectPageType(html: string, url: string, schemaBlocks: IDataObject[]): PageType {
  const types = schemaTypes(schemaBlocks).map(t => t.toLowerCase());

  // Schema.org is the most reliable signal
  if (types.includes('product') || types.includes('offer')) return 'product';
  if (types.includes('recipe')) return 'recipe';
  if (types.includes('jobposting')) return 'job';
  if (types.includes('event') || types.includes('businessevent') || types.includes('socialevent')) return 'event';
  if (types.includes('videoobject')) return 'video';
  if (types.some(t => ['article', 'newsarticle', 'blogposting', 'reportage', 'webpage'].includes(t))) return 'article';
  if (types.some(t => ['person', 'profilepage'].includes(t))) return 'profile';

  // URL heuristics
  const path = url.toLowerCase();
  if (/\/(recipe|recipes?)\//i.test(path)) return 'recipe';
  if (/\/(job|jobs|careers?|position|vacancy|vacancies)\//i.test(path)) return 'job';
  if (/\/(event|events?|conference|meetup)\//i.test(path)) return 'event';
  if (/\/(watch|video|videos?)\//i.test(path) || /youtube\.com|vimeo\.com/.test(path)) return 'video';
  if (/\/(property|listing|rent|buy|apartment|house|flat)\//i.test(path)) return 'real_estate';
  if (/\/(forum|community|thread|discussion|topic|post)\//i.test(path)) return 'forum';
  if (/\/(docs?|documentation|guide|reference|manual|api)\//i.test(path)) return 'documentation';
  if (
    /\/(dp|product|item|sku|p\/[a-z0-9-]+|shop)\//i.test(path) ||
    /amazon\.|flipkart\.|ebay\.|etsy\./.test(path)
  ) return 'product';

  // HTML content signals
  if (/itemprop=["']recipeIngredient/i.test(html)) return 'recipe';
  if (/itemprop=["']hiringOrganization/i.test(html)) return 'job';
  if (
    /<article[\s>]/i.test(html) &&
    /(?:byline|author|published|dateline)/i.test(html)
  ) return 'article';

  return 'generic';
}

// ─── Open Graph & meta helpers ────────────────────────────────────────────────

interface MetaData {
  og:   Record<string, string>;
  meta: Record<string, string>;
}

function extractMeta(html: string): MetaData {
  const og: Record<string, string>   = {};
  const meta: Record<string, string> = {};

  const ogRe = /<meta[^>]+property=["'](og:[^"']+)["'][^>]+content=["']([^"']*)["'][^>]*\/?>/gi;
  let m;
  while ((m = ogRe.exec(html)) !== null) og[m[1].replace('og:', '')] = m[2];

  const metaRe = /<meta[^>]+name=["']([^"']+)["'][^>]+content=["']([^"']*)["'][^>]*\/?>/gi;
  while ((m = metaRe.exec(html)) !== null) meta[m[1].toLowerCase()] = m[2];

  return { og, meta };
}

// ─── Core content extraction ──────────────────────────────────────────────────

/**
 * Extract the main readable body text from a page.
 * Strategy: find the largest block of prose text, stripping nav/header/footer/sidebar noise.
 */
function extractBodyText(html: string): string | null {
  // Remove clearly non-content regions
  let cleaned = html
    .replace(/<(nav|header|footer|aside|script|style|noscript|iframe|form|svg)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  // Prefer semantic main content containers
  const candidates = [
    /<main[^>]*>([\s\S]*?)<\/main>/i,
    /<article[^>]*>([\s\S]*?)<\/article>/i,
    /id=["'](?:content|main|article|post|entry|body|story|text)[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|section|article)>/i,
    /class=["'][^"']*(?:content|article|post|entry|story|body|prose)[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|section|article)>/i,
  ];

  let best: string | null = null;
  for (const re of candidates) {
    const match = re.exec(cleaned);
    if (match && match[1] && match[1].length > (best?.length ?? 0)) {
      best = match[1];
    }
  }

  const source = best ?? cleaned;
  const text   = stripHtml(source);

  // Require at least 100 chars of real content
  return text.length >= 100 ? truncate(text, 5000) : null;
}

function extractTitle(html: string, og: Record<string, string>, meta: Record<string, string>): string | null {
  // Priority: og:title > <title> > <h1>
  if (og['title']) return og['title'].trim();

  const titleTag = reGet(html, /<title[^>]*>([\s\S]{1,300}?)<\/title>/i);
  if (titleTag) {
    const stripped = stripHtml(titleTag);
    // Strip common site-name suffixes: "Article Title | Site Name"
    const cleaned = stripped.split(/\s+[|\-–—]\s+/)[0].trim();
    if (cleaned.length >= 3) return cleaned;
  }

  const h1 = reGet(html, /<h1[^>]*>([\s\S]{1,300}?)<\/h1>/i);
  if (h1) return stripHtml(h1).trim() || null;

  if (meta['title']) return meta['title'].trim();

  return null;
}

function extractAuthor(html: string, schemaBlocks: IDataObject[], og: Record<string, string>, meta: Record<string, string>): string | null {
  // Schema.org author (Article or Person)
  const article = findSchemaByType(schemaBlocks, 'Article', 'NewsArticle', 'BlogPosting', 'Reportage');
  if (article) {
    const a = article['author'] as IDataObject | string | undefined;
    if (a) {
      const name = typeof a === 'object' ? coerceString((a as IDataObject)['name']) : coerceString(a);
      if (name) return name;
    }
  }

  // Meta tags
  if (meta['author']) return meta['author'];
  if (meta['article:author']) return meta['article:author'];
  if (og['article:author']) return og['article:author'];

  // Common HTML patterns
  return (
    reGet(html, /itemprop=["']author["'][^>]*>\s*(?:<[^>]+>)?\s*([A-Z][^<]{2,60})/) ??
    reGet(html, /class=["'][^"']*(?:byline|author|byline__name)[^"']*["'][^>]*>\s*(?:<[^>]+>)?\s*([A-Z][^<]{2,60})/) ??
    reGet(html, /rel=["']author["'][^>]*>\s*([^<]{2,60})/) ??
    null
  );
}

function extractDates(html: string, schemaBlocks: IDataObject[], meta: Record<string, string>): { published: string | null; modified: string | null } {
  const article = findSchemaByType(schemaBlocks, 'Article', 'NewsArticle', 'BlogPosting', 'WebPage');

  const published =
    coerceString(article?.['datePublished']) ??
    meta['article:published_time'] ??
    meta['date'] ??
    meta['pubdate'] ??
    reGet(html, /itemprop=["']datePublished["'][^>]*(?:content=["']([^"']+)["']|>\s*([^<]{4,30}))/) ??
    reGet(html, /<time[^>]+datetime=["']([^"']+)["']/) ??
    null;

  const modified =
    coerceString(article?.['dateModified']) ??
    meta['article:modified_time'] ??
    reGet(html, /itemprop=["']dateModified["'][^>]*content=["']([^"']+)["']/) ??
    null;

  return { published, modified };
}

function extractLanguage(html: string): string | null {
  return (
    reGet(html, /<html[^>]+lang=["']([^"']+)["']/) ??
    reGet(html, /<meta[^>]+http-equiv=["']Content-Language["'][^>]+content=["']([^"']+)["']/) ??
    null
  );
}

function extractImages(html: string, url: string): string[] {
  const seen    = new Set<string>();
  const results: string[] = [];
  const origin  = getOrigin(url);

  function add(src: string | null | undefined) {
    if (!src) return;
    src = src.trim();
    if (src.startsWith('data:')) return;
    const resolved = src.startsWith('http') ? src : resolveUrl(src, origin);
    if (!resolved) return;
    // Skip tiny tracking/spacer images and clearly non-content URLs
    if (/\/(pixel|tracking|beacon|spacer|blank|1x1)\b/i.test(resolved)) return;
    if (/\.(ico|svg)(\?|$)/i.test(resolved)) return;
    if (!seen.has(resolved)) {
      seen.add(resolved);
      results.push(resolved);
    }
  }

  // 1. og:image — usually the best representative image
  const ogImg = reGet(html, /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
  add(ogImg);

  // 2. Twitter card image
  const twImg = reGet(html, /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i);
  add(twImg);

  // 3. Schema.org image
  const blocks = flattenSchemaBlocks(extractStructuredData(html));
  for (const block of blocks) {
    const img = block['image'] as string | string[] | IDataObject | undefined;
    if (typeof img === 'string') add(img);
    else if (Array.isArray(img)) (img as string[]).forEach(add);
    else if (img && typeof img === 'object') {
      add(coerceString((img as IDataObject)['url']));
    }
  }

  // 4. Scan <img> tags — gather up to 20 meaningful images
  const re = /<img[^>]+(?:src|data-src|data-lazy-src|data-original)=["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null && results.length < 20) {
    add(m[1]);
  }

  // 5. Background images in inline styles (common for hero sections)
  const bgRe = /background(?:-image)?:\s*url\(['"]?([^'")\s]+)['"]?\)/gi;
  while ((m = bgRe.exec(html)) !== null && results.length < 20) {
    add(m[1]);
  }

  return results.slice(0, 20);
}

function extractLinks(html: string, baseUrl: string): PageLink[] {
  const origin  = getOrigin(baseUrl);
  const seen    = new Set<string>();
  const results: PageLink[] = [];

  const NOISE_PATTERNS = /\/(login|logout|signin|signup|register|cart|checkout|account|wishlist|search|sitemap|privacy|terms|contact|about|subscribe|unsubscribe)\b|\.(css|js|xml|rss|atom|json|pdf|zip)(\?|$)/i;

  const re = /<a[^>]+href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null && results.length < 50) {
    const href = m[1].trim();
    if (!href) continue;
    const resolved = href.startsWith('http') ? href : resolveUrl(href, origin);
    if (!resolved) continue;
    if (NOISE_PATTERNS.test(resolved)) continue;
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    const text = stripHtml(m[2]).slice(0, 100).trim();
    if (!text) continue;
    results.push({ url: resolved, text });
  }

  return results;
}

// ─── Type-specific field extractors ──────────────────────────────────────────

function extractProductFields(html: string, url: string, schemaBlocks: IDataObject[]): ProductFields {
  const ldProduct = findSchemaByType(schemaBlocks, 'Product');
  const ldOffers  = ldProduct?.['offers'] as IDataObject | IDataObject[] | undefined;
  const ldOffer   = Array.isArray(ldOffers) ? ldOffers[0] : ldOffers;
  const { og, meta } = extractMeta(html);

  // Name
  const name =
    coerceString(ldProduct?.['name']) ??
    og['title'] ??
    reGet(html, /<h1[^>]*>([\s\S]{1,200}?)<\/h1>/i)?.replace(/<[^>]+>/g, '').trim() ??
    null;

  // Brand
  const ldBrand = ldProduct?.['brand'] as IDataObject | string | undefined;
  const brand =
    (ldBrand ? (typeof ldBrand === 'object' ? coerceString((ldBrand as IDataObject)['name']) : coerceString(ldBrand)) : null) ??
    reGet(html, /itemprop=["']brand["'][^>]*>[\s\S]*?itemprop=["']name["'][^>]*content=["']([^"']+)["']/) ??
    reGet(html, /itemprop=["']brand["'][^>]*>\s*<[^>]+>\s*([^<]{2,80})/) ??
    meta['author'] ??
    null;

  // SKU
  const sku =
    coerceString(ldProduct?.['sku']) ??
    coerceString(ldProduct?.['mpn']) ??
    coerceString(ldProduct?.['productID']) ??
    reGet(html, /itemprop=["'](?:sku|mpn|productID)["'][^>]*content=["']([^"']+)["']/i) ??
    url.match(/\/(?:dp|product|gp\/product)\/([A-Z0-9]{10})/)?.[1] ??
    null;

  // Price
  const rawPrice =
    coerceString(ldOffer?.['price']) ??
    reGet(html, /itemprop=["']price["'][^>]*content=["']([^"']+)["']/i) ??
    reGet(html, /itemprop=["']price["'][^>]*>\s*([£$€¥₹]?[\d,. ]+)/) ??
    reGet(html, /class=["'][^"']*(?:price|rate|cost|fare)[^"']*["'][^>]*>\s*([£$€¥₹][\d,.]+)/) ??
    null;

  const currency =
    coerceString(ldOffer?.['priceCurrency']) ??
    reGet(html, /itemprop=["']priceCurrency["'][^>]*content=["']([^"']+)["']/i) ??
    rawPrice?.match(/[£$€¥₹]/)?.[0] ??
    null;

  const price_numeric = rawPrice ? (parseFloat(rawPrice.replace(/[^0-9.]/g, '')) || null) : null;
  const price = rawPrice
    ? (currency && !rawPrice.includes(currency) && !/[£$€¥₹]/.test(rawPrice) ? `${currency} ${rawPrice}` : rawPrice)
    : null;

  // Availability
  const availRaw =
    coerceString(ldOffer?.['availability']) ??
    reGet(html, /itemprop=["']availability["'][^>]*content=["']([^"']+)["']/i) ??
    null;
  const availability = availRaw
    ? (/instock|available/i.test(availRaw) ? 'Available' : 'Unavailable')
    : /\b(in stock|available now|add to cart|buy now)\b/i.test(html) ? 'Available'
    : /\b(out of stock|sold out|unavailable)\b/i.test(html) ? 'Unavailable'
    : null;

  // Rating
  const ldAgg = ldProduct?.['aggregateRating'] as IDataObject | undefined;
  const ratingRaw =
    coerceNumber(ldAgg?.['ratingValue']) ??
    coerceNumber(reGet(html, /itemprop=["']ratingValue["'][^>]*content=["']([^"']+)["']/i)) ??
    coerceNumber(reGet(html, /(\d\.\d)\s+out of 5/)) ??
    null;
  const rating = ratingRaw && ratingRaw >= 1 && ratingRaw <= 5 ? ratingRaw : null;

  const review_count =
    coerceInt(ldAgg?.['reviewCount']) ??
    coerceInt(ldAgg?.['ratingCount']) ??
    coerceInt(reGet(html, /([\d,]+)\s+(?:reviews?|ratings?)/i)) ??
    null;

  // Category
  const category =
    coerceString(ldProduct?.['category']) ??
    coerceString(ldProduct?.['breadcrumb']) ??
    null;

  return { name, brand, sku, price, price_numeric, currency, availability, rating, review_count, category };
}

function extractRecipeFields(html: string, schemaBlocks: IDataObject[]): RecipeFields {
  const ld = findSchemaByType(schemaBlocks, 'Recipe');

  const extractList = (val: unknown): string[] => {
    if (!val) return [];
    if (Array.isArray(val)) return (val as unknown[]).map(v => {
      if (typeof v === 'string') return stripHtml(v).trim();
      const o = v as IDataObject;
      return stripHtml(coerceString(o['text'] ?? o['name'] ?? o['itemListElement']) ?? '').trim();
    }).filter(Boolean);
    if (typeof val === 'string') return [stripHtml(val).trim()].filter(Boolean);
    return [];
  };

  // Fallback: scrape itemprop lists from HTML
  const scrapeItemProp = (prop: string): string[] => {
    const re = new RegExp(`itemprop=["']${prop}["'][^>]*>([^<]{2,300})<`, 'gi');
    const results: string[] = [];
    let m;
    while ((m = re.exec(html)) !== null) results.push(m[1].trim());
    return results;
  };

  const ldAgg = ld?.['aggregateRating'] as IDataObject | undefined;
  const ratingRaw = coerceNumber(ldAgg?.['ratingValue']);
  const rating = ratingRaw && ratingRaw >= 1 && ratingRaw <= 5 ? ratingRaw : null;
  const caloriesVal = ld?.['nutrition'] as IDataObject | undefined;

  return {
    name:         coerceString(ld?.['name']),
    cuisine:      coerceString(ld?.['recipeCuisine']),
    cook_time:    coerceString(ld?.['cookTime']),
    prep_time:    coerceString(ld?.['prepTime']),
    total_time:   coerceString(ld?.['totalTime']),
    yield:        typeof ld?.['recipeYield'] === 'object'
                    ? (ld?.['recipeYield'] as IDataObject[])[0]?.toString() ?? null
                    : coerceString(ld?.['recipeYield']),
    ingredients:  extractList(ld?.['recipeIngredient']) ?? scrapeItemProp('recipeIngredient'),
    instructions: extractList(ld?.['recipeInstructions']) ?? scrapeItemProp('recipeInstructions'),
    rating,
    review_count: coerceInt(ldAgg?.['reviewCount']) ?? coerceInt(ldAgg?.['ratingCount']),
    calories:     coerceString(caloriesVal?.['calories']),
  };
}

function extractJobFields(html: string, schemaBlocks: IDataObject[]): JobFields {
  const ld     = findSchemaByType(schemaBlocks, 'JobPosting');
  const org    = ld?.['hiringOrganization'] as IDataObject | undefined;
  const loc    = ld?.['jobLocation'] as IDataObject | IDataObject[] | undefined;
  const locObj = Array.isArray(loc) ? loc[0] : loc;
  const addr   = locObj?.['address'] as IDataObject | undefined;

  const location =
    coerceString(addr?.['addressLocality']) ??
    coerceString(addr?.['addressRegion']) ??
    coerceString((locObj as IDataObject | undefined)?.['name']) ??
    reGet(html, /itemprop=["']jobLocation["'][^>]*>[\s\S]*?itemprop=["']addressLocality["'][^>]*>([^<]{2,80})/) ??
    null;

  const remoteRaw = coerceString(ld?.['jobLocationType']);
  const remote    = remoteRaw ? /remote/i.test(remoteRaw) : /\bremote\b/i.test(html) ? true : null;

  const salaryObj  = ld?.['baseSalary'] as IDataObject | undefined;
  const salaryVal  = salaryObj?.['value'] as IDataObject | undefined;
  const salaryStr  =
    (salaryVal?.['minValue'] != null && salaryVal?.['maxValue'] != null)
      ? `${salaryVal['minValue']}–${salaryVal['maxValue']} ${coerceString(salaryVal?.['unitText']) ?? ''}`
      : coerceString(salaryVal?.['value']) ?? coerceString(salaryObj?.['value']);

  const descHtml = coerceString(ld?.['description']);
  const description = descHtml ? truncate(stripHtml(descHtml), 2000) : null;

  return {
    title:           coerceString(ld?.['title']) ?? reGet(html, /<h1[^>]*>([\s\S]{1,200}?)<\/h1>/i)?.replace(/<[^>]+>/g, '').trim() ?? null,
    company:         coerceString(org?.['name']) ?? reGet(html, /itemprop=["']hiringOrganization["'][^>]*>[\s\S]*?itemprop=["']name["'][^>]*>([^<]{2,80})/) ?? null,
    location,
    employment_type: coerceString(ld?.['employmentType']),
    remote,
    salary:          salaryStr ?? null,
    date_posted:     coerceString(ld?.['datePosted']),
    valid_through:   coerceString(ld?.['validThrough']),
    description,
  };
}

function extractEventFields(html: string, schemaBlocks: IDataObject[]): EventFields {
  const ld  = findSchemaByType(schemaBlocks, 'Event', 'BusinessEvent', 'SocialEvent', 'Festival', 'MusicEvent');
  const loc = ld?.['location'] as IDataObject | string | undefined;
  const org = ld?.['organizer'] as IDataObject | string | undefined;
  const off = ld?.['offers'] as IDataObject | IDataObject[] | undefined;
  const offer = Array.isArray(off) ? off[0] : off;

  const locationStr =
    (loc && typeof loc === 'object'
      ? coerceString((loc as IDataObject)['name']) ?? coerceString(((loc as IDataObject)['address'] as IDataObject | undefined)?.['streetAddress'])
      : coerceString(loc)) ??
    reGet(html, /itemprop=["']location["'][^>]*>[\s\S]*?itemprop=["']name["'][^>]*>([^<]{2,80})/) ??
    null;

  const statusRaw = coerceString(ld?.['eventStatus']);

  return {
    name:       coerceString(ld?.['name']) ?? reGet(html, /<h1[^>]*>([^<]{2,200})<\/h1>/i) ?? null,
    start_date: coerceString(ld?.['startDate']),
    end_date:   coerceString(ld?.['endDate']),
    location:   locationStr,
    organizer:  (org && typeof org === 'object' ? coerceString((org as IDataObject)['name']) : coerceString(org)) ?? null,
    price:      coerceString(offer?.['price']),
    status:     statusRaw ?? null,
  };
}

function extractVideoFields(html: string, url: string, schemaBlocks: IDataObject[]): VideoFields {
  const ld = findSchemaByType(schemaBlocks, 'VideoObject');

  // YouTube-specific extraction
  let viewCount: number | null = null;
  if (/youtube\.com|youtu\.be/.test(url)) {
    const vcM = html.match(/"viewCount"\s*:\s*"?([\d]+)"?/);
    if (vcM) viewCount = parseInt(vcM[1], 10) || null;
  }

  const thumbnail =
    coerceString((ld?.['thumbnailUrl'] as string[] | string | undefined) instanceof Array
      ? (ld?.['thumbnailUrl'] as string[])[0]
      : ld?.['thumbnailUrl']) ??
    reGet(html, /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ??
    null;

  return {
    name:        coerceString(ld?.['name']) ?? reGet(html, /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ?? null,
    duration:    coerceString(ld?.['duration']),
    upload_date: coerceString(ld?.['uploadDate']),
    thumbnail,
    embed_url:   coerceString(ld?.['embedUrl']),
    channel:     coerceString((ld?.['author'] as IDataObject | undefined)?.['name']) ?? null,
    view_count:  viewCount ?? coerceInt(ld?.['interactionCount']),
  };
}

// ─── Master extractor ─────────────────────────────────────────────────────────

function extractData(html: string, url: string): ScrapedOutput {
  const rawBlocks = extractStructuredData(html);
  const schemas   = flattenSchemaBlocks(rawBlocks);
  const pageType  = detectPageType(html, url, schemas);
  const { og, meta } = extractMeta(html);

  const title        = extractTitle(html, og, meta);
  const author       = extractAuthor(html, schemas, og, meta);
  const { published, modified } = extractDates(html, schemas, meta);
  const bodyText     = extractBodyText(html);
  const images       = extractImages(html, url);
  const links        = extractLinks(html, url);
  const language     = extractLanguage(html);

  // Meta description (short summary, distinct from body_text)
  const description =
    og['description']?.trim() ||
    meta['description']?.trim() ||
    meta['twitter:description']?.trim() ||
    null;

  return {
    url,
    source:       hostname(url),
    scraped_at:   new Date().toISOString(),
    page_type:    pageType,

    title,
    description:  description || null,
    body_text:    bodyText,
    author,
    published_at: published,
    modified_at:  modified,
    language,
    images,
    links,

    schema_types: schemaTypes(schemas),
    schema_raw:   schemas,

    // Populate only the relevant type-specific block; others are null
    product:  pageType === 'product'  ? extractProductFields(html, url, schemas) : null,
    recipe:   pageType === 'recipe'   ? extractRecipeFields(html, schemas)       : null,
    job:      pageType === 'job'      ? extractJobFields(html, schemas)           : null,
    event:    pageType === 'event'    ? extractEventFields(html, schemas)         : null,
    video:    pageType === 'video'    ? extractVideoFields(html, url, schemas)    : null,
  };
}

// ─── Syphoon API ──────────────────────────────────────────────────────────────

async function syphoonFetch(
  ctx: IExecuteFunctions, apiKey: string, url: string, itemIndex: number,
): Promise<string> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
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
      if (e.statusCode === 401 || e.statusCode === 403) throw new NodeOperationError(ctx.getNode(), 'Invalid Syphoon API key.', { itemIndex });
      if (e.statusCode === 429 && attempt < MAX_RETRIES) continue;
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
    description: 'Universal web scraper. Extracts structured data from any URL — articles, products, recipes, jobs, events, videos, forums, documentation, and more. Returns rich typed output with auto-detected page type.',
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
        placeholder: 'https://example.com/any/page',
        description: 'Any URL to scrape — product, article, recipe, job posting, event, video, forum thread, documentation page, or generic webpage.',
      },
      {
        displayName: 'API Key Setup',
        name:        'apiKeyNotice',
        type:        'notice',
        default:     'Need an API key? Go to syphoon.com → Sign Up → Dashboard → API Keys.',
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
              page_type:  'generic',
              error:      (error as Error).message,
            },
            pairedItem: i,
          });
          continue;
        }
        throw error;
      }
    }

    return [returnData];
  }
}
