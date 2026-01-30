/**
 * Unit tests for layout stitching utility.
 *
 * The `stitchComponentLayouts()` function combines independently-laid-out
 * graph components into a single PositionedGraph by offsetting coordinates.
 *
 * Stacking is perpendicular to flow direction for space efficiency:
 * - LR/RL flows horizontally → stack vertically (below each other)
 * - TD/TB/BT flows vertically → stack horizontally (side-by-side)
 */
import { describe, it, expect } from 'bun:test'
import { stitchComponentLayouts } from '../graph-utils.ts'
import type { PositionedGraph, PositionedNode, PositionedEdge, PositionedGroup, Direction } from '../types.ts'

// ============================================================================
// Test helpers
// ============================================================================

/** Create a minimal positioned graph for testing */
function createPositionedGraph(
  width: number,
  height: number,
  nodes: PositionedNode[] = [],
  edges: PositionedEdge[] = [],
  groups: PositionedGroup[] = []
): PositionedGraph {
  return { width, height, nodes, edges, groups }
}

/** Create a minimal positioned node */
function createNode(
  id: string,
  x: number,
  y: number,
  width: number = 60,
  height: number = 36
): PositionedNode {
  return { id, label: id, shape: 'rectangle', x, y, width, height }
}

/** Create a minimal positioned edge */
function createEdge(
  source: string,
  target: string,
  points: Array<{ x: number; y: number }>,
  labelPosition?: { x: number; y: number }
): PositionedEdge {
  return {
    source,
    target,
    style: 'solid',
    hasArrowStart: false,
    hasArrowEnd: true,
    points,
    labelPosition,
  }
}

/** Create a minimal positioned group */
function createGroup(
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
  children: PositionedGroup[] = []
): PositionedGroup {
  return { id, label: id, x, y, width, height, children }
}

// ============================================================================
// Basic stitching tests
// ============================================================================

describe('stitchComponentLayouts – single component', () => {
  it('returns single layout unchanged', () => {
    const layout = createPositionedGraph(
      200, 100,
      [createNode('A', 40, 40)],
      [createEdge('A', 'B', [{ x: 100, y: 58 }, { x: 140, y: 58 }])],
      [createGroup('G1', 20, 20, 160, 80)]
    )

    const result = stitchComponentLayouts([layout], 'LR', 40)

    expect(result.width).toBe(200)
    expect(result.height).toBe(100)
    expect(result.nodes).toEqual(layout.nodes)
    expect(result.edges).toEqual(layout.edges)
    expect(result.groups).toEqual(layout.groups)
  })

  it('returns empty graph for no components', () => {
    const result = stitchComponentLayouts([], 'LR', 40)

    expect(result.width).toBe(0)
    expect(result.height).toBe(0)
    expect(result.nodes).toEqual([])
    expect(result.edges).toEqual([])
    expect(result.groups).toEqual([])
  })
})

// ============================================================================
// LR direction: stack vertically (perpendicular to horizontal flow)
// ============================================================================

