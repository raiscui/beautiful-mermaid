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
    const options = { useAscii: false }

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
})
