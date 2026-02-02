// ============================================================================
// ASCII/Unicode Flowchart 反向解析（字符画 → Mermaid）
//
// 目标（用户需求）：
// - 把 `renderMermaidAscii()` 的输出（Flowchart/State）反向解析回 Mermaid 文本。
// - 用它作为“渲染不歧义”的验收：如果能 parse 回逻辑一致的图（允许 id 不同），说明读图与解析都不含糊。
//
// 重要说明（范围与取舍）：
// - 这是一个“只支持本项目渲染风格”的解析器，不追求解析任意来源的 ASCII 图。
// - 目前只覆盖 Flowchart/State（也就是使用 src/ascii/grid.ts + draw.ts 的那条管线）。
// - 解析策略偏向鲁棒而非完美：优先服务回归测试与“可逆验收”。
// ============================================================================

import type { Direction } from '../types.ts'
import { charDisplayWidth } from './canvas.ts'

// ============================================================================
// 数据结构
// ============================================================================

interface Point {
  x: number
  y: number
}

interface Box {
  /** 左上角（包含边框） */
  x1: number
  y1: number
  /** 右下角（包含边框） */
  x2: number
  y2: number
  /** box 内部的文本 label（用于生成 Mermaid 节点） */
  label: string
}

interface ParsedEdge {
  fromBoxIndex: number
  toBoxIndex: number
  label: string
}

export interface ReverseFlowchartOptions {
  /**
   * 输出 Mermaid 的方向（默认 LR）。
   * 注意：从字符画中“推断方向”不可靠，因此这里用显式参数更稳。
   */
  direction?: Direction
}

// ============================================================================
// 基础工具：字符网格
// ============================================================================

// 宽字符占位符：
// - ASCII/Unicode 输出里，emoji/中文等字符会占 2 列。
// - `canvasToString()` 会“跳过下一列 cell”来保持对齐，因此输出字符串里缺少这一列。
// - 反向解析时必须把它补回来，否则 x 坐标会整体漂移，box/箭头根本找不到。
const WIDE_PLACEHOLDER = '\u0000'

function stripWidePlaceholders(text: string): string {
  return text.replaceAll(WIDE_PLACEHOLDER, '')
}

function lineDisplayWidth(line: string): number {
  let width = 0
  for (const ch of line) width += charDisplayWidth(ch)
  return width
}

function toGrid(text: string): { grid: string[][]; width: number; height: number } {
  const lines = text.split('\n')

  // 以“终端显示列宽”作为网格宽度，而不是 JS 字符串 length。
  const width = lines.reduce((m, l) => Math.max(m, lineDisplayWidth(l)), 0)

  const grid = lines.map((line) => {
    const cells: string[] = []
    for (const ch of line) {
      const w = charDisplayWidth(ch)
      cells.push(ch)
      if (w === 2) {
        // 用占位符补齐“被跳过的下一列”
        cells.push(WIDE_PLACEHOLDER)
      }
    }
    while (cells.length < width) cells.push(' ')
    return cells
  })

  return { grid, width, height: grid.length }
}

function inBounds(p: Point, width: number, height: number): boolean {
  return p.x >= 0 && p.y >= 0 && p.x < width && p.y < height
}

function key(p: Point): string {
  return `${p.x},${p.y}`
}

function charAt(grid: string[][], p: Point): string {
  return grid[p.y]?.[p.x] ?? ' '
}

// ============================================================================
// 节点 box 检测（Unicode 模式）
// ============================================================================

// 说明：
// - 理想情况下 box 四角分别是 ┌┐└┘。
// - 但在我们的渲染里，边可能会“贴着角落端口”出入，导致 corner 被 junction 字符替换（例如 ┬/┴/├/┤）。
// - 为了让反解器对这种情况更鲁棒，我们允许 corner 是“具备该角落连通性”的 junction 变体。
const TOP_LEFT_OK = new Set(['┌', '├', '┬', '┼'])
const TOP_RIGHT_OK = new Set(['┐', '┤', '┬', '┼'])
const BOTTOM_LEFT_OK = new Set(['└', '├', '┴', '┼'])
const BOTTOM_RIGHT_OK = new Set(['┘', '┤', '┴', '┼'])

