// ============================================================================
// ASCII/Unicode SequenceDiagram 反向解析（字符画 → Mermaid）
//
// 目标（用户需求）：
// - 把 `renderMermaidAscii()` 的 sequenceDiagram 输出反向解析回 Mermaid 文本。
// - 用于“字符画不歧义”的自证：能反解回逻辑一致的 Mermaid（允许 id 不同）。
//
// 取舍（非常重要）：
// - 这是“只支持本项目渲染风格”的解析器，不追求通吃任意 ASCII 图。
// - 当前仅覆盖本仓库 unicode testdata 里出现的能力：
//   - 普通消息（左→右 / 右→左）
//   - dashed/solid
//   - filled/open arrowhead
//   - self-message loop（├──┐ ... ◀──┘）
// - block/note 等高级语法目前不在 unicode testdata 里，暂不实现（后续可扩展）。
// ============================================================================

import { stripWidePlaceholders, toUnicodeGrid, WIDE_PLACEHOLDER } from './reverse-grid.ts'

type LineStyle = 'solid' | 'dashed'
type ArrowHead = 'filled' | 'open'

interface Actor {
  /** lifeline 的 x 坐标（列） */
  lifelineX: number
  /** 参与者显示名（box 内文本） */
  label: string
  /** 输出 Mermaid 用的 id（允许与 label 不同） */
  id: string
}

interface ParsedMessage {
  fromActorIndex: number
  toActorIndex: number
  label: string
  lineStyle: LineStyle
  arrowHead: ArrowHead
  /** 用于排序：消息在画布里的 y */
  y: number
}

const RIGHT_ARROWS = new Set(['▶', '▷', '>'])
const LEFT_ARROWS = new Set(['◀', '◁', '<'])

function isSpace(ch: string): boolean {
  return ch === ' ' || ch === WIDE_PLACEHOLDER
}

function isVerticalLine(ch: string): boolean {
  return ch === '│' || ch === '|'
}

function detectHeaderJunctionRow(grid: string[][]): number | null {
  // Sequence header 的 box 底边会把 lifeline 处标成 ┬（Unicode）或 +（ASCII）。
  // 我们用“出现最多 ┬ 的行”来定位 header 的 junction row。
  let bestY: number | null = null
  let bestCount = 0

  // 只扫顶部一小段即可（sequence 的 header 一定在顶部）
  const limit = Math.min(grid.length, 20)
  for (let y = 0; y < limit; y++) {
    let count = 0
    for (const c of grid[y] ?? []) {
      if (c === '┬' || c === '+') count++
    }
    if (count > bestCount) {
      bestCount = count
      bestY = y
    }
  }

  return bestCount > 0 ? bestY : null
}

function scanToBoundary(row: string[], startX: number, dir: -1 | 1): number {
  let x = startX
  while (x >= 0 && x < row.length) {
    if (isVerticalLine(row[x]!)) return x
    x += dir
  }
  return -1
}

function parseActors(grid: string[][]): Actor[] {
  const headerY = detectHeaderJunctionRow(grid)
  if (headerY == null || headerY <= 0) return []

  const lifelineXs: number[] = []
  for (let x = 0; x < (grid[headerY]?.length ?? 0); x++) {
    const c = grid[headerY]![x]!
    if (c === '┬' || c === '+') lifelineXs.push(x)
  }

  // label 行通常是 headerY - 1（box 的中间行）
  const labelRow = grid[headerY - 1] ?? []

  const actors: Actor[] = []
  for (let i = 0; i < lifelineXs.length; i++) {
    const x = lifelineXs[i]!
    const left = scanToBoundary(labelRow, x, -1)
    const right = scanToBoundary(labelRow, x, 1)
    if (left < 0 || right < 0 || right <= left) continue

    const raw = labelRow.slice(left + 1, right).join('')
    const label = stripWidePlaceholders(raw).trim()
    if (!label) continue

    // 生成可解析、稳定的 actor id：
    // - label 无空白：直接用 label（最接近原 Mermaid）
    // - label 含空白：用 A1/A2...，并在 participant 声明里 as 回 label
    const id = /\s/.test(label) ? `A${i + 1}` : label

    actors.push({ lifelineX: x, label, id })
  }

  // 按列排序（保证从左到右的参与者顺序稳定）
  return actors.sort((a, b) => a.lifelineX - b.lifelineX)
}

function actorIndexByLifelineX(actors: Actor[]): Map<number, number> {
  const map = new Map<number, number>()
  for (let i = 0; i < actors.length; i++) map.set(actors[i]!.lifelineX, i)
  return map
}

function detectLineStyle(lineChar: string): LineStyle {
  // sequence.ts 里 dashed 用的是 '╌'（Unicode）或 '.'（ASCII）
  return lineChar === '╌' || lineChar === '.' ? 'dashed' : 'solid'
}

function detectArrowHead(ch: string): ArrowHead {
  // Filled: ▶ ◀
  // Open:   ▷ ◁
  return ch === '▶' || ch === '◀' ? 'filled' : 'open'
}

function extractLabelBetween(
  gridRow: string[],
  x1: number,
  x2: number,
): string {
  const lo = Math.min(x1, x2) + 1
  const hi = Math.max(x1, x2)
  if (hi <= lo) return ''

  const raw = gridRow
    .slice(lo, hi)
    .map((c) => (isVerticalLine(c) ? ' ' : c))
    .join('')

  return stripWidePlaceholders(raw).trim()
}

