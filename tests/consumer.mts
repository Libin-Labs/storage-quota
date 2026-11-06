import { createStorageQuota, estimateJsonBytes, type QuotaPlan } from '@lp-labs/storage-quota';
const quota = createStorageQuota(1024);
const plan: QuotaPlan = quota.planAdmission({
  id: 'item',
  bytes: estimateJsonBytes({ x: 1 }),
  priority: 1,
});
if (plan.accepted) quota.commit(plan);
const used: number = quota.snapshot().used;
void used;
