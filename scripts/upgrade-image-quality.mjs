#!/usr/bin/env node
// Re-download every product appearance/view image at a higher resolution,
// overwriting in place (same paths) so lib/products-data.ts stays untouched.
// Model images are left as-is (shown only small). Run: node scripts/upgrade-image-quality.mjs

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, "..")
const IMG_WIDTH = 1200
const CONCURRENCY = 8
const SERVER = "https://image.spreadshirtmedia.net/image-server/v1"

async function loadProducts() {
  let src = await readFile(join(ROOT, "lib", "products-data.ts"), "utf8")
  src = src
    .replace(/export type[\s\S]*?\n}\n/g, "")
    .replace("export const PRODUCTS: StaticProduct[] =", "export const PRODUCTS =")
  const mod = await import("data:text/javascript," + encodeURIComponent(src))
  return mod.PRODUCTS
}

async function download(url, path) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, buf)
}

async function main() {
  const products = await loadProducts()
  const jobs = []
  for (const p of products) {
    for (const a of p.appearances) {
      for (const v of a.views) {
        const url = `${SERVER}/productTypes/${p.id}/views/${v.id}/appearances/${a.id}?width=${IMG_WIDTH}`
        const path = join(ROOT, "public", v.image.replace(/^\//, ""))
        jobs.push({ url, path, label: `${p.id}/${a.id}/${v.id}` })
      }
    }
  }
  console.log(`Re-fetching ${jobs.length} images at ${IMG_WIDTH}px…`)
  let done = 0
  let failed = 0
  let i = 0
  async function worker() {
    while (i < jobs.length) {
      const job = jobs[i++]
      try {
        await download(job.url, job.path)
      } catch (e) {
        failed++
        console.warn(`  skip ${job.label}: ${e.message}`)
      }
      if (++done % 100 === 0) console.log(`  ${done}/${jobs.length}`)
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  console.log(`Done — ${done - failed}/${jobs.length} upgraded (${failed} failed)`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
