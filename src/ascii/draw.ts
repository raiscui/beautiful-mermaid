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
import { mkCanvas, copyCanvas, getCanvasSize, increaseSize, mergeCanvases, drawText, textDisplayWidth } from './canvas.ts'
import { determineDirection, dirEquals } from './edge-routing.ts'

// ============================================================================
// Comb ports（梳子口端口）—— lane-aware 坐标映射
//
// 背景：
// - grid A* 仍然只知道 3x3 block 的“粗端口”（Up/Down/Left/Right/角落）。
// - 但用户希望“沿边框多点分布”，并且“不同线不能重叠/终点不能复用”。
//
// 做法：
// - 在绘制层，把某些 grid cell 的“中心点”替换成“同一格内部的不同偏移（lane）”：
//   - Left/Right 端口：在 content row（高度可扩）内选择不同的 Y offset
//   - Up/Down 端口：在 content col（宽度可扩）内选择不同的 X offset
//
// 关键点：
// - 这不会影响 grid A* 的路径搜索（也不需要改 Rust native pathfinder）。
// - 但绘制出来的线会从不同的边框点出入，形成“梳子口”效果。
// ============================================================================

function gridToDrawingCoordForEdge(graph: AsciiGraph, edge: AsciiEdge, c: GridCoord): DrawingCoord {
  // 注意：这里不要直接复用 grid.ts 的 gridToDrawingCoord：
  // - 我们需要拿到 cell origin（非居中）来应用 offset；
  // - 同时保持与 gridToDrawingCoord 相同的 offsetX/offsetY 语义。
  let xOrigin = 0
  if (graph.columnStartX && c.x >= 0 && c.x < graph.columnStartX.length) {
    xOrigin = graph.columnStartX[c.x] ?? 0
  } else {
    for (let col = 0; col < c.x; col++) xOrigin += graph.columnWidth.get(col) ?? 0
  }

  let yOrigin = 0
  if (graph.rowStartY && c.y >= 0 && c.y < graph.rowStartY.length) {
    yOrigin = graph.rowStartY[c.y] ?? 0
  } else {
    for (let row = 0; row < c.y; row++) yOrigin += graph.rowHeight.get(row) ?? 0
  }

  const colW = graph.columnWidth.get(c.x) ?? 0
  const rowH = graph.rowHeight.get(c.y) ?? 0

  // 默认：cell center
  let xOffset = Math.floor(colW / 2)
  let yOffset = Math.floor(rowH / 2)

  // comb ports：用 edge 上记录的端口 offset 覆盖掉对应 row/col 的 center
  //
  // 说明：
  // - startPortOffsetX/Y 与 endPortOffsetX/Y 都是 0-based offset；
  // - 我们只把 offset 应用到“首段/末段”的两个端点:
  //   - 这样可以保证出线/入线的第一段/最后一段仍是严格水平/垂直(不会画出对角线);
  //   - 同时避免把 offset 误应用到整条 row/col 上,导致其它线段被整体平移(你之前看到的 box 内横线就是这个原因)。
  //
  // 注意:
  // - edge.path 经过 merge 后是折线关键点序列(不是逐格路径);
  // - 因此“首段/末段”的端点分别是 [0],[1] 与 [n-2],[n-1]。
  if (edge.path.length >= 2) {
    const start0 = edge.path[0]!
    const start1 = edge.path[1]!
    const end0 = edge.path[edge.path.length - 1]!
    const end1 = edge.path[edge.path.length - 2]!

    const isStartEndpoint =
      (c.x === start0.x && c.y === start0.y) || (c.x === start1.x && c.y === start1.y)
    if (isStartEndpoint) {
      const startIsVertical = start0.x === start1.x
      const startIsHorizontal = start0.y === start1.y
      if (startIsVertical && edge.startPortOffsetX != null) xOffset = edge.startPortOffsetX
      if (startIsHorizontal && edge.startPortOffsetY != null) yOffset = edge.startPortOffsetY
    }

    const isEndEndpoint =
      (c.x === end0.x && c.y === end0.y) || (c.x === end1.x && c.y === end1.y)
    if (isEndEndpoint) {
      const endIsVertical = end0.x === end1.x
      const endIsHorizontal = end0.y === end1.y
      if (endIsVertical && edge.endPortOffsetX != null) xOffset = edge.endPortOffsetX
      if (endIsHorizontal && edge.endPortOffsetY != null) yOffset = edge.endPortOffsetY
    }
  }

  // 防御：offset 不能越界（否则会写到别的 cell，导致字符画错乱）
  if (xOffset < 0) xOffset = 0
  if (yOffset < 0) yOffset = 0
  if (colW > 0 && xOffset > colW - 1) xOffset = colW - 1
  if (rowH > 0 && yOffset > rowH - 1) yOffset = rowH - 1

  return {
    x: xOrigin + xOffset + graph.offsetX,
    y: yOrigin + yOffset + graph.offsetY,
  }
}

function lineToDrawingForEdge(graph: AsciiGraph, edge: AsciiEdge, line: GridCoord[]): DrawingCoord[] {
  return line.map(c => gridToDrawingCoordForEdge(graph, edge, c))
}

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
  // -----------------------------------------------------------------------
  // 防御性: 确保画布足够大,避免写越界导致整图崩溃
  //
  // 背景(真实 crash):
  // - 在某些“绕外圈/扩 bounds”路径下,端点可能落在当前 canvas 的最外侧;
  // - drawLine 再加上 offsetFrom/offsetTo 后,就可能写到 canvas 右/下边界之外,
  //   从而触发 `canvas[x] is undefined` 这类运行时异常。
  //
  // 取舍:
  // - 这里选择“自动扩容”而不是直接跳过绘制:
  //   - 跳过会造成断线/游离箭头,比多扩 1~2 格更糟;
  //   - increaseSize 是整段一次性扩,不会在每个 cell 上重复扩容(性能可控)。
  // -----------------------------------------------------------------------
  const [currMaxX, currMaxY] = getCanvasSize(canvas)
  const needMaxX = Math.max(from.x, to.x)
  const needMaxY = Math.max(from.y, to.y)
  if (needMaxX > currMaxX || needMaxY > currMaxY) {
    increaseSize(canvas, needMaxX, needMaxY)
  }

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

  const [pathCanvas, linesDrawn, lineDirs] = drawPath(graph, edge, edge.path)
  const boxStartCanvas = drawBoxStart(graph, edge)
  const arrowHeadCanvas = drawArrowHead(
    graph,
    edge,
    linesDrawn[linesDrawn.length - 1]!,
    lineDirs[lineDirs.length - 1]!,
  )
  const cornersCanvas = drawCorners(graph, edge, edge.path)

  // 性能优化:
  // - `drawGraph()` 会在合成线路层之后,再统一生成 label layer 并做避让;
  // - 因此 `drawArrow()` 里提前生成 labelCanvas 已经没有实际用途(也不会被合成);
  // - 这里返回空 canvas,避免每条边额外的 canvas 拷贝与 label 布局计算。
  const labelCanvas = mkCanvas(0, 0)

  return [pathCanvas, boxStartCanvas, arrowHeadCanvas, cornersCanvas, labelCanvas]
}

