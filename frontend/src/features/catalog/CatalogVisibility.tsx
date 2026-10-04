import { Select } from '../../shared/ui/Select';
import type { Filters } from './api';

export function CatalogVisibility({
  filters,
  onChange,
}: {
  filters: Filters;
  onChange: (filters: Filters) => void;
}) {
  return (
    <Select
      label="Стан товарів"
      selectedKey={filters.visibility || 'active'}
      options={[
        { id: 'active', label: 'Активні товари' },
        { id: 'hidden', label: 'Приховані товари' },
      ]}
      onSelectionChange={(key) =>
        onChange({ ...filters, visibility: key === 'hidden' ? 'hidden' : 'active', page: 1 })
      }
    />
  );
}
