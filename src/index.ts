export interface QuotaEntry {
  readonly id: string;
  readonly bytes: number;
  readonly priority: number;
  readonly pinned?: boolean;
  readonly lastUsed?: number;
}

export interface QuotaOptions {
  readonly maxEntries?: number;
}

export interface QuotaPlan {
  readonly accepted: boolean;
  readonly requiredBytes: number;
  readonly evictIds: readonly string[];
  readonly remainingBytes: number;
  readonly revision: number;
  readonly reason?: 'capacity' | 'protected';
}

export interface QuotaSnapshot {
  readonly capacity: number;
  readonly used: number;
  readonly available: number;
  readonly entries: readonly Readonly<Required<QuotaEntry>>[];
  readonly revision: number;
}

export class QuotaError extends Error {
  constructor(
    readonly code: 'invalid' | 'capacity' | 'stale-plan' | 'foreign-plan',
    message: string,
  ) {
    super(message);
    this.name = 'QuotaError';
  }
}

function integer(value: unknown, name: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum)
    throw new QuotaError(
      'invalid',
      `${name} must be a non-negative safe integer no greater than ${maximum}.`,
    );
  return value as number;
}

function normalize(entry: QuotaEntry): Required<QuotaEntry> {
  if (
    !entry ||
    typeof entry !== 'object' ||
    Array.isArray(entry) ||
    (Object.getPrototypeOf(entry) !== Object.prototype && Object.getPrototypeOf(entry) !== null)
  )
    throw new QuotaError('invalid', 'An entry must be a plain record.');
  const fields: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(entry)) {
    if (typeof key !== 'string' || !['id', 'bytes', 'priority', 'pinned', 'lastUsed'].includes(key))
      throw new QuotaError('invalid', 'Entry contains an unknown or symbol field.');
    const descriptor = Object.getOwnPropertyDescriptor(entry, key);
    if (!descriptor?.enumerable || !('value' in descriptor))
      throw new QuotaError('invalid', 'Entry fields must be enumerable data properties.');
    fields[key] = descriptor.value;
  }
  if (typeof fields.id !== 'string' || fields.id.length < 1 || fields.id.length > 128)
    throw new QuotaError('invalid', 'Entry id must contain 1..128 characters.');
  const bytes = integer(fields.bytes, 'bytes');
  const priority = integer(fields.priority, 'priority', 1_000_000);
  const lastUsed = integer(fields.lastUsed ?? 0, 'lastUsed');
  if (fields.pinned !== undefined && typeof fields.pinned !== 'boolean')
    throw new QuotaError('invalid', 'pinned must be boolean.');
  return Object.freeze({
    id: fields.id,
    bytes,
    priority,
    pinned: (fields.pinned as boolean | undefined) ?? false,
    lastUsed,
  });
}

function validateJson(value: unknown, depth = 0, budget = { nodes: 100_000 }): void {
  budget.nodes--;
  if (budget.nodes < 0 || depth > 64)
    throw new QuotaError('capacity', 'JSON value exceeds the validation limit.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    for (const key of Reflect.ownKeys(value)) {
      if (key === 'length') continue;
      if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)
        throw new QuotaError('invalid', 'JSON arrays cannot have extra properties.');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !('value' in descriptor))
        throw new QuotaError('invalid', 'JSON arrays must be dense data properties.');
    }
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !('value' in descriptor))
        throw new QuotaError('invalid', 'JSON arrays must be dense data properties.');
      validateJson(descriptor.value, depth + 1, budget);
    }
    return;
  }
  if (
    value &&
    typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  ) {
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string')
        throw new QuotaError('invalid', 'JSON records cannot contain symbol keys.');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !('value' in descriptor))
        throw new QuotaError('invalid', 'JSON records must use enumerable data properties.');
      validateJson(descriptor.value, depth + 1, budget);
    }
    return;
  }
  throw new QuotaError('invalid', 'Value cannot be represented as plain JSON.');
}

export function estimateJsonBytes(value: unknown, maxBytes = 10_000_000): number {
  integer(maxBytes, 'maxBytes');
  validateJson(value);
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new QuotaError('invalid', 'Value cannot be represented as JSON.');
  }
  if (encoded === undefined)
    throw new QuotaError('invalid', 'Value cannot be represented as JSON.');
  const size = new TextEncoder().encode(encoded).byteLength;
  if (size > maxBytes) throw new QuotaError('capacity', `Encoded JSON exceeds ${maxBytes} bytes.`);
  return size;
}

