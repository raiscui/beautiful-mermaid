// ============================================================================
// ASCII renderer — drawing operations
//
// Ported from AlexanderGrooff/mermaid-ascii cmd/draw.go + cmd/arrow.go.
// Contains all visual rendering: boxes, lines, arrows, corners,
// subgraphs, labels, and the top-level draw orchestrator.
// ============================================================================

import type {
  Canvas, DrawingCoord, GridCoord, Direction,
  AsciiGraph, AsciiNode, AsciiEdge, AsciiSubgraph,
} from './types.ts'
import {
  Up, Down, Left, Right, UpperLeft, UpperRight, LowerLeft, LowerRight, Middle,
  drawingCoordEquals,
} from './types.ts'
import { mkCanvas, copyCanvas, getCanvasSize, mergeCanvases, drawText, textDisplayWidth } from './canvas.ts'
import { determineDirection, dirEquals } from './edge-routing.ts'
import { gridToDrawingCoord, lineToDrawing } from './grid.ts'

// ============================================================================
// Box drawing — renders a node as a bordered rectangle
// ============================================================================

/**
 * Draw a node box with centered label text.
 * Returns a standalone canvas containing just the box.
 * Box size is determined by the grid column/row sizes for the node's position.
 */
export function drawBox(node: AsciiNode, graph: AsciiGraph): Canvas {
  const gc = node.gridCoord!
  const useAscii = graph.config.useAscii

  // Width spans 2 columns (border + content)
  let w = 0
  for (let i = 0; i < 2; i++) {
    w += graph.columnWidth.get(gc.x + i) ?? 0
  }
  // Height spans 2 rows (border + content)
  let h = 0
  for (let i = 0; i < 2; i++) {
    h += graph.rowHeight.get(gc.y + i) ?? 0
  }

  const from: DrawingCoord = { x: 0, y: 0 }
  const to: DrawingCoord = { x: w, y: h }
  const box = mkCanvas(Math.max(from.x, to.x), Math.max(from.y, to.y))

  if (!useAscii) {
    // Unicode box-drawing characters
    for (let x = from.x + 1; x < to.x; x++) box[x]![from.y] = '─'
    for (let x = from.x + 1; x < to.x; x++) box[x]![to.y] = '─'
    for (let y = from.y + 1; y < to.y; y++) box[from.x]![y] = '│'
    for (let y = from.y + 1; y < to.y; y++) box[to.x]![y] = '│'
    box[from.x]![from.y] = '┌'
    box[to.x]![from.y] = '┐'
    box[from.x]![to.y] = '└'
    box[to.x]![to.y] = '┘'
  } else {
    // ASCII characters
    for (let x = from.x + 1; x < to.x; x++) box[x]![from.y] = '-'
    for (let x = from.x + 1; x < to.x; x++) box[x]![to.y] = '-'
    for (let y = from.y + 1; y < to.y; y++) box[from.x]![y] = '|'
    for (let y = from.y + 1; y < to.y; y++) box[to.x]![y] = '|'
    box[from.x]![from.y] = '+'
    box[to.x]![from.y] = '+'
    box[from.x]![to.y] = '+'
    box[to.x]![to.y] = '+'
  }

  // Center the display label inside the box
  const label = node.displayLabel
  const textY = from.y + Math.floor(h / 2)
  const labelWidth = textDisplayWidth(label)
  const textX = from.x + Math.floor(w / 2) - Math.ceil(labelWidth / 2) + 1
  drawText(box, { x: textX, y: textY }, label)

  return box
}

// ============================================================================
// Multi-section box drawing — for class and ER diagram nodes
// ============================================================================

/**
 * Draw a multi-section box with horizontal dividers between sections.
 * Used by class diagrams (header | attributes | methods) and ER diagrams (header | attributes).
 * Each section is an array of text lines to render left-aligned with padding.
 *
 * @param sections - Array of sections, each section is an array of text lines
 * @param useAscii - true for ASCII chars, false for Unicode box-drawing
 * @param padding - horizontal padding inside the box (default 1)
 * @returns A standalone Canvas containing the multi-section box
 */
