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
 * If the requested position is occupied, recursively shift by `shiftBy` grid units
 * (in the perpendicular direction based on graph direction) until a free spot is found.
 */
export function reserveSpotInGrid(
  graph: AsciiGraph,
  node: AsciiNode,
  requested: GridCoord,
  shiftBy: number = 4,
): GridCoord {
  if (graph.grid.has(gridKey(requested))) {
    // Collision — shift perpendicular to main flow direction
    if (graph.config.graphDirection === 'LR') {
      return reserveSpotInGrid(graph, node, { x: requested.x, y: requested.y + shiftBy }, shiftBy)
    } else {
      // TD + Unicode relaxed: 优先“向下堆叠”而不是“向右扩展”
      //
      // 背景(用户复现图):
      // - TD 下如果兄弟节点发生碰撞,旧逻辑会把其中一个节点向右平移,
      //   结果把图拉成“两列极端分离”,并且制造大量 backward edge(向上走)的长水平/外圈绕行。
      // - 在 Unicode relaxed 模式下,我们更偏向“人类可读性”:
      //   - 宁愿图更高一些(向下堆叠),
      //   - 也不要把关键节点拆成远距离左右两列(会让多条边被迫绕外圈)。
      //
      // 取舍:
      // - strict/ASCII 仍保持旧行为(更稳定,也更利于 roundtrip/golden)。
      if (graph.config.routing === 'relaxed' && !graph.config.useAscii) {
        return reserveSpotInGrid(graph, node, { x: requested.x, y: requested.y + shiftBy }, shiftBy)
      }
      return reserveSpotInGrid(graph, node, { x: requested.x + shiftBy, y: requested.y }, shiftBy)
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
// Grid step（拥挤图的 lane/margin 基础）
// ============================================================================

/**
 * 计算 grid 坐标系下的“层级步长/节点间距”(默认=4)。
 *
 * 背景(你的复现用例):
 * - 当同一对节点之间存在多条边(平行边),或某个节点出入边很多时,
 *   仅靠 4 的步长(节点 3x3 + 1 格间隙)往往不足以给 A* 留出多条可用通道;
 * - 在 relaxed + 禁 segment overlap 的约束下,通道不足会直接导致:
 *   - 边不可达(path=[]),进而触发 createMapping() 失败;
 *   - A* 在大量不可达候选上反复扩 bounds,性能急剧变差。
 *
 * 策略:
 * - strict: 保持 4,优先稳定性(golden/roundtrip)。
 * - relaxed: 按“拥挤度”适度增加到 6 或 8,给路由器更多 lane。
 *
 * 说明:
 * - 这是 grid 层的间距,与最终绘制的 paddingX/paddingY(字符画间距)不同。
 * - 这里的目标是让路由先变得\"可达且不爆炸\",然后再谈更精细的 nearest-side/penalty。
 */
function computeGridStep(graph: AsciiGraph): number {
  const BASE = 4
  if (graph.config.routing !== 'relaxed') return BASE

  const nodeCount = graph.nodes.length
  if (nodeCount === 0) return BASE

  // 统计“同一对节点(from->to)”的最大平行边数量。
  let maxParallel = 1
  const pairCounts = new Map<number, number>()
  for (const e of graph.edges) {
    const key = e.from.index * nodeCount + e.to.index
    const next = (pairCounts.get(key) ?? 0) + 1
    pairCounts.set(key, next)
    if (next > maxParallel) maxParallel = next
  }

  // 统计最大出度: 出边越多,越需要更多 lane。
  let maxOutDegree = 0
  const outDegree = new Uint16Array(nodeCount)
  for (const e of graph.edges) {
    const next = (outDegree[e.from.index] ?? 0) + 1
    outDegree[e.from.index] = next
    if (next > maxOutDegree) maxOutDegree = next
  }

  // 启发式阈值(可再根据更多样例微调):
  // - 平行边>=3 或 maxOutDegree>=4: 从 4 提升到 6(间隙=3)
  // - 平行边>=5 或 maxOutDegree>=8: 再提升到 8(间隙=5)
  if (maxParallel >= 5 || maxOutDegree >= 8) return 8
  if (maxParallel >= 3 || maxOutDegree >= 4) return 6
  return BASE
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
  const gridStep = computeGridStep(graph)
  const highestPositionPerLevel: number[] = new Array(
    Math.max(100, (graph.nodes.length + 2) * gridStep + 16),
  ).fill(0)

  // Identify root nodes.
  //
  // 设计取舍（避免“一刀切”引发大面积 golden 变化）：
  // - strict：保持旧行为（依赖 insertion order 的“首次出现”推断），尽量保留用户定义顺序与历史输出稳定性。
  // - relaxed：使用“无入边节点”作为 root，避免节点先声明再连边时把 target 误判成 root，
  //   进而把节点堆到同一列/同一行, 迫使边大绕路并产生强歧义。
  let rootNodes: AsciiNode[] = []
  if (graph.config.routing === 'strict') {
    const nodesFound = new Set<string>()
    for (const node of graph.nodes) {
      if (!nodesFound.has(node.name)) rootNodes.push(node)
      nodesFound.add(node.name)
      for (const child of getChildren(graph, node)) {
        nodesFound.add(child.name)
      }
    }
  } else {
    const nodesWithIncoming = new Set<string>()
    for (const edge of graph.edges) {
      nodesWithIncoming.add(edge.to.name)
    }

    // 保持稳定顺序：按 graph.nodes 的 insertion order 过滤得到 rootNodes。
    rootNodes = graph.nodes.filter(n => !nodesWithIncoming.has(n.name))

    // 极端情况：全图成环时, 所有节点都有入边, rootNodes 会为空。
    // 为了保持可用性与确定性, 回退到“第一个节点”作为 root, 继续布局。
    if (rootNodes.length === 0 && graph.nodes.length > 0) {
      rootNodes = [graph.nodes[0]!]
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
    reserveSpotInGrid(graph, graph.nodes[node.index]!, requested, gridStep)
    highestPositionPerLevel[0] = highestPositionPerLevel[0]! + gridStep
  }

  // Place subgraph root nodes at level 4 (one level in from the edge)
  if (shouldSeparate && subgraphRootNodes.length > 0) {
    const subgraphLevel = gridStep
    for (const node of subgraphRootNodes) {
      const requested: GridCoord = dir === 'LR'
        ? { x: subgraphLevel + layoutMargin, y: highestPositionPerLevel[subgraphLevel]! + layoutMargin }
        : { x: highestPositionPerLevel[subgraphLevel]! + layoutMargin, y: subgraphLevel + layoutMargin }
      reserveSpotInGrid(graph, graph.nodes[node.index]!, requested, gridStep)
      highestPositionPerLevel[subgraphLevel] = highestPositionPerLevel[subgraphLevel]! + gridStep
    }
  }

  // Place child nodes level by level.
  //
  // 注意：
  // - graph.nodes 的 insertion order 不保证“父节点一定在子节点之前”（尤其是用户先声明节点再连边时）。
  // - 因此这里不能假设 node.gridCoord 一定非 null；必须跳过尚未放置的节点。
  // - 另外: 对于“不连通的纯环组件”, 可能不存在真正的 rootNodes, 需要兜底把未放置节点当作额外 root。
  let placedSomething = true
  while (placedSomething) {
    placedSomething = false

    for (const node of graph.nodes) {
      const gc = node.gridCoord
      if (!gc) continue

      // 注意：node.gridCoord 已经包含 layoutMargin，我们必须把 level 还原成“相对 level”，
      // 否则 highestPositionPerLevel 的索引会漂移（导致节点堆叠或越界）。
      const nodeLevel = dir === 'LR' ? (gc.x - layoutMargin) : (gc.y - layoutMargin)
      const childLevel = nodeLevel + gridStep

      let highestPosition = highestPositionPerLevel[childLevel] ?? 0

      for (const child of getChildren(graph, node)) {
        if (child.gridCoord !== null) continue // already placed

        // -----------------------------------------------------------------
        // TD + Unicode relaxed: 双向边(bidirectional)子节点的“下沉”放置
        //
        // 背景(用户复现图):
        // - 在 TD 下,同一父节点的多个 child 默认会被放在同一层(childLevel)并横向铺开,
        //   这会制造大量“跨列的 backward edge(向上走)”,最终被迫绕外圈,读图非常糟糕。
        // - 典型形态是 A<->B(双向边)同时还存在 A->C 的分支:
        //   - B 被放到右侧同层后, B->A 就成了“向上+向左”的长边,经常需要绕外圈。
        //
        // 改良策略(只对 relaxed Unicode 启用,避免影响 strict/golden 稳定性):
        // - 若发现 parent(node) 与 child 之间存在反向边(child->node),
        //   则把 child 下沉到下一层(childLevel + gridStep),并优先与 parent 对齐同一列(x=parent.x)。
        // - 这会让双向关系更像“垂直回路”,大幅降低外圈绕行概率。
        // -----------------------------------------------------------------
        if (dir !== 'LR' && graph.config.routing === 'relaxed' && !graph.config.useAscii) {
          const hasReverseEdge = graph.edges.some(e => e.from === child && e.to === node)
          if (hasReverseEdge) {
            const bidirLevel = childLevel + gridStep
            const requested: GridCoord = { x: gc.x, y: bidirLevel + layoutMargin }
            reserveSpotInGrid(graph, graph.nodes[child.index]!, requested, gridStep)

            // 更新该层的“最高占用位置”,避免后续节点继续往同一位置挤。
            const relX = gc.x - layoutMargin
            const currentHighest = highestPositionPerLevel[bidirLevel] ?? 0
            highestPositionPerLevel[bidirLevel] = Math.max(currentHighest, relX + gridStep)

            placedSomething = true
            continue
          }
        }

        const requested: GridCoord = dir === 'LR'
          ? { x: childLevel + layoutMargin, y: highestPosition + layoutMargin }
          : { x: highestPosition + layoutMargin, y: childLevel + layoutMargin }
        reserveSpotInGrid(graph, graph.nodes[child.index]!, requested, gridStep)
        highestPositionPerLevel[childLevel] = highestPosition + gridStep
        highestPosition = highestPositionPerLevel[childLevel]!
        placedSomething = true
      }
    }

    if (placedSomething) continue

    // 如果还有没放置的节点, 说明存在:
    // - 不连通组件（且该组件没有 root, 例如纯环）
    // - 或者 rootNodes 的覆盖不足（例如所有 root 都在 subgraph 里但被 shouldSeparate 分流后没被放置）
    //
    // 此时把“按 insertion order 的第一个未放置节点”当作额外 root, 继续放置。
    const nextUnplaced = graph.nodes.find(n => n.gridCoord === null)
    if (!nextUnplaced) break

    const rootLevel = (shouldSeparate && isNodeInAnySubgraph(graph, nextUnplaced)) ? gridStep : 0
    const requested: GridCoord = dir === 'LR'
      ? { x: rootLevel + layoutMargin, y: highestPositionPerLevel[rootLevel]! + layoutMargin }
      : { x: highestPositionPerLevel[rootLevel]! + layoutMargin, y: rootLevel + layoutMargin }
    reserveSpotInGrid(graph, graph.nodes[nextUnplaced.index]!, requested, gridStep)
    highestPositionPerLevel[rootLevel] = highestPositionPerLevel[rootLevel]! + gridStep
    placedSomething = true
  }

  // 防御：理论上此处必须保证所有节点都已放置，否则后续 edge routing 会崩溃。
  // 如果仍有未放置节点，返回 false 交给外层 layoutMargin 重试（增加可用空间）。
  if (graph.nodes.some(n => n.gridCoord === null)) return false

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

  // Route edges via A*
  //
  // 重要修正(先保正确性,再谈更优排序):
  // - relaxed 目前仍然有“禁止 segment overlap”的 hard rule;
  // - 在该约束下,路由顺序会直接影响“后续边是否还有可用通道”。如果排序不当,会出现:
  //   - 某些边被迫绕到外圈形成大矩形;
  //   - 更糟的是: 某些边 path=[](不可达),导致整个 createMapping() 失败,最终输出只剩线段。
  // - 这在“同一对节点之间存在多条边(平行边/回边)”的图里尤为明显(你的复现用例就是这种结构)。
  //
  // “严格按输入顺序”虽然确定性最好,但会触发一个终端输出里最致命的可读性问题:
  // - 一条“主干边”(把节点连起来的关键边)如果在 Mermaid 文本里写得靠后,
  //   就会被迫在其它边占满通道后才开始路由,最终经常绕到画布最外圈形成“外框”。
  //
  // 因此在 Unicode relaxed 下,我们采用更贴近人类画图直觉的策略:
  // - 先路由一棵覆盖所有节点的 spanning forest(生成树主干边)；
  // - 再路由剩余的回边/补充边。
  //
  // 这样做的直觉收益:
  // - 主干边更直、更短、更靠内圈,减少“外框”；
  // - 回边即使绕一点,也更像“围绕主干的反馈箭头”,而不是把整张图框起来。
  //
  // 约束与风险控制:
  // - 仅对 Unicode relaxed 启用(控影响面)；
  // - 在同一优先级内仍保持 insertion order(保证确定性)；
  // - 如果排序导致不可达,外层仍会通过 layoutMargin 重试与最后一次 unconstrained fallback 兜底。
  function computeEdgesForRoutingSpanningForestFirst(): AsciiEdge[] {
    // 入度统计: 用于找 root(无入边节点)。
    const incomingCount = new Map<string, number>()
    for (const node of graph.nodes) incomingCount.set(node.name, 0)
    for (const edge of graph.edges) {
      incomingCount.set(edge.to.name, (incomingCount.get(edge.to.name) ?? 0) + 1)
    }

    // 出边邻接表: 保持 insertion order,保证最终排序确定性。
    const outgoingByNode = new Map<string, AsciiEdge[]>()
    for (const edge of graph.edges) {
      const list = outgoingByNode.get(edge.from.name)
      if (list) {
        list.push(edge)
      } else {
        outgoingByNode.set(edge.from.name, [edge])
      }
    }

    const roots: AsciiNode[] = []
    for (const node of graph.nodes) {
      if ((incomingCount.get(node.name) ?? 0) === 0) roots.push(node)
    }

    // 纯环/无 root 的图: 用 insertion order 的第一个节点作为 root,继续生成 spanning forest。
    if (roots.length === 0 && graph.nodes.length > 0) roots.push(graph.nodes[0]!)

    const visited = new Set<string>()
    const primary = new Set<AsciiEdge>()
    const queue: AsciiNode[] = []

    const pushRoot = (node: AsciiNode) => {
      if (visited.has(node.name)) return
      visited.add(node.name)
      queue.push(node)
    }

    for (const root of roots) pushRoot(root)

    // BFS 构建 spanning forest:
    // - 每次遇到一个“未访问的 to 节点”,就把这条边作为主干边(primary)。
    let queueIndex = 0
    while (true) {
      while (queueIndex < queue.length) {
        const node = queue[queueIndex++]!
        const outs = outgoingByNode.get(node.name) ?? []
        for (const edge of outs) {
          if (visited.has(edge.to.name)) continue
          primary.add(edge)
          pushRoot(edge.to)
        }
      }

      if (visited.size >= graph.nodes.length) break
      const next = graph.nodes.find(n => !visited.has(n.name))
      if (!next) break
      pushRoot(next)
    }

    const primaryEdges: AsciiEdge[] = []
    const secondaryEdges: AsciiEdge[] = []
    for (const edge of graph.edges) {
      if (primary.has(edge)) {
        primaryEdges.push(edge)
      } else {
        secondaryEdges.push(edge)
      }
    }

    return primaryEdges.concat(secondaryEdges)
  }

  const edgesForRouting: AsciiEdge[] =
    graph.config.routing === 'relaxed' && !graph.config.useAscii
      ? computeEdgesForRoutingSpanningForestFirst()
      : graph.edges

  // -------------------------------------------------------------------------
  // Bundle trunk（同端点多边共享主干）
  //
  // 目标(最佳方案第一步):
  // - 对同一对端点(from,to)的多条边,先路由一条“主干边”；
  // - 其余边直接复用主干 path,把复杂度集中到两端 fanout/fanin(由 comb ports 处理)。
  //
  // 这样做的收益:
  // - 避免同端点平行边各自做 A* 竞争,减少“线束抖动”与大回环概率；
  // - 让图形读感更像“一条关系主干 + 多个事件标签”,而不是多条互抢通道的线团。
  //
  // 影响面控制:
  // - 仅在 Unicode relaxed 启用(ASCII/strict 不动)；
  // - 只对 group.size >= 2 的同端点边生效。
  // -------------------------------------------------------------------------
  function bundleKey(edge: AsciiEdge): string {
    return `${edge.from.name}→${edge.to.name}`
  }

  function cloneEdgePathFromLeader(leader: AsciiEdge, follower: AsciiEdge): void {
    // 深拷贝坐标,避免后续步骤误改同一数组引用。
    follower.path = leader.path.map(p => ({ x: p.x, y: p.y }))

    // 复制端口方向,确保后续 comb ports 分配仍然基于同一主干拓扑。
    follower.startDir = { x: leader.startDir.x, y: leader.startDir.y }
    follower.endDir = { x: leader.endDir.x, y: leader.endDir.y }

    // 端口 offset 在 comb ports 阶段重新分配,这里先清空为 undefined。
    follower.startPortOffsetX = undefined
    follower.startPortOffsetY = undefined
    follower.endPortOffsetX = undefined
    follower.endPortOffsetY = undefined
  }

  const enableBundleTrunk = graph.config.routing === 'relaxed' && !graph.config.useAscii
  const edgesByBundle = new Map<string, AsciiEdge[]>()
  if (enableBundleTrunk) {
    for (const edge of edgesForRouting) {
      const key = bundleKey(edge)
      const list = edgesByBundle.get(key)
      if (list) {
        list.push(edge)
      } else {
        edgesByBundle.set(key, [edge])
      }
    }
  }
  const bundleLeaderByKey = new Map<string, AsciiEdge>()

  // 无约束 fallback 的触发时机必须非常谨慎：
  // - 它会放开 usedPoints/segmentUsage 约束,很容易引入“共享走线/误连线”的可读性灾难；
  // - 但在极端不可达场景下,它能保证图至少“有路可画”,不会直接渲染失败。
  //
  // 取舍：
  // - 先让 layoutMargin 重试去解决几何不可达(用户也明确偏好“宁愿更大,不要并线”)；
  // - 只有在最后一次 margin 尝试时,才允许 fallback 兜底,保证可用性。
  const allowUnconstrainedFallback = layoutMargin >= 4

  for (const edge of edgesForRouting) {
    if (enableBundleTrunk) {
      const key = bundleKey(edge)
      const group = edgesByBundle.get(key) ?? []

      if (group.length >= 2) {
        const leader = bundleLeaderByKey.get(key)
        if (!leader) {
          // 同端点组的第一条边: 作为主干边正常做一次 A*。
          determinePath(
            graph,
            edge,
            aStar,
            baseMaxX,
            baseMaxY,
            segmentUsage,
            usedPoints,
            allowUnconstrainedFallback,
          )

          // 只有“可绘制主干”(至少 2 点)才纳入 leader。
          // 否则让后续边继续独立路由,避免把空路径扩散给整组。
          if (edge.path.length >= 2) {
            bundleLeaderByKey.set(key, edge)
          }
          increaseGridSizeForPath(graph, edge.path)
          continue
        }

        if (leader.path.length >= 2) {
          // 复用主干: follower 不再重复做 A*。
          cloneEdgePathFromLeader(leader, edge)
          increaseGridSizeForPath(graph, edge.path)
          continue
        }
      }
    }

    determinePath(
      graph,
      edge,
      aStar,
      baseMaxX,
      baseMaxY,
      segmentUsage,
      usedPoints,
      allowUnconstrainedFallback,
    )
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

    function dirToSide(
      d: { x: number; y: number },
      node: GridCoord | null | undefined,
      other: GridCoord | null | undefined,
    ): Side | null {
      // 四边端口: 直接映射。
      if (d.x === 1 && d.y === 0) return 'up'
      if (d.x === 1 && d.y === 2) return 'down'
      if (d.x === 0 && d.y === 1) return 'left'
      if (d.x === 2 && d.y === 1) return 'right'

      // 角落端口(兜底候选): 在“相邻两条边”中选择更接近对方的那条边。
      //
      // 背景:
      // - relaxed + Unicode 默认不希望走 corner port,但在“几何上不可达”时仍会作为最后兜底出现；
      // - 如果 comb ports 统计/扩容/offset 分配忽略 corner port,会导致:
      //   - node 边长不足(端口挤在 3 行/3 列内),用户看到的就是“边接不到/断线/绕路”；
      //   - 更糟的是,corner port 会让线路贴角,更容易制造 `┼` 冲突。
      //
      // 做法:
      // - corner port 同时属于水平/垂直两条边；
      // - 我们用“相对位移的主轴(|dx| vs |dy|)”决定把它算到哪条边上,从而:
      //   - 让 box 自适应扩容更符合真实拥挤度；
      //   - 让 offset 分配更接近“最近边出线/入线”的直觉。
      if (!node || !other) return null

      const dx = other.x - node.x
      const dy = other.y - node.y
      const preferHorizontal = Math.abs(dx) >= Math.abs(dy)

      // UpperRight: (up,right)
      if (d.x === 2 && d.y === 0) return preferHorizontal ? 'right' : 'up'
      // UpperLeft: (up,left)
      if (d.x === 0 && d.y === 0) return preferHorizontal ? 'left' : 'up'
      // LowerRight: (down,right)
      if (d.x === 2 && d.y === 2) return preferHorizontal ? 'right' : 'down'
      // LowerLeft: (down,left)
      if (d.x === 0 && d.y === 2) return preferHorizontal ? 'left' : 'down'

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

      const startSide = dirToSide(edge.startDir, edge.from.gridCoord, edge.to.gridCoord)
      const endSide = dirToSide(edge.endDir, edge.to.gridCoord, edge.from.gridCoord)

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

    // 2) box 自适应扩容：确保 content 宽/高 >= 端口数量，并为拥挤节点增加 breathing room
    //
    // 设计取舍:
    // - 我们刻意不改“node 外侧 padding 列/行”，因为那会改变 grid 的几何结构,
    //   进而影响 A* 的可达性与路径选择(容易引入绕路回归)。
    // - 这里仅扩大 node 自身的 content cell(绘制层容量):
    //   - comb ports 的 lane 会按 contentWidth/contentHeight 分散;
    //   - 当端口数很多时,额外增加 1~N 的容量能显著降低“挤在一起导致字符合并/label 覆盖”的概率。
    //
    // 这满足用户诉求:
    // - "对拥挤节点按需增加 lane/margin"
    // - "如果 box 不够大 就要扩大 box"
    for (const node of graph.nodes) {
      if (!node.gridCoord) continue

      const counts = endpointsByNode[node.index]!

      const borderPadding = graph.config.boxBorderPadding
      const baseContentWidth = 2 * borderPadding + textDisplayWidth(node.displayLabel)
      const baseContentHeight = 1 + 2 * borderPadding

      const maxHorizontalPorts = Math.max(counts.up.length, counts.down.length)
      const maxVerticalPorts = Math.max(counts.left.length, counts.right.length)

      function extraCapacityForPorts(portCount: number): number {
        // 0~3 条边: 不扩容(避免影响常见小图的 golden)
        if (portCount <= 3) return 0

        // 4~5 => +1, 6~7 => +2, 8~9 => +3 ...
        //
        // 经验值:
        // - 这会让 lane 之间自然出现空隙,减少线段/箭头/label 互相覆盖;
        // - 上限避免超大 node 把图撑得过宽。
        const extra = Math.floor((portCount - 3 + 1) / 2)
        return Math.min(4, extra)
      }

      const requiredContentWidth = Math.max(
        baseContentWidth,
        maxHorizontalPorts + extraCapacityForPorts(maxHorizontalPorts),
      )
      const requiredContentHeight = Math.max(
        baseContentHeight,
        maxVerticalPorts + extraCapacityForPorts(maxVerticalPorts),
      )

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
          let offset = offsets[i]!

          // -----------------------------------------------------------------
          // 单端口偏移(nudge): 解决“不同边在画布中部对齐导致误连线”的可读性问题
          //
          // 现象(用户反馈):
          // - 当某个 node 在某个 side 只有 1 条边时,旧逻辑会把 offset 固定在 center；
          // - 在拥挤图里,多个 node 的“center lane”很容易在画布中部重合,
          //   形成 `◄──┴──►` 这类“共享走线”的视觉假象(读者会误以为存在一条双向边)。
          //
          // 策略(先能用,风险可控):
          // - 仅对 list.length===1 的 side 做一个 1 格的确定性 nudge；
          // - nudge 方向取决于 side + kind(start/end):
          //   - left/up: 默认往 -1 偏移; right/down: 默认往 +1 偏移；
          //   - start/end 取相反方向,让出边与入边更不容易在同一条 lane 对齐。
          //
          // 说明:
          // - 这不会影响 A* 路由(仍然是 3x3 block),只改变绘制层的 lane 选择；
          // - clamp 后保证不会越界写到别的 cell,避免字符画错乱。
          // -----------------------------------------------------------------
          if (list.length === 1 && capacity >= 2) {
            let delta = (side === 'left' || side === 'up') ? -1 : 1
            if (ep.kind === 'start') delta = -delta
            const nudged = offset + delta
            if (nudged < 0) offset = 0
            else if (nudged > capacity - 1) offset = capacity - 1
            else offset = nudged
          }

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