// ============================================================================
// Edge corner coords — used to keep Unicode "bridge" from breaking real turns
// ============================================================================

/**
 * 计算一条边的“拐点坐标”（只包含方向变化处的 corner cell）。
 *
 * 用途：
 * - Unicode 输出会在最后做一次 “┼ → 桥(─/│)” 的去歧义；
 * - 但如果某个 `┼` 恰好落在某条边的拐点上，桥化会把这条边直接“断开”，
 *   用户看到的就是“断线/绕路/箭头游离”。
 *
 * 因此这里把“拐点坐标”单独暴露出去，给桥化逻辑做保护名单：
 * - 交叉处仍然尽量桥化（避免误读为连接）；
 * - 但拐点处必须保持连通（不能桥化）。
 */
export function computeEdgeCornerCoords(graph: AsciiGraph, edge: AsciiEdge): DrawingCoord[] {
  const out: DrawingCoord[] = []
  const seen = new Set<string>()

  function pushUnique(c: DrawingCoord): void {
    const key = `${c.x},${c.y}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(c)
  }

  if (edge.path.length < 3) return out

  for (let i = 1; i < edge.path.length - 1; i++) {
    const prev = edge.path[i - 1]!
    const curr = edge.path[i]!
    const next = edge.path[i + 1]!

    const prevDir = determineDirection(prev, curr)
    const nextDir = determineDirection(curr, next)
    if (dirEquals(prevDir, nextDir) || dirEquals(prevDir, Middle) || dirEquals(nextDir, Middle)) continue

    pushUnique(gridToDrawingCoordForEdge(graph, edge, curr))
  }

  return out
}

/**
 * 计算一条边的“拐点连通掩码”(每个拐点需要保留哪些方向的连通)。
 *
 * 说明:
 * - 这是给 `deambiguateUnicodeCrossings()` 用的:
 *   当 `┼` 恰好落在拐点上时,我们希望把它降级成 `┐/┘/┌/└/┬/┴/├/┤` 等,
 *   以保留这条边的真实连通,同时把“穿过的那条线”桥化(断开)。
 */
export function computeEdgeCornerArmMasks(graph: AsciiGraph, edge: AsciiEdge): Map<string, number> {
  // bitmask:
  // - 1: left, 2: right, 4: up, 8: down
  const LEFT_MASK = 1
  const RIGHT_MASK = 2
  const UP_MASK = 4
  const DOWN_MASK = 8

  const out = new Map<string, number>()

  if (edge.path.length < 3) return out

  function incomingArmMask(dir: Direction): number {
    // prev -> curr 的运动方向,对应 curr 处的“入边”连通方向。
    if (dirEquals(dir, Up)) return DOWN_MASK
    if (dirEquals(dir, Down)) return UP_MASK
    if (dirEquals(dir, Left)) return RIGHT_MASK
    if (dirEquals(dir, Right)) return LEFT_MASK
    return 0
  }

  function outgoingArmMask(dir: Direction): number {
    // curr -> next 的运动方向,对应 curr 处的“出边”连通方向。
    if (dirEquals(dir, Up)) return UP_MASK
    if (dirEquals(dir, Down)) return DOWN_MASK
    if (dirEquals(dir, Left)) return LEFT_MASK
    if (dirEquals(dir, Right)) return RIGHT_MASK
    return 0
  }

  for (let i = 1; i < edge.path.length - 1; i++) {
    const prev = edge.path[i - 1]!
    const curr = edge.path[i]!
    const next = edge.path[i + 1]!

    const prevDir = determineDirection(prev, curr)
    const nextDir = determineDirection(curr, next)
    if (dirEquals(prevDir, nextDir) || dirEquals(prevDir, Middle) || dirEquals(nextDir, Middle)) continue

    const dc = gridToDrawingCoordForEdge(graph, edge, curr)
    const key = `${dc.x},${dc.y}`

    const mask = incomingArmMask(prevDir) | outgoingArmMask(nextDir)
    if (mask === 0) continue

    out.set(key, (out.get(key) ?? 0) | mask)
  }

  return out
}

/**
 * 计算一条边的“笔画坐标”（有序 DrawingCoord 列表）。
 *
 * 这个函数的存在理由：
 * - UI 使用方（例如 TUI）需要“稳定的 cell 级坐标”来做高亮/动画，
 *   不应依赖对最终字符画再做二次解析（太脆弱）。
 * - ASCII 渲染器本来就知道路由后的 path；这里把它暴露成可消费的 cell 坐标列表，
 *   适合做 source → target 的逐格 reveal。
 *
 * 说明：
 * - 返回的 path 会尽量覆盖“读图关键点”，包含：
 *   - Unicode box-start marker（┤/├/┬/┴；仅 Unicode 模式）
 *   - 线段（与 drawPath/drawLine 一致的 offset 规则）
 *   - 拐角（方向变化处的 corner cell）
 *   - 箭头（▲▼◄► / ^v<>）
 * - 会在保持顺序的前提下去重。
 */
export function computeEdgeStrokeCoords(graph: AsciiGraph, edge: AsciiEdge): DrawingCoord[] {
  const out: DrawingCoord[] = []
  const seen = new Set<string>()

  function pushUnique(c: DrawingCoord): void {
    const key = `${c.x},${c.y}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(c)
  }

  // 把一个坐标“稳定地放到尾部”(用于 arrowPos)。
  //
  // 背景:
  // - 由于 columnWidth/rowHeight 的伸缩,末段 line segment 可能在 pushUnique 阶段就经过 arrowPos;
  // - 但箭头是 drawArrowHead 最后写入的关键格子,消费方也默认把 path.last() 当成 arrow cell。
  //
  // 这里对 arrowPos 做一个特殊处理:
  // - 若之前已出现过,就把旧位置移除并重新 push 到尾部;
  // - 保持“去重”同时保证“箭头永远在末尾”。
  function pushUniqueLast(c: DrawingCoord): void {
    const key = `${c.x},${c.y}`
    if (!seen.has(key)) {
      seen.add(key)
      out.push(c)
      return
    }

    for (let i = 0; i < out.length; i++) {
      const p = out[i]!
      if (p.x === c.x && p.y === c.y) {
        out.splice(i, 1)
        break
      }
    }

    out.push(c)
  }

  if (edge.path.length < 2) return out

  // Unicode mode: include the source box-start marker cell (drawBoxStart writes here).
  if (!graph.config.useAscii) {
    const sourceFallback = gridToDrawingCoordForEdge(graph, edge, edge.path[0]!)
    const sourceDir = determineDirection(edge.path[0]!, edge.path[1]!)
    const sourceMarker = computeBoxStartPositionNearSourceBox(edge, sourceDir, sourceFallback)

    if (
      (dirEquals(sourceDir, Left) || dirEquals(sourceDir, Right)) &&
      sourceMarker.y === sourceFallback.y
    ) {
      const startX = Math.min(sourceMarker.x, sourceFallback.x)
      const endX = Math.max(sourceMarker.x, sourceFallback.x)
      for (let x = startX; x <= endX; x++) {
        pushUnique({ x, y: sourceFallback.y })
      }
    } else if (
      (dirEquals(sourceDir, Up) || dirEquals(sourceDir, Down)) &&
      sourceMarker.x === sourceFallback.x
    ) {
      const startY = Math.min(sourceMarker.y, sourceFallback.y)
      const endY = Math.max(sourceMarker.y, sourceFallback.y)
      for (let y = startY; y <= endY; y++) {
        pushUnique({ x: sourceFallback.x, y })
      }
    }

    pushUnique(sourceMarker)
  }

  // Reproduce drawPath/drawLine traversal (offsetFrom=1, offsetTo=-1) without mutating a canvas.
  const offsetFrom = 1
  const offsetTo = -1

  // ---------------------------------------------------------------------------
  // 与 drawArrowHead 对齐: 记录末段 drawLine 的 from/lastPos 与 fallbackDir
  //
  // 背景:
  // - drawPath 使用 offsetFrom/offsetTo 来避免线段侵入 node box。
  // - 当某个 grid 段在 drawing 维度被“压扁”(drawLine 画不出任何 cell)时,
  //   drawPath 会把该段的 lastLine 退化成 [prevDC],并在 drawArrowHead 里用 fallbackDir 决定箭头方向。
  // - 如果 meta 仍然用 edge.path 的最后两个 grid 点推断 dir,
  //   就会出现“实际箭头已贴边,但 meta.last 仍停在 box 内部”的不一致。
  //
  // 这里记录 drawPath/drawArrowHead 会用到的末段信息,让 computeEdgeStrokeCoords 的箭头坐标与实际绘制一致。
  // ---------------------------------------------------------------------------
  let lastLineFrom: DrawingCoord | null = null
  let lastLineLastPos: DrawingCoord | null = null
  let lastFallbackDir: Direction | null = null

  function computeLastLineEndpoints(fromDC: DrawingCoord, toDC: DrawingCoord, dir: Direction): [DrawingCoord, DrawingCoord] {
    // 默认退化:
    // - drawLine 没画出任何 cell 时,drawPath 会把 lastLine 视为 [fromDC]。
    // - 这会导致 determineDirection(from,lastPos) 为 Middle,从而触发 drawArrowHead 的 fallbackDir 逻辑。
    let a = fromDC
    let b = fromDC

    if (dirEquals(dir, Up)) {
      const startY = fromDC.y - offsetFrom
      const endY = toDC.y - offsetTo
      if (startY >= endY) {
        a = { x: fromDC.x, y: startY }
        b = { x: fromDC.x, y: endY }
      }
    } else if (dirEquals(dir, Down)) {
      const startY = fromDC.y + offsetFrom
      const endY = toDC.y + offsetTo
      if (startY <= endY) {
        a = { x: fromDC.x, y: startY }
        b = { x: fromDC.x, y: endY }
      }
    } else if (dirEquals(dir, Left)) {
      const startX = fromDC.x - offsetFrom
      const endX = toDC.x - offsetTo
      if (startX >= endX) {
        a = { x: startX, y: fromDC.y }
        b = { x: endX, y: fromDC.y }
      }
    } else if (dirEquals(dir, Right)) {
      const startX = fromDC.x + offsetFrom
      const endX = toDC.x + offsetTo
      if (startX <= endX) {
        a = { x: startX, y: fromDC.y }
        b = { x: endX, y: fromDC.y }
      }
    } else if (dirEquals(dir, UpperLeft)) {
      const startX = fromDC.x
      const startY = fromDC.y - offsetFrom
      const endX = toDC.x - offsetTo
      const endY = toDC.y - offsetTo
      if (startX >= endX && startY >= endY) {
        a = { x: startX, y: startY }
        b = { x: endX, y: endY }
      }
    } else if (dirEquals(dir, UpperRight)) {
      const startX = fromDC.x
      const startY = fromDC.y - offsetFrom
      const endX = toDC.x + offsetTo
      const endY = toDC.y - offsetTo
      if (startX <= endX && startY >= endY) {
        a = { x: startX, y: startY }
        b = { x: endX, y: endY }
      }
    } else if (dirEquals(dir, LowerLeft)) {
      const startX = fromDC.x
      const startY = fromDC.y + offsetFrom
      const endX = toDC.x - offsetTo
      const endY = toDC.y + offsetTo
      if (startX >= endX && startY <= endY) {
        a = { x: startX, y: startY }
        b = { x: endX, y: endY }
      }
    } else if (dirEquals(dir, LowerRight)) {
      const startX = fromDC.x
      const startY = fromDC.y + offsetFrom
      const endX = toDC.x + offsetTo
      const endY = toDC.y + offsetTo
      if (startX <= endX && startY <= endY) {
        a = { x: startX, y: startY }
        b = { x: endX, y: endY }
      }
    }

    return [a, b]
  }

  for (let i = 1; i < edge.path.length; i++) {
    const prev = edge.path[i - 1]!
    const curr = edge.path[i]!
    const prevDC = gridToDrawingCoordForEdge(graph, edge, prev)
    const currDC = gridToDrawingCoordForEdge(graph, edge, curr)

    if (drawingCoordEquals(prevDC, currDC)) continue

    const dir = determineDirection(prev, curr)
    const [segFrom, segLastPos] = computeLastLineEndpoints(prevDC, currDC, dir)
    lastLineFrom = segFrom
    lastLineLastPos = segLastPos
    lastFallbackDir = dir

    if (dirEquals(dir, Up)) {
      for (let y = prevDC.y - offsetFrom; y >= currDC.y - offsetTo; y--) {
        pushUnique({ x: prevDC.x, y })
      }
    } else if (dirEquals(dir, Down)) {
      for (let y = prevDC.y + offsetFrom; y <= currDC.y + offsetTo; y++) {
        pushUnique({ x: prevDC.x, y })
      }
    } else if (dirEquals(dir, Left)) {
      for (let x = prevDC.x - offsetFrom; x >= currDC.x - offsetTo; x--) {
        pushUnique({ x, y: prevDC.y })
      }
    } else if (dirEquals(dir, Right)) {
      for (let x = prevDC.x + offsetFrom; x <= currDC.x + offsetTo; x++) {
        pushUnique({ x, y: prevDC.y })
      }
    } else if (dirEquals(dir, UpperLeft)) {
      for (
        let x = prevDC.x, y = prevDC.y - offsetFrom;
        x >= currDC.x - offsetTo && y >= currDC.y - offsetTo;
        x--, y--
      ) {
        pushUnique({ x, y })
      }
    } else if (dirEquals(dir, UpperRight)) {
      for (
        let x = prevDC.x, y = prevDC.y - offsetFrom;
        x <= currDC.x + offsetTo && y >= currDC.y - offsetTo;
        x++, y--
      ) {
        pushUnique({ x, y })
      }
    } else if (dirEquals(dir, LowerLeft)) {
      for (
        let x = prevDC.x, y = prevDC.y + offsetFrom;
        x >= currDC.x - offsetTo && y <= currDC.y + offsetTo;
        x--, y++
      ) {
        pushUnique({ x, y })
      }
    } else if (dirEquals(dir, LowerRight)) {
      for (
        let x = prevDC.x, y = prevDC.y + offsetFrom;
        x <= currDC.x + offsetTo && y <= currDC.y + offsetTo;
        x++, y++
      ) {
        pushUnique({ x, y })
      }
    }

    // Corner cell (drawCorners writes here) — only when direction changes at this grid point.
    if (i < edge.path.length - 1) {
      const nextDir = determineDirection(curr, edge.path[i + 1]!)
      if (!dirEquals(dir, nextDir) && !dirEquals(dir, Middle) && !dirEquals(nextDir, Middle)) {
        pushUnique(gridToDrawingCoordForEdge(graph, edge, curr))
      }
    }
  }

  // Arrowhead cell (drawArrowHead writes here).
  {
    const last = edge.path[edge.path.length - 1]!
    const prev = edge.path[edge.path.length - 2]!
    const fallbackDir = lastFallbackDir ?? determineDirection(prev, last)
    const lastPos = lastLineLastPos ?? gridToDrawingCoordForEdge(graph, edge, last)
    const from = lastLineFrom ?? lastPos

    // 对齐 drawArrowHead:
    // - 先按 lastLine(from->lastPos) 推断方向;
    // - 当 lastLine 退化为单点(Middle)时,退回到 drawPath 的 fallbackDir。
    let dir = determineDirection(from, lastPos)
    if (drawingCoordEquals(from, lastPos) || dirEquals(dir, Middle)) dir = fallbackDir

    const arrowPos = computeArrowHeadPositionNearTargetBox(edge, dir, lastPos)

    // 与 drawEndpointBridge 对齐: 当 arrowPos 因 clamp 而与 lastPos 分离时,补上桥接线段。
    if ((dirEquals(dir, Left) || dirEquals(dir, Right)) && arrowPos.y === lastPos.y) {
      const startX = Math.min(arrowPos.x, lastPos.x) + 1
      const endX = Math.max(arrowPos.x, lastPos.x) - 1
      for (let x = startX; x <= endX; x++) {
        pushUnique({ x, y: lastPos.y })
      }
    } else if ((dirEquals(dir, Up) || dirEquals(dir, Down)) && arrowPos.x === lastPos.x) {
      const startY = Math.min(arrowPos.y, lastPos.y) + 1
      const endY = Math.max(arrowPos.y, lastPos.y) - 1
      for (let y = startY; y <= endY; y++) {
        pushUnique({ x: lastPos.x, y })
      }
    }

    pushUniqueLast(arrowPos)
  }

  return out
}

