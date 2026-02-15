// ============================================================================
// ASCII renderer — A* pathfinding for edge routing
//
// Ported from AlexanderGrooff/mermaid-ascii cmd/arrow.go.
// Uses A* search with a corner-penalizing heuristic to find clean
// paths between nodes on the grid. Prefers straight lines over zigzags.
// ============================================================================

import type { GridCoord } from './types.ts'

// ============================================================================
// Strict constraints (for ASCII edge routing)
//
// 说明：
// - Rust CLI 使用 QuickJS（无 JIT），如果把 moveCost 做成“每步回调函数”，会慢到离谱。
// - 因此这里提供 `getPathStrict`：把“共线/┼”约束内联到 A* 循环里，避免函数调用开销。
// - 但仅靠 JS 层优化仍然很难把 QuickJS 场景压到 1s 内；
//   因此 Rust CLI 会额外注入 native pathfinder（见下文 `__bm_getPath*`）。
// ============================================================================

export interface SegmentUsageArrays {
  segmentUsed: Uint8Array
  usedAsMiddle: Uint8Array
  // 同端点平行边共享干线: segmentPair / segmentPairMulti
  //
  // 说明:
  // - pairId = (fromId << 16) | toId,其中 fromId/toId 为 1-based node id；
  // - 当同一 segment 被多个不同 pair 使用过时,segmentPairMulti 会被置 1,
  //   这样只有“干净的单 pair segment”才允许平行边复用(避免误连线)。
  segmentPair: Uint32Array
  segmentPairMulti: Uint8Array
  startSource: Uint32Array
  startSourceMulti: Uint8Array
  endTarget: Uint32Array
  endTargetMulti: Uint8Array
}

export interface StrictPathConstraints {
  segmentUsage: SegmentUsageArrays
  usedPoints?: Uint8Array
  routeFromIdx: number
  routeToIdx: number
  edgeFromId: number
  edgeToId: number

  /**
   * relaxed 专用：是否允许“同靶终点最后一段”复用已占用 segment。
   *
   * 背景：
   * - 在 node 仍是 3x3 block 的架构下，同一 side port 的边界格子往往只有一个 free neighbor；
   * - 当多条边需要从同一侧进入同一节点时，“最后一段 unit segment”在几何上是唯一的；
   * - 如果严格禁止该段复用，会导致 relaxed 路由不可达，进而让渲染流程崩溃。
   *
   * 策略：
   * - relaxed 默认仍优先“禁止终点段复用”（更符合直觉）；
   * - 但当不可达时，允许同靶终点最后一段复用，并依赖 comb ports 在绘制层分 lane，
   *   保证端点点位（箭头格子）不重叠。
   */
  relaxedAllowEndSegmentReuse?: boolean
}

export interface RelaxedPathResult {
  /** 包含 fromIdx 与 toIdx 的路径 idx 列表 */
  path: number[]
  /** A* 的累计代价（包含步长 + 惩罚项），用于候选比较 */
  cost: number
}

/** A* 搜索的边界（用于避免在“目标不可达”时在无限网格里跑到天荒地老）。 */
export interface GridBounds {
  maxX: number
  maxY: number
}

// ============================================================================
// Native fast path (Rust CLI only)
//
// 说明：
// - `beautiful-mermaid-rs` 会在 QuickJS Context 初始化阶段注入全局函数：
//   - `globalThis.__bm_getPath(...)`
//   - `globalThis.__bm_getPathStrict(...)`
//   - `globalThis.__bm_getPathRelaxed(...)`
// - 在浏览器/Bun 环境里这些函数不存在，因此这里会自动回退到纯 JS 实现。
//
// 性能动机：
// - QuickJS 无 JIT，A* 的热循环（heap pop + 4 邻居扩展）解释执行极慢。
// - 把 A* 移到 Rust（编译优化）后，CLI 的端到端耗时才能有机会压到 <1s。
// ============================================================================

type NativeGetPath = (
  stride: number,
  fromIdx: number,
  toIdx: number,
  maxX: number,
  maxY: number,
  blocked: Uint8Array,
) => number[] | null

type NativeGetPathStrict = (
  stride: number,
  fromIdx: number,
  toIdx: number,
  maxX: number,
  maxY: number,
  blocked: Uint8Array,
  constraints: StrictPathConstraints,
) => number[] | null

type NativeGetPathRelaxed = (
  stride: number,
  fromIdx: number,
  toIdx: number,
  maxX: number,
  maxY: number,
  blocked: Uint8Array,
  constraints: StrictPathConstraints,
) => RelaxedPathResult | null

// ============================================================================
// Priority queue (min-heap) for A* open set
// ============================================================================

/**
 * Simple min-heap priority queue.
 *
 * 性能要点：
 * - 用 3 个平行数组存储（idx / priority / cost），避免在热循环里分配对象
 * - pop() 通过写入字段返回结果，避免分配临时对象/数组
 */
class MinHeap {
  private idxs: number[] = []
  private priorities: number[] = []
  private costs: number[] = []

  poppedIdx = -1
  poppedPriority = 0
  poppedCost = 0

  get length(): number {
    return this.idxs.length
  }

  clear(): void {
    this.idxs.length = 0
    this.priorities.length = 0
    this.costs.length = 0
    this.poppedIdx = -1
    this.poppedPriority = 0
    this.poppedCost = 0
  }

  push(idx: number, priority: number, cost: number): void {
    this.idxs.push(idx)
    this.priorities.push(priority)
    this.costs.push(cost)
    this.bubbleUp(this.idxs.length - 1)
  }

  pop(): boolean {
    if (this.idxs.length === 0) return false

    this.poppedIdx = this.idxs[0]!
    this.poppedPriority = this.priorities[0]!
    this.poppedCost = this.costs[0]!

    const lastIdx = this.idxs.pop()!
    const lastPriority = this.priorities.pop()!
    const lastCost = this.costs.pop()!

    if (this.idxs.length > 0) {
      this.idxs[0] = lastIdx
      this.priorities[0] = lastPriority
      this.costs[0] = lastCost
      this.sinkDown(0)
    }

    return true
  }