describe('stitchComponentLayouts – LR (vertical stacking)', () => {
  it('offsets second component vertically for LR direction', () => {
    const comp1 = createPositionedGraph(100, 80, [createNode('A', 20, 20)])
    const comp2 = createPositionedGraph(80, 60, [createNode('B', 10, 10)])
    const gap = 40

    const result = stitchComponentLayouts([comp1, comp2], 'LR', gap)

    // Width: max of both = 100
    expect(result.width).toBe(100)
    // Total height: 80 + 40 (gap) + 60 = 180
    expect(result.height).toBe(180)

    // First component unchanged
    const nodeA = result.nodes.find(n => n.id === 'A')!
    expect(nodeA.x).toBe(20)
    expect(nodeA.y).toBe(20)

    // Second component offset by comp1.height + gap
    const nodeB = result.nodes.find(n => n.id === 'B')!
    expect(nodeB.x).toBe(10) // X unchanged
    expect(nodeB.y).toBe(10 + 80 + gap) // 130
  })

  it('handles three components vertically', () => {
    const comp1 = createPositionedGraph(100, 50, [createNode('A', 20, 10)])
    const comp2 = createPositionedGraph(80, 70, [createNode('B', 10, 20)])
    const comp3 = createPositionedGraph(60, 40, [createNode('C', 5, 5)])
    const gap = 20

    const result = stitchComponentLayouts([comp1, comp2, comp3], 'LR', gap)

    // Width: max(100, 80, 60) = 100
    expect(result.width).toBe(100)
    // Total height: 50 + 20 + 70 + 20 + 40 = 200
    expect(result.height).toBe(200)

    const nodeA = result.nodes.find(n => n.id === 'A')!
    const nodeB = result.nodes.find(n => n.id === 'B')!
    const nodeC = result.nodes.find(n => n.id === 'C')!

    expect(nodeA.y).toBe(10)
    expect(nodeB.y).toBe(20 + 50 + gap) // 90
    expect(nodeC.y).toBe(5 + 50 + gap + 70 + gap) // 165
  })

  it('offsets edges vertically', () => {
    const comp1 = createPositionedGraph(100, 80)
    const comp2 = createPositionedGraph(80, 60, [], [
      createEdge('B', 'C', [{ x: 10, y: 30 }, { x: 50, y: 30 }])
    ])
    const gap = 40

    const result = stitchComponentLayouts([comp1, comp2], 'LR', gap)

    const edge = result.edges[0]!
    // X unchanged
    expect(edge.points[0]!.x).toBe(10)
    expect(edge.points[1]!.x).toBe(50)
    // Y offset
    expect(edge.points[0]!.y).toBe(30 + 80 + gap) // 150
    expect(edge.points[1]!.y).toBe(30 + 80 + gap) // 150
  })

  it('offsets edge label positions vertically', () => {
    const comp1 = createPositionedGraph(100, 80)
    const comp2 = createPositionedGraph(80, 60, [], [
      createEdge('B', 'C', [{ x: 10, y: 30 }, { x: 50, y: 30 }], { x: 30, y: 30 })
    ])
    const gap = 40

    const result = stitchComponentLayouts([comp1, comp2], 'LR', gap)

    const edge = result.edges[0]!
    expect(edge.labelPosition!.x).toBe(30) // X unchanged
    expect(edge.labelPosition!.y).toBe(30 + 80 + gap) // 150
  })

  it('offsets groups vertically', () => {
    const comp1 = createPositionedGraph(100, 80)
    const comp2 = createPositionedGraph(80, 60, [], [], [
      createGroup('G2', 5, 5, 70, 50)
    ])
    const gap = 40

    const result = stitchComponentLayouts([comp1, comp2], 'LR', gap)

    const group = result.groups[0]!
    expect(group.x).toBe(5) // X unchanged
    expect(group.y).toBe(5 + 80 + gap) // 125
  })

  it('offsets nested groups vertically', () => {
    const comp1 = createPositionedGraph(100, 80)
    const comp2 = createPositionedGraph(80, 60, [], [], [
      createGroup('Outer', 5, 5, 70, 50, [
        createGroup('Inner', 10, 10, 40, 30)
      ])
    ])
    const gap = 40

    const result = stitchComponentLayouts([comp1, comp2], 'LR', gap)

    const outerGroup = result.groups[0]!
    expect(outerGroup.y).toBe(5 + 80 + gap) // 125

    const innerGroup = outerGroup.children[0]!
    expect(innerGroup.y).toBe(10 + 80 + gap) // 130
  })
})

// ============================================================================
// TD direction: stack horizontally (perpendicular to vertical flow)
// ============================================================================

describe('stitchComponentLayouts – TD (horizontal stacking)', () => {
  it('offsets second component horizontally for TD direction', () => {
    const comp1 = createPositionedGraph(100, 80, [createNode('A', 20, 20)])
    const comp2 = createPositionedGraph(80, 60, [createNode('B', 10, 10)])
    const gap = 40

    const result = stitchComponentLayouts([comp1, comp2], 'TD', gap)

    // Total width: 100 + 40 (gap) + 80 = 220
    expect(result.width).toBe(220)
    // Height: max of both = 80
    expect(result.height).toBe(80)

    // First component unchanged
    const nodeA = result.nodes.find(n => n.id === 'A')!
    expect(nodeA.x).toBe(20)
    expect(nodeA.y).toBe(20)

    // Second component offset by comp1.width + gap
    const nodeB = result.nodes.find(n => n.id === 'B')!
    expect(nodeB.x).toBe(10 + 100 + gap) // 150
    expect(nodeB.y).toBe(10) // Y unchanged
  })

  it('handles TB direction same as TD', () => {
    const comp1 = createPositionedGraph(100, 80, [createNode('A', 20, 20)])
    const comp2 = createPositionedGraph(80, 60, [createNode('B', 10, 10)])
    const gap = 40

    const result = stitchComponentLayouts([comp1, comp2], 'TB', gap)

    expect(result.width).toBe(220)
    const nodeB = result.nodes.find(n => n.id === 'B')!
    expect(nodeB.x).toBe(10 + 100 + gap)
  })

  it('handles BT direction same as TD', () => {
    const comp1 = createPositionedGraph(100, 80, [createNode('A', 20, 20)])
    const comp2 = createPositionedGraph(80, 60, [createNode('B', 10, 10)])
    const gap = 40

    const result = stitchComponentLayouts([comp1, comp2], 'BT', gap)

    expect(result.width).toBe(220)
    const nodeB = result.nodes.find(n => n.id === 'B')!
    expect(nodeB.x).toBe(10 + 100 + gap)
  })

  it('offsets edges horizontally', () => {
    const comp1 = createPositionedGraph(100, 80)
    const comp2 = createPositionedGraph(80, 60, [], [
      createEdge('B', 'C', [{ x: 30, y: 10 }, { x: 30, y: 50 }])
    ])
    const gap = 40

    const result = stitchComponentLayouts([comp1, comp2], 'TD', gap)

    const edge = result.edges[0]!
    // X offset
    expect(edge.points[0]!.x).toBe(30 + 100 + gap) // 170
    expect(edge.points[1]!.x).toBe(30 + 100 + gap) // 170
    // Y unchanged
    expect(edge.points[0]!.y).toBe(10)
    expect(edge.points[1]!.y).toBe(50)
  })
})

