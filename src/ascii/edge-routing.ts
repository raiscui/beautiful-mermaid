// ============================================================================
// ASCII renderer — direction system and edge path determination
//
// Ported from AlexanderGrooff/mermaid-ascii cmd/direction.go + cmd/mapping_edge.go.
// Handles direction constants, edge attachment point selection,
// and dual-path comparison for optimal edge routing.
// ============================================================================

import type { GridCoord, Direction, AsciiEdge, AsciiGraph, AsciiNode } from './types.ts'
import {
  Up, Down, Left, Right, UpperRight, UpperLeft, LowerRight, LowerLeft, Middle,
  gridCoordDirection,
  gridCoordEquals,
} from './types.ts'
import { getPath, getPathStrict, mergePath, gridCoordToIdx, idxToGridCoord, mergePathIdx, mergePathLengthIdx, type AStarContext, type StrictPathConstraints } from './pathfinder.ts'
import { textDisplayWidth } from './canvas.ts'

// ============================================================================
// A* bounds strategy（供 grid.ts 预分配缓存用）
// ============================================================================

export const ROUTING_BOUNDS_EXPAND_STEPS_FAST = [12, 24, 48] as const
export const ROUTING_BOUNDS_EXPAND_STEPS_FULL = [12, 24, 48, 96, 192, 384] as const
export const ROUTING_MAX_BOUNDS_EXPAND_BY = ROUTING_BOUNDS_EXPAND_STEPS_FULL[ROUTING_BOUNDS_EXPAND_STEPS_FULL.length - 1]

// ============================================================================
// Direction utilities
// ============================================================================

export function getOpposite(d: Direction): Direction {
  if (d === Up) return Down
  if (d === Down) return Up
  if (d === Left) return Right
  if (d === Right) return Left
  if (d === UpperRight) return LowerLeft
  if (d === UpperLeft) return LowerRight
  if (d === LowerRight) return UpperLeft
  if (d === LowerLeft) return UpperRight
  return Middle
}

/** Compare directions by value (not reference). */
export function dirEquals(a: Direction, b: Direction): boolean {
  return a.x === b.x && a.y === b.y
}

/**
 * Determine 8-way direction from one coordinate to another.
 * Uses the coordinate difference to pick one of 8 cardinal/ordinal directions.
 */
export function determineDirection(from: { x: number; y: number }, to: { x: number; y: number }): Direction {
  if (from.x === to.x) {
    return from.y < to.y ? Down : Up
  } else if (from.y === to.y) {
    return from.x < to.x ? Right : Left
  } else if (from.x < to.x) {
    return from.y < to.y ? LowerRight : UpperRight
  } else {
    return from.y < to.y ? LowerLeft : UpperLeft
  }
}

// ============================================================================
// Start/end direction selection for edges
// ============================================================================

/** Self-reference routing (node points to itself). */
function selfReferenceDirection(graphDirection: string): [Direction, Direction, Direction, Direction] {
  if (graphDirection === 'LR') return [Right, Down, Down, Right]
  return [Down, Right, Right, Down]
}

/**
 * Determine preferred and alternative start/end directions for an edge.
 * Returns [preferredStart, preferredEnd, alternativeStart, alternativeEnd].
 *
 * The edge routing tries both pairs and picks the shorter path.
 * Direction selection depends on relative node positions and graph direction (LR vs TD).
 */
export function determineStartAndEndDir(
  edge: AsciiEdge,
  graphDirection: string,
): [Direction, Direction, Direction, Direction] {
  if (edge.from === edge.to) return selfReferenceDirection(graphDirection)

  const d = determineDirection(edge.from.gridCoord!, edge.to.gridCoord!)

  let preferredDir: Direction
  let preferredOppositeDir: Direction
  let alternativeDir: Direction
  let alternativeOppositeDir: Direction

  const isBackwards = graphDirection === 'LR'
    ? (dirEquals(d, Left) || dirEquals(d, UpperLeft) || dirEquals(d, LowerLeft))
    : (dirEquals(d, Up) || dirEquals(d, UpperLeft) || dirEquals(d, UpperRight))

  if (dirEquals(d, LowerRight)) {
    if (graphDirection === 'LR') {
      preferredDir = Down; preferredOppositeDir = Left
      alternativeDir = Right; alternativeOppositeDir = Up
    } else {
      preferredDir = Right; preferredOppositeDir = Up
      alternativeDir = Down; alternativeOppositeDir = Left
    }
  } else if (dirEquals(d, UpperRight)) {
    if (graphDirection === 'LR') {
      preferredDir = Up; preferredOppositeDir = Left
      alternativeDir = Right; alternativeOppositeDir = Down
    } else {
      preferredDir = Right; preferredOppositeDir = Down
      alternativeDir = Up; alternativeOppositeDir = Left
    }
  } else if (dirEquals(d, LowerLeft)) {
    if (graphDirection === 'LR') {
      preferredDir = Down; preferredOppositeDir = Down
      alternativeDir = Left; alternativeOppositeDir = Up
    } else {
      preferredDir = Left; preferredOppositeDir = Up
      alternativeDir = Down; alternativeOppositeDir = Right
    }
  } else if (dirEquals(d, UpperLeft)) {
    if (graphDirection === 'LR') {
      preferredDir = Down; preferredOppositeDir = Down
      alternativeDir = Left; alternativeOppositeDir = Down
    } else {
      preferredDir = Right; preferredOppositeDir = Right
      alternativeDir = Up; alternativeOppositeDir = Right
    }
  } else if (isBackwards) {
    if (graphDirection === 'LR' && dirEquals(d, Left)) {
      preferredDir = Down; preferredOppositeDir = Down
      alternativeDir = Left; alternativeOppositeDir = Right
    } else if (graphDirection === 'TD' && dirEquals(d, Up)) {
      preferredDir = Right; preferredOppositeDir = Right
      alternativeDir = Up; alternativeOppositeDir = Down
    } else {
      preferredDir = d; preferredOppositeDir = getOpposite(d)
      alternativeDir = d; alternativeOppositeDir = getOpposite(d)
    }
  } else {
    // Default: go in the natural direction
    preferredDir = d; preferredOppositeDir = getOpposite(d)
    alternativeDir = d; alternativeOppositeDir = getOpposite(d)
  }

  return [preferredDir, preferredOppositeDir, alternativeDir, alternativeOppositeDir]
}

