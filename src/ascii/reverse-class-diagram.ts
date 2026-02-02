// ============================================================================
// ASCII/Unicode ClassDiagram 反向解析（字符画 → Mermaid）
//
// 目标（用户需求）：
// - 把 `renderMermaidAscii()` 的 classDiagram 输出反向解析回 Mermaid 文本；
// - 作为“读图不歧义”的验收：字符画能自证（能反解回逻辑一致的 Mermaid，id 允许不同）。
//
// 重要取舍：
// - 只支持本项目当前的 class-diagram ASCII/Unicode 输出风格；
// - 只覆盖 unicode testdata 里用到的能力：
//   - class box（多分区：header/attrs/methods）
//   - 关系类型：inheritance / realization / composition / aggregation / association / dependency
//   - 关系 label（要求不裁剪，否则信息丢失无法反解）
// - 不尝试恢复“方法参数列表”（当前 parser 也不会保留参数，只保留 name/type）。
// ============================================================================

import { stripWidePlaceholders, toUnicodeGrid, WIDE_PLACEHOLDER } from './reverse-grid.ts'

interface BoxRect {
  x1: number
  y1: number
  x2: number
  y2: number
}

interface ClassMemberLite {
  visibility: '+' | '-' | '#' | '~' | ''
  name: string
  type?: string
}

interface ParsedClassBox extends BoxRect {
  label: string
  annotation?: string
  attributes: ClassMemberLite[]
  methods: ClassMemberLite[]
}

type RelationshipType =
  | 'inheritance'
  | 'realization'
  | 'composition'
  | 'aggregation'
  | 'association'
  | 'dependency'

interface ParsedRelationship {
  type: RelationshipType
  fromLabel: string
  toLabel: string
  label?: string
  /** 用于排序（输出稳定） */
  markerY: number
  markerX: number
}

function key(x: number, y: number): string {
  return `${x},${y}`
}

function inBounds(x: number, y: number, width: number, height: number): boolean {
  return x >= 0 && y >= 0 && x < width && y < height
}

function isSpace(ch: string): boolean {
  return ch === ' ' || ch === WIDE_PLACEHOLDER
}

function isLineChar(ch: string): boolean {
  return (
    ch === '─' || ch === '│' || ch === '╌' || ch === '┊' ||
    ch === '┌' || ch === '┐' || ch === '└' || ch === '┘' ||
    ch === '├' || ch === '┤'
  )
}

function findBoxesUnicode(grid: string[][], width: number, height: number): BoxRect[] {
  const boxes: BoxRect[] = []
  const usedTopLeft = new Set<string>()

  for (let y = 0; y < height; y++) {
    const row = grid[y] ?? []
    for (let x = 0; x < width; x++) {
      if (row[x] !== '┌') continue
      const k = key(x, y)
      if (usedTopLeft.has(k)) continue

      // 找 top-right：┌───...──┐
      let x2 = -1
      for (let cx = x + 1; cx < width; cx++) {
        const c = row[cx] ?? ' '
        if (c === '┐') {
          x2 = cx
          break
        }
        if (c !== '─') break
      }
      if (x2 < 0) continue

      // 找 bottom：└───...──┘
      let y2 = -1
      for (let cy = y + 1; cy < height; cy++) {
        const left = grid[cy]?.[x] ?? ' '
        const right = grid[cy]?.[x2] ?? ' '
        if (left === '└' && right === '┘') {
          y2 = cy
          break
        }
      }
      if (y2 < 0) continue

      boxes.push({ x1: x, y1: y, x2, y2 })
      usedTopLeft.add(k)
    }
  }

  return boxes
}

function extractBoxTextLines(grid: string[][], box: BoxRect): string[][] {
  // 分区分割线：├────┤
  const separators: number[] = []
  for (let y = box.y1 + 1; y < box.y2; y++) {
    const left = grid[y]?.[box.x1] ?? ' '
    const right = grid[y]?.[box.x2] ?? ' '
    if (left === '├' && right === '┤') separators.push(y)
  }

  const sections: string[][] = []
  let startY = box.y1 + 1
  for (const sepY of separators) {
    const lines: string[] = []
    for (let y = startY; y < sepY; y++) {
      const raw = (grid[y] ?? []).slice(box.x1 + 1, box.x2).join('')
      const line = stripWidePlaceholders(raw).trim()
      lines.push(line)
    }
    sections.push(lines)
    startY = sepY + 1
  }

  // 最后一段（到 bottom border 前一行）
  {
    const lines: string[] = []
    for (let y = startY; y < box.y2; y++) {
      const raw = (grid[y] ?? []).slice(box.x1 + 1, box.x2).join('')
      const line = stripWidePlaceholders(raw).trim()
      lines.push(line)
    }
    sections.push(lines)
  }

  return sections
}

