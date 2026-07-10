// One-off migration: recompute each product's print-area selection in
// public/catalog.json from the Spreadshirt API, keeping only NON-DEPRECATED
// print areas (matches create-omat's Imgly.getAreas). Fixes products whose
// viewMaps[0] pointed at a legacy oversized area (e.g. 812 front was 308x570
// instead of 390x490; hoodie 20 front was 343x594 instead of 390x280).
// Images / prices / model images are left untouched.
//
// Run: node scripts/fix-print-areas.mjs
import { readFile, writeFile } from "node:fs/promises"

const SHOP_ID = "205909"
const CATALOG = new URL("../public/catalog.json", import.meta.url)

const fetchDetail = async id => {
  const res = await fetch(
    `https://api.spreadshirt.net/api/v1/shops/${SHOP_ID}/productTypes/${id}?mediaType=json&fullData=true`
  )
  if (!res.ok) throw new Error(`${res.status}`)
  return res.json()
}

const catalog = JSON.parse(await readFile(CATALOG, "utf8"))
let updated = 0
const fixes = []

for (const p of catalog.products) {
  let detail
  try {
    detail = await fetchDetail(p.id)
  } catch (e) {
    console.warn(`  ${p.id} ${p.name}: skipped (${e.message})`)
    continue
  }

  const activeIds = new Set(
    (detail.printAreas ?? []).filter(pa => !pa.deprecated).map(pa => pa.id)
  )
  const apiViews = new Map((detail.views ?? []).map(v => [String(v.id), v]))
  const before = p.views?.[0]?.viewMaps?.[0]?.printAreaId

  // Rebuild each view's viewMaps from the API, keeping only non-deprecated areas.
  for (const view of p.views ?? []) {
    const apiView = apiViews.get(String(view.id))
    if (!apiView) continue
    view.viewMaps = (apiView.viewMaps ?? [])
      .filter(vm => activeIds.has(vm.printArea?.id))
      .map(vm => ({
        printAreaId: vm.printArea?.id ?? "",
        offset: { x: vm.offset?.x ?? 0, y: vm.offset?.y ?? 0, unit: vm.offset?.unit ?? "mm" },
        size: {
          width: vm.size?.width ?? 0,
          height: vm.size?.height ?? 0,
          unit: vm.size?.unit ?? "mm",
        },
        dpi: vm.dpi ?? 0,
      }))
  }

  // Keep only non-deprecated print areas.
  p.printAreas = (detail.printAreas ?? [])
    .filter(pa => !pa.deprecated)
    .map(pa => ({
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

  const after = p.views?.[0]?.viewMaps?.[0]?.printAreaId
  updated++
  if (before !== after) fixes.push(`  ${p.id} ${p.name}: front printArea ${before} -> ${after}`)
}

await writeFile(CATALOG, JSON.stringify(catalog))
console.log(`Updated ${updated}/${catalog.products.length} products.`)
console.log(`Front print-area changed for ${fixes.length}:`)
fixes.forEach(f => console.log(f))