// ============================================================================
// Edge path determination
// ============================================================================

// ============================================================================
// Edge segment overlap rules（避免“不同 source/target 的边共线”）
//
// 目标（用户需求）：
// - 相同 source 的边：允许在“起点段”共线（从 source 出发的第一段可以共用）
// - 相同 target 的边：允许在“终点段”共线（进入 target 的最后一段可以共用）
// - 其它情况：尽量不复用同一段线（不共线）
//
// 实现策略：
// - 在 A* 的移动代价函数里加入“已用线段”的约束：
//   - 默认：未被占用的线段，正常可走（代价=1）
//   - 已占用且“允许共线”（同源起点段 / 同靶终点段）：可走（代价=1）
//   - 已占用但“不允许共线”：优先“硬禁止”（返回 null），不可达时再降级为“强惩罚”路由
// ============================================================================

export interface SegmentUsageMap {
  /**
   * segmentUsed[key] = 1 表示该 segment 被任意边使用过（start/end/middle 任一即可）。
   *
   * 说明：
   * - moveCost 的热路径里需要非常快地判定“有没有被占用过”；
   * - 用 Uint8Array 替代 Map.get() 能显著加速 QuickJS 场景。
   */
  segmentUsed: Uint8Array

  /** usedAsMiddle[key] = 1 表示曾作为“中间段”使用过（永不允许共享）。 */
  usedAsMiddle: Uint8Array

  /**
   * startSource[key] = sourceId（1-based），0 表示没有 startSource。
   *
   * 用 1-based 的原因：
   * - AsciiNode.index 是 0-based；
   * - Uint32Array 默认值为 0，正好可当作“未设置”的 sentinel。
   */
  startSource: Uint32Array
  startSourceMulti: Uint8Array

  /** endTarget[key] = targetId（1-based），0 表示没有 endTarget。 */
  endTarget: Uint32Array
  endTargetMulti: Uint8Array

  /** 已出现过的 segment 数量（用于快速判断“是否启用 strict 路由”）。 */
  usedCount: number
}

export function makeSegmentUsageMap(cellCount: number): SegmentUsageMap {
  const segmentCount = cellCount * 2
  return {
    segmentUsed: new Uint8Array(segmentCount),
    usedAsMiddle: new Uint8Array(segmentCount),
    startSource: new Uint32Array(segmentCount),
    startSourceMulti: new Uint8Array(segmentCount),
    endTarget: new Uint32Array(segmentCount),
    endTargetMulti: new Uint8Array(segmentCount),
    usedCount: 0,
  }
}

/**
 * 已占用的“通路点”（grid cell）。
 *
 * 目标（用户需求）：
 * - 避免出现“┼”这种交叉点：它会让人误以为线路连接，读图非常痛苦。
 * - 当线路密度过大时，宁愿绕远/扩大网格，也不要把两条边挤进同一个 cell。
 *
 * 实现策略：
 * - 我们只“硬禁止”会产生 **交叉（horizontal ⟂ vertical）** 的 point overlap。
 * - 同方向（horizontal ∥ horizontal / vertical ∥ vertical）的 point overlap 不一定产生“┼”，
 *   且在一些图（自环/回边/拥挤端口）里是必要的，否则会把某些端口彻底堵死。
 * - 节点自身占用的 3x3 区域不纳入该集合（否则会把 node 边界点也禁掉，导致边无法入/出）。
 */
export type UsedPointSet = Uint8Array

const CONNECT_LEFT = 1 << 0
const CONNECT_RIGHT = 1 << 1
const CONNECT_UP = 1 << 2
const CONNECT_DOWN = 1 << 3

/** 把一条 unit segment（相邻两格）压缩成稳定 key（无向、可快速计算）。 */
function segmentKey(fromIdx: number, toIdx: number): number {
  const diff = toIdx - fromIdx
  const isHorizontal = diff === 1 || diff === -1
  const smaller = fromIdx < toIdx ? fromIdx : toIdx
  return smaller * 2 + (isHorizontal ? 0 : 1)
}

/** 记录某条边的路径占用了哪些 unit segments（用于后续边避让）。 */
function recordPathSegments(usageMap: SegmentUsageMap, edge: AsciiEdge, pathIdx: number[]): void {
  if (pathIdx.length < 2) return

  const edgeFromId = edge.from.index + 1
  const edgeToId = edge.to.index + 1

  for (let i = 1; i < pathIdx.length; i++) {
    const fromIdx = pathIdx[i - 1]!
    const toIdx = pathIdx[i]!
    const key = segmentKey(fromIdx, toIdx)
    const isStartSegment = i === 1
    const isEndSegment = i === pathIdx.length - 1

    if (!usageMap.segmentUsed[key]) {
      usageMap.segmentUsed[key] = 1
      usageMap.usedCount++
    }

    if (isStartSegment) {
      const current = usageMap.startSource[key]!
      if (current === 0) usageMap.startSource[key] = edgeFromId
      else if (current !== edgeFromId) usageMap.startSourceMulti[key] = 1
    }

    if (isEndSegment) {
      const current = usageMap.endTarget[key]!
      if (current === 0) usageMap.endTarget[key] = edgeToId
      else if (current !== edgeToId) usageMap.endTargetMulti[key] = 1
    }

    if (!isStartSegment && !isEndSegment) usageMap.usedAsMiddle[key] = 1
  }
}

