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
import type { DesignWorkflowStatusResponse, DesignWorkflowSyncStatus } from '@open-design/contracts';
import { useT } from '../i18n';
import {
  fetchDesignWorkflowStatus,
  publishDesignWorkflowRevision,
  resumeDesignWorkflow,
  rollbackDesignWorkflow,
  updateAllDesignWorkflowProjects,
} from '../providers/registry';
import { Icon } from './Icon';
import styles from './DesignWorkflowDialog.module.css';

interface Props {
  projectId: string;
  onClose: () => void;
}

const STATUS_KEYS: Record<DesignWorkflowSyncStatus, string> = {
  up_to_date: 'designWorkflow.status.upToDate',
  updated_automatically: 'designWorkflow.status.updatedAutomatically',
  update_needed: 'designWorkflow.status.updateNeeded',
  sync_failed: 'designWorkflow.status.syncFailed',
  pinned: 'designWorkflow.status.pinned',
};

export function DesignWorkflowDialog({ projectId, onClose }: Props) {
  const t = useT();
  const titleId = useId();
  const [status, setStatus] = useState<DesignWorkflowStatusResponse | null>(null);
  const [revision, setRevision] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      setStatus(await fetchDesignWorkflowStatus(projectId));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, [projectId]);

  async function act(action: 'resume' | 'rollback' | 'update-all' | 'publish') {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (action === 'resume') setStatus(await resumeDesignWorkflow(projectId));
      if (action === 'rollback') setStatus(await rollbackDesignWorkflow(projectId, revision.trim()));
      if (action === 'publish') setStatus(await publishDesignWorkflowRevision(projectId));
      if (action === 'update-all') {
        const result = await updateAllDesignWorkflowProjects(projectId);
        setNotice(t('designWorkflow.updateAllResult', { n: result.subscriptions.length }));
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  const dialog = (
    <Dialog className={styles.dialog} layout="sectioned" onClose={onClose} closeOnEscape ariaLabelledBy={titleId}>
      <DialogHeader>
        <div className={styles.titleRow}>
          <div>
            <DialogTitle id={titleId}>{t('designWorkflow.title')}</DialogTitle>
            <DialogDescription>{t('designWorkflow.description')}</DialogDescription>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label={t('common.close')}>
            <Icon name="close" size={14} />
          </Button>
        </div>
      </DialogHeader>
      <DialogBody className={styles.body}>
        {loading ? <div className={styles.state}><Icon name="spinner" size={15} /> {t('designWorkflow.loading')}</div> : null}
        {error ? <div className={styles.error}>{error}</div> : null}
        {notice ? <div className={styles.notice}>{notice}</div> : null}
        {status ? (
          <>
            <div className={`${styles.status} ${styles[status.status]}`}>
              <span>{t(STATUS_KEYS[status.status] as never)}</span>
              <code>{status.currentRevision.shortSha}</code>
            </div>
            <dl className={styles.details}>
              <div><dt>{t('designWorkflow.role')}</dt><dd>{status.role}</dd></div>
              <div><dt>{t('designWorkflow.system')}</dt><dd>{status.designSystemId}</dd></div>
              <div><dt>{t('designWorkflow.subscribers')}</dt><dd>{status.subscriberCount}</dd></div>
              {status.subscription ? (
                <>
                  <div><dt>{t('designWorkflow.applied')}</dt><dd><code>{status.subscription.appliedSha.slice(0, 8)}</code></dd></div>
                  <div><dt>{t('designWorkflow.target')}</dt><dd><code>{status.subscription.targetSha.slice(0, 8)}</code></dd></div>
                </>
              ) : null}
            </dl>
            {status.status === 'update_needed' ? <p className={styles.callout}>{t('designWorkflow.updateHint')}</p> : null}
            {status.delivery ? (
              <div className={styles.delivery}>
                <div>
                  <strong>{t('common.preview')}</strong>
                  <span>{status.delivery.adapter} · {status.delivery.status}</span>
                </div>
                <code title={status.delivery.implementationDigest}>{status.delivery.implementationDigest.slice(0, 12)}</code>
                {status.delivery.previewUrl ? (
                  <a href={status.delivery.previewUrl} target="_blank" rel="noreferrer">{status.delivery.previewUrl}</a>
                ) : null}
                {status.delivery.error ? <p className={styles.error}>{status.delivery.error}</p> : null}
              </div>
            ) : null}
            {status.role === 'subscriber' ? (
              <div className={styles.rollback}>
                <Input value={revision} onChange={(event) => setRevision(event.target.value)} placeholder={t('designWorkflow.revisionPlaceholder')} />
                <Button variant="ghost" disabled={busy || !revision.trim()} onClick={() => void act('rollback')}>{t('designWorkflow.rollback')}</Button>
              </div>
            ) : null}
          </>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={() => void refresh()} disabled={busy}><Icon name="refresh" size={13} /> {t('designWorkflow.refresh')}</Button>
        {status?.status === 'pinned' ? <Button variant="primary" onClick={() => void act('resume')} disabled={busy}>{t('designWorkflow.resume')}</Button> : null}
        {status?.role === 'source' ? <Button variant="ghost" onClick={() => void act('update-all')} disabled={busy}>{t('designWorkflow.updateAll')}</Button> : null}
        {status?.role === 'source' ? <Button variant="primary" onClick={() => void act('publish')} disabled={busy}>{t('designWorkflow.publish')}</Button> : null}
        <Button variant="ghost" onClick={onClose}>{t('common.close')}</Button>
      </DialogFooter>
    </Dialog>
  );
  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body);
}
