import { describe, it, expect } from 'bun:test'
import { parseMermaid } from '../parser.ts'
import { convertToAsciiGraph } from '../ascii/converter.ts'
import { createMapping } from '../ascii/grid.ts'
import type { GridCoord, AsciiEdge, AsciiConfig } from '../ascii/types.ts'

// ============================================================================
// 回归测试：Unicode relaxed 路由“不共线重叠（允许起点/终点段有限复用）”
//
// 用户规则（最新诉求）：
// - 允许交错（crossing），但不同边不允许共线重叠（否则看不清哪条线）
// - 同一 source 的多条边：允许“起点段”共线（只允许第一段）
// - 终点“点位”不允许重叠（不要画到同一个箭头格子上）
//
// 实现侧约束（当前架构的必要取舍）：
// - grid A* 的 node 仍是 3x3 block：同一 side port 的“最后一段”在几何上通常是唯一的；
// - 因此我们允许“同 target 的最后一段”复用，但要求端口 lane offset 不同（点位不同、视觉不重叠）。
//
// 判定粒度：
// - 用“unit segment”（相邻两格之间的线段）来判定是否共线重叠；
// - 这样可以允许交错（不同 segment），同时禁止同段重叠（共线）。
// ============================================================================

function segmentKey(a: GridCoord, b: GridCoord): string {
  // 为了把“同一段线”视为相同 key，这里按坐标排序，做成无向 key。
  const aFirst = a.x < b.x || (a.x === b.x && a.y < b.y)
  const p = aFirst ? `${a.x},${a.y}` : `${b.x},${b.y}`
  const q = aFirst ? `${b.x},${b.y}` : `${a.x},${a.y}`
  return `${p}|${q}`
}

function expandEdgeToUnitSegments(edge: AsciiEdge): Array<{ key: string }> {
  const segments: Array<{ key: string }> = []

  for (let i = 1; i < edge.path.length; i++) {
    const from = edge.path[i - 1]!
    const to = edge.path[i]!

    // 路由理论上只会产生水平/垂直线段；如果出现斜线段，说明路由器出了问题。
    if (from.x !== to.x && from.y !== to.y) {
      throw new Error(`edge.path 出现斜线段：${edge.from.name} -> ${edge.to.name}`)
    }

    if (from.x === to.x) {
      const step = to.y > from.y ? 1 : -1
      for (let y = from.y; y !== to.y; y += step) {
        const a: GridCoord = { x: from.x, y }
        const b: GridCoord = { x: from.x, y: y + step }
        segments.push({ key: segmentKey(a, b) })
      }
    } else {
      const step = to.x > from.x ? 1 : -1
      for (let x = from.x; x !== to.x; x += step) {
        const a: GridCoord = { x, y: from.y }
        const b: GridCoord = { x: x + step, y: from.y }
        segments.push({ key: segmentKey(a, b) })
      }
    }
  }

  return segments
}

describe('Unicode relaxed：不共线重叠（仅允许起点段/终点段有限复用）', () => {
  it('Hat workflow：仅允许同源起点段 / 同靶终点段复用，其它 segment 不允许复用', () => {
    const input = `flowchart LR
    Hat_ralph[ralph#1]
    Hat_spec_logger[<0001f9fe> 规格记录员]
    Hat_spec_reviewer[🔎 规格审阅者]
    Hat_spec_writer[📋 规格撰写者]
    Start[task.start]
    Start --> Hat_ralph
    Complete[complete]
    Hat_ralph -->|spec.start| Hat_spec_writer
    Hat_spec_reviewer -->|spec.approved| Complete
    Hat_spec_reviewer -->|spec.approved| Hat_ralph
    Hat_spec_reviewer -->|spec.rejected| Hat_spec_logger
    Hat_spec_reviewer -->|spec.rejected| Hat_spec_writer
    Hat_spec_writer -->|spec.ready| Hat_spec_logger
    Hat_spec_writer -->|spec.ready| Hat_spec_reviewer`

    const parsed = parseMermaid(input)
    const config: AsciiConfig = {
      useAscii: false,
      paddingX: 5,
      paddingY: 5,
      boxBorderPadding: 1,
      graphDirection: (parsed.direction === 'LR' || parsed.direction === 'RL') ? 'LR' : 'TD',
      routing: 'relaxed',
    }

    const graph = convertToAsciiGraph(parsed, config)
    createMapping(graph)

    // 统计每条 unit segment 被哪些边复用。
    const segmentToEdges = new Map<string, Array<{ edge: AsciiEdge; unitIndex: number; unitCount: number }>>()

    for (const edge of graph.edges) {
      expect(edge.path.length).toBeGreaterThan(1)

      const units = expandEdgeToUnitSegments(edge)
      for (let i = 0; i < units.length; i++) {
        const key = units[i]!.key
        const list = segmentToEdges.get(key) ?? []
        list.push({ edge, unitIndex: i, unitCount: units.length })
        segmentToEdges.set(key, list)
      }
    }

    function endLaneOffset(edge: AsciiEdge): number | null {
      // comb ports：Left/Right 用 Y offset；Up/Down 用 X offset
      if (edge.endPortOffsetY != null) return edge.endPortOffsetY
      if (edge.endPortOffsetX != null) return edge.endPortOffsetX
      return null
    }

    for (const [key, list] of segmentToEdges.entries()) {
      if (list.length < 2) continue

      const first = list[0]!
      const allSameSource = list.every(x => x.edge.from.name === first.edge.from.name)
      const allSameTarget = list.every(x => x.edge.to.name === first.edge.to.name)

      const allowedBySameSourceStartOnly = allSameSource && list.every(x => x.unitIndex === 0)

      const allowedBySameTargetEndOnly = allSameTarget && list.every(x => x.unitIndex === x.unitCount - 1)
      const endOffsets = allowedBySameTargetEndOnly
        ? list.map(x => endLaneOffset(x.edge))
        : []
      const hasUniqueEndOffsets = allowedBySameTargetEndOnly
        && endOffsets.length === list.length
        && endOffsets.every(x => x != null)
        && (new Set(endOffsets as number[])).size === list.length

      const allowed = allowedBySameSourceStartOnly || hasUniqueEndOffsets

      if (!allowed) {
        const detail = list
          .map(x => `${x.edge.from.name} -> ${x.edge.to.name} (unitIndex=${x.unitIndex}, unitCount=${x.unitCount})`)
          .join('\n')
        throw new Error(`检测到不允许的共线复用：segment=${key}\n${detail}`)
      }
    }
  })
})
