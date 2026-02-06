// ============================================================================
// ASCII renderer — grid-based layout
//
// Ported from AlexanderGrooff/mermaid-ascii cmd/graph.go + cmd/mapping_node.go.
// Places nodes on a logical grid, computes column/row sizes,
// converts grid coordinates to character-level drawing coordinates,
// and handles subgraph bounding boxes.
// ============================================================================

import type {
  GridCoord, DrawingCoord, Direction, AsciiGraph, AsciiNode, AsciiSubgraph, AsciiEdge,
} from './types.ts'
import { gridKey } from './types.ts'
import { mkCanvas, setCanvasSizeToGrid, textDisplayWidth } from './canvas.ts'
import { determinePath, determineLabelLine, ROUTING_MAX_BOUNDS_EXPAND_BY, makeSegmentUsageMap, type SegmentUsageMap, type UsedPointSet } from './edge-routing.ts'
import { makeAStarContext } from './pathfinder.ts'
import { drawBox } from './draw.ts'

// ============================================================================
// Grid coordinate → drawing coordinate conversion
// ============================================================================

/**
 * Convert a grid coordinate to a drawing (character) coordinate.
 * Sums column widths up to the target column, and row heights up to the target row,
 * then centers within the cell.
 */
export function gridToDrawingCoord(
  graph: AsciiGraph,
  c: GridCoord,
  dir?: Direction,
): DrawingCoord {
  const target: GridCoord = dir
    ? { x: c.x + dir.x, y: c.y + dir.y }
    : c

  let x = 0
  if (graph.columnStartX && target.x >= 0 && target.x < graph.columnStartX.length) {
    x = graph.columnStartX[target.x] ?? 0
  } else {
    for (let col = 0; col < target.x; col++) {
      x += graph.columnWidth.get(col) ?? 0
    }
  }

  let y = 0
  if (graph.rowStartY && target.y >= 0 && target.y < graph.rowStartY.length) {
    y = graph.rowStartY[target.y] ?? 0
  } else {
    for (let row = 0; row < target.y; row++) {
      y += graph.rowHeight.get(row) ?? 0
    }
  }

  const colW = graph.columnWidth.get(target.x) ?? 0
  const rowH = graph.rowHeight.get(target.y) ?? 0
  return {
    x: x + Math.floor(colW / 2) + graph.offsetX,
    y: y + Math.floor(rowH / 2) + graph.offsetY,
  }
}

/** Convert a path of grid coords to drawing coords. */
export function lineToDrawing(graph: AsciiGraph, line: GridCoord[]): DrawingCoord[] {
  return line.map(c => gridToDrawingCoord(graph, c))
}

// ============================================================================
// Node placement on the grid
// ============================================================================

/**
 * Reserve a 3x3 block in the grid for a node.
 * If the requested position is occupied, recursively shift by 4 grid units
 * (in the perpendicular direction based on graph direction) until a free spot is found.
 */
export function reserveSpotInGrid(
  graph: AsciiGraph,
  node: AsciiNode,
  requested: GridCoord,
): GridCoord {
  if (graph.grid.has(gridKey(requested))) {
    // Collision — shift perpendicular to main flow direction
    if (graph.config.graphDirection === 'LR') {
      return reserveSpotInGrid(graph, node, { x: requested.x, y: requested.y + 4 })
    } else {
      return reserveSpotInGrid(graph, node, { x: requested.x + 4, y: requested.y })
    }
  }

  // Reserve the 3x3 block
  for (let dx = 0; dx < 3; dx++) {
    for (let dy = 0; dy < 3; dy++) {
      const reserved: GridCoord = { x: requested.x + dx, y: requested.y + dy }
      graph.grid.set(gridKey(reserved), node)
    }
  }

  node.gridCoord = requested
  return requested
}

// ============================================================================
// Column width / row height computation
// ============================================================================

/**
 * Set column widths and row heights for a node's 3x3 grid block.
 * Each node occupies 3 columns (border, content, border) and 3 rows.
 * The content column must be wide enough for the node's label.
 */
