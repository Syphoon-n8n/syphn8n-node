# n8n-nodes-syphoon

A community node for [n8n](https://n8n.io) that connects to the [Syphoon](https://syphoon.com) web scraping API. Pass any URL and get back structured, typed data - no CSS selectors, no XPath, no browser setup required.

---

## Operations

| Operation | Description |
|---|---|
| **Scrape URL** | Scrapes any URL and returns structured data. Automatically detects the page type and populates the relevant fields. |

### Output fields (always present)

| Field | Description |
|---|---|
| `url` | Canonical URL that was scraped |
| `source` | Hostname of the scraped page |
| `scraped_at` | ISO 8601 timestamp |
| `page_type` | Detected type: `product`, `article`, `recipe`, `job`, `event`, `video`, `real_estate`, `forum`, `documentation`, or `generic` |
| `title` | Page title |
| `description` | Meta description or lead paragraph |
| `body_text` | Main readable content, stripped of nav/footer noise |
| `author` | Byline or author name |
| `published_at` | Publication date (ISO 8601) |
| `images` | Array of image URLs found on the page |
| `links` | Array of `{ url, text }` outbound links |
| `schema_types` | Detected schema.org types (e.g. `["Product", "BreadcrumbList"]`) |
| `schema_raw` | Full parsed `ld+json` blocks |

### Type-specific fields

When `page_type` is detected as one of the following, additional structured fields are populated:

- **`product`** - `name`, `brand`, `sku`, `price`, `price_numeric`, `currency`, `availability`, `rating`, `review_count`, `category`
- **`recipe`** - `name`, `cuisine`, `cook_time`, `prep_time`, `total_time`, `yield`, `ingredients`, `instructions`
- **`job`** - `title`, `company`, `location`, `employment_type`, `salary`, `posted_at`, `description`
- **`event`** - `name`, `start_date`, `end_date`, `location`, `organizer`, `price`
- **`video`** - `title`, `duration`, `upload_date`, `channel`, `view_count`

---

## Installation

### In n8n (recommended)

1. Go to **Settings → Community Nodes**
2. Click **Install**
3. Enter `n8n-nodes-syphoon`
4. Click **Install**

### Via npm (self-hosted)

```bash
npm install n8n-nodes-syphoon
```

Then restart your n8n instance.

---

## Authentication

This node uses an API key credential.

1. Sign up at [syphoon.com](https://syphoon.com)
2. Go to **Dashboard → API Keys** and create a new key
3. In n8n, go to **Credentials → New → Syphoon API**
4. Paste your API key and save

---

## Usage example

### Scrape a product page

1. Add a **Syphoon** node to your workflow
2. Select your Syphoon API credential
3. Set **URL** to any product page, e.g. `https://www.amazon.com/dp/B09G9FPHY6`
4. Execute the node

**Example output:**

```json
{
  "url": "https://www.amazon.com/dp/B09G9FPHY6",
  "page_type": "product",
  "title": "Echo Dot (5th Gen)",
  "product": {
    "name": "Echo Dot (5th Gen)",
    "brand": "Amazon",
    "price": "$49.99",
    "price_numeric": 49.99,
    "currency": "USD",
    "availability": "InStock",
    "rating": 4.7,
    "review_count": 28453
  }
}
```

### Use in a workflow

Combine with other n8n nodes to build pipelines like:

- **Price monitoring** - Schedule → Syphoon → IF (price changed) → Slack/email alert
- **Content aggregation** - RSS Feed → Syphoon → Airtable (store full article body)
- **Job board scraper** - HTTP Request (list page) → Split In Batches → Syphoon → Google Sheets

---

## Resources

- [Syphoon documentation](https://docs.syphoon.com)
- [n8n community nodes docs](https://docs.n8n.io/integrations/community-nodes/)
- [n8n community forum](https://community.n8n.io/)

## License

[MIT](LICENSE)