function parseMemberLine(line: string): ClassMemberLite | null {
  const trimmed = line.trim()
  if (!trimmed) return null

  let visibility: ClassMemberLite['visibility'] = ''
  let rest = trimmed
  if (/^[+\-#~]/.test(rest)) {
    visibility = rest[0] as ClassMemberLite['visibility']
    rest = rest.slice(1).trim()
  }

  // renderer 的输出形态是：name: Type（type 可缺省）
  const colonIdx = rest.indexOf(':')
  if (colonIdx >= 0) {
    const name = rest.slice(0, colonIdx).trim()
    const type = rest.slice(colonIdx + 1).trim()
    if (!name) return null
    return { visibility, name, type: type || undefined }
  }

  // 没有冒号：只有 name
  return { visibility, name: rest }
}

function parseClassBox(grid: string[][], box: BoxRect): ParsedClassBox | null {
  const sections = extractBoxTextLines(grid, box)
  if (sections.length === 0) return null

  const headerLines = (sections[0] ?? []).map(s => s.trim()).filter(Boolean)
  if (headerLines.length === 0) return null

  let annotation: string | undefined
  let label = headerLines[headerLines.length - 1]!
  for (const l of headerLines) {
    const m = l.match(/^<<(.+?)>>$/)
    if (m) annotation = m[1]!
  }

  // attrs / methods：根据 section 顺序来判定（与 class-diagram.ts buildClassSections 一致）
  const attributes: ClassMemberLite[] = []
  const methods: ClassMemberLite[] = []

  if (sections.length >= 2) {
    for (const l of sections[1] ?? []) {
      const m = parseMemberLine(l)
      if (m) attributes.push(m)
    }
  }
  if (sections.length >= 3) {
    for (const l of sections[2] ?? []) {
      const m = parseMemberLine(l)
      if (m) methods.push(m)
    }
  }

  return {
    ...box,
    label,
    annotation,
    attributes,
    methods,
  }
}

const MARKERS = new Set(['△', '▽', '◆', '◇', '▲', '▼', '◀', '▶', '◁', '▷'])

function detectTypeByMarker(marker: string, dashed: boolean): RelationshipType | null {
  if (marker === '◆') return 'composition'
  if (marker === '◇') return 'aggregation'

  // triangle：inheritance / realization
  if (marker === '△' || marker === '▽' || marker === '◁' || marker === '▷') {
    return dashed ? 'realization' : 'inheritance'
  }

  // arrow：association / dependency
  if (marker === '▲' || marker === '▼' || marker === '◀' || marker === '▶') {
    return dashed ? 'dependency' : 'association'
  }

  return null
}

function buildBlockedSet(boxes: BoxRect[]): Set<string> {
  const blocked = new Set<string>()
  for (const b of boxes) {
    for (let y = b.y1; y <= b.y2; y++) {
      for (let x = b.x1; x <= b.x2; x++) {
        blocked.add(key(x, y))
      }
    }
  }
  return blocked
}

function buildAdjacencyMap(boxes: BoxRect[], width: number, height: number): Map<string, number> {
  const map = new Map<string, number>()

  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i]!

    // 上/下
    const topY = b.y1 - 1
    const botY = b.y2 + 1
    if (topY >= 0) {
      for (let x = b.x1; x <= b.x2; x++) map.set(key(x, topY), i)
    }
    if (botY < height) {
      for (let x = b.x1; x <= b.x2; x++) map.set(key(x, botY), i)
    }

    // 左/右
    const leftX = b.x1 - 1
    const rightX = b.x2 + 1
    if (leftX >= 0) {
      for (let y = b.y1; y <= b.y2; y++) map.set(key(leftX, y), i)
    }
    if (rightX < width) {
      for (let y = b.y1; y <= b.y2; y++) map.set(key(rightX, y), i)
    }
  }

  return map
}

