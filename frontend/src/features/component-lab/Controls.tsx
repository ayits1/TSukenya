import { useState } from 'react';
import { Button } from '../../shared/ui/Button';
import { TextField } from '../../shared/ui/TextField';
import { Select } from '../../shared/ui/Select';
import { ComboBox } from '../../shared/ui/ComboBox';
import { products, fonts } from './fixtures';

export function Controls() {
  const [selected, setSelected] = useState<string | null>('americano');
  return (
    <section className="tk-stack" aria-label="Контроли конструктора">
      <ComboBox
        label="Товар для перегляду"
        options={products}
        selectedKey={selected}
        onSelectionChange={(key) => setSelected(key === null ? null : String(key))}
        description="Оберіть зі списку або введіть назву."
      />
      <div className="tk-controls-grid">
        <Select label="Шрифт" options={fonts} defaultSelectedKey="sans-serif" />
        <TextField label="Розмір, pt" defaultValue="30" inputMode="decimal" />
      </div>
      <Button variant="primary">Зберегти макет</Button>
      <output aria-live="polite">
        Вибрано: {products.find((p) => p.id === selected)?.label || '—'}
      </output>
    </section>
  );
}
