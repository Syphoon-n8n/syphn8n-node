# n8n-nodes-syphoon

Official n8n community node for [Syphoon](https://syphoon.com) — Amazon product scraping and competitive price intelligence.

## What is Syphoon?

Syphoon is an Amazon scraping API that returns real-time product data — prices, availability, ratings, seller info — without managing proxies, CAPTCHAs, or browser automation yourself.

## Operations

### Get Product
Scrape a single Amazon product by ASIN and return structured data:
- `current_price`, `original_price`, `sale_price`
- `title`, `brand`, `image_url`, `product_url`
- `rating`, `review_count`
- `availability`, `seller`, `is_sold_by_amazon`
- `scraped_at`

### Get Product with Price Intelligence
Everything in Get Product, plus competitive pricing metrics calculated against your listed price:
- `gap_abs` / `gap_pct` — absolute and percentage gap vs competitor
- `competitor_cheaper` — boolean flag
- `urgency` — `low` | `medium` | `high` | `critical`
- `recommendation` — `hold` | `undercut` | `match` | `raise`
- `opportunity_score` — 0–100 priority score
- `margin_at_competitor` — your margin if you matched their price
- `min_viable_price` — floor price based on your cost + margin floor

### Batch Get Products
Scrape up to 50 ASINs in a single node execution, with automatic rate limiting between requests.

## Supported Marketplaces

US, UK, DE, FR, IN, CA, JP, AU

## Credentials

You need a Syphoon API key. Get one at [app.syphoon.com/api-keys](https://app.syphoon.com/api-keys).

New accounts include a **free trial with 5,000 requests**. Paid plans start at $29/month.

## Installation

### n8n Cloud / n8n >= 1.94.0
Search for **Syphoon** in the nodes panel. Verified nodes can be installed with one click.

### Self-hosted
```bash
# In your n8n instance settings → Community Nodes → Install
n8n-nodes-syphoon
```

Or via npm:
```bash
npm install n8n-nodes-syphoon
```

## Example Use Cases

- Monitor competitor prices every 5 minutes and alert on Discord/Slack when they drop
- Auto-discover competitor ASINs by keyword, then track their prices daily
- Build a Buy Box strategy by tracking when Amazon is the seller vs third parties
- Feed price data into your own dashboard or database for trend analysis

## Workflow Template

A ready-to-import n8n workflow template using this node is available at:
[n8n.io/workflows — PriceIQ Amazon Price Intelligence](https://n8n.io/workflows)

## Changelog

### 1.0.0
- Initial release
- Operations: Get Product, Get Product with Price Intelligence, Batch Get Products
- Supports 8 Amazon marketplaces
- Built-in 402/401/429 error handling with actionable messages

## License

MIT © [Syphoon](https://syphoon.com)
