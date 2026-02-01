import { describe, it, expect } from 'bun:test'
import { parseMermaid } from '../parser.ts'
import { convertToAsciiGraph } from '../ascii/converter.ts'
import { createMapping } from '../ascii/grid.ts'
import type { GridCoord, AsciiEdge, AsciiConfig } from '../ascii/types.ts'

// ============================================================================
// 回归测试：边不共线（仅允许起点/终点共线）
//
// 用户规则：
// - 相同 source 的边：允许在“起点段”共线（第一段）
// - 相同 target 的边：允许在“终点段”共线（最后一段）
// - 其它情况：不同 source 或不同 target 的边，不允许复用同一段 unit segment（不共线）
//
// 注意：
// - 这里用“unit segment”（相邻两格之间的线段）作为判定粒度，
//   这样可以允许交叉（不同 segment），同时禁止同段重叠（共线）。
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

    // ASCII 路由理论上只会产生水平/垂直线段；如果出现斜线段，说明路由器出了问题。
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

describe('ASCII 渲染：边不共线（仅允许起点/终点共线）', () => {
  it('不同 source/target 的边不应共线重叠', () => {
    const input = `flowchart LR
    Hat_spec_logger[<0001f9fe> 规格记录员]
    Hat_spec_reviewer[🔎 规格审阅者]
    Hat_spec_writer[📋 规格撰写者]
    Start[task.start]
    Start -->|spec.start| Hat_spec_writer
    Hat_spec_reviewer -->|spec.rejected| Hat_spec_logger
    Hat_spec_reviewer -->|spec.rejected| Hat_spec_writer
    Hat_spec_writer -->|spec.ready| Hat_spec_logger
    Hat_spec_writer -->|spec.ready| Hat_spec_reviewer`

    const parsed = parseMermaid(input)
    const config: AsciiConfig = {
      useAscii: true,
      paddingX: 5,
      paddingY: 5,
      boxBorderPadding: 1,
      graphDirection: (parsed.direction === 'LR' || parsed.direction === 'RL') ? 'LR' : 'TD',
    }

    const graph = convertToAsciiGraph(parsed, config)
    createMapping(graph)

    // 统计每条 unit segment 被哪些边复用。
    // 我们不需要画布输出，只需要路由后的 edge.path。
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

    for (const [key, list] of segmentToEdges.entries()) {
      if (list.length < 2) continue

      const first = list[0]!
      const allSameSource = list.every(x => x.edge.from.name === first.edge.from.name)
      const allSameTarget = list.every(x => x.edge.to.name === first.edge.to.name)

      const allowedBySameSource = allSameSource && list.every(x => x.unitIndex === 0)
      const allowedBySameTarget = allSameTarget && list.every(x => x.unitIndex === x.unitCount - 1)

      if (!allowedBySameSource && !allowedBySameTarget) {
        const detail = list
          .map(x => `${x.edge.from.name} -> ${x.edge.to.name} (unitIndex=${x.unitIndex}, unitCount=${x.unitCount})`)
          .join('\n')
        throw new Error(`检测到不允许的共线复用：segment=${key}\n${detail}`)
      }
    }
  })
})

