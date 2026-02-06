// ============================================================================
// ASCII renderer — type definitions
//
// Ported from AlexanderGrooff/mermaid-ascii (Go).
// These types model the grid-based coordinate system, 2D text canvas,
// and graph structures used by the ASCII/Unicode renderer.
// ============================================================================

/** Logical grid coordinate — nodes occupy 3x3 blocks on this grid. */
export interface GridCoord {
  x: number
  y: number
}

/** Character-level coordinate on the 2D text canvas. */
export interface DrawingCoord {
  x: number
  y: number
}

/**
 * Direction constants model positions on a node's 3x3 grid block.
 * Each node occupies grid cells [x..x+2, y..y+2].
 * Directions are offsets into that block, used for edge attachment points.
 *
 *   (0,0) UL   (1,0) Up   (2,0) UR
 *   (0,1) Left (1,1) Mid  (2,1) Right
 *   (0,2) LL   (1,2) Down (2,2) LR
 */
export interface Direction {
  readonly x: number
  readonly y: number
}

export const Up: Direction         = { x: 1, y: 0 }
export const Down: Direction       = { x: 1, y: 2 }
export const Left: Direction       = { x: 0, y: 1 }
export const Right: Direction      = { x: 2, y: 1 }
export const UpperRight: Direction = { x: 2, y: 0 }
export const UpperLeft: Direction  = { x: 0, y: 0 }
export const LowerRight: Direction = { x: 2, y: 2 }
export const LowerLeft: Direction  = { x: 0, y: 2 }
export const Middle: Direction     = { x: 1, y: 1 }

/** All named directions for iteration. */
export const ALL_DIRECTIONS: readonly Direction[] = [
  Up, Down, Left, Right, UpperRight, UpperLeft, LowerRight, LowerLeft, Middle,
]

/**
 * 2D text canvas — column-major (canvas[x][y]).
 * Each cell holds a single character (or space).
 */
export type Canvas = string[][]

/** A node in the ASCII graph, positioned on the grid. */
export interface AsciiNode {
  /** Unique identity key — the original node ID from the parser (e.g. "A", "B"). */
  name: string
  /** Human-readable label for rendering inside the box (e.g. "Web Server"). */
  displayLabel: string
  index: number
  gridCoord: GridCoord | null
  drawingCoord: DrawingCoord | null
  drawing: Canvas | null
  drawn: boolean
  styleClassName: string
  styleClass: AsciiStyleClass
}

/** Style class for colored node text (ported from Go's classDef). */
export interface AsciiStyleClass {
  name: string
  styles: Record<string, string>
}

/** An edge in the ASCII graph, with a routed path. */
export interface AsciiEdge {
  from: AsciiNode
  to: AsciiNode
  text: string
  path: GridCoord[]
  labelLine: GridCoord[]
  startDir: Direction
  endDir: Direction

  // -------------------------------------------------------------------------
  // Comb ports（梳子口端口）——仅用于 Unicode relaxed 的“可读性优先”绘制层
  //
  // 目标：
  // - 让边的出入口不再局限于 8 个端口；
  // - 在不改动 grid A*（也不依赖 Rust native pathfinder 变更）的前提下，
  //   通过“在同一格内部选择不同 lane（偏移）”来实现沿边框多点分布。
  //
  // 说明：
  // - offset 是 **0-based**，表示“在该 grid cell 的宽/高范围内的偏移”：
  //   - X offset：0..(columnWidth[col]-1)
  //   - Y offset：0..(rowHeight[row]-1)
  // - 对于 Left/Right 端口：我们只需要 Y offset（沿 box 竖边分布）
  // - 对于 Up/Down 端口：我们只需要 X offset（沿 box 横边分布）
  // -------------------------------------------------------------------------

  /** 出边端口的 X 偏移（Up/Down 端口用）。 */
  startPortOffsetX?: number
  /** 出边端口的 Y 偏移（Left/Right 端口用）。 */
  startPortOffsetY?: number
  /** 入边端口的 X 偏移（Up/Down 端口用）。 */
  endPortOffsetX?: number
  /** 入边端口的 Y 偏移（Left/Right 端口用）。 */
  endPortOffsetY?: number
}

/** A subgraph container with bounding box for rendering. */
export interface AsciiSubgraph {
  name: string
  nodes: AsciiNode[]
  parent: AsciiSubgraph | null
  children: AsciiSubgraph[]
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** Configuration for ASCII rendering. */
export interface AsciiConfig {
  /** true = ASCII chars (+,-,|), false = Unicode box-drawing (┌,─,│). Default: false */
  useAscii: boolean
  /** Horizontal spacing between nodes. Default: 5 */
  paddingX: number
  /** Vertical spacing between nodes. Default: 5 */
  paddingY: number
  /** Padding inside node boxes. Default: 1 */
  boxBorderPadding: number
  /** Graph direction: "LR" or "TD". */
  graphDirection: 'LR' | 'TD'