export function setColumnWidth(graph: AsciiGraph, node: AsciiNode): void {
  const gc = node.gridCoord!
  const padding = graph.config.boxBorderPadding

  // 3 columns: [border=1] [content=2*padding+labelLen] [border=1]
  // 注意：中文/emoji 等在终端里通常是 2 列宽，必须用显示宽度而不是 string.length。
  const colWidths = [1, 2 * padding + textDisplayWidth(node.displayLabel), 1]
  // 3 rows: [border=1] [content=1+2*padding] [border=1]
  const rowHeights = [1, 1 + 2 * padding, 1]

  for (let idx = 0; idx < colWidths.length; idx++) {
    const xCoord = gc.x + idx
    const current = graph.columnWidth.get(xCoord) ?? 0
    graph.columnWidth.set(xCoord, Math.max(current, colWidths[idx]!))
  }

  for (let idx = 0; idx < rowHeights.length; idx++) {
    const yCoord = gc.y + idx
    const current = graph.rowHeight.get(yCoord) ?? 0
    graph.rowHeight.set(yCoord, Math.max(current, rowHeights[idx]!))
  }

  // Padding column/row before the node (spacing between nodes)
  if (gc.x > 0) {
    const current = graph.columnWidth.get(gc.x - 1) ?? 0
    graph.columnWidth.set(gc.x - 1, Math.max(current, graph.config.paddingX))
  }

  if (gc.y > 0) {
    let basePadding = graph.config.paddingY
    // Extra vertical padding for nodes with incoming edges from outside their subgraph
    if (hasIncomingEdgeFromOutsideSubgraph(graph, node)) {
      const subgraphOverhead = 4
      basePadding += subgraphOverhead
    }
    const current = graph.rowHeight.get(gc.y - 1) ?? 0
    graph.rowHeight.set(gc.y - 1, Math.max(current, basePadding))
  }
}

/** Ensure grid has width/height entries for all cells along an edge path. */
export function increaseGridSizeForPath(graph: AsciiGraph, path: GridCoord[]): void {
  if (path.length === 0) return

  // 注意：edge.path 是 merge 过的（只保留拐点/端点），
  // 但绘制时会把端点之间的直线“整段画出来”。
  //
  // 因此这里不能只给 path 中出现的点补列宽/行高，
  // 还必须把直线段上的所有中间坐标也补齐，
  // 否则缺失的列/行会被当成宽度 0，导致坐标累加错误（线段被压扁/重叠）。
  function ensureCoord(c: GridCoord): void {
    if (!graph.columnWidth.has(c.x)) {
      graph.columnWidth.set(c.x, Math.floor(graph.config.paddingX / 2))
    }
    if (!graph.rowHeight.has(c.y)) {
      graph.rowHeight.set(c.y, Math.floor(graph.config.paddingY / 2))
    }
  }

  let prev = path[0]!
  ensureCoord(prev)

  for (let i = 1; i < path.length; i++) {
    const curr = path[i]!

    if (prev.x === curr.x) {
      const step = curr.y > prev.y ? 1 : -1
      for (let y = prev.y; y !== curr.y; y += step) {
        ensureCoord({ x: prev.x, y })
        ensureCoord({ x: prev.x, y: y + step })
      }
    } else if (prev.y === curr.y) {
      const step = curr.x > prev.x ? 1 : -1
      for (let x = prev.x; x !== curr.x; x += step) {
        ensureCoord({ x, y: prev.y })
        ensureCoord({ x: x + step, y: prev.y })
      }
    } else {
      // 正常情况下 A* 只会产生水平/垂直路径，这里主要用于防御性检查。
      ensureCoord(curr)
    }

    prev = curr
  }
}

// ============================================================================
// Subgraph helpers
// ============================================================================

function isNodeInAnySubgraph(graph: AsciiGraph, node: AsciiNode): boolean {
  return graph.subgraphs.some(sg => sg.nodes.includes(node))
}

function getNodeSubgraph(graph: AsciiGraph, node: AsciiNode): AsciiSubgraph | null {
  for (const sg of graph.subgraphs) {
    if (sg.nodes.includes(node)) return sg
  }
  return null
}

