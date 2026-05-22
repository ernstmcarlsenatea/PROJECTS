import { useEffect, useMemo, useRef, useState } from 'react';
import { STORAGE_KEY, createEmptyDraft, createId, demoParts } from './data.js';
import { buildStructuredEdgePath, canUseAsSource, getGraphLayout, getPartsMap, getResolvedPart, getSourceChainNames } from './graph.js';

const colorPalette = ['#ffd84f', '#ffafdc', '#a8f0de', '#b7d6ff', '#ffc79c', '#c9f59d'];

function clonePart(part) {
  return {
    ...part,
    dependencies: [...part.dependencies],
    position: { ...(part.position ?? { x: 140, y: 140 }) },
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

function App() {
  const [state, setState] = useState(() => loadState());
  const [dragId, setDragId] = useState(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [connectionHoverId, setConnectionHoverId] = useState(null);
  const historyRef = useRef({ past: [], future: [] });
  const dragSnapshotRef = useRef(null);
  const connectionStartRef = useRef(null);
  const dragMovedRef = useRef(false);

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

  const partsMap = useMemo(() => getPartsMap(state.parts), [state.parts]);
  const draft = state.draft ?? state.parts.find((part) => part.id === state.selectedId) ?? null;
  const graph = useMemo(() => getGraphLayout(state.parts), [state.parts]);

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
      position: draft.position ?? { x: 140, y: 140 },
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
      }));

    const nextSelected = parts[0]?.id ?? null;
    commit({ parts, selectedId: nextSelected, draft: nextSelected ? clonePart(parts[0]) : createEmptyDraft(), connectingFromId: null, pendingConnection: null });
  }

  function startDrag(event, partId) {
    event.preventDefault();
    const part = state.parts.find((entry) => entry.id === partId);
    if (!part) {
      return;
    }

    const rect = event.currentTarget.closest('.graph-stage').getBoundingClientRect();
    setDragId(partId);
    setDragOffset({ x: event.clientX - rect.left - (part.position?.x ?? 0), y: event.clientY - rect.top - (part.position?.y ?? 0) });
    dragSnapshotRef.current = cloneAppState(state);
    dragMovedRef.current = false;
    selectPart(partId);
  }

  useEffect(() => {
    function onMove(event) {
      if (!dragId) {
        return;
      }

      const stage = document.querySelector('.graph-stage');
      if (!stage) {
        return;
      }

      const rect = stage.getBoundingClientRect();
      const nextX = Math.max(0, event.clientX - rect.left - dragOffset.x);
      const nextY = Math.max(0, event.clientY - rect.top - dragOffset.y);
      dragMovedRef.current = true;

      setState((current) => ({
        ...current,
        parts: current.parts.map((part) => (part.id === dragId ? { ...part, position: { x: nextX, y: nextY } } : part)),
        draft: current.draft?.id === dragId ? { ...current.draft, position: { x: nextX, y: nextY } } : current.draft,
      }));
    }

    function onUp() {
      if (dragId) {
        if (dragMovedRef.current) {
          historyRef.current.past.push(dragSnapshotRef.current ?? cloneAppState(state));
          historyRef.current.future = [];
        }
        setDragId(null);
        dragSnapshotRef.current = null;
        dragMovedRef.current = false;
      }
    }

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [dragId, dragOffset]);

  function beginConnection(partId, event) {
    event.stopPropagation();
    connectionStartRef.current = partId;
    setState((current) => ({ ...current, connectingFromId: partId, pendingConnection: null }));
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
          return { ...part, sourceId: fromId };
        }

        if (mode === 'dependency' && part.id === targetId) {
          if (part.dependencies.includes(fromId)) {
            return part;
          }
          return { ...part, dependencies: [...part.dependencies, fromId] };
        }

        return part;
      });

      return { ...current, parts, connectingFromId: null, pendingConnection: null, selectedId: targetId, draft: clonePart(parts.find((part) => part.id === targetId) ?? current.draft ?? createEmptyDraft()) };
    }, { history });
  }

  function cancelConnection() {
    connectionStartRef.current = null;
    setState((current) => ({ ...current, connectingFromId: null, pendingConnection: null }));
  }

  function removeDependency(partId, dependencyId) {
    commit((current) => ({
      ...current,
      parts: current.parts.map((part) => (part.id === partId ? { ...part, dependencies: part.dependencies.filter((id) => id !== dependencyId) } : part)),
      draft: current.draft?.id === partId ? { ...current.draft, dependencies: current.draft.dependencies.filter((id) => id !== dependencyId) } : current.draft,
    }));
  }

  function removeSourceLink(partId) {
    commit((current) => ({
      ...current,
      parts: current.parts.map((part) => (part.id === partId ? { ...part, sourceId: null } : part)),
      draft: current.draft?.id === partId ? { ...current.draft, sourceId: null } : current.draft,
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
    setDragId(null);
  }

  function redo() {
    const next = historyRef.current.future.pop();
    if (!next) {
      return;
    }

    historyRef.current.past.push(cloneAppState(state));
    setState({ ...cloneAppState(next), connectingFromId: null, pendingConnection: null });
    cancelConnection();
    setDragId(null);
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

  const connectionInstruction = state.connectingFromId
    ? `Choose a target to ${state.connectionMode === 'source' ? 'set a source link' : 'add a dependency'}.`
    : 'Drag nodes to reposition them, or drag from the link dot on one node to another node.';

  useEffect(() => {
    function onPointerMove(event) {
      if (!state.connectingFromId) {
        return;
      }

      const element = document.elementFromPoint(event.clientX, event.clientY);
      const node = element?.closest?.('.graph-node');
      const targetId = node?.dataset?.partId ?? null;
      setConnectionHoverId(targetId);
    }

    function onPointerUp(event) {
      if (!state.connectingFromId) {
        return;
      }

      const element = document.elementFromPoint(event.clientX, event.clientY);
      const node = element?.closest?.('.graph-node');
      const targetId = node?.dataset?.partId ?? null;
      if (targetId) {
        completeConnection(targetId, connectionStartRef.current ?? state.connectingFromId);
      } else {
        cancelConnection();
      }
      setConnectionHoverId(null);
    }

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
  }, [state.connectingFromId, state.connectionMode, state.parts]);

  return (
    <main className="app-shell">
      <div className="sky-blobs" aria-hidden="true" />
      <header className="hero">
        <div>
          <p className="eyebrow">ATEA AS customer plan atlas</p>
          <h1>Kundeplan built as a living cartoon map.</h1>
          <p className="hero-copy">
            Track every part, the owner, where it lives, where it is presented, and how it depends on the rest.
            One source of truth keeps updates propagating cleanly across the map.
          </p>
        </div>
        <div className="hero-actions">
          <button type="button" className="primary-button" onClick={openNewPart}>New part</button>
          <button type="button" className="secondary-button" onClick={resetDemo}>Reset demo</button>
          <button type="button" className="secondary-button" onClick={undo} disabled={!historyRef.current.past.length}>Undo</button>
          <button type="button" className="secondary-button" onClick={redo} disabled={!historyRef.current.future.length}>Redo</button>
        </div>
      </header>

      <section className="stats-row" aria-label="Plan summary">
        {stats.map(([value, label]) => (
          <article className="stat-card" key={label}>
            <span className="stat-value">{value}</span>
            <span className="stat-label">{label}</span>
          </article>
        ))}
      </section>

      <section className="workspace-grid">
        <section className="panel board-panel">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Blueprint map</p>
              <h2>Parts and dependencies</h2>
            </div>
            <div className="panel-tools">
              <label>
                Connection mode
                <select value={state.connectionMode} onChange={(event) => persist({ connectionMode: event.target.value })}>
                  <option value="dependency">Dependency</option>
                  <option value="source">Source</option>
                </select>
              </label>
              <span className="pill">{connectionInstruction}</span>
              <div className="edge-legend" aria-label="Connection types">
                <span className="edge-legend-item edge-legend-source">Source link</span>
                <span className="edge-legend-item edge-legend-dependency">Dependency</span>
              </div>
            </div>
          </div>

          <div className="graph-stage" aria-live="polite" onPointerLeave={() => setConnectionHoverId(null)}>
            <svg viewBox={`0 0 ${graph.width} ${graph.height}`} preserveAspectRatio="none" aria-hidden="true">
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

                  return <path key={`${part.id}-${part.sourceId}`} d={buildStructuredEdgePath(source, target, 'source', 0)} className={`edge-line edge-source ${part.id === selectedId ? 'is-highlighted' : ''}`} />;
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

                      return <path key={`${part.id}-${dependencyId}`} d={buildStructuredEdgePath(source, target, 'dependency', lane)} className="edge-line edge-dependency" />;
                    }),
                  );
                })()}
                {connectionPreview ? <path d={connectionPreview} className="edge-line connection-preview" /> : null}
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
                    className={`graph-node ${selected} ${sourceClass}`}
                    style={{ left: position.x, top: position.y, '--node-color': color }}
                    onClick={() => selectPart(part.id)}
                    onPointerDown={(event) => startDrag(event, part.id)}
                  >
                    <span className="graph-handle" onPointerDown={(event) => beginConnection(part.id, event)} title={`Start ${state.connectionMode === 'source' ? 'source' : 'dependency'} connection`}>
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
              <select value={draft?.sourceId ?? ''} onChange={(event) => updateDraft('sourceId', event.target.value || null)}>
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
                <span>Dependencies</span>
                <span className="hint">Choose the parts this one needs</span>
              </div>
              <div className="checkbox-grid">
                {state.parts
                  .filter((part) => part.id !== draft?.id)
                  .map((part) => {
                    const checked = draft?.dependencies?.includes(part.id) ?? false;
                    return (
                      <label className="checkbox-item" key={part.id}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(event) => {
                            if (!draft) {
                              return;
                            }

                            const nextDependencies = event.target.checked
                              ? [...draft.dependencies, part.id]
                              : draft.dependencies.filter((dependencyId) => dependencyId !== part.id);
                            updateDraft('dependencies', nextDependencies);
                          }}
                        />
                        <span>{part.name}</span>
                      </label>
                    );
                  })}
              </div>
            </div>

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
          <p className="panel-note">This table gives the exact owner, presentation point, and dependency footprint for each part.</p>
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
    </main>
  );
}

export default App;