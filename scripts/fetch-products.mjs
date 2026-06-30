#!/usr/bin/env node
// Fetch product types + images from Spreadshirt once and store statically.
// Run: `node scripts/fetch-products.mjs`

import { mkdir, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, "..")
const IMG_ROOT = join(ROOT, "public", "products")
const DATA_FILE = join(ROOT, "lib", "products-data.ts")

const SHOP_ID = "205909"
const FEATURED_ID = "2940" // Unisex Premium Oversized Organic T-Shirt
const PER_CATEGORY = 3
const IMG_WIDTH = 600
// When non-empty, use exactly these product type IDs in this order instead of
// the auto-categorizer. Pinned so regenerating stays deterministic (the live
// catalog order drifts, which would otherwise swap the embedded products).
const PINNED_PRODUCT_IDS = [
  "2940", "812", "813", "814", "1047", "20", "1505", "3980", "3001", "4312",
  "56", "4133", "2973", "1040", "4562", "15", "4180", "4181", "4182", "31",
  "1313", "1470", "4506", "1459", "4505", "943", "916", "917", "1300", "1301",
  "1302", "2116",
]
// Always include these product type IDs in addition to the auto-categorized
// list (or to replace them if the categorizer doesn't pick them).
const ADDITIONAL_PRODUCT_IDS = []
// Skip these product IDs even if categorizer would pick them.
const EXCLUDE_PRODUCT_IDS = []
// Print type IDs that represent embroidery. Mirrors create-omat's
// EMBROIDERY_PRINT_TYPE_IDS (src/lib/Constants.ts) so a product counts as
// embroidery-suitable when any appearance offers one of these print types.
const EMBROIDERY_PRINT_TYPE_IDS = ["8", "33", "46"]
// Model-image metadata (which model shots exist per product type) is only
// available via create-omat's assortment API — there is no public endpoint.
// Best-effort: if create-omat isn't running, model images are simply omitted.
const MODEL_META_BASE = process.env.MODEL_META_BASE || "http://localhost:3000"
const MODEL_META_SHOP = process.env.MODEL_META_SHOP || "1133169"
const MODEL_IMAGE_SERVER = "https://image.spreadshirtmedia.net/image-server/v1"

// Fetches a product's assortment from create-omat (the real shop) — used for both
// the real base price and model-image metadata. Returns null when unavailable
// (create-omat not running, or product not in that shop).
async function fetchOmatAssortment(productTypeId) {
  try {
    const data = await fetchJson(
      `${MODEL_META_BASE}/api/assortment/${productTypeId}?mediaType=json&shopId=${MODEL_META_SHOP}&locale=en_GB`
    )
    return data && !data.error ? data : null
  } catch {
    return null
  }
}

// Builds the front-view (viewId 1) model-image URL from model metadata, preferring
// an on-model (non-flatlay) shot. Returns null when none exists.
function frontModelImageUrl(modelImages, productTypeId, appearanceId) {
  const front = (modelImages ?? []).filter(m => m.viewId === 1 && m.active !== false)
  if (front.length === 0) return null
  const sorted = front.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
  const chosen = sorted.find(m => !(m.tags ?? []).includes("flatlay")) ?? sorted[0]
  const ids = (chosen.appearanceIds ?? []).map(String)
  const appId = ids.includes(String(appearanceId)) ? appearanceId : (ids[0] ?? appearanceId)
  const crop = (chosen.crops ?? []).includes("detail") ? "detail" : (chosen.crops?.[0] ?? "detail")
  return `${MODEL_IMAGE_SERVER}/productTypes/${productTypeId}/views/1,modelId=${chosen.modelId},crop=${crop},appearanceId=${appId},backgroundColor=F4F4F4`
}

function categorize(name) {
  if (/hoodie|hooded/i.test(name)) return "Hoodies"
  if (/cap|hat|visor|beanie/i.test(name)) return "Caps & Hats"
  if (/t-shirt|tee\b/i.test(name)) return "T-Shirts"
  if (/sweat/i.test(name)) return "Sweatshirts"
  if (/mug|cup|bottle|flask/i.test(name)) return "Drinkware"
  if (/bag|backpack|tote/i.test(name)) return "Bags"
  if (/sticker/i.test(name)) return "Stickers"
  if (/poster|canvas/i.test(name)) return "Wall Art"
  if (/tank|top/i.test(name)) return "Tank Tops"
  if (/sock/i.test(name)) return "Socks"
  return null
}

