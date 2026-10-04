import type { CustomerPage, CustomerProfile } from './api';
export const customerProfile: CustomerProfile = {
  customer: {
    id: 1,
    name: 'Олена Коваленко',
    phone: '+380 99 123 45 67',
    email: 'olena@example.invalid',
    notes: 'Самовивіз у суботу. Лише синтетичні дані.',
    active: true,
  },
  scope: { store: 1, today: '2026-10-04', basis: 'current' },
  purchases: {
    checks: 2,
    gross: '50.00',
    returned: '10.00',
    net: '40.00',
    averageCheck: '25.00',
    first: '2026-09-30',
    last: '2026-10-04',
    segment: 'repeat',
  },
  debt: {
    outstanding: '62.00',
    overdue: '55.00',
    documents: 2,
    overdueDocuments: 1,
    unknownDueDocuments: 0,
  },
  canEdit: true,
};
export const customerPage: CustomerPage = {
  items: [customerProfile.customer],
  total: 1,
  page: 1,
  pages: 1,
  canEdit: true,
};
