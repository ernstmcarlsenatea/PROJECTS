import { useMemo, useState, useEffect, useCallback } from 'react';
import { getPartsMap, getResolvedPart } from './graph.js';

const RUNBOOK_CONFIG_KEY = 'kundeplan-runbook-config-v1';

const STEP_STATUS = {
  'not-started': { label: 'Not started', className: 'rb-status-not-started' },
  'in-progress': { label: 'In progress', className: 'rb-status-in-progress' },
  done: { label: 'Done', className: 'rb-status-done' },
  'skipped': { label: 'Skipped', className: 'rb-status-skipped' },
};

// Topological sort: dependencies and source links define execution order.
// A part's dependencies must be executed before the part itself.
function topoSort(parts) {
  const partsMap = new Map(parts.map((p) => [p.id, p]));

  // Build directed graph: edge from A → B means A must come before B
  const successors = new Map(parts.map((p) => [p.id, []]));
  const inDegree = new Map(parts.map((p) => [p.id, 0]));

  for (const part of parts) {
    // dependencies: depId → part (dep must run before this part)
    for (const depId of part.dependencies ?? []) {
      if (!partsMap.has(depId)) continue;
      successors.get(depId).push(part.id);
      inDegree.set(part.id, (inDegree.get(part.id) ?? 0) + 1);
    }
    // source link: sourceId → part (source must run before derived part)
    if (part.sourceId && partsMap.has(part.sourceId)) {
      // Only add if not already added via dependencies to avoid duplicate edges
      const alreadyLinked = (part.dependencies ?? []).includes(part.sourceId);
      if (!alreadyLinked) {
        successors.get(part.sourceId).push(part.id);
        inDegree.set(part.id, (inDegree.get(part.id) ?? 0) + 1);
      }
    }
  }

  // Kahn's algorithm — stable: sort zero-degree nodes by name for reproducibility
  const queue = parts
    .filter((p) => (inDegree.get(p.id) ?? 0) === 0)
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
    .map((p) => p.id);

  const result = [];
  const visited = new Set();

  while (queue.length > 0) {
    const id = queue.shift();
    if (visited.has(id)) continue;
    visited.add(id);
    result.push(id);

    const nextIds = [...(successors.get(id) ?? [])].sort((a, b) =>
      (partsMap.get(a)?.name ?? '').localeCompare(partsMap.get(b)?.name ?? ''),
    );
    for (const nextId of nextIds) {
      const newDeg = (inDegree.get(nextId) ?? 0) - 1;
      inDegree.set(nextId, newDeg);
      if (newDeg <= 0 && !visited.has(nextId)) {
        queue.push(nextId);
      }
    }
  }

  // Append any parts not reached (cycles in data) at the end
  for (const part of parts) {
    if (!visited.has(part.id)) {
      result.push(part.id);
    }
  }

  return result.map((id) => partsMap.get(id)).filter(Boolean);
}

function loadRunbookConfig() {
  try {
    const raw = localStorage.getItem(RUNBOOK_CONFIG_KEY);
    if (!raw) return {};
    return JSON.parse(raw) ?? {};
  } catch {
    return {};
  }
}

function saveRunbookConfig(config) {
  try {
    localStorage.setItem(RUNBOOK_CONFIG_KEY, JSON.stringify(config));
  } catch {
    // quota exceeded — ignore
  }
}