export function createStorageQuota(
  capacity: number,
  initial: readonly QuotaEntry[] = [],
  options: QuotaOptions = {},
) {
  const limit = integer(capacity, 'capacity');
  const maxEntries = integer(options.maxEntries ?? 10_000, 'maxEntries', 1_000_000);
  if (maxEntries < 1) throw new RangeError('maxEntries must be at least 1.');
  if (!Array.isArray(initial) || initial.length > maxEntries)
    throw new QuotaError('capacity', `Expected at most ${maxEntries} initial entries.`);
  const entries = new Map<string, Required<QuotaEntry>>();
  for (const raw of initial) {
    const entry = normalize(raw);
    if (entries.has(entry.id)) throw new QuotaError('invalid', `Duplicate entry id: ${entry.id}`);
    entries.set(entry.id, entry);
  }
  const initialUsed = [...entries.values()].reduce((sum, entry) => sum + entry.bytes, 0);
  if (!Number.isSafeInteger(initialUsed) || initialUsed > limit)
    throw new QuotaError('capacity', 'Initial entries exceed the configured capacity.');
  let revision = 0;
  const plans = new WeakMap<object, Required<QuotaEntry>>();
  const snapshot = (): QuotaSnapshot => {
    const used = [...entries.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    return Object.freeze({
      capacity: limit,
      used,
      available: limit - used,
      entries: Object.freeze([...entries.values()].map((entry) => Object.freeze({ ...entry }))),
      revision,
    });
  };

  return Object.freeze({
    snapshot(): QuotaSnapshot {
      return snapshot();
    },
    planAdmission(candidateInput: QuotaEntry): QuotaPlan {
      const candidate = normalize(candidateInput);
      const old = entries.get(candidate.id);
      if (old?.pinned && !candidate.pinned)
        return Object.freeze({
          accepted: false,
          requiredBytes: 0,
          evictIds: Object.freeze([]),
          remainingBytes:
            limit - [...entries.values()].reduce((sum, entry) => sum + entry.bytes, 0),
          revision,
          reason: 'protected' as const,
        });
      if (!old && entries.size >= maxEntries)
        return Object.freeze({
          accepted: false,
          requiredBytes: candidate.bytes,
          evictIds: Object.freeze([]),
          remainingBytes:
            limit - [...entries.values()].reduce((sum, entry) => sum + entry.bytes, 0),
          revision,
          reason: 'capacity',
        });
      if (candidate.bytes > limit)
        return Object.freeze({
          accepted: false,
          requiredBytes: candidate.bytes - limit,
          evictIds: Object.freeze([]),
          remainingBytes:
            limit - [...entries.values()].reduce((sum, entry) => sum + entry.bytes, 0),
          revision,
          reason: 'capacity',
        });
      let projected =
        [...entries.values()].reduce((sum, entry) => sum + entry.bytes, 0) - (old?.bytes ?? 0);
      const evictable = [...entries.values()]
        .filter(
          (entry) =>
            entry.id !== candidate.id && !entry.pinned && entry.priority <= candidate.priority,
        )
        .sort(
          (a, b) => a.priority - b.priority || a.lastUsed - b.lastUsed || a.id.localeCompare(b.id),
        );
      const evictIds: string[] = [];
      for (const entry of evictable) {
        if (projected + candidate.bytes <= limit) break;
        projected -= entry.bytes;
        evictIds.push(entry.id);
      }
      const accepted = projected + candidate.bytes <= limit;
      const plan: QuotaPlan = Object.freeze({
        accepted,
        requiredBytes: Math.max(0, projected + candidate.bytes - limit),
        evictIds: Object.freeze(evictIds),
        remainingBytes: limit - projected - (accepted ? candidate.bytes : 0),
        revision,
        ...(!accepted
          ? { reason: evictable.length === 0 ? ('protected' as const) : ('capacity' as const) }
          : {}),
      });
      plans.set(plan, candidate);
      return plan;
    },
    commit(plan: QuotaPlan): QuotaSnapshot {
      if (!plan || typeof plan !== 'object' || !plans.has(plan))
        throw new QuotaError(
          'foreign-plan',
          'Commit requires a plan created by this quota manager.',
        );
      if (plan.revision !== revision)
        throw new QuotaError('stale-plan', 'Quota changed after the plan was created.');
      const candidate = plans.get(plan)!;
      if (!plan.accepted) throw new QuotaError('capacity', `Admission rejected (${plan.reason}).`);
      for (const id of plan.evictIds) entries.delete(id);
      entries.set(candidate.id, candidate);
      revision++;
      return snapshot();
    },
    remove(id: string): boolean {
      if (typeof id !== 'string' || id.length < 1 || id.length > 128)
        throw new QuotaError('invalid', 'id must contain 1..128 characters.');
      const removed = entries.delete(id);
      if (removed) revision++;
      return removed;
    },
  });
}
