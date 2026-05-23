import { useEffect, useMemo, useRef, useState } from 'react';
import html2canvas from 'html2canvas';
import { jsPDF } from 'jspdf';
import { STORAGE_KEY, VERSIONS_KEY, VERSION_COUNT_KEY, createEmptyDraft, createId, demoParts } from './data.js';
import { ANCHOR_SIDES, buildStructuredEdgePath, canUseAsSource, getAnchorPoint, getEdgeGeometry, getGraphLayout, getPartsMap, getResolvedPart, getSourceChainNames, getSuggestedAnchorSides } from './graph.js';

const colorPalette = ['#ffd84f', '#ffafdc', '#a8f0de', '#b7d6ff', '#ffc79c', '#c9f59d'];
const NODE_WIDTH = 220;
const NODE_HEIGHT = 158;
const EXPORT_QUALITY_SCALE = {
  normal: 1,
  high: 2,
};
const ANCHOR_LABELS = {
  left: 'Left',
  right: 'Right',
  top: 'Top',
  bottom: 'Bottom',
};

function nextAnchorSide(side) {
  const index = ANCHOR_SIDES.indexOf(side);
  if (index < 0) {
    return ANCHOR_SIDES[0];
  }
  return ANCHOR_SIDES[(index + 1) % ANCHOR_SIDES.length];
}

function clonePart(part) {
  const dependencyAnchors = Object.fromEntries(
    Object.entries(part.dependencyAnchors ?? {}).map(([dependencyId, anchor]) => [
      dependencyId,
      {
        from: anchor?.from ?? 'right',
        to: anchor?.to ?? 'left',
      },
    ]),
  );

  return {
    ...part,
    dependencies: [...(part.dependencies ?? [])],
    dependencyLabels: { ...(part.dependencyLabels ?? {}) },
    position: { ...(part.position ?? { x: 140, y: 140 }) },
    sourceAnchor: {
      from: part.sourceAnchor?.from ?? 'right',
      to: part.sourceAnchor?.to ?? 'left',
    },
    dependencyAnchors,
  };
}

function cloneAppState(source) {
  return {
    parts: source.parts.map(clonePart),
    selectedId: source.selectedId,
    draft: source.draft ? clonePart(source.draft) : null,
    connectionMode: source.connectionMode,
  };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { parts: demoParts.map(clonePart), selectedId: demoParts[0].id, draft: null, connectionMode: 'dependency', connectingFromId: null, pendingConnection: null };
    }

    const parsed = JSON.parse(raw);
    if (!parsed?.parts) {
      return { parts: demoParts.map(clonePart), selectedId: demoParts[0].id, draft: null, connectionMode: 'dependency', connectingFromId: null, pendingConnection: null };
    }

    return {
      parts: parsed.parts.map(clonePart),
      selectedId: parsed.selectedId ?? parsed.parts[0]?.id ?? null,
      draft: parsed.draft ? clonePart(parsed.draft) : null,
      connectionMode: parsed.connectionMode ?? 'dependency',
      connectingFromId: parsed.connectingFromId ?? null,
      pendingConnection: parsed.pendingConnection ?? null,
    };
  } catch {
    return { parts: demoParts.map(clonePart), selectedId: demoParts[0].id, draft: null, connectionMode: 'dependency', connectingFromId: null, pendingConnection: null };
  }
}

function DetailLine({ label, value }) {
  return (
    <div className="detail-line">
      <strong>{label}</strong>
      <span>{value}</span>
    </div>
  );
}

function versionLabel(count) {
  if (count <= 0) return null;
  const major = Math.floor((count - 1) / 10) + 1;
  const minor = (count - 1) % 10;
  return `${major}.${minor}`;
}