  private bubbleUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (this.priorities[i]! < this.priorities[parent]!) {
        ;[this.idxs[i], this.idxs[parent]] = [this.idxs[parent]!, this.idxs[i]!]
        ;[this.priorities[i], this.priorities[parent]] = [this.priorities[parent]!, this.priorities[i]!]
        ;[this.costs[i], this.costs[parent]] = [this.costs[parent]!, this.costs[i]!]
        i = parent
      } else {
        break
      }
    }
  }

  private sinkDown(i: number): void {
    const n = this.idxs.length
    while (true) {
      let smallest = i
      const left = 2 * i + 1
      const right = 2 * i + 2
      if (left < n && this.priorities[left]! < this.priorities[smallest]!) {
        smallest = left
      }
      if (right < n && this.priorities[right]! < this.priorities[smallest]!) {
        smallest = right
      }
      if (smallest !== i) {
        ;[this.idxs[i], this.idxs[smallest]] = [this.idxs[smallest]!, this.idxs[i]!]
        ;[this.priorities[i], this.priorities[smallest]] = [this.priorities[smallest]!, this.priorities[i]!]
        ;[this.costs[i], this.costs[smallest]] = [this.costs[smallest]!, this.costs[i]!]
        i = smallest
      } else {
        break
      }
    }
  }
}

// ============================================================================
// A* pathfinding (fast)
// ============================================================================

export interface AStarContext {
  /** 坐标压缩：idx = x + y * stride */
  stride: number
  /** y 维度大小（height = maxY + 1） */
  height: number
  /** 节点占用格子：1=被 node 3x3 占用，0=free cell */
  blocked: Uint8Array

  // ------------------------------------------------------------
  // 复用缓存（避免每次 getPath 都重新分配/清空大表）
  // ------------------------------------------------------------

  stamp: number
  /** costStamp[idx] === stamp 表示本次 search 写入过 cost */
  costStamp: Uint32Array
  /** costSoFar（只在 costStamp==stamp 时有效） */
  costSoFar: Float64Array
  /** cameFrom（父节点 idx），用于回溯路径 */
  cameFrom: Int32Array
  heap: MinHeap
}

export function makeAStarContext(stride: number, height: number): AStarContext {
  const cellCount = stride * height
  return {
    stride,
    height,
    blocked: new Uint8Array(cellCount),
    stamp: 0,
    costStamp: new Uint32Array(cellCount),
    costSoFar: new Float64Array(cellCount),
    cameFrom: new Int32Array(cellCount),
    heap: new MinHeap(),
  }
}

export function gridCoordToIdx(stride: number, c: GridCoord): number {
  return c.x + c.y * stride
}

export function idxToGridCoord(stride: number, idx: number): GridCoord {
  const y = (idx / stride) | 0
  const x = idx - y * stride
  return { x, y }
}

export function mergePathLengthIdx(path: number[], stride: number): number {
  void stride
  if (path.length <= 2) return path.length

  // mergedLen = 2 + turns
  let turns = 0
  let prevDelta = path[1]! - path[0]!

  for (let i = 2; i < path.length; i++) {
    const delta = path[i]! - path[i - 1]!
    if (delta !== prevDelta) {
      turns++
      prevDelta = delta
    }
  }

  return 2 + turns
}

export function mergePathIdx(path: number[], stride: number): number[] {
  void stride
  if (path.length <= 2) return path

  const out: number[] = [path[0]!]
  let prevDelta = path[1]! - path[0]!

  for (let i = 2; i < path.length; i++) {
    const delta = path[i]! - path[i - 1]!
    if (delta !== prevDelta) {
      out.push(path[i - 1]!)
      prevDelta = delta
    }
  }

  out.push(path[path.length - 1]!)
  return out
}

/**
 * A* 搜索（有边界）。
 *
 * 返回：
 * - number[]：路径 idx 列表（包含 fromIdx 与 toIdx）
 * - null：不可达
 */
export function getPath(
  ctx: AStarContext,
  fromIdx: number,
  toIdx: number,
  bounds: GridBounds,
): number[] | null {
  // Rust CLI 快速路径：把热循环挪到 native（Rust）里跑。
  const native = (globalThis as any).__bm_getPath as NativeGetPath | undefined
  if (typeof native === 'function') {
    return native(ctx.stride, fromIdx, toIdx, bounds.maxX, bounds.maxY, ctx.blocked)
  }

  const { stride } = ctx
  const maxX = bounds.maxX
  const maxY = bounds.maxY

  if (maxX < 0 || maxY < 0) return null

  const toY = (toIdx / stride) | 0
  const toX = toIdx - toY * stride

  // stamp 递增；溢出后回到 1（0 作为“未使用”保留）
  ctx.stamp = (ctx.stamp + 1) >>> 0
  if (ctx.stamp === 0) ctx.stamp = 1
  const stamp = ctx.stamp

  ctx.heap.clear()

  ctx.costStamp[fromIdx] = stamp
  ctx.costSoFar[fromIdx] = 0
  ctx.cameFrom[fromIdx] = -1
  ctx.heap.push(fromIdx, 0, 0)

  while (ctx.heap.pop()) {
    const currentIdx = ctx.heap.poppedIdx
    const currentCostAtPush = ctx.heap.poppedCost

    // 旧的堆项（被更优路径覆盖）直接跳过，避免重复扩展
    if (ctx.costStamp[currentIdx] !== stamp) continue
    if (currentCostAtPush !== ctx.costSoFar[currentIdx]!) continue

    if (currentIdx === toIdx) {
      const path: number[] = []
      let c = currentIdx
      while (c !== -1) {
        path.push(c)
        c = ctx.cameFrom[c]!
      }
      path.reverse()
      return path
    }

    const currentCost = ctx.costSoFar[currentIdx]!
    const currentY = (currentIdx / stride) | 0
    const currentX = currentIdx - currentY * stride

    // ---------------------------------------------------------------------
    // 4-directional movement (no diagonals in grid pathfinding)
    // 注意：node 占用格子（blocked=1）不可走，但允许把 toIdx 作为“终点”走进去
    // ---------------------------------------------------------------------

    // 右
    if (currentX < maxX) {
      const nextIdx = currentIdx + 1
      if (!ctx.blocked[nextIdx] || nextIdx === toIdx) {
        const newCost = currentCost + 1
        if (ctx.costStamp[nextIdx] !== stamp || newCost < ctx.costSoFar[nextIdx]!) {
          ctx.costStamp[nextIdx] = stamp
          ctx.costSoFar[nextIdx] = newCost
          ctx.cameFrom[nextIdx] = currentIdx

          const absX = (currentX + 1) >= toX ? (currentX + 1) - toX : toX - (currentX + 1)
          const absY = currentY >= toY ? currentY - toY : toY - currentY
          const h = (absX === 0 || absY === 0) ? (absX + absY) : (absX + absY + 1)
          ctx.heap.push(nextIdx, newCost + h, newCost)
        }
      }
    }

    // 左
    if (currentX > 0) {
      const nextIdx = currentIdx - 1
      if (!ctx.blocked[nextIdx] || nextIdx === toIdx) {
        const newCost = currentCost + 1
        if (ctx.costStamp[nextIdx] !== stamp || newCost < ctx.costSoFar[nextIdx]!) {
          ctx.costStamp[nextIdx] = stamp
          ctx.costSoFar[nextIdx] = newCost
          ctx.cameFrom[nextIdx] = currentIdx

          const absX = (currentX - 1) >= toX ? (currentX - 1) - toX : toX - (currentX - 1)
          const absY = currentY >= toY ? currentY - toY : toY - currentY
          const h = (absX === 0 || absY === 0) ? (absX + absY) : (absX + absY + 1)
          ctx.heap.push(nextIdx, newCost + h, newCost)
        }
      }
    }

    // 下
    if (currentY < maxY) {
      const nextIdx = currentIdx + stride
      if (!ctx.blocked[nextIdx] || nextIdx === toIdx) {
        const newCost = currentCost + 1
        if (ctx.costStamp[nextIdx] !== stamp || newCost < ctx.costSoFar[nextIdx]!) {
          ctx.costStamp[nextIdx] = stamp
          ctx.costSoFar[nextIdx] = newCost
          ctx.cameFrom[nextIdx] = currentIdx

          const absX = currentX >= toX ? currentX - toX : toX - currentX
          const absY = (currentY + 1) >= toY ? (currentY + 1) - toY : toY - (currentY + 1)
          const h = (absX === 0 || absY === 0) ? (absX + absY) : (absX + absY + 1)
          ctx.heap.push(nextIdx, newCost + h, newCost)
        }
      }
    }

    // 上
    if (currentY > 0) {
      const nextIdx = currentIdx - stride
      if (!ctx.blocked[nextIdx] || nextIdx === toIdx) {
        const newCost = currentCost + 1
        if (ctx.costStamp[nextIdx] !== stamp || newCost < ctx.costSoFar[nextIdx]!) {
          ctx.costStamp[nextIdx] = stamp
          ctx.costSoFar[nextIdx] = newCost
          ctx.cameFrom[nextIdx] = currentIdx

          const absX = currentX >= toX ? currentX - toX : toX - currentX
          const absY = (currentY - 1) >= toY ? (currentY - 1) - toY : toY - (currentY - 1)
          const h = (absX === 0 || absY === 0) ? (absX + absY) : (absX + absY + 1)
          ctx.heap.push(nextIdx, newCost + h, newCost)
        }
      }
    }
  }

  return null
}

