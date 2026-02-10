/**
 * renderMermaidAsciiWithMeta 回归测试
 *
 * 目的：
 * - 确保新增的 meta API 不会改变最终字符画输出（text 必须与旧 API 一致）
 * - 确保 meta 至少包含 nodes/edges 的坐标信息（为 TUI 上色/动画提供稳定数据）
 * - 保持“字符画可反向解析回 Mermaid（逻辑一致）”的硬约束（AGENTS.md）
 */

import { describe, it, expect } from 'bun:test'
import { renderMermaidAscii, renderMermaidAsciiWithMeta, reverseFlowchartAsciiToMermaid } from '../ascii/index.ts'
import { charDisplayWidth } from '../ascii/canvas.ts'
import { parseMermaid } from '../parser.ts'
import type { MermaidGraph, MermaidEdge } from '../types.ts'

function edgeKeyByNodeLabel(graph: MermaidGraph, edge: MermaidEdge): string {
  // 用“节点 label”作为身份，而不是 id（因为反解会重新分配 id）。
  const sourceLabel = graph.nodes.get(edge.source)?.label.trim() ?? edge.source
  const targetLabel = graph.nodes.get(edge.target)?.label.trim() ?? edge.target
  const label = (edge.label ?? '').trim()
  return `${sourceLabel} -> ${targetLabel} | ${label}`
}

function sortedEdgeKeysByLabel(graph: MermaidGraph): string[] {
  // 排序后再对比，避免“输出顺序不同但逻辑一致”导致误报。
  return graph.edges.map(e => edgeKeyByNodeLabel(graph, e)).sort()
}

function isAdjacentToBox(
  box: { x: number; y: number; width: number; height: number },
  point: { x: number; y: number },
): boolean {
  const minX = box.x
  const minY = box.y
  const maxX = box.x + box.width - 1
  const maxY = box.y + box.height - 1

  const rightSide = point.x === maxX + 1 && point.y >= minY && point.y <= maxY
  const leftSide = point.x === minX - 1 && point.y >= minY && point.y <= maxY
  const topSide = point.y === minY - 1 && point.x >= minX && point.x <= maxX
  const bottomSide = point.y === maxY + 1 && point.x >= minX && point.x <= maxX

  return rightSide || leftSide || topSide || bottomSide
}

function charAtDisplayColumn(line: string, x: number): string | null {
  if (x < 0) return null

  let col = 0
  for (const ch of line) {
    const w = charDisplayWidth(ch)

    // combining mark 宽度为 0: 不占列宽,也不参与坐标映射。
    if (w === 0) continue

    if (col <= x && x < col + w) return ch
    col += w
  }

  return null
}

function charAtTextCoord(text: string, x: number, y: number): string | null {
  const lines = text.split('\n')
  if (y < 0 || y >= lines.length) return null
  return charAtDisplayColumn(lines[y]!, x)
}

