export type DesignWorkflowSyncStatus =
  | 'up_to_date'
  | 'updated_automatically'
  | 'update_needed'
  | 'sync_failed'
  | 'pinned';

export type DesignWorkflowRevisionClassification = 'compatible' | 'structural';

export interface DesignWorkflowRevision {
  id: string;
  designSystemId: string;
  sourceProjectId: string;
  sha: string;
  shortSha: string;
  branch: string | null;
  classification: DesignWorkflowRevisionClassification;
  changedPaths: string[];
  runId: string | null;
  createdAt: number;
}

export interface DesignWorkflowSubscription {
  projectId: string;
  designSystemId: string;
  sourceProjectId: string;
  status: DesignWorkflowSyncStatus;
  targetSha: string;
  appliedSha: string;
  pinnedSha: string | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export type DesignWorkflowDeliveryAdapter = 'core-ui' | 'wordpress-draft';
export type DesignWorkflowDeliveryStatus = 'ready_for_approval' | 'approving' | 'failed' | 'deployed';

export interface DesignWorkflowDelivery {
  id: string;
  projectId: string;
  adapter: DesignWorkflowDeliveryAdapter;
  revisionSha: string;
  implementationDigest: string;
  status: DesignWorkflowDeliveryStatus;
  previewUrl: string | null;
  target: Record<string, unknown>;
  checkpointPath: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

export interface DesignWorkflowStatusResponse {
  projectId: string;
  role: 'source' | 'subscriber';
  designSystemId: string;
  sourceProjectId: string;
  status: DesignWorkflowSyncStatus;
  currentRevision: DesignWorkflowRevision;
  subscription: DesignWorkflowSubscription | null;
  subscriberCount: number;
  delivery: DesignWorkflowDelivery | null;
}

export interface DesignWorkflowUpdateAllResponse {
  designSystemId: string;
  sourceProjectId: string;
  subscriptions: DesignWorkflowSubscription[];
}

export interface DesignWorkflowRollbackRequest {
  sha: string;
}

export interface DesignWorkflowApproveRequest {
  deliveryId: string;
  implementationDigest: string;
}