/** 把一步移动映射为“在 from/to 两端各新增哪个连通方向”（bitmask 版）。 */
function stepToConnectionBits(
  stepFromIdx: number,
  stepToIdx: number,
  stride: number,
): { fromBit: number; toBit: number } | null {
  const diff = stepToIdx - stepFromIdx
  if (diff === 1) return { fromBit: CONNECT_RIGHT, toBit: CONNECT_LEFT }
  if (diff === -1) return { fromBit: CONNECT_LEFT, toBit: CONNECT_RIGHT }
  if (diff === stride) return { fromBit: CONNECT_DOWN, toBit: CONNECT_UP }
  if (diff === -stride) return { fromBit: CONNECT_UP, toBit: CONNECT_DOWN }
  return null
}

/** 记录一条边占用过的所有 free cell，用于后续边避让“交叉（┼）”。 */
function recordPathPoints(usedPoints: UsedPointSet, ctx: AStarContext, pathIdx: number[]): void {
  if (pathIdx.length < 2) return

  const stride = ctx.stride

  for (let i = 1; i < pathIdx.length; i++) {
    const fromIdx = pathIdx[i - 1]!
    const toIdx = pathIdx[i]!
    const bits = stepToConnectionBits(fromIdx, toIdx, stride)
    if (!bits) continue

    // 只记录“非节点占用”的格子：
    // - 节点 3x3 区域（包含边界）在 blocked=1
    // - 节点内部/边界点允许被多条边复用（入边/出边），否则会把路由器逼到死角
    if (!ctx.blocked[fromIdx]) {
      usedPoints[fromIdx] = usedPoints[fromIdx]! | bits.fromBit
    }

    if (!ctx.blocked[toIdx]) {
      usedPoints[toIdx] = usedPoints[toIdx]! | bits.toBit
    }
  }
}

/**
 * 是否会形成“四向交叉”（Unicode: `┼`）。
 *
 * 关键取舍（用户反馈后调整）：
 * - `┼` 在 box-drawing 语义里等价“四向真实连接”，对 Flowchart/State 会造成强歧义；
 * - 但像 `┬/┴/├/┤` 这类 **T junction** 在“同源分叉 / 同靶汇入”场景下是可读的，
 *   用户明确表示这类场景不需要强行绕开。
 *
 * 因此这里不再禁止“任何水平+垂直混合”，而是只禁止会形成 `┼` 的四向交叉。
 */
function wouldBecomeCrossAfterSetting(mask: number, bit: number): boolean {
  const next = mask | bit
  const hasHorizontalThrough = (next & CONNECT_LEFT) !== 0 && (next & CONNECT_RIGHT) !== 0
  const hasVerticalThrough = (next & CONNECT_UP) !== 0 && (next & CONNECT_DOWN) !== 0
  return hasHorizontalThrough && hasVerticalThrough
}

/**
 * 是否允许走进一个“已占用的 free cell”。
 *
 * 说明：
 * - 这不是 A* 的热路径（主路由使用 `getPathStrict`），仅用于 deterministic self-loop 的可行性校验。
 * - 所以这里更优先“语义正确 + 与严格路由规则一致”，性能只需做到不离谱即可。
 */
function isAllowedToEnterUsedPoint(
  ctx: AStarContext,
  usedPoints: UsedPointSet | undefined,
  stepFromIdx: number,
  stepToIdx: number,
): boolean {
  if (!usedPoints) return true

  const bits = stepToConnectionBits(stepFromIdx, stepToIdx, ctx.stride)
  if (!bits) return true

  if (!ctx.blocked[stepFromIdx]) {
    const mask = usedPoints[stepFromIdx]!
    if (mask !== 0 && wouldBecomeCrossAfterSetting(mask, bits.fromBit)) return false
  }

  if (!ctx.blocked[stepToIdx]) {
    const mask = usedPoints[stepToIdx]!
    if (mask !== 0 && wouldBecomeCrossAfterSetting(mask, bits.toBit)) return false
  }

  return true
}

function isAllowedToShareSegmentStrict(
  usageMap: SegmentUsageMap,
  edgeFromId: number,
  edgeToId: number,
  routeFromIdx: number,
  routeToIdx: number,
  stepFromIdx: number,
  stepToIdx: number,
  segKey: number,
): boolean {
  // 一旦有边把这段当“中间段”用过，那么任何共享都会让语义变得更难读。
  if (usageMap.usedAsMiddle[segKey]) return false

  const isStartStep = stepFromIdx === routeFromIdx
  const isEndStep = stepToIdx === routeToIdx

  const startSource = usageMap.startSource[segKey]!
  const endTarget = usageMap.endTarget[segKey]!
  const startSourceMulti = usageMap.startSourceMulti[segKey]! !== 0
  const endTargetMulti = usageMap.endTargetMulti[segKey]! !== 0

  // 特殊情况：from 与 to 紧挨着时，这一段既是起点段也是终点段。
  // 我们只允许“同源 + 同靶”的边共享它（例如多条平行边），避免引入混淆。
  if (isStartStep && isEndStep) {
    const startOk = !startSourceMulti && (startSource === 0 || startSource === edgeFromId)
    const endOk = !endTargetMulti && (endTarget === 0 || endTarget === edgeToId)
    return startOk && endOk
  }

  // 同源：只允许“起点段”共线，并且该段只能属于这一类起点共享（不能混入其它 target/end 共享）
  if (isStartStep) {
    return !endTargetMulti
      && endTarget === 0
      && !startSourceMulti
      && startSource === edgeFromId
  }

  // 同靶：只允许“终点段”共线，并且该段只能属于这一类终点共享
  if (isEndStep) {
    return !startSourceMulti
      && startSource === 0
      && !endTargetMulti
      && endTarget === edgeToId
  }

  return false
}

/**
 * Determine the path for an edge by trying two candidate routes (preferred + alternative)
 * and picking the shorter one. Sets edge.path, edge.startDir, edge.endDir.
 */