export function drawMultiBox(
  sections: string[][],
  useAscii: boolean,
  padding: number = 1,
): Canvas {
  // Compute width: widest line across all sections + 2*padding + 2 border chars
  let maxTextWidth = 0
  for (const section of sections) {
    for (const line of section) {
      maxTextWidth = Math.max(maxTextWidth, textDisplayWidth(line))
    }
  }
  const innerWidth = maxTextWidth + 2 * padding
  const boxWidth = innerWidth + 2 // +2 for left/right border

  // Compute height: sum of all section line counts + dividers + 2 border rows
  let totalLines = 0
  for (const section of sections) {
    totalLines += Math.max(section.length, 1) // at least 1 row per section
  }
  const numDividers = sections.length - 1
  const boxHeight = totalLines + numDividers + 2 // +2 for top/bottom border

  // Box-drawing characters
  const hLine = useAscii ? '-' : '─'
  const vLine = useAscii ? '|' : '│'
  const tl = useAscii ? '+' : '┌'
  const tr = useAscii ? '+' : '┐'
  const bl = useAscii ? '+' : '└'
  const br = useAscii ? '+' : '┘'
  const divL = useAscii ? '+' : '├'
  const divR = useAscii ? '+' : '┤'

  const canvas = mkCanvas(boxWidth - 1, boxHeight - 1)

  // Top border
  canvas[0]![0] = tl
  for (let x = 1; x < boxWidth - 1; x++) canvas[x]![0] = hLine
  canvas[boxWidth - 1]![0] = tr

  // Bottom border
  canvas[0]![boxHeight - 1] = bl
  for (let x = 1; x < boxWidth - 1; x++) canvas[x]![boxHeight - 1] = hLine
  canvas[boxWidth - 1]![boxHeight - 1] = br

  // Left and right borders (full height)
  for (let y = 1; y < boxHeight - 1; y++) {
    canvas[0]![y] = vLine
    canvas[boxWidth - 1]![y] = vLine
  }

  // Render sections with dividers
  let row = 1 // current y position (starts after top border)
  for (let s = 0; s < sections.length; s++) {
    const section = sections[s]!
    const lines = section.length > 0 ? section : ['']

    // Draw section text lines
    for (const line of lines) {
      const startX = 1 + padding
      drawText(canvas, { x: startX, y: row }, line)
      row++
    }

    // Draw divider after each section except the last
    if (s < sections.length - 1) {
      canvas[0]![row] = divL
      for (let x = 1; x < boxWidth - 1; x++) canvas[x]![row] = hLine
      canvas[boxWidth - 1]![row] = divR
      row++
    }
  }

  return canvas
}

// ============================================================================
// Line drawing — 8-directional lines on the canvas
// ============================================================================

/**
 * Draw a line between two drawing coordinates.
 * Returns the list of coordinates that were drawn on.
 * offsetFrom/offsetTo control how many cells to skip at the start/end.
 */
export function drawLine(
  canvas: Canvas,
  from: DrawingCoord,
  to: DrawingCoord,
  offsetFrom: number,
  offsetTo: number,
  useAscii: boolean,
): DrawingCoord[] {
  const dir = determineDirection(from, to)
  const drawnCoords: DrawingCoord[] = []

  // Horizontal/vertical/diagonal character pairs: [unicode, ascii]
  const hChar = useAscii ? '-' : '─'
  const vChar = useAscii ? '|' : '│'
  const bslash = useAscii ? '\\' : '╲'
  const fslash = useAscii ? '/' : '╱'

  if (dirEquals(dir, Up)) {
    for (let y = from.y - offsetFrom; y >= to.y - offsetTo; y--) {
      drawnCoords.push({ x: from.x, y })
      canvas[from.x]![y] = vChar
    }
  } else if (dirEquals(dir, Down)) {
    for (let y = from.y + offsetFrom; y <= to.y + offsetTo; y++) {
      drawnCoords.push({ x: from.x, y })
      canvas[from.x]![y] = vChar
    }
  } else if (dirEquals(dir, Left)) {
    for (let x = from.x - offsetFrom; x >= to.x - offsetTo; x--) {
      drawnCoords.push({ x, y: from.y })
      canvas[x]![from.y] = hChar
    }
  } else if (dirEquals(dir, Right)) {
    for (let x = from.x + offsetFrom; x <= to.x + offsetTo; x++) {
      drawnCoords.push({ x, y: from.y })
      canvas[x]![from.y] = hChar
    }
  } else if (dirEquals(dir, UpperLeft)) {
    for (let x = from.x, y = from.y - offsetFrom; x >= to.x - offsetTo && y >= to.y - offsetTo; x--, y--) {
      drawnCoords.push({ x, y })
      canvas[x]![y] = bslash
    }
  } else if (dirEquals(dir, UpperRight)) {
    for (let x = from.x, y = from.y - offsetFrom; x <= to.x + offsetTo && y >= to.y - offsetTo; x++, y--) {
      drawnCoords.push({ x, y })
      canvas[x]![y] = fslash
    }
  } else if (dirEquals(dir, LowerLeft)) {
    for (let x = from.x, y = from.y + offsetFrom; x >= to.x - offsetTo && y <= to.y + offsetTo; x--, y++) {
      drawnCoords.push({ x, y })
      canvas[x]![y] = fslash
    }
  } else if (dirEquals(dir, LowerRight)) {
    for (let x = from.x, y = from.y + offsetFrom; x <= to.x + offsetTo && y <= to.y + offsetTo; x++, y++) {
      drawnCoords.push({ x, y })
      canvas[x]![y] = bslash
    }
  }

  return drawnCoords
}

