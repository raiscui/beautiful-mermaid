import { describe, expect, it } from 'bun:test'
import { renderMermaidAsciiWithMeta } from '../ascii/index.ts'

// ============================================================================
// 回归测试: root 节点识别不应依赖“节点声明顺序”
//
// 背景:
// - Mermaid 常见写法是先声明节点, 再声明边.
// - 如果 rootNodes 识别依赖 node insertion order, 当 target 节点声明在 source 之前时,
//   会把“其实有入边”的节点误判为 root, 进而把它放到最左侧/最上侧, 让边被迫绕路或产生歧义.
// ============================================================================

describe('Flowchart root nodes', () => {
  it('places the true root to the left in LR layout', () => {
    const diagram = `flowchart LR
  B[Beta]
  A[Alpha]
  A --> B
`

    const { meta } = renderMermaidAsciiWithMeta(diagram, {
      useAscii: false,
      // 这里用 relaxed：用户在 Unicode 下的默认模式就是 relaxed,
      // 并且本回归测试关注的是 relaxed 的可读性布局.
      routing: 'relaxed',
    })

    const nodeA = meta.nodes.find(n => n.id === 'A')
    const nodeB = meta.nodes.find(n => n.id === 'B')

    expect(nodeA).toBeTruthy()
    expect(nodeB).toBeTruthy()

    // LR: root(A) 应在左侧, B 在右侧.
    expect(nodeA!.box.x).toBeLessThan(nodeB!.box.x)
  })
})
