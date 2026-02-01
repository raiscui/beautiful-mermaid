// ============================================================================
// ASCII renderer — direction system and edge path determination
//
// Ported from AlexanderGrooff/mermaid-ascii cmd/direction.go + cmd/mapping_edge.go.
// Handles direction constants, edge attachment point selection,
// and dual-path comparison for optimal edge routing.
// ============================================================================

import type { GridCoord, Direction, AsciiEdge, AsciiGraph } from './types.ts'
import {
  Up, Down, Left, Right, UpperRight, UpperLeft, LowerRight, LowerLeft, Middle,
  gridCoordDirection,
  gridCoordEquals,
} from './types.ts'
import { getPath, mergePath, type MoveCostFn } from './pathfinder.ts'
import { textDisplayWidth } from './canvas.ts'

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

export interface SegmentUsage {
  /**
   * 允许“同源起点共线”的 source 集合。
   *
   * 只有当某条边把该 segment 用作“起点段”（第一段）时，才会写入这里。
   * 这样才能满足用户规则：同源只能在起点共线，而不是“同源就可以复用任意线段”。
   */
  startSources: Set<string>

  /**
   * 允许“同靶终点共线”的 target 集合。
   *
   * 只有当某条边把该 segment 用作“终点段”（最后一段）时，才会写入这里。
   */
  endTargets: Set<string>

  /**
   * 该 segment 是否曾经作为“中间段”被任何边使用过。
   *
   * 中间段永远不允许共享：一旦出现，后续边应该严格避开。
   *（如果降级 penalty 模式被迫复用，也会把它标记为 true，从而让后续尽量绕开）
   */
  usedAsMiddle: boolean
}

export type SegmentUsageMap = Map<string, SegmentUsage>

/** 对“不允许共线”的线段复用施加的大惩罚（用于降级模式）。 */
const DISALLOWED_SEGMENT_PENALTY = 1_000

/** 把一条 unit segment（相邻两格）规范化成一个稳定 key（无向）。 */
function segmentKey(a: GridCoord, b: GridCoord): string {
  const aFirst = a.x < b.x || (a.x === b.x && a.y < b.y)
  const p = aFirst ? `${a.x},${a.y}` : `${b.x},${b.y}`
  const q = aFirst ? `${b.x},${b.y}` : `${a.x},${a.y}`
  return `${p}|${q}`
}

/** 记录某条边的路径占用了哪些 unit segments（用于后续边避让）。 */
function recordPathSegments(usageMap: SegmentUsageMap, edge: AsciiEdge, path: GridCoord[]): void {
  if (path.length < 2) return

  for (let i = 1; i < path.length; i++) {
    const from = path[i - 1]!
    const to = path[i]!
    const key = segmentKey(from, to)
    const isStartSegment = i === 1
    const isEndSegment = i === path.length - 1

    let usage = usageMap.get(key)
    if (!usage) {
      usage = { startSources: new Set(), endTargets: new Set(), usedAsMiddle: false }
      usageMap.set(key, usage)
    }

    if (isStartSegment) usage.startSources.add(edge.from.name)
    if (isEndSegment) usage.endTargets.add(edge.to.name)
    if (!isStartSegment && !isEndSegment) usage.usedAsMiddle = true
  }
}

function isAllowedToShareSegmentStrict(
  edge: AsciiEdge,
  routeFrom: GridCoord,
  routeTo: GridCoord,
  stepFrom: GridCoord,
  stepTo: GridCoord,
  usage: SegmentUsage,
): boolean {
  // 一旦有边把这段当“中间段”用过，那么任何共享都会让语义变得更难读。
  if (usage.usedAsMiddle) return false

  const isStartStep = gridCoordEquals(stepFrom, routeFrom)
  const isEndStep = gridCoordEquals(stepTo, routeTo)

  // 特殊情况：from 与 to 紧挨着时，这一段既是起点段也是终点段。
  // 我们只允许“同源 + 同靶”的边共享它（例如多条平行边），避免引入混淆。
  if (isStartStep && isEndStep) {
    const startOk = usage.startSources.size === 0
      || (usage.startSources.size === 1 && usage.startSources.has(edge.from.name))
    const endOk = usage.endTargets.size === 0
      || (usage.endTargets.size === 1 && usage.endTargets.has(edge.to.name))
    return startOk && endOk
  }

  // 同源：只允许“起点段”共线，并且该段只能属于这一类起点共享（不能混入其它 target/end 共享）
  if (isStartStep) {
    return usage.endTargets.size === 0
      && usage.startSources.size === 1
      && usage.startSources.has(edge.from.name)
  }

  // 同靶：只允许“终点段”共线，并且该段只能属于这一类终点共享
  if (isEndStep) {
    return usage.startSources.size === 0
      && usage.endTargets.size === 1
      && usage.endTargets.has(edge.to.name)
  }

  return false
}