// ============================================================================
// Arrow drawing — path, corners, arrowheads, box-start junctions, labels
// ============================================================================

/**
 * Draw a complete arrow (edge) between two nodes.
 * Returns 5 separate canvases for layered compositing:
 * [path, boxStart, arrowHead, corners, label]
 */
export function drawArrow(
  graph: AsciiGraph,
  edge: AsciiEdge,
): [Canvas, Canvas, Canvas, Canvas, Canvas] {
  // 防御性处理：
  // - 正常情况下 edge.path 至少应当包含 2 个点（起点与终点）。
  // - 但在某些极端路由退化/候选过滤失效时，可能出现 0/1 点路径。
  //   这里直接跳过绘制，避免后续对 linesDrawn[0] 等访问导致崩溃。
  if (edge.path.length < 2) {
    const empty = copyCanvas(graph.canvas)
    return [empty, empty, empty, empty, empty]
  }

  const labelCanvas = drawArrowLabel(graph, edge)
  const [pathCanvas, linesDrawn, lineDirs] = drawPath(graph, edge.path)
  const boxStartCanvas = drawBoxStart(graph, edge.path, linesDrawn[0]!)
  const arrowHeadCanvas = drawArrowHead(
    graph,
    linesDrawn[linesDrawn.length - 1]!,
    lineDirs[lineDirs.length - 1]!,
  )
  const cornersCanvas = drawCorners(graph, edge.path)

  return [pathCanvas, boxStartCanvas, arrowHeadCanvas, cornersCanvas, labelCanvas]
}

/**
 * Draw the path lines for an edge.
 * Returns the canvas, the coordinates drawn for each segment, and the direction of each segment.
 */
function drawPath(
  graph: AsciiGraph,
  path: GridCoord[],
): [Canvas, DrawingCoord[][], Direction[]] {
  const canvas = copyCanvas(graph.canvas)
  let previousCoord = path[0]!
  const linesDrawn: DrawingCoord[][] = []
  const lineDirs: Direction[] = []

  for (let i = 1; i < path.length; i++) {
    const nextCoord = path[i]!
    const prevDC = gridToDrawingCoord(graph, previousCoord)
    const nextDC = gridToDrawingCoord(graph, nextCoord)

    if (drawingCoordEquals(prevDC, nextDC)) {
      previousCoord = nextCoord
      continue
    }

    const dir = determineDirection(previousCoord, nextCoord)
    const segment = drawLine(canvas, prevDC, nextDC, 1, -1, graph.config.useAscii)
    if (segment.length === 0) segment.push(prevDC)
    linesDrawn.push(segment)
    lineDirs.push(dir)
    previousCoord = nextCoord
  }

  return [canvas, linesDrawn, lineDirs]
}

/**
 * Draw the junction character where an edge exits the source node's box.
 * Only applies to Unicode mode (ASCII mode just uses the line characters).
 */
function drawBoxStart(
  graph: AsciiGraph,
  path: GridCoord[],
  firstLine: DrawingCoord[],
): Canvas {
  const canvas = copyCanvas(graph.canvas)
  if (graph.config.useAscii) return canvas

  const from = firstLine[0]!
  const dir = determineDirection(path[0]!, path[1]!)

  if (dirEquals(dir, Up)) canvas[from.x]![from.y + 1] = '┴'
  else if (dirEquals(dir, Down)) canvas[from.x]![from.y - 1] = '┬'
  else if (dirEquals(dir, Left)) canvas[from.x + 1]![from.y] = '┤'
  else if (dirEquals(dir, Right)) canvas[from.x - 1]![from.y] = '├'

  return canvas
}

/**
 * Draw the arrowhead at the end of an edge path.
 * Uses triangular Unicode symbols (▲▼◄►) or ASCII symbols (^v<>).
 */