// ============================================================================
// RL direction: same as LR (vertical stacking)
// ============================================================================

describe('stitchComponentLayouts – RL direction', () => {
  it('handles RL same as LR (vertical stacking)', () => {
    const comp1 = createPositionedGraph(100, 80, [createNode('A', 20, 20)])
    const comp2 = createPositionedGraph(80, 60, [createNode('B', 10, 10)])
    const gap = 40

    const result = stitchComponentLayouts([comp1, comp2], 'RL', gap)

    // Should stack vertically like LR
    expect(result.width).toBe(100) // max width
    expect(result.height).toBe(180) // total height
  })
})

// ============================================================================
// Correctness tests
// ============================================================================

describe('stitchComponentLayouts – correctness', () => {
  it('computes correct total height for LR (vertical stacking)', () => {
    const comp1 = createPositionedGraph(100, 50)
    const comp2 = createPositionedGraph(80, 70)
    const comp3 = createPositionedGraph(60, 40)
    const gap = 20

    const result = stitchComponentLayouts([comp1, comp2, comp3], 'LR', gap)

    // 50 + 20 + 70 + 20 + 40 = 200
    expect(result.height).toBe(200)
    // max(100, 80, 60) = 100
    expect(result.width).toBe(100)
  })

  it('computes correct total width for TD (horizontal stacking)', () => {
    const comp1 = createPositionedGraph(100, 50)
    const comp2 = createPositionedGraph(80, 70)
    const comp3 = createPositionedGraph(60, 40)
    const gap = 20

    const result = stitchComponentLayouts([comp1, comp2, comp3], 'TD', gap)

    // 100 + 20 + 80 + 20 + 60 = 280
    expect(result.width).toBe(280)
    // max(50, 70, 40) = 70
    expect(result.height).toBe(70)
  })

  it('preserves all nodes from all components', () => {
    const comp1 = createPositionedGraph(100, 80, [
      createNode('A', 10, 10),
      createNode('B', 40, 10),
    ])
    const comp2 = createPositionedGraph(80, 60, [
      createNode('C', 10, 10),
      createNode('D', 40, 10),
    ])

    const result = stitchComponentLayouts([comp1, comp2], 'LR', 40)

    expect(result.nodes.length).toBe(4)
    expect(result.nodes.map(n => n.id).sort()).toEqual(['A', 'B', 'C', 'D'])
  })

  it('preserves all edges from all components', () => {
    const comp1 = createPositionedGraph(100, 80, [], [
      createEdge('A', 'B', [{ x: 0, y: 0 }, { x: 10, y: 10 }]),
    ])
    const comp2 = createPositionedGraph(80, 60, [], [
      createEdge('C', 'D', [{ x: 0, y: 0 }, { x: 10, y: 10 }]),
    ])

    const result = stitchComponentLayouts([comp1, comp2], 'LR', 40)

    expect(result.edges.length).toBe(2)
  })

  it('preserves all groups from all components', () => {
    const comp1 = createPositionedGraph(100, 80, [], [], [
      createGroup('G1', 10, 10, 80, 60),
    ])
    const comp2 = createPositionedGraph(80, 60, [], [], [
      createGroup('G2', 10, 10, 60, 40),
    ])

    const result = stitchComponentLayouts([comp1, comp2], 'LR', 40)

    expect(result.groups.length).toBe(2)
    expect(result.groups.map(g => g.id).sort()).toEqual(['G1', 'G2'])
  })
})
