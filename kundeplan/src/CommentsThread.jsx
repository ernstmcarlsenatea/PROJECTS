import { useEffect, useMemo, useState } from 'react';
import { createCommentsStore } from './firebaseStore.js';
import { FEATURE_FLAGS } from './featureFlags.js';

function formatTime(date) {
  if (!date) return 'just now';
  try {
    return date.toLocaleString();
  } catch {
    return '';
  }
}

// Reusable comment thread bound to a (planId, entityType, entityId) tuple.
// Hidden entirely when FEATURE_FLAGS.comments is off.
export function CommentsThread({
  planId,
  entityType,
  entityId,
  callerEmail,
  callerDisplayName,
  isAdmin = false,
  canComment = false,
  onAuditEvent,
}) {
  const store = useMemo(() => createCommentsStore(), []);
  const [comments, setComments] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editingDraft, setEditingDraft] = useState('');

  useEffect(() => {
    if (!FEATURE_FLAGS.comments || !store.enabled || !entityId) {
      setLoaded(true);
      setComments([]);
      return undefined;
    }
    const unsub = store.subscribeThread(
      { planId, entityType, entityId },
      (items) => {
        setComments(items);
        setLoaded(true);
      },
      (err) => {
        console.warn('Comments subscription failed:', err);
        setError(err?.message ?? String(err));
        setLoaded(true);
      },
    );
    return () => {
      if (typeof unsub === 'function') unsub();
    };
  }, [store, planId, entityType, entityId]);

  if (!FEATURE_FLAGS.comments) return null;
  if (!store.enabled) {
    return (
      <section className="comments-thread">
        <header className="comments-header">
          <span className="panel-kicker">Comments</span>
        </header>
        <p className="comments-note">Firebase is not configured — comments unavailable.</p>
      </section>
    );
  }

  async function handleSubmit(event) {
    event?.preventDefault?.();
    if (!canComment) return;
    const body = draft.trim();
    if (!body) return;
    setBusy(true);
    setError(null);
    try {
      await store.addComment({
        planId,
        entityType,
        entityId,
        body,
        author: { email: callerEmail, displayName: callerDisplayName ?? '' },
      });
      if (typeof onAuditEvent === 'function') {
        onAuditEvent(
          'comment.add',
          `Added comment on ${entityType} ${entityId}`,
          { planId, entityType, entityId, length: body.length },
        );
      }
      setDraft('');
    } catch (err) {
      console.error('Add comment failed:', err);
      setError(err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  }

  function startEdit(comment) {
    setEditingId(comment.id);
    setEditingDraft(comment.body);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditingDraft('');
  }

  async function saveEdit(comment) {
    const body = editingDraft.trim();
    if (!body) return;
    setBusy(true);
    setError(null);
    try {
      await store.updateComment(comment.id, { body });
      if (typeof onAuditEvent === 'function') {
        onAuditEvent(
          'comment.edit',
          `Edited comment on ${entityType} ${entityId}`,
          { planId, entityType, entityId, commentId: comment.id },
        );
      }
      cancelEdit();
    } catch (err) {
      console.error('Edit comment failed:', err);
      setError(err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(comment) {
    if (!window.confirm('Delete this comment? This cannot be undone.')) return;
    setBusy(true);
    setError(null);
    try {
      await store.deleteComment(comment.id);
      if (typeof onAuditEvent === 'function') {
        onAuditEvent(
          'comment.delete',
          `Deleted comment on ${entityType} ${entityId}`,
          { planId, entityType, entityId, commentId: comment.id, author: comment.author?.email ?? '' },
        );
      }
    } catch (err) {
      console.error('Delete comment failed:', err);
      setError(err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  }

  const sortedComments = comments; // already sorted by store subscription

  return (
    <section className="comments-thread">
      <header className="comments-header">
        <span className="panel-kicker">Comments</span>
        <span className="comments-count">{sortedComments.length}</span>
      </header>

      {!loaded ? (
        <p className="comments-note">Loading comments…</p>
      ) : sortedComments.length === 0 ? (
        <p className="comments-empty">No comments yet.</p>
      ) : (
        <ul className="comments-list">
          {sortedComments.map((c) => {
            const isAuthor = callerEmail && c.author?.email === callerEmail;
            const canEditThis = isAuthor;
            const canDeleteThis = isAdmin || isAuthor;
            const isEditing = editingId === c.id;
            return (
              <li key={c.id} className="comment-row">
                <div className="comment-meta">
                  <span className="comment-author">
                    {c.author?.displayName ? `${c.author.displayName} · ` : ''}
                    <span className="comment-author-email">{c.author?.email ?? 'unknown'}</span>
                  </span>
                  <span className="comment-time" title={c.createdAt?.toISOString?.() ?? ''}>
                    {formatTime(c.createdAt)}
                    {c.editedAt ? <span className="comment-edited" title={c.editedAt.toISOString()}> · edited</span> : null}
                  </span>
                </div>
                {isEditing ? (
                  <div className="comment-editor">
                    <textarea
                      rows={3}
                      value={editingDraft}
                      onChange={(e) => setEditingDraft(e.target.value)}
                      maxLength={4000}
                      disabled={busy}
                    />
                    <div className="comment-editor-actions">
                      <button type="button" className="primary-button" onClick={() => saveEdit(c)} disabled={busy || !editingDraft.trim()}>
                        {busy ? 'Saving…' : 'Save'}
                      </button>
                      <button type="button" className="secondary-button" onClick={cancelEdit} disabled={busy}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <p className="comment-body">{c.body}</p>
                )}
                {(canEditThis || canDeleteThis) && !isEditing ? (
                  <div className="comment-actions">
                    {canEditThis ? (
                      <button type="button" className="comment-action" onClick={() => startEdit(c)} disabled={busy}>Edit</button>
                    ) : null}
                    {canDeleteThis ? (
                      <button type="button" className="comment-action comment-action-danger" onClick={() => handleDelete(c)} disabled={busy}>Delete</button>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {canComment ? (
        <form className="comments-composer" onSubmit={handleSubmit}>
          <textarea
            rows={2}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Write a comment…"
            maxLength={4000}
            disabled={busy}
          />
          <button type="submit" className="primary-button" disabled={busy || !draft.trim()}>
            {busy ? 'Posting…' : 'Post comment'}
          </button>
        </form>
      ) : null}

      {error ? <p className="comments-error">{error}</p> : null}
    </section>
  );
}