function drawArrowHead(
  graph: AsciiGraph,
  lastLine: DrawingCoord[],
  fallbackDir: Direction,
): Canvas {
  const canvas = copyCanvas(graph.canvas)
  if (lastLine.length === 0) return canvas

  const from = lastLine[0]!
  const lastPos = lastLine[lastLine.length - 1]!
  let dir = determineDirection(from, lastPos)
  if (lastLine.length === 1 || dirEquals(dir, Middle)) dir = fallbackDir

  let char: string

  if (!graph.config.useAscii) {
    if (dirEquals(dir, Up)) char = '▲'
    else if (dirEquals(dir, Down)) char = '▼'
    else if (dirEquals(dir, Left)) char = '◄'
    else if (dirEquals(dir, Right)) char = '►'
    else if (dirEquals(dir, UpperRight)) char = '◥'
    else if (dirEquals(dir, UpperLeft)) char = '◤'
    else if (dirEquals(dir, LowerRight)) char = '◢'
    else if (dirEquals(dir, LowerLeft)) char = '◣'
    else {
      // Fallback
      if (dirEquals(fallbackDir, Up)) char = '▲'
      else if (dirEquals(fallbackDir, Down)) char = '▼'
      else if (dirEquals(fallbackDir, Left)) char = '◄'
      else if (dirEquals(fallbackDir, Right)) char = '►'
      else if (dirEquals(fallbackDir, UpperRight)) char = '◥'
      else if (dirEquals(fallbackDir, UpperLeft)) char = '◤'
      else if (dirEquals(fallbackDir, LowerRight)) char = '◢'
      else if (dirEquals(fallbackDir, LowerLeft)) char = '◣'
      else char = '●'
    }
  } else {
    if (dirEquals(dir, Up)) char = '^'
    else if (dirEquals(dir, Down)) char = 'v'
    else if (dirEquals(dir, Left)) char = '<'
    else if (dirEquals(dir, Right)) char = '>'
    else {
      if (dirEquals(fallbackDir, Up)) char = '^'
      else if (dirEquals(fallbackDir, Down)) char = 'v'
      else if (dirEquals(fallbackDir, Left)) char = '<'
      else if (dirEquals(fallbackDir, Right)) char = '>'
      else char = '*'
    }
  }

  canvas[lastPos.x]![lastPos.y] = char
  return canvas
}

/**
 * Draw corner characters at path bends (where the direction changes).
 * Uses ┌┐└┘ in Unicode mode, + in ASCII mode.
 */
function drawCorners(graph: AsciiGraph, path: GridCoord[]): Canvas {
  const canvas = copyCanvas(graph.canvas)

  for (let idx = 1; idx < path.length - 1; idx++) {
    const coord = path[idx]!
    const dc = gridToDrawingCoord(graph, coord)
    const prevDir = determineDirection(path[idx - 1]!, coord)
    const nextDir = determineDirection(coord, path[idx + 1]!)

    let corner: string
    if (!graph.config.useAscii) {
      if ((dirEquals(prevDir, Right) && dirEquals(nextDir, Down)) ||
          (dirEquals(prevDir, Up) && dirEquals(nextDir, Left))) {
        corner = '┐'
      } else if ((dirEquals(prevDir, Right) && dirEquals(nextDir, Up)) ||
                 (dirEquals(prevDir, Down) && dirEquals(nextDir, Left))) {
        corner = '┘'
      } else if ((dirEquals(prevDir, Left) && dirEquals(nextDir, Down)) ||
                 (dirEquals(prevDir, Up) && dirEquals(nextDir, Right))) {
        corner = '┌'
      } else if ((dirEquals(prevDir, Left) && dirEquals(nextDir, Up)) ||
                 (dirEquals(prevDir, Down) && dirEquals(nextDir, Right))) {
        corner = '└'
      } else {
        corner = '+'
      }
    } else {
      corner = '+'
    }

    canvas[dc.x]![dc.y] = corner
  }

  return canvas
}

/** Draw edge label text centered on the widest path segment. */
function drawArrowLabel(graph: AsciiGraph, edge: AsciiEdge, baseCanvasForAvoid?: Canvas): Canvas {
  const canvas = copyCanvas(graph.canvas)
  if (edge.text.length === 0) return canvas

  const drawingLine = lineToDrawing(graph, edge.labelLine)
  // 重要：label 不能覆盖 arrowhead，否则：
  // - 人读图会误判方向（看起来像是另一条边的箭头）
  // - 反向解析会直接丢边（箭头被覆盖就找不到 target）
  //
  // 因此这里把“本边的箭头格子”当作禁用点，label 会尽量避开它。
  const avoid: DrawingCoord[] = []
  const arrowHeadPos = computeArrowHeadPosForLabelAvoid(graph, edge)
  if (arrowHeadPos) avoid.push(arrowHeadPos)

  // 同理：label 也不应该覆盖 source box 的“出边标记”（drawBoxStart 写入的 ├/┤/┬/┴）。
  // 否则反向解析在追溯 source 时会找不到 marker，导致整条边被丢掉。
  const boxStartPos = computeBoxStartPosForLabelAvoid(graph, edge)
  if (boxStartPos) avoid.push(boxStartPos)

  drawTextOnLine(canvas, drawingLine, edge.text, avoid, baseCanvasForAvoid, graph.config.useAscii)
  return canvas
}