export function determinePath(
  graph: AsciiGraph,
  edge: AsciiEdge,
  aStar: AStarContext,
  baseMaxX: number,
  baseMaxY: number,
  usageMap?: SegmentUsageMap,
  usedPoints?: UsedPointSet,
): void {
  const isSelfLoop = edge.from === edge.to
  const [preferredDir, preferredOppositeDir, alternativeDir, alternativeOppositeDir] =
    determineStartAndEndDir(edge, graph.config.graphDirection)

  interface Candidate {
    startDir: Direction
    endDir: Direction
    routeFrom: GridCoord
    routeTo: GridCoord
    routeFromIdx: number
    routeToIdx: number
  }

  function uniqueDirections(dirs: Direction[]): Direction[] {
    const out: Direction[] = []
    for (const d of dirs) {
      if (!out.some(x => dirEquals(x, d))) out.push(d)
    }
    return out
  }

  function buildCandidates(startDirs: Direction[], endDirs: Direction[]): Candidate[] {
    const candidates: Candidate[] = []
    for (const startDir of startDirs) {
      for (const endDir of endDirs) {
        const routeFrom = gridCoordDirection(edge.from.gridCoord!, startDir)
        const routeTo = gridCoordDirection(edge.to.gridCoord!, endDir)

        // 退化候选（routeFrom === routeTo）会导致 getPath 返回单点路径，
        // 最终 edge.path 只有 1 个点，绘制阶段会出现崩溃/空箭头。
        // 这种候选对“连线语义”没有意义，直接跳过。
        if (gridCoordEquals(routeFrom, routeTo)) continue

        candidates.push({
          startDir,
          endDir,
          routeFrom,
          routeTo,
          routeFromIdx: gridCoordToIdx(aStar.stride, routeFrom),
          routeToIdx: gridCoordToIdx(aStar.stride, routeTo),
        })
      }
    }
    return candidates
  }

  // -------------------------------------------------------------------------
  // Port penalty（避免走到 node 的四个角）
  //
  // 背景：
  // - 当 startDir/endDir 选择 UpperLeft/UpperRight/... 这类“角落端口”时，
  //   线路会贴着 box 的角走，渲染时很容易把 box corner 合成成 “┼”，读图会非常痛苦。
  //
  // 策略：
  // - 给“角落端口”加一个轻微的惩罚，让路由在可行时优先选上下左右四边端口。
  // - 如果确实只有角落端口可行，仍允许使用（不要让边消失）。
  // -------------------------------------------------------------------------
  function portPenalty(dir: Direction): number {
    if (dirEquals(dir, Up) || dirEquals(dir, Down) || dirEquals(dir, Left) || dirEquals(dir, Right)) return 0
    // 数值刻意给得很大：只要存在“非角落端口”的可行路径，就优先选它。
    return 100
  }

  // -------------------------------------------------------------------------
  // Boundary penalty（避免贴着画布边界走）
  //
  // 背景（反向解析 + 可读性）：
  // - 当边使用 y=0 / x=0 附近的端口时，线路很容易“贴着 box 的顶边/左边”走，
  //   进而覆盖 box border 或把 box 顶边变成一条长横线，导致：
  //   1) 读图更困难（边/box 的边界混在一起）
  //   2) 反向解析时 box 检测更脆弱（top border 被覆盖）
  //
  // 策略：
  // - 对落在 x=0 或 y=0 的端口加一个较大的惩罚；
  // - 仍允许使用（不要让边消失），但优先选“非边界端口”。
  // -------------------------------------------------------------------------
  function boundaryPortPenalty(port: GridCoord): number {
    return (port.x === 0 || port.y === 0) ? 200 : 0
  }

  function candidateCost(candidate: Candidate, pathIdx: number[]): number {
    return mergePathLengthIdx(pathIdx, aStar.stride)
      + portPenalty(candidate.startDir)
      + portPenalty(candidate.endDir)
      + boundaryPortPenalty(candidate.routeFrom)
      + boundaryPortPenalty(candidate.routeTo)
  }

  // baseCandidates 必须尽量保持“旧行为”：
  // 旧实现只尝试 2 条路径：
  // - preferredDir -> preferredOppositeDir
  // - alternativeDir -> alternativeOppositeDir
  //
  // 这里不要把 startDirs/endDirs 做笛卡尔积（会引入新的组合，从而改变大量 golden）。
  const baseCandidates: Candidate[] = []
  {
    const routeFrom = gridCoordDirection(edge.from.gridCoord!, preferredDir)
    const routeTo = gridCoordDirection(edge.to.gridCoord!, preferredOppositeDir)
    if (!gridCoordEquals(routeFrom, routeTo)) {
      baseCandidates.push({
        startDir: preferredDir,
        endDir: preferredOppositeDir,
        routeFrom,
        routeTo,
        routeFromIdx: gridCoordToIdx(aStar.stride, routeFrom),
        routeToIdx: gridCoordToIdx(aStar.stride, routeTo),
      })
    }
  }

  // alternative 可能与 preferred 相同（例如某些方向判断分支），这里去重。
  if (!dirEquals(preferredDir, alternativeDir) || !dirEquals(preferredOppositeDir, alternativeOppositeDir)) {
    const routeFrom = gridCoordDirection(edge.from.gridCoord!, alternativeDir)
    const routeTo = gridCoordDirection(edge.to.gridCoord!, alternativeOppositeDir)
    if (!gridCoordEquals(routeFrom, routeTo)) {
      baseCandidates.push({
        startDir: alternativeDir,
        endDir: alternativeOppositeDir,
        routeFrom,
        routeTo,
        routeFromIdx: gridCoordToIdx(aStar.stride, routeFrom),
        routeToIdx: gridCoordToIdx(aStar.stride, routeTo),
      })
    }
  }

  // -------------------------------------------------------------------------
  // Self-loop 快速路径：用“确定性的矩形绕行”替代 A* 大搜索
  //
  // 背景（用户反馈 + 性能证据）：
  // - `A --> A` 这类 self-loop，如果用通用 A*：
  //   1) 很容易选到“过短的内部路径”，导致 arrowhead 覆盖 box 边框（例如把 `│` 变成 `▼`）
  //   2) 在有其它边占用/避交叉约束存在时，A* 可能需要很大 bounds 才能找到一条不交叉的回路，性能急剧变差
  //
  // 目标：
  // - self-loop 必须“出 box 再回来”
  // - 优先保持与原 golden 一致的“手绘”形态（右出、下绕、回到下边）
  // - 失败时再逐步扩大回路半径（clearance），而不是让 A* 在大网格里跑很久
  // -------------------------------------------------------------------------

  function directionToStep(dir: Direction): GridCoord | null {
    if (dirEquals(dir, Up)) return { x: 0, y: -1 }
    if (dirEquals(dir, Down)) return { x: 0, y: 1 }
    if (dirEquals(dir, Left)) return { x: -1, y: 0 }
    if (dirEquals(dir, Right)) return { x: 1, y: 0 }
    return null
  }

  function appendStraightLine(points: GridCoord[], to: GridCoord): void {
    const from = points[points.length - 1]!
    if (from.x === to.x) {
      const step = to.y > from.y ? 1 : -1
      for (let y = from.y + step; y !== to.y + step; y += step) {
        points.push({ x: from.x, y })
      }
      return
    }
    if (from.y === to.y) {
      const step = to.x > from.x ? 1 : -1
      for (let x = from.x + step; x !== to.x + step; x += step) {
        points.push({ x, y: from.y })
      }
      return
    }
    // self-loop 的构造路径只应该是水平/垂直折线
    throw new Error(`appendStraightLine expects straight line, got from=(${from.x},${from.y}) to=(${to.x},${to.y})`)
  }

  function isDeterministicSelfLoopPathValid(
    candidate: Candidate,
    path: GridCoord[],
  ): boolean {
    if (path.length < 4) return false

    const pathIdx: number[] = []
    for (let i = 0; i < path.length; i++) {
      const p = path[i]!
      if (p.x < 0 || p.y < 0) return false
      if (p.x >= aStar.stride || p.y >= aStar.height) return false
      pathIdx.push(gridCoordToIdx(aStar.stride, p))

      const isEndpoint = gridCoordEquals(p, candidate.routeFrom) || gridCoordEquals(p, candidate.routeTo)
      if (!isEndpoint && aStar.blocked[pathIdx[pathIdx.length - 1]!]) return false
    }

    for (let i = 1; i < pathIdx.length; i++) {
      const stepFromIdx = pathIdx[i - 1]!
      const stepToIdx = pathIdx[i]!
      // 交叉（┼）约束：禁止形成四向交叉，保证可读 + 可逆
      if (!isAllowedToEnterUsedPoint(aStar, usedPoints, stepFromIdx, stepToIdx)) return false

      // 共线段复用约束：不允许非法复用已占用 segment
      if (usageMap) {
        const segKey = segmentKey(stepFromIdx, stepToIdx)
        if (usageMap.segmentUsed[segKey] && !isAllowedToShareSegmentStrict(
          usageMap,
          edge.from.index + 1,
          edge.to.index + 1,
          candidate.routeFromIdx,
          candidate.routeToIdx,
          stepFromIdx,
          stepToIdx,
          segKey,
        )) {
          return false
        }
      }
    }

    return true
  }

  function buildDeterministicSelfLoopPath(candidate: Candidate, clearance: number): GridCoord[] | null {
    const startStep = directionToStep(candidate.startDir)
    const endStep = directionToStep(candidate.endDir)
    if (!startStep || !endStep) return null
    if (clearance < 1) return null

    const startOutside: GridCoord = {
      x: candidate.routeFrom.x + startStep.x * clearance,
      y: candidate.routeFrom.y + startStep.y * clearance,
    }
    const endOutside: GridCoord = {
      x: candidate.routeTo.x + endStep.x * clearance,
      y: candidate.routeTo.y + endStep.y * clearance,
    }

    // 两种折线方式：先对齐 y 再对齐 x，或先对齐 x 再对齐 y。
    const mids: GridCoord[] = [
      { x: startOutside.x, y: endOutside.y },
      { x: endOutside.x, y: startOutside.y },
    ]

    for (const mid of mids) {
      const points: GridCoord[] = [candidate.routeFrom]
      appendStraightLine(points, startOutside)
      appendStraightLine(points, mid)
      appendStraightLine(points, endOutside)
      appendStraightLine(points, candidate.routeTo)

      // 防御：去掉连续重复点（理论上不会出现，但避免 bug 影响 segmentKey/校验）
      const deduped = points.filter((p, idx) => idx === 0 || !gridCoordEquals(p, points[idx - 1]!))

      if (isDeterministicSelfLoopPathValid(candidate, deduped) && mergePath(deduped).length >= 4) {
        return deduped
      }
    }

    return null
  }

  if (isSelfLoop) {
    // self-loop 只尝试最可信的两组端口组合（保持与原实现一致的“右出/下入”风格）。
    // clearance 从 1 开始逐步扩大，直到找到不交叉且不压边框的回路。
    const candidates = baseCandidates.length > 0 ? baseCandidates : expandedStartCandidates
    for (const c of candidates) {
      for (let clearance = 1; clearance <= 12; clearance++) {
        const path = buildDeterministicSelfLoopPath(c, clearance)
        if (!path) continue

        edge.startDir = c.startDir
        edge.endDir = c.endDir
        edge.path = mergePath(path)

        const pathIdx = path.map(p => gridCoordToIdx(aStar.stride, p))
        if (usageMap) recordPathSegments(usageMap, edge, pathIdx)
        if (usedPoints) recordPathPoints(usedPoints, aStar, pathIdx)

        return
      }
    }
  }

  const baseEndDirs = uniqueDirections([preferredOppositeDir, alternativeOppositeDir])
  const expandedStartDirs = uniqueDirections([
    preferredDir, alternativeDir,
    // 扩展候选只包含“四边端口”，避免把线路引到 box 的角落（角落容易把 corner 合成成“┼”或覆盖 box 角）。
    Right, Left, Down, Up,
  ])
  const expandedEndDirs = uniqueDirections([
    preferredOppositeDir, alternativeOppositeDir,
    Right, Left, Down, Up,
  ])

  const expandedStartCandidates = buildCandidates(expandedStartDirs, baseEndDirs)
  const expandedAllCandidates = buildCandidates(expandedStartDirs, expandedEndDirs)

  // -------------------------------------------------------------------------
  // A* bounds strategy
  //
  // 说明：
  // - 由于我们的 grid 理论上是无限的，一旦 strict 模式让目标不可达，
  //   A* 就可能在无限网格里“跑很久”。
  // - 为了避免卡死，我们给 A* 一个可控的上界，并在找不到路径时逐步扩大。
  // -------------------------------------------------------------------------
  // 说明：
  // - “避交点/避共线”会让后续边需要绕行更远。
  // - 因此我们需要“可控扩大”的搜索上界，避免无限网格搜索导致卡死。
  //
  // 两档策略：
  // - FAST：用于“先快速探测有没有路”，避免在明显不可达的候选上把 bounds 拉到 384 然后跑很久。
  // - FULL：用于“确实需要绕很远”的场景（例如密集图、端口被占用后只能大绕行）。
  //
  // 根因：
  // - 有些候选端口组合在几何上就是不可能（例如端口贴着边界，外侧没有任何可进入的 free cell），
  //   再怎么扩大 bounds 也不会变可达；这类候选应该尽快放弃，把计算量留给更有希望的候选（尤其是 corner 端口）。
  function computeSearchBounds(expandBy: number): { maxX: number; maxY: number } {
    // baseMaxX/baseMaxY 已经包含了所有 node 的 3x3 占用边界（x..x+2 / y..y+2）
    // 在此基础上做可控扩展即可。
    return {
      maxX: Math.min(aStar.stride - 1, baseMaxX + expandBy),
      maxY: Math.min(aStar.height - 1, baseMaxY + expandBy),
    }
  }

  function pickBestFallback(
    candidates: Candidate[],
    expandSteps: readonly number[] = ROUTING_BOUNDS_EXPAND_STEPS_FULL,
  ): { candidate: Candidate; pathIdx: number[]; cost: number } | null {
    // 重要：fallback 必须有 bounds。
    //
    // 否则当目标几何上不可达（例如端口在画布边界且外侧没有任何 free cell）时，
    // A* 会在“无限网格”里持续扩张，导致同步渲染把整个进程卡死（测试超时也无法打断）。
    for (const expandBy of expandSteps) {
      const bounds = computeSearchBounds(expandBy)
      let best: { candidate: Candidate; pathIdx: number[]; cost: number } | null = null

      for (const c of candidates) {
        const pathIdx = getPath(aStar, c.routeFromIdx, c.routeToIdx, bounds)
        if (!pathIdx) continue

        // self-loop 必须“出 box 再回来”，否则箭头会落在 box 边框上，读图完全不可理解。
        // 这里用 mergePath 后的拐点数量做一个最小约束：太短的路径基本等价于“在 box 内部画一小段”。
        if (isSelfLoop && mergePathLengthIdx(pathIdx, aStar.stride) < 4) continue

        // 保持旧逻辑：用 mergePath 后的“折线段数量”做比较，
        // 这样会倾向更少拐点的路线（更像人画出来的线）。
        const cost = candidateCost(c, pathIdx)
        if (!best || cost < best.cost) {
          best = { candidate: c, pathIdx, cost }
        }
      }

      if (best) return best
    }

    return null
  }

  function pickBestStrict(
    candidates: Candidate[],
    expandSteps: readonly number[],
  ): { candidate: Candidate; pathIdx: number[]; cost: number } | null {
    if (!usageMap || usageMap.usedCount === 0) return null

    // 重要：避免在 QuickJS 热路径里构造“每步 moveCost 回调”。
    // - moveCost 是 A* 扩展节点时的 per-step hook，调用次数可达几十万到百万级；
    // - QuickJS 无 JIT，函数调用开销会把整体性能拖到十几秒。
    //
    // 这里改为复用一个 `StrictPathConstraints` 对象，把约束内联进 getPathStrict() 的循环里。
    const constraints: StrictPathConstraints = {
      segmentUsage: usageMap,
      usedPoints,
      routeFromIdx: 0,
      routeToIdx: 0,
      edgeFromId: edge.from.index + 1,
      edgeToId: edge.to.index + 1,
    }

    for (const expandBy of expandSteps) {
      const bounds = computeSearchBounds(expandBy)
      let best: { candidate: Candidate; pathIdx: number[]; cost: number } | null = null

      for (const c of candidates) {
        constraints.routeFromIdx = c.routeFromIdx
        constraints.routeToIdx = c.routeToIdx
        const strictPathIdx = getPathStrict(aStar, c.routeFromIdx, c.routeToIdx, bounds, constraints)
        if (!strictPathIdx) continue
        if (isSelfLoop && mergePathLengthIdx(strictPathIdx, aStar.stride) < 4) continue

        // strict 下我们同样优先更少拐点（而不是更短距离），避免出现“绕来绕去但步数差不多”的丑路径。
        const cost = candidateCost(c, strictPathIdx)
        if (!best || cost < best.cost) {
          best = { candidate: c, pathIdx: strictPathIdx, cost }
        }
      }

      if (best) return best
    }

    return null
  }

  let picked: { candidate: Candidate; pathIdx: number[]; cost: number } | null = null

  if (!usageMap || usageMap.usedCount === 0) {
    // usageMap 为空：完全按旧逻辑（pref/alt）选最短，避免影响 golden。
    picked = pickBestFallback(baseCandidates, ROUTING_BOUNDS_EXPAND_STEPS_FAST)
  } else {
    // usageMap 非空：启用“线段避让”。
    //
    // 规则（用户需求）：
    // - 同源：允许“起点段”共线
    // - 同靶：允许“终点段”共线
    // - 其它：不允许共线
    //
    // 实现策略：
    // 1) strict：不允许的共线直接禁止（moveCost 返回 null）
    // 2) 如果 strict 不可达：降级 penalty（允许但强惩罚），保证边不会“消失”
    //
    // 同时采用“分层扩展候选”减少 A* 调用次数：
    // - 先尝试最保守的候选（pref/alt）
    // - 再扩大候选集合（更多起止方向组合）
    // 先用 FAST bounds 快速探测四边端口是否可达（可达则立即返回，不浪费大 bounds）。
    picked = pickBestStrict(baseCandidates, ROUTING_BOUNDS_EXPAND_STEPS_FAST)
      ?? pickBestStrict(expandedStartCandidates, ROUTING_BOUNDS_EXPAND_STEPS_FAST)
      ?? pickBestStrict(expandedAllCandidates, ROUTING_BOUNDS_EXPAND_STEPS_FAST)

    // FAST bounds 不可达：允许更大范围绕行（仍然禁止四向交叉 `┼`，保证可读 + 可逆）。
    //
    // 性能取舍：
    // - FULL bounds + expandedAllCandidates（笛卡尔积）会产生大量 A* 调用，某些小图也会被拖慢。
    // - 因此 FULL 阶段优先只扩大“更可信”的候选集合（base / expandedStart），避免无意义的全量尝试。
    picked = picked
      ?? pickBestStrict(baseCandidates, ROUTING_BOUNDS_EXPAND_STEPS_FULL)
      ?? pickBestStrict(expandedStartCandidates, ROUTING_BOUNDS_EXPAND_STEPS_FULL)

    // 最后兜底（仍然严格遵守 segment 复用规则）：
    // - FULL bounds 下把候选扩大到笛卡尔积（expandedAllCandidates），尽最大努力找到“可读且不共线”的路线。
    // - 我们刻意不做“无约束 fallback”（会引入非法共线复用，导致读图与反向解析都产生歧义）。
    picked = picked ?? pickBestStrict(expandedAllCandidates, ROUTING_BOUNDS_EXPAND_STEPS_FULL)
  }

  if (!picked) {
    edge.startDir = preferredDir
    edge.endDir = preferredOppositeDir
    edge.path = []
    return
  }

  edge.startDir = picked.candidate.startDir
  edge.endDir = picked.candidate.endDir
  edge.path = mergePathIdx(picked.pathIdx, aStar.stride).map(idx => idxToGridCoord(aStar.stride, idx))

  if (usageMap) {
    recordPathSegments(usageMap, edge, picked.pathIdx)
  }

  // 记录“通路点占用”，用于后续边避让交叉/重叠。
  if (usedPoints) {
    recordPathPoints(usedPoints, aStar, picked.pathIdx)
  }
}

