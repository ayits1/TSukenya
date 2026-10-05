import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from 'react-aria-components';
import { syncShiftStatus, disposeShiftStatus } from './shared/native/shiftStatus';
import { DirectoryComboBox } from './features/trading/DirectoryComboBox';
import {
  createTradingApi,
  type DirectoryItem,
  type DirectoryQuery,
  type DirectoryRef,
  type DirectoryType,
} from './features/trading/api';
import './shared/ui/controls.css';
const api = createTradingApi();
const cache = new Map<string, DirectoryItem>();
const controls = new Map<
  HTMLSelectElement,
  {
    root: Root;
    host: HTMLElement;
    render: () => void;
    search: (text: string) => void;
    controller: AbortController | undefined;
  }
>();
const resources: DirectoryType[] = [
  'stores',
  'warehouses',
  'accounts',
  'employees',
  'parties',
  'products',
  'expense_categories',
  'cash_shifts',
];
const key = (type: DirectoryType, id: string, store: number | null = null) =>
  `${type}:${id}:${type === 'products' ? store || 0 : ''}`;
function remember(type: DirectoryType, items: DirectoryItem[], store: number | null = null) {
  for (const item of items) {
    const id = key(type, item.id, store);
    cache.delete(id);
    cache.set(id, item);
  }
  // Page/selected metadata only; this cache is never a choice universe or money summary.
  while (cache.size > 1200) {
    const first = cache.keys().next().value;
    if (first) cache.delete(first);
    else break;
  }
}
const get = (type: DirectoryType, id: string | number, store: number | null = null) =>
  cache.get(key(type, String(id), store)) || null;
async function hydrate(
  refs: DirectoryRef[],
  query: Pick<DirectoryQuery, 'store' | 'purpose'> = {},
  signal?: AbortSignal,
) {
  const unique = [
    ...new Map(refs.filter((ref) => ref.id).map((ref) => [ref.type + ':' + ref.id, ref])).values(),
  ];
  const items: (DirectoryItem & { type: DirectoryType })[] = [];
  const unavailable: DirectoryRef[] = [];
  for (let offset = 0; offset < unique.length; offset += 200) {
    const page = await api.details(unique.slice(offset, offset + 200), query, signal);
    for (const item of page.items) remember(item.type, [item], query.store);
    for (const ref of page.unavailable) cache.delete(key(ref.type, ref.id, query.store));
    items.push(...page.items);
    unavailable.push(...page.unavailable);
  }
  return { items, unavailable };
}
type SelectedJob = {
  ref: DirectoryRef;
  signal: AbortSignal;
  resolve: (item: DirectoryItem | null) => void;
  reject: (error: unknown) => void;
};
const selectedQueue = new Map<
  string,
  { query: Pick<DirectoryQuery, 'store' | 'purpose'>; jobs: SelectedJob[] }