async function fetchJson(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${res.status} ${url}`)
  return res.json()
}

async function downloadImage(url, path) {
  try {
    await stat(path)
    return // already downloaded
  } catch {}
  await mkdir(dirname(path), { recursive: true })
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${res.status} ${url}`)
  const buf = Buffer.from(await res.arrayBuffer())
  await writeFile(path, buf)
}

async function main() {
  console.log("Fetching product type list…")
  const list = await fetchJson(
    `https://api.spreadshirt.net/api/v1/shops/${SHOP_ID}/productTypes?mediaType=json&limit=1000`
  )

  const byId = id => list.productTypes.find(p => p.id === id)

  // Pinned selection takes precedence: deterministic, exact set in order.
  let orderedPinned = null
  if (PINNED_PRODUCT_IDS.length) {
    orderedPinned = PINNED_PRODUCT_IDS.map(byId).filter(Boolean)
    const missing = PINNED_PRODUCT_IDS.filter(id => !byId(id))
    if (missing.length) console.warn(`  ! pinned ids not in catalog: ${missing.join(", ")}`)
  }

  // Bucket up to PER_CATEGORY products per category, always include featured first.
  const buckets = {}
  for (const p of list.productTypes) {
    if (p.id === FEATURED_ID) continue
    if (EXCLUDE_PRODUCT_IDS.includes(p.id)) continue
    const c = categorize(p.name)
    if (!c) continue
    buckets[c] ??= []
    if (buckets[c].length >= PER_CATEGORY) continue
    buckets[c].push(p)
  }
  // Featured + categorized + any extras requested via ADDITIONAL_PRODUCT_IDS
  const idsSoFar = new Set([FEATURED_ID, ...Object.values(buckets).flat().map(p => p.id)])
  const extras = ADDITIONAL_PRODUCT_IDS.filter(id => !idsSoFar.has(id))
    .map(id => list.productTypes.find(p => p.id === id))
    .filter(Boolean)
  const ordered =
    orderedPinned ??
    [
      list.productTypes.find(p => p.id === FEATURED_ID),
      ...Object.values(buckets).flat(),
      ...extras,
    ].filter(Boolean)

  const products = []
  for (const stub of ordered) {
    const id = stub.id
    console.log(`  ${id} — ${stub.name}`)
    const detail = await fetchJson(
      `https://api.spreadshirt.net/api/v1/shops/${SHOP_ID}/productTypes/${id}?mediaType=json&fullData=true`
    )
    const defaultViewId = detail.views?.[0]?.id ?? "1"

    // Per-view metadata: image + the print-area boxes overlaid on that view.
    const viewMeta = {}
    for (const view of detail.views ?? []) {
      viewMeta[view.id] = {
        id: view.id,
        name: view.name ?? "",
        canvas: {
          width: view.size?.width ?? 0,
          height: view.size?.height ?? 0,
          unit: view.size?.unit ?? "mm",
        },
        dpi: view.dpi ?? 0,
        viewMaps: (view.viewMaps ?? []).map(vm => ({
          printAreaId: vm.printArea?.id ?? "",
          offset: {
            x: vm.offset?.x ?? 0,
            y: vm.offset?.y ?? 0,
            unit: vm.offset?.unit ?? "mm",
          },
          size: {
            width: vm.size?.width ?? 0,
            height: vm.size?.height ?? 0,
            unit: vm.size?.unit ?? "mm",
          },
          dpi: vm.dpi ?? 0,
        })),
      }
    }

    const appearances = []
    for (const a of detail.appearances ?? []) {
      const views = []
      for (const view of detail.views ?? []) {
        const imgUrl = `https://image.spreadshirtmedia.net/image-server/v1/productTypes/${id}/views/${view.id}/appearances/${a.id}?width=${IMG_WIDTH}`
        const file = join(IMG_ROOT, id, a.id, `${view.id}.webp`)
        try {
          await downloadImage(imgUrl, file)
          views.push({
            id: view.id,
            image: `/products/${id}/${a.id}/${view.id}.webp`,
          })
        } catch (e) {
          console.warn(`    skip ${a.id}/view ${view.id}: ${e.message}`)
        }
      }
      if (views.length === 0) continue
      const def = views.find(v => v.id === defaultViewId) ?? views[0]
      appearances.push({
        id: a.id,
        name: a.name ?? "",
        color: a.colors?.[0]?.value ?? "#cccccc",
        image: def.image,
        printTypes: (a.printTypes ?? []).map(pt => ({ id: pt.id, href: pt.href ?? "" })),
        views,
      })
    }

    const productViews = Object.values(viewMeta)

    const printAreas = (detail.printAreas ?? []).map(pa => ({
      id: pa.id,
      defaultViewId: pa.defaultView?.id ?? "",
      boundary: {
        width: pa.boundary?.size?.width ?? 0,
        height: pa.boundary?.size?.height ?? 0,
        unit: pa.boundary?.size?.unit ?? "mm",
      },
      restrictions: {
        textAllowed: !!pa.restrictions?.textAllowed,
        designAllowed: !!pa.restrictions?.designAllowed,
        backgroundAllowed: !!pa.restrictions?.backgroundAllowed,
      },
      printoutQuantity: pa.printoutQuantity ?? 1,
    }))

    // Prefer the black variant as the drawer thumbnail when one exists.
    const black =
      appearances.find(a => /\bblack\b/i.test(a.name)) ??
      appearances.find(a => /^#?0{6}$/i.test(a.color.replace("#", ""))) ??
      appearances[0]
    const embroidery = appearances.some(a =>
      a.printTypes.some(pt => EMBROIDERY_PRINT_TYPE_IDS.includes(pt.id))
    )

    // Real-shop assortment from create-omat — for the base price and model images.
    const omat = await fetchOmatAssortment(id)
    const omatPrice = omat?.price?.vatIncluded
    const price = typeof omatPrice === "number" ? omatPrice : (detail.price?.vatIncluded ?? 0)
    if (typeof omatPrice !== "number") {
      console.warn(`    no create-omat price for ${id}; keeping public price ${price}`)
    }

    // Front model image — only for embroidery products (shown in the print-technique
    // modal). Best-effort; null if unavailable.
    let modelImageFront = null
    if (embroidery && omat) {
      const modelUrl = frontModelImageUrl(omat.modelImages, id, black?.id ?? appearances[0]?.id)
      if (modelUrl) {
        const file = join(IMG_ROOT, id, "model-front.webp")
        try {
          await downloadImage(`${modelUrl}?width=${IMG_WIDTH}`, file)
          modelImageFront = `/products/${id}/model-front.webp`
        } catch (e) {
          console.warn(`    skip model image ${id}: ${e.message}`)
        }
      }
    }
    products.push({
      id,
      name: detail.name,
      price,
      preview: black?.image ?? "",
      embroidery,
      modelImageFront,
      appearances,
      views: productViews,
      sizes: (detail.sizes ?? []).map(s => s.name),
      printAreas,
      details: {
        shortDescription: detail.shortDescription ?? "",
        description: detail.description ?? "",
        brand: detail.brand ?? "",
        weight: detail.weight ?? 0,
        sizeFitHint: detail.sizeFitHint ?? "",
      },
    })
  }

  const code = `// Auto-generated by scripts/fetch-products.mjs. Do not edit by hand.

export type StaticViewMap = {
  printAreaId: string
  offset: { x: number; y: number; unit: string }
  size: { width: number; height: number; unit: string }
  dpi: number
}

export type StaticView = {
  id: string
  name: string
  canvas: { width: number; height: number; unit: string }
  dpi: number
  viewMaps: StaticViewMap[]
}

export type StaticAppearanceView = {
  id: string
  image: string
}

export type StaticPrintType = {
  id: string
  href: string
}

export type StaticAppearance = {
  id: string
  name: string
  color: string
  image: string
  printTypes: StaticPrintType[]
  views: StaticAppearanceView[]
}

export type StaticPrintArea = {
  id: string
  defaultViewId: string
  boundary: { width: number; height: number; unit: string }
  restrictions: { textAllowed: boolean; designAllowed: boolean; backgroundAllowed: boolean }
  printoutQuantity: number
}

export type StaticProductDetails = {
  shortDescription: string
  description: string
  brand: string
  weight: number
  sizeFitHint: string
}

export type StaticProduct = {
  id: string
  name: string
  price: number
  preview: string
  embroidery: boolean
  modelImageFront: string | null
  appearances: StaticAppearance[]
  views: StaticView[]
  sizes: string[]
  printAreas: StaticPrintArea[]
  details: StaticProductDetails
}

export const FEATURED_PRODUCT_ID = ${JSON.stringify(FEATURED_ID)}

export const PRODUCTS: StaticProduct[] = ${JSON.stringify(products, null, 2)}
`
  await mkdir(dirname(DATA_FILE), { recursive: true })
  await writeFile(DATA_FILE, code)
  console.log(`\nWrote ${DATA_FILE} (${products.length} products)`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