export function RunbookPage({ parts }) {
  const [config, setConfig] = useState(() => loadRunbookConfig());
  const [filterStatus, setFilterStatus] = useState('all');
  const [filterOwner, setFilterOwner] = useState('all');
  const [filterResidence, setFilterResidence] = useState('all');
  const [expandedIds, setExpandedIds] = useState(() => new Set());
  const [editingNotesId, setEditingNotesId] = useState(null);

  // Persist config on every change
  useEffect(() => {
    saveRunbookConfig(config);
  }, [config]);

  const partsMap = useMemo(() => getPartsMap(parts), [parts]);

  // Compute execution order from blueprint topology
  const orderedSteps = useMemo(() => topoSort(parts), [parts]);

  const owners = useMemo(() => {
    const set = new Set();
    for (const part of parts) {
      if (part.owner) set.add(part.owner);
    }
    return [...set].sort();
  }, [parts]);

  const residences = useMemo(() => {
    const set = new Set();
    for (const part of parts) {
      const resolved = getResolvedPart(part.id, parts) ?? part;
      const r = resolved.residesIn || part.residesIn;
      if (r) set.add(r);
    }
    return [...set].sort();
  }, [parts]);

  const filteredSteps = useMemo(() => {
    return orderedSteps.filter((part) => {
      const resolved = getResolvedPart(part.id, parts) ?? part;
      const stepConfig = config[part.id] ?? {};
      const status = stepConfig.status ?? 'not-started';

      if (filterStatus !== 'all' && status !== filterStatus) return false;
      if (filterOwner !== 'all' && (resolved.owner || part.owner || '') !== filterOwner) return false;
      if (filterResidence !== 'all') {
        const residence = resolved.residesIn || part.residesIn || '';
        if (residence !== filterResidence) return false;
      }
      return true;
    });
  }, [orderedSteps, config, filterStatus, filterOwner, filterResidence, parts]);

  const progress = useMemo(() => {
    if (orderedSteps.length === 0) return { done: 0, inProgress: 0, total: 0 };
    let done = 0;
    let inProgress = 0;
    for (const part of orderedSteps) {
      const status = (config[part.id] ?? {}).status ?? 'not-started';
      if (status === 'done') done++;
      if (status === 'in-progress') inProgress++;
    }
    return { done, inProgress, total: orderedSteps.length };
  }, [orderedSteps, config]);

  const updateStepStatus = useCallback((partId, status) => {
    setConfig((prev) => ({
      ...prev,
      [partId]: { ...(prev[partId] ?? {}), status },
    }));
  }, []);

  const updateStepNotes = useCallback((partId, notes) => {
    setConfig((prev) => ({
      ...prev,
      [partId]: { ...(prev[partId] ?? {}), notes },
    }));
  }, []);

  const toggleExpanded = useCallback((partId) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(partId)) {
        next.delete(partId);
      } else {
        next.add(partId);
      }
      return next;
    });
  }, []);

  function expandAll() {
    setExpandedIds(new Set(filteredSteps.map((p) => p.id)));
  }

  function collapseAll() {
    setExpandedIds(new Set());
  }

  function resetAllStatuses() {
    if (!window.confirm('Reset all step statuses to "Not started"?')) return;
    setConfig((prev) => {
      const next = { ...prev };
      for (const part of parts) {
        if (next[part.id]) {
          next[part.id] = { ...next[part.id], status: 'not-started' };
        }
      }
      return next;
    });
  }

  const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div className="runbook-shell">
      {/* Header */}
      <div className="runbook-header">
        <div className="runbook-header-intro">
          <p className="panel-kicker">Runbook</p>
          <h2>Execution plan — derived from blueprint map</h2>
          <p className="panel-note">
            Steps are ordered by dependencies from the blueprint map. When the blueprint changes, this runbook updates automatically.
          </p>
        </div>

        {/* Progress bar */}
        <div className="runbook-progress-wrap">
          <div className="runbook-progress-labels">
            <span><strong>{progress.done}</strong> of <strong>{progress.total}</strong> steps done</span>
            <span className="runbook-progress-pct">{pct}%</span>
          </div>
          <div className="runbook-progress-bar-track" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <div className="runbook-progress-bar-fill" style={{ width: `${pct}%` }} />
            {progress.inProgress > 0 && (
              <div
                className="runbook-progress-bar-wip"
                style={{ width: `${Math.round((progress.inProgress / progress.total) * 100)}%`, left: `${pct}%` }}
              />
            )}
          </div>
          <div className="runbook-progress-legend">
            <span className="rb-legend-dot rb-legend-done" /> Done
            <span className="rb-legend-dot rb-legend-wip" /> In progress
            <span className="rb-legend-dot rb-legend-ns" /> Not started
          </div>
        </div>
      </div>

      {/* Filters + controls */}
      <div className="runbook-controls">
        <div className="runbook-filters">
          <label>
            Status
            <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
              <option value="all">All statuses</option>
              <option value="not-started">Not started</option>
              <option value="in-progress">In progress</option>
              <option value="done">Done</option>
              <option value="skipped">Skipped</option>
            </select>
          </label>
          <label>
            Owner
            <select value={filterOwner} onChange={(e) => setFilterOwner(e.target.value)}>
              <option value="all">All owners</option>
              {owners.map((o) => (
                <option key={o} value={o}>{o}</option>
              ))}
            </select>
          </label>
          <label>
            Residence
            <select value={filterResidence} onChange={(e) => setFilterResidence(e.target.value)}>
              <option value="all">All residences</option>
              {residences.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="runbook-actions">
          <button type="button" className="secondary-button" onClick={expandAll}>Expand all</button>
          <button type="button" className="secondary-button" onClick={collapseAll}>Collapse all</button>
          <button type="button" className="secondary-button" onClick={resetAllStatuses}>Reset statuses</button>
        </div>
      </div>

      {/* Step count pill */}
      <div className="runbook-step-count">
        Showing <strong>{filteredSteps.length}</strong> of <strong>{orderedSteps.length}</strong> steps
      </div>

      {/* Steps list */}
      {filteredSteps.length === 0 ? (
        <p className="catalog-empty runbook-empty">No steps match the current filters. Adjust the filters above or add parts in the Blueprint map.</p>
      ) : (
        <ol className="runbook-steps" aria-label="Runbook steps">
          {filteredSteps.map((part, index) => {
            const resolved = getResolvedPart(part.id, parts) ?? part;
            const stepConfig = config[part.id] ?? {};
            const status = stepConfig.status ?? 'not-started';
            const customNotes = stepConfig.notes ?? '';
            const isExpanded = expandedIds.has(part.id);
            const isEditingNotes = editingNotesId === part.id;

            const deps = (part.dependencies ?? [])
              .map((depId) => partsMap.get(depId))
              .filter(Boolean);
            const sourcePart = part.sourceId ? partsMap.get(part.sourceId) : null;

            // Check if all dependencies are done
            const allDepsDone = deps.every((dep) => (config[dep.id] ?? {}).status === 'done');
            const hasBlockers = deps.some((dep) => {
              const depStatus = (config[dep.id] ?? {}).status ?? 'not-started';
              return depStatus !== 'done' && depStatus !== 'skipped';
            });

            const stepNumber = orderedSteps.indexOf(part) + 1;

            return (
              <li
                key={part.id}
                className={`runbook-step rb-status-${status} ${hasBlockers && status === 'not-started' ? 'is-blocked' : ''} ${status === 'done' ? 'is-done' : ''}`}
                data-part-id={part.id}
              >
                <div className="runbook-step-head">
                  <button
                    type="button"
                    className="runbook-step-toggle"
                    onClick={() => toggleExpanded(part.id)}
                    aria-expanded={isExpanded}
                    aria-label={`${isExpanded ? 'Collapse' : 'Expand'} step ${stepNumber}: ${part.name}`}
                  >
                    <span className="runbook-step-number">{stepNumber}</span>
                    <span className="runbook-step-title">{part.name || '(Unnamed)'}</span>
                    <span className="runbook-step-owner">{resolved.owner || part.owner || 'No owner'}</span>
                    {hasBlockers && status !== 'done' && status !== 'skipped' && (
                      <span className="runbook-blocker-badge" title="One or more dependencies are not yet done">⚠ Blocked</span>
                    )}
                    <span className={`runbook-status-badge ${STEP_STATUS[status]?.className ?? ''}`}>
                      {STEP_STATUS[status]?.label ?? status}
                    </span>
                    <span className="runbook-step-chevron" aria-hidden="true">{isExpanded ? '▲' : '▼'}</span>
                  </button>

                  {/* Quick status buttons — always visible */}
                  <div className="runbook-quick-status" role="group" aria-label={`Status for ${part.name}`}>
                    {Object.entries(STEP_STATUS).map(([key, meta]) => (
                      <button
                        key={key}
                        type="button"
                        className={`runbook-status-btn ${status === key ? 'is-active' : ''} ${meta.className}`}
                        onClick={() => updateStepStatus(part.id, key)}
                        title={`Mark as "${meta.label}"`}
                        aria-pressed={status === key}
                      >
                        {meta.label}
                      </button>
                    ))}
                  </div>
                </div>

                {isExpanded && (
                  <div className="runbook-step-body">
                    {/* Blueprint fields */}
                    <div className="runbook-step-meta-grid">
                      <div className="runbook-meta-cell">
                        <span className="runbook-meta-label">Owner</span>
                        <span className="runbook-meta-value">{resolved.owner || part.owner || '—'}</span>
                      </div>
                      <div className="runbook-meta-cell">
                        <span className="runbook-meta-label">Resides in</span>
                        <span className="runbook-meta-value">{resolved.residesIn || part.residesIn || '—'}</span>
                      </div>
                      <div className="runbook-meta-cell">
                        <span className="runbook-meta-label">Presented in</span>
                        <span className="runbook-meta-value">{resolved.presentedIn || part.presentedIn || '—'}</span>
                      </div>
                      <div className="runbook-meta-cell">
                        <span className="runbook-meta-label">Source part</span>
                        <span className="runbook-meta-value">
                          {sourcePart ? sourcePart.name : <em>Source root</em>}
                        </span>
                      </div>
                    </div>

                    {(resolved.description || part.description) && (
                      <div className="runbook-step-description">
                        <span className="runbook-meta-label">Blueprint notes</span>
                        <p>{resolved.description || part.description}</p>
                      </div>
                    )}

                    {/* Dependencies */}
                    {deps.length > 0 && (
                      <div className="runbook-step-deps">
                        <span className="runbook-meta-label">Must be done before this step</span>
                        <ul className="runbook-dep-list">
                          {deps.map((dep) => {
                            const depStatus = (config[dep.id] ?? {}).status ?? 'not-started';
                            return (
                              <li key={dep.id} className={`runbook-dep-item rb-dep-${depStatus}`}>
                                <span className={`rb-dep-dot rb-dep-dot-${depStatus}`} aria-hidden="true" />
                                <span className="runbook-dep-name">{dep.name || '(Unnamed)'}</span>
                                <span className={`runbook-status-badge ${STEP_STATUS[depStatus]?.className ?? ''}`}>
                                  {STEP_STATUS[depStatus]?.label ?? depStatus}
                                </span>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    )}

                    {/* Dependents — what this step unblocks */}
                    {(() => {
                      const dependents = parts.filter((p) => p.dependencies?.includes(part.id));
                      if (dependents.length === 0) return null;
                      return (
                        <div className="runbook-step-unblocks">
                          <span className="runbook-meta-label">This step unblocks</span>
                          <div className="runbook-unblocks-list">
                            {dependents.map((dep) => (
                              <span key={dep.id} className="part-chip">{dep.name || '(Unnamed)'}</span>
                            ))}
                          </div>
                        </div>
                      );
                    })()}

                    {/* Runbook notes (editable) */}
                    <div className="runbook-step-notes">
                      <div className="runbook-notes-header">
                        <span className="runbook-meta-label">Runbook procedure notes</span>
                        {!isEditingNotes && (
                          <button
                            type="button"
                            className="secondary-button runbook-edit-notes-btn"
                            onClick={() => setEditingNotesId(part.id)}
                          >
                            {customNotes ? 'Edit notes' : 'Add notes'}
                          </button>
                        )}
                      </div>
                      {isEditingNotes ? (
                        <div className="runbook-notes-editor">
                          <textarea
                            rows={5}
                            value={customNotes}
                            onChange={(e) => updateStepNotes(part.id, e.target.value)}
                            placeholder="Write step-by-step instructions, checklists, or any runbook procedure here..."
                            autoFocus
                          />
                          <button
                            type="button"
                            className="primary-button"
                            onClick={() => setEditingNotesId(null)}
                          >
                            Done
                          </button>
                        </div>
                      ) : (
                        customNotes
                          ? <p className="runbook-notes-display">{customNotes}</p>
                          : <p className="runbook-notes-empty">No procedure notes yet. Click "Add notes" to document how to execute this step.</p>
                      )}
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