function isUnicodeTopLeft(c: string): boolean { return TOP_LEFT_OK.has(c) }
function isUnicodeTopRight(c: string): boolean { return TOP_RIGHT_OK.has(c) }
function isUnicodeBottomLeft(c: string): boolean { return BOTTOM_LEFT_OK.has(c) }
function isUnicodeBottomRight(c: string): boolean { return BOTTOM_RIGHT_OK.has(c) }

function findBoxesUnicode(grid: string[][], width: number, height: number): Box[] {
  const boxes: Box[] = []

  // 允许出现在 box 边框上的字符（考虑边从 box 上入/出时的 junction 字符）
  // 顶/底边：只要具备“水平连通”即可（允许 junction）
  const topBorderOk = new Set(['─', '┬', '┴', '┼'])
  const bottomBorderOk = new Set(['─', '┬', '┴', '┼'])
  // 左/右边：只要具备“垂直连通”即可（允许 junction）
  const sideBorderOk = new Set(['│', '├', '┤', '┬', '┴', '┼'])

  // 过滤误判：box label 必须包含“非结构字符”
  // 说明：
  // - 在复杂路由里，可能出现“看起来像矩形”的线段组合；
  // - 如果不做约束，反解器会把这些线段误判为 node box，导致：
  //   1) 多出假的节点；2) 真实箭头落在假 box 内部被跳过；3) 边解析缺失。
  // - 真实节点 label 通常是字母/数字/中文/emoji 等，而不是 box-drawing 字符。
  const structuralForLabel = new Set([
    '─', '│', '┌', '┐', '└', '┘', '├', '┤', '┬', '┴', '┼',
    '╴', '╵', '╶', '╷',
    '►', '◄', '▲', '▼',
  ])

  function hasMeaningfulLabel(label: string): boolean {
    for (const ch of label) {
      if (ch === ' ' || ch === WIDE_PLACEHOLDER) continue
      if (structuralForLabel.has(ch)) continue
      return true
    }
    return false
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!isUnicodeTopLeft(grid[y]![x]!)) continue

      // 找同一行的右上角
      for (let x2 = x + 1; x2 < width; x2++) {
        if (!isUnicodeTopRight(grid[y]![x2]!)) continue

        // 顶边必须是一段连续的 box 边框（否则很可能只是线条拐角）
        let okTop = true
        for (let xx = x + 1; xx < x2; xx++) {
          const c = grid[y]![xx]!
          if (!topBorderOk.has(c)) { okTop = false; break }
        }
        if (!okTop) continue

        // 找对应的左下角（同一列）
        for (let y2 = y + 1; y2 < height; y2++) {
          if (!isUnicodeBottomLeft(grid[y2]![x]!)) continue
          if (!isUnicodeBottomRight(grid[y2]![x2]!)) continue

          // 最小尺寸过滤（避免把边的“拐角”当成 box）
          const w = x2 - x
          const h = y2 - y
          if (w < 3 || h < 3) continue

          // 左右边框必须是连续的竖边框（允许 junction）
          let okSides = true
          for (let yy = y + 1; yy < y2; yy++) {
            const lc = grid[yy]![x]!
            const rc = grid[yy]![x2]!
            if (!sideBorderOk.has(lc) || !sideBorderOk.has(rc)) { okSides = false; break }
          }
          if (!okSides) continue

          // 底边也需要是连续的 box 边框
          let okBottom = true
          for (let xx = x + 1; xx < x2; xx++) {
            const c = grid[y2]![xx]!
            if (!bottomBorderOk.has(c)) { okBottom = false; break }
          }
          if (!okBottom) continue

          // 提取 box label：取内部“非空字符最多”的那一行
          let bestLabel = ''
          let bestCount = -1
          for (let yy = y + 1; yy < y2; yy++) {
            const inner = stripWidePlaceholders(grid[yy]!.slice(x + 1, x2).join(''))
            const trimmed = inner.trim()
            if (trimmed.length === 0) continue
            const count = [...trimmed].filter(ch => ch !== ' ').length
            if (count > bestCount) {
              bestCount = count
              bestLabel = trimmed
            }
          }

          if (bestLabel.length === 0) continue
          if (!hasMeaningfulLabel(bestLabel)) continue

          boxes.push({ x1: x, y1: y, x2, y2, label: bestLabel })
          break
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // 第二条路径：从“底边”推断 box（用于 top border 被 edge label 覆盖的场景）
  //
  // 背景：
  // - 我们的渲染器会把 edge label 画在连线上，而连线层级在 box 之上（drawGraph: label 最后 merge）。
  // - 当某条边恰好沿着 box 的顶边走时，label 可能会把 box 的顶边/角字符覆盖掉，
  //   导致仅靠“top-left corner -> top-right corner”的检测漏掉该 box。
  //
  // 解决：
  // - 增加一个“从底边反推”的检测：只要 bottom-left/bottom-right + 两侧竖边成立，
  //   就认为这是一个 box；top border 允许被覆盖（不强校验）。
  //
  // 这条路径只用于补漏，不替代原始检测。
  // -------------------------------------------------------------------------

  function findBoxesFromBottom(): Box[] {
    const found: Box[] = []

    // 底边允许出现的字符（考虑边从 box 边框出入时的 junction）
    const bottomBorderOk = new Set(['─', '┬', '┴', '┼'])
    const sideBorderOk = new Set(['│', '├', '┤', '┬', '┴', '┼'])

    for (let y2 = 0; y2 < height; y2++) {
      for (let x = 0; x < width; x++) {
        if (!isUnicodeBottomLeft(grid[y2]![x]!)) continue

        for (let x2 = x + 1; x2 < width; x2++) {
          if (!isUnicodeBottomRight(grid[y2]![x2]!)) continue

          // 底边必须连续（否则更像是路径拐角）
          let okBottom = true
          for (let xx = x + 1; xx < x2; xx++) {
            const c = grid[y2]![xx]!
            if (!bottomBorderOk.has(c)) { okBottom = false; break }
          }
          if (!okBottom) continue

          // 向上找竖边：直到遇到“不是竖边”的那一行，作为 top row（允许被覆盖）
          let y1 = y2 - 1
          let seenSide = 0
          while (y1 >= 0) {
            const lc = grid[y1]![x]!
            const rc = grid[y1]![x2]!
            if (!sideBorderOk.has(lc) || !sideBorderOk.has(rc)) break
            seenSide++
            y1--
          }

          // y1 现在停在“不是竖边”的那一行；top border 行应该是 y1（停的位置），
          // box 的最小高度至少要能容纳内容与边框。
          const topRow = y1
          const h = y2 - topRow
          const w = x2 - x
          if (topRow < 0) continue
          if (w < 3 || h < 3) continue

          // 至少要看到 1 行竖边（否则很可能只是底边+拐角）
          if (seenSide < 1) continue

          // 提取 label：同样取内部“非空字符最多”的那一行
          let bestLabel = ''
          let bestCount = -1
          for (let yy = topRow + 1; yy < y2; yy++) {
            const inner = stripWidePlaceholders(grid[yy]!.slice(x + 1, x2).join(''))
            const trimmed = inner.trim()
            if (trimmed.length === 0) continue
            const count = [...trimmed].filter(ch => ch !== ' ').length
            if (count > bestCount) {
              bestCount = count
              bestLabel = trimmed
            }
          }

          if (bestLabel.length === 0) continue
          if (!hasMeaningfulLabel(bestLabel)) continue

          found.push({ x1: x, y1: topRow, x2, y2, label: bestLabel })
          break
        }
      }
    }

    return found
  }

  // 合并 bottom-based 的补漏结果（按坐标去重）
  const bottomBoxes = findBoxesFromBottom()
  const coordKey = (b: Box) => `${b.x1},${b.y1},${b.x2},${b.y2}`
  const seen = new Set(boxes.map(coordKey))
  for (const b of bottomBoxes) {
    const k = coordKey(b)
    if (seen.has(k)) continue
    seen.add(k)
    boxes.push(b)
  }

  // -------------------------------------------------------------------------
  // 第三条路径：固定高度（默认 padding=1）从“label 行”推断 box
  //
  // 说明：
  // - 默认配置下（boxBorderPadding=1），node box 的高度通常是 5 行：
  //   top border / 空行 / label 行 / 空行 / bottom border。
  // - 如果 top/bottom 的角字符被边覆盖，top/bottom-based 都可能漏检；
  //   但 label 行两侧的 `│ ... │` 往往仍在，因此可以作为锚点。
  //
  // 这同样只用于补漏，且我们会用“上下空行是否基本为空”来降低误判概率。
  // -------------------------------------------------------------------------
  function findBoxesFromFixedHeight(): Box[] {
    const found: Box[] = []

    const sideBorderOk = new Set(['│', '├', '┤', '┬', '┴', '┼'])
    const bottomBorderOk = new Set(['─', '┬', '┴', '┼'])

    function innerNonSpaceCount(y: number, x1: number, x2: number): number {
      const raw = stripWidePlaceholders(grid[y]!.slice(x1, x2).join(''))
      return [...raw].filter(ch => ch !== ' ').length
    }

    for (let y = 0; y < height; y++) {
      // 找到这一行所有可能的左右边界点
      const borderXs: number[] = []
      for (let x = 0; x < width; x++) {
        if (sideBorderOk.has(grid[y]![x]!)) borderXs.push(x)
      }

      for (let i = 0; i < borderXs.length; i++) {
        for (let j = i + 1; j < borderXs.length; j++) {
          const x1 = borderXs[i]!
          const x2 = borderXs[j]!
          if (x2 - x1 < 3) continue

          const inner = stripWidePlaceholders(grid[y]!.slice(x1 + 1, x2).join(''))
          const trimmed = inner.trim()
          if (trimmed.length === 0) continue

          // 预期高度：5 行（label 行在中间）
          const topRow = y - 2
          const bottomRow = y + 2
          if (topRow < 0 || bottomRow >= height) continue

          // 两侧竖边在“上下空行”也应存在
          if (!sideBorderOk.has(grid[y - 1]![x1]!) || !sideBorderOk.has(grid[y - 1]![x2]!)) continue
          if (!sideBorderOk.has(grid[y + 1]![x1]!) || !sideBorderOk.has(grid[y + 1]![x2]!)) continue

          // 上下空行内部应当基本为空（避免把 edge label 当成 box）
          const upperInner = innerNonSpaceCount(y - 1, x1 + 1, x2)
          const lowerInner = innerNonSpaceCount(y + 1, x1 + 1, x2)
          if (upperInner > 1 || lowerInner > 1) continue

          // 底边应当主要由水平边框字符组成（允许 junction）
          let okBottom = true
          for (let xx = x1 + 1; xx < x2; xx++) {
            const c = grid[bottomRow]![xx]!
            if (!bottomBorderOk.has(c)) { okBottom = false; break }
          }
          if (!okBottom) continue

          // 用与主逻辑一致的方式提取 label（更鲁棒）
          let bestLabel = ''
          let bestCount = -1
          for (let yy = topRow + 1; yy < bottomRow; yy++) {
            const rowInner = stripWidePlaceholders(grid[yy]!.slice(x1 + 1, x2).join(''))
            const rowTrimmed = rowInner.trim()
            if (rowTrimmed.length === 0) continue
            const count = [...rowTrimmed].filter(ch => ch !== ' ').length
            if (count > bestCount) {
              bestCount = count
              bestLabel = rowTrimmed
            }
          }
          if (bestLabel.length === 0) continue
          if (!hasMeaningfulLabel(bestLabel)) continue

          found.push({ x1, y1: topRow, x2, y2: bottomRow, label: bestLabel })
        }
      }
    }

    return found
  }

  const fixedBoxes = findBoxesFromFixedHeight()
  for (const b of fixedBoxes) {
    const k = coordKey(b)
    if (seen.has(k)) continue
    seen.add(k)
    boxes.push(b)
  }

  // 过滤：只保留“最内层 box”（用于排除 subgraph 外框）
  return boxes.filter(b => !boxes.some(o => o !== b && o.x1 > b.x1 && o.y1 > b.y1 && o.x2 < b.x2 && o.y2 < b.y2))
}

// ============================================================================
// 边解析（基于箭头 + “沿非空字符走线”）
// ============================================================================

const UNICODE_ARROWS: Record<string, Point> = {
  '►': { x: 1, y: 0 },
  '◄': { x: -1, y: 0 },
  '▲': { x: 0, y: -1 },
  '▼': { x: 0, y: 1 },
}

function isArrowChar(c: string): boolean {
  return c in UNICODE_ARROWS
}

function isSpace(c: string): boolean { return c === ' ' }

function buildBorderIndex(boxes: Box[]): Map<string, number> {
  const map = new Map<string, number>()
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i]!
    for (let x = b.x1; x <= b.x2; x++) {
      map.set(key({ x, y: b.y1 }), i)
      map.set(key({ x, y: b.y2 }), i)
    }
    for (let y = b.y1; y <= b.y2; y++) {
      map.set(key({ x: b.x1, y }), i)
      map.set(key({ x: b.x2, y }), i)
    }
  }
  return map
}