function bfsFindOtherBox(
  grid: string[][],
  width: number,
  height: number,
  blocked: Set<string>,
  adjacentBox: Map<string, number>,
  startX: number,
  startY: number,
  attachedBoxIndex: number,
): { otherBoxIndex: number; dashed: boolean } | null {
  const q: Array<[number, number]> = [[startX, startY]]
  const seen = new Set<string>([key(startX, startY)])
  let dashed = false

  while (q.length > 0) {
    const [x, y] = q.shift()!
    const ch = grid[y]?.[x] ?? ' '
    if (ch === '┊' || ch === '╌' || ch === ':' || ch === '.') dashed = true

    const adj = adjacentBox.get(key(x, y))
    if (adj != null && adj !== attachedBoxIndex) {
      return { otherBoxIndex: adj, dashed }
    }

    const nexts: Array<[number, number]> = [
      [x + 1, y],
      [x - 1, y],
      [x, y + 1],
      [x, y - 1],
    ]
    for (const [nx, ny] of nexts) {
      if (!inBounds(nx, ny, width, height)) continue
      const k = key(nx, ny)
      if (seen.has(k)) continue
      if (blocked.has(k)) continue

      const c = grid[ny]?.[nx] ?? ' '
      if (isSpace(c)) continue

      seen.add(k)
      q.push([nx, ny])
    }
  }

  return null
}

function centerX(box: BoxRect): number {
  return box.x1 + Math.floor((box.x2 - box.x1) / 2)
}

function extractRelationshipLabel(
  grid: string[][],
  boxA: BoxRect,
  boxB: BoxRect,
): string | undefined {
  // class-diagram.ts 的 label 画在路径中点：
  // - 纵向连接：取上下 box 之间的中线行
  const upper = boxA.y1 <= boxB.y1 ? boxA : boxB
  const lower = upper === boxA ? boxB : boxA

  const fromBY = upper.y2
  const toTY = lower.y1
  const midY = Math.floor((fromBY + toTY) / 2)

  const midX = Math.floor((centerX(boxA) + centerX(boxB)) / 2)
  const row = grid[midY] ?? []

  // 取 midX 附近“最接近 midX 的文本 run”
  type Run = { start: number; end: number; text: string; center: number }
  const runs: Run[] = []

  let x = 0
  while (x < row.length) {
    while (x < row.length && (isSpace(row[x] ?? ' ') || isLineChar(row[x] ?? ' '))) x++
    if (x >= row.length) break

    const start = x
    while (x < row.length && !isSpace(row[x] ?? ' ') && !isLineChar(row[x] ?? ' ')) x++
    const end = x - 1

    const raw = row.slice(start, end + 1).join('')
    const text = stripWidePlaceholders(raw).trim()
    const center = Math.floor((start + end) / 2)

    // 过滤掉明显不是 label 的 run（比如单个符号）
    if (text && /[A-Za-z0-9_]/.test(text)) {
      runs.push({ start, end, text, center })
    }
  }

  if (runs.length === 0) return undefined

  runs.sort((a, b) => Math.abs(a.center - midX) - Math.abs(b.center - midX))
  return runs[0]!.text
}