function makeStrictMoveCost(
  usageMap: SegmentUsageMap,
  edge: AsciiEdge,
  routeFrom: GridCoord,
  routeTo: GridCoord,
): MoveCostFn {
  return (stepFrom, stepTo) => {
    const usage = usageMap.get(segmentKey(stepFrom, stepTo))
    if (!usage) return 1

    if (isAllowedToShareSegmentStrict(edge, routeFrom, routeTo, stepFrom, stepTo, usage)) {
      return 1
    }

    // 严格模式：不允许的共线直接禁止（让 A* 只能绕开）
    return null
  }
}

function makePenaltyMoveCost(
  usageMap: SegmentUsageMap,
  edge: AsciiEdge,
  routeFrom: GridCoord,
  routeTo: GridCoord,
): MoveCostFn {
  return (stepFrom, stepTo) => {
    const usage = usageMap.get(segmentKey(stepFrom, stepTo))
    if (!usage) return 1

    if (isAllowedToShareSegmentStrict(edge, routeFrom, routeTo, stepFrom, stepTo, usage)) {
      return 1
    }

    // 降级模式：允许复用，但代价非常高（尽量避免共线）
    return 1 + DISALLOWED_SEGMENT_PENALTY
  }
}

function computePathCost(path: GridCoord[], moveCost?: MoveCostFn): number {
  if (path.length < 2) return 0
  if (!moveCost) return path.length - 1

  let total = 0
  for (let i = 1; i < path.length; i++) {
    const cost = moveCost(path[i - 1]!, path[i]!)
    if (cost === null) return Number.POSITIVE_INFINITY
    total += cost
  }
  return total
}

/**
 * Determine the path for an edge by trying two candidate routes (preferred + alternative)
 * and picking the shorter one. Sets edge.path, edge.startDir, edge.endDir.
 */