/**
 * Draw the path lines for an edge.
 * Returns the canvas, the coordinates drawn for each segment, and the direction of each segment.
 */
function drawPath(
  graph: AsciiGraph,
  edge: AsciiEdge,
  path: GridCoord[],
): [Canvas, DrawingCoord[][], Direction[]] {
  const canvas = copyCanvas(graph.canvas)
  let previousCoord = path[0]!
  const linesDrawn: DrawingCoord[][] = []
  const lineDirs: Direction[] = []

  for (let i = 1; i < path.length; i++) {
    const nextCoord = path[i]!
    const prevDC = gridToDrawingCoordForEdge(graph, edge, previousCoord)
    const nextDC = gridToDrawingCoordForEdge(graph, edge, nextCoord)

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
function drawBoxStart(graph: AsciiGraph, edge: AsciiEdge): Canvas {
  const canvas = copyCanvas(graph.canvas)
  if (graph.config.useAscii) return canvas
  if (edge.path.length < 2) return canvas

  const dir = determineDirection(edge.path[0]!, edge.path[1]!)
  const fallbackMarkerPos = gridToDrawingCoordForEdge(graph, edge, edge.path[0]!)
  const markerPos = computeBoxStartPositionNearSourceBox(edge, dir, fallbackMarkerPos)
  drawEndpointBridge(canvas, fallbackMarkerPos, markerPos, dir, graph.config.useAscii)

  if (dirEquals(dir, Up)) canvas[markerPos.x]![markerPos.y] = '┴'
  else if (dirEquals(dir, Down)) canvas[markerPos.x]![markerPos.y] = '┬'
  else if (dirEquals(dir, Left)) canvas[markerPos.x]![markerPos.y] = '┤'
  else if (dirEquals(dir, Right)) canvas[markerPos.x]![markerPos.y] = '├'

  return canvas
}

/**
 * Draw the arrowhead at the end of an edge path.
 * Uses triangular Unicode symbols (▲▼◄►) or ASCII symbols (^v<>).
 */
function drawArrowHead(
  graph: AsciiGraph,
  edge: AsciiEdge,
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

  const arrowPos = computeArrowHeadPositionNearTargetBox(edge, dir, lastPos)
  drawEndpointBridge(canvas, lastPos, arrowPos, dir, graph.config.useAscii)
  canvas[arrowPos.x]![arrowPos.y] = char
  return canvas
}

function computeBoxStartPositionNearSourceBox(
  edge: AsciiEdge,
  dir: Direction,
  fallbackPos: DrawingCoord,
): DrawingCoord {
  const fromCoord = edge.from.drawingCoord
  const fromDrawing = edge.from.drawing
  if (!fromCoord || !fromDrawing) return fallbackPos

  const [boxMaxX, boxMaxY] = getCanvasSize(fromDrawing)
  const boxLeft = fromCoord.x
  const boxRight = fromCoord.x + boxMaxX
  const boxTop = fromCoord.y
  const boxBottom = fromCoord.y + boxMaxY

  // source 侧是“出边口”，应当落在 box 边框上（替换边框字符为 ├/┤/┬/┴）。
  if (dirEquals(dir, Left)) return { x: boxLeft, y: clamp(fallbackPos.y, boxTop, boxBottom) }
  if (dirEquals(dir, Right)) return { x: boxRight, y: clamp(fallbackPos.y, boxTop, boxBottom) }
  if (dirEquals(dir, Up)) return { x: clamp(fallbackPos.x, boxLeft, boxRight), y: boxTop }
  if (dirEquals(dir, Down)) return { x: clamp(fallbackPos.x, boxLeft, boxRight), y: boxBottom }

  return fallbackPos
}

function computeArrowHeadPositionNearTargetBox(
  edge: AsciiEdge,
  dir: Direction,
  fallbackPos: DrawingCoord,
): DrawingCoord {
  const toCoord = edge.to.drawingCoord
  const toDrawing = edge.to.drawing
  if (!toCoord || !toDrawing) return fallbackPos

  const [boxMaxX, boxMaxY] = getCanvasSize(toDrawing)
  const boxLeft = toCoord.x
  const boxRight = toCoord.x + boxMaxX
  const boxTop = toCoord.y
  const boxBottom = toCoord.y + boxMaxY

  if (dirEquals(dir, Left)) return { x: boxRight + 1, y: clamp(fallbackPos.y, boxTop, boxBottom) }
  if (dirEquals(dir, Right)) return { x: boxLeft - 1, y: clamp(fallbackPos.y, boxTop, boxBottom) }
  if (dirEquals(dir, Up)) return { x: clamp(fallbackPos.x, boxLeft, boxRight), y: boxBottom + 1 }
  if (dirEquals(dir, Down)) return { x: clamp(fallbackPos.x, boxLeft, boxRight), y: boxTop - 1 }

  return fallbackPos
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min
  if (value > max) return max
  return value
}

function drawEndpointBridge(
  canvas: Canvas,
  from: DrawingCoord,
  to: DrawingCoord,
  dir: Direction,
  useAscii: boolean,
): void {
  // 防御性: endpoint bridge 可能把线段/marker 推到 box 外 1 格。
  // 如果目标点恰好落在画布边界,就会出现越界写入并触发运行时异常。
  //
  // 这里选择“自动扩容”:
  // - 扩容只做一次(按端点最大坐标),不会在每个 cell 上反复扩;
  // - 能确保后续 `drawBoxStart` / `drawArrowHead` 写入 marker/箭头时不崩溃。
  const needMaxX = Math.max(from.x, to.x)
  const needMaxY = Math.max(from.y, to.y)
  if (needMaxX >= 0 && needMaxY >= 0) {
    increaseSize(canvas, needMaxX, needMaxY)
  }

  const [maxX, maxY] = getCanvasSize(canvas)
  const lineChar = useAscii ? '-' : '─'
  const verticalLineChar = useAscii ? '|' : '│'

  const safeWrite = (x: number, y: number, char: string): void => {
    if (x < 0 || y < 0 || x > maxX || y > maxY) return
    canvas[x]![y] = char
  }

  const pickCornerChar = (horizontalArm: 'left' | 'right', verticalArm: 'up' | 'down'): string => {
    if (useAscii) return '+'
    if (horizontalArm === 'left' && verticalArm === 'down') return '┐'
    if (horizontalArm === 'left' && verticalArm === 'up') return '┘'
    if (horizontalArm === 'right' && verticalArm === 'down') return '┌'
    if (horizontalArm === 'right' && verticalArm === 'up') return '└'
    return '+'
  }

  const drawHorizontal = (y: number, x1: number, x2: number): void => {
    const startX = Math.min(x1, x2)
    const endX = Math.max(x1, x2)
    for (let x = startX; x <= endX; x++) safeWrite(x, y, lineChar)
  }

  const drawVertical = (x: number, y1: number, y2: number): void => {
    const startY = Math.min(y1, y2)
    const endY = Math.max(y1, y2)
    for (let y = startY; y <= endY; y++) safeWrite(x, y, verticalLineChar)
  }

  // 水平出入边: 确保最后一段仍是水平(箭头方向/box-start marker 方向一致)
  if (dirEquals(dir, Left) || dirEquals(dir, Right)) {
    if (from.y === to.y) {
      drawHorizontal(from.y, from.x, to.x)
      return
    }

    // L 型桥接: 先垂直,再水平,避免出现“箭头悬空但线在另一列”的断线。
    const corner = { x: from.x, y: to.y }
    drawVertical(from.x, from.y, corner.y)
    drawHorizontal(corner.y, corner.x, to.x)

    const verticalArm: 'up' | 'down' = from.y < corner.y ? 'up' : 'down'
    const horizontalArm: 'left' | 'right' = to.x < corner.x ? 'left' : 'right'
    safeWrite(corner.x, corner.y, pickCornerChar(horizontalArm, verticalArm))
    return
  }

  // 垂直出入边: 确保最后一段仍是垂直(箭头方向/box-start marker 方向一致)
  if (dirEquals(dir, Up) || dirEquals(dir, Down)) {
    if (from.x === to.x) {
      drawVertical(from.x, from.y, to.y)
      return
    }

    // 特例:
    // - 当 from.y === to.y 时,如果直接水平桥接到 arrowPos,
    //   箭头(▲/▼)会变成“水平线的尽头”,视觉上就是游离箭头。
    // - 这里通过插入 1 格“竖向 stem”,保证箭头入边方向一定是竖向笔画。
    if (from.y === to.y) {
      const stemY = dirEquals(dir, Down) ? to.y - 1 : to.y + 1
      const cornerFrom = { x: from.x, y: stemY }
      const cornerTo = { x: to.x, y: stemY }

      drawVertical(from.x, from.y, cornerFrom.y)
      drawHorizontal(stemY, from.x, to.x)
      drawVertical(to.x, cornerTo.y, to.y)

      const verticalArmFrom: 'up' | 'down' = from.y < cornerFrom.y ? 'up' : 'down'
      const horizontalArmFrom: 'left' | 'right' = to.x < cornerFrom.x ? 'left' : 'right'
      safeWrite(cornerFrom.x, cornerFrom.y, pickCornerChar(horizontalArmFrom, verticalArmFrom))

      const verticalArmTo: 'up' | 'down' = to.y < cornerTo.y ? 'up' : 'down'
      const horizontalArmTo: 'left' | 'right' = from.x < cornerTo.x ? 'left' : 'right'
      safeWrite(cornerTo.x, cornerTo.y, pickCornerChar(horizontalArmTo, verticalArmTo))

      return
    }

    // 一般情况: L 型桥接(先水平,再垂直),保证箭头上方/下方一定存在竖向笔画。
    const corner = { x: to.x, y: from.y }
    drawHorizontal(from.y, from.x, corner.x)
    drawVertical(corner.x, corner.y, to.y)

    const horizontalArm: 'left' | 'right' = from.x < corner.x ? 'left' : 'right'
    const verticalArm: 'up' | 'down' = to.y < corner.y ? 'up' : 'down'
    safeWrite(corner.x, corner.y, pickCornerChar(horizontalArm, verticalArm))
  }
}

/**
 * Draw corner characters at path bends (where the direction changes).
 * Uses ┌┐└┘ in Unicode mode, + in ASCII mode.
 */
function drawCorners(graph: AsciiGraph, edge: AsciiEdge, path: GridCoord[]): Canvas {
  const canvas = copyCanvas(graph.canvas)

  for (let idx = 1; idx < path.length - 1; idx++) {
    const coord = path[idx]!
    const dc = gridToDrawingCoordForEdge(graph, edge, coord)
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

    // 防御性: 某些极端 detour 路径会把 corner 推到画布边界之外。
    // 与其直接崩溃,不如把画布扩容 1 次,保证 corner 能写入(避免断线/游离拐点)。
    const [maxX, maxY] = getCanvasSize(canvas)
    if (dc.x > maxX || dc.y > maxY) {
      increaseSize(canvas, Math.max(dc.x, maxX), Math.max(dc.y, maxY))
    }

    canvas[dc.x]![dc.y] = corner
  }

  return canvas
}

/** Draw edge label text centered on the widest path segment. */
function drawArrowLabel(graph: AsciiGraph, edge: AsciiEdge, baseCanvasForAvoid?: Canvas): Canvas {
  const canvas = copyCanvas(graph.canvas)
  if (edge.text.length === 0) return canvas

  const drawingLine = lineToDrawingForEdge(graph, edge, edge.labelLine)
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

  // 额外：禁止覆盖“文本类字符”（node label / subgraph label / 其它 edge label）。
  //
  // 背景:
  // - label 是最上层，默认会覆盖底层字符；
  // - 当多个 edge label 落在同一行/同一区间时，会出现文字拼接(例如 "iexperiment.taskked")，
  //   视觉上就是断线 + 无法读懂。
  //
  // 策略:
  // - 允许覆盖“纯线段字符”(─/│/-/| 等)，因为 label 本来就应当写在线上；
  // - 但禁止覆盖任何“非线段字符”的已有内容(大概率是文本)，从而让后续 label 自动避开已放置文本。
  //
  // 重要限制:
  // - 仅对 Unicode relaxed 启用:
  //   - ASCII 默认 routing=strict,更多依赖 golden 的稳定性；
  //   - 如果在 ASCII strict 里也启用,可能会让 label 被迫漂移到非常怪的位置(影响大量既有输出)。
  if (!useAscii && c !== ' ' && !charHasVerticalStroke(c, useAscii) && !charHasHorizontalStroke(c, useAscii)) {
    return true
  }

  // 额外：禁止 label 与已有文本“紧贴”(至少留 1 格空隙)，避免肉眼把两段文字读成一串。
  //
  // 典型现象(用户复现图):
  // - 两个 edge label 落在同一行且刚好首尾相接,
  //   会出现类似 `experiment.completeintegration.rejected` 这种“无分隔拼接”，读图很痛苦。
  //
  // 策略:
  // - 如果当前格是空白或线段字符,但左右相邻格存在“文本类字符”，
  //   则把当前格视为 forbidden,从而强制 label 之间至少隔 1 格。
  //
  // 取舍:
  // - 仅对 Unicode 启用(ASCII strict 更强调历史输出稳定性)。
  if (!useAscii) {
    const left = x > 0 ? base[x - 1]![y]! : ' '
    const right = x < maxX ? base[x + 1]![y]! : ' '

    const isTextLike = (ch: string): boolean => ch !== ' '
      && !isUnicodeArrowChar(ch)
      && !isUnicodeJunctionOrCorner(ch)
      && !charHasVerticalStroke(ch, useAscii)
      && !charHasHorizontalStroke(ch, useAscii)

    const cellIsNonText = c === ' '
      || charHasVerticalStroke(c, useAscii)
      || charHasHorizontalStroke(c, useAscii)

    if (cellIsNonText && (isTextLike(left) || isTextLike(right))) return true
  }

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
interface DrawTextOnLineOptions {
  // 并线标签模式:
  // - 保持中心 x 不变(不做横向漂移);
  // - 只允许上下寻找可用 y,满足“标签上下堆叠,不左右拼接”。
  verticalOnlyStack?: boolean
}

interface LabelPlacement {
  startX: number
  y: number
  width: number
}

function drawTextOnLine(
  canvas: Canvas,
  line: DrawingCoord[],
  label: string,
  avoid: DrawingCoord[] = [],
  baseCanvasForAvoid?: Canvas,
  useAsciiForAvoid: boolean = false,
  options: DrawTextOnLineOptions = {},
): LabelPlacement | null {
  if (line.length < 2) return null
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
    const [canvasMaxX, canvasMaxY] = getCanvasSize(baseCanvasForAvoid)
    const globalMinStart = 0
    const globalMaxStart = Math.max(globalMinStart, canvasMaxX - labelWidth + 1)
    if (startX < globalMinStart) startX = globalMinStart
    if (startX > globalMaxStart) startX = globalMaxStart

    // 并线标签强约束:
    // - 禁止横向漂移(避免“左右拼接”);
    // - 仅允许纵向找位(上下堆叠)。
    if (options.verticalOnlyStack) {
      const endX = startX + labelWidth - 1
      const isValidAtY = (candidateY: number): boolean => {
        if (intervalOverlapsAvoidPoints(candidateY, startX, endX, avoid)) return false
        if (intervalOverlapsForbiddenCells(baseCanvasForAvoid, candidateY, startX, endX, useAsciiForAvoid)) return false
        return true
      }

      if (isValidAtY(middleY)) {
        drawText(canvas, { x: startX, y: middleY }, label)
        return { startX, y: middleY, width: labelWidth }
      }

      const maxDelta = Math.max(middleY, canvasMaxY - middleY)
      for (let delta = 1; delta <= maxDelta; delta++) {
        const upY = middleY - delta
        if (upY >= 0 && isValidAtY(upY)) {
          drawText(canvas, { x: startX, y: upY }, label)
          return { startX, y: upY, width: labelWidth }
        }

        const downY = middleY + delta
        if (downY <= canvasMaxY && isValidAtY(downY)) {
          drawText(canvas, { x: startX, y: downY }, label)
          return { startX, y: downY, width: labelWidth }
        }
      }

      // Unicode relaxed 下,找不到合法位置就不画,避免把多个标签挤成一串。
      if (!useAsciiForAvoid) return null
      drawText(canvas, { x: startX, y: middleY }, label)
      return { startX, y: middleY, width: labelWidth }
    }

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

      const isValid = (candidate: number) => {
        const endX = candidate + labelWidth - 1
        if (intervalOverlapsAvoidPoints(middleY, candidate, endX, avoid)) return false
        if (intervalOverlapsForbiddenCells(baseCanvasForAvoid, middleY, candidate, endX, useAsciiForAvoid)) return false
        return true
      }

      // 第一次：在“优先范围”内找最近可行解
      const desiredStartX = startX
      startX = findNearestValidStartX({
        desiredStartX,
        minStartX: searchMin,
        maxStartX: searchMax,
        isValid,
      })

      // 额外策略仅对 Unicode relaxed 启用:
      // - Unicode relaxed 更强调“可读性优先”，允许 label 少量漂移或在极端拥挤时消失;
      // - ASCII strict 更强调“稳定/可逆”，不在这里引入行为漂移。
      if (!useAsciiForAvoid) {
        // 如果仍不可行,说明该范围内根本没有合法位置:
        // - 水平线段: 尝试放宽到“全画布范围”，宁可漂移也不要和其它文本拼接；
        // - 仍不可行: 直接不画 label（避免出现乱码/断线）。
        if (!isValid(startX) && isHorizontal && segmentMaxStart >= segmentMinStart) {
          const globalMinStart = 0
          const globalMaxStart = Math.max(globalMinStart, canvasMaxX - labelWidth + 1)
          if (globalMaxStart >= globalMinStart) {
            const clampedDesired = Math.min(Math.max(desiredStartX, globalMinStart), globalMaxStart)
            const globalPicked = findNearestValidStartX({
              desiredStartX: clampedDesired,
              minStartX: globalMinStart,
              maxStartX: globalMaxStart,
              isValid,
            })
            if (isValid(globalPicked)) startX = globalPicked
          }
        }

        if (!isValid(startX)) {
          // 实在找不到：宁可不画，也不要覆盖关键语义或与其它 label 拼接。
          return null
        }
      }
    }

    drawText(canvas, { x: startX, y: middleY }, label)
    return { startX, y: middleY, width: labelWidth }
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

      // 兜底：上面的“局部左/右移动”在某些极端情况下仍可能留下覆盖（例如多 avoid 点叠加）。
      // 这里再用一次“最近可行解”搜索, 确保不覆盖 avoid 点（只要线段容量允许）。
      startX = findNearestValidStartX({
        desiredStartX: startX,
        minStartX: minStart,
        maxStartX: maxStart,
        isValid: (candidate) => {
          const endX = candidate + labelWidth - 1
          return !intervalOverlapsAvoidPoints(middleY, candidate, endX, avoid)
        },
      })
    }
  }

  drawText(canvas, { x: startX, y: middleY }, label)
  return { startX, y: middleY, width: labelWidth }
}

