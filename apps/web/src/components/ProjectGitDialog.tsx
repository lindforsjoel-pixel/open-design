import { useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Button,
  Dialog,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
} from '@open-design/components';
import type { ProjectGitStatusResponse } from '@open-design/contracts';
import { useT } from '../i18n';
import {
  commitProjectGitChanges,
  fetchProjectGitStatus,
  initializeProjectGit,
} from '../providers/registry';
import { Icon } from './Icon';
import styles from './ProjectGitDialog.module.css';

interface Props {
  projectId: string;
  onClose: () => void;
}

export function ProjectGitDialog({ projectId, onClose }: Props) {
  const t = useT();
  const titleId = useId();
  const [status, setStatus] = useState<ProjectGitStatusResponse | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const next = await fetchProjectGitStatus(projectId);
      setStatus(next);
      const availablePaths = new Set(next.changes.map((change) => change.path));
      setSelected((current) => new Set([...current].filter((path) => availablePaths.has(path))));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, [projectId]);

  async function initialize() {
    setBusy(true);
    setError(null);
    try {
      setStatus(await initializeProjectGit(projectId));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!message.trim() || selected.size === 0) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await commitProjectGitChanges(projectId, {
        message: message.trim(),
        paths: [...selected],
      });
      setStatus(result.status);
      setSelected(new Set());
      setMessage('');
      setNotice(t('designFiles.git.committed', { hash: result.commit.shortHash }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  function togglePath(path: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  const selectableChanges = status?.changes.filter((change) => !change.conflicted) ?? [];
  const allSelected = selectableChanges.length > 0
    && selectableChanges.every((change) => selected.has(change.path));
  const branchLabel = status?.branch ?? (status?.detached ? t('designFiles.git.detached') : 'HEAD');

  const dialog = (
    <Dialog
      className={styles.dialog}
      layout="sectioned"
      onClose={onClose}
      closeOnEscape
      ariaLabelledBy={titleId}
      data-testid="project-git-dialog"
    >
      <DialogHeader className={styles.header}>
        <div className={styles.titleRow}>
          <div>
            <DialogTitle id={titleId}>{t('designFiles.git.title')}</DialogTitle>
            <DialogDescription>{t('designFiles.git.description')}</DialogDescription>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label={t('common.close')}
          >
            <Icon name="close" size={14} />
          </Button>
        </div>
      </DialogHeader>
      <DialogBody className={styles.body}>
        {loading ? (
          <div className={styles.state}><Icon name="spinner" size={16} /> {t('designFiles.git.loading')}</div>
        ) : error && !status ? (
          <div className={styles.error}>{error}</div>
        ) : status && !status.available ? (
          <div className={styles.state}>{status.error ?? t('designFiles.git.unavailable')}</div>
        ) : status && !status.repository ? (
          <div className={styles.emptyState}>
            <Icon name="fork" size={24} />
            <strong>{t('designFiles.git.notRepository')}</strong>
            <span>{t('designFiles.git.initializeDescription')}</span>
            <Button variant="primary" onClick={() => void initialize()} disabled={busy}>
              {busy ? <Icon name="spinner" size={13} /> : <Icon name="fork" size={13} />}
              {t('designFiles.git.initialize')}
            </Button>
          </div>
        ) : status ? (
          <>
            <div className={styles.repositoryBar}>
              <span className={styles.branch}><Icon name="fork" size={13} /> {branchLabel}</span>
              {status.upstream ? (
                <span className={styles.tracking}>
                  {status.upstream} · +{status.ahead}/−{status.behind}
                </span>
              ) : null}
              <Button variant="ghost" size="icon" onClick={() => void refresh()} aria-label={t('designFiles.git.refresh')}>
                <Icon name="refresh" size={13} />
              </Button>
            </div>

            {notice ? <div className={styles.notice}>{notice}</div> : null}
            {error ? <div className={styles.error}>{error}</div> : null}

            {status.clean ? (
              <div className={styles.cleanState}>
                <Icon name="check" size={18} />
                <span>{t('designFiles.git.clean')}</span>
              </div>
            ) : (
              <div className={styles.changeSection}>
                <div className={styles.changeHeader}>
                  <strong>{t('designFiles.git.changes', { n: status.changes.length })}</strong>
                  <button
                    type="button"
                    className={styles.selectAll}
                    onClick={() => setSelected(allSelected
                      ? new Set()
                      : new Set(selectableChanges.map((change) => change.path)))}
                  >
                    {allSelected ? t('designFiles.git.clearSelection') : t('designFiles.git.selectAll')}
                  </button>
                </div>
                <div className={styles.changeList}>
                  {status.changes.map((change) => (
                    <label className={styles.changeRow} key={change.path}>
                      <input
                        type="checkbox"
                        aria-label={change.path}
                        checked={selected.has(change.path)}
                        disabled={change.conflicted || busy}
                        onChange={() => togglePath(change.path)}
                      />
                      <code>{`${change.indexStatus}${change.worktreeStatus}`.replaceAll(' ', '·')}</code>
                      <span title={change.path}>{change.path}</span>
                    </label>
                  ))}
                </div>
                {status.truncated ? <p className={styles.helper}>{t('designFiles.git.truncated')}</p> : null}
                <label className={styles.messageField}>
                  <span>{t('designFiles.git.commitMessage')}</span>
                  <Input
                    value={message}
                    maxLength={500}
                    placeholder={t('designFiles.git.commitPlaceholder')}
                    onChange={(event) => setMessage(event.target.value.replace(/[\r\n]/g, ' '))}
                  />
                </label>
              </div>
            )}
          </>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>{t('common.close')}</Button>
        {status?.repository && !status.clean ? (
          <Button
            variant="primary"
            disabled={busy || selected.size === 0 || !message.trim()}
            onClick={() => void commit()}
          >
            {busy ? <Icon name="spinner" size={13} /> : <Icon name="check" size={13} />}
            {t('designFiles.git.commitSelected', { n: selected.size })}
          </Button>
        ) : null}
      </DialogFooter>
    </Dialog>
  );

  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body);
}
