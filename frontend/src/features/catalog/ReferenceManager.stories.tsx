import { fixtureReferenceDirectory } from './referenceDirectoryFixtures';
import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, fn, userEvent, within, waitFor } from 'storybook/test';
import { ApiError } from '../../shared/api/client';
import { ReferenceManager } from './ReferenceManager';
import type {
  ManagedReference,
  ReferenceManagementApi,
  ReferenceImpact,
  ReferenceMutation,
} from './referenceManagementApi';
import './catalog.css';
const items: ManagedReference[] = [
  {
    id: 'source',
    field: 'type',
    value: 'Напої',
    parentType: '',
    parentId: null,
    mergedInto: null,
    state: 'active',
    revision: 'a'.repeat(64),
  },
  {
    id: 'target',
    field: 'type',
    value: 'Подарункові набори із довгою назвою',
    parentType: '',
    parentId: null,
    mergedInto: null,
    state: 'active',
    revision: 'b'.repeat(64),
  },
  {
    id: 'archive',
    field: 'type',
    value: 'Архівна група',
    parentType: '',
    parentId: null,
    mergedInto: null,
    state: 'archived',
    revision: 'c'.repeat(64),
  },
];
const reviewed = (request: ReferenceMutation): ReferenceImpact => ({
  snapshot: 'd'.repeat(64),
  operation: request.operation,
  source: items.find((item) => item.id === request.sourceId)!,
  target: request.targetId ? items.find((item) => item.id === request.targetId)! : null,
  productCount: request.operation === 'archive' ? 0 : 2,
  usageCount: 2,
  referenceCount: 3,
  coalescedCount: request.operation === 'merge' ? 1 : 0,
  coalescedCategories:
    request.operation === 'merge'
      ? [
          {
            sourceId: 'cat_source',
            targetId: 'cat_target',
            value: 'Кава з довгою назвою категорії',
          },
        ]
      : [],
  examples:
    request.operation === 'archive'
      ? []
      : [{ id: 'coffee', name: 'Кава без цукру, контрольний товар' }],
  blocked: [],
  blockedCount: 0,
  warnings: ['Історичні назви й одиниці в облікових рядках та партіях залишаться незмінними.'],
});
const directory = fixtureReferenceDirectory(async () => ({ items, canEdit: true }));
const api: ReferenceManagementApi = {
  directory,
  list: directory.page,
  preview: fn(async (request) => reviewed(request)),
  commit: fn(async (request) => ({ ...reviewed(request), ok: true as const })),
};
const meta = {
  title: 'Catalogue/Reference Management',
  component: ReferenceManager,
  args: { api, onClose: fn(), onChanged: fn() },
  render: function Render(args) {
    const [client] = useState(() => new QueryClient());
    return (
      <QueryClientProvider client={client}>
        <ReferenceManager {...args} />
      </QueryClientProvider>
    );
  },
} satisfies Meta<typeof ReferenceManager>;
export default meta;
type Story = StoryObj<typeof meta>;
const ui = () => within(within(document.body).getByRole('dialog'));
const select = async (label: string, name: string) => {
  const picker = ui().queryByRole('combobox', { name: new RegExp(label) });
  await userEvent.click(picker || ui().getByRole('button', { name: new RegExp(label) }));
  await userEvent.click(within(document.body).getByRole('option', { name }));
};
const source = async () => {
  await waitFor(() =>
    expect(ui().getByRole('combobox', { name: /Запис довідника/ })).toBeEnabled(),
  );
  await select('Запис довідника', 'Напої');
};
const impact = async () => {
  await userEvent.click(ui().getByRole('button', { name: 'Переглянути вплив' }));
  await waitFor(() =>
    expect(ui().getByRole('heading', { name: 'Перевірений вплив' })).toHaveFocus(),
  );
};
export const RenameKeyboard: Story = {
  play: async ({ args }) => {
    await source();
    await userEvent.clear(ui().getByRole('textbox', { name: 'Нова назва' }));
    await userEvent.type(ui().getByRole('textbox', { name: 'Нова назва' }), 'Гарячі напої');
    const button = ui().getByRole('button', { name: 'Переглянути вплив' });
    button.focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() =>
      expect(ui().getByRole('heading', { name: 'Перевірений вплив' })).toHaveFocus(),
    );
    await expect(args.api!.commit).not.toHaveBeenCalled();
    const confirm = ui().getByRole('button', { name: 'Підтвердити зміну довідника' });
    confirm.focus();
    await userEvent.keyboard(' ');
    await waitFor(() => expect(args.onChanged).toHaveBeenCalled());
    await expect(args.api!.commit).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: 'source',
        revision: items[0]!.revision,
        value: 'Гарячі напої',
        snapshot: 'd'.repeat(64),
        idempotencyKey: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f-]{27}$/),
      }),
    );
  },
};
export const ExplicitMerge: Story = {
  play: async () => {
    await source();
    await select('Дія', 'Об’єднати');
    await expect(ui().getByRole('button', { name: 'Переглянути вплив' })).toBeDisabled();
    await select('Цільова група', items[1]!.value);
    await impact();
    await expect(
      ui().getByText('Кава з довгою назвою категорії → Подарункові набори із довгою назвою'),
    ).toBeVisible();
  },
};
export const ArchiveAndRestore: Story = {
  play: async () => {
    await source();
    await select('Дія', 'Архівувати');
    await impact();
    await expect(
      ui().getByText(
        'Архівований запис зникне з нового вибору. Наявні значення товарів залишаться читабельними.',
      ),
    ).toBeVisible();
    await select('Стан записів', 'Архівований');
    await select('Запис довідника', 'Архівна група');
    await expect(ui().queryByRole('heading', { name: 'Перевірений вплив' })).toBeNull();
    await impact();
    await expect(ui().getByText('Відновити: Архівна група')).toBeVisible();
  },
};
export const BlockedUnit: Story = {
  args: {
    api: {
      ...api,
      preview: async (request) => ({
        ...reviewed(request),
        blockedCount: 1,
        blocked: ['Товар уже використовується в облікових документах. Створіть окремий товар.'],
      }),
    },
  },
  play: async () => {
    await source();
    await impact();
    await expect(ui().getByRole('button', { name: 'Підтвердити зміну довідника' })).toBeDisabled();
    await expect(ui().getByText('Жодна зміна не буде збережена.')).toBeVisible();
  },
};
export const StaleSnapshotKeepsInput: Story = {
  args: {
    api: {
      ...api,
      commit: async () => {
        throw new ApiError(409, 'Вплив уже змінився.', 'snapshot_conflict');
      },
    },
  },
  play: async () => {
    await source();
    await userEvent.clear(ui().getByRole('textbox', { name: 'Нова назва' }));
    await userEvent.type(ui().getByRole('textbox', { name: 'Нова назва' }), 'Моя нова назва');
    await impact();
    await userEvent.click(ui().getByRole('button', { name: 'Підтвердити зміну довідника' }));
    await waitFor(() =>
      expect(ui().getByRole('alert')).toHaveTextContent('Перегляньте вплив знову.'),
    );
    await expect(ui().getByRole('textbox', { name: 'Нова назва' })).toHaveValue('Моя нова назва');
    await expect(ui().queryByRole('heading', { name: 'Перевірений вплив' })).toBeNull();
  },
};
export const ReadOnly: Story = {
  args: {
    api: {
      ...api,
      list: async (query, page) => ({ ...(await directory.page(query, page)), canEdit: false }),
    },
  },
  play: async () => {
    await source();
    await expect(ui().getByText('Вашій ролі доступний перегляд довідників.')).toBeVisible();
    await expect(ui().queryByRole('button', { name: 'Переглянути вплив' })).toBeNull();
  },
};
export const ExactRetry: Story = {
  render: function Render(args) {
    const [services] = useState(() => {
      let first = true;
      const calls: unknown[] = [];
      return {
        client: new QueryClient(),
        api: {
          ...api,
          commit: async (request) => {
            calls.push(request);
            if (first) {
              first = false;
              throw new ApiError(0, 'З’єднання перервано.');
            }
            expect(calls[0]).toEqual(calls[1]);
            return { ...reviewed(request), ok: true as const };
          },
        } satisfies ReferenceManagementApi,
      };
    });
    return (
      <QueryClientProvider client={services.client}>
        <ReferenceManager {...args} api={services.api} />
      </QueryClientProvider>
    );
  },
  play: async () => {
    await source();
    await impact();
    await userEvent.click(ui().getByRole('button', { name: 'Підтвердити зміну довідника' }));
    await waitFor(() =>
      expect(ui().getByRole('button', { name: 'Повторити підтвердження' })).toBeEnabled(),
    );
    await userEvent.click(ui().getByRole('button', { name: 'Повторити підтвердження' }));
    await waitFor(() =>
      expect(ui().getByRole('status')).toHaveTextContent('Зміну довідника збережено.'),
    );
  },
};
export const LatePreview: Story = {
  render: function Render(args) {
    const [services] = useState(() => {
      let release: () => void = () => {};
      let started = false;
      return {
        client: new QueryClient(),
        get started() {
          return started;
        },
        release: () => release(),
        api: {
          ...api,
          preview: async (request) => {
            if (request.value === 'Затриманий') {
              started = true;
              await new Promise<void>((resolve) => {
                release = resolve;
              });
            }
            return reviewed(request);
          },
        } satisfies ReferenceManagementApi,
      };
    });
    return (
      <QueryClientProvider client={services.client}>
        <ReferenceManager {...args} api={services.api} />
        <button data-release-preview onClick={() => services.release()}>
          Завершити старий preview
        </button>
      </QueryClientProvider>
    );
  },
  play: async () => {
    await source();
    const name = ui().getByRole('textbox', { name: 'Нова назва' });
    await userEvent.clear(name);
    await userEvent.type(name, 'Затриманий');
    await userEvent.click(ui().getByRole('button', { name: 'Переглянути вплив' }));
    await userEvent.clear(name);
    await userEvent.type(name, 'Актуальний');
    await impact();
    within(document.body).getByRole('button', { name: 'Завершити старий preview' }).click();
    await expect(ui().getByText('Перейменувати: Напої').parentElement).toHaveTextContent(
      '→ Актуальний',
    );
    await userEvent.clear(name);
    await expect(ui().queryByRole('heading', { name: 'Перевірений вплив' })).toBeNull();
  },
};