/**
 * Find the best line segment in an edge's path to place a label on.
 * Picks the first segment wide enough for the label, or the widest segment overall.
 * Also increases the column width at the label position to fit the text.
 */
export function determineLabelLine(graph: AsciiGraph, edge: AsciiEdge): void {
  if (edge.text.length === 0) return
  if (edge.path.length < 2) return

  // label 也可能包含中文/emoji 等宽字符，必须按“终端显示宽度”来判断能否放下。
  const lenLabel = textDisplayWidth(edge.text)
  const occupiedBoxes = collectOccupiedLabelBoxes(graph)
  const occupiedNodeBoxes = collectOccupiedNodeBoxes(graph)

  let prevStep = edge.path[0]!

  // -------------------------------------------------------------------------
  // 选择 labelLine 的原则：
  // 1) 尽量保持原行为：优先使用“第一个能放下 label 的线段”，否则用“最宽线段”。
  // 2) 但如果该线段会与已放置的其它 label 重叠，则跳过它，改用后续不冲突的线段。
  //
  // 这样可以修复类似 `specspec.ready` 这种“多个 label 画在同一段线上导致拼接”的问题，
  // 同时把对现有 golden 的影响控制在“只有发生重叠时才改变”的范围内。
  // -------------------------------------------------------------------------
  let chosenLine: [GridCoord, GridCoord] | null = null

  // 原始算法的兜底选择（不考虑碰撞）
  let fallbackLine: [GridCoord, GridCoord] = [prevStep, edge.path[1]!]
  let fallbackLineSize = 0
  let fallbackFoundWideEnough = false

  // 如果所有线段都碰撞，用这个作为“碰撞下的最佳努力”（尽量选最宽且不碰撞）
  let bestNonOverlappingLine: [GridCoord, GridCoord] | null = null
  let bestNonOverlappingSize = -1

  for (let i = 1; i < edge.path.length; i++) {
    const step = edge.path[i]!
    const line: [GridCoord, GridCoord] = [prevStep, step]
    const lineWidth = calculateLineWidth(graph, line)

    // 兜底逻辑：保持原算法“第一个能放下 label 的线段，否则选最宽”的行为
    if (!fallbackFoundWideEnough) {
      if (lineWidth >= lenLabel) {
        fallbackLine = line
        fallbackFoundWideEnough = true
      } else if (lineWidth > fallbackLineSize) {
        fallbackLineSize = lineWidth
        fallbackLine = line
      }
    }

    const candidateBox = getLabelBox(graph, line, edge.text)
    const overlapsExisting = candidateBox
      ? occupiedBoxes.some(b => labelBoxesOverlap(b, candidateBox))
      : false
    const overlapsNode = candidateBox
      ? occupiedNodeBoxes.some(b => labelOverlapsNodeBox(candidateBox, b))
      : false

    if (!overlapsExisting && !overlapsNode) {
      // 记录“最宽的非重叠线段”，用于后续兜底
      if (lineWidth > bestNonOverlappingSize) {
        bestNonOverlappingSize = lineWidth
        bestNonOverlappingLine = line
      }

      // 与原算法保持一致：优先使用“第一个能放下 label 的非重叠线段”
      if (lineWidth >= lenLabel) {
        chosenLine = line
        break
      }
    }

    prevStep = step
  }

  if (chosenLine === null) {
    chosenLine = bestNonOverlappingLine ?? fallbackLine
  }

  // Ensure column at midpoint is wide enough for the label
  const minX = Math.min(chosenLine[0].x, chosenLine[1].x)
  const maxX = Math.max(chosenLine[0].x, chosenLine[1].x)
  const middleX = minX + Math.floor((maxX - minX) / 2)

  const current = graph.columnWidth.get(middleX) ?? 0
  graph.columnWidth.set(middleX, Math.max(current, lenLabel + 2))

  edge.labelLine = [chosenLine[0], chosenLine[1]]
}

