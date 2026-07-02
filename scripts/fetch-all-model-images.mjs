#!/usr/bin/env node
// Fetch ALL on-model images (front/back/left/right × both crops) for every
// colour of every product that has them, into public/products, and record them
// on each appearance as `modelImages: { viewId, crop, image }[]` in
// public/catalog.json. Existing `modelImage` / `modelImageFront` (the front
// detail shot) are left untouched for backward compatibility.
//
// Metadata comes from the internal model-image renderer (VPN); images come from
// the PUBLIC image server. No Spreadshirt URLs are written into catalog.json —
// only local /products/... paths — so the deployed catalog stays link-clean.
//
// Run: MODEL_IMAGES_URL=<renderer-base> node scripts/fetch-all-model-images.mjs

import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, "..")
const IMG_ROOT = join(ROOT, "public", "products")
const CATALOG_FILE = join(ROOT, "public", "catalog.json")

// Source width for on-model shots. 1200 keeps drawer tiles crisp on large /
// retina screens; override with IMG_WIDTH=… . Note: downloadImage() skips
// files that already exist, so bump the width AND clear public/products/**/
// model-*.webp first to actually re-fetch at the new size.
const IMG_WIDTH = Number(process.env.IMG_WIDTH) || 1200
const IMAGE_SERVER = "https://image.spreadshirtmedia.net/image-server/v1"
const BG = "F4F4F4"
const VIEWS = [1, 2, 3, 4]
const CROPS = ["detail", "list"]
const CONCURRENCY = 10

const MODEL_IMAGES_URL = process.env.MODEL_IMAGES_URL
if (!MODEL_IMAGES_URL) {
  console.error("Set MODEL_IMAGES_URL to the model-image renderer base (VPN required).")
  process.exit(1)
}

// Some products default to a two-person "unisex" shot; force a single-person
// shot by preferring a gender tag instead.
const MODEL_TAG_OVERRIDE = {
  "2116": "male", // polo
}

async function fetchJson(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${res.status} ${url}`)
  return res.json()
}

// All model-image metadata entries for a product type (paginated defensively).
async function fetchModelMeta(productTypeId) {
  const out = []
  for (let offset = 0; ; offset += 100) {
    let page
    try {
      page = await fetchJson(
        `${MODEL_IMAGES_URL}/singleproduct/modelimages?tags=cyo&productTypeId=${productTypeId}&limit=100&offset=${offset}`
      )
    } catch {
      break
    }
    const entries = Object.values(page.producttypes ?? {}).flat()
    out.push(...entries)
    if (entries.length < 100) break
  }
  return out
}

// Best styled/on-model entry for a given view + appearance. "Model images" here
// means any non-flatlay shot (model / studio / mood / transparent, depending on
// the product) — the flat product-only shots are excluded (those are the plain
// product `views` images already in the catalog).
function bestEntry(entries, viewId, appearanceId, productTypeId) {
  const cands = entries.filter(
    m =>
      m.viewId === viewId &&
      m.active !== false &&
      !(m.tags ?? []).includes("flatlay") &&
      (m.appearanceIds ?? []).map(String).includes(String(appearanceId))
  )
  if (cands.length === 0) return null
  cands.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
  const preferTag = MODEL_TAG_OVERRIDE[String(productTypeId)]
  return (preferTag && cands.find(m => (m.tags ?? []).includes(preferTag))) || cands[0]
}

async function downloadImage(url, path) {
  try {
    await stat(path)
    return true // already downloaded
  } catch {}
  await mkdir(dirname(path), { recursive: true })
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${res.status}`)
  await writeFile(path, Buffer.from(await res.arrayBuffer()))
  return true
}

async function runPool(tasks, worker) {
  let i = 0
  let ok = 0
  const runners = Array.from({ length: CONCURRENCY }, async () => {
    while (i < tasks.length) {
      const t = tasks[i++]
      if (await worker(t)) ok++
    }
  })
  await Promise.all(runners)
  return ok
}

async function main() {
  const catalog = JSON.parse(await readFile(CATALOG_FILE, "utf8"))

  // 1) Build the full download plan from metadata.
  const tasks = [] // { ptId, appId, viewId, crop, url, file, rel, target: appearance }
  for (const p of catalog.products) {
    const meta = await fetchModelMeta(p.id)
    if (meta.length === 0) {
      console.log(`  ${p.id} ${p.name}: no model metadata`)
      continue
    }
    let planned = 0
    for (const a of p.appearances) {
      a.modelImages = [] // rebuilt below
      for (const v of VIEWS) {
        const entry = bestEntry(meta, v, a.id, p.id)
        if (!entry) continue
        let crops = CROPS.filter(c => (entry.crops ?? []).includes(c))
        if (crops.length === 0) crops = ["detail"]
        for (const crop of crops) {
          const rel = `/products/${p.id}/${a.id}/model-${v}-${crop}.webp`
          tasks.push({
            appearance: a,
            viewId: v,
            crop,
            rel,
            url: `${IMAGE_SERVER}/productTypes/${p.id}/views/${v},modelId=${entry.modelId},crop=${crop},appearanceId=${a.id},backgroundColor=${BG}?width=${IMG_WIDTH}`,
            file: join(IMG_ROOT, String(p.id), String(a.id), `model-${v}-${crop}.webp`),
          })
          planned++
        }
      }
    }
    console.log(`  ${p.id} ${p.name}: planned ${planned} model images`)
  }

  // 2) Download with a concurrency pool; record successes on the appearance.
  console.log(`\nDownloading ${tasks.length} images (concurrency ${CONCURRENCY})…`)
  const ok = await runPool(tasks, async t => {
    try {
      await downloadImage(t.url, t.file)
      t.appearance.modelImages.push({ viewId: t.viewId, crop: t.crop, image: t.rel })
      return true
    } catch (e) {
      return false
    }
  })

  // 3) Sort each appearance's list (view, then crop) and drop empties.
  for (const p of catalog.products) {
    for (const a of p.appearances) {
      if (!a.modelImages || a.modelImages.length === 0) {
        delete a.modelImages
        continue
      }
      a.modelImages.sort((x, y) => x.viewId - y.viewId || x.crop.localeCompare(y.crop))
    }
  }

  await writeFile(CATALOG_FILE, JSON.stringify(catalog))
  const withModels = catalog.products.reduce(
    (n, p) => n + p.appearances.filter(a => a.modelImages?.length).length,
    0
  )
  console.log(`\nDownloaded ${ok}/${tasks.length} images. ${withModels} colours now carry modelImages. Wrote ${CATALOG_FILE}`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