function pointInBox(p: Point, b: Box): boolean {
  return p.x >= b.x1 && p.x <= b.x2 && p.y >= b.y1 && p.y <= b.y2
}

function pointInsideAnyBox(p: Point, boxes: Box[]): boolean {
  return boxes.some(b => pointInBox(p, b))
}

function neighbors4(p: Point): Point[] {
  return [
    { x: p.x + 1, y: p.y },
    { x: p.x - 1, y: p.y },
    { x: p.x, y: p.y + 1 },
    { x: p.x, y: p.y - 1 },
  ]
}

function add(p: Point, d: Point): Point {
  return { x: p.x + d.x, y: p.y + d.y }
}

function sub(a: Point, b: Point): Point {
  return { x: a.x - b.x, y: a.y - b.y }
}

function equals(a: Point, b: Point): boolean {
  return a.x === b.x && a.y === b.y
}

/**
 * 从箭头开始，沿着“非空字符”反向追踪到源 box。
 *
 * 关键假设（来自我们的渲染器特性）：
 * - 线段由 box-drawing 字符与 label 文本构成（都是非空字符）。
 * - 线段一般不会分叉（我们通过路由避免交叉/重叠），因此用“直行优先 + 必要时转弯”可解析。
 */
function traceEdgeToSourceBoxes(
  grid: string[][],
  width: number,
  height: number,
  boxes: Box[],
  borderIndex: Map<string, number>,
  arrowPos: Point,
  arrowDir: Point,
  targetBoxIndex: number,
): Array<{ sourceBoxIndex: number; visited: Point[] }> | null {
  const tailDir = { x: -arrowDir.x, y: -arrowDir.y }
  const tail = add(arrowPos, tailDir)
  if (!inBounds(tail, width, height)) return null
  if (pointInsideAnyBox(tail, boxes)) return null
  if (isSpace(charAt(grid, tail))) return null

  function isSourceMarkerChar(ch: string): boolean {
    // drawBoxStart() 会把 source box 的边框替换成这些 junction 字符：
    // - ├ ┤ ┬ ┴ （极端合成时可能变成 ┼）
    // 反解时只把“带 source marker 的边框”当作真正的 source 端口。
    //
    // 注意：这里不能把普通边框字符（│/─/┌/┐/└/┘）也算作 source marker。
    //
    // 原因（本轮真实回归）：
    // - 当允许“同源分叉”的 T junction 时，某条边的支路可能会贴着其它 box 旁边走。
    // - 若把普通边框也视为 source，会导致 BFS 在更近的“无关 box”处提前命中，
    //   进而反解出完全错误的边（例如把 `审阅者 -> 撰写者` 误判成 `记录员 -> 撰写者`）。
    //
    // 取舍：
    // - 我们只解析本项目的渲染风格，而 drawBoxStart 会稳定写入 junction marker，
    //   因此这里应当更“严格”，优先保证不误判。
    return ch === '├' || ch === '┤' || ch === '┬' || ch === '┴' || ch === '┼'
  }

  // -------------------------------------------------------------------------
  // 反解必须允许“分支/回溯”，原因：
  // - 我们的渲染允许“入边的终点段”和“出边的起点段”在同一个 node 端口附近靠得很近。
  // - 在这种场景下，仅靠“直行优先”的贪心走法，会很容易沿着另一条边的主干走到错误的 box。
  //
  // 解决策略：
  // - 用 BFS 在“非空字符组成的连通域”里找 source：
  //   - 命中 box 边框时，不立即返回；
  //   - 只有当该边框是“source marker”（drawBoxStart 的 junction 字符）且不是 target box 时，才接受为 source。
  // -------------------------------------------------------------------------

  const queue: Point[] = [tail]
  let qIndex = 0

  const cameFrom = new Map<string, Point | null>()
  cameFrom.set(key(tail), null)

  const MAX_VISITS = width * height

  // 同一个 arrowhead 的 tail 连通域里，可能存在多个 source marker：
  // - 用户允许“同 target 末端并线”（多个 source 的边共用同一个箭头）；
  // - 这时如果只返回第一个 source，会丢边，导致 roundtrip 无法通过。
  const results: Array<{ sourceBoxIndex: number; visited: Point[] }> = []
  const seenSources = new Set<number>()

  while (qIndex < queue.length && cameFrom.size <= MAX_VISITS) {
    const curr = queue[qIndex++]!

    for (const n of neighbors4(curr)) {
      if (!inBounds(n, width, height)) continue

      const borderHit = borderIndex.get(key(n))
      if (borderHit != null) {
        const borderCh = charAt(grid, n)
        if (!isSourceMarkerChar(borderCh)) continue

        // 允许自环（A --> A）：
        // - source 与 target 相同，但 source marker 会出现在“出边端口”的边框上（junction 字符）。
        // - 只要命中 source marker，就视为有效 source（即便它与 entry port 在同一侧）。
        //   否则在一些“端口紧张/多边贴近”的布局里，自环会完全无法被反解。

        if (!seenSources.has(borderHit)) {
          seenSources.add(borderHit)

          // 找到一个 source：回溯重建路径（tail -> curr），并把 border cell 也纳入 visited 里。
          const path: Point[] = []
          let p: Point | null = curr
          while (p) {
            path.unshift(p)
            p = cameFrom.get(key(p)) ?? null
          }

          results.push({ sourceBoxIndex: borderHit, visited: [arrowPos, ...path, n] })
        }

        // 不把 border cell 入队（它属于 box 边框），继续搜索其它 source
        continue
      }

      if (pointInsideAnyBox(n, boxes)) continue
      if (isSpace(charAt(grid, n))) continue

      const nk = key(n)
      if (cameFrom.has(nk)) continue

      cameFrom.set(nk, curr)
      queue.push(n)
    }
  }

  return results.length > 0 ? results : null
}

