# Порожній вибір у довідниках · 04.10.2026

## Контракт

`DirectoryComboBox.emptyLabel` — підпис порожнього **необов’язкового** вибору. Native adapter бере його з `<option value="">`; React-аналітика клієнтів передає «Усі магазини» тим самим компонентом. Це placeholder, а не `inputValue`, пошуковий `q` чи штучний ID. Для обов’язкового вибору залишається «Оберіть або знайдіть запис…» та пояснення про підтвердження зі списку. Якщо запис уже вибрано, очищення лише пошукового тексту показує «Знайдіть запис…»: committed ID залишається до явного очищення або іншого вибору.

Правка не змінює серверні фільтри, scope, проведення, paging чи мережеві контракти. Одна реалізація працює для native довідників магазину, складу, контрагента й працівника та прямого React-виклику. Сторінкових CSS-виправлень немає.

## Цільові докази

- TypeScript, ESLint і Prettier змінених чотирьох TSX-файлів — PASS; Vite build — PASS.
- `DirectoryComboBox.stories.tsx`: п’ять сценаріїв пройшли перший запуск; `OptionalEmpty` спершу натискав Enter до завершення завантаження, після очікування готового footer повторено лише цей сценарій — PASS. Разом підтверджено всі шість станів, включно з `RequiredEmpty`. Для відтворення потрібних історій: `npm run test:components --workspace frontend -- src/features/trading/DirectoryComboBox.stories.tsx`.
- `PYTHON_BIN=/tmp/tsukenya-review-venv/bin/python node tests/directory-empty-ui.cjs` — PASS. Власна SQLite, локальний сервер і Chrome: реальний native adapter, порожні підписи чотирьох довідників, обов’язковий вибір, keyboard search/cancel/commit/clear, ID без підміни, запити без caption у `q`, відсутність бізнес-записів та browser errors. Тестова форма зупиняє лише bubbling change до stock page, щоб чужий обробник не видаляв fixture; native select, adapter, details/list API і React-компонент справжні.
- Переглянуто PNG на 320/1440 px. Нема горизонтального overflow, popup у viewport, стрілка по центру, поля й кнопки не менші за 44 px.

Артефакти завершеного запуску: `proof.json`, `optional-empty-320.png`, `optional-empty-1440.png` у `/var/folders/9_/xkms65w90g57nhx8n9bhp6300000gn/T/tsukenya-directory-empty-RgW9j2/`.

Базова гілка `b49212a`; новий пакет не змінює раніше доставлені звіти. Повну регресію, Linux PNG baselines, WebKit, перевірку скринрідером і розгортання не виконували; успішні незмінені перевірки повторно не запускали.

## Незалежне інтеграційне рев’ю

Root source review і перегляд author PNG320/1440 — PASS. Пакет інтегровано поверх accepted #62;
combined TypeScript/Vite build PASS. Новий harness фіксує test Django settings/secret, прибирає inherited
DB/PG/URL/require connection variables, перевіряє ранній server exit та очікує завершення власного сервера.
Повторено лише цей affected native integration: PASS, артефакти
`/var/folders/9_/xkms65w90g57nhx8n9bhp6300000gn/T/tsukenya-directory-empty-uzwLnc/`.
Author six Storybook states та незмінні keyboard/layout assertions перевикористані; broad regression
не повторювалася. Новий native harness зареєстровано один раз у explicit full runner.

Перед PR перебазовано на accepted #63 (8470b35), registry/entry збережено аддитивно.
Legacy API/loader/CSS не змінюють inputs targeted directory proof, тому повтор його успіху не потрібен.
