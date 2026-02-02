// ============================================================================
// ASCII/Unicode ERDiagram 反向解析（字符画 → Mermaid）
//
// 目标（用户需求）：
// - 把 `renderMermaidAscii()` 的 erDiagram 输出反向解析回 Mermaid 文本；
// - 用于“字符画自证”：能反解回逻辑一致的 Mermaid（允许 id 不同）。
//
// 当前覆盖范围（按 unicode testdata 需求裁剪）：
// - entity box（header + attributes）
// - crow's foot cardinality（|| / o| / }| / o{）
// - identifying/non-identifying（-- / ..）
// - 水平关系（同一行的实体之间连接）
//
// 说明：
// - 本仓库 ER renderer 会把 relationship label 写在“实体间 gap”里；
//   如果 gap 不够大，label 会被裁剪，信息丢失无法反解。
//   因此配套需要 renderer 侧保证 label 不裁剪（见 er-diagram.ts 的改良）。
// ============================================================================

import { stripWidePlaceholders, toUnicodeGrid, WIDE_PLACEHOLDER } from './reverse-grid.ts'

type Cardinality = 'one' | 'zero-one' | 'many' | 'zero-many'

interface BoxRect {
  x1: number
  y1: number
  x2: number
  y2: number
}

interface ParsedAttribute {
  type: string
  name: string
  keys: Array<'PK' | 'FK' | 'UK'>
}

interface ParsedEntity extends BoxRect {
  label: string
  attributes: ParsedAttribute[]
}

interface ParsedRelationship {
  entity1: string
  entity2: string
  cardinality1: Cardinality
  cardinality2: Cardinality
  identifying: boolean
  label: string
}

function key(x: number, y: number): string {
  return `${x},${y}`
}

function isSpace(ch: string): boolean {
  return ch === ' ' || ch === WIDE_PLACEHOLDER
}

function findBoxesUnicode(grid: string[][], width: number, height: number): BoxRect[] {
  const boxes: BoxRect[] = []

  for (let y = 0; y < height; y++) {
    const row = grid[y] ?? []
    for (let x = 0; x < width; x++) {
      if (row[x] !== '┌') continue

      // 找到 ┐
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

      // 找到 ┘
      let y2 = -1
      for (let cy = y + 1; cy < height; cy++) {
        if ((grid[cy]?.[x] ?? ' ') === '└' && (grid[cy]?.[x2] ?? ' ') === '┘') {
          y2 = cy
          break
        }
      }
      if (y2 < 0) continue

      boxes.push({ x1: x, y1: y, x2, y2 })
    }
  }

  return boxes
}

function extractBoxSections(grid: string[][], box: BoxRect): string[][] {
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
      lines.push(stripWidePlaceholders(raw).trim())
    }
    sections.push(lines)
    startY = sepY + 1
  }

  {
    const lines: string[] = []
    for (let y = startY; y < box.y2; y++) {
      const raw = (grid[y] ?? []).slice(box.x1 + 1, box.x2).join('')
      lines.push(stripWidePlaceholders(raw).trim())
    }
    sections.push(lines)
  }

  return sections
}

function parseAttributeLine(line: string): ParsedAttribute | null {
  const trimmed = line.trim()
  if (!trimmed) return null

  const parts = trimmed.split(/\s+/)
  if (parts.length < 2) return null

  // 输出形态：
  // - 有 key：PK string name
  // - 无 key：int age
  const first = parts[0]!.toUpperCase()

  const isKeysToken = (() => {
    const pieces = first.split(',')
    return pieces.length > 0 && pieces.every(p => p === 'PK' || p === 'FK' || p === 'UK')
  })()

  let keys: ParsedAttribute['keys'] = []
  let type: string
  let name: string

  if (isKeysToken) {
    if (parts.length < 3) return null
    keys = first.split(',') as ParsedAttribute['keys']
    type = parts[1]!
    name = parts[2]!
  } else {
    type = parts[0]!
    name = parts[1]!
  }

  return { type, name, keys }
}

function parseEntity(grid: string[][], box: BoxRect): ParsedEntity | null {
  const sections = extractBoxSections(grid, box)
  if (sections.length === 0) return null

  const header = (sections[0] ?? []).map(s => s.trim()).filter(Boolean)
  if (header.length === 0) return null

  const label = header[0]!
  const attributes: ParsedAttribute[] = []

  if (sections.length >= 2) {
    for (const l of sections[1] ?? []) {
      const attr = parseAttributeLine(l)
      if (attr) attributes.push(attr)
    }
  }

  return { ...box, label, attributes }
}

function centerX(box: BoxRect): number {
  return box.x1 + Math.floor((box.x2 - box.x1) / 2)
}

function centerY(box: BoxRect): number {
  return box.y1 + Math.floor((box.y2 - box.y1) / 2)
}

