import {
  IExecuteFunctions,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
  NodeOperationError,
  NodeApiError,
  IDataObject,
} from 'n8n-workflow';

// ─── Helpers ────────────────────────────────────────────────────────────────

function getText(html: string, re: RegExp, group = 1): string | null {
  const m = html.match(re);
  return m && m[group] ? m[group].trim() : null;
}

function parsePrice(html: string): number | null {
  const whole = getText(html, /class=["']a-price-whole["']>([\d,]+)</);
  const frac  = getText(html, /class=["']a-price-fraction["']>(\d+)</);
  if (!whole) return null;
  return parseFloat(whole.replace(/,/g, '') + '.' + (frac ?? '00'));
}

function parseProduct(html: string, asin: string): IDataObject {
  const current_price  = parsePrice(html);
  const orig_raw       = getText(html, /class=["']a-text-price["'][^>]*>[^<]*<span[^>]*>\$([\d,.]+)/);
  const original_price = orig_raw ? parseFloat(orig_raw.replace(/,/g, '')) : null;
  const sale_price     = original_price && current_price && current_price < original_price ? current_price : null;

  const title = getText(html, /id=["']productTitle["'][^>]*>\s*([^<]+)\s*</);
  const brand =
    getText(html, /id=["']bylineInfo["'][^>]*>[\s\S]{0,300}?<a[^>]*>([^<]+)</) ??
    getText(html, /class=["']po-brand["'][^>]*>[\s\S]{0,200}?<span[^>]*>([^<]+)</);

  const rating_str  = getText(html, /(\d\.\d) out of 5 stars/);
  const reviews_str = getText(html, /([\d,]+)[\s\xa0]+(?:global )?ratings/);
  const img         =
    getText(html, /id=["']landingImage["'][^>]*data-old-hires=["']([^"']+)["']/) ??
    getText(html, /id=["']landingImage["'][^>]*src=["']([^"']+)["']/);

  const avail_raw = getText(html, /id=["']availability["'][^>]*>[\s\S]{0,300}?<span[^>]*>\s*([^<]+)/);
  let availability = 'In Stock';
  if (avail_raw) {
    const al = avail_raw.toLowerCase();
    if (al.includes('out of stock') || al.includes('unavailable')) availability = 'Out of Stock';
    else if (al.includes('only') || al.includes('limited'))        availability = 'Limited Stock';
    else availability = avail_raw.replace(/\s+/g, ' ').trim();
  }

  let seller = 'Third Party';
  if (html.includes('Sold by Amazon') || html.includes('Ships from Amazon.com')) seller = 'Amazon';
  const seller_name = getText(html, /id=["']sellerProfileTriggerId["'][^>]*>([^<]+)</) ?? seller;

  return {
    asin,
    title:           title ? title.replace(/&amp;/g, '&').trim() : null,
    brand:           brand ? brand.replace(/&amp;/g, '&').trim() : null,
    current_price,
    original_price,
    sale_price,
    rating:          rating_str ? parseFloat(rating_str) : null,
    review_count:    reviews_str ? parseInt(reviews_str.replace(/,/g, ''), 10) : null,
    availability,
    seller:          seller_name,
    is_sold_by_amazon: seller === 'Amazon',
    image_url:       img ?? null,
    product_url:     `https://www.amazon.com/dp/${asin}`,
    scraped_at:      new Date().toISOString(),
  };
}

function normalisePriceIntelligence(
  product: IDataObject,
  myPrice: number,
  cost: number,
  marginFloor: number,
): IDataObject {
  const current_price = product.current_price as number | null;
  const min_viable    = parseFloat((cost * (1 + marginFloor / 100)).toFixed(2));

  if (current_price === null) {
    return { ...product, my_price: myPrice, cost, margin_floor: marginFloor, min_viable_price: min_viable };
  }

  const gap_abs             = parseFloat((myPrice - current_price).toFixed(2));
  const gap_pct             = parseFloat(((gap_abs / current_price) * 100).toFixed(2));
  const competitor_cheaper  = current_price < myPrice;
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
  if (competitor_cheaper && current_price !== null) {
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

// ─── Node definition ─────────────────────────────────────────────────────────

export class Syphoon implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Syphoon',
    name: 'syphoon',
    icon: 'file:icon.svg',
    group: ['transform'],
    version: 1,
    subtitle: '={{$parameter["operation"]}}',
    description: 'Amazon product scraping and competitive price intelligence via Syphoon API',
    defaults: {
      name: 'Syphoon',
    },
    inputs: ['main'],
    outputs: ['main'],
    credentials: [
      {
        name: 'syphoonApi',
        required: true,
      },
    ],
    properties: [

      // ── Operation selector ──────────────────────────────────────────────
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        options: [
          {
            name: 'Get Product',
            value: 'getProduct',
            description: 'Scrape a single Amazon product by ASIN and return structured data',
            action: 'Get a product by ASIN',
          },
          {
            name: 'Get Product with Price Intelligence',
            value: 'getProductIntelligence',
            description: 'Scrape a product and calculate competitive price metrics against your price',
            action: 'Get product with price intelligence',
          },
          {
            name: 'Batch Get Products',
            value: 'batchGetProducts',
            description: 'Scrape multiple ASINs in one operation (rate-limited automatically)',
            action: 'Batch get products',
          },
        ],
        default: 'getProduct',
      },

      // ── Shared: ASIN ────────────────────────────────────────────────────
      {
        displayName: 'ASIN',
        name: 'asin',
        type: 'string',
        default: '',
        required: true,
        displayOptions: {
          show: {
            operation: ['getProduct', 'getProductIntelligence'],
          },
        },
        description: 'Amazon Standard Identification Number (e.g. B09B8RVKGM). Also accepts a full amazon.com product URL.',
        placeholder: 'B09B8RVKGM',
      },

      // ── Batch: ASIN list ────────────────────────────────────────────────
      {
        displayName: 'ASINs',
        name: 'asins',
        type: 'string',
        default: '',
        required: true,
        displayOptions: {
          show: {
            operation: ['batchGetProducts'],
          },
        },
        description: 'Comma-separated list of ASINs to scrape (e.g. B09B8RVKGM,B0C1H26C46). Max 50 per batch.',
        placeholder: 'B09B8RVKGM,B0C1H26C46,B07YJ8C5SG',
      },

      // ── Price Intelligence fields ────────────────────────────────────────
      {
        displayName: 'Your Current Price ($)',
        name: 'myPrice',
        type: 'number',
        default: 0,
        required: true,
        displayOptions: {
          show: {
            operation: ['getProductIntelligence'],
          },
        },
        description: 'Your listed price for this product on Amazon',
      },
      {
        displayName: 'Your Cost ($)',
        name: 'cost',
        type: 'number',
        default: 0,
        required: true,
        displayOptions: {
          show: {
            operation: ['getProductIntelligence'],
          },
        },
        description: 'Your unit cost / COGS for this product',
      },
      {
        displayName: 'Minimum Margin (%)',
        name: 'marginFloor',
        type: 'number',
        default: 20,
        required: true,
        displayOptions: {
          show: {
            operation: ['getProductIntelligence'],
          },
        },
        description: 'Minimum acceptable profit margin. Used to calculate minimum viable price.',
      },

      // ── Advanced options ─────────────────────────────────────────────────
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
            description: 'Which Amazon marketplace to scrape from',
          },
          {
            displayName: 'Batch Delay (ms)',
            name: 'batchDelay',
            type: 'number',
            default: 10000,
            displayOptions: {
              show: {
                '/operation': ['batchGetProducts'],
              },
            },
            description: 'Milliseconds to wait between each request in a batch. Minimum 5000ms recommended to avoid rate limits.',
          },
          {
            displayName: 'Request Timeout (ms)',
            name: 'timeout',
            type: 'number',
            default: 30000,
            description: 'Maximum time in milliseconds to wait for a response from Syphoon',
          },
        ],
      },
    ],
  };

  // ── Execute ───────────────────────────────────────────────────────────────

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items     = this.getInputData();
    const returnData: INodeExecutionData[] = [];
    const credentials = await this.getCredentials('syphoonApi');
    const apiKey    = credentials.apiKey as string;

    for (let i = 0; i < items.length; i++) {
      const operation = this.getNodeParameter('operation', i) as string;
      const options   = this.getNodeParameter('options', i, {}) as IDataObject;
      const marketplace = (options.marketplace as string) ?? 'amazon.com';
      const timeout   = (options.timeout as number) ?? 30000;

      try {

        // ── getProduct ────────────────────────────────────────────────────
        if (operation === 'getProduct') {
          const rawAsin = this.getNodeParameter('asin', i) as string;
          const asin    = extractAsin(rawAsin);
          if (!asin) throw new NodeOperationError(this.getNode(), `Invalid ASIN or URL: ${rawAsin}`, { itemIndex: i });

          const html = await syphoonRequest(this, apiKey, asin, marketplace, timeout, i);
          const product = parseProduct(html, asin);
          returnData.push({ json: product, pairedItem: i });
        }

        // ── getProductIntelligence ────────────────────────────────────────
        else if (operation === 'getProductIntelligence') {
          const rawAsin    = this.getNodeParameter('asin', i) as string;
          const asin       = extractAsin(rawAsin);
          if (!asin) throw new NodeOperationError(this.getNode(), `Invalid ASIN or URL: ${rawAsin}`, { itemIndex: i });

          const myPrice    = this.getNodeParameter('myPrice', i) as number;
          const cost       = this.getNodeParameter('cost', i) as number;
          const marginFloor = this.getNodeParameter('marginFloor', i) as number;

          const html       = await syphoonRequest(this, apiKey, asin, marketplace, timeout, i);
          const product    = parseProduct(html, asin);
          const enriched   = normalisePriceIntelligence(product, myPrice, cost, marginFloor);
          returnData.push({ json: enriched, pairedItem: i });
        }

        // ── batchGetProducts ──────────────────────────────────────────────
        else if (operation === 'batchGetProducts') {
          const rawAsins  = this.getNodeParameter('asins', i) as string;
          const batchDelay = (options.batchDelay as number) ?? 10000;
          const asinList  = rawAsins
            .split(',')
            .map(a => extractAsin(a.trim()))
            .filter((a): a is string => Boolean(a))
            .slice(0, 50);

          if (asinList.length === 0) {
            throw new NodeOperationError(this.getNode(), 'No valid ASINs found in the list.', { itemIndex: i });
          }

          for (let idx = 0; idx < asinList.length; idx++) {
            const asin = asinList[idx];
            const html = await syphoonRequest(this, apiKey, asin, marketplace, timeout, i);
            const product = parseProduct(html, asin);
            returnData.push({ json: product, pairedItem: i });

            if (idx < asinList.length - 1) {
              await sleep(batchDelay);
            }
          }
        }

      } catch (error) {
        if (this.continueOnFail()) {
          returnData.push({
            json: { error: (error as Error).message },
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

// ─── Internal helpers ─────────────────────────────────────────────────────────

function extractAsin(input: string): string | null {
  // Already a bare ASIN (10 chars, alphanumeric starting with B or digit)
  if (/^[A-Z0-9]{10}$/i.test(input.trim())) return input.trim().toUpperCase();
  // Full Amazon URL — extract /dp/ASIN or /gp/product/ASIN
  const m = input.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
  return m ? m[1].toUpperCase() : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function syphoonRequest(
  ctx: IExecuteFunctions,
  apiKey: string,
  asin: string,
  marketplace: string,
  timeout: number,
  itemIndex: number,
): Promise<string> {
  const url = `https://www.${marketplace}/dp/${asin}`;

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

    if (httpErr.statusCode === 402) {
      throw new NodeOperationError(
        ctx.getNode(),
        'Syphoon trial exhausted or subscription inactive. Upgrade your plan at https://app.syphoon.com/billing',
        { itemIndex },
      );
    }
    if (httpErr.statusCode === 401 || httpErr.statusCode === 403) {
      throw new NodeOperationError(
        ctx.getNode(),
        'Invalid Syphoon API key. Check your credentials at https://app.syphoon.com/api-keys',
        { itemIndex },
      );
    }
    if (httpErr.statusCode === 429) {
      throw new NodeOperationError(
        ctx.getNode(),
        'Syphoon rate limit hit. Increase the Batch Delay option or reduce polling frequency.',
        { itemIndex },
      );
    }
    throw new NodeApiError(ctx.getNode(), err as object, { itemIndex });
  }

  // Syphoon returns { data: "<html>..." } or a raw string
  if (typeof response === 'string') return response;
  if (response.data && typeof response.data === 'string') return response.data;

  throw new NodeOperationError(
    ctx.getNode(),
    `Unexpected response format from Syphoon for ASIN ${asin}`,
    { itemIndex },
  );
}