const CONNECT_LEFT = 1 << 0
const CONNECT_RIGHT = 1 << 1
const CONNECT_UP = 1 << 2
const CONNECT_DOWN = 1 << 3

/**
 * A* 搜索（strict 约束版）。
 *
 * 约束：
 * - 禁止形成 `┼` 四向交叉（usedPoints bitmask）
 * - 遵守 segment 共享规则（segmentUsage arrays）
 *
 * 重要：
 * - 这里把“能否走这一步”的判定内联到循环里，避免 QuickJS 下的回调开销。
 */
export function getPathStrict(
  ctx: AStarContext,
  fromIdx: number,
  toIdx: number,
  bounds: GridBounds,
  constraints: StrictPathConstraints,
): number[] | null {
  // Rust CLI 快速路径：严格约束版 A*（共线/交叉规则）同样放到 native。
  const native = (globalThis as any).__bm_getPathStrict as NativeGetPathStrict | undefined
  if (typeof native === 'function') {
    return native(
      ctx.stride,
      fromIdx,
      toIdx,
      bounds.maxX,
      bounds.maxY,
      ctx.blocked,
      constraints,
    )
  }

  const stride = ctx.stride
  const maxX = bounds.maxX
  const maxY = bounds.maxY

  if (maxX < 0 || maxY < 0) return null

  const toY = (toIdx / stride) | 0
  const toX = toIdx - toY * stride

  // stamp 递增；溢出后回到 1（0 作为“未使用”保留）
  ctx.stamp = (ctx.stamp + 1) >>> 0
  if (ctx.stamp === 0) ctx.stamp = 1
  const stamp = ctx.stamp

  const heap = ctx.heap
  const blocked = ctx.blocked
  const costStamp = ctx.costStamp
  const costSoFar = ctx.costSoFar
  const cameFrom = ctx.cameFrom

  heap.clear()

  costStamp[fromIdx] = stamp
  costSoFar[fromIdx] = 0
  cameFrom[fromIdx] = -1
  heap.push(fromIdx, 0, 0)

  // -----------------------------------------------------------------------
  // 约束（全部展开为局部变量，避免热循环里多层属性访问）
  // -----------------------------------------------------------------------
  const usedPoints = constraints.usedPoints

  const segmentUsage = constraints.segmentUsage
  const segmentUsed = segmentUsage.segmentUsed
  const usedAsMiddle = segmentUsage.usedAsMiddle
  const segmentPair = segmentUsage.segmentPair
  const segmentPairMulti = segmentUsage.segmentPairMulti
  const startSource = segmentUsage.startSource
  const startSourceMulti = segmentUsage.startSourceMulti
  const endTarget = segmentUsage.endTarget
  const endTargetMulti = segmentUsage.endTargetMulti

  const routeFromIdx = constraints.routeFromIdx
  const routeToIdx = constraints.routeToIdx
  const edgeFromId = constraints.edgeFromId
  const edgeToId = constraints.edgeToId

  // 用常量掩码避免在热循环里重复 OR
  const H_MASK = CONNECT_LEFT | CONNECT_RIGHT
  const V_MASK = CONNECT_UP | CONNECT_DOWN

  while (heap.pop()) {
    const currentIdx = heap.poppedIdx
    const currentCostAtPush = heap.poppedCost

    // 旧的堆项（被更优路径覆盖）直接跳过，避免重复扩展
    if (costStamp[currentIdx] !== stamp) continue
    if (currentCostAtPush !== costSoFar[currentIdx]!) continue

    if (currentIdx === toIdx) {
      const path: number[] = []
      let c = currentIdx
      while (c !== -1) {
        path.push(c)
        c = cameFrom[c]!
      }
      path.reverse()
      return path
    }

    const currentCost = costSoFar[currentIdx]!
    const currentY = (currentIdx / stride) | 0
    const currentX = currentIdx - currentY * stride

    // ---------------------------------------------------------------------
    // 4-directional movement (no diagonals in grid pathfinding)
    // 注意：node 占用格子（blocked=1）不可走，但允许把 toIdx 作为“终点”走进去
    // ---------------------------------------------------------------------

    // 右
    if (currentX < maxX) {
      const nextIdx = currentIdx + 1
      if (!blocked[nextIdx] || nextIdx === toIdx) {
        let ok = true

        // usedPoints：禁止形成 `┼` 四向交叉
        if (usedPoints) {
          const fromMask = usedPoints[currentIdx]!
          if (fromMask !== 0) {
            const nextMask = fromMask | CONNECT_RIGHT
            if ((nextMask & H_MASK) === H_MASK && (nextMask & V_MASK) === V_MASK) ok = false
          }
          if (ok) {
            const toMask = usedPoints[nextIdx]!
            if (toMask !== 0) {
              const nextMask = toMask | CONNECT_LEFT
              if ((nextMask & H_MASK) === H_MASK && (nextMask & V_MASK) === V_MASK) ok = false
            }
          }
        }

        // segmentUsage：严格共线规则（不允许的 segment 直接禁用）
        if (ok) {
          const segKey = currentIdx * 2
          if (segmentUsed[segKey]) {
            ok = false

            if (!usedAsMiddle[segKey]) {
              const isStartStep = currentIdx === routeFromIdx
              const isEndStep = nextIdx === routeToIdx

              const ss = startSource[segKey]!
              const et = endTarget[segKey]!
              const ssMulti = startSourceMulti[segKey]! !== 0
              const etMulti = endTargetMulti[segKey]! !== 0

              if (isStartStep && isEndStep) {
                const startOk = !ssMulti && (ss === 0 || ss === edgeFromId)
                const endOk = !etMulti && (et === 0 || et === edgeToId)
                ok = startOk && endOk
              } else if (isStartStep) {
                ok = !etMulti && et === 0 && !ssMulti && ss === edgeFromId
              } else if (isEndStep) {
                ok = !ssMulti && ss === 0 && !etMulti && et === edgeToId
              }
            }
          }
        }

        if (ok) {
          const newCost = currentCost + 1
          if (costStamp[nextIdx] !== stamp || newCost < costSoFar[nextIdx]!) {
            costStamp[nextIdx] = stamp
            costSoFar[nextIdx] = newCost
            cameFrom[nextIdx] = currentIdx

            const nextX = currentX + 1
            const absX = nextX >= toX ? nextX - toX : toX - nextX
            const absY = currentY >= toY ? currentY - toY : toY - currentY
            const h = (absX === 0 || absY === 0) ? (absX + absY) : (absX + absY + 1)
            heap.push(nextIdx, newCost + h, newCost)
          }
        }
      }
    }

    // 左
    if (currentX > 0) {
      const nextIdx = currentIdx - 1
      if (!blocked[nextIdx] || nextIdx === toIdx) {
        let ok = true

        if (usedPoints) {
          const fromMask = usedPoints[currentIdx]!
          if (fromMask !== 0) {
            const nextMask = fromMask | CONNECT_LEFT
            if ((nextMask & H_MASK) === H_MASK && (nextMask & V_MASK) === V_MASK) ok = false
          }
          if (ok) {
            const toMask = usedPoints[nextIdx]!
            if (toMask !== 0) {
              const nextMask = toMask | CONNECT_RIGHT
              if ((nextMask & H_MASK) === H_MASK && (nextMask & V_MASK) === V_MASK) ok = false
            }
          }
        }

        if (ok) {
          const segKey = nextIdx * 2
          if (segmentUsed[segKey]) {
            ok = false

            if (!usedAsMiddle[segKey]) {
              const isStartStep = currentIdx === routeFromIdx
              const isEndStep = nextIdx === routeToIdx

              const ss = startSource[segKey]!
              const et = endTarget[segKey]!
              const ssMulti = startSourceMulti[segKey]! !== 0
              const etMulti = endTargetMulti[segKey]! !== 0

              if (isStartStep && isEndStep) {
                const startOk = !ssMulti && (ss === 0 || ss === edgeFromId)
                const endOk = !etMulti && (et === 0 || et === edgeToId)
                ok = startOk && endOk
              } else if (isStartStep) {
                ok = !etMulti && et === 0 && !ssMulti && ss === edgeFromId
              } else if (isEndStep) {
                ok = !ssMulti && ss === 0 && !etMulti && et === edgeToId
              }
            }
          }
        }

        if (ok) {
          const newCost = currentCost + 1
          if (costStamp[nextIdx] !== stamp || newCost < costSoFar[nextIdx]!) {
            costStamp[nextIdx] = stamp
            costSoFar[nextIdx] = newCost
            cameFrom[nextIdx] = currentIdx

            const nextX = currentX - 1
            const absX = nextX >= toX ? nextX - toX : toX - nextX
            const absY = currentY >= toY ? currentY - toY : toY - currentY
            const h = (absX === 0 || absY === 0) ? (absX + absY) : (absX + absY + 1)
            heap.push(nextIdx, newCost + h, newCost)
          }
        }
      }
    }

    // 下
    if (currentY < maxY) {
      const nextIdx = currentIdx + stride
      if (!blocked[nextIdx] || nextIdx === toIdx) {
        let ok = true

        if (usedPoints) {
          const fromMask = usedPoints[currentIdx]!
          if (fromMask !== 0) {
            const nextMask = fromMask | CONNECT_DOWN
            if ((nextMask & H_MASK) === H_MASK && (nextMask & V_MASK) === V_MASK) ok = false
          }
          if (ok) {
            const toMask = usedPoints[nextIdx]!
            if (toMask !== 0) {
              const nextMask = toMask | CONNECT_UP
              if ((nextMask & H_MASK) === H_MASK && (nextMask & V_MASK) === V_MASK) ok = false
            }
          }
        }

        if (ok) {
          const segKey = currentIdx * 2 + 1
          if (segmentUsed[segKey]) {
            ok = false

            if (!usedAsMiddle[segKey]) {
              const isStartStep = currentIdx === routeFromIdx
              const isEndStep = nextIdx === routeToIdx

              const ss = startSource[segKey]!
              const et = endTarget[segKey]!
              const ssMulti = startSourceMulti[segKey]! !== 0
              const etMulti = endTargetMulti[segKey]! !== 0

              if (isStartStep && isEndStep) {
                const startOk = !ssMulti && (ss === 0 || ss === edgeFromId)
                const endOk = !etMulti && (et === 0 || et === edgeToId)
                ok = startOk && endOk
              } else if (isStartStep) {
                ok = !etMulti && et === 0 && !ssMulti && ss === edgeFromId
              } else if (isEndStep) {
                ok = !ssMulti && ss === 0 && !etMulti && et === edgeToId
              }
            }
          }
        }

        if (ok) {
          const newCost = currentCost + 1
          if (costStamp[nextIdx] !== stamp || newCost < costSoFar[nextIdx]!) {
            costStamp[nextIdx] = stamp
            costSoFar[nextIdx] = newCost
            cameFrom[nextIdx] = currentIdx

            const nextY = currentY + 1
            const absX = currentX >= toX ? currentX - toX : toX - currentX
            const absY = nextY >= toY ? nextY - toY : toY - nextY
            const h = (absX === 0 || absY === 0) ? (absX + absY) : (absX + absY + 1)
            heap.push(nextIdx, newCost + h, newCost)
          }
        }
      }
    }

    // 上
    if (currentY > 0) {
      const nextIdx = currentIdx - stride
      if (!blocked[nextIdx] || nextIdx === toIdx) {
        let ok = true

        if (usedPoints) {
          const fromMask = usedPoints[currentIdx]!
          if (fromMask !== 0) {
            const nextMask = fromMask | CONNECT_UP
            if ((nextMask & H_MASK) === H_MASK && (nextMask & V_MASK) === V_MASK) ok = false
          }
          if (ok) {
            const toMask = usedPoints[nextIdx]!
            if (toMask !== 0) {
              const nextMask = toMask | CONNECT_DOWN
              if ((nextMask & H_MASK) === H_MASK && (nextMask & V_MASK) === V_MASK) ok = false
            }
          }
        }

        if (ok) {
          const segKey = nextIdx * 2 + 1
          if (segmentUsed[segKey]) {
            ok = false

            if (!usedAsMiddle[segKey]) {
              const isStartStep = currentIdx === routeFromIdx
              const isEndStep = nextIdx === routeToIdx

              const ss = startSource[segKey]!
              const et = endTarget[segKey]!
              const ssMulti = startSourceMulti[segKey]! !== 0
              const etMulti = endTargetMulti[segKey]! !== 0

              if (isStartStep && isEndStep) {
                const startOk = !ssMulti && (ss === 0 || ss === edgeFromId)
                const endOk = !etMulti && (et === 0 || et === edgeToId)
                ok = startOk && endOk
              } else if (isStartStep) {
                ok = !etMulti && et === 0 && !ssMulti && ss === edgeFromId
              } else if (isEndStep) {
                ok = !ssMulti && ss === 0 && !etMulti && et === edgeToId
              }
            }
          }
        }

        if (ok) {
          const newCost = currentCost + 1
          if (costStamp[nextIdx] !== stamp || newCost < costSoFar[nextIdx]!) {
            costStamp[nextIdx] = stamp
            costSoFar[nextIdx] = newCost
            cameFrom[nextIdx] = currentIdx

            const nextY = currentY - 1
            const absX = currentX >= toX ? currentX - toX : toX - currentX
            const absY = nextY >= toY ? nextY - toY : toY - nextY
            const h = (absX === 0 || absY === 0) ? (absX + absY) : (absX + absY + 1)
            heap.push(nextIdx, newCost + h, newCost)
          }
        }
      }
    }
  }

  return null
}

