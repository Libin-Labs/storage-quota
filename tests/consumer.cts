import { createStorageQuota, QuotaError } from '@lp-labs/storage-quota';
const quota = createStorageQuota(100);
const plan = quota.planAdmission({ id: 'x', bytes: 1, priority: 0 });
const error = new QuotaError('capacity', 'full');
void [quota.commit(plan), error];