// ============================================================================
// Label placement avoidance
//
// 用户新规则：
// - “线交错/分叉/拐点处，不要出现线上文字（edge label）”
//
// 这里的“交错处”不仅包含 `┼/┬/┴/├/┤/┌/┐/└/┘` 这类 junction/corner，
// 也包含“桥式交叉”的关键格（上下是 `│`，中间被保留为 `─` 的那一格）。
//
// 关键点：
// - label 是最后一层，默认会覆盖底层字符。
// - 如果 label 覆盖了 junction 字符，会把“通路语义”直接遮掉，人就会迷路。
// - 因此我们需要在绘制 label 时“看见线路层”，避开这些格子。
// ============================================================================

function isUnicodeArrowChar(c: string): boolean {
  return c === '▲' || c === '▼' || c === '◄' || c === '►' ||
    c === '◥' || c === '◤' || c === '◢' || c === '◣' || c === '●'
}

function isAsciiArrowChar(c: string): boolean {
  return c === '^' || c === 'v' || c === '<' || c === '>' || c === '*'
}

function isUnicodeJunctionOrCorner(c: string): boolean {
  // 注意：不要把普通线段（`─/│`）也算进去，否则 label 永远放不下。
  return c === '┼' || c === '┬' || c === '┴' || c === '├' || c === '┤' ||
    c === '┌' || c === '┐' || c === '└' || c === '┘' ||
    c === '╴' || c === '╵' || c === '╶' || c === '╷'
}

function isAsciiJunctionOrCorner(c: string): boolean {
  // ASCII 下，`+` 同时承担 corner/junction 的语义。
  return c === '+'
}

function charHasVerticalStroke(c: string, useAscii: boolean): boolean {
  if (useAscii) return c === '|' || c === '+'
  return c === '│' || c === '┼' || c === '┬' || c === '┴' || c === '├' || c === '┤' ||
    c === '┌' || c === '┐' || c === '└' || c === '┘' ||
    c === '╷' || c === '╵'
}

function charHasHorizontalStroke(c: string, useAscii: boolean): boolean {
  if (useAscii) return c === '-' || c === '+'
  return c === '─' || c === '┼' || c === '┬' || c === '┴' || c === '├' || c === '┤' ||
    c === '┌' || c === '┐' || c === '└' || c === '┘' ||
    c === '╴' || c === '╶'
}

function isBridgeCrossingCell(base: Canvas, x: number, y: number, useAscii: boolean): boolean {
  const [maxX, maxY] = getCanvasSize(base)
  if (x < 0 || y < 0 || x > maxX || y > maxY) return false

  const here = base[x]![y]!
  const left = x > 0 ? base[x - 1]![y]! : ' '
  const right = x < maxX ? base[x + 1]![y]! : ' '
  const up = y > 0 ? base[x]![y - 1]! : ' '
  const down = y < maxY ? base[x]![y + 1]! : ' '

  const verticalAround = charHasVerticalStroke(up, useAscii) && charHasVerticalStroke(down, useAscii)
  const horizontalAround = charHasHorizontalStroke(left, useAscii) && charHasHorizontalStroke(right, useAscii)

  // “桥式交叉”常见形态：
  // - 当前格保留水平（`─`），上下是 `│`（但不会在当前格连通）
  // - 或当前格留空（极端情况下），上下仍是 `│`
  if ((here === ' ' || charHasHorizontalStroke(here, useAscii)) && verticalAround) return true
  if ((here === ' ' || charHasVerticalStroke(here, useAscii)) && horizontalAround) return true

  return false
}

function isForbiddenLabelCell(base: Canvas, x: number, y: number, useAscii: boolean): boolean {
  const [maxX, maxY] = getCanvasSize(base)
  if (x < 0 || y < 0 || x > maxX || y > maxY) return false

  const c = base[x]![y]!
  if (useAscii) {
    if (isAsciiArrowChar(c)) return true
    if (isAsciiJunctionOrCorner(c)) return true
  } else {
    if (isUnicodeArrowChar(c)) return true
    if (isUnicodeJunctionOrCorner(c)) return true
  }

  // 额外：桥式交叉点也禁止覆盖（否则会把“断开”遮成“连通”）
  if (isBridgeCrossingCell(base, x, y, useAscii)) return true

  return false
}

function intervalOverlapsAvoidPoints(
  y: number,
  startX: number,
  endX: number,
  avoid: DrawingCoord[],
): boolean {
  for (const p of avoid) {
    if (p.y !== y) continue
    if (p.x >= startX && p.x <= endX) return true
  }
  return false
}

