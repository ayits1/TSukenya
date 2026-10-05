import { Button } from '../../../shared/ui/Button';
import type { useCatalogRecovery } from './session';
export function RecoveryActions({
  recovery,
  onCurrent,
  onExact,
}: {
  recovery: Pick<
    ReturnType<typeof useCatalogRecovery>,
    'error' | 'private' | 'busy' | 'intent' | 'confirmed' | 'prepare' | 'stop'
  >;
  onCurrent: () => void;
  onExact: () => void;
}) {
  return (
    <section className="tk-catalog-recovery" aria-label="Відновлення чернетки">
      {recovery.error ? <p role="alert">{recovery.error}</p> : null}
      {!recovery.private ? (
        <>
          <p>Поля приховані до актуальної перевірки доступу.</p>
          <Button type="button" isDisabled={recovery.busy} onPress={() => void recovery.prepare()}>
            Перевірити доступ до чернетки
          </Button>
          <Button type="button" onPress={recovery.stop}>
            Скасувати перевірку
          </Button>
        </>
      ) : null}
      {recovery.intent ? (
        <>
          <p>Первісна дія збережена. Новіші поля не змінюють цей запит.</p>
          <Button type="button" isDisabled={recovery.busy || !recovery.private} onPress={onExact}>
            Повторити саме первісну дію
          </Button>
        </>
      ) : null}
      {recovery.confirmed ? (
        <>
          <p>Первісний результат підтверджено. Повторне створення не потрібне.</p>
          <Button type="button" isDisabled={recovery.busy} onPress={onCurrent}>
            Прочитати підтверджений запис
          </Button>
        </>
      ) : null}
    </section>
  );
}