// ============================================================================
// A* pathfinding (relaxed)
//
// 目标：
// - 可读性优先：允许交叉/复用，但通过“惩罚项”尽量减少过度重叠与 `┼`；
// - 保留 strict：用于可逆/规整场景（比如 golden/roundtrip）。
//
// 说明：
// - 惩罚项必须是非负数，这样 Manhattan heuristic 仍然是 admissible（不会高估）。
// - 这里同样把逻辑内联到热循环里，避免 QuickJS 场景函数回调开销。
// ============================================================================

// 惩罚值选择：
// - 数值不要太大，否则会退化成“为了避交叉而绕远”，违背 relaxed 的目标。
// - 这里给一个偏保守的默认值，后续可根据样例（Hat workflow）再微调。
const RELAXED_PENALTY_CROSSING = 1
// 走进已占用点（point overlap）的惩罚:
// - segment overlap（共线复用）已经被 hard rule 禁掉了；
// - 但不同边仍可能在某个 free cell “点相交/点合并”，Unicode 合成后会出现 `┴/┬/├/┤`,
//   视觉上像“共享走线”，用户会误读成一条双向边。
//
// 策略：
// - 仍然允许 crossing（交错），但让“走进已占用点”变贵，让 A* 在可行时更倾向绕开；
// - 起点第一步（从 routeFromIdx 出去）不加惩罚，否则多出边同侧会被几何锁死。
// 走进已占用点（point overlap）的惩罚:
// - 这不是 hard forbid,只是在 relaxed 下“尽量不让不同边在同一格相交/合并”;
// - 数值太小会导致 A* 仍偏好“更短但共享一个 junction 的路径”,最终在字符画里合成 `┬/┴/├/┤`,
//   读图时很容易误以为两条边真的连接在一起。
//
// 这里把 penalty 适度加大,让路由更稳定地绕开已占用点,同时保持可达性与性能(不增加 A* 次数)。
const RELAXED_PENALTY_USED_POINT = 8
const RELAXED_PENALTY_USED_POINT_JUNCTION = 512

