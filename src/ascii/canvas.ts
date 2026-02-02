// ============================================================================
// ASCII renderer — 2D text canvas
//
// Ported from AlexanderGrooff/mermaid-ascii cmd/draw.go.
// The canvas is a column-major 2D array of single-character strings.
// canvas[x][y] gives the character at column x, row y.
// ============================================================================

import type { Canvas, DrawingCoord } from './types.ts'

// ============================================================================
// 终端显示宽度（简化版 wcwidth）
//
// 背景：
// - ASCII/Unicode 画图使用的是“按列”的二维 canvas（canvas[x][y]）。
// - 但中文/全角/emoji 在终端里通常占用 2 列宽度。
// - 如果仍用 string.length 当作宽度，就会导致某些行“显示更长”，边框错位。
//
// 这里实现一个“够用且可预测”的宽度估算：
// - 普通字符：1
// - 组合附加符（combining marks）：0
// - CJK/全角/emoji：2（覆盖常见中文场景，避免 label 撞边框）
// ============================================================================

/** 判断一个 Unicode code point 是否是组合附加符（通常显示宽度为 0）。 */
function isCombiningMark(codePoint: number): boolean {
  return (
    (codePoint >= 0x0300 && codePoint <= 0x036F) || // Combining Diacritical Marks
    (codePoint >= 0x1AB0 && codePoint <= 0x1AFF) || // Combining Diacritical Marks Extended
    (codePoint >= 0x1DC0 && codePoint <= 0x1DFF) || // Combining Diacritical Marks Supplement
    (codePoint >= 0x20D0 && codePoint <= 0x20FF) || // Combining Diacritical Marks for Symbols
    (codePoint >= 0xFE20 && codePoint <= 0xFE2F)    // Combining Half Marks
  )
}

/** 判断一个 code point 在大多数终端里是否是“宽字符”（通常占 2 列）。 */
function isWideCodePoint(codePoint: number): boolean {
  // 参考 wcwidth 的常见范围实现（裁剪为“更实用”的集合）
  return (
    // Hangul Jamo init. consonants
    (codePoint >= 0x1100 && codePoint <= 0x115F) ||
    // CJK Radicals Supplement..Yi Radicals
    (codePoint >= 0x2E80 && codePoint <= 0xA4CF) ||
    // Hangul Syllables
    (codePoint >= 0xAC00 && codePoint <= 0xD7A3) ||
    // CJK Compatibility Ideographs
    (codePoint >= 0xF900 && codePoint <= 0xFAFF) ||
    // Vertical forms + CJK Compatibility Forms
    (codePoint >= 0xFE10 && codePoint <= 0xFE19) ||
    (codePoint >= 0xFE30 && codePoint <= 0xFE6F) ||
    // Fullwidth Forms
    (codePoint >= 0xFF00 && codePoint <= 0xFF60) ||
    (codePoint >= 0xFFE0 && codePoint <= 0xFFE6) ||
    // Emoji (common ranges; terminals typically render as width 2)
    (codePoint >= 0x1F300 && codePoint <= 0x1FAFF) ||
    // Misc symbols and pictographs supplement
    (codePoint >= 0x1F900 && codePoint <= 0x1F9FF)
  )
}

/** 单个“字符”（一个 Unicode code point）的终端显示宽度。 */
export function charDisplayWidth(char: string): number {
  const codePoint = char.codePointAt(0)
  if (codePoint == null) return 0

  // 控制字符：宽度视为 0（避免把它们当成可见列宽）
  if (codePoint === 0) return 0
  if (codePoint < 32 || (codePoint >= 0x7F && codePoint < 0xA0)) return 0

  if (isCombiningMark(codePoint)) return 0
  if (isWideCodePoint(codePoint)) return 2
  return 1
}

/** 字符串在终端中的“显示宽度”（列数），用于布局/居中/碰撞计算。 */
export function textDisplayWidth(text: string): number {
  let width = 0
  for (const ch of text) {
    width += charDisplayWidth(ch)
  }
  return width
}

/**
 * 按“显示宽度”裁剪字符串（不会把宽字符截成一半）。
 *
 * 典型用途：
 * - 在固定宽度区域（如 block header）写入文本，避免覆盖右侧边框。
 */
export function truncateTextToDisplayWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return ''
  let width = 0
  let out = ''
  for (const ch of text) {
    const w = charDisplayWidth(ch)
    if (width + w > maxWidth) break
    out += ch
    width += w
  }
  return out
}

