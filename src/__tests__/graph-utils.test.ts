/**
 * Unit tests for connected component detection.
 *
 * The `findConnectedComponents()` function partitions a graph into
 * disjoint subsets of nodes that are transitively connected by edges.
 * This is the foundation for the "layout independently → stitch together"
 * pattern that fixes disconnected subgraph overlap issues.
 */
import { describe, it, expect } from 'bun:test'
import { findConnectedComponents, type ConnectedComponent } from '../graph-utils.ts'
import type { MermaidGraph, MermaidEdge, MermaidNode, MermaidSubgraph } from '../types.ts'

// ============================================================================
// Test helpers
// ============================================================================

/** Create a minimal MermaidGraph for testing */
function createGraph(
  nodeIds: string[],
  edges: Array<[string, string]>,
  subgraphs: MermaidSubgraph[] = []
): MermaidGraph {
  const nodes = new Map<string, MermaidNode>()
  for (const id of nodeIds) {
    nodes.set(id, { id, label: id, shape: 'rectangle' })
  }

  const mermaidEdges: MermaidEdge[] = edges.map(([source, target]) => ({
    source,
    target,
    style: 'solid' as const,
    hasArrowStart: false,
    hasArrowEnd: true,
  }))

  return {
    direction: 'LR',
    nodes,
    edges: mermaidEdges,
    subgraphs,
    classDefs: new Map(),
    classAssignments: new Map(),
    nodeStyles: new Map(),
  }
}

/** Create a subgraph structure */
function createSubgraph(
  id: string,
  nodeIds: string[],
  children: MermaidSubgraph[] = []
): MermaidSubgraph {
  return { id, label: id, nodeIds, children }
}

// ============================================================================
// Basic connectivity tests
// ============================================================================

describe('findConnectedComponents – basic', () => {
  it('returns single component for fully connected graph', () => {
    // A --> B --> C (one component)
    const graph = createGraph(['A', 'B', 'C'], [['A', 'B'], ['B', 'C']])
    const components = findConnectedComponents(graph)

    expect(components.length).toBe(1)
    expect(components[0]!.nodeIds).toEqual(new Set(['A', 'B', 'C']))
  })

  it('returns multiple components for disconnected nodes', () => {
    // A --> B    C --> D (two components)
    const graph = createGraph(['A', 'B', 'C', 'D'], [['A', 'B'], ['C', 'D']])
    const components = findConnectedComponents(graph)

    expect(components.length).toBe(2)

    // Components may be in any order, so check by content
    const compNodeSets = components.map(c => c.nodeIds)
    expect(compNodeSets).toContainEqual(new Set(['A', 'B']))
    expect(compNodeSets).toContainEqual(new Set(['C', 'D']))
  })

  it('handles single isolated node as its own component', () => {
    // A --> B    C (three nodes, two components)
    const graph = createGraph(['A', 'B', 'C'], [['A', 'B']])
    const components = findConnectedComponents(graph)

    expect(components.length).toBe(2)

    const compNodeSets = components.map(c => c.nodeIds)
    expect(compNodeSets).toContainEqual(new Set(['A', 'B']))
    expect(compNodeSets).toContainEqual(new Set(['C']))
  })

  it('handles empty graph', () => {
    const graph = createGraph([], [])
    const components = findConnectedComponents(graph)

    expect(components.length).toBe(0)
  })

  it('handles graph with only nodes, no edges', () => {
    // A    B    C (three components, each with one node)
    const graph = createGraph(['A', 'B', 'C'], [])
    const components = findConnectedComponents(graph)

    expect(components.length).toBe(3)

    const compNodeSets = components.map(c => c.nodeIds)
    expect(compNodeSets).toContainEqual(new Set(['A']))
    expect(compNodeSets).toContainEqual(new Set(['B']))
    expect(compNodeSets).toContainEqual(new Set(['C']))
  })

  it('merges components when edge connects them', () => {
    // Initially: A --> B    C --> D
    // Then: B --> C connects them into one component
    const graph = createGraph(
      ['A', 'B', 'C', 'D'],
      [['A', 'B'], ['C', 'D'], ['B', 'C']]
    )
    const components = findConnectedComponents(graph)

    expect(components.length).toBe(1)
    expect(components[0]!.nodeIds).toEqual(new Set(['A', 'B', 'C', 'D']))
  })

  it('treats edges as undirected for connectivity', () => {
    // C --> B --> A (connectivity goes both ways)
    const graph = createGraph(['A', 'B', 'C'], [['C', 'B'], ['B', 'A']])
    const components = findConnectedComponents(graph)

    expect(components.length).toBe(1)
    expect(components[0]!.nodeIds).toEqual(new Set(['A', 'B', 'C']))
  })
})

// ============================================================================
// Subgraph handling tests
// ============================================================================

