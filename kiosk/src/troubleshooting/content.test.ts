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
type Topic = { id: string; title: string; blurb: string; doc: string }
const TOPICS: Topic[] = JSON.parse(fs.readFileSync(path.join(CANON, 'topics.json'), 'utf8'))
const readDoc = (file: string): Node => JSON.parse(fs.readFileSync(path.join(CANON, file), 'utf8'))
const imagesOf = (doc: Node) =>
  walk(doc).filter((n) => n.type === 'wikiImage').map((n) => String(n.attrs?.assetId))

describe('troubleshooting content', () => {
  it('ships identical copies to Android and iOS', () => {
    const files = shared(CANON)
    // at least topics.json, one doc and its images
    expect(files).toContain('topics.json')
    for (const t of TOPICS) expect(files).toContain(t.doc)
    for (const dir of COPIES) {
      expect(shared(dir)).toEqual(files)
      for (const f of files) {
        expect(fs.readFileSync(path.join(dir, f)).equals(fs.readFileSync(path.join(CANON, f)))).toBe(true)
      }
    }
  })

  it('every topic uses only supported nodes', () => {
    for (const t of TOPICS) {
      for (const n of walk(readDoc(t.doc))) {
        expect(SUPPORTED.has(n.type), `${t.doc}: ${n.type}`).toBe(true)
        for (const m of n.marks ?? []) expect(m.type).toBe('bold')
        if (n.type === 'heading') expect([2, 3]).toContain(n.attrs?.level)
      }
    }
  })

  it('bundles every image the topics name, and nothing else', () => {
    const files = fs.readdirSync(CANON)
    const named = TOPICS.flatMap((t) => imagesOf(readDoc(t.doc)))
    for (const id of named) {
      // only plain .png names are mirrored by sync.sh, so anything else would ship on the web alone
      expect(id).toMatch(/^[a-z0-9][a-z0-9-]*\.png$/)
      expect(files).toContain(id)
    }
    for (const png of files.filter((f) => f.endsWith('.png'))) expect(named).toContain(png)
  })

  it('lists the scanner topic', () => {
    expect(TOPICS).toContainEqual({
      id: 'zebra-ds22',
      title: 'Zebra Scanner Troubleshooting',
      blurb: 'Set up, pair, and reset Zebra DS22 scanners, with programming barcodes.',
      doc: 'zebra-ds22.json',
    })
    expect(new Set(TOPICS.map((t) => t.id)).size).toBe(TOPICS.length)
    for (const t of TOPICS) expect(fs.existsSync(path.join(CANON, t.doc))).toBe(true)
  })
})