describe('renderMermaidAsciiWithMeta', () => {
  it('returns identical text + usable meta, and still roundtrips via reverse parser', () => {
    const mermaid = `flowchart LR
    Hat_planner[📋Planner]
    Hat_builder[🔨Builder]
    Hat_planner -->|build.task| Hat_builder
`

    // 注意：
    // - 反向解析对“极端紧凑”的参数（例如 padding=0）并不做强保证，
    //   因为线段/箭头可能在非常小的空间内发生覆盖/退化。
    // - 这里用默认 spacing，验证“主路径”仍然可 roundtrip。
    const options = {
      useAscii: false,
      // roundtrip 依赖可逆性：这里必须锁定 strict
      routing: 'strict',
    } as const

    const oldText = renderMermaidAscii(mermaid, options)
    const { text, meta } = renderMermaidAsciiWithMeta(mermaid, options)

    // 1) text 必须保持一致（避免引入“隐式行为变化”）
    expect(text).toEqual(oldText)

    // 2) meta 至少能定位到 node/edge（用于终端 TUI 做 cell-level 上色/动画）
    expect(meta.nodes.length).toBeGreaterThan(0)
    expect(meta.edges.length).toBeGreaterThan(0)

    const planner = meta.nodes.find(n => n.id === 'Hat_planner')
    const builder = meta.nodes.find(n => n.id === 'Hat_builder')
    expect(planner).toBeTruthy()
    expect(builder).toBeTruthy()
    expect(planner!.box.width).toBeGreaterThan(0)
    expect(planner!.box.height).toBeGreaterThan(0)

    const edge = meta.edges.find(e => e.from === 'Hat_planner' && e.to === 'Hat_builder' && e.label === 'build.task')
    expect(edge).toBeTruthy()
    expect(edge!.path.length).toBeGreaterThan(0)

    // 3) 反向解析仍必须可用（逻辑一致）
    const reversedMermaid = reverseFlowchartAsciiToMermaid(text, { direction: 'LR' })
    const originalGraph = parseMermaid(mermaid)
    const reversedGraph = parseMermaid(reversedMermaid)
    expect(sortedEdgeKeysByLabel(reversedGraph)).toEqual(sortedEdgeKeysByLabel(originalGraph))
  })

  it('relaxed: meta endpoint must stay adjacent to target box, and text must contain an arrow at path.last() (user case)', () => {
    const mermaid = `flowchart TD
Hat_ralph["ralph#1 (coordinator)"]
Hat_experiment_auditor[<0001f9fe> 结果审计员]
Hat_experiment_integrator[<0001f9e9> 集成验收员]
Hat_experiment_runner[<0001f9ea> 实验执行器]
Start[task.start]
Start --> Hat_ralph
Complete[complete]
Hat_experiment_auditor -->|experiment.reviewed| Hat_ralph
Hat_experiment_integrator -->|experiment.complete| Complete
Hat_experiment_integrator -->|experiment.complete| Hat_ralph
Hat_experiment_integrator -->|integration.applied| Hat_ralph
Hat_experiment_integrator -->|integration.blocked| Hat_ralph
Hat_experiment_integrator -->|integration.rejected| Hat_ralph
Hat_experiment_runner -->|experiment.result| Hat_experiment_auditor
Hat_ralph -->|experiment.task| Hat_experiment_runner
Hat_ralph -->|integration.task| Hat_experiment_integrator
`

    // 说明:
    // - 这个回归用例的关键触发条件来自 Unicode + relaxed。
    // - ASCII strict 在该图上可能布局失败(严格路由不可达),会导致 meta.nodes 为空。
    // - 为避免把 scope 拉大到“strict 可达性”问题,这里先锁死本次 bug 的核心语义。
    const { text, meta } = renderMermaidAsciiWithMeta(mermaid, { useAscii: false, routing: 'relaxed' })
    expect(meta.nodes.length).toBeGreaterThan(0)
    expect(meta.edges.length).toBeGreaterThan(0)

    const nodesById = new Map(meta.nodes.map(n => [n.id, n] as const))
    const arrowChars = new Set(['▲', '▼', '◄', '►', '◥', '◤', '◢', '◣', '●'])

    for (const edge of meta.edges) {
      const target = nodesById.get(edge.to)
      if (!target) throw new Error(`missing meta for target node: ${edge.to}`)

      const last = edge.path.at(-1)
      if (!last) throw new Error(`empty edge path: ${edge.from} -> ${edge.to} (${edge.label})`)

      if (!isAdjacentToBox(target.box, last)) {
        throw new Error(
          `edge endpoint not adjacent to target box: ` +
            `${edge.from} -> ${edge.to} (${edge.label}), last=(${last.x},${last.y}), box=${JSON.stringify(target.box)}`,
        )
      }

      const ch = charAtTextCoord(text, last.x, last.y)
      if (!ch) {
        throw new Error(
          `cannot read endpoint char from text: ` +
            `${edge.from} -> ${edge.to} (${edge.label}), last=(${last.x},${last.y})`,
        )
      }

      if (!arrowChars.has(ch)) {
        throw new Error(
          `endpoint char is not an arrow: ` +
            `${edge.from} -> ${edge.to} (${edge.label}), last=(${last.x},${last.y}), char=${JSON.stringify(ch)}`,
        )
      }
    }
  }, 20_000)
})