describe('findConnectedComponents – subgraphs', () => {
  it('groups subgraph nodes with their connected component', () => {
    // subgraph S1 [A --> B]    subgraph S2 [C --> D]
    const graph = createGraph(
      ['A', 'B', 'C', 'D'],
      [['A', 'B'], ['C', 'D']],
      [
        createSubgraph('S1', ['A', 'B']),
        createSubgraph('S2', ['C', 'D']),
      ]
    )
    const components = findConnectedComponents(graph)

    expect(components.length).toBe(2)

    // Each component should have its corresponding subgraph
    const comp1 = components.find(c => c.nodeIds.has('A'))!
    const comp2 = components.find(c => c.nodeIds.has('C'))!

    expect(comp1.subgraphIds).toEqual(new Set(['S1']))
    expect(comp2.subgraphIds).toEqual(new Set(['S2']))
  })

  it('keeps connected subgraphs in same component', () => {
    // subgraph S1 [A --> B] --> subgraph S2 [C --> D]
    // B --> C connects the subgraphs
    const graph = createGraph(
      ['A', 'B', 'C', 'D'],
      [['A', 'B'], ['C', 'D'], ['B', 'C']],
      [
        createSubgraph('S1', ['A', 'B']),
        createSubgraph('S2', ['C', 'D']),
      ]
    )
    const components = findConnectedComponents(graph)

    expect(components.length).toBe(1)
    expect(components[0]!.nodeIds).toEqual(new Set(['A', 'B', 'C', 'D']))
    expect(components[0]!.subgraphIds).toEqual(new Set(['S1', 'S2']))
  })

  it('handles nested subgraphs', () => {
    // subgraph Outer [subgraph Inner [A --> B]]    C (disconnected)
    const graph = createGraph(
      ['A', 'B', 'C'],
      [['A', 'B']],
      [
        createSubgraph('Outer', [], [createSubgraph('Inner', ['A', 'B'])]),
      ]
    )
    const components = findConnectedComponents(graph)

    expect(components.length).toBe(2)

    const compWithSubgraph = components.find(c => c.nodeIds.has('A'))!
    expect(compWithSubgraph.subgraphIds).toEqual(new Set(['Outer', 'Inner']))
  })

  it('handles empty subgraphs', () => {
    // subgraph Empty []    A --> B
    const graph = createGraph(
      ['A', 'B'],
      [['A', 'B']],
      [createSubgraph('Empty', [])]
    )
    const components = findConnectedComponents(graph)

    // Empty subgraph has no nodes, so it doesn't belong to any component
    // The nodes A, B form one component
    expect(components.length).toBe(1)
    expect(components[0]!.nodeIds).toEqual(new Set(['A', 'B']))
  })
})

// ============================================================================
// Edge assignment tests
// ============================================================================

describe('findConnectedComponents – edges', () => {
  it('assigns edges to their component', () => {
    // A --> B    C --> D (two components with one edge each)
    const graph = createGraph(['A', 'B', 'C', 'D'], [['A', 'B'], ['C', 'D']])
    const components = findConnectedComponents(graph)

    expect(components.length).toBe(2)

    const comp1 = components.find(c => c.nodeIds.has('A'))!
    const comp2 = components.find(c => c.nodeIds.has('C'))!

    expect(comp1.edgeIndices).toEqual(new Set([0]))
    expect(comp2.edgeIndices).toEqual(new Set([1]))
  })

  it('assigns all edges within a connected graph to single component', () => {
    // A --> B --> C --> A (cycle, all edges in one component)
    const graph = createGraph(['A', 'B', 'C'], [['A', 'B'], ['B', 'C'], ['C', 'A']])
    const components = findConnectedComponents(graph)

    expect(components.length).toBe(1)
    expect(components[0]!.edgeIndices).toEqual(new Set([0, 1, 2]))
  })
})

// ============================================================================
// Complex scenarios
// ============================================================================

describe('findConnectedComponents – complex', () => {
  it('handles multiple disconnected clusters of varying sizes', () => {
    // Cluster 1: A --> B --> C --> D (4 nodes)
    // Cluster 2: E --> F (2 nodes)
    // Cluster 3: G (1 node)
    const graph = createGraph(
      ['A', 'B', 'C', 'D', 'E', 'F', 'G'],
      [['A', 'B'], ['B', 'C'], ['C', 'D'], ['E', 'F']]
    )
    const components = findConnectedComponents(graph)

    expect(components.length).toBe(3)

    const sizes = components.map(c => c.nodeIds.size).sort((a, b) => a - b)
    expect(sizes).toEqual([1, 2, 4])
  })

  it('handles star topology', () => {
    // Center node connected to all others: A --> B, A --> C, A --> D, A --> E
    const graph = createGraph(
      ['A', 'B', 'C', 'D', 'E'],
      [['A', 'B'], ['A', 'C'], ['A', 'D'], ['A', 'E']]
    )
    const components = findConnectedComponents(graph)

    expect(components.length).toBe(1)
    expect(components[0]!.nodeIds.size).toBe(5)
  })

  it('handles diamond topology with disconnected tail', () => {
    //      B
    //     / \
    // A -+   +- D    E --> F (disconnected)
    //     \ /
    //      C
    const graph = createGraph(
      ['A', 'B', 'C', 'D', 'E', 'F'],
      [['A', 'B'], ['A', 'C'], ['B', 'D'], ['C', 'D'], ['E', 'F']]
    )
    const components = findConnectedComponents(graph)

    expect(components.length).toBe(2)

    const compNodeSets = components.map(c => c.nodeIds)
    expect(compNodeSets).toContainEqual(new Set(['A', 'B', 'C', 'D']))
    expect(compNodeSets).toContainEqual(new Set(['E', 'F']))
  })
})

// ============================================================================
// Determinism and ordering
// ============================================================================

describe('findConnectedComponents – determinism', () => {
  it('returns components in deterministic order', () => {
    // Run the same graph multiple times, expect same component order
    const graph = createGraph(['A', 'B', 'C', 'D'], [['A', 'B'], ['C', 'D']])

    const results: ConnectedComponent[][] = []
    for (let i = 0; i < 5; i++) {
      results.push(findConnectedComponents(graph))
    }

    // All results should be identical
    for (let i = 1; i < results.length; i++) {
      expect(results[i]!.length).toBe(results[0]!.length)
      for (let j = 0; j < results[0]!.length; j++) {
        expect(results[i]![j]!.nodeIds).toEqual(results[0]![j]!.nodeIds)
      }
    }
  })
})
