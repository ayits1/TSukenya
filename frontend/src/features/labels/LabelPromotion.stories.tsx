import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';
import { Label } from './Label';
import { clippedLabel, defaultConfig } from './domain';
import { studioProducts, studioSettings } from './fixtures';

const meta = {
  title: 'Цінники/Компактна акція',
  component: Label,
  args: {
    config: {
      ...defaultConfig(),
      chain: false,
      store: false,
      category: false,
      date: false,
      pack: false,
      psize: false,
    },
    settings: studioSettings,
    product: {
      ...studioProducts[0]!,
      name: 'Контрольна кава',
      promotion: true,
      regularPrice: 60,
      salePrice: 45,
    },
  },
} satisfies Meta<typeof Label>;
export default meta;
type Story = StoryObj<typeof meta>;
const check: NonNullable<Story['play']> = async ({ canvasElement }) => {
  const label = canvasElement.querySelector<HTMLElement>('.tk-label')!;
  const promo = label.querySelector<HTMLElement>('[data-field=promo]')!;
  const old = label.querySelector<HTMLElement>('[data-field=oldPrice]')!;
  const p = promo.getBoundingClientRect(),
    o = old.getBoundingClientRect();
  await expect(getComputedStyle(old).textDecorationLine).toBe('line-through');
  await expect(p.bottom > o.top && o.bottom > p.top).toBe(true);
  await expect(p.right <= o.left).toBe(true);
  await expect(clippedLabel(label)).toBe(false);
};
export const OneRow: Story = {
  play: async (context) => {
    await check(context);
    const label = context.canvasElement.querySelector('.tk-label')!;
    const meta = label.querySelector('.t-promotion-meta')!.getBoundingClientRect();
    const price = label.querySelector('[data-field=price]')!.getBoundingClientRect();
    await expect(meta.bottom > price.top).toBe(true);
  },
};
export const TwoRows: Story = {
  args: { product: { ...meta.args.product, regularPrice: 1500, salePrice: 1234.5 } },
  play: async (context) => {
    await check(context);
    const label = context.canvasElement.querySelector('.tk-label')!;
    const meta = label.querySelector('.t-promotion-meta')!.getBoundingClientRect();
    const price = label.querySelector('[data-field=price]')!.getBoundingClientRect();
    await expect(price.top >= meta.bottom).toBe(true);
  },
};

export const LongName: Story = {
  args: {
    product: { ...meta.args.product, name: 'Кава мелена арабіка середнього обсмаження' },
  },
  play: check,
};

export const MediumFormat: Story = {
  args: {
    config: { ...meta.args.config, size: 'm' },
    product: { ...meta.args.product, regularPrice: 1500, salePrice: 1234.5 },
  },
  play: check,
};

export const LargeFormat: Story = {
  args: {
    config: { ...meta.args.config, size: 'l' },
    product: { ...meta.args.product, regularPrice: 1500, salePrice: 1234.5 },
  },
  play: check,
};
