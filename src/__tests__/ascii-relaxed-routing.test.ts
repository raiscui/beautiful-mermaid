import { describe, it, expect } from 'bun:test'
import { renderMermaidAsciiWithMeta } from '../ascii/index.ts'
import { textDisplayWidth } from '../ascii/canvas.ts'

function diagramBox(text: string): { width: number; height: number } {
  const lines = text.split('\n')
  const height = lines.length
  const width = Math.max(0, ...lines.map(textDisplayWidth))
  return { width, height }
}

describe('Unicode relaxed routing', () => {
  it('Hat workflow: relaxed should reduce layout area and keep LR reading', () => {
    const mermaid = `flowchart LR
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
    Hat_spec_writer -->|spec.ready| Hat_spec_reviewer
`

    const strict = renderMermaidAsciiWithMeta(mermaid, { useAscii: false, routing: 'strict' })
    const relaxed = renderMermaidAsciiWithMeta(mermaid, { useAscii: false, routing: 'relaxed' })

    // 说明（用户诉求优先级调整）：
    // - 之前 relaxed 以“更紧凑”为主要目标（面积更小）；
    // - 但在引入“禁止共线重叠 + 禁止终点复用”后，
    //   relaxed 可能会为了可读性而绕行更远，面积不一定小于 strict。
    //
    // 因此这里不再强行断言 relaxed 必须更小，
    // 只要求它不要出现明显不可读的退化（例如挤成竖条、出现 `┼`、丢关键 label）。
    void strict

    // Unicode：交叉应当被桥化（不出现 `┼` 的四向连接歧义）
    expect(relaxed.text).not.toContain('┼')

    // LR：宽应该明显大于高（避免输出“竖着挤成一团”）
    const box = diagramBox(relaxed.text)
    expect(box.width).toBeGreaterThan(box.height)

    // 关键节点 label 仍必须可见（防止输出退化/丢字）
    expect(relaxed.text).toContain('ralph#1')
    expect(relaxed.text).toContain('task.start')
    expect(relaxed.text).toContain('complete')
  })
})