/** Calculate the total character width of a line segment by summing column widths. */
function calculateLineWidth(graph: AsciiGraph, line: [GridCoord, GridCoord]): number {
  let total = 0
  const startX = Math.min(line[0].x, line[1].x)
  const endX = Math.max(line[0].x, line[1].x)
  for (let x = startX; x <= endX; x++) {
    total += graph.columnWidth.get(x) ?? 0
  }
  return total
}

// ============================================================================
// Label collision avoidance
// ============================================================================

interface LabelBox {
  /** label 所在的绘制行（DrawingCoord 的 y） */
  y: number
  /** label 起始列（DrawingCoord 的 x） */
  startX: number
  /** label 结束列（DrawingCoord 的 x），包含端点 */
  endX: number
}

interface NodeBox {
  /** box 左上角（DrawingCoord） */
  minX: number
  minY: number
  /** box 右下角（DrawingCoord），包含边框 */
  maxX: number
  maxY: number
}

/**
 * 将 GridCoord 转为 DrawingCoord（字符画坐标）。
 *
 * 注意：这里刻意不从 `grid.ts` 导入 `gridToDrawingCoord`，避免形成循环依赖：
 * `grid.ts -> edge-routing.ts`（determineLabelLine）以及 `edge-routing.ts -> grid.ts`。
 */