  /**
   * 路由模式：
   * - strict：规整/可逆优先（尽量避免交叉与非法共线复用，代价是可能绕远）
   * - relaxed：可读性优先（允许交叉/复用，但会用惩罚项尽量减少“太乱”的路径）
   */
  routing: 'strict' | 'relaxed'
}

/** Full ASCII graph state used during layout and rendering. */
export interface AsciiGraph {
  nodes: AsciiNode[]
  edges: AsciiEdge[]
  canvas: Canvas
  /** Grid occupancy map — maps "x,y" keys to node references. */
  grid: Map<string, AsciiNode>
  columnWidth: Map<number, number>
  rowHeight: Map<number, number>
  subgraphs: AsciiSubgraph[]
  config: AsciiConfig
  /** Offset applied to all drawing coords to accommodate subgraph borders. */
  offsetX: number
  offsetY: number

  /**
   * relaxed 路由专用：端口占用统计（用于让多条边分散出入点，减少重叠）。
   *
   * 索引规则：
   * - portIdx = dir.x + dir.y * 3（dir 来自 3x3 端口坐标系）
   * - idx = node.index * 9 + portIdx
   */
  portUsage?: Uint16Array

  // -------------------------------------------------------------------------
  // grid → drawing 坐标换算缓存（prefix-sum）
  //
  // 背景：
  // - `gridToDrawingCoord*` 需要频繁做“从 0 累加到目标列/行”的求和；
  // - 对于边较多/路径较长的图，这会导致 O(N^2) 的热点（尤其在 QuickJS 无 JIT 场景）。
  //
  // 做法：
  // - 在 grid layout 完成（columnWidth/rowHeight 最终确定）后，预计算前缀和：
  //   - columnStartX[col] = Σ width[0..col-1]
  //   - rowStartY[row]    = Σ height[0..row-1]
  // - 渲染阶段直接 O(1) 查表拿 origin，再叠加 cell 内 offset（center 或 comb lane）。
  // -------------------------------------------------------------------------

  /** 每列的绘制起始 X（不含 graph.offsetX）。 */
  columnStartX?: Int32Array
  /** 每行的绘制起始 Y（不含 graph.offsetY）。 */
  rowStartY?: Int32Array
}

// ============================================================================
// 对外暴露的 meta 类型（用于稳定的 cell 级上色/动画）
// ============================================================================

/** 画布上的包围盒，单位是终端 cell 坐标。 */
export interface AsciiBox {
  x: number
  y: number
  width: number
  height: number
}

/** 节点的渲染元信息（用于 UI 高亮）。 */
export interface AsciiRenderMetaNode {
  /** Mermaid 的节点 id（解析器语义），例如 "Hat_planner"。 */
  id: string
  /** 节点框内最终渲染出来的 label 文本。 */
  label: string
  /** 节点框在最终画布上的包围盒。 */
  box: AsciiBox
}

/** 边的渲染元信息（用于 UI 动画）。 */
export interface AsciiRenderMetaEdge {
  /** source 节点 id。 */
  from: string
  /** target 节点 id。 */
  to: string
  /** 边的 label 文本。 */
  label: string
  /**
   * 组成边“笔画”的画布坐标列表（有序）。
   * 在需要时会包含 corner/arrowhead/box-start marker 等关键 cell。
   *
   * 典型用途：按 source → target 做逐格高亮/播放。
   */
  path: DrawingCoord[]
}

/** ASCII/Unicode 渲染的完整元信息。 */
export interface AsciiRenderMeta {
  nodes: AsciiRenderMetaNode[]
  edges: AsciiRenderMetaEdge[]
}

/** meta-aware 渲染的返回值。 */
export interface AsciiRenderWithMeta {
  text: string
  meta: AsciiRenderMeta
}

// ============================================================================
// Coordinate helpers
// ============================================================================

export function gridCoordEquals(a: GridCoord, b: GridCoord): boolean {
  return a.x === b.x && a.y === b.y
}

export function drawingCoordEquals(a: DrawingCoord, b: DrawingCoord): boolean {
  return a.x === b.x && a.y === b.y
}

/** Apply a direction offset to a grid coordinate (move into the 3x3 block). */
export function gridCoordDirection(c: GridCoord, dir: Direction): GridCoord {
  return { x: c.x + dir.x, y: c.y + dir.y }
}

/** Key for storing GridCoord in a Map. */
export function gridKey(c: GridCoord): string {
  return `${c.x},${c.y}`
}

/** Default empty style class. */
export const EMPTY_STYLE: AsciiStyleClass = { name: '', styles: {} }