export function determinePath(graph: AsciiGraph, edge: AsciiEdge, usageMap?: SegmentUsageMap): void {
  const [preferredDir, preferredOppositeDir, alternativeDir, alternativeOppositeDir] =
    determineStartAndEndDir(edge, graph.config.graphDirection)

  interface Candidate {
    startDir: Direction
    endDir: Direction
    routeFrom: GridCoord
    routeTo: GridCoord
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
        candidates.push({
          startDir,
          endDir,
          routeFrom: gridCoordDirection(edge.from.gridCoord!, startDir),
          routeTo: gridCoordDirection(edge.to.gridCoord!, endDir),
        })
      }
    }
    return candidates
  }

  // baseCandidates 必须尽量保持“旧行为”：
  // 旧实现只尝试 2 条路径：
  // - preferredDir -> preferredOppositeDir
  // - alternativeDir -> alternativeOppositeDir
  //
  // 这里不要把 startDirs/endDirs 做笛卡尔积（会引入新的组合，从而改变大量 golden）。
  const baseCandidates: Candidate[] = []
  baseCandidates.push({
    startDir: preferredDir,
    endDir: preferredOppositeDir,
    routeFrom: gridCoordDirection(edge.from.gridCoord!, preferredDir),
    routeTo: gridCoordDirection(edge.to.gridCoord!, preferredOppositeDir),
  })

  // alternative 可能与 preferred 相同（例如某些方向判断分支），这里去重。
  if (!dirEquals(preferredDir, alternativeDir) || !dirEquals(preferredOppositeDir, alternativeOppositeDir)) {
    baseCandidates.push({
      startDir: alternativeDir,
      endDir: alternativeOppositeDir,
      routeFrom: gridCoordDirection(edge.from.gridCoord!, alternativeDir),
      routeTo: gridCoordDirection(edge.to.gridCoord!, alternativeOppositeDir),
    })
  }

  const baseEndDirs = uniqueDirections([preferredOppositeDir, alternativeOppositeDir])
  const expandedStartDirs = uniqueDirections([
    preferredDir, alternativeDir,
    Right, Left, Down, Up,
    UpperRight, UpperLeft, LowerRight, LowerLeft,
  ])
  const expandedEndDirs = uniqueDirections([
    preferredOppositeDir, alternativeOppositeDir,
    Right, Left, Down, Up,
    UpperRight, UpperLeft, LowerRight, LowerLeft,
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
  const BOUNDS_EXPAND_STEPS = [12, 24, 48, 96]

  function computeSearchBounds(routeFrom: GridCoord, routeTo: GridCoord, expandBy: number): { maxX: number; maxY: number } {
    let maxX = Math.max(routeFrom.x, routeTo.x)
    let maxY = Math.max(routeFrom.y, routeTo.y)

    for (const node of graph.nodes) {
      if (!node.gridCoord) continue
      // node 占据 3x3（x..x+2, y..y+2）
      maxX = Math.max(maxX, node.gridCoord.x + 2)
      maxY = Math.max(maxY, node.gridCoord.y + 2)
    }

    return { maxX: maxX + expandBy, maxY: maxY + expandBy }
  }

  function pickBestFallback(candidates: Candidate[]): { candidate: Candidate; path: GridCoord[]; cost: number } | null {
    let best: { candidate: Candidate; path: GridCoord[]; cost: number } | null = null

    for (const c of candidates) {
      const path = getPath(graph.grid, c.routeFrom, c.routeTo)
      if (!path) continue
      // 保持旧逻辑：用 mergePath 后的“折线段数量”做比较，
      // 这样会倾向更少拐点的路线（更像人画出来的线）。
      const cost = mergePath(path).length
      if (!best || cost < best.cost) {
        best = { candidate: c, path, cost }
      }
    }

    return best
  }

  function pickBestStrict(candidates: Candidate[]): { candidate: Candidate; path: GridCoord[]; cost: number } | null {
    if (!usageMap || usageMap.size === 0) return null

    for (const expandBy of BOUNDS_EXPAND_STEPS) {
      let best: { candidate: Candidate; path: GridCoord[]; cost: number } | null = null

      for (const c of candidates) {
        const strictMoveCost = makeStrictMoveCost(usageMap, edge, c.routeFrom, c.routeTo)
        const bounds = computeSearchBounds(c.routeFrom, c.routeTo, expandBy)
        const strictPath = getPath(graph.grid, c.routeFrom, c.routeTo, strictMoveCost, bounds)
        if (!strictPath) continue

        // strict 下我们同样优先更少拐点（而不是更短距离），避免出现“绕来绕去但步数差不多”的丑路径。
        const cost = mergePath(strictPath).length
        if (!best || cost < best.cost) {
          best = { candidate: c, path: strictPath, cost }
        }
      }

      if (best) return best
    }

    return null
  }

  function pickBestPenalty(candidates: Candidate[]): { candidate: Candidate; path: GridCoord[]; cost: number } | null {
    if (!usageMap || usageMap.size === 0) return null

    for (const expandBy of BOUNDS_EXPAND_STEPS) {
      let best: { candidate: Candidate; path: GridCoord[]; cost: number } | null = null

      for (const c of candidates) {
        const penaltyMoveCost = makePenaltyMoveCost(usageMap, edge, c.routeFrom, c.routeTo)
        const bounds = computeSearchBounds(c.routeFrom, c.routeTo, expandBy)
        const penaltyPath = getPath(graph.grid, c.routeFrom, c.routeTo, penaltyMoveCost, bounds)
        if (!penaltyPath) continue

        const cost = computePathCost(penaltyPath, penaltyMoveCost)
        // penalty 的 primary 目标是：尽量避免不允许的共线（penaltyCost 越小越好）。
        // 当 penaltyCost 相同，再倾向更少拐点的路线，让输出更像“手绘”。
        if (!best) {
          best = { candidate: c, path: penaltyPath, cost }
          continue
        }

        if (cost < best.cost) {
          best = { candidate: c, path: penaltyPath, cost }
          continue
        }

        if (cost === best.cost) {
          const mergedLen = mergePath(penaltyPath).length
          const bestMergedLen = mergePath(best.path).length
          if (mergedLen < bestMergedLen) {
            best = { candidate: c, path: penaltyPath, cost }
          }
        }
      }

      if (best) return best
    }

    return null
  }

  let picked: { candidate: Candidate; path: GridCoord[]; cost: number } | null = null

  if (!usageMap || usageMap.size === 0) {
    // usageMap 为空：完全按旧逻辑（pref/alt）选最短，避免影响 golden。
    picked = pickBestFallback(baseCandidates)
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
    picked = pickBestStrict(baseCandidates)
      ?? pickBestStrict(expandedStartCandidates)
      ?? pickBestStrict(expandedAllCandidates)

    const hasDisallowedOverlap = (p: { path: GridCoord[]; cost: number }): boolean => {
      const baseSteps = Math.max(0, p.path.length - 1)
      return p.cost > baseSteps
    }

    if (!picked) {
      picked = pickBestPenalty(baseCandidates)

      if (picked && hasDisallowedOverlap(picked)) {
        const expanded = pickBestPenalty(expandedStartCandidates)
        if (expanded && expanded.cost < picked.cost) picked = expanded
      }

      if (picked && hasDisallowedOverlap(picked)) {
        const expandedAll = pickBestPenalty(expandedAllCandidates)
        if (expandedAll && expandedAll.cost < picked.cost) picked = expandedAll
      }
    }

    // 极端兜底：如果 strict/penalty 都找不到路，则回退到旧逻辑（至少保证有边）
    if (!picked) {
      picked = pickBestFallback(expandedAllCandidates)
    }
  }

  if (!picked) {
    edge.startDir = preferredDir
    edge.endDir = preferredOppositeDir
    edge.path = []
    return
  }

  edge.startDir = picked.candidate.startDir
  edge.endDir = picked.candidate.endDir
  edge.path = mergePath(picked.path)

  if (usageMap) {
    recordPathSegments(usageMap, edge, picked.path)
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

    if (!overlapsExisting) {
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