function intervalOverlapsForbiddenCells(
  base: Canvas,
  y: number,
  startX: number,
  endX: number,
  useAscii: boolean,
): boolean {
  for (let x = startX; x <= endX; x++) {
    if (isForbiddenLabelCell(base, x, y, useAscii)) return true
  }
  return false
}

function findNearestValidStartX(params: {
  desiredStartX: number
  minStartX: number
  maxStartX: number
  isValid: (startX: number) => boolean
}): number {
  const { desiredStartX, minStartX, maxStartX, isValid } = params

  if (isValid(desiredStartX)) return desiredStartX

  const maxDelta = Math.max(0, maxStartX - minStartX)
  for (let delta = 1; delta <= maxDelta; delta++) {
    const left = desiredStartX - delta
    if (left >= minStartX && isValid(left)) return left

    const right = desiredStartX + delta
    if (right <= maxStartX && isValid(right)) return right
  }

  // 实在找不到：保持原位置（宁可覆盖，也不让 label 消失）
  return desiredStartX
}

/** Draw text centered on a line segment defined by two drawing coordinates. */
function drawTextOnLine(
  canvas: Canvas,
  line: DrawingCoord[],
  label: string,
  avoid: DrawingCoord[] = [],
  baseCanvasForAvoid?: Canvas,
  useAsciiForAvoid: boolean = false,
): void {
  if (line.length < 2) return
  const minX = Math.min(line[0]!.x, line[1]!.x)
  const maxX = Math.max(line[0]!.x, line[1]!.x)
  const minY = Math.min(line[0]!.y, line[1]!.y)
  const maxY = Math.max(line[0]!.y, line[1]!.y)
  const middleX = minX + Math.floor((maxX - minX) / 2)
  const middleY = minY + Math.floor((maxY - minY) / 2)
  const labelWidth = textDisplayWidth(label)

  // 默认策略：居中。
  // 注意：vertical line 的 label 也是“横向写字”，因此这里依旧用 X 轴做居中。
  let startX = middleX - Math.floor(labelWidth / 2)

  // -------------------------------------------------------------------------
  // label 避让策略（用户规则优先）
  //
  // 需求：
  // - 交错/分叉/拐点处不要出现线上文字（避免遮挡 `┼/┬/┴/...` 等关键符号）。
  //
  // 实现取舍：
  // - 当我们有 baseCanvas（线路层已合成）时，以 baseCanvas 的“真实字符”做判定，最可靠。
  // - 当没有 baseCanvas 时（例如 drawArrow 里早期生成的 label layer，仅用于占位），
  //   只做最小避让（避免覆盖显式 avoid 点），以减少对旧输出的影响。
  // -------------------------------------------------------------------------

  // 有 baseCanvas：用“最近可行解”搜索 startX，避免覆盖 junction/cross/arrow 等关键格子。
  if (baseCanvasForAvoid) {
    const [canvasMaxX] = getCanvasSize(baseCanvasForAvoid)
    const globalMinStart = 0
    const globalMaxStart = Math.max(globalMinStart, canvasMaxX - labelWidth + 1)

    const isHorizontal = line[0]!.y === line[1]!.y
    const segmentMinStart = minX
    const segmentMaxStart = maxX - labelWidth + 1

    // 水平线段且“能放下”：优先把搜索范围限制在该线段内部，保持 label 贴着这段线。
    // 否则：退化到全画布范围（label 可以稍微漂移，但至少不会遮挡关键 junction）。
    const searchMin = (isHorizontal && segmentMaxStart >= segmentMinStart)
      ? Math.max(globalMinStart, segmentMinStart)
      : globalMinStart
    const searchMax = (isHorizontal && segmentMaxStart >= segmentMinStart)
      ? Math.min(globalMaxStart, segmentMaxStart)
      : globalMaxStart

    if (searchMax >= searchMin) {
      // clamp 到搜索区间
      if (startX < searchMin) startX = searchMin
      if (startX > searchMax) startX = searchMax

      startX = findNearestValidStartX({
        desiredStartX: startX,
        minStartX: searchMin,
        maxStartX: searchMax,
        isValid: (candidate) => {
          const endX = candidate + labelWidth - 1
          if (intervalOverlapsAvoidPoints(middleY, candidate, endX, avoid)) return false
          if (intervalOverlapsForbiddenCells(baseCanvasForAvoid, middleY, candidate, endX, useAsciiForAvoid)) return false
          return true
        },
      })
    }

    drawText(canvas, { x: startX, y: middleY }, label)
    return
  }

  // -------------------------------------------------------------------------
  // 无 baseCanvas：保持旧行为（仅对水平线段做最小避让）
  //
  // 目的：
  // - 减少对历史 golden 的影响
  // - 也避免在“没有线路信息”的情况下做过度猜测
  // -------------------------------------------------------------------------

  // 仅对“水平线段”做避让：
  // - 这能解决用户示例中的核心歧义：label 覆盖箭头导致方向读错。
  // - 同时避免改动 vertical line 的既有表现（减少 golden 变化）。
  const isHorizontal = line[0]!.y === line[1]!.y
  if (isHorizontal) {
    const minStart = minX
    const maxStart = maxX - labelWidth + 1

    if (maxStart >= minStart) {
      // 先把 startX clamp 到线段范围内，避免负坐标/越界导致写入崩溃。
      if (startX < minStart) startX = minStart
      if (startX > maxStart) startX = maxStart

      for (const p of avoid) {
        if (p.y !== middleY) continue

        const endX = startX + labelWidth - 1
        const overlaps = p.x >= startX && p.x <= endX
        if (!overlaps) continue

        // 两个候选：把 label 整体移到“箭头左侧”或“箭头右侧”，选更接近当前的位置。
        const candidateLeft = p.x - labelWidth
        const candidateRight = p.x + 1

        const candidates: number[] = []
        if (candidateLeft >= minStart && candidateLeft <= maxStart) candidates.push(candidateLeft)
        if (candidateRight >= minStart && candidateRight <= maxStart) candidates.push(candidateRight)

        if (candidates.length === 0) {
          // 线段空间不足：只能接受覆盖（但这种情况会非常少见）
          continue
        }

        candidates.sort((a, b) => Math.abs(a - startX) - Math.abs(b - startX))
        startX = candidates[0]!
      }
    }
  }

  drawText(canvas, { x: startX, y: middleY }, label)
}