/**
 * Check if a node has an incoming edge from outside its subgraph
 * AND is the topmost such node in its subgraph.
 * Used to add extra vertical padding for subgraph borders.
 */
function hasIncomingEdgeFromOutsideSubgraph(graph: AsciiGraph, node: AsciiNode): boolean {
  const nodeSg = getNodeSubgraph(graph, node)
  if (!nodeSg) return false

  let hasExternalEdge = false
  for (const edge of graph.edges) {
    if (edge.to === node) {
      const sourceSg = getNodeSubgraph(graph, edge.from)
      if (sourceSg !== nodeSg) {
        hasExternalEdge = true
        break
      }
    }
  }

  if (!hasExternalEdge) return false

  // Only return true for the topmost node with an external incoming edge
  for (const otherNode of nodeSg.nodes) {
    if (otherNode === node || !otherNode.gridCoord) continue
    let otherHasExternal = false
    for (const edge of graph.edges) {
      if (edge.to === otherNode) {
        const sourceSg = getNodeSubgraph(graph, edge.from)
        if (sourceSg !== nodeSg) {
          otherHasExternal = true
          break
        }
      }
    }
    if (otherHasExternal && otherNode.gridCoord.y < node.gridCoord!.y) {
      return false
    }
  }

  return true
}

// ============================================================================
// Subgraph bounding boxes
// ============================================================================

function calculateSubgraphBoundingBox(graph: AsciiGraph, sg: AsciiSubgraph): void {
  if (sg.nodes.length === 0) return

  let minX = 1_000_000
  let minY = 1_000_000
  let maxX = -1_000_000
  let maxY = -1_000_000

  // Include children's bounding boxes
  for (const child of sg.children) {
    calculateSubgraphBoundingBox(graph, child)
    if (child.nodes.length > 0) {
      minX = Math.min(minX, child.minX)
      minY = Math.min(minY, child.minY)
      maxX = Math.max(maxX, child.maxX)
      maxY = Math.max(maxY, child.maxY)
    }
  }

  // Include node positions
  for (const node of sg.nodes) {
    if (!node.drawingCoord || !node.drawing) continue
    const nodeMinX = node.drawingCoord.x
    const nodeMinY = node.drawingCoord.y
    const nodeMaxX = nodeMinX + node.drawing.length - 1
    const nodeMaxY = nodeMinY + node.drawing[0]!.length - 1
    minX = Math.min(minX, nodeMinX)
    minY = Math.min(minY, nodeMinY)
    maxX = Math.max(maxX, nodeMaxX)
    maxY = Math.max(maxY, nodeMaxY)
  }

  const subgraphPadding = 2
  const subgraphLabelSpace = 2
  sg.minX = minX - subgraphPadding
  sg.minY = minY - subgraphPadding - subgraphLabelSpace
  sg.maxX = maxX + subgraphPadding
  sg.maxY = maxY + subgraphPadding
}

/** Ensure non-overlapping root subgraphs have minimum spacing. */
function ensureSubgraphSpacing(graph: AsciiGraph): void {
  const minSpacing = 1
  const rootSubgraphs = graph.subgraphs.filter(sg => sg.parent === null && sg.nodes.length > 0)

  for (let i = 0; i < rootSubgraphs.length; i++) {
    for (let j = i + 1; j < rootSubgraphs.length; j++) {
      const sg1 = rootSubgraphs[i]!
      const sg2 = rootSubgraphs[j]!

      // Horizontal overlap → adjust vertical
      if (sg1.minX < sg2.maxX && sg1.maxX > sg2.minX) {
        if (sg1.maxY >= sg2.minY - minSpacing && sg1.minY < sg2.minY) {
          sg2.minY = sg1.maxY + minSpacing + 1
        } else if (sg2.maxY >= sg1.minY - minSpacing && sg2.minY < sg1.minY) {
          sg1.minY = sg2.maxY + minSpacing + 1
        }
      }
      // Vertical overlap → adjust horizontal
      if (sg1.minY < sg2.maxY && sg1.maxY > sg2.minY) {
        if (sg1.maxX >= sg2.minX - minSpacing && sg1.minX < sg2.minX) {
          sg2.minX = sg1.maxX + minSpacing + 1
        } else if (sg2.maxX >= sg1.minX - minSpacing && sg2.minX < sg1.minX) {
          sg1.minX = sg2.maxX + minSpacing + 1
        }
      }
    }
  }
}