>();
function selectedDetail(
  ref: DirectoryRef,
  query: Pick<DirectoryQuery, 'store' | 'purpose'>,
  signal: AbortSignal,
): Promise<DirectoryItem | null> {
  return new Promise((resolve, reject) => {
    const id = JSON.stringify(query),
      existing = selectedQueue.get(id);
    if (existing) {
      existing.jobs.push({ ref, signal, resolve, reject });
      return;
    }
    const batch = { query, jobs: [{ ref, signal, resolve, reject }] };
    selectedQueue.set(id, batch);
    queueMicrotask(() => {
      selectedQueue.delete(id);
      const controller = new AbortController();
      const abort = () => {
        if (batch.jobs.every((job) => job.signal.aborted)) controller.abort();
      };
      batch.jobs.forEach((job) => job.signal.addEventListener('abort', abort, { once: true }));
      abort();
      void hydrate(
        batch.jobs.map((job) => job.ref),
        query,
        controller.signal,
      )
        .then((result) => {
          for (const job of batch.jobs)
            if (!job.signal.aborted)
              job.resolve(
                result.items.find((item) => item.type === job.ref.type && item.id === job.ref.id) ||
                  null,
              );
        })
        .catch((error) => {
          batch.jobs.forEach((job) => {
            if (!job.signal.aborted) job.reject(error);
          });
        })
        .finally(() => batch.jobs.forEach((job) => job.signal.removeEventListener('abort', abort)));
    });
  });
}
function descriptor(select: HTMLSelectElement): DirectoryType | null {
  if (
    select.dataset.directoryType &&
    resources.includes(select.dataset.directoryType as DirectoryType)
  )
    return select.dataset.directoryType as DirectoryType;
  if (
    select.dataset.line === 'product' ||
    select.dataset.recipe === 'product' ||
    select.dataset.component === 'product'
  )
    return 'products';
  if (select.dataset.payment === 'account') return 'accounts';
  const name = select.name.replace(/Display$/, '');
  return (
    (
      {
        store: 'stores',
        filterStore: 'stores',
        warehouse: 'warehouses',
        stockWarehouse: 'warehouses',
        assortmentWarehouse: 'warehouses',
        target: 'warehouses',
        account: 'accounts',
        target_account: 'accounts',
        employee: 'employees',
        party: 'parties',
        category_id: 'expense_categories',
        product: 'products',
        shift: 'cash_shifts',
      } as Record<string, DirectoryType>
    )[name] || null
  );
}
function queryFor(input: HTMLSelectElement, type: DirectoryType): DirectoryQuery {
  const form = input.form,
    container = form || input.closest<HTMLElement>('[data-directory-purpose]');
  const purpose =
    container?.dataset.directoryPurpose ||
    (form?.id === 'recipeVersionForm'
      ? 'recipe'
      : form?.id === 'tradeRecipeForm'
        ? 'legacy_recipe'
        : form?.id === 'tradeWorkForm'
          ? 'work_shift'
          : 'filter');
  const storeControl = form?.elements.namedItem('store') || form?.elements.namedItem('filterStore');
  const store =
    storeControl instanceof HTMLInputElement || storeControl instanceof HTMLSelectElement
      ? Number(storeControl.value) || null
      : Number(input.closest<HTMLElement>('[data-directory-store]')?.dataset.directoryStore) ||
        null;
  const target = ['target', 'target_account'].includes(input.name);
  const result: DirectoryQuery = { purpose };
  if (store && !target && type !== 'stores' && type !== 'parties' && type !== 'expense_categories')
    result.store = store;
  if (
    type === 'products' &&
    (purpose === 'recipe' || purpose === 'legacy_recipe') &&
    input.name !== 'product'
  ) {
    const output = form?.elements.namedItem('product');
    if (output instanceof HTMLInputElement && output.value) result.exclude = output.value;
  }
  if (type === 'employees' && purpose === 'shift_open') {
    const account = form?.elements.namedItem('account');
    const selected = account instanceof HTMLInputElement ? get('accounts', account.value) : null;
    if (selected?.store_id) result.store = selected.store_id;
  }
  return result;
}
function mount(select: HTMLSelectElement, type: DirectoryType) {
  const parent = select.parentElement;
  if (!parent) return;
  const label =
    select.getAttribute('aria-label') ||
    [...parent.childNodes]
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent || '')
      .join(' ')
      .trim() ||
    'Запис довідника';
  const input = select;
  input.hidden = true;
  input.dataset.directoryMounted = 'true';
  input.dataset.directoryType = type;
  input.dataset.directoryRequired = String(select.required);
  input.required = false;
  const host = document.createElement('div');
  host.className = 'tk-root trade-directory-host';
  // React Aria owns the label. A native outer label must not contain a nested label.
  if (parent.tagName === 'LABEL') {
    const field = document.createElement('div');
    field.className = parent.className;
    field.classList.add('trade-directory-field');
    for (const attr of parent.attributes)
      if (attr.name !== 'class') field.setAttribute(attr.name, attr.value);
    for (const child of [...parent.childNodes])
      if (child.nodeType !== Node.TEXT_NODE) field.append(child);
    parent.replaceWith(field);
  }
  select.after(host);
  host.addEventListener('focusin', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.getAttribute('role') !== 'combobox') return;
    const dialog = host.closest('dialog'),
      footer = dialog?.querySelector('.trade-dialog-foot');
    if (!dialog || !footer) return;
    const rect = target.getBoundingClientRect(),
      bottom = footer.getBoundingClientRect().top;
    // Native sticky actions must not cover the input when keyboard/programmatic focus opens a menu.
    if (rect.bottom + 8 > bottom || rect.top < dialog.getBoundingClientRect().top + 8)
      target.scrollIntoView({ block: 'center' });
  });
  const root = createRoot(host);
  let externalSearch: { id: number; text: string } | undefined;
  let selected: DirectoryItem | null = null,
    context = '',
    failed = false;
  const control = {
    root,
    host,
    render,
    search(text: string) {
      externalSearch = { id: (externalSearch?.id || 0) + 1, text };
      render();
      focus(input);
    },
    controller: undefined as AbortController | undefined,
  };
  controls.set(input, control);
  function render() {
    if (!input.isConnected) return;
    const query = queryFor(input, type),
      signature = JSON.stringify([input.value, query]);
    if (signature !== context) {
      context = signature;
      failed = false;
      selected = get(type, input.value, query.store);
      control.controller?.abort();
      const controller = new AbortController();
      control.controller = controller;
      if (input.value)
        void selectedDetail(
          { type, id: input.value },
          {
            ...(query.store ? { store: query.store } : {}),
            ...(query.purpose ? { purpose: query.purpose } : {}),
          },
          controller.signal,
        )
          .then((result) => {
            if (controller.signal.aborted || !input.isConnected || context !== signature) return;
            selected = result;
            failed = !selected;
            draw();
          })
          .catch((error) => {
            if (!controller.signal.aborted) {
              failed = true;
              draw();
              console.warn(
                'Не вдалося прочитати вибраний довідник',
                error instanceof Error ? error.message : '',
              );
            }
          });
    }
    draw();
    function draw() {
      const pinned =
        selected ||
        (input.value
          ? {
              id: input.value,
              name: failed
                ? 'Вибраний запис недоступний · ' + input.value
                : 'Завантажуємо вибраний запис…',
            }
          : null);
      root.render(
        <I18nProvider locale="uk-UA">
          <DirectoryComboBox
            {...(host.closest('dialog') ? { portalContainer: host.closest('dialog')! } : {})}
            {...(externalSearch ? { externalSearch } : {})}
            api={api}
            type={type}
            query={query}
            label={label}
            emptyLabel={
              Array.from(input.options)
                .find((option) => option.value === '')
                ?.text.trim() || ''
            }
            value={input.value}
            selected={pinned}
            disabled={input.matches(':disabled') || (!!input.value && !selected && !failed)}
            required={input.dataset.directoryRequired === 'true'}
            onItems={(items) => remember(type, items, query.store)}
            onCommit={(item) => {
              selected = item;
              failed = false;
              if (item && !Array.from(input.options).some((option) => option.value === item.id)) {
                const option = new Option(item.name, item.id);
                input.append(option);
              }
              input.value = item?.id || '';
              if (item) remember(type, [item], query.store);
              input.dispatchEvent(new Event('change', { bubbles: true }));
              sync(input.form || document);
            }}
          />
          {failed ? (
            <p className="tk-error" role="alert">
              Вибраний запис не прочитано. Пошук дозволяє вибрати інший; поточний ID і решта
              чернетки збережені.
              <button
                className="tk-button tk-button--secondary"
                type="button"
                onClick={() => {
                  context = '';
                  render();
                }}
              >
                Повторити читання вибраного
              </button>
            </p>
          ) : null}
        </I18nProvider>,
      );
    }
  }
  render();
}
function scan(container: ParentNode = document) {
  syncShiftStatus(container);
  for (const [input, control] of controls)
    if (!input.isConnected) {
      control.controller?.abort();
      control.root.unmount();
      controls.delete(input);
    }
  container
    .querySelectorAll<HTMLSelectElement>('select:not([data-directory-mounted])')
    .forEach((select) => {
      const type = descriptor(select);
      if (type) mount(select, type);
    });
}
function sync(container: ParentNode = document) {
  scan(container);
  for (const [input, control] of controls)
    if (container === document || (container instanceof Node && container.contains(input)))
      control.render();
}
function dispose(container: Node) {
  disposeShiftStatus(container);
  for (const [input, control] of controls)
    if (container.contains(input)) {
      control.controller?.abort();
      control.root.unmount();
      controls.delete(input);
    }
}
function focus(input: HTMLElement | null) {
  if (input instanceof HTMLSelectElement) {
    if (!controls.has(input) && input.parentElement) scan(input.parentElement);
    const show = () =>
      controls.get(input)?.host.querySelector<HTMLInputElement>('[role=combobox]')?.focus();
    show();
    requestAnimationFrame(() => {
      if (input.isConnected) show();
    });
  } else input?.focus();
}
function setValue(
  input: HTMLInputElement | HTMLSelectElement,
  value: string | number | null | undefined,
) {
  const text = String(value ?? '');
  if (
    input instanceof HTMLSelectElement &&
    text &&
    !Array.from(input.options).some((option) => option.value === text)
  )
    input.append(new Option('Завантажуємо вибраний запис…', text));
  input.value = text;
  if (input.form) sync(input.form);
}