function cardinalityFromMarker(token: string): Cardinality | null {
  // Unicode marker（er-diagram.ts）：
  // one:       ║
  // zero-one:  o║
  // many:      ╟
  // zero-many: o╟
  if (token === '║') return 'one'
  if (token === 'o║') return 'zero-one'
  if (token === '╟') return 'many'
  if (token === 'o╟') return 'zero-many'
  return null
}

function mermaidCardinality(card: Cardinality): string {
  switch (card) {
    case 'one': return '||'
    case 'zero-one': return 'o|'
    case 'many': return '}|'
    case 'zero-many': return 'o{'
  }
}

function parseHorizontalRelationship(
  grid: string[][],
  left: ParsedEntity,
  right: ParsedEntity,
): ParsedRelationship | null {
  const startX = left.x2 + 1
  const endX = right.x1 - 1
  if (endX < startX) return null

  const lineY = left.y1 + Math.floor((left.y2 - left.y1 + 1) / 2)
  const lineRow = grid[lineY] ?? []

  // 关系线必须出现 crow marker，否则认为不是关系
  const hasCrow = (() => {
    for (let x = startX; x <= endX; x++) {
      const c = lineRow[x] ?? ' '
      if (c === '║' || c === '╟') return true
    }
    return false
  })()
  if (!hasCrow) return null

  // 左侧 marker（startX 开始）
  const leftToken = (() => {
    const c0 = lineRow[startX] ?? ' '
    const c1 = lineRow[startX + 1] ?? ' '
    if (c0 === 'o') return `o${c1}`
    return c0
  })()

  // 右侧 marker（endX 结尾）
  const rightToken = (() => {
    const c0 = lineRow[endX - 1] ?? ' '
    const c1 = lineRow[endX] ?? ' '
    if (c0 === 'o') return `o${c1}`
    return c1
  })()

  const cardinality1 = cardinalityFromMarker(leftToken)
  const cardinality2 = cardinalityFromMarker(rightToken)
  if (!cardinality1 || !cardinality2) return null

  // identifying: 线是 ─；non-identifying: 线是 ╌
  let identifying = true
  for (let x = startX; x <= endX; x++) {
    const c = lineRow[x] ?? ' '
    if (c === '╌' || c === '.') {
      identifying = false
      break
    }
  }

  // label：在 lineY-1 的 gap 区域内
  const labelY = lineY - 1
  const labelRow = grid[labelY] ?? []
  const raw = labelRow.slice(startX, endX + 1).join('')
  const label = stripWidePlaceholders(raw).trim()

  if (!label) return null

  return {
    entity1: left.label,
    entity2: right.label,
    cardinality1,
    cardinality2,
    identifying,
    label,
  }
}

export function reverseErAsciiToMermaid(ascii: string): string {
  const { grid, width, height } = toUnicodeGrid(ascii)

  // 1) entities
  const rects = findBoxesUnicode(grid, width, height)
  const entities: ParsedEntity[] = []
  for (const r of rects) {
    const e = parseEntity(grid, r)
    if (e) entities.push(e)
  }

  // 稳定顺序：先从上到下，再从左到右
  entities.sort((a, b) => (a.y1 - b.y1) || (a.x1 - b.x1))

  // 2) relationships（当前只实现“水平关系”足以覆盖 unicode testdata）
  const relationships: ParsedRelationship[] = []
  for (let i = 0; i < entities.length; i++) {
    for (let j = i + 1; j < entities.length; j++) {
      const a = entities[i]!
      const b = entities[j]!

      // 仅处理同一行（水平连接）
      const sameRow = Math.abs(centerY(a) - centerY(b)) < Math.max(a.y2 - a.y1 + 1, b.y2 - b.y1 + 1)
      if (!sameRow) continue

      const left = centerX(a) <= centerX(b) ? a : b
      const right = left === a ? b : a

      const rel = parseHorizontalRelationship(grid, left, right)
      if (rel) relationships.push(rel)
    }
  }

  // 3) Mermaid 输出
  const lines: string[] = []
  lines.push('erDiagram')

  for (const e of entities) {
    if (e.attributes.length === 0) continue

    lines.push(`  ${e.label} {`)
    for (const a of e.attributes) {
      const keys = a.keys.length > 0 ? ` ${a.keys.join(' ')}` : ''
      lines.push(`    ${a.type} ${a.name}${keys}`)
    }
    lines.push('  }')
  }

  for (const r of relationships) {
    const c1 = mermaidCardinality(r.cardinality1)
    const c2 = mermaidCardinality(r.cardinality2)
    const lineStyle = r.identifying ? '--' : '..'
    lines.push(`  ${r.entity1} ${c1}${lineStyle}${c2} ${r.entity2} : ${r.label}`)
  }

  return lines.join('\n') + '\n'
}

