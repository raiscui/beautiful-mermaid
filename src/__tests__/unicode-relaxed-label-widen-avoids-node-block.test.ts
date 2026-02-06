import { renderMermaidAsciiWithMeta } from '../ascii/index.ts'

describe('Unicode relaxed: label 扩宽列不应误伤 node block', () => {
  it('TD: spec.rejected 的回边不应进入 reviewer box interior', () => {
    const mermaid = `flowchart TD
    Hat_ralph[ralph#1 (coordinator)]
    Hat_spec_logger[🧾 规格记录员]
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

    const out = renderMermaidAsciiWithMeta(mermaid, { useAscii: false, routing: 'relaxed' })

    const reviewer = out.meta.nodes.find(n => n.id === 'Hat_spec_reviewer')
    expect(reviewer).toBeTruthy()

    const edge = out.meta.edges.find(e =>
      e.from === 'Hat_spec_reviewer'
      && e.to === 'Hat_spec_writer'
      && e.label === 'spec.rejected'
    )
    expect(edge).toBeTruthy()

    const box = reviewer!.box
    const inside = edge!.path.filter(p =>
      p.x > box.x
      && p.x < box.x + box.width - 1
      && p.y > box.y
      && p.y < box.y + box.height - 1
    )

    // 只要有 stroke 落进 interior, 视觉上就会出现“线从 box 里面长出来”的错觉。
    expect(inside).toEqual([])
  })
})

