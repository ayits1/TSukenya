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
export const fonts: Choice[] = [
  { id: 'sans-serif', label: 'Без засічок' },
  { id: 'serif', label: 'Із засічками' },
  { id: 'monospace', label: 'Моноширинний' },
];
