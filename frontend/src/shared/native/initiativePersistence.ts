/** Initiative actions retain their own revisions, receipts and source identities. */
import type { FirstIntent, Json, Payload } from '../recovery/storage';
import type { DraftSession } from '../recovery/session';

export const actions = [
  'create',
  'edit',
  'start',
  'complete',
  'result_edit',
  'cancel',
  'task_create',
  'task_link',
  'task_update',
  'expense_attach',
  'expense_detach',
] as const;
export type Action = (typeof actions)[number];
export type Raw = Record<string, string>;
export type Project = {
  id: string;
  idea: string;
  store: number | null;
  title: string;
  problem: string;
  hypothesis: string;
  responsible: number | null;
  responsibleName: string | null;
  responsibleActive: boolean | null;
  state: 'planned' | 'active' | 'completed' | 'cancelled';
  revision: number;
  plannedBudget: string | null;
  metric: string;
  metricUnit: string;
  targetValue: string | null;
  factValue: string | null;
  resultSummary: string;
  resultDate: string | null;
  cancelReason: string;
};
export type Idea = {
  id: string;
  title: string;
  text: string;
  reaction: 'yes' | 'no' | null;
  revision: string;
  project: string | null;
};
export type Task = {
  kind: 'task';
  id: string;
  title: string;
  status: 'todo' | 'doing' | 'done';
  revision: string;
  linkedHere: boolean;
  available: boolean;
};
export type Expense = {
  kind: 'expense';
  id: number;
  number: string;
  date: string;
  amount: string;
  status: string;
  revision: number;
  store: number;
  category: string;
  linkedHere: boolean;
  available: boolean;
};
export type Source = Task | Expense;
export type Selection = {
  project: string | null;
  idea: string | null;
  task: string | null;
  voucher: number | null;
  store: number | null;
};
export type Context = {
  contract: 'initiative-recovery-context-v1';
  role: 'owner';
  storeId: number | null;
  networkOwner: boolean;
  selection: Selection;
  action: Action;
  project: Project | null;
  idea: Idea | null;
  source: Source | null;
  canWrite: boolean;
  reason: string;
};
export type State = {
  recordId: string;
  key: string;
  action: Action;
  routeProject: string | null;
  ideaId: string;
  original: Project | null;
  originalIdea: Idea | null;
  sourceId: string | number | null;
  source: Source | null;
  review: boolean;
  frozenRaw: Raw | null;
};
export type Receipt = {
  contract: 'initiative-operation-identity-v1';
  confirmed: boolean;
  key: string;
  action: Action;
  routeProject: string | null;
  observedRevision: number | null;
  observedIdeaRevision: string | null;
  project?: string;
  appliedRevision?: number;
};
function fail(): never {
  throw Error('Чернетку проєкту не підтверджено. Первісний запит не змінено.');
}
const object = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : fail();
const exact = (v: Record<string, unknown>, keys: readonly string[]) => {
  if (Object.keys(v).length !== keys.length || keys.some((k) => !Object.hasOwn(v, k))) fail();
};
const text = (v: unknown, max = 8000): string =>
  typeof v === 'string' && v.length <= max ? v : fail();
const bool = (v: unknown): boolean => (typeof v === 'boolean' ? v : fail());
const id = (v: unknown): string =>
  /^[A-Za-z0-9_-]{1,120}$/.test(text(v, 120)) ? String(v) : fail();
const uuid = (v: unknown): string =>
  /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(text(v, 36)) ? String(v) : fail();
const revision = (v: unknown): string => (/^[a-f0-9]{64}$/.test(text(v, 64)) ? String(v) : fail());
const number = (v: unknown): number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v <= 999999999999 ? v : fail();
const nullableNumber = (v: unknown) => (v === null ? null : number(v));
const nullableText = (v: unknown, max = 8000) => (v === null ? null : text(v, max));
const action = (v: unknown): Action =>
  typeof v === 'string' && actions.includes(v as Action) ? (v as Action) : fail();
const json = (v: unknown): Json => JSON.parse(JSON.stringify(v)) as Json;
const same = (a: Record<string, unknown>, b: Record<string, unknown>) =>
  Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((k) => a[k] === b[k]);