/**
 * 按“显示宽度”从左侧裁剪（丢弃前 `skipWidth` 列）。
 *
 * 典型用途：
 * - 当文本的起始 X 为负数（会超出画布左边界）时，
 *   我们不把文本整体右移（那会改变布局），而是裁掉左侧溢出的部分。
 *
 * 注意：
 * - 不会把宽字符截成一半：如果遇到宽字符且 skipWidth 只剩 1，
 *   会直接丢弃整个字符（因为终端里无法显示半个字符宽度）。
 */
export function skipTextByDisplayWidth(text: string, skipWidth: number): string {
  if (skipWidth <= 0) return text

  let skipped = 0
  let out = ''

  for (const ch of text) {
    const w = charDisplayWidth(ch)

    // 还在“裁剪区”内：继续丢弃字符。
    // 组合附加符宽度为 0，也应当被丢弃，避免出现“孤儿 combining mark”。
    if (skipped < skipWidth) {
      skipped += w
      continue
    }

    out += ch
  }

  return out
}

/**
 * Create a blank canvas filled with spaces.
 * Dimensions are inclusive: mkCanvas(3, 2) creates a 4x3 grid (indices 0..3, 0..2).
 */
export function mkCanvas(x: number, y: number): Canvas {
  const canvas: Canvas = []
  for (let i = 0; i <= x; i++) {
    const col: string[] = []
    for (let j = 0; j <= y; j++) {
      col.push(' ')
    }
    canvas.push(col)
  }
  return canvas
}

/** Create a blank canvas with the same dimensions as the given canvas. */
export function copyCanvas(source: Canvas): Canvas {
  const [maxX, maxY] = getCanvasSize(source)
  return mkCanvas(maxX, maxY)
}

/** Returns [maxX, maxY] — the highest valid indices in each dimension. */
export function getCanvasSize(canvas: Canvas): [number, number] {
  return [canvas.length - 1, (canvas[0]?.length ?? 1) - 1]
}

/**
 * Grow the canvas to fit at least (newX, newY), preserving existing content.
 * Mutates the canvas in place and returns it.
 */
export function increaseSize(canvas: Canvas, newX: number, newY: number): Canvas {
  const [currX, currY] = getCanvasSize(canvas)
  const targetX = Math.max(newX, currX)
  const targetY = Math.max(newY, currY)
  const grown = mkCanvas(targetX, targetY)
  for (let x = 0; x < grown.length; x++) {
    for (let y = 0; y < grown[0]!.length; y++) {
      if (x < canvas.length && y < canvas[0]!.length) {
        grown[x]![y] = canvas[x]![y]!
      }
    }
  }
  // Mutate in place: splice old contents and replace with grown
  canvas.length = 0
  canvas.push(...grown)
  return canvas
}

// ============================================================================
// Junction merging — Unicode box-drawing character compositing
// ============================================================================

/** All Unicode box-drawing characters that participate in junction merging. */
const JUNCTION_CHARS = new Set([
  '─', '│', '┌', '┐', '└', '┘', '├', '┤', '┬', '┴', '┼', '╴', '╵', '╶', '╷',
])

export function isJunctionChar(c: string): boolean {
  return JUNCTION_CHARS.has(c)
}

/**
 * When two junction characters overlap during canvas merging,
 * resolve them to the correct combined junction.
 * E.g., '─' overlapping '│' becomes '┼'.
 */
const JUNCTION_MAP: Record<string, Record<string, string>> = {
  '─': { '│': '┼', '┌': '┬', '┐': '┬', '└': '┴', '┘': '┴', '├': '┼', '┤': '┼', '┬': '┬', '┴': '┴' },
  '│': { '─': '┼', '┌': '├', '┐': '┤', '└': '├', '┘': '┤', '├': '├', '┤': '┤', '┬': '┼', '┴': '┼' },
  '┌': { '─': '┬', '│': '├', '┐': '┬', '└': '├', '┘': '┼', '├': '├', '┤': '┼', '┬': '┬', '┴': '┼' },
  '┐': { '─': '┬', '│': '┤', '┌': '┬', '└': '┼', '┘': '┤', '├': '┼', '┤': '┤', '┬': '┬', '┴': '┼' },
  '└': { '─': '┴', '│': '├', '┌': '├', '┐': '┼', '┘': '┴', '├': '├', '┤': '┼', '┬': '┼', '┴': '┴' },
  '┘': { '─': '┴', '│': '┤', '┌': '┼', '┐': '┤', '└': '┴', '├': '┼', '┤': '┤', '┬': '┼', '┴': '┴' },
  '├': { '─': '┼', '│': '├', '┌': '├', '┐': '┼', '└': '├', '┘': '┼', '┤': '┼', '┬': '┼', '┴': '┼' },
  '┤': { '─': '┼', '│': '┤', '┌': '┼', '┐': '┤', '└': '┼', '┘': '┤', '├': '┼', '┬': '┼', '┴': '┼' },
  '┬': { '─': '┬', '│': '┼', '┌': '┬', '┐': '┬', '└': '┼', '┘': '┼', '├': '┼', '┤': '┼', '┴': '┼' },
  '┴': { '─': '┴', '│': '┼', '┌': '┼', '┐': '┼', '└': '┴', '┘': '┴', '├': '┼', '┤': '┼', '┬': '┼' },
}