function captions(raw: unknown): DirectoryRef[] {
  const refs: DirectoryRef[] = [];
  const fields: Record<string, DirectoryType> = {
    warehouse_id: 'warehouses',
    target_id: 'warehouses',
    party_id: 'parties',
    store: 'stores',
    store_id: 'stores',
    warehouse: 'warehouses',
    target: 'warehouses',
    account: 'accounts',
    account_id: 'accounts',
    target_account: 'accounts',
    employee: 'employees',
    employee_id: 'employees',
    party: 'parties',
    category_id: 'expense_categories',
  };
  function visit(value: unknown) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    for (const [name, item] of Object.entries(value)) {
      if (
        fields[name] &&
        ((typeof item === 'number' && Number.isSafeInteger(item) && item > 0) ||
          (typeof item === 'string' &&
            (/^[1-9]\d*$/.test(item) || (name === 'category_id' && /^[a-f0-9-]{36}$/.test(item)))))
      )
        refs.push({ type: fields[name], id: String(item) });
      if (item && typeof item === 'object') visit(item);
    }
  }
  visit(raw);
  return [...new Map(refs.map((ref) => [ref.type + ':' + ref.id, ref])).values()];
}
const observer = new MutationObserver((records) => {
  if (
    records.some(
      (record) =>
        record.type === 'childList' &&
        [...record.addedNodes, ...record.removedNodes].some(
          (node) =>
            node instanceof HTMLElement &&
            (!node.closest('.trade-directory-host') || node.matches('select')),
        ),
    )
  )
    scan();
  for (const record of records)
    if (record.type === 'attributes') {
      if (record.target instanceof HTMLSelectElement) {
        controls.get(record.target)?.render();
        if (record.target.dataset.statusMounted && record.target.parentElement)
          syncShiftStatus(record.target.parentElement);
      } else if (record.target instanceof HTMLFieldSetElement) sync(record.target);
    }
});
observer.observe(document.body, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['disabled'],
});
document.addEventListener('change', (event) => {
  const target = event.target;
  if (
    (target instanceof HTMLInputElement || target instanceof HTMLSelectElement) &&
    ['store', 'filterStore', 'account', 'product'].includes(target.name)
  )
    queueMicrotask(() => sync(target.form || document));
});
document.addEventListener(
  'submit',
  (event) => {
    if (!(event.target instanceof HTMLFormElement)) return;
    for (const [input, control] of controls)
      if (
        input.form === event.target &&
        !input.matches(':disabled') &&
        input.dataset.directoryRequired === 'true' &&
        !input.value
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        control.host.querySelector<HTMLInputElement>('[role=combobox]')?.focus();
        return;
      }
  },
  true,
);
let bootstrapScope = '';
const service = {
  api,
  invalidate: () => cache.clear(),
  bootstrap: async () => {
    const result = await api.bootstrap();
    const next = JSON.stringify([result.role, result.storeId]);
    if (bootstrapScope && bootstrapScope !== next) cache.clear();
    bootstrapScope = next;
    return result;
  },
  get,
  remember,
  hydrate,
  hydrateCaptions: async (value: unknown) => {
    await hydrate(captions(value), { purpose: 'label' });
  },
  scan,
  sync,
  dispose,
  focus,
  setValue,
  search: (input: HTMLSelectElement, text: string) => controls.get(input)?.search(text),
};
declare global {
  interface Window {
    TradeDirectories: typeof service;
  }
}
window.TradeDirectories = service;
window.dispatchEvent(new Event('tsukenya:trading-ready'));
