import { describe, it, expect } from 'bun:test'
import { renderMermaidAscii } from '../ascii/index.ts'

// ============================================================================
// 回归测试：Unicode relaxed（梳子口端口）应能处理“多入边同靶”而不崩溃
//
// 背景：
// - comb ports 的目标是让同一侧可以容纳很多入/出边（端点分散到不同 lane）
// - 在 grid 还是 3x3 block 的架构下，同侧多入边的“最后一段”在几何上通常是唯一的
// - 因此 relaxed 不能因为“不允许终点段复用”而把图路由成不可达（否则会导致 drawGraph 崩溃）
// ============================================================================

describe('Unicode relaxed：comb ports（多入边同靶）', () => {
  it('many inbound edges to the same target should render without throwing', () => {
    const mermaid = `flowchart LR
  A[Center]
  B1[b1]
  B2[b2]
  B3[b3]
  B4[b4]
  B5[b5]
  B6[b6]
  B1 --> A
  B2 --> A
  B3 --> A
  B4 --> A
  B5 --> A
  B6 --> A
`

    const out = renderMermaidAscii(mermaid, { useAscii: false, routing: 'relaxed' })

    // 基本可用性：不为空，且关键节点 label 可见
    expect(out.trim().length).toBeGreaterThan(0)
    expect(out).toContain('Center')
    expect(out).toContain('b1')
    expect(out).toContain('b6')

    // Unicode：交叉应当被桥化（不出现 `┼` 的四向连接歧义）
    expect(out).not.toContain('┼')
  })
})