function parseRelationships(
  grid: string[][],
  width: number,
  height: number,
  classBoxes: ParsedClassBox[],
): ParsedRelationship[] {
  const boxes: BoxRect[] = classBoxes.map(b => ({ x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2 }))
  const blocked = buildBlockedSet(boxes)
  const adjacentBox = buildAdjacencyMap(boxes, width, height)

  const rels: ParsedRelationship[] = []
  const seen = new Set<string>()

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ch = grid[y]?.[x] ?? ' '
      if (!MARKERS.has(ch)) continue

      // marker 必须在 box 外部
      if (blocked.has(key(x, y))) continue

      const attached = adjacentBox.get(key(x, y))
      if (attached == null) continue

      const bfs = bfsFindOtherBox(grid, width, height, blocked, adjacentBox, x, y, attached)
      if (!bfs) continue

      const type = detectTypeByMarker(ch, bfs.dashed)
      if (!type) continue

      const attachedBox = classBoxes[attached]!
      const otherBox = classBoxes[bfs.otherBoxIndex]!

      // 关系方向/语义归一：
      // - arrow（association/dependency）：marker 所在 box 是 to
      // - diamond/triangle：marker 所在 box 是“语义端”（whole/parent），我们用前缀语法输出：FROM <marker>-- TO
      let from: ParsedClassBox
      let to: ParsedClassBox
      if (type === 'association' || type === 'dependency') {
        to = attachedBox
        from = otherBox
      } else {
        from = attachedBox
        to = otherBox
      }

      const label = extractRelationshipLabel(grid, attachedBox, otherBox)
      const dedupeKey = `${type}|${from.label}->${to.label}|${label ?? ''}|${x},${y}`
      if (seen.has(dedupeKey)) continue
      seen.add(dedupeKey)

      rels.push({
        type,
        fromLabel: from.label,
        toLabel: to.label,
        label,
        markerX: x,
        markerY: y,
      })
    }
  }

  // 输出稳定：按 marker 的 y/x 排序
  rels.sort((a, b) => (a.markerY - b.markerY) || (a.markerX - b.markerX))
  return rels
}

function memberToMermaidAttribute(m: ClassMemberLite): string {
  // class/parser.ts 的 attribute 解析是 “Type name” 风格。
  // renderer 输出是 “name: Type”，因此这里要反向还原。
  const vis = m.visibility ?? ''
  if (m.type) return `${vis}${m.type} ${m.name}`.trim()
  return `${vis}${m.name}`.trim()
}

function memberToMermaidMethod(m: ClassMemberLite): string {
  // class/parser.ts 用 “()” 来区分 method，所以必须补上空括号。
  const vis = m.visibility ?? ''
  const t = m.type ? ` ${m.type}` : ''
  return `${vis}${m.name}()${t}`.trim()
}

export function reverseClassAsciiToMermaid(ascii: string): string {
  const { grid, width, height } = toUnicodeGrid(ascii)

  // 1) 找到所有 class box
  const rects = findBoxesUnicode(grid, width, height)
  const classBoxes: ParsedClassBox[] = []
  for (const r of rects) {
    const parsed = parseClassBox(grid, r)
    if (parsed) classBoxes.push(parsed)
  }

  // 2) 解析关系（需要 box 的空间信息）
  const relationships = parseRelationships(grid, width, height, classBoxes)

  // 3) Mermaid 输出（尽量稳定：按 box 左上角排序）
  classBoxes.sort((a, b) => (a.y1 - b.y1) || (a.x1 - b.x1))

  const lines: string[] = []
  lines.push('classDiagram')

  for (const cls of classBoxes) {
    const hasBody = Boolean(cls.annotation) || cls.attributes.length > 0 || cls.methods.length > 0
    if (!hasBody) {
      lines.push(`  class ${cls.label}`)
      continue
    }

    lines.push(`  class ${cls.label} {`)

    if (cls.annotation) {
      lines.push(`    <<${cls.annotation}>>`)
    }

    for (const a of cls.attributes) {
      lines.push(`    ${memberToMermaidAttribute(a)}`)
    }

    for (const m of cls.methods) {
      lines.push(`    ${memberToMermaidMethod(m)}`)
    }

    lines.push('  }')
  }

  // 关系：用 parser 能识别的 canonical 语法输出
  for (const r of relationships) {
    const label = r.label?.trim()
    const labelSuffix = label ? ` : ${label}` : ''

    switch (r.type) {
      case 'inheritance':
        lines.push(`  ${r.fromLabel} <|-- ${r.toLabel}${labelSuffix}`)
        break
      case 'realization':
        lines.push(`  ${r.fromLabel} <|.. ${r.toLabel}${labelSuffix}`)
        break
      case 'composition':
        lines.push(`  ${r.fromLabel} *-- ${r.toLabel}${labelSuffix}`)
        break
      case 'aggregation':
        lines.push(`  ${r.fromLabel} o-- ${r.toLabel}${labelSuffix}`)
        break
      case 'association':
        lines.push(`  ${r.fromLabel} --> ${r.toLabel}${labelSuffix}`)
        break
      case 'dependency':
        lines.push(`  ${r.fromLabel} ..> ${r.toLabel}${labelSuffix}`)
        break
    }
  }

  return lines.join('\n') + '\n'
}

