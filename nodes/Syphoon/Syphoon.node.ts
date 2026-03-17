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

const SYPHOON_TRACKING_URL = 'https://api.syphoon.com';

// ─── HTML Helpers ─────────────────────────────────────────────────────────────

function getText(html: string, re: RegExp, group = 1): string | null {
  const m = html.match(re);
  return m && m[group] ? m[group].trim() : null;
}

function parsePrice(html: string): number | null {
  const whole = getText(html, /class="a-price-whole">([\d,]+)</);
  const frac  = getText(html, /class="a-price-fraction">(\d+)</);
  if (whole) return parseFloat(whole.replace(/,/g, '') + '.' + (frac ?? '00'));

  const core = getText(html, /corePriceDisplay[\s\S]{0,500}?a-offscreen["'][^>]*>\$([\d,.]+)/) ??
               getText(html, /class="a-offscreen">\$([\d,.]+)<\/span>/);
  if (core) return parseFloat(core.replace(/,/g, ''));

  const json = getText(html, /"buyingPrice"\s*:\s*"?([\d.]+)/) ??
               getText(html, /"price"\s*:\s*"?\$([\d,.]+)/);
  if (json) return parseFloat(json.replace(/,/g, ''));

  return null;
}

function parseProduct(html: string, asin: string): IDataObject {
  const current_price = parsePrice(html);

  const orig_raw = getText(html, /class="a-price a-text-price[^"]*"[^>]*>\s*<span[^>]*>\$([\d,.]+)/) ??
                   getText(html, /basisPrice[^>]*>[\s\S]{0,100}?\$([\d,.]+)/);
  const original_price = orig_raw ? parseFloat(orig_raw.replace(/,/g, '')) : null;
  const sale_price = original_price && current_price && current_price < original_price ? current_price : null;

  const title = getText(html, /id="productTitle"[^>]*>\s*([\s\S]{1,300}?)\s*<\/span>/) ??
                getText(html, /"title"\s*:\s*"([^"]{5,200})"/) ??
                getText(html, /<title>([^<]{5,200})<\/title>/);

  const brand = getText(html, /id="bylineInfo"[^>]*>[\s\S]{0,400}?(?:Visit the |Brand: ?)([^<\n]{2,60})(?:<| Store)/) ??
                getText(html, /"brand"\s*:\s*"([^"]{1,100})"/) ??
                getText(html, /class="po-brand"[\s\S]{0,200}?<td[^>]*>\s*<span[^>]*>([^<]{1,80})</);

  const rating_str  = getText(html, /(\d\.\d) out of 5 stars/) ??
                      getText(html, /"ratingScore"\s*:\s*"?([\d.]+)/);
  const reviews_str = getText(html, /([\d,]+)\s+(?:global )?ratings/) ??
                      getText(html, /id="acrCustomerReviewText"[^>]*>([\d,]+)/);

  const img = getText(html, /id="landingImage"[^>]*data-old-hires="([^"]+)"/) ??
              getText(html, /id="landingImage"[^>]*src="([^"]+)"/) ??
              getText(html, /"large"\s*:\s*"(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+)"/) ??
              getText(html, /data-a-dynamic-image="[^"]*?(https:\/\/m\.media-amazon\.com\/images\/I\/[^"\\]+)/);

  const avail_raw = getText(html, /id="availability"[^>]*>[\s\S]{0,300}?<span[^>]*>\s*([^<\n]{3,80})/);
  let availability = 'In Stock';
  if (avail_raw) {
    const al = avail_raw.toLowerCase();
    if (al.includes('out of stock') || al.includes('unavailable')) availability = 'Out of Stock';
    else if (al.includes('only') || al.includes('limited'))        availability = 'Limited Stock';
    else availability = avail_raw.replace(/\s+/g, ' ').trim();
  }

  let seller = 'Third Party';
  if (html.includes('Sold by Amazon') || html.includes('Ships from Amazon.com') || html.includes('Fulfilled by Amazon')) {
    seller = 'Amazon';
  }
  const seller_name = getText(html, /id="sellerProfileTriggerId"[^>]*>([^<]{1,80})</) ??
                      getText(html, /(?:Sold by|Ships from)\s*<[^>]*>\s*([^<]{1,60})</) ??
                      seller;

  return {
    asin,
    title:             title ? title.replace(/&amp;/g, '&').replace(/&#\d+;/g, '').trim() : null,
    brand:             brand ? brand.replace(/&amp;/g, '&').trim() : null,
    current_price,
    original_price,
    sale_price,
    rating:            rating_str ? parseFloat(rating_str) : null,
    review_count:      reviews_str ? parseInt(reviews_str.replace(/,/g, ''), 10) : null,
    availability,
    seller:            seller_name,
    is_sold_by_amazon: seller === 'Amazon',
    image_url:         img ?? null,
    product_url:       `https://www.amazon.com/dp/${asin}`,
    scraped_at:        new Date().toISOString(),
  };
}

function parseSearchResults(html: string): IDataObject[] {
  const results: IDataObject[] = [];
  const seen = new Set<string>();

  const asinPattern = /data-asin="([A-Z0-9]{10})"/g;
  let match;
  while ((match = asinPattern.exec(html)) !== null) {
    const asin = match[1];
    if (seen.has(asin) || asin === '0000000000') continue;
    seen.add(asin);

    const start = match.index;
    const block = html.slice(start, start + 4000);

    const t1 = getText(block, /class="a-size-medium[^"]*"[^>]*>\s*([^<]{10,200})</);
    const t2 = getText(block, /class="a-size-base-plus[^"]*"[^>]*>\s*([^<]{10,200})</);
    const t3 = getText(block, /class="a-text-normal"[^>]*>\s*([^<]{10,200})</);
    const t4 = getText(block, /aria-label="([^"]{10,200})"/);

    const badgePatterns = /^(amazon|overall pick|best seller|limited deal|sponsored|results|showing|sort by|filter|brand|price|rating)/i;
    const rawTitle = [t1, t2, t3, t4].find(t => t && t.length > 10 && !badgePatterns.test(t.trim())) ?? null;
    const title = rawTitle ? rawTitle.replace(/&#x27;/g, "'").replace(/&amp;/g, '&').trim() : null;

    const priceWhole = getText(block, /class="a-price-whole">([\d,]+)</);
    const priceFrac  = getText(block, /class="a-price-fraction">(\d+)</);
    const price = priceWhole
      ? parseFloat(priceWhole.replace(/,/g, '') + '.' + (priceFrac ?? '00'))
      : null;

    const rating  = getText(block, /(\d\.\d) out of 5/);
    const reviews = getText(block, /([\d,]+)\s+ratings?/);
    const img     = getText(block, /class="s-image"[^>]*src="([^"]+)"/) ??
                    getText(block, /src="(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+)"/);

    if (asin && title) {
      results.push({
        asin,
        title:        title.trim(),
        price,
        rating:       rating ? parseFloat(rating) : null,
        review_count: reviews ? parseInt(reviews.replace(/,/g, ''), 10) : null,
        image_url:    img ?? null,
        product_url:  `https://www.amazon.com/dp/${asin}`,
      });
    }

    if (results.length >= 20) break;
  }
  return results;
}

// ─── Auto keyword builder ─────────────────────────────────────────────────────

function buildSearchKeyword(title: string, brand: string | null): { keyword: string; weight: string | null } {
  // Extract weight/size from title e.g. 100g, 3.5oz, 85g, 200g
  const weightMatch = title.match(/(\d+(?:\.\d+)?)\s*(g|kg|oz|ounce|lb|lbs|ml|l)\b/i);
  const weight = weightMatch ? `${weightMatch[1]}${weightMatch[2].toLowerCase()}` : null;

  // Strip brand from title if known
  let cleaned = title;
  if (brand) {
    cleaned = cleaned.replace(new RegExp(brand, 'gi'), '').trim();
  }

  // Remove common noise words
  cleaned = cleaned
    .replace(/\b(pack of|count|each|value|bundle|set|lot|case|box|bag)\b/gi, '')
    .replace(/[^a-z0-9\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Take first 5-6 meaningful words
  const words = cleaned.split(' ').filter(w => w.length > 2).slice(0, 6);
  const keyword = words.join(' ') + (weight ? ` ${weight}` : '');

  return { keyword: keyword.trim(), weight };
}

function matchesWeight(title: string, targetWeight: string): boolean {
  if (!targetWeight) return true;
  const num = parseFloat(targetWeight);
  const unit = targetWeight.replace(/[\d.]/g, '').trim();
  // Allow ±30% weight variance
  const min = num * 0.7;
  const max = num * 1.3;
  const titleWeights = [...title.matchAll(/(\d+(?:\.\d+)?)\s*(g|kg|oz|ounce|lb|lbs)\b/gi)];
  if (!titleWeights.length) return true; // no weight in title — don't filter out
  return titleWeights.some(m => {
    const w = parseFloat(m[1]);
    const u = m[2].toLowerCase();
    if (u === unit.toLowerCase()) return w >= min && w <= max;
    return false;
  });
}

// ─── Price Intelligence ───────────────────────────────────────────────────────

function normalisePriceIntelligence(product: IDataObject, myPrice: number, cost: number, marginFloor: number): IDataObject {
  const current_price = product.current_price as number | null;
  const min_viable    = parseFloat((cost * (1 + marginFloor / 100)).toFixed(2));

  if (current_price === null) {
    return { ...product, my_price: myPrice, cost, margin_floor: marginFloor, min_viable_price: min_viable };
  }

  const gap_abs            = parseFloat((myPrice - current_price).toFixed(2));
  const gap_pct            = parseFloat(((gap_abs / current_price) * 100).toFixed(2));
  const competitor_cheaper = current_price < myPrice;
  const margin_at_competitor = current_price > 0
    ? parseFloat(((current_price - cost) / current_price * 100).toFixed(2))
    : null;

  let urgency = 'low';
  let opportunity_score = 0;
  if (competitor_cheaper) {
    const abs = Math.abs(gap_pct);
    if (abs > 15)     { urgency = 'critical'; opportunity_score = Math.min(100, 90 + (abs - 15)); }
    else if (abs > 8) { urgency = 'high';     opportunity_score = 70 + (abs - 8) * 2; }
    else if (abs > 3) { urgency = 'medium';   opportunity_score = 40 + (abs - 3) * 6; }
    else              { urgency = 'low';       opportunity_score = 15; }
  }

  let recommendation = 'hold';
  if (competitor_cheaper) {
    recommendation = current_price >= min_viable
      ? (Math.abs(gap_pct) > 10 ? 'match' : 'undercut')
      : 'hold';
  } else if (!competitor_cheaper && gap_pct > 20) {
    recommendation = 'raise';
  }

  return {
    ...product,
    my_price: myPrice,
    cost,
    margin_floor: marginFloor,
    min_viable_price: min_viable,
    gap_abs,
    gap_pct,
    competitor_cheaper,
    margin_at_competitor,
    profitable_at_competitor: margin_at_competitor !== null ? margin_at_competitor > 0 : null,
    urgency,
    opportunity_score: Math.min(100, Math.round(opportunity_score)),
    recommendation,
  };
}

// ─── Alert helpers ────────────────────────────────────────────────────────────

function buildDiscordEmbed(product: IDataObject): IDataObject {
  const urgency = (product.urgency as string) ?? 'low';
  const emoji   = urgency === 'critical' ? '🚨' : urgency === 'high' ? '⚠️' : urgency === 'medium' ? '📊' : '✅';

  const fields: IDataObject[] = [
    { name: 'Competitor Price', value: `$${product.current_price}`,        inline: true },
    { name: 'Your Price',       value: `$${product.my_price}`,             inline: true },
    { name: 'Gap',              value: `${product.gap_pct}%`,              inline: true },
    { name: 'Urgency',          value: String(urgency).toUpperCase(),      inline: true },
    { name: 'Recommendation',   value: String(product.recommendation ?? '').toUpperCase(), inline: true },
    { name: 'Opp. Score',       value: `${product.opportunity_score}/100`, inline: true },
    { name: 'Availability',     value: String(product.availability),      inline: true },
    { name: 'Seller',           value: String(product.seller),            inline: true },
    { name: 'Min Viable Price', value: `$${product.min_viable_price}`,    inline: true },
  ];

  if (product.ai_recommendation) {
    fields.push({ name: '🤖 AI Insight', value: String(product.ai_recommendation), inline: false });
  }

  return {
    embeds: [{
      title:     `${emoji} Price Alert — ${product.title ?? product.asin}`,
      color:     urgency === 'critical' ? 16711680 : urgency === 'high' ? 16737843 : 16755200,
      fields,
      url:       product.product_url as string,
      footer:    { text: 'Syphoon Price Intelligence' },
      timestamp: new Date().toISOString(),
    }],
  };
}

function buildTelegramMessage(product: IDataObject): string {
  const urgency = (product.urgency as string) ?? 'low';
  const emoji   = urgency === 'critical' ? '🚨' : urgency === 'high' ? '⚠️' : '📊';

  const lines = [
    `${emoji} *Price Alert — ${product.title ?? product.asin}*`,
    ``,
    `💰 Competitor: *$${product.current_price}*`,
    `🏷️ Your Price: *$${product.my_price}*`,
    `📉 Gap: *${product.gap_pct}%*`,
    `🎯 Recommendation: *${String(product.recommendation ?? '').toUpperCase()}*`,
    `⚡ Urgency: *${String(urgency).toUpperCase()}*`,
  ];

  if (product.ai_recommendation) {
    lines.push(``, `🤖 *AI Insight:* ${product.ai_recommendation}`);
  }

  lines.push(``, `[View on Amazon](${product.product_url})`);
  return lines.join('\n');
}

// ─── DB tracking helper ───────────────────────────────────────────────────────

async function trackToSyphoon(
  ctx: IExecuteFunctions,
  endpoint: string,
  body: IDataObject,
  apiKey: string,
): Promise<void> {
  try {
    await ctx.helpers.request({
      method: 'POST',
      url: `${SYPHOON_TRACKING_URL}${endpoint}`,
      headers: {
        'Content-Type': 'application/json',
        'X-Syphoon-Key': apiKey,
      },
      body: JSON.stringify(body),
      timeout: 8000,
    });
  } catch {
    // Silent fail — tracking should never break the main workflow
  }
}

// ─── Node definition ──────────────────────────────────────────────────────────

export class Syphoon implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Syphoon',
    name: 'syphoon',
    icon: 'file:icon.svg',
    group: ['transform'],
    version: 1,
    subtitle: '={{$parameter["operation"]}}',
    description: 'Amazon product scraping, competitor discovery, price intelligence, and alerts via Syphoon API',
    defaults: { name: 'Syphoon' },
    inputs: ['main'],
    outputs: ['main'],
    credentials: [{ name: 'syphoonApi', required: true }],
    properties: [

      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        options: [
          { name: 'Get Product',                        value: 'getProduct',              description: 'Scrape a single Amazon product by ASIN',                                                          action: 'Get a product by ASIN' },
          { name: 'Get Product with Price Intelligence', value: 'getProductIntelligence',  description: 'Scrape a product and calculate competitive pricing metrics against your price',                   action: 'Get product with price intelligence' },
          { name: 'Batch Get Products',                 value: 'batchGetProducts',        description: 'Scrape multiple ASINs at once (rate-limited automatically)',                                      action: 'Batch get products' },
          { name: 'Auto Discover Competitors',          value: 'autoDiscoverCompetitors', description: 'Enter your product ASIN — node automatically finds competitors by weight and category, no AI needed', action: 'Auto discover competitors from ASIN' },
          { name: 'Discover Competitors with AI',       value: 'discoverCompetitors',     description: 'Search Amazon then use Groq AI to filter only products that match your product name and weight',  action: 'Discover competitors with AI' },
          { name: 'Monitor Price and Alert',            value: 'monitorAndAlert',         description: 'Scrape a product, run price intelligence, and alert via Discord or Telegram when price drops',    action: 'Monitor price and send alert' },
        ],
        default: 'getProduct',
      },

      // ── ASIN ────────────────────────────────────────────────────────────
      {
        displayName: 'ASIN',
        name: 'asin',
        type: 'string',
        default: '',
        required: true,
        displayOptions: { show: { operation: ['getProduct', 'getProductIntelligence', 'monitorAndAlert', 'autoDiscoverCompetitors'] } },
        description: 'Amazon ASIN or full product URL',
        placeholder: 'B07X41PWTY',
      },

      // ── Batch ASINs ──────────────────────────────────────────────────────
      {
        displayName: 'ASINs',
        name: 'asins',
        type: 'string',
        default: '',
        required: true,
        displayOptions: { show: { operation: ['batchGetProducts'] } },
        description: 'Comma-separated ASINs (max 50)',
        placeholder: 'B07X41PWTY,B09B8RVKGM',
      },

      // ── Manual search keyword (AI discovery only) ────────────────────────
      {
        displayName: 'Search Keyword',
        name: 'keyword',
        type: 'string',
        default: '',
        required: true,
        displayOptions: { show: { operation: ['discoverCompetitors'] } },
        description: 'Amazon search keyword to find competitor products',
        placeholder: 'thai rice chips 85g',
      },

      // ── Price Intelligence ───────────────────────────────────────────────
      {
        displayName: 'Your Current Price ($)',
        name: 'myPrice',
        type: 'number',
        default: 0,
        required: true,
        displayOptions: { show: { operation: ['getProductIntelligence', 'monitorAndAlert', 'autoDiscoverCompetitors'] } },
        description: 'Your listed price for this product on Amazon',
      },
      {
        displayName: 'Your Cost ($)',
        name: 'cost',
        type: 'number',
        default: 0,
        required: true,
        displayOptions: { show: { operation: ['getProductIntelligence', 'monitorAndAlert', 'autoDiscoverCompetitors'] } },
        description: 'Your unit cost / COGS',
      },
      {
        displayName: 'Minimum Margin (%)',
        name: 'marginFloor',
        type: 'number',
        default: 20,
        required: true,
        displayOptions: { show: { operation: ['getProductIntelligence', 'monitorAndAlert', 'autoDiscoverCompetitors'] } },
        description: 'Minimum acceptable profit margin percentage',
      },

      // ── AI Discovery ─────────────────────────────────────────────────────
      {
        displayName: 'Your Product Name',
        name: 'myProductName',
        type: 'string',
        default: '',
        required: true,
        displayOptions: { show: { operation: ['discoverCompetitors'] } },
        description: 'Full product name including weight for AI comparison',
        placeholder: 'Thai Rice Chips by Natch 85g',
      },
      {
        displayName: 'Groq API Key',
        name: 'groqApiKey',
        type: 'string',
        typeOptions: { password: true },
        default: '',
        required: true,
        displayOptions: { show: { operation: ['discoverCompetitors'] } },
        description: 'Your Groq API key. Get one free at console.groq.com',
      },

      // ── Alert settings ───────────────────────────────────────────────────
      {
        displayName: 'Alert Channel',
        name: 'alertChannel',
        type: 'options',
        required: true,
        displayOptions: { show: { operation: ['monitorAndAlert'] } },
        options: [
          { name: 'Discord Webhook',          value: 'discord' },
          { name: 'Telegram Bot',             value: 'telegram' },
          { name: 'Both Discord + Telegram',  value: 'both' },
          { name: 'None (return data only)',  value: 'none' },
        ],
        default: 'discord',
      },
      {
        displayName: 'Discord Webhook URL',
        name: 'discordWebhook',
        type: 'string',
        default: '',
        displayOptions: { show: { operation: ['monitorAndAlert'], alertChannel: ['discord', 'both'] } },
        placeholder: 'https://discord.com/api/webhooks/...',
      },
      {
        displayName: 'Telegram Bot Token',
        name: 'telegramToken',
        type: 'string',
        typeOptions: { password: true },
        default: '',
        displayOptions: { show: { operation: ['monitorAndAlert'], alertChannel: ['telegram', 'both'] } },
      },
      {
        displayName: 'Telegram Chat ID',
        name: 'telegramChatId',
        type: 'string',
        default: '',
        displayOptions: { show: { operation: ['monitorAndAlert'], alertChannel: ['telegram', 'both'] } },
        placeholder: '-1001234567890',
      },
      {
        displayName: 'Alert Only on Price Drop',
        name: 'alertOnDropOnly',
        type: 'boolean',
        default: true,
        displayOptions: { show: { operation: ['monitorAndAlert'] } },
      },
      {
        displayName: 'Minimum Urgency to Alert',
        name: 'minUrgency',
        type: 'options',
        default: 'high',
        displayOptions: { show: { operation: ['monitorAndAlert'] } },
        options: [
          { name: 'Any (low+)',    value: 'low' },
          { name: 'Medium+',       value: 'medium' },
          { name: 'High+',         value: 'high' },
          { name: 'Critical only', value: 'critical' },
        ],
      },
      {
        displayName: 'Enable AI Pricing Recommendation',
        name: 'enableAI',
        type: 'boolean',
        default: false,
        displayOptions: { show: { operation: ['monitorAndAlert'] } },
      },
      {
        displayName: 'Groq API Key (for AI Recommendation)',
        name: 'groqApiKeyAlert',
        type: 'string',
        typeOptions: { password: true },
        default: '',
        displayOptions: { show: { operation: ['monitorAndAlert'], enableAI: [true] } },
        description: 'Get one free at console.groq.com',
      },

      // ── Options ──────────────────────────────────────────────────────────
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        placeholder: 'Add Option',
        default: {},
        options: [
          {
            displayName: 'Amazon Marketplace',
            name: 'marketplace',
            type: 'options',
            default: 'amazon.com',
            options: [
              { name: 'Amazon US',  value: 'amazon.com' },
              { name: 'Amazon UK',  value: 'amazon.co.uk' },
              { name: 'Amazon DE',  value: 'amazon.de' },
              { name: 'Amazon FR',  value: 'amazon.fr' },
              { name: 'Amazon IN',  value: 'amazon.in' },
              { name: 'Amazon CA',  value: 'amazon.ca' },
              { name: 'Amazon JP',  value: 'amazon.co.jp' },
              { name: 'Amazon AU',  value: 'amazon.com.au' },
            ],
          },
          {
            displayName: 'Batch Delay (ms)',
            name: 'batchDelay',
            type: 'number',
            default: 10000,
            displayOptions: { show: { '/operation': ['batchGetProducts'] } },
          },
          {
            displayName: 'Request Timeout (ms)',
            name: 'timeout',
            type: 'number',
            default: 30000,
          },
        ],
      },
    ],
  };

  // ── Execute ───────────────────────────────────────────────────────────────

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items       = this.getInputData();
    const returnData: INodeExecutionData[] = [];
    const credentials = await this.getCredentials('syphoonApi');
    const apiKey      = credentials.apiKey as string;

    for (let i = 0; i < items.length; i++) {
      const operation   = this.getNodeParameter('operation', i) as string;
      const options     = this.getNodeParameter('options', i, {}) as IDataObject;
      const marketplace = (options.marketplace as string) ?? 'amazon.com';
      const timeout     = (options.timeout as number) ?? 30000;

      try {

        // ── getProduct ──────────────────────────────────────────────────
        if (operation === 'getProduct') {
          const asin = extractAsin(this.getNodeParameter('asin', i) as string);
          if (!asin) throw new NodeOperationError(this.getNode(), 'Invalid ASIN or URL', { itemIndex: i });
          const html    = await syphoonRequest(this, apiKey, `https://www.${marketplace}/dp/${asin}`, timeout, i);
          const product = parseProduct(html, asin);

          // Track to DB silently
          await trackToSyphoon(this, '/track/price', { asin, ...product }, apiKey);

          returnData.push({ json: product, pairedItem: i });
        }

        // ── getProductIntelligence ──────────────────────────────────────
        else if (operation === 'getProductIntelligence') {
          const asin        = extractAsin(this.getNodeParameter('asin', i) as string);
          if (!asin) throw new NodeOperationError(this.getNode(), 'Invalid ASIN or URL', { itemIndex: i });
          const myPrice     = this.getNodeParameter('myPrice', i) as number;
          const cost        = this.getNodeParameter('cost', i) as number;
          const marginFloor = this.getNodeParameter('marginFloor', i) as number;
          const html        = await syphoonRequest(this, apiKey, `https://www.${marketplace}/dp/${asin}`, timeout, i);
          const product     = parseProduct(html, asin);
          const enriched    = normalisePriceIntelligence(product, myPrice, cost, marginFloor);

          // Save product + price snapshot
          await trackToSyphoon(this, '/track/product', {
            product: { asin, ...product, my_price: myPrice, cost, margin_floor: marginFloor },
            competitors: [],
          }, apiKey);
          await trackToSyphoon(this, '/track/price', { asin, ...enriched }, apiKey);

          returnData.push({ json: enriched, pairedItem: i });
        }

        // ── batchGetProducts ────────────────────────────────────────────
        else if (operation === 'batchGetProducts') {
          const rawAsins   = this.getNodeParameter('asins', i) as string;
          const batchDelay = (options.batchDelay as number) ?? 10000;
          const asinList   = rawAsins.split(',').map(a => extractAsin(a.trim())).filter((a): a is string => Boolean(a)).slice(0, 50);
          if (!asinList.length) throw new NodeOperationError(this.getNode(), 'No valid ASINs found', { itemIndex: i });
          for (let idx = 0; idx < asinList.length; idx++) {
            const html    = await syphoonRequest(this, apiKey, `https://www.${marketplace}/dp/${asinList[idx]}`, timeout, i);
            const product = parseProduct(html, asinList[idx]);
            await trackToSyphoon(this, '/track/price', { asin: asinList[idx], ...product }, apiKey);
            returnData.push({ json: product, pairedItem: i });
            if (idx < asinList.length - 1) await sleep(batchDelay);
          }
        }

        // ── autoDiscoverCompetitors — NO AI needed ──────────────────────
        else if (operation === 'autoDiscoverCompetitors') {
          const rawAsin     = this.getNodeParameter('asin', i) as string;
          const asin        = extractAsin(rawAsin);
          if (!asin) throw new NodeOperationError(this.getNode(), 'Invalid ASIN or URL', { itemIndex: i });
          const myPrice     = this.getNodeParameter('myPrice', i) as number;
          const cost        = this.getNodeParameter('cost', i) as number;
          const marginFloor = this.getNodeParameter('marginFloor', i) as number;

          // Step 1: fetch user's own product
          const productHtml = await syphoonRequest(this, apiKey, `https://www.${marketplace}/dp/${asin}`, timeout, i);
          const myProduct   = parseProduct(productHtml, asin);

          if (!myProduct.title) {
            throw new NodeOperationError(this.getNode(), `Could not extract title for ASIN ${asin}. Check the ASIN is valid.`, { itemIndex: i });
          }

          // Step 2: build search keyword automatically from title
          const { keyword, weight } = buildSearchKeyword(
            myProduct.title as string,
            myProduct.brand as string | null,
          );

          // Step 3: search Amazon
          const searchUrl  = `https://www.${marketplace}/s?k=${encodeURIComponent(keyword)}`;
          const searchHtml = await syphoonRequest(this, apiKey, searchUrl, timeout, i);
          const rawResults = parseSearchResults(searchHtml);

          // Step 4: filter by weight match and exclude own ASIN
          const competitors = rawResults.filter(r =>
            r.asin !== asin &&
            r.title &&
            (!weight || matchesWeight(r.title as string, weight)),
          );

          // Step 5: save to DB
          await trackToSyphoon(this, '/track/product', {
            product: {
              asin,
              title:       myProduct.title,
              brand:       myProduct.brand,
              image_url:   myProduct.image_url,
              product_url: myProduct.product_url,
              my_price:    myPrice,
              cost,
              margin_floor: marginFloor,
            },
            competitors: competitors.map(c => ({
              asin:        c.asin,
              title:       c.title,
              image_url:   c.image_url,
              product_url: c.product_url,
            })),
          }, apiKey);

          // Step 6: return each competitor
          for (const c of competitors) {
            returnData.push({
              json: {
                ...c,
                my_product_asin:  asin,
                my_product_title: myProduct.title,
                search_keyword:   keyword,
                weight_filter:    weight,
                is_competitor:    true,
              },
              pairedItem: i,
            });
          }

          if (!competitors.length) {
            returnData.push({
              json: {
                my_product_asin: asin,
                search_keyword:  keyword,
                competitors:     [],
                message:         `No competitors found matching weight "${weight}" for keyword "${keyword}"`,
              },
              pairedItem: i,
            });
          }
        }

        // ── discoverCompetitors — with Groq AI ──────────────────────────
        else if (operation === 'discoverCompetitors') {
          const keyword       = this.getNodeParameter('keyword', i) as string;
          const myProductName = this.getNodeParameter('myProductName', i) as string;
          const groqApiKey    = this.getNodeParameter('groqApiKey', i) as string;

          const searchUrl = `https://www.${marketplace}/s?k=${encodeURIComponent(keyword)}`;
          const html      = await syphoonRequest(this, apiKey, searchUrl, timeout, i);
          const results   = parseSearchResults(html);

          if (!results.length) {
            returnData.push({ json: { keyword, competitors: [], ai_summary: 'No products found' }, pairedItem: i });
            continue;
          }

          const productList = results.map((r, idx) =>
            `${idx + 1}. ASIN: ${r.asin} | Title: ${r.title} | Price: $${r.price ?? 'N/A'}`,
          ).join('\n');

          const groqPrompt = `My product is: "${myProductName}"

Here are Amazon search results for "${keyword}":
${productList}

Identify which of these are DIRECT competitors — must be a similar snack/food product, same category, similar weight/size, different brand. Exclude products that are clearly different (e.g. seasonings, garlic, spices if my product is chips).
Return ONLY a JSON array of ASINs. No explanation, no markdown.
Example: ["B07X41PWTY","B09B8RVKGM"]
If none match, return [].`;

          let competitorAsins: string[] = [];
          try {
            const groqRaw = await this.helpers.request({
              method: 'POST',
              url: 'https://api.groq.com/openai/v1/chat/completions',
              headers: { 'Authorization': `Bearer ${groqApiKey}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                model: 'llama-3.1-8b-instant',
                max_tokens: 200,
                temperature: 0.1,
                messages: [
                  { role: 'system', content: 'You are a product analyst. Return only valid JSON arrays, no explanation.' },
                  { role: 'user',   content: groqPrompt },
                ],
              }),
              timeout: 15000,
            }) as string;
            const parsed  = JSON.parse(groqRaw);
            const content = parsed?.choices?.[0]?.message?.content ?? '[]';
            competitorAsins = JSON.parse(content.replace(/```json|```/g, '').trim());
          } catch {
            competitorAsins = results.map(r => r.asin as string);
          }

          const competitors = results.filter(r => competitorAsins.includes(r.asin as string));

          // Save to DB
          await trackToSyphoon(this, '/track/product', {
            product: { asin: null, title: myProductName },
            competitors: competitors.map(c => ({ asin: c.asin, title: c.title, image_url: c.image_url })),
          }, apiKey);

          if (competitors.length) {
            for (const c of competitors) {
              returnData.push({ json: { ...c, keyword, my_product: myProductName, is_competitor: true }, pairedItem: i });
            }
          } else {
            returnData.push({ json: { keyword, my_product: myProductName, competitors: [], message: 'AI found no direct competitors' }, pairedItem: i });
          }
        }

        // ── monitorAndAlert ─────────────────────────────────────────────
        else if (operation === 'monitorAndAlert') {
          const asin         = extractAsin(this.getNodeParameter('asin', i) as string);
          if (!asin) throw new NodeOperationError(this.getNode(), 'Invalid ASIN or URL', { itemIndex: i });
          const myPrice      = this.getNodeParameter('myPrice', i) as number;
          const cost         = this.getNodeParameter('cost', i) as number;
          const marginFloor  = this.getNodeParameter('marginFloor', i) as number;
          const alertChannel = this.getNodeParameter('alertChannel', i) as string;
          const alertOnDrop  = this.getNodeParameter('alertOnDropOnly', i) as boolean;
          const minUrgency   = this.getNodeParameter('minUrgency', i) as string;
          const enableAI     = this.getNodeParameter('enableAI', i) as boolean;

          const html     = await syphoonRequest(this, apiKey, `https://www.${marketplace}/dp/${asin}`, timeout, i);
          const product  = parseProduct(html, asin);
          const enriched = normalisePriceIntelligence(product, myPrice, cost, marginFloor) as IDataObject;

          // AI recommendation (optional)
          if (enableAI) {
            const groqApiKeyAlert = this.getNodeParameter('groqApiKeyAlert', i) as string;
            if (groqApiKeyAlert) {
              try {
                const groqRaw = await this.helpers.request({
                  method: 'POST',
                  url: 'https://api.groq.com/openai/v1/chat/completions',
                  headers: { 'Authorization': `Bearer ${groqApiKeyAlert}`, 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    model: 'llama-3.1-8b-instant',
                    max_tokens: 180,
                    temperature: 0.5,
                    messages: [
                      { role: 'system', content: 'You are a sharp competitive pricing analyst. Give concise, actionable recommendations in 2 sentences max.' },
                      { role: 'user', content: `Product: ${enriched.title}\nMy Price: $${enriched.my_price}\nCompetitor Price: $${enriched.current_price}\nGap: ${enriched.gap_pct}%\nRecommendation: ${enriched.recommendation}\nUrgency: ${enriched.urgency}\nMargin at competitor price: ${enriched.margin_at_competitor}%\nMin viable price: $${enriched.min_viable_price}\n\nGive a direct 2-sentence pricing recommendation.` },
                    ],
                  }),
                  timeout: 15000,
                }) as string;
                const parsed = JSON.parse(groqRaw);
                enriched.ai_recommendation = parsed?.choices?.[0]?.message?.content?.trim() ?? null;
              } catch {
                enriched.ai_recommendation = 'AI recommendation unavailable.';
              }
            }
          }

          // Alert logic
          const urgencyOrder: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };
          const currentLevel = urgencyOrder[enriched.urgency as string] ?? 0;
          const minLevel     = urgencyOrder[minUrgency] ?? 2;
          const shouldAlert  = alertOnDrop
            ? (enriched.competitor_cheaper === true && currentLevel >= minLevel)
            : true;

          enriched.alert_sent    = shouldAlert;
          enriched.alert_channel = alertChannel;

          if (shouldAlert && alertChannel !== 'none') {
            if (alertChannel === 'discord' || alertChannel === 'both') {
              const webhook = this.getNodeParameter('discordWebhook', i) as string;
              if (webhook) {
                await this.helpers.request({
                  method: 'POST', url: webhook,
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(buildDiscordEmbed(enriched)),
                  timeout: 10000,
                });
                enriched.discord_alert_sent = true;
              }
            }
            if (alertChannel === 'telegram' || alertChannel === 'both') {
              const token  = this.getNodeParameter('telegramToken', i) as string;
              const chatId = this.getNodeParameter('telegramChatId', i) as string;
              if (token && chatId) {
                await this.helpers.request({
                  method: 'POST',
                  url: `https://api.telegram.org/bot${token}/sendMessage`,
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ chat_id: chatId, text: buildTelegramMessage(enriched), parse_mode: 'Markdown' }),
                  timeout: 10000,
                });
                enriched.telegram_alert_sent = true;
              }
            }
          }

          // Track to DB silently
          await trackToSyphoon(this, '/track/price', {
            ...enriched,
            alert_sent:    shouldAlert,
            alert_channel: alertChannel,
          }, apiKey);

          returnData.push({ json: enriched, pairedItem: i });
        }

      } catch (error) {
        if (this.continueOnFail()) {
          returnData.push({ json: { error: (error as Error).message }, pairedItem: i });
          continue;
        }
        throw error;
      }
    }

    return [returnData];
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractAsin(input: string): string | null {
  if (/^[A-Z0-9]{10}$/i.test(input.trim())) return input.trim().toUpperCase();
  const m = input.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
  return m ? m[1].toUpperCase() : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function syphoonRequest(
  ctx: IExecuteFunctions,
  apiKey: string,
  url: string,
  timeout: number,
  itemIndex: number,
): Promise<string> {
  let response: IDataObject;
  try {
    response = await ctx.helpers.request({
      method: 'POST',
      url: 'https://api.syphoon.com/',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, key: apiKey, method: 'GET' }),
      timeout,
      resolveWithFullResponse: false,
    }) as IDataObject;
  } catch (err: unknown) {
    const httpErr = err as { statusCode?: number; message?: string };
    if (httpErr.statusCode === 402) throw new NodeOperationError(ctx.getNode(), 'Syphoon trial exhausted. Upgrade at https://app.syphoon.com/billing', { itemIndex });
    if (httpErr.statusCode === 401 || httpErr.statusCode === 403) throw new NodeOperationError(ctx.getNode(), 'Invalid Syphoon API key. Check at https://app.syphoon.com/api-keys', { itemIndex });
    if (httpErr.statusCode === 429) throw new NodeOperationError(ctx.getNode(), 'Syphoon rate limit hit. Increase delay or reduce polling frequency.', { itemIndex });
    throw new NodeApiError(ctx.getNode(), err as JsonObject, { itemIndex });
  }

  if (typeof response === 'string') return response;
  if (response.data && typeof response.data === 'string') return response.data;
  throw new NodeOperationError(ctx.getNode(), `Unexpected response format from Syphoon for: ${url}`, { itemIndex });
}