function drawShortBundleLabelLeader(
  canvas: Canvas,
  placement: LabelPlacement,
  target: DrawingCoord,
  useAscii: boolean,
): void {
  const [, maxCanvasY] = getCanvasSize(canvas)
  const labelCenterX = placement.startX + Math.floor((placement.width - 1) / 2)
  const labelY = placement.y
  const dy = target.y - labelY

  // 仅保留“纵向引导”:
  // - 标签文本本身必须上下堆叠,不能因为引导符在左右扩展而制造横向噪音;
  // - 因此不再在文本同一行写入 `─/-`。
  if (dy === 0) return

  const verticalChar = useAscii ? '|' : '│'
  const leaderY = dy > 0 ? (labelY + 1) : (labelY - 1)

  if (leaderY < 0 || leaderY > maxCanvasY) return
  const current = canvas[labelCenterX]![leaderY]!
  // 仅在空白格写入引导符,避免破坏已有线段/junction 语义。
  if (current === '' || current === ' ') {
    canvas[labelCenterX]![leaderY] = verticalChar
  }
}

function computeArrowHeadPosForLabelAvoid(graph: AsciiGraph, edge: AsciiEdge): DrawingCoord | null {
  if (edge.path.length < 2) return null

  const last = edge.path[edge.path.length - 1]!
  const prev = edge.path[edge.path.length - 2]!
  const dir = determineDirection(prev, last)
  const target = gridToDrawingCoordForEdge(graph, edge, last)

  let fallback = target
  if (dirEquals(dir, Up)) fallback = { x: target.x, y: target.y + 1 }
  if (dirEquals(dir, Down)) fallback = { x: target.x, y: target.y - 1 }
  if (dirEquals(dir, Left)) fallback = { x: target.x + 1, y: target.y }
  if (dirEquals(dir, Right)) fallback = { x: target.x - 1, y: target.y }

  return computeArrowHeadPositionNearTargetBox(edge, dir, fallback)
}