function computeArrowHeadPosForLabelAvoid(graph: AsciiGraph, edge: AsciiEdge): DrawingCoord | null {
  if (edge.path.length < 2) return null

  const last = edge.path[edge.path.length - 1]!
  const prev = edge.path[edge.path.length - 2]!
  const dir = determineDirection(prev, last)
  const target = gridToDrawingCoord(graph, last)

  // drawArrowHead 会把箭头画在“目标格子前 1 格”（避免覆盖 box 边框）。
  if (dirEquals(dir, Up)) return { x: target.x, y: target.y + 1 }
  if (dirEquals(dir, Down)) return { x: target.x, y: target.y - 1 }
  if (dirEquals(dir, Left)) return { x: target.x + 1, y: target.y }
  if (dirEquals(dir, Right)) return { x: target.x - 1, y: target.y }

  return null
}

function computeBoxStartPosForLabelAvoid(graph: AsciiGraph, edge: AsciiEdge): DrawingCoord | null {
  if (edge.path.length < 2) return null
  // drawBoxStart 的 marker 最终会落在 edge.path[0] 对应的 box 边界点上。
  return gridToDrawingCoord(graph, edge.path[0]!)
}

// ============================================================================
// Subgraph drawing
// ============================================================================

/** Draw a subgraph border rectangle. */
export function drawSubgraphBox(sg: AsciiSubgraph, graph: AsciiGraph): Canvas {
  const width = sg.maxX - sg.minX
  const height = sg.maxY - sg.minY
  if (width <= 0 || height <= 0) return mkCanvas(0, 0)

  const from: DrawingCoord = { x: 0, y: 0 }
  const to: DrawingCoord = { x: width, y: height }
  const canvas = mkCanvas(width, height)

  if (!graph.config.useAscii) {
    for (let x = from.x + 1; x < to.x; x++) canvas[x]![from.y] = '─'
    for (let x = from.x + 1; x < to.x; x++) canvas[x]![to.y] = '─'
    for (let y = from.y + 1; y < to.y; y++) canvas[from.x]![y] = '│'
    for (let y = from.y + 1; y < to.y; y++) canvas[to.x]![y] = '│'
    canvas[from.x]![from.y] = '┌'
    canvas[to.x]![from.y] = '┐'
    canvas[from.x]![to.y] = '└'
    canvas[to.x]![to.y] = '┘'
  } else {
    for (let x = from.x + 1; x < to.x; x++) canvas[x]![from.y] = '-'
    for (let x = from.x + 1; x < to.x; x++) canvas[x]![to.y] = '-'
    for (let y = from.y + 1; y < to.y; y++) canvas[from.x]![y] = '|'
    for (let y = from.y + 1; y < to.y; y++) canvas[to.x]![y] = '|'
    canvas[from.x]![from.y] = '+'
    canvas[to.x]![from.y] = '+'
    canvas[from.x]![to.y] = '+'
    canvas[to.x]![to.y] = '+'
  }

  return canvas
}