function extractEdgeLabel(grid: string[][], width: number, visited: Point[]): string {
  // “结构字符”集合：用于排除线条/箭头，只提取 label 文本
  const structural = new Set([
    '─', '│', '┌', '┐', '└', '┘', '├', '┤', '┬', '┴', '┼',
    '╴', '╵', '╶', '╷',
    '►', '◄', '▲', '▼',
  ])

  function isLabelChar(ch: string): boolean {
    if (isSpace(ch)) return false
    if (ch === WIDE_PLACEHOLDER) return false
    return !structural.has(ch)
  }

  // 关键点：
  // - label 文本会“覆盖在线条上”，但对“竖线 + 横向 label”的边，
  //   路径只会经过 label 的 1 个字符（穿过的那一格）。
  // - 因此不能只从 visited 点收集字符；
  //   必须在遇到 label 字符时，向左右扩展读取整段连续文本。
  function readHorizontalRunAt(p: Point): string | null {
    const ch = charAt(grid, p)
    if (!isLabelChar(ch)) return null

    let x1 = p.x
    let x2 = p.x

    while (x1 - 1 >= 0 && isLabelChar(charAt(grid, { x: x1 - 1, y: p.y }))) x1--
    while (x2 + 1 < width && isLabelChar(charAt(grid, { x: x2 + 1, y: p.y }))) x2++

    const run = stripWidePlaceholders(grid[p.y]!.slice(x1, x2 + 1).join('')).trim()
    return run.length > 0 ? run : null
  }

  // -----------------------------------------------------------------------
  // 选择策略（与渲染器行为对齐）：
  // - `determineLabelLine()` 默认倾向把 label 放在“从 source 出发的更早线段”上（第一个能放下的段）。
  // - 因此在反解时，优先选择“更靠近 source 的 label”，能显著降低“误拿到别的边的 label”的概率。
  //
  // 具体做法：
  // - visited 的顺序是：arrow -> ... -> source border
  // - 我们从尾部（source 侧）往前扫，遇到第一个 label run 就返回。
  // - 若完全没遇到，再退化为“最长 run”（旧逻辑）。
  // -----------------------------------------------------------------------
  for (let i = visited.length - 1; i >= 0; i--) {
    const run = readHorizontalRunAt(visited[i]!)
    if (run) return run
  }

  // fallback：最长 run（保留旧行为）
  let best = ''
  for (const p of visited) {
    const run = readHorizontalRunAt(p)
    if (!run) continue
    if (run.length > best.length) best = run
  }
  return best
}