export function mergeJunctions(c1: string, c2: string): string {
  return JUNCTION_MAP[c1]?.[c2] ?? c1
}

// ============================================================================
// Canvas merging — composite multiple canvases with offset
// ============================================================================

/**
 * Merge overlay canvases onto a base canvas at the given offset.
 * Non-space characters in overlays overwrite the base.
 * When both characters are Unicode junction chars, they're merged intelligently.
 */
export function mergeCanvases(
  base: Canvas,
  offset: DrawingCoord,
  useAscii: boolean,
  ...overlays: Canvas[]
): Canvas {
  let [maxX, maxY] = getCanvasSize(base)
  for (const overlay of overlays) {
    const [oX, oY] = getCanvasSize(overlay)
    maxX = Math.max(maxX, oX + offset.x)
    maxY = Math.max(maxY, oY + offset.y)
  }

  const merged = mkCanvas(maxX, maxY)

  // Copy base
  for (let x = 0; x <= maxX; x++) {
    for (let y = 0; y <= maxY; y++) {
      if (x < base.length && y < base[0]!.length) {
        merged[x]![y] = base[x]![y]!
      }
    }
  }

  // Apply overlays
  for (const overlay of overlays) {
    for (let x = 0; x < overlay.length; x++) {
      for (let y = 0; y < overlay[0]!.length; y++) {
        const c = overlay[x]![y]!
        if (c !== ' ') {
          const mx = x + offset.x
          const my = y + offset.y
          const current = merged[mx]![my]!
          if (!useAscii && isJunctionChar(c) && isJunctionChar(current)) {
            merged[mx]![my] = mergeJunctions(current, c)
          } else {
            merged[mx]![my] = c
          }
        }
      }
    }
  }

  return merged
}

// ============================================================================
// Unicode 交叉点去歧义（把“┼”变成“桥”）
//
// 背景：
// - 在 box-drawing 语义里，“┼”表示“四向都连接”的真实路口。
// - 但 Flowchart/State 的“边”在交叉处并不会连接，渲染出“┼”会产生强歧义：
//   读者无法判断线路是否相连、该怎么走。
//
// 用户期望：
// - 不要“┼”
// - 更像“上下两层交叉通路”的画法：中间保留一条线，另一条线在该行留空
//   （视觉上类似：
//      │
//     ───
//      │
//   ）
//
// 策略：
// - 对最终 canvas 做一个轻量后处理：
//   - 遇到 “┼” 时，优先保留水平线（改成 “─”），让竖线在该行断开，形成“桥”效果。
//   - 这样不会把交叉误读成连接，也避免输出里出现“┼”。
// ============================================================================

/** 判断某个字符是否“向左连通”。 */
function connectsLeft(c: string): boolean {
  return c === '─' || c === '┼' || c === '┬' || c === '┴' || c === '┤' || c === '┐' || c === '┘'
}

/** 判断某个字符是否“向右连通”。 */
function connectsRight(c: string): boolean {
  return c === '─' || c === '┼' || c === '┬' || c === '┴' || c === '├' || c === '┌' || c === '└'
}

/** 判断某个字符是否“向上连通”。 */
function connectsUp(c: string): boolean {
  return c === '│' || c === '┼' || c === '├' || c === '┤' || c === '┴' || c === '└' || c === '┘'
}

/** 判断某个字符是否“向下连通”。 */
function connectsDown(c: string): boolean {
  return c === '│' || c === '┼' || c === '├' || c === '┤' || c === '┬' || c === '┌' || c === '┐'
}

/**
 * 把 canvas 中的“┼”交叉点改成更不歧义的“桥”样式。
 *
 * 注意：
 * - 这是一个“渲染后处理”，不改变路由结果，只改变单字符交叉点的表现。
 * - 目前策略优先保留水平线（改成 “─”），因为 box border 多为水平线，
 *   优先保证 box 轮廓完整，竖线在该行断开即可表达“交叉不连接”。
 */