export function calculateSubgraphBoundingBoxes(graph: AsciiGraph): void {
  for (const sg of graph.subgraphs) {
    calculateSubgraphBoundingBox(graph, sg)
  }
  ensureSubgraphSpacing(graph)
}

/**
 * Offset all drawing coordinates so subgraph borders don't go negative.
 * If any subgraph has negative min coordinates, shift everything positive.
 */
export function offsetDrawingForSubgraphs(graph: AsciiGraph): void {
  if (graph.subgraphs.length === 0) return

  let minX = 0
  let minY = 0
  for (const sg of graph.subgraphs) {
    minX = Math.min(minX, sg.minX)
    minY = Math.min(minY, sg.minY)
  }

  const offsetX = -minX
  const offsetY = -minY
  if (offsetX === 0 && offsetY === 0) return

  graph.offsetX = offsetX
  graph.offsetY = offsetY

  for (const sg of graph.subgraphs) {
    sg.minX += offsetX
    sg.minY += offsetY
    sg.maxX += offsetX
    sg.maxY += offsetY
  }

  for (const node of graph.nodes) {
    if (node.drawingCoord) {
      node.drawingCoord.x += offsetX
      node.drawingCoord.y += offsetY
    }
  }
}

// ============================================================================
// Main layout orchestrator
// ============================================================================

/**
 * createMapping performs the full grid layout:
 * 1. Place root nodes on the grid
 * 2. Place child nodes level by level
 * 3. Compute column widths and row heights
 * 4. Run A* pathfinding for all edges
 * 5. Determine label placement
 * 6. Convert grid coords → drawing coords
 * 7. Generate node box drawings
 * 8. Calculate subgraph bounding boxes
 */
export function createMapping(graph: AsciiGraph): void {
  // -------------------------------------------------------------------------
  // 重要：布局重试（layout margin）
  //
  // 背景（用户规则 + 真实失败案例）：
  // - strict 路由（禁四向交叉 + 禁中段共线）在“节点贴边”时可能让某些端口几何上不可达，
  //   进而导致整条边 `path=[]`（边直接消失）。
  // - 用户明确偏好：宁愿扩大绘制面积/网格，也不要为了挤进同一格而并线/合并。
  //
  // 策略：
  // - 第一次按原布局（margin=0）跑，尽量保持现有 golden 的稳定性；
  // - 只要发现任一边 `path.length < 2`（不可绘制箭头），就整体右移/下移（margin++）并重跑布局；
  // - 这样能给 top/left 留出 free cell，让原本不可达的 Up/Left 端口变为可达，strict 也能找到路径。
  // -------------------------------------------------------------------------
  const LAYOUT_MARGIN_STEPS = [0, 1, 2, 3, 4]

  for (const layoutMargin of LAYOUT_MARGIN_STEPS) {
    resetLayoutState(graph)
    const ok = createMappingOnce(graph, layoutMargin)
    if (ok) return
  }
}

function resetLayoutState(graph: AsciiGraph): void {
  graph.grid = new Map()
  graph.columnWidth = new Map()
  graph.rowHeight = new Map()
  graph.canvas = mkCanvas(0, 0)
  graph.offsetX = 0
  graph.offsetY = 0
  graph.columnStartX = undefined
  graph.rowStartY = undefined
  graph.portUsage = graph.config.routing === 'relaxed'
    ? new Uint16Array(graph.nodes.length * 9)
    : undefined

  for (const node of graph.nodes) {
    node.gridCoord = null
    node.drawingCoord = null
    node.drawing = null
    node.drawn = false
  }

  for (const edge of graph.edges) {
    edge.path = []
    edge.labelLine = []
    edge.startDir = { x: 0, y: 0 }
    edge.endDir = { x: 0, y: 0 }
    edge.startPortOffsetX = undefined
    edge.startPortOffsetY = undefined
    edge.endPortOffsetX = undefined
    edge.endPortOffsetY = undefined
  }

  for (const sg of graph.subgraphs) {
    sg.minX = 0
    sg.minY = 0
    sg.maxX = 0
    sg.maxY = 0
  }
}