function computeBoxStartPosForLabelAvoid(graph: AsciiGraph, edge: AsciiEdge): DrawingCoord | null {
  if (edge.path.length < 2) return null
  const dir = determineDirection(edge.path[0]!, edge.path[1]!)
  const fallback = gridToDrawingCoordForEdge(graph, edge, edge.path[0]!)
  return computeBoxStartPositionNearSourceBox(edge, dir, fallback)
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

// ============================================================================
// Bundle label stacking（同端点多边标签纵向堆叠）
// ============================================================================

interface BundleLabelStackInfo {
  key: string
  rank: number
  size: number
}

function buildBundleLabelStackInfo(edges: AsciiEdge[]): Map<AsciiEdge, BundleLabelStackInfo> {
  const grouped = new Map<string, AsciiEdge[]>()
  const info = new Map<AsciiEdge, BundleLabelStackInfo>()

  // 按“同端点(from,to)”分组,保持输入顺序稳定。
  for (const edge of edges) {
    if (edge.text.length === 0) continue
    const key = `${edge.from.name}→${edge.to.name}`
    const list = grouped.get(key)
    if (list) {
      list.push(edge)
    } else {
      grouped.set(key, [edge])
    }
  }

  for (const list of grouped.values()) {
    const key = `${list[0]!.from.name}→${list[0]!.to.name}`
    if (list.length <= 1) continue
    for (let i = 0; i < list.length; i++) {
      info.set(list[i]!, { key, rank: i, size: list.length })
    }
  }

  return info
}

function buildBundleStackedLabelLines(
  graph: AsciiGraph,
  stackInfoMap: Map<AsciiEdge, BundleLabelStackInfo>,
  canvas: Canvas,
): Map<AsciiEdge, DrawingCoord[]> {
  const out = new Map<AsciiEdge, DrawingCoord[]>()
  if (stackInfoMap.size === 0) return out

  // 先按 bundle key 聚合，后续同组共享一个 anchorY。
  const grouped = new Map<string, Array<{ edge: AsciiEdge; stack: BundleLabelStackInfo; baseLine: DrawingCoord[] }>>()
  for (const edge of graph.edges) {
    const stack = stackInfoMap.get(edge)
    if (!stack) continue
    const baseLine = lineToDrawingForEdge(graph, edge, edge.labelLine)
    const list = grouped.get(stack.key)
    if (list) {
      list.push({ edge, stack, baseLine })
    } else {
      grouped.set(stack.key, [{ edge, stack, baseLine }])
    }
  }

  const [maxCanvasX, maxCanvasY] = getCanvasSize(canvas)
  for (const list of grouped.values()) {
    if (list.length === 0) continue

    // 同组共享锚点:
    // - 取所有 baseLine 的 middleY 均值，避免“每条边各算各的 y”导致又回到横向拼接。
    let ySum = 0
    for (const item of list) {
      if (item.baseLine.length >= 2) {
        const minY = Math.min(item.baseLine[0]!.y, item.baseLine[1]!.y)
        const maxY = Math.max(item.baseLine[0]!.y, item.baseLine[1]!.y)
        ySum += minY + Math.floor((maxY - minY) / 2)
      }
    }
    const anchorY = Math.round(ySum / list.length)

    const centerCandidates: number[] = []
    for (const item of list) {
      if (item.baseLine.length < 2) continue
      const minX = Math.min(item.baseLine[0]!.x, item.baseLine[1]!.x)
      const maxX = Math.max(item.baseLine[0]!.x, item.baseLine[1]!.x)
      centerCandidates.push(minX + Math.floor((maxX - minX) / 2))
    }
    const sortedCenters = [...centerCandidates].sort((a, b) => a - b)
    let anchorCenterX = sortedCenters.length > 0
      ? sortedCenters[Math.floor(sortedCenters.length / 2)]!
      : 0
    if (anchorCenterX < 0) anchorCenterX = 0

    // 同组统一“文本起始列”:
    // - 先用组内最长标签反推一个 anchorStartX;
    // - 每条标签再按自己的宽度回推 centerX。
    // 结果: 所有标签左边界一致,彻底消除“同组标签左右散开”。
    const maxLabelWidth = list.reduce((maxWidth, item) => {
      return Math.max(maxWidth, textDisplayWidth(item.edge.text))
    }, 1)
    let anchorStartX = anchorCenterX - Math.floor(maxLabelWidth / 2)
    const maxAnchorStartX = Math.max(0, maxCanvasX - maxLabelWidth + 1)
    if (anchorStartX < 0) anchorStartX = 0
    if (anchorStartX > maxAnchorStartX) anchorStartX = maxAnchorStartX

    for (const item of list) {
      const line = item.baseLine
      if (line.length < 2) {
        out.set(item.edge, line)
        continue
      }

      const center = (item.stack.size - 1) / 2
      const offsetY = Math.round((item.stack.rank - center) * 2)
      let stackedY = anchorY + offsetY
      if (stackedY < 0) stackedY = 0
      if (stackedY > maxCanvasY) stackedY = maxCanvasY

      const labelWidth = textDisplayWidth(item.edge.text)
      let labelCenterX = anchorStartX + Math.floor(labelWidth / 2)
      if (labelCenterX < 0) labelCenterX = 0
      if (labelCenterX > maxCanvasX) labelCenterX = maxCanvasX

      out.set(item.edge, [
        // 同组标签共享起始列(anchorStartX):
        // - 视觉上严格形成纵向列表;
        // - 仍由 verticalOnlyStack 负责 y 轴避让。
        { x: labelCenterX, y: stackedY },
        { x: labelCenterX, y: stackedY },
      ])
    }
  }

  return out
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
  const enableSequentialLabelAvoid = graph.config.routing === 'relaxed' && !graph.config.useAscii
  const bundleLabelStackInfo = enableSequentialLabelAvoid
    ? buildBundleLabelStackInfo(graph.edges)
    : new Map<AsciiEdge, BundleLabelStackInfo>()
  const bundleStackedLines = enableSequentialLabelAvoid
    ? buildBundleStackedLabelLines(graph, bundleLabelStackInfo, graph.canvas)
    : new Map<AsciiEdge, DrawingCoord[]>()
  if (enableSequentialLabelAvoid) {
    // Unicode relaxed: label 需要“互相避让”
    // - 如果一次性生成所有 label layer 再 merge,每条 label 只能看到“线路层”,
    //   看不到其它 label,就会发生文字重叠/拼接。
    //
    // 因此这里改为“逐条边”把 label 直接画进 graph.canvas:
    // - 后画的 label 能看到先画的 label(通过 baseCanvasForAvoid=graph.canvas),
    //   从而在 findNearestValidStartX 时自动避开已存在文本。
    for (const edge of graph.edges) {
      if (edge.text.length === 0) continue

      const sourceLineForLeader = lineToDrawingForEdge(graph, edge, edge.labelLine)
      const drawingLine = bundleStackedLines.get(edge) ?? sourceLineForLeader
      const avoid: DrawingCoord[] = []
      const isBundleStackedLabel = bundleLabelStackInfo.has(edge)

      const arrowHeadPos = computeArrowHeadPosForLabelAvoid(graph, edge)
      if (arrowHeadPos) avoid.push(arrowHeadPos)

      const boxStartPos = computeBoxStartPosForLabelAvoid(graph, edge)
      if (boxStartPos) avoid.push(boxStartPos)

      const placement = drawTextOnLine(
        graph.canvas,
        drawingLine,
        edge.text,
        avoid,
        graph.canvas,
        useAscii,
        { verticalOnlyStack: isBundleStackedLabel },
      )

      // 并线标签的可读性增强:
      // - 在标签附近补 1 格短引导符;
      // - 指向该边原始 labelLine 的中心,帮助识别“这是哪条线的注释”。
      if (isBundleStackedLabel && placement && sourceLineForLeader.length >= 2) {
        const minX = Math.min(sourceLineForLeader[0]!.x, sourceLineForLeader[1]!.x)
        const maxX = Math.max(sourceLineForLeader[0]!.x, sourceLineForLeader[1]!.x)
        const minY = Math.min(sourceLineForLeader[0]!.y, sourceLineForLeader[1]!.y)
        const maxY = Math.max(sourceLineForLeader[0]!.y, sourceLineForLeader[1]!.y)
        const target: DrawingCoord = {
          x: minX + Math.floor((maxX - minX) / 2),
          y: minY + Math.floor((maxY - minY) / 2),
        }
        drawShortBundleLabelLeader(graph.canvas, placement, target, useAscii)
      }
    }
  } else {
    // ASCII strict（以及其它非 Unicode relaxed 的模式）：
    // - 保持旧行为：一次性生成所有 label layer，再 merge；
    // - 这样能最大化保持历史 golden 的稳定性。
    const labelCanvases: Canvas[] = []
    const baseCanvasForAvoid = graph.canvas
    for (const edge of graph.edges) {
      labelCanvases.push(drawArrowLabel(graph, edge, baseCanvasForAvoid))
    }
    graph.canvas = mergeCanvases(graph.canvas, zero, useAscii, ...labelCanvases)
  }

  // Draw subgraph labels last (on top)
  for (const sg of graph.subgraphs) {
    if (sg.nodes.length === 0) continue
    const [labelCanvas, offset] = drawSubgraphLabel(sg, graph)
    graph.canvas = mergeCanvases(graph.canvas, offset, useAscii, labelCanvas)
  }

  return graph.canvas
}