function connectionDegree(mask: number): number {
  // mask 只会用到 4 个 bit,直接手写 popcount 更快也更稳定。
  return ((mask & CONNECT_LEFT) !== 0 ? 1 : 0)
    + ((mask & CONNECT_RIGHT) !== 0 ? 1 : 0)
    + ((mask & CONNECT_UP) !== 0 ? 1 : 0)
    + ((mask & CONNECT_DOWN) !== 0 ? 1 : 0)
}

/**
 * A* 搜索（relaxed 约束版）。
 *
 * 与 strict 的区别：
 * - strict：遇到非法交叉/共线直接禁用该步；
 * - relaxed：允许走，但会把它变成“更贵”的一步（惩罚），让 A* 在可行时自然避开。
 */
export function getPathRelaxed(
  ctx: AStarContext,
  fromIdx: number,
  toIdx: number,
  bounds: GridBounds,
  constraints: StrictPathConstraints,
): RelaxedPathResult | null {
  // Rust CLI 快速路径：relaxed 同样把热循环挪到 native（Rust）里跑。
  const native = (globalThis as any).__bm_getPathRelaxed as NativeGetPathRelaxed | undefined
  if (typeof native === 'function') {
    return native(ctx.stride, fromIdx, toIdx, bounds.maxX, bounds.maxY, ctx.blocked, constraints)
  }

  const stride = ctx.stride
  const maxX = bounds.maxX
  const maxY = bounds.maxY

  if (maxX < 0 || maxY < 0) return null

  const toY = (toIdx / stride) | 0
  const toX = toIdx - toY * stride

  // stamp 递增；溢出后回到 1（0 作为“未使用”保留）
  ctx.stamp = (ctx.stamp + 1) >>> 0
  if (ctx.stamp === 0) ctx.stamp = 1
  const stamp = ctx.stamp

  const heap = ctx.heap
  const blocked = ctx.blocked
  const costStamp = ctx.costStamp
  const costSoFar = ctx.costSoFar
  const cameFrom = ctx.cameFrom

  heap.clear()

  costStamp[fromIdx] = stamp
  costSoFar[fromIdx] = 0
  cameFrom[fromIdx] = -1
  heap.push(fromIdx, 0, 0)

  // -----------------------------------------------------------------------
  // 约束数据（展开为局部变量）
  // -----------------------------------------------------------------------
  const usedPoints = constraints.usedPoints

  const segmentUsage = constraints.segmentUsage
  const segmentUsed = segmentUsage.segmentUsed
  const usedAsMiddle = segmentUsage.usedAsMiddle
  // 同端点平行边共享干线所需的 pair 标记数组。
  // - segmentPair: 某段线当前归属的 pairId
  // - segmentPairMulti: 某段线是否被多个 pair 复用过
  const segmentPair = segmentUsage.segmentPair
  const segmentPairMulti = segmentUsage.segmentPairMulti
  const startSource = segmentUsage.startSource
  const startSourceMulti = segmentUsage.startSourceMulti
  const endTarget = segmentUsage.endTarget
  const endTargetMulti = segmentUsage.endTargetMulti

  const routeFromIdx = constraints.routeFromIdx
  const routeToIdx = constraints.routeToIdx
  const edgeFromId = constraints.edgeFromId
  const edgeToId = constraints.edgeToId
  const relaxedAllowEndSegmentReuse = constraints.relaxedAllowEndSegmentReuse === true

  // 同端点平行边共享干线：把 (from,to) 打包成一个稳定的 pairId。
  //
  // 说明:
  // - 这不是“图语义”的 id,只是用于 routing 期间识别“同一对节点”的平行边；
  // - 极端大图如果超过 16-bit,我们退化为 0(禁用该优化),避免位运算溢出导致误共享。
  const edgePairId = (edgeFromId > 0xffff || edgeToId > 0xffff)
    ? 0
    : ((edgeFromId << 16) | edgeToId)

  function isSamePairSegment(segKey: number): boolean {
    return edgePairId !== 0
      && segmentPairMulti[segKey] === 0
      && segmentPair[segKey] === edgePairId
  }

  // 用常量掩码避免在热循环里重复 OR
  const H_MASK = CONNECT_LEFT | CONNECT_RIGHT
  const V_MASK = CONNECT_UP | CONNECT_DOWN

  // 4-bit bitcount 查表(0..15)：
  // - usedPoints 的方向 mask 只使用 4 个 bit
  // - 热循环里避免调用 popcount/Math 逻辑,用 O(1) 查表更稳
  const BITCOUNT_4: readonly number[] = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4]

  function crossingPenalty(fromMask: number, addBit: number): number {
    if (fromMask === 0) return 0
    const nextMask = fromMask | addBit
    return ((nextMask & H_MASK) === H_MASK && (nextMask & V_MASK) === V_MASK)
      ? RELAXED_PENALTY_CROSSING
      : 0
  }

  // -----------------------------------------------------------------------
  // relaxed：不重叠规则（用户强诉求）
  //
  // 用户期望：
  // - 允许交错（crossing），因为 Unicode 可以后处理桥化，且“交错不等于连接”
  // - 但不同边 **不要共线重叠**，否则在“合并后再分开”的地方会完全读不清
  // - 同源边允许“起点段”共线（只允许第一段）
  // - 终点“点位”必须分开（不要画到同一个箭头格子上）
  //
  // 做法：
  // - 对“已被占用的 unit segment”，默认直接禁用（hard rule）
  // - 允许复用的情况仅限：
  //   - 同 source 的起点第一段（分叉可读）
  //   - 同 target 的终点最后一段（避免“多入边同侧”在几何上不可达；Unicode comb ports 会在绘制层分 lane）
  //
  // 重要：
  // - 这里用 hard rule，而不是“大惩罚”：
  //   - 大惩罚会让 A* 在巨大的搜索空间里反复试错，性能更差；
  //   - hard rule 直接裁掉不合法分支，往往更快也更符合用户预期。
  // -----------------------------------------------------------------------
  function isAllowedToReuseUsedSegment(segKey: number, isStartStep: boolean, isEndStep: boolean): boolean {
    if (!segmentUsed[segKey]) return true

    // ---------------------------------------------------------------------
    // 同端点平行边共享干线（终端可读性关键改良）
    //
    // 病灶:
    // - 同一对节点(from->to)存在多条带 label 的边时,如果强行“禁止 segment overlap”,
    //   这些边会被挤到不同通道,最后必然绕外圈形成大矩形,并制造大量 junction。
    //
    // 目标:
    // - 仅对“完全相同端点的平行边”允许复用已占用 segment,
    //   让它们共享同一条干线(视觉上更像同一关系的多种事件)。
    //
    // 安全阈:
    // - segmentPairMulti=1 表示该 segment 曾被多个不同 pair 使用过,
    //   此时禁止共享,避免把不相关的边合并成一条线(误连线灾难)。
    // ---------------------------------------------------------------------
    if (isSamePairSegment(segKey)) {
      return true
    }

    // 中间段永不允许复用：它必然意味着“合并后再分开”的重叠。
    //
    // 注意:
    // - 上面已经为“同端点平行边共享”开了口,因此这里的含义变为:
    //   “不同端点的边不要在中段共线重叠”。
    if (usedAsMiddle[segKey]) return false

    // relaxed 默认仍优先“禁止终点段复用”（更符合直觉）。
    // 只有在 edge-routing 进入 fallback（不可达）时，才会打开 relaxedAllowEndSegmentReuse。
    if (isEndStep && !relaxedAllowEndSegmentReuse) return false

    const ss = startSource[segKey]!
    const et = endTarget[segKey]!
    const ssMulti = startSourceMulti[segKey]! !== 0
    const etMulti = endTargetMulti[segKey]! !== 0

    // 特殊情况：from 与 to 紧挨着时，这一段既是起点段也是终点段。
    // 我们只允许“同源 + 同靶”的边共享它（例如多条平行边），避免引入混淆。
    if (isStartStep && isEndStep) {
      const startOk = !ssMulti && (ss === 0 || ss === edgeFromId)
      const endOk = !etMulti && (et === 0 || et === edgeToId)
      return startOk && endOk
    }

    // 同源：只允许“起点段”复用，并且该段不能混入任何 end 复用（避免读图歧义）。
    if (isStartStep) {
      // 重要取舍(终端可读性优先):
      // - 不允许 start 段与 end 段共享同一 unit segment。
      // - 否则双向边(A->B 与 B->A)会在节点端口附近“合并成一条线”,人类很难追踪每条 label 的归属。
      //
      // 因此这里保持更强的约束:
      // - start 段只允许与“同 source 的 start 段”复用；
      // - 该 segment 不能同时作为任何边的 end 段(et 必须为 0)。
      return !etMulti && et === 0 && !ssMulti && ss === edgeFromId
    }

    // 同靶：允许“终点段”复用（最后一段；仅 fallback 开启）。
    //
    // 说明：
    // - 对于 3x3 node block 的边界点，进入某些 side port 时“最后一段”在几何上是唯一的；
    //   如果完全禁止终点段复用，会让“多入边同侧”变成不可达。
    // - 在 Unicode relaxed 下，comb ports 会把端点分散到不同 lane，
    //   因此即使 grid segment 复用，最终也不会画到同一个“箭头格子”（不会重叠）。
    if (isEndStep) {
      // 同靶：允许“终点段”复用（最后一段；仅 fallback 开启）。
      // 但仍然禁止与任何 start 段混用(ss 必须为 0),否则会在 target 端口附近形成难以读懂的合并线。
      return !ssMulti && ss === 0 && !etMulti && et === edgeToId
    }

    return false
  }

  while (heap.pop()) {
    const currentIdx = heap.poppedIdx
    const currentCostAtPush = heap.poppedCost

    // 旧的堆项（被更优路径覆盖）直接跳过，避免重复扩展
    if (costStamp[currentIdx] !== stamp) continue
    if (currentCostAtPush !== costSoFar[currentIdx]!) continue

    if (currentIdx === toIdx) {
      const path: number[] = []
      let c = currentIdx
      while (c !== -1) {
        path.push(c)
        c = cameFrom[c]!
      }
      path.reverse()
      return { path, cost: costSoFar[currentIdx]! }
    }

    const currentCost = costSoFar[currentIdx]!
    const currentY = (currentIdx / stride) | 0
    const currentX = currentIdx - currentY * stride

    // ---------------------------------------------------------------------
    // 4-directional movement (no diagonals in grid pathfinding)
    // 注意：node 占用格子（blocked=1）不可走，但允许把 toIdx 作为“终点”走进去
    // ---------------------------------------------------------------------

    // 右
    if (currentX < maxX) {
      const nextIdx = currentIdx + 1
      if (!blocked[nextIdx] || nextIdx === toIdx) {
        let penalty = 0
        let ok = true
        const segKey = currentIdx * 2

        // 交叉惩罚（`┼`）
        if (usedPoints) {
          penalty += crossingPenalty(usedPoints[currentIdx]!, CONNECT_RIGHT)
          penalty += crossingPenalty(usedPoints[nextIdx]!, CONNECT_LEFT)

          // 点重叠惩罚：尽量不要走进已被其它边占用的 free cell。
          //
          // 注意:
          // - 只惩罚“进入 nextIdx”这一刻,避免对“离开占用点”重复计费；
          // - 起点第一步不惩罚(多出边同侧经常需要共享第一步)。
          // 点重叠 hard rule（但对“起点第一步 / 终点前一步”做更细的豁免）:
          //
          // 背景:
          // - 我们确实需要允许“同源多出边”在几何上共享第一步,否则会把路由器逼到死角；
          // - 同样的,多入边同侧时,终点前的那一格 free cell 往往是“唯一可达通道”；
          //   comb ports 会在绘制层把箭头分 lane,所以这里允许“同靶汇入”的受控共享；
          // - 但如果第一步直接走进一个“会形成 3/4 向 junction”的已占用点,
          //   会在绘制层制造强歧义(例如你反馈的 `◄──┴──►` / 看起来像误连线)。
          //
          // 规则:
          // - 非起点第一步: 禁止走进任何已占用点；
          // - 起点第一步 / 终点前一步: 只允许走进“不会形成 3+ 向 junction”的点位(<=2 arms)。
          if (nextIdx !== toIdx) {
            const mask = usedPoints[nextIdx]!
            if (mask !== 0) {
              const diffToTarget = routeToIdx - nextIdx
              const isPreTarget = diffToTarget === 1
                || diffToTarget === -1
                || diffToTarget === stride
                || diffToTarget === -stride

              const nextMask = (mask | CONNECT_LEFT) & 0xF
              const arms = BITCOUNT_4[nextMask]!

              // 同端点平行边共享干线:
              // - 允许它们“走进已占用点”,从而复用整条路径；
              // - 但仍然禁止制造 3+ arms junction(否则又会变线团)。
              if (isSamePairSegment(segKey) && arms <= 2) {
                // ok: 复用既有直线段不会增加 arms
              } else if (currentIdx !== routeFromIdx && !isPreTarget) {
                ok = false
              } else if (currentIdx === routeFromIdx) {
                // 起点第一步: 不允许制造 3+ arms junction
                if (arms >= 3) ok = false
              } else {
                // 终点前一步: 允许 T junction(3 arms) 汇入,但禁止 `┼`(4 arms)
                if (arms >= 4) ok = false
              }
            }
          }
        }

        // segment 复用 hard rule（不重叠 + 禁终点复用）
        if (ok && isAllowedToReuseUsedSegment(segKey, currentIdx === routeFromIdx, nextIdx === routeToIdx)) {
          const newCost = currentCost + 1 + penalty
          if (costStamp[nextIdx] !== stamp || newCost < costSoFar[nextIdx]!) {
            costStamp[nextIdx] = stamp
            costSoFar[nextIdx] = newCost
            cameFrom[nextIdx] = currentIdx

            const nextX = currentX + 1
            const absX = nextX >= toX ? nextX - toX : toX - nextX
            const absY = currentY >= toY ? currentY - toY : toY - currentY
            const h = (absX === 0 || absY === 0) ? (absX + absY) : (absX + absY + 1)
            heap.push(nextIdx, newCost + h, newCost)
          }
        }
      }
    }

    // 左
    if (currentX > 0) {
      const nextIdx = currentIdx - 1
      if (!blocked[nextIdx] || nextIdx === toIdx) {
        let penalty = 0
        let ok = true
        const segKey = nextIdx * 2

        if (usedPoints) {
          penalty += crossingPenalty(usedPoints[currentIdx]!, CONNECT_LEFT)
          penalty += crossingPenalty(usedPoints[nextIdx]!, CONNECT_RIGHT)

          if (nextIdx !== toIdx) {
            const mask = usedPoints[nextIdx]!
            if (mask !== 0) {
              const diffToTarget = routeToIdx - nextIdx
              const isPreTarget = diffToTarget === 1
                || diffToTarget === -1
                || diffToTarget === stride
                || diffToTarget === -stride

              const nextMask = (mask | CONNECT_RIGHT) & 0xF
              const arms = BITCOUNT_4[nextMask]!

              if (isSamePairSegment(segKey) && arms <= 2) {
                // ok: 同端点平行边复用直线段
              } else if (currentIdx !== routeFromIdx && !isPreTarget) {
                ok = false
              } else if (currentIdx === routeFromIdx) {
                if (arms >= 3) ok = false
              } else if (arms >= 4) {
                ok = false
              }
            }
          }
        }

        if (ok && isAllowedToReuseUsedSegment(segKey, currentIdx === routeFromIdx, nextIdx === routeToIdx)) {
          const newCost = currentCost + 1 + penalty
          if (costStamp[nextIdx] !== stamp || newCost < costSoFar[nextIdx]!) {
            costStamp[nextIdx] = stamp
            costSoFar[nextIdx] = newCost
            cameFrom[nextIdx] = currentIdx

            const nextX = currentX - 1
            const absX = nextX >= toX ? nextX - toX : toX - nextX
            const absY = currentY >= toY ? currentY - toY : toY - currentY
            const h = (absX === 0 || absY === 0) ? (absX + absY) : (absX + absY + 1)
            heap.push(nextIdx, newCost + h, newCost)
          }
        }
      }
    }

    // 下
    if (currentY < maxY) {
      const nextIdx = currentIdx + stride
      if (!blocked[nextIdx] || nextIdx === toIdx) {
        let penalty = 0
        let ok = true
        const segKey = currentIdx * 2 + 1

        if (usedPoints) {
          penalty += crossingPenalty(usedPoints[currentIdx]!, CONNECT_DOWN)
          penalty += crossingPenalty(usedPoints[nextIdx]!, CONNECT_UP)

          if (nextIdx !== toIdx) {
            const mask = usedPoints[nextIdx]!
            if (mask !== 0) {
              const diffToTarget = routeToIdx - nextIdx
              const isPreTarget = diffToTarget === 1
                || diffToTarget === -1
                || diffToTarget === stride
                || diffToTarget === -stride

              const nextMask = (mask | CONNECT_UP) & 0xF
              const arms = BITCOUNT_4[nextMask]!

              if (isSamePairSegment(segKey) && arms <= 2) {
                // ok: 同端点平行边复用直线段
              } else if (currentIdx !== routeFromIdx && !isPreTarget) {
                ok = false
              } else if (currentIdx === routeFromIdx) {
                if (arms >= 3) ok = false
              } else if (arms >= 4) {
                ok = false
              }
            }
          }
        }

        if (ok && isAllowedToReuseUsedSegment(segKey, currentIdx === routeFromIdx, nextIdx === routeToIdx)) {
          const newCost = currentCost + 1 + penalty
          if (costStamp[nextIdx] !== stamp || newCost < costSoFar[nextIdx]!) {
            costStamp[nextIdx] = stamp
            costSoFar[nextIdx] = newCost
            cameFrom[nextIdx] = currentIdx

            const nextY = currentY + 1
            const absX = currentX >= toX ? currentX - toX : toX - currentX
            const absY = nextY >= toY ? nextY - toY : toY - nextY
            const h = (absX === 0 || absY === 0) ? (absX + absY) : (absX + absY + 1)
            heap.push(nextIdx, newCost + h, newCost)
          }
        }
      }
    }

    // 上
    if (currentY > 0) {
      const nextIdx = currentIdx - stride
      if (!blocked[nextIdx] || nextIdx === toIdx) {
        let penalty = 0
        let ok = true
        const segKey = nextIdx * 2 + 1

        if (usedPoints) {
          penalty += crossingPenalty(usedPoints[currentIdx]!, CONNECT_UP)
          penalty += crossingPenalty(usedPoints[nextIdx]!, CONNECT_DOWN)

          if (nextIdx !== toIdx) {
            const mask = usedPoints[nextIdx]!
            if (mask !== 0) {
              const diffToTarget = routeToIdx - nextIdx
              const isPreTarget = diffToTarget === 1
                || diffToTarget === -1
                || diffToTarget === stride
                || diffToTarget === -stride

              const nextMask = (mask | CONNECT_DOWN) & 0xF
              const arms = BITCOUNT_4[nextMask]!

              if (isSamePairSegment(segKey) && arms <= 2) {
                // ok: 同端点平行边复用直线段
              } else if (currentIdx !== routeFromIdx && !isPreTarget) {
                ok = false
              } else if (currentIdx === routeFromIdx) {
                if (arms >= 3) ok = false
              } else if (arms >= 4) {
                ok = false
              }
            }
          }
        }

        if (ok && isAllowedToReuseUsedSegment(segKey, currentIdx === routeFromIdx, nextIdx === routeToIdx)) {
          const newCost = currentCost + 1 + penalty
          if (costStamp[nextIdx] !== stamp || newCost < costSoFar[nextIdx]!) {
            costStamp[nextIdx] = stamp
            costSoFar[nextIdx] = newCost
            cameFrom[nextIdx] = currentIdx

            const nextY = currentY - 1
            const absX = currentX >= toX ? currentX - toX : toX - currentX
            const absY = nextY >= toY ? nextY - toY : toY - nextY
            const h = (absX === 0 || absY === 0) ? (absX + absY) : (absX + absY + 1)
            heap.push(nextIdx, newCost + h, newCost)
          }
        }
      }
    }
  }

  return null
}

