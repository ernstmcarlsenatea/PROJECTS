import { useMemo, useState, useEffect, useCallback, useRef } from 'react';
import { jsPDF } from 'jspdf';
import { getPartsMap, getResolvedPart } from './graph.js';
import { createRunbookStore } from './firebaseStore.js';
import { FEATURE_FLAGS } from './featureFlags.js';

const RUNBOOK_CONFIG_KEY = 'kundeplan-runbook-config-v1';

const STEP_STATUS = {
  'not-started': { label: 'Not started', className: 'rb-status-not-started' },
  'in-progress': { label: 'In progress', className: 'rb-status-in-progress' },
  done: { label: 'Done', className: 'rb-status-done' },
  'skipped': { label: 'Skipped', className: 'rb-status-skipped' },
};

const STEP_FIELDS = ['status', 'notes', 'assignee', 'dueDate'];

// Topological sort: dependencies and source links define execution order.
// A part's dependencies must be executed before the part itself.
function topoSort(parts) {
  const partsMap = new Map(parts.map((p) => [p.id, p]));
  const successors = new Map(parts.map((p) => [p.id, []]));
  const inDegree = new Map(parts.map((p) => [p.id, 0]));

  for (const part of parts) {
    for (const depId of part.dependencies ?? []) {
      if (!partsMap.has(depId)) continue;
      successors.get(depId).push(part.id);
      inDegree.set(part.id, (inDegree.get(part.id) ?? 0) + 1);
    }
    if (part.sourceId && partsMap.has(part.sourceId)) {
      const alreadyLinked = (part.dependencies ?? []).includes(part.sourceId);
      if (!alreadyLinked) {
        successors.get(part.sourceId).push(part.id);
        inDegree.set(part.id, (inDegree.get(part.id) ?? 0) + 1);
      }
    }
  }

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

function normalizeStepConfig(step) {
  if (!step || typeof step !== 'object') return {};
  const out = {};
  for (const field of STEP_FIELDS) {
    if (step[field] != null) out[field] = step[field];
  }
  return out;
}

function normalizeConfig(config) {
  if (!config || typeof config !== 'object') return {};
  const out = {};
  for (const [id, step] of Object.entries(config)) {
    const norm = normalizeStepConfig(step);
    if (Object.keys(norm).length > 0) out[id] = norm;
  }
  return out;
}

function shallowEqualConfig(a, b) {
  return JSON.stringify(normalizeConfig(a)) === JSON.stringify(normalizeConfig(b));
}

// CSV helpers
function csvEscape(value) {
  if (value == null) return '';
  const str = String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function formatDate(value) {
  if (!value) return '';
  return value;
}

export function RunbookPage({ parts, canEdit = false, onAuditEvent }) {
  const [config, setConfig] = useState(() => loadRunbookConfig());
  const [filterStatus, setFilterStatus] = useState('all');
  const [filterOwner, setFilterOwner] = useState('all');
  const [filterAssignee, setFilterAssignee] = useState('all');
  const [filterResidence, setFilterResidence] = useState('all');
  const [searchText, setSearchText] = useState('');
  const [expandedIds, setExpandedIds] = useState(() => new Set());
  const [editingNotesId, setEditingNotesId] = useState(null);
  const [cloudStatus, setCloudStatus] = useState('idle'); // idle | syncing | synced | offline | error
  const [cloudError, setCloudError] = useState(null);

  const runbookStore = useMemo(() => createRunbookStore(), []);
  const cloudInitializedRef = useRef(false);
  const cloudBaselineRef = useRef(null);
  const lastSaveRef = useRef(null);

  // Persist config to localStorage on every change
  useEffect(() => {
    saveRunbookConfig(config);
  }, [config]);

  // Subscribe to cloud runbook config
  useEffect(() => {
    if (!runbookStore.enabled) {
      setCloudStatus('offline');
      return undefined;
    }

    const unsubscribe = runbookStore.subscribeConfig(
      (data, meta) => {
        // Ignore echoes of our own pending writes.
        if (meta?.hasPendingWrites) return;

        const cloudConfig = normalizeConfig(data?.config);

        if (!cloudInitializedRef.current) {
          cloudInitializedRef.current = true;
          // First snapshot: if cloud has data, adopt it (cloud is source of truth
          // for newly opened browsers). If cloud is empty and we have local
          // data, the next save will seed the cloud.
          if (Object.keys(cloudConfig).length > 0) {
            setConfig(cloudConfig);
            cloudBaselineRef.current = cloudConfig;
          } else {
            cloudBaselineRef.current = {};
          }
          setCloudStatus('synced');
          return;
        }

        // Subsequent remote update — adopt remote state. Last-write-wins
        // per-step (Firestore-level serialization handles concurrent writes).
        cloudBaselineRef.current = cloudConfig;
        setConfig((current) => (shallowEqualConfig(current, cloudConfig) ? current : cloudConfig));
        setCloudStatus('synced');
      },
      (error) => {
        console.error('Runbook cloud subscription failed:', error);
        setCloudError(error?.message ?? String(error));
        setCloudStatus('error');
      },
    );

    return () => {
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, [runbookStore]);

  // Debounced save to cloud when config changes
  useEffect(() => {
    if (!runbookStore.enabled || !canEdit) return undefined;
    if (!cloudInitializedRef.current) return undefined;

    const normalized = normalizeConfig(config);

    // Don't push if it matches what we just received from cloud.
    if (cloudBaselineRef.current && shallowEqualConfig(normalized, cloudBaselineRef.current)) {
      return undefined;
    }

    setCloudStatus('syncing');
    const timeoutId = window.setTimeout(() => {
      runbookStore
        .saveConfig(normalized)
        .then(() => {
          cloudBaselineRef.current = normalized;
          lastSaveRef.current = Date.now();
          setCloudStatus('synced');
          setCloudError(null);
        })
        .catch((error) => {
          console.error('Runbook cloud save failed:', error);
          setCloudError(error?.message ?? String(error));
          setCloudStatus('error');
        });
    }, 600);

    return () => window.clearTimeout(timeoutId);
  }, [config, runbookStore, canEdit]);

  const partsMap = useMemo(() => getPartsMap(parts), [parts]);
  const orderedSteps = useMemo(() => topoSort(parts), [parts]);

  const owners = useMemo(() => {
    const set = new Set();
    for (const part of parts) if (part.owner) set.add(part.owner);
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

  const assignees = useMemo(() => {
    const set = new Set();
    for (const id of Object.keys(config)) {
      const a = config[id]?.assignee;
      if (a) set.add(a);
    }
    return [...set].sort();
  }, [config]);

  const filteredSteps = useMemo(() => {
    const search = FEATURE_FLAGS.searchAndFilter ? searchText.trim().toLowerCase() : '';
    return orderedSteps.filter((part) => {
      const resolved = getResolvedPart(part.id, parts) ?? part;
      const stepConfig = config[part.id] ?? {};
      const status = stepConfig.status ?? 'not-started';

      if (filterStatus !== 'all' && status !== filterStatus) return false;
      if (filterOwner !== 'all' && (resolved.owner || part.owner || '') !== filterOwner) return false;
      if (filterAssignee !== 'all') {
        const a = stepConfig.assignee || '';
        if (filterAssignee === '__none__' ? a !== '' : a !== filterAssignee) return false;
      }
      if (filterResidence !== 'all') {
        const residence = resolved.residesIn || part.residesIn || '';
        if (residence !== filterResidence) return false;
      }
      if (search) {
        const haystack = [
          part.name,
          resolved.name,
          part.owner,
          resolved.owner,
          part.residesIn,
          resolved.residesIn,
          part.notes,
          resolved.notes,
          stepConfig.assignee,
          stepConfig.notes,
          stepConfig.dueDate,
        ];
        const match = haystack.some(
          (value) => typeof value === 'string' && value.toLowerCase().includes(search),
        );
        if (!match) return false;
      }
      return true;
    });
  }, [orderedSteps, config, filterStatus, filterOwner, filterAssignee, filterResidence, searchText, parts]);

  const progress = useMemo(() => {
    if (orderedSteps.length === 0) return { done: 0, inProgress: 0, total: 0, overdue: 0 };
    let done = 0;
    let inProgress = 0;
    let overdue = 0;
    const todayStr = new Date().toISOString().slice(0, 10);
    for (const part of orderedSteps) {
      const stepConfig = config[part.id] ?? {};
      const status = stepConfig.status ?? 'not-started';
      if (status === 'done') done++;
      if (status === 'in-progress') inProgress++;
      if (stepConfig.dueDate && stepConfig.dueDate < todayStr && status !== 'done' && status !== 'skipped') {
        overdue++;
      }
    }
    return { done, inProgress, total: orderedSteps.length, overdue };
  }, [orderedSteps, config]);

  const updateStepField = useCallback((partId, field, value) => {
    if (!STEP_FIELDS.includes(field)) return;
    setConfig((prev) => {
      const next = { ...prev };
      const existing = next[partId] ?? {};
      if (value === '' || value == null) {
        const updated = { ...existing };
        delete updated[field];
        if (Object.keys(updated).length === 0) {
          delete next[partId];
        } else {
          next[partId] = updated;
        }
      } else {
        next[partId] = { ...existing, [field]: value };
      }
      return next;
    });
  }, []);

  const updateStepStatus = useCallback((partId, status) => {
    updateStepField(partId, 'status', status);
    if (typeof onAuditEvent === 'function') {
      const part = parts.find((p) => p.id === partId);
      const previous = config[partId]?.status ?? 'not-started';
      if (previous !== status) {
        const label = part?.name || partId;
        onAuditEvent(
          'runbook.step.status',
          `Runbook “${label}”: ${previous} → ${status}`,
          { partId, partName: label, previousStatus: previous, newStatus: status },
        );
      }
    }
  }, [updateStepField, onAuditEvent, parts, config]);

  const updateStepNotes = useCallback((partId, notes) => {
    updateStepField(partId, 'notes', notes);
  }, [updateStepField]);

  const toggleExpanded = useCallback((partId) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(partId)) next.delete(partId);
      else next.add(partId);
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
    if (!canEdit) return;
    if (!window.confirm('Reset all step statuses to "Not started"?')) return;
    let clearedCount = 0;
    setConfig((prev) => {
      const next = { ...prev };
      for (const id of Object.keys(next)) {
        const entry = { ...next[id] };
        if (entry.status) clearedCount += 1;
        delete entry.status;
        if (Object.keys(entry).length === 0) {
          delete next[id];
        } else {
          next[id] = entry;
        }
      }
      return next;
    });
    if (typeof onAuditEvent === 'function') {
      onAuditEvent(
        'runbook.reset',
        `Reset all runbook statuses (${clearedCount} steps cleared)`,
        { clearedCount },
      );
    }
  }

  function buildRowData() {
    return orderedSteps.map((part, index) => {
      const resolved = getResolvedPart(part.id, parts) ?? part;
      const stepConfig = config[part.id] ?? {};
      const status = stepConfig.status ?? 'not-started';
      const deps = (part.dependencies ?? [])
        .map((depId) => partsMap.get(depId)?.name)
        .filter(Boolean);
      const sourceName = part.sourceId ? partsMap.get(part.sourceId)?.name ?? '' : '';
      return {
        order: index + 1,
        name: part.name || '(Unnamed)',
        status: STEP_STATUS[status]?.label ?? status,
        owner: resolved.owner || part.owner || '',
        assignee: stepConfig.assignee || '',
        dueDate: stepConfig.dueDate || '',
        residesIn: resolved.residesIn || part.residesIn || '',
        presentedIn: resolved.presentedIn || part.presentedIn || '',
        source: sourceName,
        dependencies: deps.join('; '),
        blueprintNotes: resolved.description || part.description || '',
        runbookNotes: stepConfig.notes || '',
      };
    });
  }

  function exportCSV() {
    const rows = buildRowData();
    const headers = [
      '#', 'Step', 'Status', 'Owner', 'Assignee', 'Due date',
      'Resides in', 'Presented in', 'Source', 'Dependencies',
      'Blueprint notes', 'Runbook notes',
    ];
    const lines = [headers.map(csvEscape).join(',')];
    for (const r of rows) {
      lines.push([
        r.order, r.name, r.status, r.owner, r.assignee, r.dueDate,
        r.residesIn, r.presentedIn, r.source, r.dependencies,
        r.blueprintNotes, r.runbookNotes,
      ].map(csvEscape).join(','));
    }
    const csv = '\uFEFF' + lines.join('\r\n');
    downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), 'kundeplan-runbook.csv');
  }

  function exportPDF() {
    const rows = buildRowData();
    const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });

    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    const marginX = 10;
    const marginTop = 15;
    let y = marginTop;

    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(16);
    pdf.text('Kundeplan — Runbook', marginX, y);
    y += 6;
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(9);
    pdf.text(
      `Generated ${new Date().toLocaleString()}  •  ${rows.length} steps  •  ${progress.done} done, ${progress.inProgress} in progress`,
      marginX, y,
    );
    y += 6;

    // Column widths in mm (sum ≈ 277mm = A4 landscape width minus margins)
    const cols = [
      { key: 'order', label: '#', w: 8 },
      { key: 'name', label: 'Step', w: 50 },
      { key: 'status', label: 'Status', w: 22 },
      { key: 'owner', label: 'Owner', w: 30 },
      { key: 'assignee', label: 'Assignee', w: 30 },
      { key: 'dueDate', label: 'Due', w: 22 },
      { key: 'dependencies', label: 'Depends on', w: 50 },
      { key: 'runbookNotes', label: 'Runbook notes', w: 65 },
    ];

    function drawHeader() {
      pdf.setFillColor(36, 48, 70);
      pdf.setTextColor(255, 255, 255);
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(9);
      pdf.rect(marginX, y, cols.reduce((acc, c) => acc + c.w, 0), 7, 'F');
      let x = marginX;
      for (const col of cols) {
        pdf.text(col.label, x + 1.5, y + 5);
        x += col.w;
      }
      y += 7;
      pdf.setTextColor(0, 0, 0);
      pdf.setFont('helvetica', 'normal');
    }

    drawHeader();

    const rowHeight = 6;
    for (const r of rows) {
      // Compute the wrapped height for the row before drawing.
      const cellLines = cols.map((col) => {
        const raw = String(r[col.key] ?? '');
        return pdf.splitTextToSize(raw, col.w - 3);
      });
      const wrappedRowHeight = Math.max(rowHeight, Math.max(...cellLines.map((l) => l.length)) * 4 + 2);

      if (y + wrappedRowHeight > pageH - 10) {
        pdf.addPage();
        y = marginTop;
        drawHeader();
      }

      // Light row background for striping
      const rowIndex = rows.indexOf(r);
      if (rowIndex % 2 === 0) {
        pdf.setFillColor(248, 248, 240);
        pdf.rect(marginX, y, cols.reduce((acc, c) => acc + c.w, 0), wrappedRowHeight, 'F');
      }

      let x = marginX;
      pdf.setFontSize(8);
      cellLines.forEach((lines, idx) => {
        pdf.text(lines, x + 1.5, y + 4);
        x += cols[idx].w;
      });

      // Row border
      pdf.setDrawColor(220, 220, 210);
      pdf.line(marginX, y + wrappedRowHeight, marginX + cols.reduce((acc, c) => acc + c.w, 0), y + wrappedRowHeight);

      y += wrappedRowHeight;
    }

    pdf.save('kundeplan-runbook.pdf');
  }

  const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  const cloudStatusMeta = {
    idle: { label: 'Idle', className: 'rb-cloud-idle' },
    syncing: { label: 'Syncing…', className: 'rb-cloud-syncing' },
    synced: { label: 'Synced to cloud', className: 'rb-cloud-synced' },
    offline: { label: 'Local only', className: 'rb-cloud-offline' },
    error: { label: 'Sync error', className: 'rb-cloud-error' },
  };

  return (
    <div className="runbook-shell">
      {/* Header */}
      <div className="runbook-header">
        <div className="runbook-header-intro">
          <p className="panel-kicker">Runbook</p>
          <h2>Execution plan — derived from blueprint map</h2>
          <p className="panel-note">
            Steps are ordered by dependencies from the blueprint map. When the blueprint changes, this runbook updates automatically.
            {runbookStore.enabled
              ? ' Status, notes, assignee, and due dates sync to Firebase in real time for all signed-in users.'
              : ' Cloud sync is unavailable — changes are stored locally only.'}
          </p>
          <div className="runbook-cloud-status-row">
            <span className={`runbook-cloud-badge ${cloudStatusMeta[cloudStatus]?.className}`}>
              {cloudStatusMeta[cloudStatus]?.label}
            </span>
            {!canEdit && runbookStore.enabled ? (
              <span className="runbook-cloud-badge rb-cloud-readonly">Read-only (admin required to edit)</span>
            ) : null}
            {cloudError ? <span className="runbook-cloud-error" title={cloudError}>{cloudError}</span> : null}
          </div>
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
            {progress.overdue > 0 ? (
              <span className="rb-legend-overdue">⚠ {progress.overdue} overdue</span>
            ) : null}
          </div>
        </div>
      </div>

      {/* Filters + controls */}
      <div className="runbook-controls">
        <div className="runbook-filters">
          {FEATURE_FLAGS.searchAndFilter ? (
            <label className="runbook-search-label">
              Search
              <div className="runbook-search-input-wrap">
                <input
                  type="search"
                  className="runbook-search-input"
                  value={searchText}
                  onChange={(e) => setSearchText(e.target.value)}
                  placeholder="Name, owner, assignee, notes…"
                  aria-label="Search runbook steps"
                />
                {searchText ? (
                  <button
                    type="button"
                    className="runbook-search-clear"
                    onClick={() => setSearchText('')}
                    aria-label="Clear search"
                  >
                    ×
                  </button>
                ) : null}
              </div>
            </label>
          ) : null}
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
              {owners.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          </label>
          <label>
            Assignee
            <select value={filterAssignee} onChange={(e) => setFilterAssignee(e.target.value)}>
              <option value="all">All assignees</option>
              <option value="__none__">— Unassigned —</option>
              {assignees.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </label>
          <label>
            Residence
            <select value={filterResidence} onChange={(e) => setFilterResidence(e.target.value)}>
              <option value="all">All residences</option>
              {residences.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
        </div>
        <div className="runbook-actions">
          <button type="button" className="secondary-button" onClick={expandAll}>Expand all</button>
          <button type="button" className="secondary-button" onClick={collapseAll}>Collapse all</button>
          <button type="button" className="secondary-button" onClick={exportCSV}>Export CSV</button>
          <button type="button" className="secondary-button" onClick={exportPDF}>Export PDF</button>
          <button
            type="button"
            className="secondary-button"
            onClick={resetAllStatuses}
            disabled={!canEdit}
            title={canEdit ? 'Reset all step statuses to Not started' : 'Only admins can reset statuses'}
          >
            Reset statuses
          </button>
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
          {filteredSteps.map((part) => {
            const resolved = getResolvedPart(part.id, parts) ?? part;
            const stepConfig = config[part.id] ?? {};
            const status = stepConfig.status ?? 'not-started';
            const customNotes = stepConfig.notes ?? '';
            const assignee = stepConfig.assignee ?? '';
            const dueDate = stepConfig.dueDate ?? '';
            const isExpanded = expandedIds.has(part.id);
            const isEditingNotes = editingNotesId === part.id;

            const deps = (part.dependencies ?? [])
              .map((depId) => partsMap.get(depId))
              .filter(Boolean);
            const sourcePart = part.sourceId ? partsMap.get(part.sourceId) : null;

            const hasBlockers = deps.some((dep) => {
              const depStatus = (config[dep.id] ?? {}).status ?? 'not-started';
              return depStatus !== 'done' && depStatus !== 'skipped';
            });

            const todayStr = new Date().toISOString().slice(0, 10);
            const isOverdue = dueDate && dueDate < todayStr && status !== 'done' && status !== 'skipped';
            const isDueSoon = dueDate && !isOverdue && status !== 'done' && status !== 'skipped'
              && (new Date(dueDate) - new Date(todayStr)) <= 7 * 24 * 3600 * 1000;

            const stepNumber = orderedSteps.indexOf(part) + 1;

            return (
              <li
                key={part.id}
                className={`runbook-step rb-status-${status} ${hasBlockers && status === 'not-started' ? 'is-blocked' : ''} ${status === 'done' ? 'is-done' : ''} ${isOverdue ? 'is-overdue' : ''}`}
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
                    {assignee ? (
                      <span className="runbook-step-assignee" title="Assignee">@{assignee}</span>
                    ) : (
                      <span className="runbook-step-owner">{resolved.owner || part.owner || 'No owner'}</span>
                    )}
                    {dueDate ? (
                      <span className={`runbook-due-badge ${isOverdue ? 'is-overdue' : isDueSoon ? 'is-soon' : ''}`} title={`Due ${dueDate}`}>
                        {isOverdue ? '⚠ ' : ''}{formatDate(dueDate)}
                      </span>
                    ) : null}
                    {hasBlockers && status !== 'done' && status !== 'skipped' && (
                      <span className="runbook-blocker-badge" title="One or more dependencies are not yet done">⚠ Blocked</span>
                    )}
                    <span className={`runbook-status-badge ${STEP_STATUS[status]?.className ?? ''}`}>
                      {STEP_STATUS[status]?.label ?? status}
                    </span>
                    <span className="runbook-step-chevron" aria-hidden="true">{isExpanded ? '▲' : '▼'}</span>
                  </button>

                  {/* Quick status buttons */}
                  <div className="runbook-quick-status" role="group" aria-label={`Status for ${part.name}`}>
                    {Object.entries(STEP_STATUS).map(([key, meta]) => (
                      <button
                        key={key}
                        type="button"
                        className={`runbook-status-btn ${status === key ? 'is-active' : ''} ${meta.className}`}
                        onClick={() => canEdit && updateStepStatus(part.id, key)}
                        title={canEdit ? `Mark as "${meta.label}"` : 'Only admins can change status'}
                        aria-pressed={status === key}
                        disabled={!canEdit}
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
                        <span className="runbook-meta-label">Owner (from blueprint)</span>
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

                    {/* Runbook-specific fields: assignee + due date */}
                    <div className="runbook-step-fields">
                      <label className="runbook-field">
                        <span className="runbook-meta-label">Assignee</span>
                        <input
                          type="text"
                          value={assignee}
                          placeholder="Name or email"
                          onChange={(e) => updateStepField(part.id, 'assignee', e.target.value)}
                          disabled={!canEdit}
                        />
                      </label>
                      <label className="runbook-field">
                        <span className="runbook-meta-label">Due date</span>
                        <input
                          type="date"
                          value={dueDate}
                          onChange={(e) => updateStepField(part.id, 'dueDate', e.target.value)}
                          disabled={!canEdit}
                        />
                      </label>
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

                    {/* Dependents */}
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

                    {/* Runbook notes */}
                    <div className="runbook-step-notes">
                      <div className="runbook-notes-header">
                        <span className="runbook-meta-label">Runbook procedure notes</span>
                        {!isEditingNotes && canEdit && (
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
                            disabled={!canEdit}
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
                          : <p className="runbook-notes-empty">No procedure notes yet.{canEdit ? ' Click "Add notes" to document how to execute this step.' : ''}</p>
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