/** Draw a subgraph label centered in its header area. */
export function drawSubgraphLabel(sg: AsciiSubgraph, graph: AsciiGraph): [Canvas, DrawingCoord] {
  const width = sg.maxX - sg.minX
  const height = sg.maxY - sg.minY
  if (width <= 0 || height <= 0) return [mkCanvas(0, 0), { x: 0, y: 0 }]

  const canvas = mkCanvas(width, height)
  const labelY = 1 // second row inside the subgraph box
  let labelX = Math.floor(width / 2) - Math.floor(textDisplayWidth(sg.name) / 2)
  if (labelX < 1) labelX = 1

  drawText(canvas, { x: labelX, y: labelY }, sg.name)

  return [canvas, { x: sg.minX, y: sg.minY }]
}

// ============================================================================
// Top-level draw orchestrator
// ============================================================================

/** Sort subgraphs by nesting depth (shallowest first) for correct layered rendering. */
function sortSubgraphsByDepth(subgraphs: AsciiSubgraph[]): AsciiSubgraph[] {
  function getDepth(sg: AsciiSubgraph): number {
    return sg.parent === null ? 0 : 1 + getDepth(sg.parent)
  }
  const sorted = [...subgraphs]
  sorted.sort((a, b) => getDepth(a) - getDepth(b))
  return sorted
}

/**
 * Main draw function — renders the entire graph onto the canvas.
 * Drawing order matters for correct layering:
 * 1. Subgraph borders (bottom layer)
 * 2. Node boxes
 * 3. Edge paths (lines)
 * 4. Edge corners
 * 5. Arrowheads
 * 6. Box-start junctions
 * 7. Edge labels
 * 8. Subgraph labels (top layer)
 */
export function drawGraph(graph: AsciiGraph): Canvas {
  const useAscii = graph.config.useAscii

  // Draw subgraph borders
  const sortedSgs = sortSubgraphsByDepth(graph.subgraphs)
  for (const sg of sortedSgs) {
    const sgCanvas = drawSubgraphBox(sg, graph)
    const offset: DrawingCoord = { x: sg.minX, y: sg.minY }
    graph.canvas = mergeCanvases(graph.canvas, offset, useAscii, sgCanvas)
  }

  // Draw node boxes
  for (const node of graph.nodes) {
    if (!node.drawn && node.drawingCoord && node.drawing) {
      graph.canvas = mergeCanvases(graph.canvas, node.drawingCoord, useAscii, node.drawing)
      node.drawn = true
    }
  }

  // Collect all edge drawing layers
  const lineCanvases: Canvas[] = []
  const cornerCanvases: Canvas[] = []
  const arrowHeadCanvases: Canvas[] = []
  const boxStartCanvases: Canvas[] = []

  for (const edge of graph.edges) {
    const [pathC, boxStartC, arrowHeadC, cornersC, labelC] = drawArrow(graph, edge)
    lineCanvases.push(pathC)
    cornerCanvases.push(cornersC)
    arrowHeadCanvases.push(arrowHeadC)
    boxStartCanvases.push(boxStartC)
  }

  // Merge edge layers in order
  const zero: DrawingCoord = { x: 0, y: 0 }
  graph.canvas = mergeCanvases(graph.canvas, zero, useAscii, ...lineCanvases)
  graph.canvas = mergeCanvases(graph.canvas, zero, useAscii, ...cornerCanvases)
  graph.canvas = mergeCanvases(graph.canvas, zero, useAscii, ...arrowHeadCanvases)
  graph.canvas = mergeCanvases(graph.canvas, zero, useAscii, ...boxStartCanvases)

  // 重要：label 必须在“线路层”之后绘制。
  //
  // 原因：
  // - label 是最上层，如果先生成 label layer，再合并线路层，
  //   label 无法知道哪里存在 `┼/┬/┴/...`，就会把这些关键符号盖掉（用户反馈：看不懂路线）。
  //
  // 做法：
  // - 先把 line/corner/arrowhead/boxStart 合成到 graph.canvas（作为 baseCanvas）
  // - 再逐 edge 生成 label layer，并用 baseCanvas 做避让（禁止写在交错处）
  const labelCanvases: Canvas[] = []
  const baseCanvasForAvoid = graph.canvas
  for (const edge of graph.edges) {
    labelCanvases.push(drawArrowLabel(graph, edge, baseCanvasForAvoid))
  }
  graph.canvas = mergeCanvases(graph.canvas, zero, useAscii, ...labelCanvases)

  // Draw subgraph labels last (on top)
  for (const sg of graph.subgraphs) {
    if (sg.nodes.length === 0) continue
    const [labelCanvas, offset] = drawSubgraphLabel(sg, graph)
    graph.canvas = mergeCanvases(graph.canvas, offset, useAscii, labelCanvas)
  }

  return graph.canvas
}