function parseEdgesUnicode(grid: string[][], width: number, height: number, boxes: Box[]): ParsedEdge[] {
  const borderIndex = buildBorderIndex(boxes)
  const edges: ParsedEdge[] = []

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ch = grid[y]![x]!
      if (!isArrowChar(ch)) continue

      const arrowPos: Point = { x, y }
      if (pointInsideAnyBox(arrowPos, boxes)) continue

      const arrowDir = UNICODE_ARROWS[ch]!
      const targetBorder = add(arrowPos, arrowDir)
      const toBoxIndex = borderIndex.get(key(targetBorder))
      if (toBoxIndex == null) continue

      const tracedAll = traceEdgeToSourceBoxes(grid, width, height, boxes, borderIndex, arrowPos, arrowDir, toBoxIndex)
      if (!tracedAll) continue

      // 如果同一个 arrowhead 识别出多个 source：
      // - 若它们的 label 不一致，通常意味着 BFS “串到了别的边/label”，属于误判；
      //   此时应退化为“只选一个最可信的 source”（避免凭空长出边）。
      // - 若 label 一致，则更可能是真实的“同 target 并线”（允许一箭头多 source），保留全部。
      const candidates = tracedAll.map((traced) => ({
        sourceBoxIndex: traced.sourceBoxIndex,
        visited: traced.visited,
        label: extractEdgeLabel(grid, width, traced.visited),
      }))

      // 1) 优先压制“伪自环”：当 target 节点有大量出边时，
      //    incoming edge 的 tail 连通域可能会碰到 target 的其它 source marker，
      //    形成 source==target 的候选（看起来像自环，但其实不是）。
      //
      //    经验规则：
      //    - 若存在非自环候选，则只有当“自环候选路径长度”与最短非自环候选接近时，
      //      才保留它（否则视为“蹭到端口附近的假连接”）。
      const nonSelf = candidates.filter(c => c.sourceBoxIndex !== toBoxIndex)
      let filtered = candidates
      if (nonSelf.length > 0) {
        const minOther = Math.min(...nonSelf.map(c => c.visited.length))
        filtered = candidates.filter(c => c.sourceBoxIndex !== toBoxIndex || c.visited.length >= (minOther - 2))
      }

      // 2) 多 source 的判定：
      //    - 若所有候选的 label 完全一致，则更可能是“同一箭头多 source”（允许并线），输出全部；
      //    - 若 label 不一致，则更可能是 BFS 串到了其它边/label，退化为只选一个最可信的。
      const uniqueLabels = new Set(filtered.map(c => c.label.trim()))
      if (filtered.length > 1 && uniqueLabels.size === 1) {
        for (const c of filtered) {
          edges.push({ fromBoxIndex: c.sourceBoxIndex, toBoxIndex, label: c.label })
        }
      } else {
        // 选最短路径；若同长，优先非自环（更符合直觉）
        filtered.sort((a, b) => (a.visited.length - b.visited.length) || ((a.sourceBoxIndex === toBoxIndex ? 1 : 0) - (b.sourceBoxIndex === toBoxIndex ? 1 : 0)))
        const best = filtered[0]!
        edges.push({ fromBoxIndex: best.sourceBoxIndex, toBoxIndex, label: best.label })
      }
    }
  }

  // 去重：在某些布局里同一条边可能被“重复识别”（极少见，但做个防御）
  const seen = new Set<string>()
  const out: ParsedEdge[] = []
  for (const e of edges) {
    const k = `${e.fromBoxIndex}->${e.toBoxIndex}|${e.label}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push(e)
  }
  return out
}

// ============================================================================
// Mermaid 输出
// ============================================================================

function escapeMermaidLabel(label: string): string {
  // Mermaid 的字符串转义规则并不完全等同 JS；这里采取“保守可用”的最小策略：
  // - 用双引号包裹
  // - 转义内部双引号
  return label.replaceAll('\"', '\\\"')
}

export function reverseFlowchartAsciiToMermaid(ascii: string, options: ReverseFlowchartOptions = {}): string {
  const { grid, width, height } = toGrid(ascii)
  const boxes = findBoxesUnicode(grid, width, height)
  const edges = parseEdgesUnicode(grid, width, height, boxes)

  const direction: Direction = options.direction ?? 'LR'

  // 分配稳定的 node id（按 label 排序，避免输出抖动）
  const sortedBoxes = [...boxes].sort((a, b) => a.label.localeCompare(b.label))
  const boxIndexToId = new Map<number, string>()
  for (let i = 0; i < sortedBoxes.length; i++) {
    const originalIndex = boxes.indexOf(sortedBoxes[i]!)
    boxIndexToId.set(originalIndex, `N${i + 1}`)
  }

  const lines: string[] = []
  lines.push(`flowchart ${direction}`)

  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i]!
    const id = boxIndexToId.get(i)!
    lines.push(`  ${id}[\"${escapeMermaidLabel(b.label)}\"]`)
  }

  for (const e of edges) {
    const fromId = boxIndexToId.get(e.fromBoxIndex)
    const toId = boxIndexToId.get(e.toBoxIndex)
    if (!fromId || !toId) continue

    const label = e.label.trim()
    if (label.length > 0) {
      lines.push(`  ${fromId} -->|${label}| ${toId}`)
    } else {
      lines.push(`  ${fromId} --> ${toId}`)
    }
  }

  return lines.join('\n') + '\n'
}