function gridToDrawingCoordForLabel(graph: AsciiGraph, c: GridCoord): { x: number; y: number } {
  let x = graph.offsetX
  for (let col = 0; col < c.x; col++) {
    x += graph.columnWidth.get(col) ?? 0
  }

  let y = graph.offsetY
  for (let row = 0; row < c.y; row++) {
    y += graph.rowHeight.get(row) ?? 0
  }

  const colW = graph.columnWidth.get(c.x) ?? 0
  const rowH = graph.rowHeight.get(c.y) ?? 0

  return {
    x: x + Math.floor(colW / 2),
    y: y + Math.floor(rowH / 2),
  }
}

/**
 * 将 GridCoord 转为“绘制原点”（不做居中）。
 *
 * 用途：
 * - 计算 node box 在画布上的占用范围，用来避免 edge label 盖住 box 边框。
 */
function gridToDrawingOriginForNode(graph: AsciiGraph, c: GridCoord): { x: number; y: number } {
  let x = graph.offsetX
  for (let col = 0; col < c.x; col++) {
    x += graph.columnWidth.get(col) ?? 0
  }

  let y = graph.offsetY
  for (let row = 0; row < c.y; row++) {
    y += graph.rowHeight.get(row) ?? 0
  }

  return { x, y }
}

/** 计算某个 node 在画布上的占用范围（包含边框）。 */
function getNodeBox(graph: AsciiGraph, node: AsciiNode): NodeBox | null {
  if (!node.gridCoord) return null
  const gc = node.gridCoord

  // drawBox 的尺寸逻辑：node 占据 2 列 + 2 行（边框 + 内容），并以 (w,h) 为右下角坐标。
  let w = 0
  for (let i = 0; i < 2; i++) w += graph.columnWidth.get(gc.x + i) ?? 0
  let h = 0
  for (let i = 0; i < 2; i++) h += graph.rowHeight.get(gc.y + i) ?? 0

  const origin = gridToDrawingOriginForNode(graph, gc)
  return {
    minX: origin.x,
    minY: origin.y,
    maxX: origin.x + w,
    maxY: origin.y + h,
  }
}

