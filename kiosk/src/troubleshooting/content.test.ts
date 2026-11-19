import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// kiosk/src/troubleshooting -> repo root
const ROOT = path.resolve(__dirname, '../../..')
const CANON = path.join(ROOT, 'kiosk/src/troubleshooting')
const COPIES = [
  path.join(ROOT, 'Android_Kiosk_App/app/src/main/assets/troubleshooting'),
  path.join(ROOT, 'IOS_Kiosk_App/ServerSherpa Kiosk/ServerSherpa Kiosk/Resources/Troubleshooting'),
]
// Only the shared content is mirrored; web source files in the folder are not.
const shared = (dir: string) =>
  fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.(json|png)$/.test(f)).sort() : []

const SUPPORTED = new Set([
  'doc', 'paragraph', 'heading', 'bulletList', 'orderedList', 'listItem', 'table',
  'tableRow', 'tableHeader', 'tableCell', 'callout', 'wikiImage', 'text',
])

type Node = { type: string; attrs?: Record<string, unknown>; marks?: { type: string }[]; content?: Node[] }
const walk = (n: Node, out: Node[] = []): Node[] => {
  out.push(n)
  ;(n.content ?? []).forEach((c) => walk(c, out))
  return out
}
const readDoc = (): Node => JSON.parse(fs.readFileSync(path.join(CANON, 'zebra-ds22.json'), 'utf8'))

describe('troubleshooting content', () => {
  it('ships identical copies to Android and iOS', () => {
    const files = shared(CANON)
    expect(files.length).toBe(7)
    for (const dir of COPIES) {
      expect(shared(dir)).toEqual(files)
      for (const f of files) {
        expect(fs.readFileSync(path.join(dir, f)).equals(fs.readFileSync(path.join(CANON, f)))).toBe(true)
      }
    }
  })

  it('uses only supported nodes', () => {
    for (const n of walk(readDoc())) {
      expect(SUPPORTED.has(n.type)).toBe(true)
      for (const m of n.marks ?? []) expect(m.type).toBe('bold')
      if (n.type === 'heading') expect([2, 3]).toContain(n.attrs?.level)
    }
  })

  it('bundles every image the doc names', () => {
    const named = walk(readDoc()).filter((n) => n.type === 'wikiImage').map((n) => String(n.attrs?.assetId))
    const files = fs.readdirSync(CANON)
    for (const id of named) expect(files).toContain(id)
    const pngs = files.filter((f) => f.endsWith('.png'))
    for (const png of pngs) expect(named).toContain(png)
  })

  it('lists the scanner topic', () => {
    const topics = JSON.parse(fs.readFileSync(path.join(CANON, 'topics.json'), 'utf8'))
    expect(topics).toEqual([
      {
        id: 'zebra-ds22',
        title: 'Zebra Scanner Troubleshooting',
        blurb: 'Set up, pair, and reset Zebra DS22 scanners, with programming barcodes.',
        doc: 'zebra-ds22.json',
      },
    ])
    for (const t of topics) expect(fs.existsSync(path.join(CANON, t.doc))).toBe(true)
  })
})
