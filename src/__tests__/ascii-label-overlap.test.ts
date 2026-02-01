import { describe, it, expect } from 'bun:test'
import { renderMermaidAscii } from '../ascii/index.ts'

describe('ASCII 渲染：edge label 避让', () => {
  it('多条边共享路径时，不应出现 label 拼接（例如 specspec.ready）', () => {
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

    const output = renderMermaidAscii(input)

    // 之前会出现 `specspec.ready`：两条 `spec.ready` label 画在同一段线上，文字被拼接。
    expect(output).not.toContain('specspec.ready')

    // 两条边都带有 label，因此输出中应该出现两次 `spec.ready`。
    const occurrences = output.match(/spec\.ready/g)?.length ?? 0
    expect(occurrences).toBe(2)
  })
})