// ============================================================================
// grid → drawing 前缀和缓存（性能关键）
// ============================================================================

function rebuildGridToDrawingCache(graph: AsciiGraph): void {
  // 说明：
  // - columnWidth/rowHeight 是稀疏 Map（只在需要的格子写入）；
  // - 但绘制阶段需要频繁把 gridCoord 转成 drawingCoord；
  // - 这里把“累加求和”变成 prefix-sum 查表，避免 O(N^2) 热点。

  let maxCol = 0
  for (const col of graph.columnWidth.keys()) maxCol = Math.max(maxCol, col)

  let maxRow = 0
  for (const row of graph.rowHeight.keys()) maxRow = Math.max(maxRow, row)

  const columnStartX = new Int32Array(maxCol + 2)
  let x = 0
  for (let col = 0; col < columnStartX.length; col++) {
    columnStartX[col] = x
    x += graph.columnWidth.get(col) ?? 0
  }

  const rowStartY = new Int32Array(maxRow + 2)
  let y = 0
  for (let row = 0; row < rowStartY.length; row++) {
    rowStartY[row] = y
    y += graph.rowHeight.get(row) ?? 0
  }

  graph.columnStartX = columnStartX
  graph.rowStartY = rowStartY
}

function createMappingOnce(graph: AsciiGraph, layoutMargin: number): boolean {
  const dir = graph.config.graphDirection
  const highestPositionPerLevel: number[] = new Array(100).fill(0)

  // Identify root nodes — nodes that aren't the target of any edge
  const nodesFound = new Set<string>()
  const rootNodes: AsciiNode[] = []

  for (const node of graph.nodes) {
    if (!nodesFound.has(node.name)) {
      rootNodes.push(node)
    }
    nodesFound.add(node.name)
    for (const child of getChildren(graph, node)) {
      nodesFound.add(child.name)
    }
  }

  // In LR mode with both external and subgraph roots, separate them
  // so subgraph roots are placed one level deeper
  let hasExternalRoots = false
  let hasSubgraphRootsWithEdges = false
  for (const node of rootNodes) {
    if (isNodeInAnySubgraph(graph, node)) {
      if (getChildren(graph, node).length > 0) hasSubgraphRootsWithEdges = true
    } else {
      hasExternalRoots = true
    }
  }
  const shouldSeparate = dir === 'LR' && hasExternalRoots && hasSubgraphRootsWithEdges

  let externalRootNodes: AsciiNode[]
  let subgraphRootNodes: AsciiNode[] = []

  if (shouldSeparate) {
    externalRootNodes = rootNodes.filter(n => !isNodeInAnySubgraph(graph, n))
    subgraphRootNodes = rootNodes.filter(n => isNodeInAnySubgraph(graph, n))
  } else {
    externalRootNodes = rootNodes
  }

  // Place external root nodes
  for (const node of externalRootNodes) {
    const requested: GridCoord = dir === 'LR'
      ? { x: 0 + layoutMargin, y: highestPositionPerLevel[0]! + layoutMargin }
      : { x: highestPositionPerLevel[0]! + layoutMargin, y: 0 + layoutMargin }
    reserveSpotInGrid(graph, graph.nodes[node.index]!, requested)
    highestPositionPerLevel[0] = highestPositionPerLevel[0]! + 4
  }

  // Place subgraph root nodes at level 4 (one level in from the edge)
  if (shouldSeparate && subgraphRootNodes.length > 0) {
    const subgraphLevel = 4
    for (const node of subgraphRootNodes) {
      const requested: GridCoord = dir === 'LR'
        ? { x: subgraphLevel + layoutMargin, y: highestPositionPerLevel[subgraphLevel]! + layoutMargin }
        : { x: highestPositionPerLevel[subgraphLevel]! + layoutMargin, y: subgraphLevel + layoutMargin }
      reserveSpotInGrid(graph, graph.nodes[node.index]!, requested)
      highestPositionPerLevel[subgraphLevel] = highestPositionPerLevel[subgraphLevel]! + 4
    }
  }

  // Place child nodes level by level
  for (const node of graph.nodes) {
    const gc = node.gridCoord!

    // 注意：node.gridCoord 已经包含 layoutMargin，我们必须把 level 还原成“相对 level”，
    // 否则 highestPositionPerLevel 的索引会漂移（导致节点堆叠或越界）。
    const nodeLevel = dir === 'LR' ? (gc.x - layoutMargin) : (gc.y - layoutMargin)
    const childLevel = nodeLevel + 4

    let highestPosition = highestPositionPerLevel[childLevel] ?? 0

    for (const child of getChildren(graph, node)) {
      if (child.gridCoord !== null) continue // already placed

      const requested: GridCoord = dir === 'LR'
        ? { x: childLevel + layoutMargin, y: highestPosition + layoutMargin }
        : { x: highestPosition + layoutMargin, y: childLevel + layoutMargin }
      reserveSpotInGrid(graph, graph.nodes[child.index]!, requested)
      highestPositionPerLevel[childLevel] = highestPosition + 4
      highestPosition = highestPositionPerLevel[childLevel]!
    }
  }

  // -------------------------------------------------------------------------
  // A* 预分配缓存（性能关键）
  //
  // 背景：
  // - A* 会被调用非常多次（多候选端口 + 多档 bounds 扩展 + strict 避让）。
  // - 如果每次都 new Map / 拼接 string key，会在无 JIT 的 JS 引擎里慢到离谱。
  //
  // 策略：
  // - 用 TypedArray + stamp 复用，把“每次 search 的成本”压到接近 O(访问点数)。
  // - blocked（节点占用）也做成 Uint8Array，避免热循环里查 Map<string>。
  // -------------------------------------------------------------------------
  let baseMaxX = 0
  let baseMaxY = 0
  for (const node of graph.nodes) {
    if (!node.gridCoord) continue
    baseMaxX = Math.max(baseMaxX, node.gridCoord.x + 2)
    baseMaxY = Math.max(baseMaxY, node.gridCoord.y + 2)
  }

  const stride = baseMaxX + ROUTING_MAX_BOUNDS_EXPAND_BY + 1
  const height = baseMaxY + ROUTING_MAX_BOUNDS_EXPAND_BY + 1
  const aStar = makeAStarContext(stride, height)

  // 标记 node 3x3 占用格子
  for (const node of graph.nodes) {
    if (!node.gridCoord) continue
    for (let dx = 0; dx < 3; dx++) {
      for (let dy = 0; dy < 3; dy++) {
        const x = node.gridCoord.x + dx
        const y = node.gridCoord.y + dy
        aStar.blocked[x + y * stride] = 1
      }
    }
  }

  // strict 路由所需的“占用表”也用 TypedArray 表示：
  // - usedPoints：每个 free cell 记录 4 向连通 bitmask（用于避免 `┼`）
  // - segmentUsage：每段 unit segment 记录“是否允许共享”（用于避免非法共线）
  const segmentUsage: SegmentUsageMap = makeSegmentUsageMap(aStar.blocked.length)
  const usedPoints: UsedPointSet = new Uint8Array(aStar.blocked.length)

  // Compute column widths and row heights
  for (const node of graph.nodes) {
    setColumnWidth(graph, node)
  }

  // Route edges via A* and determine label positions
  //
  // 重要：这里刻意保持“输入顺序”（graph.edges 的顺序），原因：
  // - ASCII/Unicode 的 golden tests（以及 Go 原实现）隐含依赖“逐边路由”的顺序稳定性。
  // - 我们曾尝试对边做排序（例如深度优先），会让“回边/反向边”过早占用主干通路，
  //   导致后续边在 strict 模式下多轮扩 bounds 重试：性能急剧变差，路径也更丑。
  //
  // 结论：在没有一个明确、可证明更优且不回归的排序策略前，优先保持稳定与可预测。
  for (const edge of graph.edges) {
    determinePath(graph, edge, aStar, baseMaxX, baseMaxY, segmentUsage, usedPoints)
    increaseGridSizeForPath(graph, edge.path)
  }

  // 若出现任何不可绘制的边（0/1 点路径），本次尝试视为失败，交给外层 margin 重试。
  const hasUnroutableEdge = graph.edges.some(e => e.path.length < 2)
  if (hasUnroutableEdge) return false

  // -------------------------------------------------------------------------
  // Comb ports（梳子口端口）+ box 自适应扩容
  //
  // 用户诉求：
  // - 出入口沿边框多点分布（不仅 8 个端口）
  // - box 大小可变：根据需要的端口数量扩大
  //
  // 实现策略（先能用，风险可控）：
  // - 不改 grid A*：仍然在 3x3 block 的端口格子上做路由；
  // - 但在绘制层允许“同一格内部多 lane（偏移）”，从而把端口分散到边框不同位置；
  // - 为了保证 lane 有容量：按每个 node 的端口数量，扩大该 node 的 content 列宽/行高。
  //
  // 注意：
  // - 这里必须发生在 determineLabelLine 之前：
  //   labelLine 选择依赖当前 columnWidth/rowHeight（避免覆盖 box/其它 label）。
  // -------------------------------------------------------------------------
  const enableCombPorts = !graph.config.useAscii && graph.config.routing === 'relaxed'
  if (enableCombPorts) {
    type Side = 'up' | 'down' | 'left' | 'right'
    type EndpointKind = 'start' | 'end'

    interface Endpoint {
      edge: AsciiEdge
      kind: EndpointKind
      otherSort: number
      edgeOrder: number
    }

    function dirToSide(d: { x: number; y: number }): Side | null {
      if (d.x === 1 && d.y === 0) return 'up'
      if (d.x === 1 && d.y === 2) return 'down'
      if (d.x === 0 && d.y === 1) return 'left'
      if (d.x === 2 && d.y === 1) return 'right'
      return null
    }

    function spreadOffsets(count: number, capacity: number): number[] {
      // offset：0..capacity-1
      if (count <= 0) return []
      if (capacity <= 0) return []
      if (count === 1) return [Math.floor(capacity / 2)]
      const out: number[] = []
      for (let i = 0; i < count; i++) {
        out.push(Math.floor(i * (capacity - 1) / (count - 1)))
      }
      return out
    }

    // 1) 收集每个 node 每条边的“端口归属侧（up/down/left/right）”
    const endpointsByNode = graph.nodes.map(() => ({
      up: [] as Endpoint[],
      down: [] as Endpoint[],
      left: [] as Endpoint[],
      right: [] as Endpoint[],
    }))

    for (let edgeOrder = 0; edgeOrder < graph.edges.length; edgeOrder++) {
      const edge = graph.edges[edgeOrder]!

      // 防御：只有可路由边才参与端口分配
      if (edge.path.length < 2) continue

      const startSide = dirToSide(edge.startDir)
      const endSide = dirToSide(edge.endDir)

      if (startSide) {
        const other = edge.to.gridCoord
        const otherSort = (startSide === 'left' || startSide === 'right')
          ? (other?.y ?? 0)
          : (other?.x ?? 0)
        endpointsByNode[edge.from.index]![startSide].push({
          edge,
          kind: 'start',
          otherSort,
          edgeOrder,
        })
      }

      if (endSide) {
        const other = edge.from.gridCoord
        const otherSort = (endSide === 'left' || endSide === 'right')
          ? (other?.y ?? 0)
          : (other?.x ?? 0)
        endpointsByNode[edge.to.index]![endSide].push({
          edge,
          kind: 'end',
          otherSort,
          edgeOrder,
        })
      }
    }

    // 2) box 自适应扩容：确保 content 宽/高 >= 端口数量
    for (const node of graph.nodes) {
      if (!node.gridCoord) continue

      const counts = endpointsByNode[node.index]!

      const borderPadding = graph.config.boxBorderPadding
      const baseContentWidth = 2 * borderPadding + textDisplayWidth(node.displayLabel)
      const baseContentHeight = 1 + 2 * borderPadding

      const requiredContentWidth = Math.max(baseContentWidth, counts.up.length, counts.down.length)
      const requiredContentHeight = Math.max(baseContentHeight, counts.left.length, counts.right.length)

      const contentCol = node.gridCoord.x + 1
      const contentRow = node.gridCoord.y + 1

      const cw = graph.columnWidth.get(contentCol) ?? 0
      if (requiredContentWidth > cw) graph.columnWidth.set(contentCol, requiredContentWidth)

      const rh = graph.rowHeight.get(contentRow) ?? 0
      if (requiredContentHeight > rh) graph.rowHeight.set(contentRow, requiredContentHeight)
    }

    // 3) 端口 offset 分配：按 side 在 content cell 内做分散（形成“梳子口”）
    for (const node of graph.nodes) {
      if (!node.gridCoord) continue

      const lists = endpointsByNode[node.index]!
      const contentCol = node.gridCoord.x + 1
      const contentRow = node.gridCoord.y + 1
      const contentWidth = graph.columnWidth.get(contentCol) ?? 0
      const contentHeight = graph.rowHeight.get(contentRow) ?? 0

      function assign(list: Endpoint[], side: Side): void {
        if (list.length === 0) return

        // 稳定排序：先按“另一端的坐标”排，再按输入边顺序排，减少不必要交错。
        list.sort((a, b) => (a.otherSort - b.otherSort) || (a.edgeOrder - b.edgeOrder))

        const capacity = (side === 'left' || side === 'right') ? contentHeight : contentWidth
        const offsets = spreadOffsets(list.length, capacity)

        for (let i = 0; i < list.length; i++) {
          const ep = list[i]!
          const offset = offsets[i]!

          if (side === 'left' || side === 'right') {
            if (ep.kind === 'start') ep.edge.startPortOffsetY = offset
            else ep.edge.endPortOffsetY = offset
          } else {
            if (ep.kind === 'start') ep.edge.startPortOffsetX = offset
            else ep.edge.endPortOffsetX = offset
          }
        }
      }

      assign(lists.left, 'left')
      assign(lists.right, 'right')
      assign(lists.up, 'up')
      assign(lists.down, 'down')
    }
  }

  // 端口/box 尺寸确定后，再做 labelLine 选择（避免 label 覆盖关键符号/边框）。
  for (const edge of graph.edges) {
    determineLabelLine(graph, edge)
  }

  // labelLine 会调整 columnWidth（给 label 腾出空间），因此必须在它之后重建 prefix cache。
  rebuildGridToDrawingCache(graph)

  // Convert grid coords → drawing coords and generate box drawings
  for (const node of graph.nodes) {
    node.drawingCoord = gridToDrawingCoord(graph, node.gridCoord!)
    node.drawing = drawBox(node, graph)
  }

  // Set canvas size and compute subgraph bounding boxes
  setCanvasSizeToGrid(graph.canvas, graph.columnWidth, graph.rowHeight)
  calculateSubgraphBoundingBoxes(graph)
  offsetDrawingForSubgraphs(graph)

  return true
}

// ============================================================================
// Graph traversal helpers
// ============================================================================

/** Get all edges originating from a node. */
function getEdgesFromNode(graph: AsciiGraph, node: AsciiNode): AsciiGraph['edges'] {
  return graph.edges.filter(e => e.from.name === node.name)
}

/** Get all direct children of a node (targets of outgoing edges). */
function getChildren(graph: AsciiGraph, node: AsciiNode): AsciiNode[] {
  return getEdgesFromNode(graph, node).map(e => e.to)
}