export function deambiguateUnicodeCrossings(canvas: Canvas): void {
  const [maxX, maxY] = getCanvasSize(canvas)

  // 处理范围：全画布（包括边界）。
  //
  // 说明：
  // - 之前为了简化实现跳过了边界点，但实际输出中“┼”可能出现在边界（例如 label 贴边/子图偏移后）。
  // - 用户诉求是“完全不要 ┼”，因此这里必须覆盖边界。
  for (let x = 0; x <= maxX; x++) {
    for (let y = 0; y <= maxY; y++) {
      if (canvas[x]![y]! !== '┼') continue

      const left = x > 0 ? canvas[x - 1]![y]! : ' '
      const right = x < maxX ? canvas[x + 1]![y]! : ' '
      const up = y > 0 ? canvas[x]![y - 1]! : ' '
      const down = y < maxY ? canvas[x]![y + 1]! : ' '

      // 用“方向连通数量”而不是简单布尔，才能在边界缺失邻居时做合理决策。
      const hCount = (connectsRight(left) ? 1 : 0) + (connectsLeft(right) ? 1 : 0)
      const vCount = (connectsDown(up) ? 1 : 0) + (connectsUp(down) ? 1 : 0)

      // 策略：默认优先保留水平线（更符合 box border 的常见形态），
      // 但如果竖向连通明显更多，则保留竖线。
      canvas[x]![y] = vCount > hCount ? '│' : '─'
    }
  }
}

// ============================================================================
// Canvas → string conversion
// ============================================================================

/** Convert the canvas to a multi-line string (row by row, left to right). */
export function canvasToString(canvas: Canvas): string {
  const [maxX, maxY] = getCanvasSize(canvas)
  const lines: string[] = []
  for (let y = 0; y <= maxY; y++) {
    let line = ''
    for (let x = 0; x <= maxX; x++) {
      const c = canvas[x]![y]!
      line += c

      // 宽字符在终端里通常占 2 列：
      // - 我们把它视为“占用了下一列”，因此输出时跳过下一列 cell。
      // - 这样可以让“canvas 列数”与“终端显示列数”保持一致，避免边框错位。
      if (charDisplayWidth(c) === 2) {
        x += 1
      }
    }
    lines.push(line)
  }
  return lines.join('\n')
}

// ============================================================================
// Canvas vertical flip — used for BT (bottom-to-top) direction support.
//
// The ASCII renderer lays out graphs top-down (TD). For BT direction, we
// flip the finished canvas vertically and remap directional characters so
// arrows point upward and corners are mirrored correctly.
// ============================================================================

/**
 * Characters that change meaning when the Y-axis is flipped.
 * Symmetric characters (─, │, ├, ┤, ┼) are unchanged.
 */
const VERTICAL_FLIP_MAP: Record<string, string> = {
  // Unicode arrows
  '▲': '▼', '▼': '▲',
  '◤': '◣', '◣': '◤',
  '◥': '◢', '◢': '◥',
  // ASCII arrows
  '^': 'v', 'v': '^',
  // Unicode corners
  '┌': '└', '└': '┌',
  '┐': '┘', '┘': '┐',
  // Unicode junctions (T-pieces flip vertically)
  '┬': '┴', '┴': '┬',
  // Box-start junctions (exit points from node boxes)
  '╵': '╷', '╷': '╵',
}

/**
 * Flip the canvas vertically (mirror across the horizontal center).
 * Reverses row order within each column and remaps directional characters
 * (arrows, corners, junctions) so they point the correct way after flip.
 *
 * Used to transform a TD-rendered canvas into BT output.
 * Mutates the canvas in place and returns it.
 */
export function flipCanvasVertically(canvas: Canvas): Canvas {
  // Reverse each column array (Y-axis flip in column-major layout)
  for (const col of canvas) {
    col.reverse()
  }

  // Remap directional characters that change meaning after vertical flip
  for (const col of canvas) {
    for (let y = 0; y < col.length; y++) {
      const flipped = VERTICAL_FLIP_MAP[col[y]!]
      if (flipped) col[y] = flipped
    }
  }

  return canvas
}

/** Draw text string onto the canvas starting at the given coordinate. */
export function drawText(canvas: Canvas, start: DrawingCoord, text: string): void {
  // 使用终端显示宽度扩容：
  // - 宽字符占 2 列，需要预留额外的列空间，否则会覆盖边框/连线。
  increaseSize(canvas, start.x + textDisplayWidth(text), start.y)

  let x = start.x
  for (const ch of text) {
    canvas[x]![start.y] = ch
    x += charDisplayWidth(ch)
  }
}

/**
 * Set the canvas size to fit all grid columns and rows.
 * Called after layout to ensure the canvas covers the full drawing area.
 */
export function setCanvasSizeToGrid(
  canvas: Canvas,
  columnWidth: Map<number, number>,
  rowHeight: Map<number, number>,
): void {
  let maxX = 0
  let maxY = 0
  for (const w of columnWidth.values()) maxX += w
  for (const h of rowHeight.values()) maxY += h
  increaseSize(canvas, maxX - 1, maxY - 1)
}