/**
 * Simplify a path by removing intermediate waypoints on straight segments.
 * E.g., [(0,0), (1,0), (2,0), (2,1)] becomes [(0,0), (2,0), (2,1)].
 * This reduces the number of line-drawing operations.
 */
export function mergePath(path: GridCoord[]): GridCoord[] {
  if (path.length <= 2) return path

  const toRemove = new Set<number>()
  let step0 = path[0]!
  let step1 = path[1]!

  for (let idx = 2; idx < path.length; idx++) {
    const step2 = path[idx]!
    const prevDx = step1.x - step0.x
    const prevDy = step1.y - step0.y
    const dx = step2.x - step1.x
    const dy = step2.y - step1.y

    // Same direction — the middle point is redundant
    if (prevDx === dx && prevDy === dy) {
      // In Go: indexToRemove = append(indexToRemove, idx+1) but idx is 0-based from path[2:]
      // which corresponds to index idx in the full path. Go uses idx+1 because idx iterates
      // from 0 in the [2:] slice, mapping to full-array index idx+1.
      // Actually re-checking Go code: the loop is `for idx, step2 := range path[2:]`
      // so idx=0 → path[2], and it removes idx+1 which is index 1 in the full array.
      // Wait, that doesn't look right. Let me re-read:
      //   step0 = path[0], step1 = path[1]
      //   for idx, step2 := range path[2:] { ... indexToRemove = append(indexToRemove, idx+1) ... }
      //   When idx=0, step2=path[2], and it removes index 1 (step1 = path[1]) if directions match
      // So it removes the middle point (step1) which is at index idx+1 in the original array
      // when counting from the 2-ahead loop. Let me just track which middle indices to remove.
      toRemove.add(idx - 1) // Remove the middle point (step1's position)
    }

    step0 = step1
    step1 = step2
  }

  return path.filter((_, i) => !toRemove.has(i))
}