function loadVersionCount() {
  try {
    const raw = localStorage.getItem(VERSION_COUNT_KEY);
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

function loadVersions() {
  try {
    const raw = localStorage.getItem(VERSIONS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function App({ auth = { enabled: false, activeAccount: null, signOut: null, publicAccess: false } }) {
  const activeAccount = auth.activeAccount ?? null;
  const [state, setState] = useState(() => loadState());
  const [connectionHoverId, setConnectionHoverId] = useState(null);
  const [draggingNodeId, setDraggingNodeId] = useState(null);
  const [hoveredLink, setHoveredLink] = useState(null);
  const [newDependencyId, setNewDependencyId] = useState('');
  const [exportQuality, setExportQuality] = useState('normal');
  const [versionCount, setVersionCount] = useState(() => loadVersionCount());
  const historyRef = useRef({ past: [], future: [] });
  const connectionStartRef = useRef(null);
  const dragRef = useRef(null);
  const suppressClickRef = useRef(null);
  const graphCanvasRef = useRef(null);
  const partsMap = useMemo(() => getPartsMap(state.parts), [state.parts]);
  const draft = state.draft ?? state.parts.find((part) => part.id === state.selectedId) ?? null;
  const displayParts = useMemo(() => {
    if (!draft || state.parts.some((part) => part.id === draft.id)) {
      return state.parts;
    }

    return [...state.parts, draft];
  }, [state.parts, draft]);
  const graph = useMemo(() => getGraphLayout(displayParts), [displayParts]);
  const exportBounds = useMemo(() => {
    const overflowPadding = 20;
    let maxX = graph.width;
    let maxY = graph.height;

    for (const part of state.parts) {
      const position = graph.positions.get(part.id);
      if (!position) {
        continue;
      }

      maxX = Math.max(maxX, position.x + NODE_WIDTH + overflowPadding);
      maxY = Math.max(maxY, position.y + NODE_HEIGHT + overflowPadding);
    }

    return { width: Math.ceil(maxX), height: Math.ceil(maxY) };
  }, [graph.width, graph.height, graph.positions, state.parts]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [state]);

  useEffect(() => {
    function onKeyDown(event) {
      const shortcut = (event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === 'z';
      const redoShortcut = (event.metaKey || event.ctrlKey) && (event.shiftKey && event.key.toLowerCase() === 'z' || event.key.toLowerCase() === 'y');

      if (shortcut) {
        event.preventDefault();
        undo();
      }

      if (redoShortcut) {
        event.preventDefault();
        redo();
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  useEffect(() => {
    setNewDependencyId('');
  }, [draft?.id]);

  const selectedResolved = draft ? getResolvedPart(draft.id, state.parts) ?? draft : null;
  const sourceChain = draft ? getSourceChainNames(draft, partsMap) : [];

  const stats = useMemo(() => {
    const roots = state.parts.filter((part) => !part.sourceId || !partsMap.has(part.sourceId)).length;
    const owners = new Set(state.parts.map((part) => part.owner || 'Unassigned')).size;
    const residences = new Set(state.parts.map((part) => part.residesIn || 'Unknown')).size;
    const dependencyLinks = state.parts.reduce((total, part) => total + part.dependencies.length, 0);
    return [
      [state.parts.length, 'parts in the atlas'],
      [roots, 'source roots'],
      [dependencyLinks, 'dependency links'],
      [`${owners} owners / ${residences} residences`, 'coverage marks'],
    ];
  }, [state.parts, partsMap]);

  const groupedParts = useMemo(() => {
    const groups = new Map();
    state.parts.forEach((part) => {
      const resolved = getResolvedPart(part.id, state.parts) ?? part;
      const key = resolved.residesIn || part.residesIn || 'Unknown residence';
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key).push(part);
    });
    return [...groups.entries()].sort((left, right) => left[0].localeCompare(right[0]));
  }, [state.parts]);

  const selectedId = draft?.id ?? state.selectedId;
  const addableDependencies = useMemo(() => {
    if (!draft) {
      return [];
    }
    return state.parts.filter((part) => part.id !== draft.id && !draft.dependencies.includes(part.id));
  }, [state.parts, draft]);

  function suggestAnchors(sourceId, targetId) {
    const source = graph.positions.get(sourceId);
    const target = graph.positions.get(targetId);
    if (!source || !target) {
      return { from: 'right', to: 'left' };
    }
    return getSuggestedAnchorSides(source, target);
  }

  function resolveAnchors(sourceId, targetId, storedAnchor) {
    const fallback = suggestAnchors(sourceId, targetId);
    return {
      from: ANCHOR_SIDES.includes(storedAnchor?.from) ? storedAnchor.from : fallback.from,
      to: ANCHOR_SIDES.includes(storedAnchor?.to) ? storedAnchor.to : fallback.to,
    };
  }

  function cycleSourceAnchorSide(targetPartId, sideKey) {
    commit((current) => {
      const target = current.parts.find((part) => part.id === targetPartId);
      if (!target?.sourceId) {
        return current;
      }

      const anchors = resolveAnchors(target.sourceId, targetPartId, target.sourceAnchor);
      const updatedAnchor = { ...anchors, [sideKey]: nextAnchorSide(anchors[sideKey]) };

      const parts = current.parts.map((part) => (part.id === targetPartId ? { ...part, sourceAnchor: updatedAnchor } : part));
      const draft = current.draft?.id === targetPartId ? { ...current.draft, sourceAnchor: updatedAnchor } : current.draft;
      return { ...current, parts, draft };
    });
  }

  function cycleDependencyAnchorSide(targetPartId, dependencyId, sideKey) {
    commit((current) => {
      const target = current.parts.find((part) => part.id === targetPartId);
      if (!target || !target.dependencies.includes(dependencyId)) {
        return current;
      }

      const anchors = resolveAnchors(dependencyId, targetPartId, target.dependencyAnchors?.[dependencyId]);
      const updatedAnchor = { ...anchors, [sideKey]: nextAnchorSide(anchors[sideKey]) };

      const parts = current.parts.map((part) => {
        if (part.id !== targetPartId) {
          return part;
        }
        return {
          ...part,
          dependencyAnchors: {
            ...(part.dependencyAnchors ?? {}),
            [dependencyId]: updatedAnchor,
          },
        };
      });

      const draft = current.draft?.id === targetPartId
        ? {
            ...current.draft,
            dependencyAnchors: {
              ...(current.draft.dependencyAnchors ?? {}),
              [dependencyId]: updatedAnchor,
            },
          }
        : current.draft;

      return { ...current, parts, draft };
    });
  }

  function commit(updater, { history = true } = {}) {
    setState((current) => {
      if (history) {
        historyRef.current.past.push(cloneAppState(current));
        historyRef.current.future = [];
      }

      const nextState = typeof updater === 'function' ? updater(current) : { ...current, ...updater };
      return nextState;
    });
  }

  function selectPart(partId) {
    const part = state.parts.find((entry) => entry.id === partId);
    if (!part) {
      return;
    }

    setState((current) => ({ ...current, selectedId: partId, draft: clonePart(part), connectingFromId: null, pendingConnection: null }));
  }

  function openNewPart() {
    const anchor = state.parts.find((part) => part.id === state.selectedId) ?? null;
    const draftPart = createEmptyDraft();
    draftPart.sourceId = anchor?.id ?? null;
    setState((current) => ({ ...current, selectedId: null, draft: draftPart, connectingFromId: null, pendingConnection: null }));
  }

  function resetDemo() {
    commit({ parts: demoParts.map(clonePart), selectedId: demoParts[0].id, draft: null, connectingFromId: null, pendingConnection: null });
  }

  function updateDraft(field, value) {
    if (!draft) {
      return;
    }

    const nextDraft = { ...draft, [field]: value };
    setState((current) => ({ ...current, draft: nextDraft }));
  }

  function updateSourceAnchor(sideKey, side) {
    if (!draft) {
      return;
    }

    const nextAnchor = {
      from: draft.sourceAnchor?.from ?? 'right',
      to: draft.sourceAnchor?.to ?? 'left',
      [sideKey]: side,
    };
    updateDraft('sourceAnchor', nextAnchor);
  }

  function updateDependencyAnchor(dependencyId, sideKey, side) {
    if (!draft) {
      return;
    }

    const nextAnchors = {
      ...(draft.dependencyAnchors ?? {}),
      [dependencyId]: {
        from: draft.dependencyAnchors?.[dependencyId]?.from ?? 'right',
        to: draft.dependencyAnchors?.[dependencyId]?.to ?? 'left',
        [sideKey]: side,
      },
    };
    updateDraft('dependencyAnchors', nextAnchors);
  }

  function addDependencyToDraft(dependencyId) {
    if (!draft || !dependencyId || dependencyId === draft.id || draft.dependencies.includes(dependencyId)) {
      return;
    }

    const sourcePart = partsMap.get(dependencyId);
    const nextDependencies = [...draft.dependencies, dependencyId];
    const nextDependencyAnchors = {
      ...(draft.dependencyAnchors ?? {}),
      [dependencyId]: draft.dependencyAnchors?.[dependencyId] ?? suggestAnchors(dependencyId, draft.id),
    };
    const nextDependencyLabels = {
      ...(draft.dependencyLabels ?? {}),
      [dependencyId]: draft.dependencyLabels?.[dependencyId] ?? `${sourcePart?.name ?? dependencyId} link`,
    };

    setState((current) => ({
      ...current,
      draft: current.draft
        ? {
            ...current.draft,
            dependencies: nextDependencies,
            dependencyAnchors: nextDependencyAnchors,
            dependencyLabels: nextDependencyLabels,
          }
        : current.draft,
    }));
  }

  function removeDependencyFromDraft(dependencyId) {
    if (!draft || !draft.dependencies.includes(dependencyId)) {
      return;
    }

    const nextDependencyAnchors = { ...(draft.dependencyAnchors ?? {}) };
    const nextDependencyLabels = { ...(draft.dependencyLabels ?? {}) };
    delete nextDependencyAnchors[dependencyId];
    delete nextDependencyLabels[dependencyId];

    setState((current) => ({
      ...current,
      draft: current.draft
        ? {
            ...current.draft,
            dependencies: current.draft.dependencies.filter((id) => id !== dependencyId),
            dependencyAnchors: nextDependencyAnchors,
            dependencyLabels: nextDependencyLabels,
          }
        : current.draft,
    }));
  }

  function updateDependencyLabel(dependencyId, label) {
    if (!draft) {
      return;
    }

    setState((current) => ({
      ...current,
      draft: current.draft
        ? {
            ...current.draft,
            dependencyLabels: {
              ...(current.draft.dependencyLabels ?? {}),
              [dependencyId]: label,
            },
          }
        : current.draft,
    }));
  }

  function beginNodeDrag(partId, event) {
    if (event.button !== 0) {
      return;
    }

    if (event.target.closest('.graph-handle')) {
      return;
    }

    const nodePosition = graph.positions.get(partId);
    if (!nodePosition) {
      return;
    }

    const pointerX = event.clientX;
    const pointerY = event.clientY;
    dragRef.current = {
      partId,
      startX: nodePosition.x,
      startY: nodePosition.y,
      pointerX,
      pointerY,
      moved: false,
      startState: cloneAppState(state),
    };
    setDraggingNodeId(partId);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function moveNode(partId, nextX, nextY) {
    setState((current) => {
      let changed = false;
      const parts = current.parts.map((part) => {
        if (part.id !== partId) {
          return part;
        }

        const clampedX = Math.max(24, Math.round(nextX));
        const clampedY = Math.max(24, Math.round(nextY));
        const same = part.position?.x === clampedX && part.position?.y === clampedY;
        if (same) {
          return part;
        }
        changed = true;
        return { ...part, position: { x: clampedX, y: clampedY } };
      });

      if (!changed) {
        return current;
      }

      const draft = current.draft?.id === partId
        ? { ...current.draft, position: { x: Math.max(24, Math.round(nextX)), y: Math.max(24, Math.round(nextY)) } }
        : current.draft;

      return { ...current, parts, draft };
    });
  }

  function onNodePointerMove(event) {
    const dragging = dragRef.current;
    if (!dragging) {
      return;
    }

    const scale = 1;
    const dx = (event.clientX - dragging.pointerX) / scale;
    const dy = (event.clientY - dragging.pointerY) / scale;
    if (!dragging.moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
      dragging.moved = true;
    }

    if (!dragging.moved) {
      return;
    }

    moveNode(dragging.partId, dragging.startX + dx, dragging.startY + dy);
  }

  function endNodeDrag(event) {
    const dragging = dragRef.current;
    if (!dragging) {
      return;
    }

    event.currentTarget.releasePointerCapture?.(event.pointerId);

    if (dragging.moved) {
      historyRef.current.past.push(dragging.startState);
      historyRef.current.future = [];
      suppressClickRef.current = dragging.partId;
    }

    dragRef.current = null;
    setDraggingNodeId(null);
  }

  function savePart(event) {
    event.preventDefault();
    if (!draft?.name.trim()) {
      window.alert('Give the part a name before saving.');
      return;
    }

    const targetId = draft.id || createId();
    if (draft.sourceId && !canUseAsSource(draft.sourceId, targetId, state.parts)) {
      window.alert('That source would create a cycle. Choose another part.');
      return;
    }

    const nextPart = {
      ...draft,
      id: targetId,
      sourceId: draft.sourceId || null,
      dependencies: [...new Set((draft.dependencies || []).filter((dependencyId) => dependencyId !== targetId))],
      dependencyLabels: Object.fromEntries(
        Object.entries(draft.dependencyLabels ?? {}).filter(([dependencyId]) => (draft.dependencies || []).includes(dependencyId)),
      ),
      position: draft.position ?? { x: 140, y: 140 },
      sourceAnchor: {
        from: ANCHOR_SIDES.includes(draft.sourceAnchor?.from) ? draft.sourceAnchor.from : 'right',
        to: ANCHOR_SIDES.includes(draft.sourceAnchor?.to) ? draft.sourceAnchor.to : 'left',
      },
      dependencyAnchors: Object.fromEntries(
        Object.entries(draft.dependencyAnchors ?? {})
          .filter(([dependencyId]) => (draft.dependencies || []).includes(dependencyId))
          .map(([dependencyId, anchor]) => [
            dependencyId,
            {
              from: ANCHOR_SIDES.includes(anchor?.from) ? anchor.from : 'right',
              to: ANCHOR_SIDES.includes(anchor?.to) ? anchor.to : 'left',
            },
          ]),
      ),
    };

    const exists = state.parts.some((part) => part.id === targetId);
    const parts = exists ? state.parts.map((part) => (part.id === targetId ? nextPart : part)) : [...state.parts, nextPart];

    commit({ parts, selectedId: targetId, draft: clonePart(nextPart), connectingFromId: null, pendingConnection: null });
  }

  function deletePart() {
    if (!draft || !state.parts.some((part) => part.id === draft.id)) {
      window.alert('Pick a part to delete first.');
      return;
    }

    if (!window.confirm(`Delete ${draft.name}? Related parts will be reattached to its source if possible.`)) {
      return;
    }

    const removedId = draft.id;
    const removedSourceId = draft.sourceId ?? null;
    const parts = state.parts
      .filter((part) => part.id !== removedId)
      .map((part) => ({
        ...part,
        sourceId: part.sourceId === removedId ? removedSourceId : part.sourceId,
        dependencies: part.dependencies.filter((dependencyId) => dependencyId !== removedId),
        dependencyLabels: Object.fromEntries(
          Object.entries(part.dependencyLabels ?? {}).filter(([dependencyId]) => dependencyId !== removedId),
        ),
        dependencyAnchors: Object.fromEntries(
          Object.entries(part.dependencyAnchors ?? {}).filter(([dependencyId]) => dependencyId !== removedId),
        ),
      }));

    const nextSelected = parts[0]?.id ?? null;
    commit({ parts, selectedId: nextSelected, draft: nextSelected ? clonePart(parts[0]) : createEmptyDraft(), connectingFromId: null, pendingConnection: null });
  }

  function beginConnection(partId, event) {
    event.stopPropagation();
    connectionStartRef.current = partId;
    setState((current) => ({ ...current, connectingFromId: partId, pendingConnection: null }));
  }

  function setConnectionMode(mode) {
    setState((current) => ({ ...current, connectionMode: mode, connectingFromId: null, pendingConnection: null }));
    connectionStartRef.current = null;
    setConnectionHoverId(null);
  }

  function onNodeClick(partId) {
    if (state.connectingFromId) {
      if (state.connectingFromId === partId) {
        return;
      }
      completeConnection(partId, connectionStartRef.current ?? state.connectingFromId);
      return;
    }

    selectPart(partId);
  }

  function completeConnection(targetId, sourceId = state.connectingFromId, { history = true } = {}) {
    if (!sourceId || sourceId === targetId) {
      setState((current) => ({ ...current, connectingFromId: null, pendingConnection: null }));
      return;
    }

    if (state.connectionMode === 'source' && !canUseAsSource(sourceId, targetId, state.parts)) {
      window.alert('That source would create a cycle.');
      cancelConnection();
      return;
    }

    commit((current) => {
      const mode = current.connectionMode;
      const fromId = sourceId;
      const parts = current.parts.map((part) => {
        if (mode === 'source' && part.id === targetId) {
          const defaultAnchor = suggestAnchors(fromId, targetId);
          return { ...part, sourceId: fromId, sourceAnchor: defaultAnchor };
        }

        if (mode === 'dependency' && part.id === targetId) {
          if (part.dependencies.includes(fromId)) {
            return part;
          }
          const dependencyName = current.parts.find((entry) => entry.id === fromId)?.name ?? fromId;
          const defaultAnchor = suggestAnchors(fromId, targetId);
          return {
            ...part,
            dependencies: [...part.dependencies, fromId],
            dependencyLabels: {
              ...(part.dependencyLabels ?? {}),
              [fromId]: part.dependencyLabels?.[fromId] ?? `${dependencyName} link`,
            },
            dependencyAnchors: {
              ...(part.dependencyAnchors ?? {}),
              [fromId]: part.dependencyAnchors?.[fromId] ?? defaultAnchor,
            },
          };
        }

        return part;
      });

      return { ...current, parts, connectingFromId: null, pendingConnection: null, selectedId: targetId, draft: clonePart(parts.find((part) => part.id === targetId) ?? current.draft ?? createEmptyDraft()) };
    }, { history });
  }

  function cancelConnection() {
    connectionStartRef.current = null;
    setConnectionHoverId(null);
    setState((current) => ({ ...current, connectingFromId: null, pendingConnection: null }));
  }

  function removeDependency(partId, dependencyId) {
    commit((current) => ({
      ...current,
      parts: current.parts.map((part) => {
        if (part.id !== partId) {
          return part;
        }
        const dependencyAnchors = { ...(part.dependencyAnchors ?? {}) };
        const dependencyLabels = { ...(part.dependencyLabels ?? {}) };
        delete dependencyAnchors[dependencyId];
        delete dependencyLabels[dependencyId];
        return { ...part, dependencies: part.dependencies.filter((id) => id !== dependencyId), dependencyAnchors, dependencyLabels };
      }),
      draft: current.draft?.id === partId
        ? {
            ...current.draft,
            dependencies: current.draft.dependencies.filter((id) => id !== dependencyId),
            dependencyAnchors: Object.fromEntries(Object.entries(current.draft.dependencyAnchors ?? {}).filter(([id]) => id !== dependencyId)),
            dependencyLabels: Object.fromEntries(Object.entries(current.draft.dependencyLabels ?? {}).filter(([id]) => id !== dependencyId)),
          }
        : current.draft,
    }));
  }

  function removeSourceLink(partId) {
    commit((current) => ({
      ...current,
      parts: current.parts.map((part) => (part.id === partId ? { ...part, sourceId: null, sourceAnchor: { from: 'right', to: 'left' } } : part)),
      draft: current.draft?.id === partId ? { ...current.draft, sourceId: null, sourceAnchor: { from: 'right', to: 'left' } } : current.draft,
    }));
  }

  function undo() {
    const previous = historyRef.current.past.pop();
    if (!previous) {
      return;
    }

    historyRef.current.future.push(cloneAppState(state));
    setState({ ...cloneAppState(previous), connectingFromId: null, pendingConnection: null });
    cancelConnection();
  }

  function redo() {
    const next = historyRef.current.future.pop();
    if (!next) {
      return;
    }

    historyRef.current.past.push(cloneAppState(state));
    setState({ ...cloneAppState(next), connectingFromId: null, pendingConnection: null });
    cancelConnection();
  }

  const connectionPreview = useMemo(() => {
    if (!state.connectingFromId) {
      return null;
    }

    const start = graph.positions.get(state.connectingFromId);
    const hover = connectionHoverId ? graph.positions.get(connectionHoverId) : null;
    if (!start || !hover) {
      return null;
    }

    return buildStructuredEdgePath(start, hover, state.connectionMode, 0);
  }, [graph.positions, state.connectingFromId, connectionHoverId, state.connectionMode]);

  function saveVersion() {
    const nextCount = versionCount + 1;
    const snapshot = {
      versionLabel: versionLabel(nextCount),
      savedAt: new Date().toISOString(),
      parts: state.parts.map(clonePart),
      selectedId: state.selectedId,
    };
    const existing = loadVersions();
    const updated = [...existing, snapshot];
    try {
      localStorage.setItem(VERSIONS_KEY, JSON.stringify(updated));
      localStorage.setItem(VERSION_COUNT_KEY, String(nextCount));
    } catch {
      // localStorage quota exceeded — silently ignore
    }
    setVersionCount(nextCount);
  }

  async function captureCanvas() {
    const el = graphCanvasRef.current;
    if (!el) return null;

    const exportPadding = 96;
    const captureWidth = exportBounds.width + exportPadding * 2;
    const captureHeight = exportBounds.height + exportPadding * 2;
    const captureScale = EXPORT_QUALITY_SCALE[exportQuality] ?? EXPORT_QUALITY_SCALE.normal;

    return html2canvas(el, {
      scale: captureScale,
      useCORS: true,
      backgroundColor: '#fffdf6',
      width: captureWidth,
      height: captureHeight,
      x: -exportPadding,
      y: -exportPadding,
      scrollX: 0,
      scrollY: 0,
      onclone: (clonedDocument) => {
        const clonedCanvas = clonedDocument.querySelector('.graph-canvas');
        if (clonedCanvas) {
          clonedCanvas.classList.add('is-exporting');
        }
      },
    });
  }

  async function exportPNG() {
    const canvas = await captureCanvas();
    if (!canvas) return;
    const link = document.createElement('a');
    link.download = 'kundeplan.png';
    link.href = canvas.toDataURL('image/png');
    link.click();
  }

  async function exportPDF() {
    const canvas = await captureCanvas();
    if (!canvas) return;
    const imgData = canvas.toDataURL('image/png');
    const pdfWidth = canvas.width;
    const pdfHeight = canvas.height;
    const pdf = new jsPDF({
      orientation: pdfWidth > pdfHeight ? 'landscape' : 'portrait',
      unit: 'px',
      format: [pdfWidth, pdfHeight],
    });
    pdf.addImage(imgData, 'PNG', 0, 0, pdfWidth, pdfHeight);
    pdf.save('kundeplan.pdf');
  }

  const connectionInstruction = state.connectingFromId
    ? `Click a target box to ${state.connectionMode === 'source' ? 'set a source link' : 'add a dependency'}.`
    : 'Click the link dot on a box, then click the target box.';

  return (
    <main className="app-shell">
      <div className="sky-blobs" aria-hidden="true" />
      <header className="hero">
        <div>
          <p className="eyebrow">ATEA AS customer plan atlas</p>
          <h1>Kundeplan</h1>
          <p className="hero-copy">
            Track every part, the owner, where it lives, where it is presented, and how it depends on the rest.
            One source of truth keeps updates propagating cleanly across the map.
          </p>
        </div>
        <div className="hero-actions">
          <button type="button" className="primary-button" onClick={openNewPart}>New part</button>
          <button type="button" className="secondary-button" onClick={undo} disabled={!historyRef.current.past.length}>Undo</button>
          <button type="button" className="secondary-button" onClick={redo} disabled={!historyRef.current.future.length}>Redo</button>
          <button type="button" className="version-save-button" onClick={saveVersion}>Save version</button>
          {versionCount > 0 ? (
            <span className="version-badge">v{versionLabel(versionCount)}</span>
          ) : null}
          {!auth.enabled ? (
            <span className="auth-disabled-badge" title={auth.publicAccess ? 'Public access is enabled. Sign-in is not required.' : 'SSO is disabled until an Entra App Registration client ID is configured.'}>
              {auth.publicAccess ? 'Public access' : 'SSO not configured'}
            </span>
          ) : null}
          {activeAccount ? (
            <>
              <span className="user-badge" title={activeAccount.username}>
                {activeAccount.name ?? activeAccount.username}
              </span>
              <button
                type="button"
                className="secondary-button"
                onClick={() => auth.signOut?.()}
              >
                Sign out
              </button>
            </>
          ) : null}
        </div>
      </header>

      <section className="workspace-grid">
        <section className="panel board-panel">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Blueprint map</p>
              <h2>Parts and dependencies</h2>
            </div>
            <div className="panel-tools">
              <label>
                Export quality
                <select value={exportQuality} onChange={(event) => setExportQuality(event.target.value)}>
                  <option value="normal">Normal</option>
                  <option value="high">High</option>
                </select>
              </label>
              <label>
                Connection mode
                <select value={state.connectionMode} onChange={(event) => setConnectionMode(event.target.value)}>
                  <option value="dependency">Dependency</option>
                  <option value="source">Source</option>
                </select>
              </label>
              <span className="pill">{connectionInstruction}</span>
              <button type="button" className="secondary-button" onClick={exportPNG}>Export PNG</button>
              <button type="button" className="secondary-button" onClick={exportPDF}>Export PDF</button>
              {state.connectingFromId ? (
                <button type="button" className="secondary-button" onClick={cancelConnection}>
                  Cancel link
                </button>
              ) : null}
              <div className="edge-legend" aria-label="Connection types">
                <span className="edge-legend-item edge-legend-source">Source link</span>
                <span className="edge-legend-item edge-legend-dependency">Dependency</span>
              </div>
            </div>
          </div>

          <div className="graph-stage" aria-live="polite" onClick={state.connectingFromId ? cancelConnection : undefined}>
            <div
              ref={graphCanvasRef}
            className="graph-canvas"
              style={{
                width: `${graph.width}px`,
                height: `${graph.height}px`,
              }}
            >
            <svg viewBox={`0 0 ${graph.width} ${graph.height}`} preserveAspectRatio="xMinYMin meet" style={{ width: `${graph.width}px`, height: `${graph.height}px` }} aria-hidden="true">
              <defs>
                <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="#243046" />
                </marker>
              </defs>
              <g strokeLinecap="round" strokeLinejoin="round">
                {state.parts.map((part) => {
                  const source = part.sourceId ? graph.positions.get(part.sourceId) : null;
                  const target = graph.positions.get(part.id);
                  if (!source || !target) {
                    return null;
                  }

                  const anchors = resolveAnchors(part.sourceId, part.id, part.sourceAnchor);

                  return (
                    <path
                      key={`${part.id}-${part.sourceId}`}
                      d={buildStructuredEdgePath(source, target, 'source', 0, anchors)}
                      className={`edge-line edge-source ${part.id === selectedId ? 'is-highlighted' : ''}`}
                      onMouseEnter={() => setHoveredLink({ kind: 'source', targetId: part.id, sourceId: part.sourceId })}
                      onMouseLeave={() => setHoveredLink((current) => (current?.kind === 'source' && current?.targetId === part.id ? null : current))}
                    />
                  );
                })}
                {(() => {
                  const dependencyLaneCounts = new Map();
                  return state.parts.flatMap((part) =>
                    part.dependencies.map((dependencyId) => {
                      const source = graph.positions.get(dependencyId);
                      const target = graph.positions.get(part.id);
                      if (!source || !target) {
                        return null;
                      }

                      const lane = dependencyLaneCounts.get(part.id) ?? 0;
                      dependencyLaneCounts.set(part.id, lane + 1);
                      const anchors = resolveAnchors(dependencyId, part.id, part.dependencyAnchors?.[dependencyId]);
                      const geometry = getEdgeGeometry(source, target, 'dependency', lane, anchors);
                      const labelText = part.dependencyLabels?.[dependencyId]?.trim() || 'Dependency';

                      return (
                        <g key={`${part.id}-${dependencyId}`}>
                          <path
                            d={geometry.path}
                            className="edge-line edge-dependency"
                            onMouseEnter={() => setHoveredLink({ kind: 'dependency', targetId: part.id, sourceId: dependencyId })}
                            onMouseLeave={() => setHoveredLink((current) => (current?.kind === 'dependency' && current?.targetId === part.id && current?.sourceId === dependencyId ? null : current))}
                          />
                          <g
                            className="edge-label"
                            transform={`translate(${geometry.label.x}, ${geometry.label.y})`}
                            onMouseEnter={() => setHoveredLink({ kind: 'dependency', targetId: part.id, sourceId: dependencyId })}
                            onMouseLeave={() => setHoveredLink((current) => (current?.kind === 'dependency' && current?.targetId === part.id && current?.sourceId === dependencyId ? null : current))}
                          >
                            <rect x="-58" y="-10" width="116" height="20" rx="9" ry="9" />
                            <text x="0" y="0">{labelText}</text>
                          </g>
                        </g>
                      );
                    }),
                  );
                })()}
                {connectionPreview ? <path d={connectionPreview} className="edge-line connection-preview" /> : null}
                {state.parts.map((part) => {
                  const source = part.sourceId ? graph.positions.get(part.sourceId) : null;
                  const target = graph.positions.get(part.id);
                  if (!source || !target) {
                    return null;
                  }

                  const showHandles = part.id === selectedId || (hoveredLink?.kind === 'source' && hoveredLink?.targetId === part.id);
                  if (!showHandles) {
                    return null;
                  }

                  const anchors = resolveAnchors(part.sourceId, part.id, part.sourceAnchor);
                  const startPoint = getAnchorPoint(source, anchors.from);
                  const endPoint = getAnchorPoint(target, anchors.to);

                  return (
                    <g key={`source-handles-${part.id}-${part.sourceId}`}>
                      <circle
                        className="edge-anchor-handle edge-anchor-start edge-anchor-source"
                        cx={startPoint.x}
                        cy={startPoint.y}
                        r="7"
                        onPointerDown={(event) => event.stopPropagation()}
                        onMouseEnter={() => setHoveredLink({ kind: 'source', targetId: part.id, sourceId: part.sourceId })}
                        onMouseLeave={() => setHoveredLink((current) => (current?.kind === 'source' && current?.targetId === part.id ? null : current))}
                        onClick={(event) => {
                          event.stopPropagation();
                          cycleSourceAnchorSide(part.id, 'from');
                        }}
                      >
                        <title>Cycle source start side</title>
                      </circle>
                      <circle
                        className="edge-anchor-handle edge-anchor-end edge-anchor-source"
                        cx={endPoint.x}
                        cy={endPoint.y}
                        r="7"
                        onPointerDown={(event) => event.stopPropagation()}
                        onMouseEnter={() => setHoveredLink({ kind: 'source', targetId: part.id, sourceId: part.sourceId })}
                        onMouseLeave={() => setHoveredLink((current) => (current?.kind === 'source' && current?.targetId === part.id ? null : current))}
                        onClick={(event) => {
                          event.stopPropagation();
                          cycleSourceAnchorSide(part.id, 'to');
                        }}
                      >
                        <title>Cycle source end side</title>
                      </circle>
                    </g>
                  );
                })}
                {state.parts.flatMap((part) =>
                  part.dependencies.map((dependencyId) => {
                    const source = graph.positions.get(dependencyId);
                    const target = graph.positions.get(part.id);
                    if (!source || !target) {
                      return null;
                    }

                    const showHandles =
                      part.id === selectedId
                      || (hoveredLink?.kind === 'dependency' && hoveredLink?.targetId === part.id && hoveredLink?.sourceId === dependencyId);
                    if (!showHandles) {
                      return null;
                    }

                    const anchors = resolveAnchors(dependencyId, part.id, part.dependencyAnchors?.[dependencyId]);
                    const startPoint = getAnchorPoint(source, anchors.from);
                    const endPoint = getAnchorPoint(target, anchors.to);

                    return (
                      <g key={`dependency-handles-${part.id}-${dependencyId}`}>
                        <circle
                          className="edge-anchor-handle edge-anchor-start edge-anchor-dependency"
                          cx={startPoint.x}
                          cy={startPoint.y}
                          r="6"
                          onPointerDown={(event) => event.stopPropagation()}
                          onMouseEnter={() => setHoveredLink({ kind: 'dependency', targetId: part.id, sourceId: dependencyId })}
                          onMouseLeave={() => setHoveredLink((current) => (current?.kind === 'dependency' && current?.targetId === part.id && current?.sourceId === dependencyId ? null : current))}
                          onClick={(event) => {
                            event.stopPropagation();
                            cycleDependencyAnchorSide(part.id, dependencyId, 'from');
                          }}
                        >
                          <title>Cycle dependency start side</title>
                        </circle>
                        <circle
                          className="edge-anchor-handle edge-anchor-end edge-anchor-dependency"
                          cx={endPoint.x}
                          cy={endPoint.y}
                          r="6"
                          onPointerDown={(event) => event.stopPropagation()}
                          onMouseEnter={() => setHoveredLink({ kind: 'dependency', targetId: part.id, sourceId: dependencyId })}
                          onMouseLeave={() => setHoveredLink((current) => (current?.kind === 'dependency' && current?.targetId === part.id && current?.sourceId === dependencyId ? null : current))}
                          onClick={(event) => {
                            event.stopPropagation();
                            cycleDependencyAnchorSide(part.id, dependencyId, 'to');
                          }}
                        >
                          <title>Cycle dependency end side</title>
                        </circle>
                      </g>
                    );
                  }),
                )}
              </g>
            </svg>

            <div className="node-layer" style={{ minWidth: `${graph.width}px`, minHeight: `${graph.height}px` }}>
              {graph.nodes.map(({ part, depth }) => {
                const position = graph.positions.get(part.id) ?? { x: 120, y: 120 };
                const resolved = getResolvedPart(part.id, state.parts) ?? part;
                const selected = part.id === selectedId ? 'is-selected' : '';
                const sourceClass = part.sourceId ? 'is-source' : '';
                const color = colorPalette[depth % colorPalette.length];
                const sourceChainText = getSourceChainNames(part, graph.partsMap).length ? getSourceChainNames(part, graph.partsMap).join(' → ') : 'Source root';

                return (
                  <button
                    type="button"
                    key={part.id}
                    data-part-id={part.id}
                    className={`graph-node ${selected} ${sourceClass} ${state.connectingFromId === part.id ? 'is-connecting-from' : ''} ${connectionHoverId === part.id ? 'is-connect-target' : ''} ${draggingNodeId === part.id ? 'is-dragging' : ''}`}
                    style={{ left: position.x, top: position.y, width: `${NODE_WIDTH}px`, height: `${NODE_HEIGHT}px`, '--node-color': color }}
                    onClick={(event) => {
                      const shouldSuppressClick = suppressClickRef.current === part.id;
                      suppressClickRef.current = null;
                      if (shouldSuppressClick) {
                        event.stopPropagation();
                        return;
                      }
                      event.stopPropagation();
                      onNodeClick(part.id);
                    }}
                    onPointerDown={(event) => beginNodeDrag(part.id, event)}
                    onPointerMove={onNodePointerMove}
                    onPointerUp={endNodeDrag}
                    onPointerCancel={endNodeDrag}
                    onMouseEnter={() => {
                      if (state.connectingFromId && state.connectingFromId !== part.id) {
                        setConnectionHoverId(part.id);
                      }
                    }}
                    onMouseLeave={() => {
                      if (connectionHoverId === part.id) {
                        setConnectionHoverId(null);
                      }
                    }}
                  >
                    <span
                      className="graph-handle"
                      onPointerDown={(event) => beginConnection(part.id, event)}
                      onClick={(event) => event.stopPropagation()}
                      title={`Start ${state.connectionMode === 'source' ? 'source' : 'dependency'} connection`}
                    >
                      ↘
                    </span>
                    <span className="node-title">{part.name}</span>
                    <span className="node-meta">{resolved.owner || 'No owner yet'}</span>
                    <span className="chip">{resolved.residesIn || 'No residence'}</span>
                    <span className="chip">{resolved.presentedIn || 'No presentation'}</span>
                    <span className="node-legend">
                      <span className="ribbon">{sourceChainText}</span>
                    </span>
                  </button>
                );
              })}
            </div>
            </div>
          </div>
        </section>

        <aside className="panel inspector-panel">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Inspector</p>
              <h2>Edit one part at a time</h2>
            </div>
          </div>

          <form className="part-form" onSubmit={savePart}>
            <div className="form-row">
              <label>
                Part name
                <input name="name" type="text" value={draft?.name ?? ''} onChange={(event) => updateDraft('name', event.target.value)} placeholder="Customer plan epic" required />
              </label>
              <label>
                Owner
                <input name="owner" type="text" value={draft?.owner ?? ''} onChange={(event) => updateDraft('owner', event.target.value)} placeholder="Plan steward" />
              </label>
            </div>

            <div className="form-row">
              <label>
                Resides in
                <input name="residesIn" type="text" value={draft?.residesIn ?? ''} onChange={(event) => updateDraft('residesIn', event.target.value)} placeholder="Portfolio vault" />
              </label>
              <label>
                Presented in
                <input name="presentedIn" type="text" value={draft?.presentedIn ?? ''} onChange={(event) => updateDraft('presentedIn', event.target.value)} placeholder="Steering board" />
              </label>
            </div>

            <label>
              Source part
              <select
                value={draft?.sourceId ?? ''}
                onChange={(event) => {
                  if (!draft) {
                    return;
                  }

                  const nextSourceId = event.target.value || null;
                  const nextAnchor = nextSourceId ? suggestAnchors(nextSourceId, draft.id) : { from: 'right', to: 'left' };
                  setState((current) => ({
                    ...current,
                    draft: current.draft
                      ? {
                          ...current.draft,
                          sourceId: nextSourceId,
                          sourceAnchor: nextAnchor,
                        }
                      : current.draft,
                  }));
                }}
              >
                <option value="">No source / root part</option>
                {state.parts
                  .filter((part) => part.id !== draft?.id)
                  .map((part) => (
                    <option value={part.id} key={part.id}>
                      {part.name}
                    </option>
                  ))}
              </select>
            </label>

            {draft?.sourceId ? (
              <div className="link-anchor-editor">
                <div className="picker-header">
                  <span>Source link endpoints</span>
                  <span className="hint">Choose which side the source line connects to</span>
                </div>
                <div className="form-row">
                  <label>
                    Start side on source box
                    <select value={draft.sourceAnchor?.from ?? 'right'} onChange={(event) => updateSourceAnchor('from', event.target.value)}>
                      {ANCHOR_SIDES.map((side) => (
                        <option value={side} key={side}>{ANCHOR_LABELS[side]}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    End side on this box
                    <select value={draft.sourceAnchor?.to ?? 'left'} onChange={(event) => updateSourceAnchor('to', event.target.value)}>
                      {ANCHOR_SIDES.map((side) => (
                        <option value={side} key={side}>{ANCHOR_LABELS[side]}</option>
                      ))}
                    </select>
                  </label>
                </div>
              </div>
            ) : null}

            <label>
              Notes
              <textarea
                rows="4"
                value={draft?.description ?? ''}
                onChange={(event) => updateDraft('description', event.target.value)}
                placeholder="Short description, rules, or context. Blank values inherit from the source part."
              />
            </label>

            <div className="dependency-picker">
              <div className="picker-header">
                <span>Dependency manager</span>
                <span className="hint">Create, label, and remove dependencies for this part</span>
              </div>
              <div className="dependency-create-row">
                <label>
                  Add dependency from part
                  <select value={newDependencyId} onChange={(event) => setNewDependencyId(event.target.value)}>
                    <option value="">Select part</option>
                    {addableDependencies.map((part) => (
                      <option value={part.id} key={part.id}>{part.name}</option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => {
                    if (!newDependencyId) {
                      return;
                    }
                    addDependencyToDraft(newDependencyId);
                    setNewDependencyId('');
                  }}
                  disabled={!newDependencyId}
                >
                  Add dependency
                </button>
              </div>

              {!draft?.dependencies?.length ? <p className="catalog-empty">No dependencies yet.</p> : null}
              <div className="dependency-manager-list">
                {(draft?.dependencies ?? []).map((dependencyId) => {
                  const dependencyName = partsMap.get(dependencyId)?.name ?? dependencyId;
                  return (
                    <div className="dependency-manager-item" key={dependencyId}>
                      <div className="dependency-manager-head">
                        <strong>{dependencyName}</strong>
                        <button type="button" className="danger-button" onClick={() => removeDependencyFromDraft(dependencyId)}>Remove</button>
                      </div>
                      <label>
                        Dependency label
                        <input
                          type="text"
                          value={draft?.dependencyLabels?.[dependencyId] ?? ''}
                          onChange={(event) => updateDependencyLabel(dependencyId, event.target.value)}
                          placeholder="e.g. Feeds status updates"
                        />
                      </label>
                    </div>
                  );
                })}
              </div>
            </div>

            {draft?.dependencies?.length ? (
              <div className="link-anchor-editor">
                <div className="picker-header">
                  <span>Dependency line endpoints</span>
                  <span className="hint">Set where each dependency line starts and ends</span>
                </div>
                <div className="dependency-anchor-list">
                  {draft.dependencies.map((dependencyId) => {
                    const dependencyName = partsMap.get(dependencyId)?.name ?? dependencyId;
                    const anchor = draft.dependencyAnchors?.[dependencyId] ?? suggestAnchors(dependencyId, draft.id);
                    return (
                      <div className="dependency-anchor-item" key={dependencyId}>
                        <div className="dependency-anchor-title">{dependencyName}</div>
                        <div className="form-row">
                          <label>
                            Start side on dependency box
                            <select value={anchor.from} onChange={(event) => updateDependencyAnchor(dependencyId, 'from', event.target.value)}>
                              {ANCHOR_SIDES.map((side) => (
                                <option value={side} key={side}>{ANCHOR_LABELS[side]}</option>
                              ))}
                            </select>
                          </label>
                          <label>
                            End side on this box
                            <select value={anchor.to} onChange={(event) => updateDependencyAnchor(dependencyId, 'to', event.target.value)}>
                              {ANCHOR_SIDES.map((side) => (
                                <option value={side} key={side}>{ANCHOR_LABELS[side]}</option>
                              ))}
                            </select>
                          </label>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}

            <div className="form-actions">
              <button type="submit" className="primary-button">Save part</button>
              <button type="button" className="danger-button" onClick={deletePart}>Delete part</button>
              <button type="button" className="secondary-button" onClick={() => removeSourceLink(draft?.id)} disabled={!draft?.sourceId}>Clear source</button>
            </div>
          </form>

          <div className="details-card">
            <div className="details-head">
              <p className="panel-kicker">Selected part</p>
              <span className="pill">{draft ? (state.parts.some((part) => part.id === draft.id) ? 'Editing existing part' : 'New draft') : 'Nothing selected'}</span>
            </div>
            <div className="detail-view">
              {!draft ? (
                <p className="catalog-empty">Click a node or catalog entry to inspect a part. New parts can start as blank or inherit from the currently selected source.</p>
              ) : (
                <>
                  <DetailLine label="Name" value={selectedResolved?.name || 'Untitled'} />
                  <DetailLine label="Owner" value={selectedResolved?.owner || 'Inherit from source'} />
                  <DetailLine label="Resides in" value={selectedResolved?.residesIn || 'Inherit from source'} />
                  <DetailLine label="Presented in" value={selectedResolved?.presentedIn || 'Inherit from source'} />
                  <DetailLine label="Source" value={draft.sourceId ? partsMap.get(draft.sourceId)?.name ?? 'Missing source' : 'Source root'} />
                  <DetailLine label="Dependencies" value={draft.dependencies.length ? draft.dependencies.map((dependencyId) => partsMap.get(dependencyId)?.name).filter(Boolean).join(', ') : 'No dependencies yet'} />
                  <DetailLine label="Origin chain" value={sourceChain.length ? sourceChain.join(' → ') : 'This part starts the chain'} />
                  <DetailLine label="Notes" value={selectedResolved?.description || 'No notes yet'} />
                </>
              )}
            </div>
          </div>
        </aside>
      </section>

      <section className="panel list-panel">
        <div className="panel-header">
          <div>
            <p className="panel-kicker">Catalog</p>
            <h2>All parts grouped by residence</h2>
          </div>
          <div className="panel-tools">
            <p className="panel-note">This table gives the exact owner, presentation point, and dependency footprint for each part.</p>
            <label>
              Export quality
              <select value={exportQuality} onChange={(event) => setExportQuality(event.target.value)}>
                <option value="normal">Normal</option>
                <option value="high">High</option>
              </select>
            </label>
            <button type="button" className="secondary-button" onClick={exportPNG}>Export PNG</button>
            <button type="button" className="secondary-button" onClick={exportPDF}>Export PDF</button>
          </div>
        </div>
        <div className="catalog">
          {groupedParts.map(([residence, parts]) => (
            <section className="catalog-group" key={residence}>
              <h3>{residence}</h3>
              <div className="catalog-list">
                {parts.map((part) => {
                  const summary = getSourceChainNames(part, partsMap);
                  const sourceName = part.sourceId ? partsMap.get(part.sourceId)?.name ?? 'Missing source' : 'Source root';
                  return (
                    <button type="button" className={`catalog-item ${part.id === selectedId ? 'is-selected' : ''}`} key={part.id} onClick={() => selectPart(part.id)}>
                      <div className="catalog-title">
                        <span>{part.name}</span>
                        <span className="ribbon">{summary.length ? 'Derived' : 'Root'}</span>
                      </div>
                      <div className="supporting-note">Owner: {part.owner || 'Unassigned'}</div>
                      <div className="supporting-note">Presented in: {part.presentedIn || 'Not set'}</div>
                      <div className="supporting-note">Source: {sourceName}</div>
                      <div className="catalog-meta">
                        {part.dependencies.length ? part.dependencies.map((dependencyId) => <span className="part-chip" key={dependencyId}>{partsMap.get(dependencyId)?.name ?? dependencyId}</span>) : <span className="part-chip">No dependencies</span>}
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      </section>

      <section className="stats-row" aria-label="Plan summary">
        {stats.map(([value, label]) => (
          <article className="stat-card" key={label}>
            <span className="stat-value">{value}</span>
            <span className="stat-label">{label}</span>
          </article>
        ))}
      </section>
    </main>
  );
}

export default App;