/** label 是否覆盖到 node box（仅比较同一 y 行上的 x 区间）。 */
function labelOverlapsNodeBox(label: LabelBox, node: NodeBox): boolean {
  if (label.y < node.minY || label.y > node.maxY) return false
  return !(label.endX < node.minX || node.maxX < label.startX)
}

/** 收集所有 node box 的占用范围，用于 label 避让。 */
function collectOccupiedNodeBoxes(graph: AsciiGraph): NodeBox[] {
  const boxes: NodeBox[] = []
  for (const node of graph.nodes) {
    const b = getNodeBox(graph, node)
    if (b) boxes.push(b)
  }
  return boxes
}

/**
 * 计算“把 label 居中画在线段上”时，label 在画布上的占用范围。
 * 这里必须使用 `textDisplayWidth`，避免中文/emoji 宽字符导致碰撞判断错误。
 */
function getLabelBox(graph: AsciiGraph, line: [GridCoord, GridCoord], label: string): LabelBox | null {
  const labelWidth = textDisplayWidth(label)
  if (labelWidth <= 0) return null

  const a = gridToDrawingCoordForLabel(graph, line[0])
  const b = gridToDrawingCoordForLabel(graph, line[1])

  const minX = Math.min(a.x, b.x)
  const maxX = Math.max(a.x, b.x)
  const minY = Math.min(a.y, b.y)
  const maxY = Math.max(a.y, b.y)

  const middleX = minX + Math.floor((maxX - minX) / 2)
  const middleY = minY + Math.floor((maxY - minY) / 2)

  const startX = middleX - Math.floor(labelWidth / 2)
  return { y: middleY, startX, endX: startX + labelWidth - 1 }
}

/** 判断两个 label 的占用范围是否重叠（仅在同一行时比较 X 区间）。 */
function labelBoxesOverlap(a: LabelBox, b: LabelBox): boolean {
  if (a.y !== b.y) return false
  return !(a.endX < b.startX || b.endX < a.startX)
}

/** 收集当前已经“放置过 labelLine 的边”的 label 占用范围，用于后续边的避让。 */
function collectOccupiedLabelBoxes(graph: AsciiGraph): LabelBox[] {
  const boxes: LabelBox[] = []
  for (const edge of graph.edges) {
    if (edge.text.length === 0) continue
    if (edge.labelLine.length < 2) continue
    const box = getLabelBox(graph, [edge.labelLine[0]!, edge.labelLine[1]!], edge.text)
    if (box) boxes.push(box)
  }
  return boxes
}
