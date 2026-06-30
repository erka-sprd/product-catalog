#!/usr/bin/env node
// One-off: append a single product type (default: polo 2116) to the existing
// lib/products-data.ts WITHOUT regenerating the whole file. Preserves every
// existing product's data (prices + model images that came from create-omat).
// Mirrors the build logic in scripts/fetch-products.mjs.
// Run: `node scripts/add-polo.mjs [productTypeId]`

import { mkdir, stat, writeFile, readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, "..")
const IMG_ROOT = join(ROOT, "public", "products")
const DATA_FILE = join(ROOT, "lib", "products-data.ts")

const SHOP_ID = "205909"
const PRODUCT_ID = process.argv[2] || "2116" // Stanley/Stella Unisex Organic Polo Shirt PREPSTER
const IMG_WIDTH = 600
const EMBROIDERY_PRINT_TYPE_IDS = ["8", "33", "46"]
const MODEL_META_BASE = process.env.MODEL_META_BASE || "http://localhost:3000"
const MODEL_META_SHOP = process.env.MODEL_META_SHOP || "1133169"
const MODEL_IMAGE_SERVER = "https://image.spreadshirtmedia.net/image-server/v1"

async function fetchJson(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${res.status} ${url}`)
  return res.json()
}

async function downloadImage(url, path) {
  try {
    await stat(path)
    return
  } catch {}
  await mkdir(dirname(path), { recursive: true })
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${res.status} ${url}`)
  const buf = Buffer.from(await res.arrayBuffer())
  await writeFile(path, buf)
}

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

async function buildProduct(id) {
  const detail = await fetchJson(
    `https://api.spreadshirt.net/api/v1/shops/${SHOP_ID}/productTypes/${id}?mediaType=json&fullData=true`
  )
  console.log(`  ${id} — ${detail.name}`)
  const defaultViewId = detail.views?.[0]?.id ?? "1"

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
        offset: { x: vm.offset?.x ?? 0, y: vm.offset?.y ?? 0, unit: vm.offset?.unit ?? "mm" },
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
        views.push({ id: view.id, image: `/products/${id}/${a.id}/${view.id}.webp` })
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

  const black =
    appearances.find(a => /\bblack\b/i.test(a.name)) ??
    appearances.find(a => /^#?0{6}$/i.test(a.color.replace("#", ""))) ??
    appearances[0]
  const embroidery = appearances.some(a =>
    a.printTypes.some(pt => EMBROIDERY_PRINT_TYPE_IDS.includes(pt.id))
  )

  const omat = await fetchOmatAssortment(id)
  const omatPrice = omat?.price?.vatIncluded
  const price = typeof omatPrice === "number" ? omatPrice : (detail.price?.vatIncluded ?? 0)
  if (typeof omatPrice !== "number") {
    console.warn(`    no create-omat price for ${id}; keeping public price ${price}`)
  }

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

  return {
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
  }
}

async function main() {
  const code = await readFile(DATA_FILE, "utf8")
  if (code.includes(`"id": "${PRODUCT_ID}"`)) {
    console.log(`Product ${PRODUCT_ID} already present in ${DATA_FILE}; nothing to do.`)
    return
  }

  console.log(`Fetching product ${PRODUCT_ID} from Spreadshirt…`)
  const product = await buildProduct(PRODUCT_ID)

  // Indent the new object to match the 2-space array-item indentation.
  const obj = JSON.stringify(product, null, 2)
    .split("\n")
    .map(line => "  " + line)
    .join("\n")

  const close = code.lastIndexOf("\n]")
  if (close === -1) throw new Error("Could not find PRODUCTS array close in data file")
  const head = code.slice(0, close) // ends with the last product's "  }"
  const tail = code.slice(close) // "\n]\n"
  const next = `${head},\n${obj}${tail}`

  await writeFile(DATA_FILE, next)
  console.log(
    `\nAppended ${PRODUCT_ID} (${product.name}) — ${product.appearances.length} colours, ${product.sizes.length} sizes, embroidery=${product.embroidery}`
  )
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
