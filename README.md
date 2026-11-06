# @lp-labs/storage-quota

Plan storage admission using caller-provided byte estimates and priority tiers. Eviction plans are
deterministic, inspectable, and committed explicitly; the package never deletes real stored data.

- Zero runtime and peer dependencies; ESM, CommonJS, and TypeScript declarations.
- Pinned entries and higher-priority entries are protected from lower-priority admissions.
- No browser storage integration, filesystem access, compression, or automatic eviction.
- [MIT](./LICENSE). Node.js 18+.

## Installation

```sh
npm install @lp-labs/storage-quota
```

## Quickstart

```js
import { createStorageQuota, estimateJsonBytes } from '@lp-labs/storage-quota';

const quota = createStorageQuota(1024, [{ id: 'draft', bytes: 700, priority: 1, lastUsed: 10 }]);
const plan = quota.planAdmission({
  id: 'checkpoint',
  bytes: estimateJsonBytes({ progress: 50 }),
  priority: 5,
});
if (plan.accepted) {
  quota.commit(plan);
}
console.log(quota.snapshot().available);
```

CommonJS: `const { createStorageQuota, estimateJsonBytes } = require('@lp-labs/storage-quota')`.
The commit updates only the in-memory quota model; perform any required external deletions in
application-owned storage code before committing.

## API and capacity behavior

`createStorageQuota(capacityBytes, initialEntries?, { maxEntries? })` accepts non-negative safe
integer capacity, bytes, priorities (0..1,000,000), and timestamps. `maxEntries` defaults to 10,000.
An entry has `{ id, bytes, priority, pinned?, lastUsed? }`; IDs contain 1..128 characters.

`planAdmission(candidate)` returns `{ accepted, requiredBytes, evictIds, remainingBytes, revision,
reason? }` without changing state. `requiredBytes` is the minimum byte shortfall after planned
evictions (for an entry-count limit it is zero). Candidate entries can replace an existing ID, but
replacing a pinned entry must keep it pinned. Victims are
unpinned entries of priority no greater than the candidate, ordered by ascending priority, oldest
`lastUsed`, then ID. If pinned/high-priority content prevents admission, `accepted` is false and
`reason` explains the limit. `commit(plan)` accepts only a plan from this manager, at its current
revision. It atomically updates the in-memory index or throws `QuotaError` (`stale-plan`,
`foreign-plan`, or `capacity`). A successful commit increments the revision. `remove(id)` and
`snapshot()` support explicit accounting.

`estimateJsonBytes(value, maxBytes?)` measures UTF-8 bytes of `JSON.stringify` output and defaults
to a 10 MB limit. This is only an estimate for serialized JSON; browser quota accounting, metadata,
compression, encryption, and provider overhead differ.

## Customization and limitations

Define your own stable byte estimator, priority policy, and deletion workflow. Execute external
deletions carefully: a plan is advisory until commit and this in-memory manager cannot make deletion
from IndexedDB/localStorage/filesystems atomic with its own index. If deletions fail, reconcile the
index with actual storage. Capacity is caller-declared and is not queried or enforced against a
browser or operating system.

## Support

If this library is useful to you, consider supporting its maintenance with a [donation via PayPal](https://www.paypal.me/LibinPrasanth).

## Author

Created by [Libin Prasanth](https://www.linkedin.com/in/libinprasanth/). Connect on LinkedIn for updates and discussion.
