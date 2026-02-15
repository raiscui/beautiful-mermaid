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
import { getPath, getPathStrict, getPathRelaxed, mergePath, gridCoordToIdx, idxToGridCoord, mergePathIdx, mergePathLengthIdx, type AStarContext, type StrictPathConstraints } from './pathfinder.ts'
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
  routing: 'strict' | 'relaxed',
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

  // -----------------------------------------------------------------------
  // relaxed: 修正“明显不朝向对方的端口选择”(nearest-facing correction)
  //
  // 背景:
  // - 某些对角/逆向场景下,旧映射会选到“背向对方”的端口(例如目标在左边,却从右侧出线),
  //   这会直接触发“绕大圈/画外框”,读图非常痛苦。
  //
  // 策略:
  // - 只做“方向符号”层面的保守修正:
  //   - startDir: 如果选到了与 dx/dy 明显相反的轴向端口,就翻转到另一侧;
  //   - endDir: 方向与 startDir 相反(端口应当面向 source),同理做翻转。
  // - 不在这里做“水平 vs 垂直”轴向选择,避免引入大面积行为漂移。
  // -----------------------------------------------------------------------
  if (routing === 'relaxed') {
    const fromGc = edge.from.gridCoord
    const toGc = edge.to.gridCoord
    if (fromGc && toGc) {
      const dx = toGc.x - fromGc.x
      const dy = toGc.y - fromGc.y

      // -------------------------------------------------------------------
      // 端口“翻转”工具(支持四边端口 + corner 端口)
      //
      // 背景:
      // - TD 下的 backward edge(向上走)在旧映射里经常会选到 Right/UpperRight/... 这类背向端口,
      //   直接触发“绕外圈画大框”。
      // - 旧版 adjustStart/adjustEnd 只处理四边端口,corner 端口仍可能背向。
      //
      // 做法:
      // - 把端口 delta(-1..1) 与 dx/dy 的符号对齐:
      //   - startDir: 面向 target(同向)
      //   - endDir: 面向 source(反向)
      // - 这一步只做“方向修正”,不改变“水平 vs 垂直”的轴向策略,避免大面积行为漂移。
      // -------------------------------------------------------------------
      function flipX(dir: Direction): Direction {
        if (dirEquals(dir, Left)) return Right
        if (dirEquals(dir, Right)) return Left
        if (dirEquals(dir, UpperLeft)) return UpperRight
        if (dirEquals(dir, UpperRight)) return UpperLeft
        if (dirEquals(dir, LowerLeft)) return LowerRight
        if (dirEquals(dir, LowerRight)) return LowerLeft
        return dir
      }

      function flipY(dir: Direction): Direction {
        if (dirEquals(dir, Up)) return Down
        if (dirEquals(dir, Down)) return Up
        if (dirEquals(dir, UpperLeft)) return LowerLeft
        if (dirEquals(dir, UpperRight)) return LowerRight
        if (dirEquals(dir, LowerLeft)) return UpperLeft
        if (dirEquals(dir, LowerRight)) return UpperRight
        return dir
      }

      function adjustStart(dir: Direction): Direction {
        let out = dir
        const deltaX = Math.sign(out.x - 1)
        const deltaY = Math.sign(out.y - 1)

        if (dx < 0 && deltaX === 1) out = flipX(out)
        else if (dx > 0 && deltaX === -1) out = flipX(out)

        // 注意: flipX 不会改变 y,因此这里直接用 deltaY 判断即可。
        if (dy < 0 && deltaY === 1) out = flipY(out)
        else if (dy > 0 && deltaY === -1) out = flipY(out)

        return out
      }

      function adjustEnd(dir: Direction): Direction {
        // endDir 应当“面向 source”，因此方向与 dx/dy 相反
        let out = dir
        const deltaX = Math.sign(out.x - 1)
        const deltaY = Math.sign(out.y - 1)

        if (dx < 0 && deltaX === -1) out = flipX(out)
        else if (dx > 0 && deltaX === 1) out = flipX(out)

        if (dy < 0 && deltaY === -1) out = flipY(out)
        else if (dy > 0 && deltaY === 1) out = flipY(out)

        return out
      }

      preferredDir = adjustStart(preferredDir)
      alternativeDir = adjustStart(alternativeDir)
      preferredOppositeDir = adjustEnd(preferredOppositeDir)
      alternativeOppositeDir = adjustEnd(alternativeOppositeDir)
    }
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

  // -----------------------------------------------------------------------
  // segmentPair（同一对节点的平行边共享干线）
  //
  // 背景(用户复现图):
  // - 同一对节点(from->to)存在多条带 label 的边时,
  //   relaxed 的 hard rule “禁止 segment overlap”会把这些边强行挤到不同通道:
  //   - 典型表现就是绕外圈画大矩形,合并点/junction 密度爆炸,人类读不懂。
  //
  // 目标:
  // - 仅对“完全相同端点的平行边”开放 segment 复用(共享干线),
  //   让它们在画面上更像“同一条关系的多种事件”,而不是被迫绕成线团。
  //
  // 设计取舍:
  // - 我们用一个 32-bit 的 pairId 来标记 segment 属于哪个 (from,to)：
  //   pairId = (fromId << 16) | toId，其中 fromId/toId 是 1-based node id。
  // - 当同一 segment 被不同 pair 使用过,会把 segmentPairMulti[key]=1,
  //   这样“平行边共享”只会发生在干净的单 pair 上,避免误连线。
  // -----------------------------------------------------------------------

  /** segmentPair[key] = pairId（1-based from/to 打包），0 表示未设置。 */
  segmentPair: Uint32Array
  /** segmentPairMulti[key] = 1 表示该 segment 被多个不同 pair 使用过。 */
  segmentPairMulti: Uint8Array

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
    segmentPair: new Uint32Array(segmentCount),
    segmentPairMulti: new Uint8Array(segmentCount),
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
  // pairId: (fromId,toId) 打包成一个 32-bit 值,用于“同端点平行边共享干线”的判定。
  //
  // 说明:
  // - 这里假设 node 数量通常远小于 65535（终端图也不可能太大）；
  // - 如果极端情况下超过 16-bit,我们退化为 0（禁用该优化）,避免碰撞导致误共享。
  const pairId = (edgeFromId > 0xffff || edgeToId > 0xffff)
    ? 0
    : ((edgeFromId << 16) | edgeToId)

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

    // 记录 pairId（用于 relaxed 下的“同端点平行边共享整条干线”）。
    //
    // 注意:
    // - pairId=0 表示禁用该优化(极端大图)；
    // - segmentPairMulti=1 时,表示该 segment 曾被多个不同 pair 使用过,
    //   后续将禁止“平行边共享”,以免把不相关的边合并成一条线。
    if (pairId !== 0) {
      const currentPair = usageMap.segmentPair[key]!
      if (currentPair === 0) usageMap.segmentPair[key] = pairId
      else if (currentPair !== pairId) usageMap.segmentPairMulti[key] = 1
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
  allowUnconstrainedFallback = false,
): void {
  // 调试标记(默认关闭):
  // - 当 relaxed 进入“无约束 getPath() 兜底”时,会把某些可读性约束放开；
  // - 这很可能是“共享走线/误连线”的来源之一。
  //
  // 这里用一个私有字段标记是否触发过兜底,便于在 Bun/测试脚本里快速定位。
  // 注意: 这个字段不会进入最终 meta,也不会影响渲染输出。
  ;(edge as any).__bm_used_unconstrained_fallback = false

  const isSelfLoop = edge.from === edge.to
  const routing = graph.config.routing
  const [preferredDir, preferredOppositeDir, alternativeDir, alternativeOppositeDir] =
    determineStartAndEndDir(edge, graph.config.graphDirection, routing)

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
    // strict：强烈避免角落（角落更容易压到 box corner，且 strict 禁交叉会绕更远）
    // relaxed：允许角落作为“分流端口”，但仍给一点惩罚，避免过度贴角
    return routing === 'relaxed' ? 10 : 100
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

  const PORT_USAGE_PENALTY = 6

  function portUsagePenalty(node: AsciiNode, dir: Direction): number {
    // 只在 relaxed 下启用：strict 需要稳定输出（golden/roundtrip）
    if (routing !== 'relaxed') return 0
    if (!graph.portUsage) return 0

    // Unicode relaxed 下会启用 comb ports(绘制层分 lane):
    // - 端口“落点”会沿边框分散,不再局限于 3x3 的 4 个 side port；
    // - 因此这里不需要再用“端口使用次数”去强行分流到其它 side(会让线路违背最近侧边直觉)。
    //
    // 典型回归(用户复现图):
    // - 同一个 source->target 的多条边,其中一条会被 portUsagePenalty 推到 bottom/left,
    //   结果箭头不再落在“面对 source 的那一侧”,读图更反直觉。
    if (!graph.config.useAscii) return 0

    const portIdx = dir.x + dir.y * 3
    const idx = node.index * 9 + portIdx
    return (graph.portUsage[idx] ?? 0) * PORT_USAGE_PENALTY
  }

  function candidateCostStrict(candidate: Candidate, pathIdx: number[]): number {
    return mergePathLengthIdx(pathIdx, aStar.stride)
      + portPenalty(candidate.startDir)
      + portPenalty(candidate.endDir)
      + boundaryPortPenalty(candidate.routeFrom)
      + boundaryPortPenalty(candidate.routeTo)
  }

  // -------------------------------------------------------------------------
  // Detour penalty（避免“绕大圈/外框”）
  //
  // 背景:
  // - 在拥挤图里, A* 为了绕开已占用 segment,可能选择一条“很规整但很远”的大矩形路径；
  // - 这种路径拐点很少(通常只有 2~3 次转向),但会把图拉得很宽,让读图者误以为存在额外结构。
  //
  // 目标:
  // - 不改变 strict 的稳定性;
  // - relaxed 下只在 detour 很大时施加软惩罚,把选择从“跑到外圈”拉回到“图中心附近”。
  //
  // 说明:
  // - 这里用 “节点 3x3 block 的包围盒” 作为参考框（与端口选择无关,避免因 startDir 不同导致惩罚失真）。
  // - 只要 detour 不是特别大(<= threshold),就不施加惩罚,避免影响大量既有 golden。
  // -------------------------------------------------------------------------
  function detourPenaltyRelaxed(pathIdx: number[]): number {
    if (!edge.from.gridCoord || !edge.to.gridCoord) return 0
    if (pathIdx.length < 8) return 0

    const stride = aStar.stride
    let minX = Number.POSITIVE_INFINITY
    let maxX = Number.NEGATIVE_INFINITY
    let minY = Number.POSITIVE_INFINITY
    let maxY = Number.NEGATIVE_INFINITY

    for (const idx of pathIdx) {
      const x = idx % stride
      const y = (idx / stride) | 0
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }

    const from = edge.from.gridCoord
    const to = edge.to.gridCoord

    // node 的占用是 3x3 block: [x..x+2], [y..y+2]
    const refMinX = Math.min(from.x, to.x)
    const refMaxX = Math.max(from.x, to.x) + 2
    const refMinY = Math.min(from.y, to.y)
    const refMaxY = Math.max(from.y, to.y) + 2

    // 允许“少量偏离”用于避让(否则会过度干预正常路径)。
    const MARGIN = 2
    const extraLeft = Math.max(0, refMinX - minX - MARGIN)
    const extraRight = Math.max(0, maxX - refMaxX - MARGIN)
    const extraTop = Math.max(0, refMinY - minY - MARGIN)
    const extraBottom = Math.max(0, maxY - refMaxY - MARGIN)

    const detour = extraLeft + extraRight + extraTop + extraBottom

    // 只在 detour 很大时才惩罚: 避免影响大多数正常图。
    //
    // 注意:
    // - 这里保持“方向无关”的总 detour 惩罚;
    // - 不对左/右/上/下做额外偏置,避免把“纯近路优先”变成“某侧优先”。
    const absDx = Math.abs(to.x - from.x)
    const absDy = Math.abs(to.y - from.y)
    const isVerticalDominant = absDy >= absDx + 2
    const THRESHOLD = isVerticalDominant ? 8 : 12
    const PENALTY_PER_CELL = isVerticalDominant ? 10 : 4

    if (detour <= THRESHOLD) return 0
    return (detour - THRESHOLD) * PENALTY_PER_CELL
  }

  // -------------------------------------------------------------------------
  // Nearest-side penalty（确保优先使用“最近侧边端口”）
  //
  // 背景(用户反馈):
  // - 你指出“绕弯/绕大圈”的根因之一是: 端口选择没有优先从 box 最近的边出线/入线；
  // - 在 relaxed 的 fallback/扩展候选阶段,我们会尝试更多 startDir/endDir 组合,
  //   这会让某些边在“代价略低”时走出一个非常反直觉的端口(例如目标在左边却从右侧出线),
  //   从而产生:
  //   - 起始段先反方向走一截(肉眼看就是断线/绕路);
  //   - 在拥挤场景下被迫绕到最右侧外圈,形成大矩形外框。
  //
  // 目标:
  // - 只在 relaxed 下施加“软惩罚”,不影响 strict 的稳定性;
  // - 不增加任何 A* 调用次数,仅影响候选之间的排序(性能风险极低);
  // - 优先保证“端口朝向正确”(不背向),再在明显水平/垂直占优时偏好最近侧边。
  // -------------------------------------------------------------------------
  // 注意: “最近侧边/轴向占优”判断必须尽量贴近最终字符画的几何关系。
  //
  // 关键原因:
  // - A* 路由发生在 gridCoord(3x3 block) 空间;
  // - 但最终画布的真实坐标会被 columnWidth/rowHeight 拉伸(长 label 会把列拉得很宽);
  // - 如果我们只用 gridCoord 的 dx/dy,在“列宽差异很大”的图里会出现误判:
  //   - 视觉上目标明显在右侧,但 gridCoord 上 dx/dy 接近,导致算法误以为不需要水平优先;
  //   - 最终就会选到 Down/Up 端口,产生“先向下走一截再折返”的绕路观感。
  //
  // 因此这里用“node box 的边界 gap”来做 dx/dy：
  // - dx/dy 表示从 source box 到 target box 的“最短分离距离”(带符号);
  // - 相比 center delta,它天然考虑了 box 的实际宽高,更贴近你说的“最近边”直觉。
  //
  // 例子:
  // - target 在 source 右侧: dx > 0,且 start 应更偏好 Right / end 更偏好 Left
  // - target 在 source 下侧: dy > 0,且 start 应更偏好 Down / end 更偏好 Up
  const nearestSideDelta = (() => {
    const fromBox = getNodeBox(graph, edge.from)
    const toBox = getNodeBox(graph, edge.to)
    if (!fromBox || !toBox) return null

    let dx = 0
    if (toBox.minX > fromBox.maxX) dx = toBox.minX - fromBox.maxX
    else if (toBox.maxX < fromBox.minX) dx = toBox.maxX - fromBox.minX

    let dy = 0
    if (toBox.minY > fromBox.maxY) dy = toBox.minY - fromBox.maxY
    else if (toBox.maxY < fromBox.minY) dy = toBox.maxY - fromBox.minY

    // 极端情况: box 在 x/y 上都重叠(例如同一列但高度不同的 label 拉伸),
    // 此时 gap=0 无法提供方向信息,回退到 center delta 保持确定性。
    if (dx === 0 && dy === 0) {
      const fromCx = Math.floor((fromBox.minX + fromBox.maxX) / 2)
      const fromCy = Math.floor((fromBox.minY + fromBox.maxY) / 2)
      const toCx = Math.floor((toBox.minX + toBox.maxX) / 2)
      const toCy = Math.floor((toBox.minY + toBox.maxY) / 2)
      return { dx: toCx - fromCx, dy: toCy - fromCy }
    }

    return { dx, dy }
  })()

  function nearestSidePenaltyRelaxed(candidate: Candidate): number {
    if (!nearestSideDelta) return 0

    const dx = nearestSideDelta.dx
    const dy = nearestSideDelta.dy
    if (dx === 0 && dy === 0) return 0

    const dxSign = dx === 0 ? 0 : (dx > 0 ? 1 : -1)
    const dySign = dy === 0 ? 0 : (dy > 0 ? 1 : -1)

    // Direction 是 3x3 block 的“端口坐标系”(0..2),这里转成 delta(-1..1) 才能做符号判断。
    const startDeltaX = Math.sign(candidate.startDir.x - 1)
    const startDeltaY = Math.sign(candidate.startDir.y - 1)
    const endDeltaX = Math.sign(candidate.endDir.x - 1)
    const endDeltaY = Math.sign(candidate.endDir.y - 1)

    // 1) 强约束(软惩罚): 端口不能“背向对方”
    //
    // 解释:
    // - startDir: 应当朝向 target(与 dx/dy 同向)
    // - endDir: 应当朝向 source(与 dx/dy 反向)
    //
    // 注意:
    // - 我们只惩罚“明确背向”的端口(delta 不为 0 且符号相反),
    //   对于“垂直/水平中性端口”(delta=0)不惩罚,让路由仍保留自由度。
    // 纯近路优先:
    // - 仍保留“背向端口”的惩罚,但强度降到中等量级;
    // - 允许当“背向但整体更短”时被路径成本覆盖,避免硬偏置到某一侧。
    const AWAY_PENALTY = 180
    let penalty = 0

    if (dxSign !== 0 && startDeltaX !== 0 && startDeltaX === -dxSign) penalty += AWAY_PENALTY
    if (dySign !== 0 && startDeltaY !== 0 && startDeltaY === -dySign) penalty += AWAY_PENALTY

    if (dxSign !== 0 && endDeltaX !== 0 && endDeltaX === dxSign) penalty += AWAY_PENALTY
    if (dySign !== 0 && endDeltaY !== 0 && endDeltaY === dySign) penalty += AWAY_PENALTY

    return penalty
  }

  function candidateCostRelaxed(candidate: Candidate, result: { path: number[]; cost: number }): number {
    // relaxed 的 result.cost 已包含“步长 + 惩罚项”，这里再叠加一些“人类审美偏好”的轻量惩罚:
    // 1) 拐点更少（避免锯齿）
    // 2) 尽量不要“跑出两端节点包围盒很远”（避免绕大圈画外框）
    // 3) 优先从最近侧边出入线（避免起点段先反方向走）

    return result.cost
      + mergePathLengthIdx(result.path, aStar.stride)
      + detourPenaltyRelaxed(result.path)
      + nearestSidePenaltyRelaxed(candidate)
      + portPenalty(candidate.startDir)
      + portPenalty(candidate.endDir)
      + boundaryPortPenalty(candidate.routeFrom)
      + boundaryPortPenalty(candidate.routeTo)
      + portUsagePenalty(edge.from, candidate.startDir)
      + portUsagePenalty(edge.to, candidate.endDir)
  }

  // baseCandidates: “最可信”的起止端口候选
  //
  // 原始实现(mermaid-ascii)只尝试两条“成对映射”的候选路径:
  // - preferredDir -> preferredOppositeDir
  // - alternativeDir -> alternativeOppositeDir
  //
  // 但你反馈的真实问题是:
  // - 对角线关系(例如 LowerRight)在 TD/LR 下,preferred/alternative 往往是“轴向耦合”的:
  //   - start=Right 时 end 被固定成 Up
  //   - start=Down 时 end 被固定成 Left
  // - 这会导致 relaxed 即便想遵守“最近侧边”(例如 dx 远大于 dy 时走水平),
  //   也根本没有 `start=Right + end=Left` 这种更直观的组合可选,从而出现:
  //   - 起点先反方向走一截(看起来像断线/绕路)
  //   - 线路更容易与其它边共享中间干线,读图更混乱
  //
  // 改良策略(改良胜过新增):
  // - strict: 继续保持旧行为,避免 golden 大漂移;
  // - relaxed: 允许 baseDirs 内部做一次“交叉组合”(最多 2x2=4 个候选),
  //   给 nearest-side penalty 一个真正能选到“最近侧边”的机会。
  const baseStartDirs = uniqueDirections([preferredDir, alternativeDir])
  const baseEndDirs = uniqueDirections([preferredOppositeDir, alternativeOppositeDir])

  const baseCandidates: Candidate[] = []

  function pushBaseCandidate(startDir: Direction, endDir: Direction): void {
    if (baseCandidates.some(c => dirEquals(c.startDir, startDir) && dirEquals(c.endDir, endDir))) return

    const routeFrom = gridCoordDirection(edge.from.gridCoord!, startDir)
    const routeTo = gridCoordDirection(edge.to.gridCoord!, endDir)

    // 退化候选（routeFrom === routeTo）会导致 getPath 返回单点路径，
    // 最终 edge.path 只有 1 个点，绘制阶段会出现崩溃/空箭头。
    if (gridCoordEquals(routeFrom, routeTo)) return

    baseCandidates.push({
      startDir,
      endDir,
      routeFrom,
      routeTo,
      routeFromIdx: gridCoordToIdx(aStar.stride, routeFrom),
      routeToIdx: gridCoordToIdx(aStar.stride, routeTo),
    })
  }

  // 1) 先保留旧行为的两条“成对映射”候选（让大多数图保持稳定输出）
  pushBaseCandidate(preferredDir, preferredOppositeDir)
  pushBaseCandidate(alternativeDir, alternativeOppositeDir)

  // 2) relaxed: 允许 baseDirs 的交叉组合,解决“最近侧边组合根本不可选”的问题
  if (routing === 'relaxed' && baseStartDirs.length > 1 && baseEndDirs.length > 1) {
    for (const startDir of baseStartDirs) {
      for (const endDir of baseEndDirs) {
        pushBaseCandidate(startDir, endDir)
      }
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

        // relaxed：self-loop 同样要更新端口占用，否则后续边仍可能挤同一端口
        if (routing === 'relaxed' && graph.portUsage) {
          const startPortIdx = edge.startDir.x + edge.startDir.y * 3
          const endPortIdx = edge.endDir.x + edge.endDir.y * 3
          graph.portUsage[edge.from.index * 9 + startPortIdx] = (graph.portUsage[edge.from.index * 9 + startPortIdx] ?? 0) + 1
          graph.portUsage[edge.to.index * 9 + endPortIdx] = (graph.portUsage[edge.to.index * 9 + endPortIdx] ?? 0) + 1
        }

        return
      }
    }
  }

  // baseEndDirs 已在上方 baseCandidates 阶段计算,这里直接复用。
  // 用户规则（梳子口端口）：
  // - Unicode 下希望端口沿边框分布（通过 lane/offset 实现），而不是“从拐角出线”。
  // - 因此 relaxed + Unicode 时不再把 corner port 当作候选端口。
  //
  // 说明：
  // - corner port 的几何自由度更高（能从两个方向出/入），确实能提升“极端拥挤”场景的可达性；
  // - 但它会让线路贴角，读图非常痛苦（也更容易把 box corner 合成 `┼`）。
  // - 我们优先遵守用户的可读性规则；若遇到不可达，外层 layoutMargin 重试会提供更多 free cell。
  //
  // 但在实践中, 仍然存在一些“几何上只有 corner port 才可达”的图（尤其当节点声明顺序与边顺序不一致时）。
  // 这类情况下, 与其让边直接消失/整图渲染失败, 更好的策略是:
  // - 先按规则尝试“四边端口”；
  // - 若完全不可达, 再把 corner port 作为最后兜底（并用 portPenalty 强烈惩罚, 让它只在必要时被选中）。
  const allowCornerPorts = routing === 'relaxed' && graph.config.useAscii
  const cornerDirs = [UpperRight, UpperLeft, LowerRight, LowerLeft]
  const expandedStartDirs = uniqueDirections([
    preferredDir, alternativeDir,
    // strict：只扩展“四边端口”，避免把线路引到 box 的角落（角落更容易压到 box 角）
    // relaxed：允许角落作为额外“分流端口”，减少多边挤同一侧造成的重叠/绕路
    Right, Left, Down, Up,
    ...(allowCornerPorts ? [UpperRight, UpperLeft, LowerRight, LowerLeft] : []),
  ])
  const expandedEndDirs = uniqueDirections([
    preferredOppositeDir, alternativeOppositeDir,
    Right, Left, Down, Up,
    ...(allowCornerPorts ? [UpperRight, UpperLeft, LowerRight, LowerLeft] : []),
  ])

  const expandedStartCandidates = buildCandidates(expandedStartDirs, baseEndDirs)
  const expandedAllCandidates = buildCandidates(expandedStartDirs, expandedEndDirs)

  // corner fallback: 仅在“完全不可达”时才启用（避免改变大量既有输出）。
  const expandedStartDirsWithCorners = uniqueDirections([...expandedStartDirs, ...cornerDirs])
  const expandedEndDirsWithCorners = uniqueDirections([...expandedEndDirs, ...cornerDirs])
  const expandedAllCandidatesEndCorners = buildCandidates(expandedStartDirs, expandedEndDirsWithCorners)
  const expandedAllCandidatesFullCorners = buildCandidates(expandedStartDirsWithCorners, expandedEndDirsWithCorners)

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
        const cost = candidateCostStrict(c, pathIdx)
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
        const cost = candidateCostStrict(c, strictPathIdx)
        if (!best || cost < best.cost) {
          best = { candidate: c, pathIdx: strictPathIdx, cost }
        }
      }

      if (best) return best
    }

    return null
  }

  function pickBestRelaxed(
    candidates: Candidate[],
    expandSteps: readonly number[],
    allowEndSegmentReuse: boolean,
  ): { candidate: Candidate; pathIdx: number[]; cost: number } | null {
    if (!usageMap) return null

    const constraints: StrictPathConstraints = {
      segmentUsage: usageMap,
      usedPoints,
      routeFromIdx: 0,
      routeToIdx: 0,
      edgeFromId: edge.from.index + 1,
      edgeToId: edge.to.index + 1,
      // relaxed：默认尽量避免终点段复用；不可达时再放开（否则多入边同侧会几何不可达）
      relaxedAllowEndSegmentReuse: allowEndSegmentReuse,
    }

    for (const expandBy of expandSteps) {
      const bounds = computeSearchBounds(expandBy)
      let best: { candidate: Candidate; pathIdx: number[]; cost: number } | null = null

      for (const c of candidates) {
        constraints.routeFromIdx = c.routeFromIdx
        constraints.routeToIdx = c.routeToIdx

        const result = getPathRelaxed(aStar, c.routeFromIdx, c.routeToIdx, bounds, constraints)
        if (!result) continue
        if (isSelfLoop && mergePathLengthIdx(result.path, aStar.stride) < 4) continue

        const cost = candidateCostRelaxed(c, result)
        if (!best || cost < best.cost) {
          best = { candidate: c, pathIdx: result.path, cost }
        }
      }

      if (best) return best
    }

    return null
  }

  let picked: { candidate: Candidate; pathIdx: number[]; cost: number } | null = null

  if (routing === 'relaxed') {
    // relaxed：可读性优先 —— 允许交叉/复用，但用惩罚项尽量减少“太乱”的路线。
    //
    // 仍然保持“分层扩展候选 + FAST→FULL bounds”的策略：
    // - 先走更保守的候选（pref/alt），大多数边很快就能找到直观路线
    // - 再扩大候选集合（更多端口组合），解决多出边节点的拥挤问题
    function pickBetter(a: typeof picked, b: typeof picked): typeof picked {
      if (!a) return b
      if (!b) return a
      if (b.cost < a.cost) return b
      if (b.cost > a.cost) return a

      // cost 相同: 再按“拐点更少”做 tie-break，避免同长度下出现台阶型 zigzag。
      const aTurns = mergePathLengthIdx(a.pathIdx, aStar.stride)
      const bTurns = mergePathLengthIdx(b.pathIdx, aStar.stride)
      return bTurns < aTurns ? b : a
    }

    function tryPickRelaxed(allowEndSegmentReuse: boolean): typeof picked {
      function shouldProbeExpandedAllFast(startFast: NonNullable<typeof picked>): boolean {
        // 仅 Unicode relaxed 下触发:
        // - 当当前候选明显“绕远或折返”时,补一次 expandedAll 探测。
        if (graph.config.useAscii) return false

        const from = idxToGridCoord(aStar.stride, startFast.candidate.routeFromIdx)
        const to = idxToGridCoord(aStar.stride, startFast.candidate.routeToIdx)
        const manhattan = Math.abs(from.x - to.x) + Math.abs(from.y - to.y) + 1
        const extraSteps = startFast.pathIdx.length - manhattan
        const longPath = startFast.pathIdx.length >= 28
        const manyTurns = mergePathLengthIdx(startFast.pathIdx, aStar.stride) >= 8
        const largeDetour = extraSteps >= 12
        return longPath || manyTurns || largeDetour
      }

      const baseFast = pickBestRelaxed(baseCandidates, ROUTING_BOUNDS_EXPAND_STEPS_FAST, allowEndSegmentReuse)
      if (baseFast) {
        let best = baseFast

        // 质量兜底(仅在 relaxed + FAST 下启用):
        // - 某些图里 baseCandidates 虽然可达,但会产生“绕大圈/大矩形”的丑路径;
        // - 更常见的原因是: endDir 已被几何限制(例如目标上方被节点挡住),导致 baseCandidates 只能选到某个 endDir,
        //   此时我们不希望更换 endDir(会让箭头方向更反直觉),而是只扩展 startDir 以寻求更直接的出边口。
        const baseTurns = mergePathLengthIdx(best.pathIdx, aStar.stride) - 2
        const TURN_THRESHOLD = 4
        if (baseTurns > TURN_THRESHOLD) {
          const startOnlyCandidates = buildCandidates(expandedStartDirs, [best.candidate.endDir])
          const startOnlyBest = pickBestRelaxed(startOnlyCandidates, ROUTING_BOUNDS_EXPAND_STEPS_FAST, allowEndSegmentReuse)
          best = pickBetter(best, startOnlyBest)
        }

        // 质量兜底(2): 避免“踩到已占用的 junction 点位”
        //
        // 背景(用户反馈):
        // - relaxed 允许 crossing(交错),但用户明确不希望出现“共享走线/误连线”的 junction(`┬/┴/├/┤`);
        // - usedPoints penalty 虽然会让 A* 尽量避开已占用点,但在 FAST bounds 下,
        //   有时会因为可用空间不足而被迫穿过某个已占用 junction,最终在绘制层合成一个 `┬`,
        //   读图会非常困惑。
        //
        // 策略:
        // - 当 FAST 结果仍然经过“已占用且至少两向连通”的点位时,
        //   额外执行一次“大 bounds(384)”搜索,给 A* 更多 free cell,
        //   让它有机会用更清晰的绕行替代 junction 复用。
        //
        // 性能取舍:
        // - 只在检测到该类坏味道时触发(大多数边不会走到这里);
        // - 仍然只搜索 baseCandidates(最多 4 个),避免 expandedAllCandidates 带来爆炸性调用数。
        if (usedPoints && best.pathIdx.length >= 4) {
          let touchesUsedJunction = false
          for (let i = 1; i < best.pathIdx.length - 1; i++) {
            const idx = best.pathIdx[i]!
            const mask = usedPoints[idx] ?? 0
            // 至少 2 个 bit => 该点已经是“线段点位”(junction/corner/through),再走进去基本会合成更复杂的 junction。
            if (mask !== 0 && (mask & (mask - 1)) !== 0) {
              touchesUsedJunction = true
              break
            }
          }

          if (touchesUsedJunction) {
            const qualityBest = pickBestRelaxed(baseCandidates, [ROUTING_MAX_BOUNDS_EXPAND_BY], allowEndSegmentReuse)
            best = pickBetter(best, qualityBest)
          }
        }

        // 关键修复:
        // - 以前 baseFast 可达后会直接返回,导致 expandedAll 的“近侧边候选”无机会参与比较;
        // - 现在仅在检测到“侧穿/错轴/偏长”坏味道时,追加一次 expandedAll FAST 探测。
        if (shouldProbeExpandedAllFast(best)) {
          const allFast = pickBestRelaxed(expandedAllCandidates, ROUTING_BOUNDS_EXPAND_STEPS_FAST, allowEndSegmentReuse)
          best = pickBetter(best, allFast)

          // 如果 FAST 仍然没有给出明显更优结果,再给 expandedAll 一次 FULL 探测机会:
          // - 只在坏味道场景触发,控制性能成本;
          // - 解决“FAST bounds 可达但仍绕远,而 FULL bounds 有近侧路径”的情况。
          const allFull = pickBestRelaxed(expandedAllCandidates, ROUTING_BOUNDS_EXPAND_STEPS_FULL, allowEndSegmentReuse)
          best = pickBetter(best, allFull)
        }
        return best
      }

      const startFast = pickBestRelaxed(expandedStartCandidates, ROUTING_BOUNDS_EXPAND_STEPS_FAST, allowEndSegmentReuse)
      const allFast = startFast
        ? (shouldProbeExpandedAllFast(startFast)
            ? pickBestRelaxed(expandedAllCandidates, ROUTING_BOUNDS_EXPAND_STEPS_FAST, allowEndSegmentReuse)
            : null)
        : pickBestRelaxed(expandedAllCandidates, ROUTING_BOUNDS_EXPAND_STEPS_FAST, allowEndSegmentReuse)

      let best = pickBetter(startFast, allFast)

      // startFast 分支同样允许“坏味道时再做一次 FULL 探测”:
      // - 避免 startFast 一旦可达就把 FULL 阶段短路掉。
      if (best && shouldProbeExpandedAllFast(best)) {
        const allFull = pickBestRelaxed(expandedAllCandidates, ROUTING_BOUNDS_EXPAND_STEPS_FULL, allowEndSegmentReuse)
        best = pickBetter(best, allFull)
      }

      best = best
        ?? pickBestRelaxed(baseCandidates, ROUTING_BOUNDS_EXPAND_STEPS_FULL, allowEndSegmentReuse)
        ?? pickBestRelaxed(expandedStartCandidates, ROUTING_BOUNDS_EXPAND_STEPS_FULL, allowEndSegmentReuse)
        ?? pickBestRelaxed(expandedAllCandidates, ROUTING_BOUNDS_EXPAND_STEPS_FULL, allowEndSegmentReuse)

      return best
    }

    function pickRelaxedWithEndReuseComparison(
      pickedWithoutReuse: typeof picked,
      pickedWithReuse: typeof picked,
    ): typeof picked {
      // 纯近路优先:
      // - withReuse / withoutReuse 都求解;
      // - 统一按成本最低者选择,不做额外方向性偏置。
      return pickBetter(pickedWithoutReuse, pickedWithReuse)
    }

    // 终点段复用策略:
    //
    // - ASCII(strict/relaxed) 下,多个箭头如果落到同一个 cell,会严重歧义,因此默认尽量不复用终点段;
    // - Unicode relaxed 下,我们有 comb ports(梳子口端口)可以把端点分 lane,
    //   此时“同靶终点段复用”反而是更符合直觉的选择:
    //   - 能让多入边保持从“最近侧边”进入,
    //   - 避免为了躲避终点段冲突而被迫换到远侧端口,导致绕弯/兜圈。
    //
    // 之前是“按顺序先试一种策略,命中就直接返回”。
    // 现在改为“先分别求解,再比较质量”,避免顺序偏置让更优候选被提前截断。
    const pickedWithoutReuse = tryPickRelaxed(false)
    const pickedWithReuse = tryPickRelaxed(true)
    picked = pickRelaxedWithEndReuseComparison(pickedWithoutReuse, pickedWithReuse)

    // corner fallback（最后兜底）：
    // - 仅当“四边端口”完全不可达时才启用；
    // - 用 portPenalty 强烈惩罚 corner port, 让它只在必要时出现。
    if (!picked) {
      function tryPickRelaxedWithCornerPorts(allowEndSegmentReuse: boolean): typeof picked {
        let best = pickBestRelaxed(expandedAllCandidatesEndCorners, ROUTING_BOUNDS_EXPAND_STEPS_FAST, allowEndSegmentReuse)
          ?? pickBestRelaxed(expandedAllCandidatesFullCorners, ROUTING_BOUNDS_EXPAND_STEPS_FAST, allowEndSegmentReuse)

        best = best
          ?? pickBestRelaxed(expandedAllCandidatesEndCorners, ROUTING_BOUNDS_EXPAND_STEPS_FULL, allowEndSegmentReuse)
          ?? pickBestRelaxed(expandedAllCandidatesFullCorners, ROUTING_BOUNDS_EXPAND_STEPS_FULL, allowEndSegmentReuse)

        return best
      }

      picked = tryPickRelaxedWithCornerPorts(false) ?? tryPickRelaxedWithCornerPorts(true)
    }
  } else if (!usageMap || usageMap.usedCount === 0) {
    // strict + usageMap 为空：完全按旧逻辑（pref/alt）选最短，避免影响 golden。
    picked = pickBestFallback(baseCandidates, ROUTING_BOUNDS_EXPAND_STEPS_FAST)
  } else {
    // strict：规整/可逆优先 —— 启用“硬约束避交叉/避非法共线”。
    //
    // 规则（用户需求）：
    // - 同源：允许“起点段”共线
    // - 同靶：允许“终点段”共线
    // - 其它：不允许共线
    //
    // 同时采用“分层扩展候选”减少 A* 调用次数：
    // - 先尝试最保守的候选（pref/alt）
    // - 再扩大候选集合（更多起止方向组合）
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

  // -------------------------------------------------------------------------
  // 最后兜底(保证“永远可渲染”)
  //
  // 现象(你的复现用例):
  // - relaxed 在“禁止 segment overlap”的 hard rule 下,某些边可能几何上不可达;
  // - 一旦任意边 path=[]:
  //   - createMappingOnce() 会返回 false;
  //   - 外层 createMapping() 会反复 layoutMargin 重试(最多 5 次);
  //   - 最终仍失败时会留下半成品状态,导致输出“只有线段,没有 node box/label”。这是灾难级体验。
  //
  // 取舍:
  // - 我们仍然优先遵守 relaxed 的可读性约束(不共线/少误连线);
  // - 但当所有候选都不可达时,必须优先保证“图能画出来”,否则用户连 debug 的抓手都没有。
  //
  // 做法:
  // - 仅在 relaxed 且完全不可达时触发;
  // - 回退到无 strict/relaxed 约束的 `getPath()`:
  //   - 仍然避开 node 的 blocked 区域;
  //   - 仍然使用 bounds 防止无限搜索;
  //   - 但允许与已有边发生共线/交叉(后续可再通过 penalty/后处理继续改良)。
  //
  // 性能收益:
  // - 这个兜底能显著减少“不可达候选 + 反复扩 bounds”的无意义搜索;
  // - 更关键的是: 能让 createMapping 在第一次尝试就成功返回,避免 5 次全量重跑。
  // -------------------------------------------------------------------------
  if (!picked && routing === 'relaxed' && allowUnconstrainedFallback) {
    ;(edge as any).__bm_used_unconstrained_fallback = true
    picked = pickBestFallback(baseCandidates, ROUTING_BOUNDS_EXPAND_STEPS_FAST)
      ?? pickBestFallback(expandedStartCandidates, ROUTING_BOUNDS_EXPAND_STEPS_FAST)
      ?? pickBestFallback(expandedAllCandidates, ROUTING_BOUNDS_EXPAND_STEPS_FAST)
      ?? pickBestFallback(expandedAllCandidatesEndCorners, ROUTING_BOUNDS_EXPAND_STEPS_FAST)
      ?? pickBestFallback(expandedAllCandidatesFullCorners, ROUTING_BOUNDS_EXPAND_STEPS_FULL)
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

  // relaxed：更新端口占用统计，让后续边更倾向分散出入点
  if (routing === 'relaxed' && graph.portUsage) {
    const startPortIdx = edge.startDir.x + edge.startDir.y * 3
    const endPortIdx = edge.endDir.x + edge.endDir.y * 3
    graph.portUsage[edge.from.index * 9 + startPortIdx] = (graph.portUsage[edge.from.index * 9 + startPortIdx] ?? 0) + 1
    graph.portUsage[edge.to.index * 9 + endPortIdx] = (graph.portUsage[edge.to.index * 9 + endPortIdx] ?? 0) + 1
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
    const lineWidth = calculateLineWidthForLabel(graph, edge, line)

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

    const candidateBox = getLabelBox(graph, edge, line, edge.text)
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

  // 给 label 腾空间时, 不能随便扩宽某一整列:
  // - columnWidth 是“整列共享”的全局值, 扩宽会影响所有行;
  // - 如果 middleX 落在某个 node 的 3x3 block 列(尤其是 node.gridCoord.x 顶点列),
  //   这会把 node box 的坐标系整体挤歪, 导致 edge 端口视觉上落入 box 内部。
  //
  // 修复策略(仅 relaxed + Unicode):
  // - 优先仍扩宽 middleX, 保持旧行为;
  // - 若 middleX 命中任意 node block 列, 则在 [minX..maxX] 内寻找最近的“非 node block 列”来扩宽。
  //   这样 label 仍有空间, 但不会误伤 node 列。
  let widenX = middleX
  const enableSafeWiden = graph.config.routing === 'relaxed' && !graph.config.useAscii
  if (enableSafeWiden) {
    const nodeBlockCols = new Set<number>()
    for (const n of graph.nodes) {
      if (!n.gridCoord) continue
      nodeBlockCols.add(n.gridCoord.x)
      nodeBlockCols.add(n.gridCoord.x + 1)
      nodeBlockCols.add(n.gridCoord.x + 2)
    }

    if (nodeBlockCols.has(widenX)) {
      const maxDelta = maxX - minX
      for (let delta = 1; delta <= maxDelta; delta++) {
        const left = widenX - delta
        if (left >= minX && left <= maxX && !nodeBlockCols.has(left)) {
          widenX = left
          break
        }

        const right = widenX + delta
        if (right >= minX && right <= maxX && !nodeBlockCols.has(right)) {
          widenX = right
          break
        }
      }
    }
  }

  const current = graph.columnWidth.get(widenX) ?? 0
  // 关键改良:
  // - 旧实现会“无条件”把某一整列 columnWidth 拉到 `labelWidth+2`，
  //   即使当前线段的总宽度已经足够放下 label。
  // - 这会制造大量无意义空白,让画布宽度膨胀,并放大 detour 的视觉成本(更像画外框)。
  //
  // 新策略:
  // - 只在“当前线段总宽度不足”时,按缺口做最小增量扩列。
  // - 这样既保持 label 不裁剪(可逆自证),又显著减少空白与外框概率。
  const desiredTotalWidth = lenLabel + 2
  const currentTotalWidth = calculateLineWidthForLabel(graph, edge, chosenLine)
  if (currentTotalWidth < desiredTotalWidth) {
    const delta = desiredTotalWidth - currentTotalWidth
    graph.columnWidth.set(widenX, current + delta)
  }

  edge.labelLine = [chosenLine[0], chosenLine[1]]
}

/**
 * 计算 labelLine 的“有效可用宽度”(用于决定是否需要扩列)。
 *
 * 注意:
 * - edge.path 的端点通常落在 node 的 3x3 block 边框上(即 box border 的同一列/行)。
 * - 绘制时,线段会从 box border 外侧开始/结束,端点列宽大部分不可用于写 label。
 * - 如果我们把端点列宽也算进去,会误判为“线段已足够宽”,最终导致:
 *   - Unicode strict: drawTextOnLine 找不到合法位置,直接不画 label(回归: build.task 消失)。
 *   - ASCII strict: 找不到合法位置时仍会画,进而覆盖箭头/拐点(回归: -sends> 退化为 sends)。
 *
 * 因此:
 * - 对“水平线段”且端点命中 edge.path 的起点/终点时,把两端端点列宽扣掉,
 *   让 widen 逻辑只针对“真正可写字的线段空间”。
 * - 非端点/非水平线段保持旧逻辑,避免引入不必要的漂移。
 */
function calculateLineWidthForLabel(graph: AsciiGraph, edge: AsciiEdge, line: [GridCoord, GridCoord]): number {
  let total = 0
  const startX = Math.min(line[0].x, line[1].x)
  const endX = Math.max(line[0].x, line[1].x)
  for (let x = startX; x <= endX; x++) {
    total += graph.columnWidth.get(x) ?? 0
  }

  // 仅对水平段做端点修正(与 drawTextOnLine 的“横向写字”语义一致)
  if (line[0].y === line[1].y && edge.path.length >= 2) {
    const startPort = edge.path[0]!
    const endPort = edge.path[edge.path.length - 1]!

    const left = (line[0].x <= line[1].x) ? line[0] : line[1]
    const right = (line[0].x <= line[1].x) ? line[1] : line[0]

    if (gridCoordEquals(left, startPort) || gridCoordEquals(left, endPort)) {
      total -= graph.columnWidth.get(left.x) ?? 0
    }
    if (gridCoordEquals(right, startPort) || gridCoordEquals(right, endPort)) {
      total -= graph.columnWidth.get(right.x) ?? 0
    }
    if (total < 0) total = 0
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
 * 将 GridCoord 转为 DrawingCoord（用于 label 碰撞判定，考虑 comb ports 的 lane offset）。
 *
 * 背景:
 * - relaxed + Unicode 下,端口会通过 comb ports(梳子口)在同一格内做偏移;
 * - 绘制层使用 `gridToDrawingCoordForEdge()`(draw.ts) 会应用这些 offset;
 * - 如果 label 碰撞判定仍用“纯居中”坐标,就会出现:
 *   - 逻辑上认为不重叠,实际绘制却重叠(最终输出出现文字拼接/断线)。
 *
 * 说明:
 * - 这里刻意不从 draw.ts 导入实现,避免循环依赖;
 * - 逻辑保持与 draw.ts 一致,仅用于 label 盒子估算。
 */
function gridToDrawingCoordForLabelEdge(
  graph: AsciiGraph,
  edge: AsciiEdge,
  c: GridCoord,
): { x: number; y: number } {
  let xOrigin = graph.offsetX
  for (let col = 0; col < c.x; col++) xOrigin += graph.columnWidth.get(col) ?? 0

  let yOrigin = graph.offsetY
  for (let row = 0; row < c.y; row++) yOrigin += graph.rowHeight.get(row) ?? 0

  const colW = graph.columnWidth.get(c.x) ?? 0
  const rowH = graph.rowHeight.get(c.y) ?? 0

  let xOffset = Math.floor(colW / 2)
  let yOffset = Math.floor(rowH / 2)

  // comb ports：与 draw.ts 保持一致,仅把 offset 应用到“首段/末段”的两个端点。
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

  // 防御：offset 不能越界（否则会把 label box 估算到别的 cell，导致误判）
  if (xOffset < 0) xOffset = 0
  if (yOffset < 0) yOffset = 0
  if (colW > 0 && xOffset > colW - 1) xOffset = colW - 1
  if (rowH > 0 && yOffset > rowH - 1) yOffset = rowH - 1

  return {
    x: xOrigin + xOffset,
    y: yOrigin + yOffset,
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
function getLabelBox(graph: AsciiGraph, edge: AsciiEdge, line: [GridCoord, GridCoord], label: string): LabelBox | null {
  const labelWidth = textDisplayWidth(label)
  if (labelWidth <= 0) return null

  const a = gridToDrawingCoordForLabelEdge(graph, edge, line[0])
  const b = gridToDrawingCoordForLabelEdge(graph, edge, line[1])

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
    const box = getLabelBox(graph, edge, [edge.labelLine[0]!, edge.labelLine[1]!], edge.text)
    if (box) boxes.push(box)
  }
  return boxes
}