const day = (v: unknown): string => {
  const value = text(v, 10);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 10) !== value
  )
    fail();
  return value;
};
function decimal(v: unknown, places = 4, nonnegative = false): string | null {
  if (v === null) return null;
  const value = text(v, 50);
  if (
    !new RegExp('^-?[0-9]+(?:\\.[0-9]{1,' + places + '})?$').test(value) ||
    (nonnegative && value.startsWith('-'))
  )
    fail();
  const [whole, fraction = ''] = value.replace(/^-/, '').split('.');
  if (BigInt(whole + fraction.padEnd(places, '0')) > 999999999999n * 10n ** BigInt(places)) fail();
  return value;
}
const normalizedDecimal = (v: unknown, places = 4, nonnegative = false) =>
  decimal(text(v).trim().replace(',', '.') || null, places, nonnegative);
const selectedNumber = (v: unknown): number | null =>
  v === '' ? null : /^[1-9][0-9]{0,11}$/.test(text(v)) ? number(Number(v)) : fail();
const planKeys = [
  'title',
  'problem',
  'hypothesis',
  'responsible',
  'plannedBudget',
  'metric',
  'metricUnit',
  'targetValue',
];
export function rawKeys(a: Action): string[] {
  if (a === 'create' || a === 'edit') return [...planKeys, ...(a === 'create' ? ['store'] : [])];
  if (a === 'complete' || a === 'result_edit')
    return ['resultSummary', 'resultDate', 'factValue', ...(a === 'result_edit' ? ['reason'] : [])];
  if (a === 'cancel' || a === 'expense_detach') return ['reason'];
  if (a === 'task_create') return ['title', 'phase', 'stage'];
  if (a === 'task_link') return ['phase'];
  if (a === 'task_update') return ['status'];
  return [];
}
export function decodeRaw(value: unknown, a: Action): Raw {
  const v = object(value),
    keys = rawKeys(a);
  exact(v, keys);
  return Object.fromEntries(keys.map((k) => [k, text(v[k])]));
}
const projectKeys = [
  'id',
  'idea',
  'store',
  'title',
  'problem',
  'hypothesis',
  'responsible',
  'responsibleName',
  'responsibleActive',
  'state',
  'revision',
  'plannedBudget',
  'metric',
  'metricUnit',
  'targetValue',
  'factValue',
  'resultSummary',
  'resultDate',
  'cancelReason',
];
export function decodeProject(value: unknown): Project {
  const v = object(value);
  exact(v, projectKeys);
  if (
    typeof v.state !== 'string' ||
    !['planned', 'active', 'completed', 'cancelled'].includes(v.state)
  )
    fail();
  const p: Project = {
    id: uuid(v.id),
    idea: id(v.idea),
    store: nullableNumber(v.store),
    title: text(v.title, 250),
    problem: text(v.problem, 4000),
    hypothesis: text(v.hypothesis, 4000),
    responsible: nullableNumber(v.responsible),
    responsibleName: nullableText(v.responsibleName, 150),
    responsibleActive: v.responsibleActive === null ? null : bool(v.responsibleActive),
    state: v.state as Project['state'],
    revision: number(v.revision),
    plannedBudget: decimal(v.plannedBudget, 2, true),
    metric: text(v.metric, 160),
    metricUnit: text(v.metricUnit, 80),
    targetValue: decimal(v.targetValue),
    factValue: decimal(v.factValue),
    resultSummary: text(v.resultSummary, 4000),
    resultDate: v.resultDate === null ? null : day(v.resultDate),
    cancelReason: text(v.cancelReason, 4000),
  };
  if (
    (p.responsible === null) !== (p.responsibleName === null) ||
    (p.responsible === null) !== (p.responsibleActive === null) ||
    (p.metric && !p.metricUnit) ||
    (p.targetValue !== null && !p.metric)
  )
    fail();
  return p;
}
export function projectTerms(value: unknown): Project {
  const v = object(value);
  return decodeProject(Object.fromEntries(projectKeys.map((k) => [k, v[k]])));
}
export function decodeIdea(value: unknown): Idea {
  const v = object(value);
  exact(v, ['id', 'title', 'text', 'reaction', 'revision', 'project']);
  if (v.reaction !== 'yes' && v.reaction !== 'no' && v.reaction !== null) fail();
  return {
    id: id(v.id),
    title: text(v.title),
    text: text(v.text),
    reaction: v.reaction,
    revision: revision(v.revision),
    project: v.project === null ? null : uuid(v.project),
  };
}
export function decodeSource(value: unknown): Source {
  const v = object(value);
  if (v.kind === 'task') {
    exact(v, ['kind', 'id', 'title', 'status', 'revision', 'linkedHere', 'available']);
    if (v.status !== 'todo' && v.status !== 'doing' && v.status !== 'done') fail();
    return {
      kind: 'task',
      id: id(v.id),
      title: text(v.title, 250),
      status: v.status,
      revision: revision(v.revision),
      linkedHere: bool(v.linkedHere),
      available: bool(v.available),
    };
  }
  if (v.kind !== 'expense') fail();
  exact(v, [
    'kind',
    'id',
    'number',
    'date',
    'amount',
    'status',
    'revision',
    'store',
    'category',
    'linkedHere',
    'available',
  ]);
  if (
    typeof v.status !== 'string' ||
    !['draft', 'posted', 'reversed', 'cancelled'].includes(v.status) ||
    v.number !== String(number(v.id)).padStart(6, '0')
  )
    fail();
  return {
    kind: 'expense',
    id: number(v.id),
    number: text(v.number, 12),
    date: day(v.date),
    amount: decimal(v.amount, 2) ?? fail(),
    status: v.status,
    revision: number(v.revision),
    store: number(v.store),
    category: text(v.category),
    linkedHere: bool(v.linkedHere),
    available: bool(v.available),
  };
}
function decodeSelection(value: unknown): Selection {
  const v = object(value);
  exact(v, ['project', 'idea', 'task', 'voucher', 'store']);
  return {
    project: v.project === null ? null : uuid(v.project),
    idea: v.idea === null ? null : id(v.idea),
    task: v.task === null ? null : id(v.task),
    voucher: nullableNumber(v.voucher),
    store: nullableNumber(v.store),
  };
}
export function selection(s: State, raw: Raw): Selection {
  return {
    project: s.routeProject,
    idea: s.routeProject === null ? s.ideaId : null,
    task: s.action === 'task_link' || s.action === 'task_update' ? id(s.sourceId) : null,
    voucher:
      s.action === 'expense_attach' || s.action === 'expense_detach' ? number(s.sourceId) : null,
    store: s.action === 'create' ? selectedNumber(raw.store) : null,
  };
}
export function query(s: State, raw: Raw): Record<string, string> {
  const selected = selection(s, raw);
  return {
    action: s.action,
    ...Object.fromEntries(
      Object.entries(selected)
        .filter(([k, v]) => v !== null || (k === 'store' && s.action === 'create'))
        .map(([k, v]) => [k, v === null ? '' : String(v)]),
    ),
  };
}
function context(value: unknown, a: Action, expected: Selection): Context {
  const v = object(value);
  exact(v, [
    'contract',
    'role',
    'storeId',
    'networkOwner',
    'selection',
    'action',
    'project',
    'idea',
    'source',
    'canWrite',
    'reason',
  ]);
  const selected = decodeSelection(v.selection);
  if (
    v.contract !== 'initiative-recovery-context-v1' ||
    v.role !== 'owner' ||
    action(v.action) !== a ||
    !same(selected, expected)
  )
    fail();
  const result: Context = {
    contract: 'initiative-recovery-context-v1',
    role: 'owner',
    storeId: nullableNumber(v.storeId),
    networkOwner: bool(v.networkOwner),
    selection: selected,
    action: a,
    project: v.project === null ? null : decodeProject(v.project),
    idea: v.idea === null ? null : decodeIdea(v.idea),
    source: v.source === null ? null : decodeSource(v.source),
    canWrite: bool(v.canWrite),
    reason: text(v.reason),
  };
  if (
    result.networkOwner !== (result.storeId === null) ||
    (a === 'create') !== (result.project === null) ||
    (a === 'create') !== (result.idea !== null) ||
    result.project?.id !== (selected.project ?? undefined) ||
    result.idea?.id !== (selected.idea ?? undefined)
  )
    fail();
  if (
    result.storeId !== null &&
    (result.project ? result.project.store : selected.store) !== result.storeId
  )
    fail();
  if (
    result.source &&
    (result.source.kind === 'task'
      ? result.source.id !== selected.task
      : result.source.id !== selected.voucher)
  )
    fail();
  if (
    (selected.task === null && selected.voucher === null && result.source !== null) ||
    (result.canWrite &&
      (selected.task !== null || selected.voucher !== null) &&
      !result.source?.available)
  )
    fail();
  return result;
}
export function decodeContext(
  value: unknown,
  a: Action,
  expected: Selection,
  session: DraftSession,
): Context {
  const current = context(value, a, expected);
  if (
    session.role !== 'owner' ||
    current.role !== session.role ||
    current.storeId !== session.storeId ||
    current.networkOwner !== session.networkOwner
  )
    fail();
  return current;
}
export async function recordId(project: string | null, idea: string): Promise<string> {
  if (project !== null) return 'initiative_project_' + uuid(project);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(id(idea)));
  return (
    'initiative_idea_' +
    Array.from(new Uint8Array(digest), (v) => v.toString(16).padStart(2, '0')).join('')
  );
}
export function decodeState(value: unknown): State {
  const v = object(value);
  exact(v, [
    'recordId',
    'key',
    'action',
    'routeProject',
    'ideaId',
    'original',
    'originalIdea',
    'sourceId',
    'source',
    'review',
    'frozenRaw',
  ]);
  const a = action(v.action),
    route = v.routeProject === null ? null : uuid(v.routeProject),
    idea = id(v.ideaId);
  const original = v.original === null ? null : decodeProject(v.original),
    originalIdea = v.originalIdea === null ? null : decodeIdea(v.originalIdea),
    source = v.source === null ? null : decodeSource(v.source);
  const sourceId =
    a === 'task_link' || a === 'task_update'
      ? id(v.sourceId)
      : a === 'expense_attach' || a === 'expense_detach'
        ? number(v.sourceId)
        : v.sourceId === null
          ? null
          : fail();
  if (
    (a === 'create') !== (route === null) ||
    (a === 'create') !== (original === null) ||
    (a === 'create') !== (originalIdea !== null) ||
    original?.id !== (route ?? undefined) ||
    (original?.idea ?? originalIdea?.id) !== idea ||
    (source && source.id !== sourceId)
  )
    fail();
  if (
    route
      ? v.recordId !== 'initiative_project_' + route
      : !/^initiative_idea_[a-f0-9]{64}$/.test(text(v.recordId, 80))
  )
    fail();
  return {
    recordId: text(v.recordId, 80),
    key: uuid(v.key),
    action: a,
    routeProject: route,
    ideaId: idea,
    original,
    originalIdea,
    sourceId,
    source,
    review: bool(v.review),
    frozenRaw: v.frozenRaw === null ? null : decodeRaw(v.frozenRaw, a),
  };
}
function required(input: unknown, max = 4000): string {
  const value = text(input, max);
  if (!value.trim() || value.length > max) throw Error('Заповніть обов’язкові поля проєкту.');
  return value;
}
export function requestBody(s: State, raw: Raw): Record<string, Json> {
  const a = s.action,
    body: Record<string, Json> = {
      action: a,
      idempotencyKey: s.key,
      ...(s.routeProject
        ? { revision: s.original?.revision ?? fail() }
        : { idea: s.ideaId, ideaRevision: s.originalIdea?.revision ?? fail() }),
    };
  if (a === 'create' || a === 'edit') {
    Object.assign(body, {
      title: required(raw.title, 250),
      problem: text(raw.problem, 4000),
      hypothesis: text(raw.hypothesis, 4000),
      responsible: selectedNumber(raw.responsible),
      plannedBudget: normalizedDecimal(raw.plannedBudget, 2, true),
      metric: text(raw.metric, 160),
      metricUnit: text(raw.metricUnit, 80),
      targetValue: normalizedDecimal(raw.targetValue),
    });
    if (
      (text(raw.metric).trim() && !text(raw.metricUnit).trim()) ||
      (body.targetValue !== null && !text(raw.metric).trim())
    )
      throw Error('Перевірте показник, його одиницю та ціль.');
    if (a === 'create') body.store = selectedNumber(raw.store);
  } else if (a === 'complete' || a === 'result_edit') {
    Object.assign(body, {
      resultSummary: required(raw.resultSummary),
      resultDate: day(raw.resultDate),
      factValue: normalizedDecimal(raw.factValue),
    });
    if (s.original?.metric ? body.factValue === null : body.factValue !== null)
      throw Error('Перевірте факт для чинного показника проєкту.');
  } else if (a === 'task_create') {
    const stage = selectedNumber(raw.stage);
    if (!stage || stage > 4) throw Error('Виберіть етап від 1 до 4.');
    Object.assign(body, { title: required(raw.title, 250), phase: text(raw.phase, 160), stage });
  } else if (a === 'task_link' || a === 'task_update') {
    if (s.source?.kind !== 'task') fail();
    Object.assign(body, { task: id(s.sourceId), taskRevision: s.source.revision });
    if (a === 'task_link') body.phase = text(raw.phase, 160);
    else {
      if (!['todo', 'doing', 'done'].includes(text(raw.status))) fail();
      body.status = text(raw.status);
    }
  } else if (a === 'expense_attach' || a === 'expense_detach') {
    body.voucher = number(s.sourceId);
    if (a === 'expense_attach') {
      if (s.source?.kind !== 'expense') fail();
      body.voucherRevision = s.source.revision;
    }
  }
  if (a === 'result_edit' || a === 'cancel' || a === 'expense_detach')
    body.reason = required(raw.reason);
  return body;
}
export function freeze(value: unknown): Payload {
  const p = decodePayload(value),
    s = decodeState(p.baseline),
    raw = decodeRaw(p.draft, s.action);
  if (p.firstIntent) return p;
  if (p.confirmation || s.review)
    throw Error('Спершу звірте поточні умови й застосуйте їх локально.');
  s.frozenRaw = raw;
  return decodePayload({
    ...p,
    baseline: json(s),
    firstIntent: {
      method: 'POST',
      path: '/api/erp/initiatives' + (s.routeProject ? '/' + s.routeProject : ''),
      key: s.key,
      body: requestBody(s, raw),
      revision: s.original?.revision ?? s.originalIdea?.revision ?? fail(),
      possiblySent: true,
    },
  });
}
function receipt(value: unknown): Receipt {
  const v = object(value),
    confirmed = bool(v.confirmed);
  exact(v, [
    'contract',
    'confirmed',
    'key',
    'action',
    'routeProject',
    'observedRevision',
    'observedIdeaRevision',
    ...(confirmed ? ['project', 'appliedRevision'] : []),
  ]);
  if (v.contract !== 'initiative-operation-identity-v1') fail();
  return {
    contract: 'initiative-operation-identity-v1',
    confirmed,
    key: uuid(v.key),
    action: action(v.action),
    routeProject: v.routeProject === null ? null : uuid(v.routeProject),
    observedRevision: nullableNumber(v.observedRevision),
    observedIdeaRevision: v.observedIdeaRevision === null ? null : revision(v.observedIdeaRevision),
    ...(confirmed ? { project: uuid(v.project), appliedRevision: number(v.appliedRevision) } : {}),
  };
}
function boundReceipt(r: Receipt, s: State) {
  if (
    r.key !== s.key ||
    r.action !== s.action ||
    r.routeProject !== s.routeProject ||
    r.observedRevision !== (s.original?.revision ?? null) ||
    r.observedIdeaRevision !== (s.originalIdea?.revision ?? null) ||
    (r.confirmed && s.routeProject !== null && r.project !== s.routeProject) ||
    (r.confirmed && r.appliedRevision !== (s.original?.revision ?? 0) + 1)
  )
    fail();
}
export function decodeIdentity(value: unknown, payload: unknown): Receipt {
  const p = decodePayload(payload),
    s = decodeState(p.baseline),
    r = receipt(value);
  if (!p.firstIntent) fail();
  boundReceipt(r, s);
  return r;
}
/** The live response belongs to the guarded frozen request; never adopt its historical fields. */
export function decodeAcknowledgement(value: unknown, payload: unknown): Receipt {
  const v = object(value),
    p = decodePayload(payload),
    s = decodeState(p.baseline);
  exact(v, ['ok', 'project']);
  const acknowledged = projectTerms(v.project);
  if (
    v.ok !== true ||
    !p.firstIntent ||
    acknowledged.idea !== s.ideaId ||
    acknowledged.store !==
      (s.action === 'create' ? selectedNumber(s.frozenRaw?.store) : s.original?.store)
  )
    fail();
  return decodeIdentity(
    {
      contract: 'initiative-operation-identity-v1',
      confirmed: true,
      key: s.key,
      action: s.action,
      routeProject: s.routeProject,
      observedRevision: s.original?.revision ?? null,
      observedIdeaRevision: s.originalIdea?.revision ?? null,
      project: acknowledged.id,
      appliedRevision: acknowledged.revision,
    },
    p,
  );
}
export function decodePayload(value: unknown): Payload {
  const v = object(value);
  exact(v, ['baseline', 'draft', 'firstIntent', 'confirmation']);
  const s = decodeState(v.baseline),
    raw = decodeRaw(v.draft, s.action);
  let first: FirstIntent | null = null,
    confirmation: Json = null;
  if (v.firstIntent !== null) {
    const f = object(v.firstIntent);
    exact(f, ['method', 'path', 'key', 'body', 'revision', 'possiblySent']);
    const body = requestBody(s, s.frozenRaw ?? fail());
    if (
      f.method !== 'POST' ||
      f.path !== '/api/erp/initiatives' + (s.routeProject ? '/' + s.routeProject : '') ||
      f.key !== s.key ||
      f.revision !== (s.original?.revision ?? s.originalIdea?.revision) ||
      f.possiblySent !== true ||
      !same(body, object(f.body))
    )
      fail();
    first = {
      method: 'POST',
      path: String(f.path),
      key: s.key,
      body,
      revision: f.revision as string | number,
      possiblySent: true,
    };
  } else if (s.frozenRaw !== null) fail();
  if (v.confirmation !== null) {
    const confirmed = object(v.confirmation);
    exact(confirmed, ['receipt', 'raw']);
    const r = receipt(confirmed.receipt);
    boundReceipt(r, s);
    if (!r.confirmed || first) fail();
    confirmation = json({ receipt: r, raw: decodeRaw(confirmed.raw, s.action) });
  }
  return { baseline: json(s), draft: raw, firstIntent: first, confirmation };
}
export function metricKey(p: Project | null): string {
  return JSON.stringify(p ? [p.metric, p.metricUnit, p.targetValue] : null);
}
export function confirmPayload(value: unknown, event: unknown): Payload | null {
  const p = decodePayload(value),
    s = decodeState(p.baseline),
    e = object(event);
  if (e.type === 'identity') {
    exact(e, ['type', 'identity', 'draft']);
    const r = decodeIdentity(e.identity, p);
    if (!r.confirmed) fail();
    p.confirmation = json({ receipt: r, raw: s.frozenRaw ?? fail() });
    p.firstIntent = null;
    s.frozenRaw = null;
    s.review = true;
    p.draft = decodeRaw(e.draft, s.action);
  } else if (e.type === 'rejected') {
    exact(e, ['type', 'key', 'action', 'revision', 'status', 'code', 'draft']);
    if (
      !p.firstIntent ||
      s.review ||
      e.key !== s.key ||
      e.action !== s.action ||
      e.revision !== p.firstIntent.revision ||
      !(
        (e.status === 400 && e.code === null) ||
        (e.status === 409 &&
          (e.code === 'revision_conflict' ||
            (s.action === 'create' && e.code === 'initiative_exists')))
      )
    )
      fail();
    p.firstIntent = null;
    s.frozenRaw = null;
    s.review = true;
    p.draft = decodeRaw(e.draft, s.action);
  } else if (e.type === 'apply') {
    exact(e, ['type', 'current', 'draft', 'key', 'metricAccepted']);
    const raw = decodeRaw(e.draft, s.action),
      current = context(e.current, s.action, selection(s, raw));
    if (
      p.firstIntent ||
      !current.canWrite ||
      (current.project && current.project.idea !== s.ideaId) ||
      (!bool(e.metricAccepted) &&
        (s.action === 'complete' || s.action === 'result_edit') &&
        metricKey(s.original) !== metricKey(current.project))
    )
      fail();
    s.original = current.project;
    s.originalIdea = current.idea;
    s.source = current.source;
    s.key = uuid(e.key);
    s.review = false;
    p.confirmation = null;
    p.draft = raw;
  } else if (e.type === 'complete') {
    exact(e, ['type', 'current']);
    context(e.current, s.action, selection(s, decodeRaw(p.draft, s.action)));
    if (!p.confirmation) fail();
    if (same(decodeRaw(object(p.confirmation).raw, s.action), decodeRaw(p.draft, s.action)))
      return null;
    s.review = true;
  } else fail();
  p.baseline = json(s);
  return decodePayload(p);
}