function isSelfMessageLoop(grid: string[][], x: number, y: number): { loopEndX: number } | null {
  // 自环消息的形状（Unicode）：
  //   Row 0: ├──┐
  //   Row 1: │  │ Label
  //   Row 2: ◀──┘
  //
  // y 是 arrow row（Row 2），则 Row 0 = y - 2。
  if (y < 2) return null
  const topRow = grid[y - 2]
  const midRow = grid[y - 1]
  const botRow = grid[y]
  if (!topRow || !midRow || !botRow) return null

  const topStart = topRow[x]
  if (topStart !== '├' && topStart !== '+') return null

  // 找到 top row 的 ┐ 作为 loopEnd
  let loopEndX = -1
  for (let cx = x + 1; cx < topRow.length && cx < x + 20; cx++) {
    if (topRow[cx] === '┐' || topRow[cx] === '+') {
      loopEndX = cx
      break
    }
  }
  if (loopEndX < 0) return null

  // bot row 同位置应当是 ┘
  if (botRow[loopEndX] !== '┘' && botRow[loopEndX] !== '+') return null
  // mid row 同位置应当是 vertical 线
  if (!isVerticalLine(midRow[loopEndX] ?? ' ')) return null

  return { loopEndX }
}

function parseMessages(grid: string[][], actors: Actor[]): ParsedMessage[] {
  const messages: ParsedMessage[] = []
  const indexByX = actorIndexByLifelineX(actors)

  for (let y = 0; y < grid.length; y++) {
    const row = grid[y] ?? []

    for (let x = 0; x < row.length; x++) {
      const ch = row[x] ?? ' '

      // ---- self-message（优先识别，否则会把 ◀ 误判成普通左向消息）----
      if (LEFT_ARROWS.has(ch)) {
        const self = isSelfMessageLoop(grid, x, y)
        if (self) {
          const actorIdx = indexByX.get(x)
          if (actorIdx == null) continue

          // lineChar 在 x+1 位置
          const lineChar = row[x + 1] ?? '─'
          const lineStyle = detectLineStyle(lineChar)
          const arrowHead = detectArrowHead(ch)

          const labelRow = grid[y - 1] ?? []
          const labelStartX = self.loopEndX + 2
          let endX = labelStartX
          while (endX < labelRow.length && !isSpace(labelRow[endX]!)) endX++
          const raw = labelRow.slice(labelStartX, endX).join('')
          const label = stripWidePlaceholders(raw).trim()

          messages.push({
            fromActorIndex: actorIdx,
            toActorIndex: actorIdx,
            label,
            lineStyle,
            arrowHead,
            y,
          })
          continue
        }
      }

      // ---- 普通消息（右箭头 / 左箭头）----
      if (!RIGHT_ARROWS.has(ch) && !LEFT_ARROWS.has(ch)) continue

      const toActorIdx = indexByX.get(x)
      if (toActorIdx == null) continue

      if (RIGHT_ARROWS.has(ch)) {
        // 右向：from 在左，to 在右（arrowhead 在 to lifeline）
        const lineChar = row[x - 1] ?? '─'
        const lineStyle = detectLineStyle(lineChar)
        const arrowHead = detectArrowHead(ch)

        let xi = x - 1
        while (xi >= 0 && (row[xi] ?? ' ') === lineChar) xi--
        const fromX = xi
        const fromActorIdx = indexByX.get(fromX)
        if (fromActorIdx == null) continue

        const labelRow = grid[y - 1] ?? []
        const label = extractLabelBetween(labelRow, fromX, x)

        messages.push({
          fromActorIndex: fromActorIdx,
          toActorIndex: toActorIdx,
          label,
          lineStyle,
          arrowHead,
          y,
        })
      } else {
        // 左向：from 在右，to 在左（arrowhead 在 to lifeline）
        const lineChar = row[x + 1] ?? '─'
        const lineStyle = detectLineStyle(lineChar)
        const arrowHead = detectArrowHead(ch)

        let xi = x + 1
        while (xi < row.length && (row[xi] ?? ' ') === lineChar) xi++
        const fromX = xi
        const fromActorIdx = indexByX.get(fromX)
        if (fromActorIdx == null) continue

        const labelRow = grid[y - 1] ?? []
        const label = extractLabelBetween(labelRow, fromX, x)

        messages.push({
          fromActorIndex: fromActorIdx,
          toActorIndex: toActorIdx,
          label,
          lineStyle,
          arrowHead,
          y,
        })
      }
    }
  }

  // 稳定排序：从上到下
  messages.sort((a, b) => a.y - b.y)
  return messages
}

function messageOp(style: LineStyle, head: ArrowHead): string {
  if (style === 'solid' && head === 'filled') return '->>'
  if (style === 'dashed' && head === 'filled') return '-->>'
  if (style === 'solid' && head === 'open') return '->'
  return '-->'
}

export function reverseSequenceAsciiToMermaid(ascii: string): string {
  const { grid } = toUnicodeGrid(ascii)

  const actors = parseActors(grid)
  const messages = parseMessages(grid, actors)

  const lines: string[] = []
  lines.push('sequenceDiagram')

  // 显式声明参与者，保证顺序与 label 保真（即便 label 含空白也能表达）
  for (const a of actors) {
    if (a.id === a.label) {
      lines.push(`  participant ${a.id}`)
    } else {
      // Mermaid 的 participant 语法：participant A as Alice
      // label 允许包含空格，因此放在 as 后面
      lines.push(`  participant ${a.id} as ${a.label}`)
    }
  }

  for (const m of messages) {
    const from = actors[m.fromActorIndex]?.id
    const to = actors[m.toActorIndex]?.id
    if (!from || !to) continue
    lines.push(`  ${from}${messageOp(m.lineStyle, m.arrowHead)}${to}: ${m.label}`)
  }

  return lines.join('\n') + '\n'
}

