/**
 * ASCII/Unicode Flowchart 反向解析回归测试
 *
 * 验收标准（用户提出）：
 * - Unicode 输出里不再出现“┼”（避免把交叉误读成连接）
 * - render(ascii/unicode) → reverseParse → parseMermaid 后，逻辑与原图一致（允许节点 id 不同）
 */

import { describe, it, expect } from 'bun:test'
import { renderMermaidAscii, reverseFlowchartAsciiToMermaid } from '../ascii/index.ts'
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

describe('reverseFlowchartAsciiToMermaid', () => {
  it('roundtrips user flowchart without ambiguity', () => {
    // 用户给定用例：多边 + 多 label，最容易出现“共线/交叉/覆盖”导致读不清。
    const mermaid = `flowchart LR
    Hat_spec_logger[<0001f9fe> 规格记录员]
    Hat_spec_reviewer[🔎 规格审阅者]
    Hat_spec_writer[📋 规格撰写者]
    Start[task.start]
    Start -->|spec.start| Hat_spec_writer
    Hat_spec_reviewer -->|spec.rejected| Hat_spec_logger
    Hat_spec_reviewer -->|spec.rejected| Hat_spec_writer
    Hat_spec_writer -->|spec.ready| Hat_spec_logger
    Hat_spec_writer -->|spec.ready| Hat_spec_reviewer
`

    // 1) 先渲染成 Unicode 字符画
    const unicode = renderMermaidAscii(mermaid, {
      useAscii: false,
      // roundtrip 依赖可逆性：这里必须锁定 strict
      routing: 'strict',
    })

    // “┼”会强烈暗示“四向都连接”，用户明确表示完全看不懂路线，因此必须消灭它。
    expect(unicode).not.toContain('┼')

    // 2) 反向解析回 Mermaid
    const reversedMermaid = reverseFlowchartAsciiToMermaid(unicode, { direction: 'LR' })

    // 3) 比对逻辑一致性：用 parseMermaid 的结构对比（节点用 label 对齐）
    const originalGraph = parseMermaid(mermaid)
    const reversedGraph = parseMermaid(reversedMermaid)

    expect(sortedEdgeKeysByLabel(reversedGraph)).toEqual(sortedEdgeKeysByLabel(originalGraph))
  })
})
