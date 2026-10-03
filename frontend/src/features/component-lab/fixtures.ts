import type { Choice } from '../../shared/ui/Select';

// Synthetic fixtures only: stories never fetch customer data or mutate the CRM.
export const products: Choice[] = [
  { id: 'americano', label: 'Американо' },
  { id: 'espresso', label: 'Еспресо' },
  { id: 'water', label: 'Миргородська негазована 1,5 л' },
  {
    id: 'long',
    label: 'Шоколад молочний із цілими лісовими горіхами та карамеллю, подарункова упаковка 250 г',
  },
];
/** Synthetic catalogue with invented barcodes for server-search stories. */
export const searchableProducts: (Choice & { barcode: string })[] = [
  { id: 'milk-chocolate', label: 'Шоколад Солодкий край молочний 90 г', barcode: '4820000000017' },
  { id: 'dark-chocolate', label: 'Шоколад Солодкий край чорний 90 г', barcode: '4820000000024' },
  { id: 'water', label: 'Вода мінеральна негазована 0,5 л', barcode: '4820000000031' },
  { id: 'americano', label: 'Американо', barcode: '' },
];
export const fonts: Choice[] = [
  { id: 'sans-serif', label: 'Без засічок' },
  { id: 'serif', label: 'Із засічками' },
  { id: 'monospace', label: 'Моноширинний' },
];
