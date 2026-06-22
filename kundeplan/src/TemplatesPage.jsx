import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { jsPDF } from 'jspdf';
import { createTemplateStore } from './firebaseStore.js';

const STATUS_LABEL = {
  'not-started': 'Not started',
  'in-progress': 'In progress',
  done: 'Done',
  skipped: 'Skipped',
};

function formatTimestamp(value) {
  if (!value) return '—';
  const date =
    typeof value?.toDate === 'function'
      ? value.toDate()
      : value instanceof Date
      ? value
      : typeof value === 'string' || typeof value === 'number'
      ? new Date(value)
      : null;
  if (!date || Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
}

function generateTemplateId() {
  return `tpl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function csvEscape(value) {
  if (value == null) return '';
  const str = String(value);
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function safeFilename(name, fallback = 'template') {
  const base = (name || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return base || fallback;
}

function templateToJson(template) {
  return JSON.stringify(
    {
      id: template.id,
      name: template.name,
      description: template.description,
      createdAt:
        typeof template.createdAt?.toDate === 'function'
          ? template.createdAt.toDate().toISOString()
          : template.createdAt ?? null,
      createdBy: template.createdBy,
      parts: template.parts ?? [],
      runbookConfig: template.runbookConfig ?? {},
    },
    null,
    2,
  );
}

function exportTemplateJson(template) {
  const json = templateToJson(template);
  const blob = new Blob([json], { type: 'application/json' });
  downloadBlob(blob, `${safeFilename(template.name)}.template.json`);
}

function exportTemplateCsv(template) {
  const lines = [];
  lines.push('Section,Field,Value');
  lines.push(`Template,Name,${csvEscape(template.name)}`);
  lines.push(`Template,Description,${csvEscape(template.description)}`);
  lines.push(`Template,Created at,${csvEscape(formatTimestamp(template.createdAt))}`);
  lines.push(`Template,Created by,${csvEscape(template.createdBy)}`);
  lines.push(`Template,Parts count,${csvEscape((template.parts ?? []).length)}`);
  lines.push('');
  lines.push('Parts');
  lines.push(
    [
      'ID',
      'Name',
      'Owner',
      'Residence',
      'Source ID',
      'Dependencies',
    ]
      .map(csvEscape)
      .join(','),
  );
  for (const p of template.parts ?? []) {
    lines.push(
      [
        p.id,
        p.name,
        p.owner ?? '',
        p.residence ?? '',
        p.sourceId ?? '',
        (p.dependencies ?? []).join(' | '),
      ]
        .map(csvEscape)
        .join(','),
    );
  }
  lines.push('');
  lines.push('Runbook config');
  lines.push(['Part ID', 'Status', 'Assignee', 'Due date', 'Notes'].map(csvEscape).join(','));
  const cfg = template.runbookConfig ?? {};
  for (const [partId, step] of Object.entries(cfg)) {
    lines.push(
      [
        partId,
        step?.status ?? '',
        step?.assignee ?? '',
        step?.dueDate ?? '',
        step?.notes ?? '',
      ]
        .map(csvEscape)
        .join(','),
    );
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  downloadBlob(blob, `${safeFilename(template.name)}.template.csv`);
}

function exportTemplatePdf(template) {
  const pdf = new jsPDF({ unit: 'pt', format: 'a4' });
  const margin = 40;
  const pageHeight = pdf.internal.pageSize.getHeight();
  const pageWidth = pdf.internal.pageSize.getWidth();
  const lineHeight = 14;
  let y = margin;

  function ensureSpace(needed) {
    if (y + needed > pageHeight - margin) {
      pdf.addPage();
      y = margin;
    }
  }

  function writeLine(text, opts = {}) {
    const { size = 10, bold = false, indent = 0 } = opts;
    pdf.setFontSize(size);
    pdf.setFont('helvetica', bold ? 'bold' : 'normal');
    const wrap = pdf.splitTextToSize(text, pageWidth - margin * 2 - indent);
    for (const w of wrap) {
      ensureSpace(lineHeight);
      pdf.text(w, margin + indent, y);
      y += lineHeight;
    }
  }

  writeLine(template.name || '(untitled template)', { size: 16, bold: true });
  if (template.description) {
    writeLine(template.description, { size: 10 });
  }
  writeLine(`Created by: ${template.createdBy || '—'}`, { size: 9 });
  writeLine(`Created: ${formatTimestamp(template.createdAt)}`, { size: 9 });
  y += 6;

  writeLine(`Parts (${(template.parts ?? []).length})`, { size: 12, bold: true });
  for (const p of template.parts ?? []) {
    writeLine(`• ${p.name || '(unnamed)'}${p.owner ? ` — ${p.owner}` : ''}`, {
      size: 10,
      indent: 6,
    });
    if (p.residence) writeLine(`Residence: ${p.residence}`, { size: 9, indent: 18 });
    if (p.sourceId) writeLine(`Source: ${p.sourceId}`, { size: 9, indent: 18 });
    if ((p.dependencies ?? []).length > 0) {
      writeLine(`Deps: ${p.dependencies.join(', ')}`, { size: 9, indent: 18 });
    }
  }
  y += 6;

  const cfgEntries = Object.entries(template.runbookConfig ?? {});
  if (cfgEntries.length > 0) {
    writeLine(`Runbook (${cfgEntries.length} configured steps)`, { size: 12, bold: true });
    for (const [partId, step] of cfgEntries) {
      const part = (template.parts ?? []).find((p) => p.id === partId);
      const heading = part ? `${part.name} (${partId})` : partId;
      writeLine(`• ${heading}`, { size: 10, indent: 6 });
      const status = STATUS_LABEL[step?.status] ?? step?.status ?? '—';
      writeLine(`Status: ${status}`, { size: 9, indent: 18 });
      if (step?.assignee) writeLine(`Assignee: ${step.assignee}`, { size: 9, indent: 18 });
      if (step?.dueDate) writeLine(`Due: ${step.dueDate}`, { size: 9, indent: 18 });
      if (step?.notes) writeLine(`Notes: ${step.notes}`, { size: 9, indent: 18 });
    }
  }

  pdf.save(`${safeFilename(template.name)}.template.pdf`);
}

export function TemplatesPage({
  currentParts,
  currentRunbookConfig,
  canManage,
  canApply,
  callerEmail,
  onApplyTemplate,
  onAuditEvent,
}) {
  const store = useMemo(() => createTemplateStore(), []);
  const [templates, setTemplates] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [draftName, setDraftName] = useState('');
  const [draftDescription, setDraftDescription] = useState('');
  const [previewId, setPreviewId] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editingDraft, setEditingDraft] = useState({ name: '', description: '' });
  const importRef = useRef(null);

  useEffect(() => {
    if (!store.enabled) {
      setLoaded(true);
      return undefined;
    }
    const unsub = store.subscribeTemplates(
      (next) => {
        setTemplates(next);
        setLoaded(true);
      },
      (err) => {
        console.error('Template subscription failed:', err);
        setError(err?.message ?? String(err));
        setLoaded(true);
      },
    );
    return () => {
      if (typeof unsub === 'function') unsub();
    };
  }, [store]);

  const sortedTemplates = useMemo(() => {
    return [...templates].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }, [templates]);

  const previewTemplate = useMemo(
    () => sortedTemplates.find((t) => t.id === previewId) ?? null,
    [sortedTemplates, previewId],
  );

  const persist = useCallback(
    async (nextTemplates) => {
      setBusy(true);
      setError(null);
      try {
        await store.saveTemplates(nextTemplates);
      } catch (err) {
        console.error('Failed to save templates:', err);
        setError(err?.message ?? String(err));
        throw err;
      } finally {
        setBusy(false);
      }
    },
    [store],
  );

  const handleSaveCurrent = useCallback(
    async (event) => {
      event.preventDefault();
      const name = draftName.trim();
      if (!name) {
        setError('Template name is required.');
        return;
      }
      const newTemplate = {
        id: generateTemplateId(),
        name,
        description: draftDescription.trim(),
        createdAt: new Date().toISOString(),
        createdBy: callerEmail || '',
        parts: Array.isArray(currentParts) ? currentParts : [],
        runbookConfig: currentRunbookConfig && typeof currentRunbookConfig === 'object' ? currentRunbookConfig : {},
      };
      try {
        await persist([...templates, newTemplate]);
        if (typeof onAuditEvent === 'function') {
          onAuditEvent(
            'template.save',
            `Saved template “${newTemplate.name}” (${(newTemplate.parts ?? []).length} parts, ${Object.keys(newTemplate.runbookConfig ?? {}).length} runbook steps)`,
            { templateId: newTemplate.id, name: newTemplate.name, partsCount: (newTemplate.parts ?? []).length, stepsCount: Object.keys(newTemplate.runbookConfig ?? {}).length },
          );
        }
        setDraftName('');
        setDraftDescription('');
      } catch {
        /* error already set */
      }
    },
    [draftName, draftDescription, callerEmail, currentParts, currentRunbookConfig, persist, templates, onAuditEvent],
  );

  const handleDelete = useCallback(
    async (id) => {
      const target = templates.find((t) => t.id === id);
      if (!target) return;
      const ok = window.confirm(`Delete template "${target.name || '(unnamed)'}"? This cannot be undone.`);
      if (!ok) return;
      try {
        await persist(templates.filter((t) => t.id !== id));
        if (typeof onAuditEvent === 'function') {
          onAuditEvent(
            'template.delete',
            `Deleted template “${target.name || '(unnamed)'}”`,
            { templateId: id, name: target.name || '' },
          );
        }
        if (previewId === id) setPreviewId(null);
        if (editingId === id) setEditingId(null);
      } catch {
        /* error already set */
      }
    },
    [persist, templates, previewId, editingId, onAuditEvent],
  );

  const handleApply = useCallback(
    (template) => {
      const ok = window.confirm(
        `Apply template "${template.name}"?\n\nThis will REPLACE the current blueprint (${(template.parts ?? []).length} parts) and runbook status for everyone.`,
      );
      if (!ok) return;
      if (typeof onApplyTemplate === 'function') {
        onApplyTemplate({
          parts: template.parts ?? [],
          runbookConfig: template.runbookConfig ?? {},
          templateName: template.name,
        });
      }
    },
    [onApplyTemplate],
  );

  const startEdit = useCallback((template) => {
    setEditingId(template.id);
    setEditingDraft({ name: template.name ?? '', description: template.description ?? '' });
  }, []);

  const cancelEdit = useCallback(() => {
    setEditingId(null);
    setEditingDraft({ name: '', description: '' });
  }, []);

  const saveEdit = useCallback(async () => {
    const name = editingDraft.name.trim();
    if (!name) {
      setError('Template name is required.');
      return;
    }
    const previous = templates.find((t) => t.id === editingId) ?? null;
    const next = templates.map((t) =>
      t.id === editingId
        ? { ...t, name, description: editingDraft.description.trim() }
        : t,
    );
    try {
      await persist(next);
      if (typeof onAuditEvent === 'function' && previous) {
        const changes = [];
        if ((previous.name || '') !== name) changes.push(`name “${previous.name || ''}” → “${name}”`);
        if ((previous.description || '') !== editingDraft.description.trim()) changes.push('description updated');
        if (changes.length > 0) {
          onAuditEvent(
            'template.update',
            `Updated template “${name}”: ${changes.join(', ')}`,
            { templateId: editingId, previous: { name: previous.name, description: previous.description }, next: { name, description: editingDraft.description.trim() } },
          );
        }
      }
      cancelEdit();
    } catch {
      /* error already set */
    }
  }, [editingDraft, editingId, persist, templates, cancelEdit, onAuditEvent]);

  const handleImportClick = useCallback(() => {
    if (importRef.current) importRef.current.click();
  }, []);

  const handleImportChange = useCallback(
    async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.parts)) {
          throw new Error('Invalid template file: missing parts array.');
        }
        const imported = {
          id: generateTemplateId(),
          name: (parsed.name || file.name.replace(/\.json$/i, '') || 'Imported template').trim(),
          description: typeof parsed.description === 'string' ? parsed.description : '',
          createdAt: new Date().toISOString(),
          createdBy: callerEmail || '',
          parts: parsed.parts,
          runbookConfig:
            parsed.runbookConfig && typeof parsed.runbookConfig === 'object'
              ? parsed.runbookConfig
              : {},
        };
        await persist([...templates, imported]);
        if (typeof onAuditEvent === 'function') {
          onAuditEvent(
            'template.import',
            `Imported template “${imported.name}” (${(imported.parts ?? []).length} parts)`,
            { templateId: imported.id, name: imported.name, partsCount: (imported.parts ?? []).length },
          );
        }
      } catch (err) {
        console.error('Import failed:', err);
        setError(err?.message ?? String(err));
      } finally {
        if (importRef.current) importRef.current.value = '';
      }
    },
    [callerEmail, persist, templates, onAuditEvent],
  );

  const currentPartsCount = Array.isArray(currentParts) ? currentParts.length : 0;
  const currentRunbookCount = currentRunbookConfig
    ? Object.keys(currentRunbookConfig).length
    : 0;

  return (
    <section className="templates-page">
      <header className="templates-header">
        <div>
          <p className="panel-kicker">Template repository</p>
          <h2>Saved blueprint &amp; runbook templates</h2>
          <p className="templates-intro">
            {canManage
              ? 'Save named snapshots of the current blueprint and runbook configuration so you can reuse them later. Viewers and editors can browse and export every template.'
              : 'Browse and export saved blueprint + runbook templates. Only admins can create, edit, apply, or delete templates.'}
          </p>
        </div>
        {!store.enabled ? (
          <div className="templates-warn">Firebase is not configured — templates require cloud sync.</div>
        ) : null}
      </header>

      {error ? <div className="templates-error">{error}</div> : null}

      {canManage ? (
        <section className="panel templates-save-panel">
          <header className="templates-save-header">
            <h3>Save current state as template</h3>
            <p className="templates-meta">
              Blueprint: <strong>{currentPartsCount}</strong> parts · Runbook:{' '}
              <strong>{currentRunbookCount}</strong> configured steps
            </p>
          </header>
          <form className="templates-save-form" onSubmit={handleSaveCurrent}>
            <label className="templates-field">
              <span>Name</span>
              <input
                type="text"
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                placeholder="e.g. Customer onboarding v1"
                disabled={busy || !store.enabled}
              />
            </label>
            <label className="templates-field templates-field-wide">
              <span>Description</span>
              <input
                type="text"
                value={draftDescription}
                onChange={(e) => setDraftDescription(e.target.value)}
                placeholder="Optional short description"
                disabled={busy || !store.enabled}
              />
            </label>
            <div className="templates-save-actions">
              <button
                type="submit"
                className="primary-button"
                disabled={busy || !store.enabled || !draftName.trim()}
              >
                Save as template
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={handleImportClick}
                disabled={busy || !store.enabled}
              >
                Import from JSON…
              </button>
              <input
                ref={importRef}
                type="file"
                accept="application/json,.json"
                onChange={handleImportChange}
                style={{ display: 'none' }}
              />
            </div>
          </form>
        </section>
      ) : null}

      <section className="panel templates-list-panel">
        <header className="templates-list-header">
          <h3>Templates</h3>
          <p className="templates-meta">
            {loaded ? `${sortedTemplates.length} template${sortedTemplates.length === 1 ? '' : 's'}` : 'Loading…'}
          </p>
        </header>

        {sortedTemplates.length === 0 ? (
          <p className="templates-empty">
            {loaded
              ? 'No templates yet. ' + (canManage ? 'Use the form above to save the first one.' : 'Ask an admin to create one.')
              : 'Loading templates…'}
          </p>
        ) : (
          <ul className="templates-grid">
            {sortedTemplates.map((template) => {
              const isEditing = editingId === template.id;
              const partCount = (template.parts ?? []).length;
              const stepCount = Object.keys(template.runbookConfig ?? {}).length;
              return (
                <li key={template.id} className="template-card">
                  {isEditing ? (
                    <div className="template-edit">
                      <label className="templates-field">
                        <span>Name</span>
                        <input
                          type="text"
                          value={editingDraft.name}
                          onChange={(e) => setEditingDraft((d) => ({ ...d, name: e.target.value }))}
                          disabled={busy}
                        />
                      </label>
                      <label className="templates-field">
                        <span>Description</span>
                        <input
                          type="text"
                          value={editingDraft.description}
                          onChange={(e) => setEditingDraft((d) => ({ ...d, description: e.target.value }))}
                          disabled={busy}
                        />
                      </label>
                      <div className="template-card-actions">
                        <button
                          type="button"
                          className="primary-button"
                          onClick={saveEdit}
                          disabled={busy || !editingDraft.name.trim()}
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={cancelEdit}
                          disabled={busy}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <header className="template-card-header">
                        <h4 className="template-card-title">{template.name || '(unnamed)'}</h4>
                        {template.description ? (
                          <p className="template-card-description">{template.description}</p>
                        ) : null}
                      </header>
                      <dl className="template-card-meta">
                        <div>
                          <dt>Parts</dt>
                          <dd>{partCount}</dd>
                        </div>
                        <div>
                          <dt>Runbook steps</dt>
                          <dd>{stepCount}</dd>
                        </div>
                        <div>
                          <dt>Created</dt>
                          <dd>{formatTimestamp(template.createdAt)}</dd>
                        </div>
                        <div>
                          <dt>By</dt>
                          <dd>{template.createdBy || '—'}</dd>
                        </div>
                      </dl>
                      <div className="template-card-actions">
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() => setPreviewId(template.id)}
                        >
                          Preview
                        </button>
                        <div className="template-card-export">
                          <button type="button" className="secondary-button" onClick={() => exportTemplateJson(template)}>
                            JSON
                          </button>
                          <button type="button" className="secondary-button" onClick={() => exportTemplateCsv(template)}>
                            CSV
                          </button>
                          <button type="button" className="secondary-button" onClick={() => exportTemplatePdf(template)}>
                            PDF
                          </button>
                        </div>
                        {canApply ? (
                          <button
                            type="button"
                            className="primary-button"
                            onClick={() => handleApply(template)}
                            disabled={busy}
                          >
                            Apply
                          </button>
                        ) : null}
                        {canManage ? (
                          <>
                            <button
                              type="button"
                              className="secondary-button"
                              onClick={() => startEdit(template)}
                              disabled={busy}
                            >
                              Rename
                            </button>
                            <button
                              type="button"
                              className="danger-button"
                              onClick={() => handleDelete(template.id)}
                              disabled={busy}
                            >
                              Delete
                            </button>
                          </>
                        ) : null}
                      </div>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {previewTemplate ? (
        <div
          className="template-preview-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Template preview"
          onClick={(e) => {
            if (e.target === e.currentTarget) setPreviewId(null);
          }}
        >
          <div className="template-preview-modal">
            <header className="template-preview-header">
              <div>
                <h3>{previewTemplate.name || '(unnamed)'}</h3>
                {previewTemplate.description ? <p>{previewTemplate.description}</p> : null}
              </div>
              <button
                type="button"
                className="secondary-button"
                onClick={() => setPreviewId(null)}
                aria-label="Close preview"
              >
                Close
              </button>
            </header>
            <div className="template-preview-body">
              <section>
                <h4>Parts ({(previewTemplate.parts ?? []).length})</h4>
                {(previewTemplate.parts ?? []).length === 0 ? (
                  <p className="templates-empty">No parts.</p>
                ) : (
                  <ul className="template-preview-list">
                    {(previewTemplate.parts ?? []).map((p) => (
                      <li key={p.id}>
                        <strong>{p.name || '(unnamed)'}</strong>
                        {p.owner ? <span className="template-preview-meta"> — {p.owner}</span> : null}
                        {(p.dependencies ?? []).length > 0 ? (
                          <span className="template-preview-meta">
                            {' '}· {(p.dependencies ?? []).length} dep
                            {(p.dependencies ?? []).length === 1 ? '' : 's'}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              <section>
                <h4>
                  Runbook config ({Object.keys(previewTemplate.runbookConfig ?? {}).length})
                </h4>
                {Object.keys(previewTemplate.runbookConfig ?? {}).length === 0 ? (
                  <p className="templates-empty">No runbook configuration.</p>
                ) : (
                  <ul className="template-preview-list">
                    {Object.entries(previewTemplate.runbookConfig ?? {}).map(([partId, step]) => {
                      const part = (previewTemplate.parts ?? []).find((p) => p.id === partId);
                      const label = part ? part.name || '(unnamed)' : partId;
                      return (
                        <li key={partId}>
                          <strong>{label}</strong>{' '}
                          <span className="template-preview-meta">
                            — {STATUS_LABEL[step?.status] ?? step?.status ?? 'not set'}
                            {step?.assignee ? `, ${step.assignee}` : ''}
                            {step?.dueDate ? `, due ${step.dueDate}` : ''}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            </div>
            <footer className="template-preview-footer">
              <button type="button" className="secondary-button" onClick={() => exportTemplateJson(previewTemplate)}>
                Export JSON
              </button>
              <button type="button" className="secondary-button" onClick={() => exportTemplateCsv(previewTemplate)}>
                Export CSV
              </button>
              <button type="button" className="secondary-button" onClick={() => exportTemplatePdf(previewTemplate)}>
                Export PDF
              </button>
              {canApply ? (
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => {
                    handleApply(previewTemplate);
                    setPreviewId(null);
                  }}
                >
                  Apply
                </button>
              ) : null}
            </footer>
          </div>
        </div>
      ) : null}
    </section>
  );
}
