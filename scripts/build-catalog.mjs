// Generate public/catalog.json from a source products-data.ts module.
// Source defaults to the b2b-embroidery prototype but can be overridden with
// PRODUCTS_DATA=/abs/path/to/products-data.ts. Run with Node >= 23.6 (strips TS
// types) or `node --experimental-strip-types`.
import { mkdir, writeFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"

const SRC =
    process.env.PRODUCTS_DATA ||
    "/Users/erka/Git/prototypes/b2b-embroidery/lib/products-data.ts"

const { PRODUCTS, FEATURED_PRODUCT_ID } = await import(pathToFileURL(SRC).href)

const catalog = {
    featuredProductId: FEATURED_PRODUCT_ID,
    products: PRODUCTS,
}

await mkdir(new URL("../public/", import.meta.url), { recursive: true })
await writeFile(
    new URL("../public/catalog.json", import.meta.url),
    JSON.stringify(catalog)
)
console.log(`wrote public/catalog.json — ${PRODUCTS.length} products`)
