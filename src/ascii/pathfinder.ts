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
// - `beautiful-mermaid-rs` 会在 QuickJS Context 初始化阶段注入两个全局函数：
//   - `globalThis.__bm_getPath(...)`
//   - `globalThis.__bm_getPathStrict(...)`
// - 在浏览器/Bun 环境里这两个函数不存在，因此这里会自动回退到纯 JS 实现。
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
