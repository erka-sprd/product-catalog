# product-catalog

Central product catalogue for the embroidery prototypes. Serves, statically and
with permissive CORS:

- `/catalog.json` — all product info/qualities (`{ featuredProductId, products[] }`)
- `/products/{productTypeId}/{appearanceId}/{viewId}.webp` — re-hosted product images

No Spreadshirt URLs or keys are exposed: images and data are pre-generated and
committed here; the public site only serves static files.

## Consuming it

Prototypes use the [`product-catalog-client`](../product-catalog-client) package
and point it at this site's base URL (e.g. `https://<deploy>.vercel.app`):

```ts
import { getCatalog, buildTiles, resolveImageUrl } from "product-catalog-client"
const { products } = await getCatalog(process.env.NEXT_PUBLIC_CATALOG_URL!)
```

Image fields in the data are root-relative (`/products/...`); resolve them with
`resolveImageUrl(baseUrl, path)`.

## Regenerate the data

```bash
npm run build:catalog          # from b2b-embroidery's products-data.ts (default)
PRODUCTS_DATA=/abs/products-data.ts npm run build:catalog   # custom source
```

To refresh from Spreadshirt, run the fetch scripts in `scripts/` (build-time
only — they hold the Spreadshirt endpoints/keys and must never run on the public
deploy).

## Deploy (Vercel)

Static site, no build step. In Vercel project settings:

- Framework preset: **Other**
- Build command: *(empty)*
- Output directory: **public**

CORS + cache headers are in `vercel.json`.
