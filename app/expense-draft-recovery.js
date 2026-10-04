/* Real legacy expense fields: raw input, row revision and creator receipt stay separate. */
(() => {
  "use strict";
  const NAME = "native-expense-v1",
    rows = new Map(),
    creates = new Map();
  let active = null,
    registered = false,
    opening = 0,
    restoring = null,
    inlineReady = false,
    preparing = false,
    authorizedSession = null,
    openingController = null;
  const f = () => window.NativeDraftRecovery,
    c = () => window.NativeExpensePersistence,
    a = () => window.NativeLegacyEditor;
  const canceled = () => new DOMException("Скасовано", "AbortError");
  const esc = (v) =>
    String(v ?? "").replace(
      /[&<>"']/g,
      (ch) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[ch],
    );
  const state = (p) => c().decodeExpenseState(p.baseline),
    raw = (p) => c().decodeExpenseRaw(p.draft);
  const project = (r) => c().expenseTerms(a().legacyProjection(r));
  const sessionKey = (s) =>
    JSON.stringify([
      s.draftOwner,
      s.draftSession,
      s.role,
      s.storeId,
      s.networkOwner,
    ]);
  const live = (ctx) => active === ctx && ctx.d.open && ctx.d.isConnected;
  async function request(
    path,
    method = "GET",
    body,
    revision,
    signal,
    guard,
    binding,
  ) {
    const gate = () => {
      if (signal?.aborted || (guard && !guard())) throw canceled();
    };
    gate();
    let actor;
    try {
      actor = await window.PortalApi.session(signal);
    } catch (error) {
      gate();
      if ([401, 403].includes(error.status))
        await f()
          .controller.check(false)
          .catch(() => {});
      throw error;
    }
    gate();
    if (binding && sessionKey(binding) !== sessionKey(actor)) {
      await f()
        .controller.check(false)
        .catch(() => {});
      throw canceled();
    }
    gate();
    let response, value;
    try {
      response = await fetch(path, {
        method,
        signal,
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": actor.csrf,
          ...(revision ? { "If-Match": revision } : {}),
          ...(method === "POST" ? { "Idempotency-Key": body.key } : {}),
        },
        body:
          body === undefined
            ? undefined
            : JSON.stringify(method === "POST" ? body.body : body),
      });
    } catch (error) {
      gate();
      throw Object.assign(
        Error(
          "Відповідь не підтверджено. Введення збережено; повторіть лише читання.",
        ),
        { uncertain: method !== "GET" },
      );
    }
    gate();
    if (response.status === 401) {
      window.dispatchEvent(new Event("tsukenya:session-invalidated"));
      location.href = "/";
      throw Object.assign(Error("Сеанс завершено."), { status: 401 });
    }
    try {
      value = await response.json();
    } catch {
      gate();
      throw Object.assign(
        Error("Некоректна відповідь сервера. Повторіть читання."),
        {
          status: response.ok ? undefined : response.status,
          uncertain: method !== "GET",
        },
      );
    }
    gate();
    if (!response.ok)
      throw Object.assign(
        Error(
          typeof value?.error === "string" ? value.error : "Дія недоступна.",
        ),
        {
          status: response.status,
          code: value?.code,
          uncertain: method !== "GET" && response.status >= 500,
        },
      );
    return value;
  }
  async function context(signal, guard) {
    const v = await request(
      "/api/v1/portal/collections/expenses?page=1",
      "GET",
      undefined,
      undefined,
      signal,
      guard,
    );
    return window.PortalApi.decodeCollection(v, "expenses");
  }
  async function current(id, signal, guard) {
    return a().decodeLegacyRecord(
      await request(
        "/api/v1/portal/records/expenses/" + id,
        "GET",
        undefined,
        undefined,
        signal,
        guard,
      ),
      "expenses",
      id,
    );
  }
  async function identity(p, signal, guard) {
    const s = state(p);
    return window.PortalApi.decodeCreateIdentity(
      await request(
        "/api/v1/portal/create-identity?collection=expenses&createKey=" + s.key,
        "GET",
        undefined,
        undefined,
        signal,
        guard,
      ),
      "expenses",
      s.key,
    );
  }
  async function authorize(p, actor, signal) {
    const s = state(p);
    if (actor.role !== "owner" || !actor.networkOwner || actor.storeId !== null)
      return false;
    if (s.id)
      try {
        await current(s.id, signal);
      } catch (error) {
        if (error.code !== "record_missing") throw error;
        await context(signal);
      }
    else await context(signal);
    if (signal.aborted) throw canceled();
    authorizedSession = { recordId: s.recordId, actor };
    return true;
  }
  function savePayload(p) {
    const s = state(p);
    f().store.save(s.recordId, NAME, p);
    if (s.id) rows.set(s.id, p);
    else creates.set(s.original.group, p);
    return p;
  }
  function existing(map, key) {
    const p = map.get(key);
    if (
      p &&
      !f()
        .store.entries()
        .some((e) => e.id === state(p).recordId)
    ) {
      map.delete(key);
      return null;
    }
    return p;
  }
  function make(
    record = null,
    group = "fixed",
    units = ["name", "group", "amount", "category"],
  ) {
    const key = crypto.randomUUID(),
      terms = record
        ? project(record)
        : { name: "", group, amount: "0.00", category: null };
    return c().decodeExpensePayload({
      baseline: {
        recordId: "expense_" + key,
        key,
        id: record?.id || null,
        revision: record?.revision || null,
        original: terms,
        units,
        review: false,
        order: Date.now(),
      },
      draft: { ...terms, category: terms.category || "" },
      firstIntent: null,
      confirmation: null,
    });
  }
  function record(collection, item) {
    return item?.collection === collection && item.data
      ? a().decodeLegacyRecord(item, collection, item.id)
      : window.LegacyEditors.snapshot(collection, item);
  }
  function capture(p, draft, units) {
    const s = state(p);
    return savePayload(
      c().decodeExpensePayload({
        ...p,
        baseline: { ...s, units: [...new Set([...s.units, ...(units || [])])] },
        draft: { ...raw(p), ...draft },
      }),
    );
  }
  function confirm(p, type, target, draft) {
    const s = state(p),
      event = {
        type,
        id: target.id,
        revision: target.revision,
        terms: project(target),
        draft,
      };
    const next = c().confirmExpensePayload(p, event);
    f().store.confirmed(s.recordId, event);
    if (s.id) next ? rows.set(s.id, next) : rows.delete(s.id);
    else
      next
        ? creates.set(s.original.group, next)
        : creates.delete(s.original.group);
    if (type === "apply" && next) {
      rows.set(state(next).id, next);
      creates.delete(s.original.group);
    }
    return next;
  }
  function hide() {
    inlineReady = false;
    const panel = document.querySelector("[data-expense-private]");
    if (panel) {
      panel.hidden = true;
      let gate = panel.previousElementSibling;
      if (!gate?.hasAttribute("data-expense-access")) {
        gate = document.createElement("section");
        gate.dataset.expenseAccess = "";
        gate.innerHTML =
          '<p role="status">Фінансові поля приховано до перевірки доступу.</p><button class="btn soft" type="button">Перевірити доступ до витрат</button>';
        gate.querySelector("button").onclick = () => void prepareInline();
        panel.before(gate);
      }
    }
    if (!active || !live(active)) return;
    const ctx = active;
    ctx.hidden = true;
    ctx.generation++;
    if (!ctx.protected) ctx.stop();
    ctx.d.querySelector(".trade-dialog-body").hidden = true;
    ctx.d.querySelector("#expenseRecoveryTitle").textContent =
      "Локальна чернетка призупинена";
    let gate = ctx.d.querySelector("[data-expense-access]");
    if (!gate) {
      gate = document.createElement("section");
      gate.className = "trade-dialog-body";
      gate.dataset.expenseAccess = "";
      gate.innerHTML =
        '<p role="status">Статтю приховано до підтвердження доступу.</p><button class="btn soft" type="button" data-access-retry>Перевірити доступ до форми</button><button class="btn soft" type="button" data-access-cancel>Скасувати читання</button>';
      gate.querySelector("[data-access-retry]").onclick = () =>
        void f()
          .controller.check()
          .catch(() => {});
      gate.querySelector("[data-access-cancel]").onclick = () => {
        ctx.stop();
        f().controller.dismiss();
      };
      ctx.d.append(gate);
    }
    gate.querySelector("[data-access-retry]").disabled = ctx.protected;
    gate.querySelector("[data-access-cancel]").hidden = !ctx.reading;
  }
  function reveal(ctx) {
    if (!live(ctx)) return;
    ctx.hidden = false;
    ctx.d.querySelector(".trade-dialog-body").hidden = false;
    ctx.d.querySelector("#expenseRecoveryTitle").textContent =
      "Стаття витрат · редагування";
    ctx.d.querySelector("[data-expense-access]")?.remove();
  }
  function register() {
    if (registered || !f() || !c() || !a()) return;
    registered = true;
    f().register({
      name: NAME,
      version: 1,
      label: "Стаття витрат · шаблон мережі",
      decode: c().decodeExpensePayload,
      authorize,
      suspend: hide,
      confirm: c().confirmExpensePayload,
      restore: async (p, signal) => {
        await open({ restored: p, signal });
        if (!signal.aborted) restoring = signal;
      },
    });
    f().controller.subscribe(() => {
      if (f().controller.snapshot().state !== "ready") return;
      if (restoring) {
        const signal = restoring;
        restoring = null;
        queueMicrotask(() => {
          if (!signal.aborted) {
            f().close();
            active?.form
              .querySelector("input:not([disabled]),select:not([disabled])")
              ?.focus();
          }
        });
      }
      const ctx = active;
      if (ctx?.hidden && live(ctx) && !ctx.protected && !ctx.warming) {
        ctx.warming = true;
        if (
          !f()
            .store.entries()
            .some((e) => e.id === state(ctx.p).recordId)
        ) {
          ctx.d.close();
          ctx.warming = false;
          return;
        }
        const pending = f().controller.verify(state(ctx.p).recordId),
          n = ctx.generation;
        void pending
          .then((actor) => {
            if (
              actor &&
              n === ctx.generation &&
              live(ctx) &&
              document.visibilityState !== "hidden"
            )
              reveal(ctx);
          })
          .finally(() => (ctx.warming = false));
      }
    });
  }
  async function prepareInline() {
    register();
    if (!registered || preparing) return;
    const panel = document.querySelector("[data-expense-private]");
    if (!panel || panel.closest("#catalogBudget")?.hidden) return;
    preparing = true;
    const route = location.hash;
    hide();
    try {
      const actor = await f().controller.check(false);
      if (actor.role !== "owner" || !actor.networkOwner)
        throw Object.assign(Error("Недостатньо прав."), { status: 403 });
      await context(
        undefined,
        () =>
          route === location.hash &&
          panel.isConnected &&
          document.visibilityState !== "hidden",
      );
      if (route !== location.hash || !panel.isConnected) return;
      inlineReady = true;
      panel.hidden = false;
      panel.previousElementSibling?.matches("[data-expense-access]") &&
        panel.previousElementSibling.remove();
    } catch {
      /* Public retry remains; no baseline or grants adopted. */
    } finally {
      preparing = false;
      if (
        route === location.hash &&
        document.querySelector("[data-expense-private]") !== panel
      )
        void prepareInline();
    }
  }
  function track(item, patch) {
    if (!inlineReady) throw Error("Спочатку перевірте доступ до витрат.");
    const r = record("expenses", item),
      p = existing(rows, r.id) || make(r, "fixed", Object.keys(patch));
    return capture(p, patch, Object.keys(patch));
  }
  function trackNew(group, name) {
    if (!inlineReady) throw Error("Спочатку перевірте доступ до витрат.");
    const p = existing(creates, group) || make(null, group);
    return capture(p, { name });
  }
  async function protectedRead(ctx, callback, signal) {
    ctx.protected = true;
    ctx.reading = true;
    const pending = f().controller.verifyRead(
        state(ctx.p).recordId,
        (authorized, actor) =>
          callback(AbortSignal.any([signal, authorized]), actor),
      ),
      n = ctx.generation;
    try {
      const result = await pending;
      if (!result || !live(ctx) || signal.aborted || n !== ctx.generation)
        throw canceled();
      reveal(ctx);
      return result.value;
    } finally {
      ctx.protected = false;
      ctx.reading = false;
      const gate = ctx.d.querySelector("[data-expense-access]");
      if (gate) {
        gate.querySelector("[data-access-retry]").disabled = false;
        gate.querySelector("[data-access-cancel]").hidden = true;
      }
    }
  }
  async function open({
    item = null,
    patch = {},
    units = null,
    group = "fixed",
    restored = null,
    signal = null,
    onConfirmed = () => {},
    needsReview = false,
  } = {}) {
    register();
    if (!registered) throw Error("Модуль чернеток ще завантажується.");
    if (active?.d.open) {
      active.d.focus();
      return active.d;
    }
    openingController?.abort();
    const localOpening = new AbortController();
    openingController = localOpening;
    signal = signal
      ? AbortSignal.any([signal, localOpening.signal])
      : localOpening.signal;
    const token = ++opening,
      route = location.hash;
    let p = restored
      ? c().decodeExpensePayload(restored)
      : item
        ? existing(rows, item.id) ||
          make(
            record("expenses", item),
            "fixed",
            units || Object.keys(patch).length
              ? units || Object.keys(patch)
              : ["name", "group", "amount", "category"],
          )
        : existing(creates, group) || make(null, group);
    if (!restored)
      p = c().decodeExpensePayload({
        ...p,
        baseline: {
          ...state(p),
          units: units || ["name", "group", "amount", "category"],
        },
        draft: { ...raw(p), ...patch },
      });
    const s = state(p),
      wasStored = f()
        .store.entries()
        .some((e) => e.id === s.recordId);
    if (!restored) {
      const session = await f().controller.check(false);
      if (
        wasStored &&
        !f()
          .store.entries()
          .some((e) => e.id === s.recordId)
      ) {
        if (s.id) rows.delete(s.id);
        else creates.delete(s.original.group);
        throw Error(
          "Попередню локальну чернетку закрито. Повторіть відкриття актуального запису.",
        );
      }
      try {
        await authorize(p, session, signal);
      } catch (error) {
        if (
          token === opening &&
          route === location.hash &&
          !signal.aborted &&
          [401, 403].includes(error.status)
        )
          await f()
            .controller.check(false)
            .catch(() => {});
        throw error;
      }
      if (token !== opening || route !== location.hash || signal?.aborted)
        throw canceled();
    } else if (authorizedSession?.recordId !== s.recordId)
      throw Error("Доступ до чернетки не підтверджено.");
    savePayload(p);
    const d = document.createElement("dialog"),
      opener = document.activeElement;
    d.className = "trade-dialog";
    d.setAttribute("aria-labelledby", "expenseRecoveryTitle");
    d.innerHTML =
      '<div class="trade-dialog-head"><h2 id="expenseRecoveryTitle">Перевіряємо доступ до форми</h2><button class="btn soft" type="button" data-close>Закрити</button></div><div class="trade-dialog-body" hidden><form novalidate id="expenseRecoveryForm"><div class="trade-form-grid"><label>Назва статті<input name="name" maxlength="250" required></label><label>Група<select name="group"><option value="fixed">Постійна</option><option value="variable">Змінна</option></select></label><label>Сума на місяць, грн<input type="text" inputmode="decimal" name="amount" maxlength="8000" required></label><label>Категорія<select name="category"><option value="">Не задано</option>' +
      a()
        .categories.map((v) => "<option>" + esc(v) + "</option>")
        .join("") +
      '</select></label></div><button class="btn" type="submit">Зберегти статтю</button></form><p class="trade-error" data-error role="alert" tabindex="-1"></p><p data-status role="status"></p><div class="trade-toolbar"><button class="btn soft" type="button" data-read>Порівняти з поточною версією</button><button class="btn soft" type="button" data-identity>Перевірити початкове створення</button><button class="btn soft" type="button" data-exact>Повторити початковий запит</button></div><div data-comparison></div></div>';
    const form = d.querySelector("form"),
      error = d.querySelector("[data-error]"),
      status = d.querySelector("[data-status]"),
      save = form.querySelector("[type=submit]"),
      read = d.querySelector("[data-read]"),
      identityButton = d.querySelector("[data-identity]"),
      exactButton = d.querySelector("[data-exact]"),
      host = d.querySelector("[data-comparison]");
    let review =
        restored || p.firstIntent || p.confirmation || needsReview
          ? true
          : s.review,
      busy = false,
      comparison = null,
      controller = null,
      sequence = 0;
    const ctx = {
      d,
      form,
      p,
      hidden: true,
      protected: false,
      reading: false,
      generation: 0,
      stop: () => {
        sequence++;
        controller?.abort();
        controller = null;
        comparison?.unmount();
        comparison = null;
        host.replaceChildren();
        ctx.reading = false;
        sync();
      },
    };
    active = ctx;
    const values = () =>
      Object.fromEntries(
        ["name", "group", "amount", "category"].map((k) => [
          k,
          form.elements[k].value,
        ]),
      );
    const fill = () => {
      const v = raw(p);
      for (const k of Object.keys(v)) {
        const input = form.elements[k];
        if (
          input.tagName === "SELECT" &&
          !Array.from(input.options).some((o) => o.value === v[k])
        )
          input.add(new Option("Некоректне збережене значення", v[k]));
        input.value = v[k];
      }
    };
    const capture = () => {
      const next = capturePayload({
        ...p,
        baseline: { ...state(p), review },
        draft: values(),
      });
      p = next;
      ctx.p = p;
      return p;
    };
    const capturePayload = (value) =>
      savePayload(c().decodeExpensePayload(value));
    const terms = () =>
      c().expenseTerms({
        ...state(p).original,
        ...Object.fromEntries(state(p).units.map((k) => [k, values()[k]])),
        amount: a().legacyMoney(
          (state(p).units.includes("amount")
            ? values().amount
            : state(p).original.amount
          ).replace(",", "."),
        ),
        category: state(p).units.includes("category")
          ? values().category || null
          : state(p).original.category,
      });
    const target = () => p.confirmation?.id || state(p).id;
    function sync() {
      form
        .querySelectorAll("input,select")
        .forEach(
          (el) =>
            (el.disabled =
              busy || ctx.reading || !state(p).units.includes(el.name)),
        );
      save.disabled =
        busy || ctx.reading || review || !!p.firstIntent || !!p.confirmation;
      d.querySelector("[data-close]").disabled = busy;
      read.hidden = !target();
      read.disabled = busy || ctx.reading || !!comparison;
      identityButton.hidden = p.firstIntent?.method !== "POST";
      identityButton.disabled = busy || ctx.reading;
      exactButton.hidden = p.firstIntent?.method !== "POST";
      exactButton.disabled = busy || ctx.reading;
      form.setAttribute("aria-busy", String(busy || ctx.reading));
      status.dataset.expenseUnits = state(p).units.join(",");
    }
    function accept(type, r) {
      const next = confirm(p, type, r, values());
      if (next) {
        p = next;
        ctx.p = p;
      }
      return next;
    }
    function dispose() {
      if (busy) return;
      if (
        !window.confirm(
          "Закрити редактор? Локальна чернетка лишиться для явного відновлення.",
        )
      )
        return;
      d.close();
    }
    form.addEventListener("input", () => {
      try {
        capture();
        error.textContent = "";
      } catch (e) {
        error.textContent = e.message;
      }
    });
    form.addEventListener("change", () => {
      try {
        capture();
        error.textContent = "";
      } catch (e) {
        error.textContent = e.message;
      }
    });
    d.querySelector("[data-close]").onclick = dispose;
    d.addEventListener("cancel", (e) => {
      e.preventDefault();
      dispose();
    });
    d.addEventListener(
      "close",
      () => {
        ctx.stop();
        if (active === ctx) active = null;
        d.remove();
        void prepareInline();
        if (opener?.isConnected) opener.focus();
      },
      { once: true },
    );
    async function readCurrent() {
      if (busy || ctx.reading || comparison || !target()) return;
      const mine = values(),
        n = ++sequence;
      capture();
      controller = new AbortController();
      error.textContent = "";
      status.textContent = "Читаємо поточний запис без змін…";
      sync();
      try {
        const r = await protectedRead(
          ctx,
          (authorized) => current(target(), authorized),
          controller.signal,
        );
        if (!live(ctx) || n !== sequence) return;
        if (!r.permissions.canEdit)
          throw Error("Редагування цієї статті недоступне.");
        if (
          p.confirmation &&
          p.confirmation.revision === r.revision &&
          JSON.stringify(p.confirmation.original) === JSON.stringify(project(r))
        ) {
          const cp = confirm(p, "complete", r, values());
          if (cp) {
            p = cp;
            ctx.p = p;
          }
          if (!cp) {
            d.close();
            await window.TSUKENYA_REFRESH_AFTER_WRITE?.().catch(() => {});
            return;
          }
        }
        if (p.confirmation?.original === null) {
          review = true;
          status.textContent =
            "Підтверджений запис прочитано. Історична квитанція без початкових полів: узгодження недоступне, новіше введення збережено.";
          sync();
          return;
        }
        const server = project(r),
          base = p.confirmation?.original || state(p).original,
          units = state(p).units;
        review = true;
        status.textContent =
          "Застосування змінює лише локальну чернетку. Збереження — окрема дія.";
        comparison = window.NativeConflictComparison.mount(host, {
          base,
          mine: { ...mine, category: mine.category || null },
          server,
          fields: a()
            .legacyFields(r)
            .map((field) => ({
              ...field,
              keys: field.keys.filter((k) => units.includes(k)),
            }))
            .filter((field) => field.keys.length),
          title: "Узгодити статтю витрат",
          onCancel: () => {
            if (live(ctx) && n === sequence) {
              ctx.stop();
              review = true;
              sync();
              read.focus();
            }
          },
          onApply: (merged) => {
            if (!live(ctx) || n !== sequence) return;
            try {
              const rawMerged = {
                ...values(),
                ...merged,
                category: Object.hasOwn(merged, "category")
                  ? (merged.category ?? "")
                  : values().category,
              };
              c().expenseTerms({
                ...server,
                ...Object.fromEntries(
                  state(p).units.map((k) => [
                    k,
                    k === "category" ? rawMerged[k] || null : rawMerged[k],
                  ]),
                ),
              });
              p = confirm(p, "apply", r, rawMerged);
              ctx.p = p;
              ctx.stop();
              review = false;
              fill();
              sync();
              save.focus();
            } catch (e) {
              error.textContent = e.message;
              error.focus();
            }
          },
        });
        sync();
      } catch (e) {
        if (live(ctx) && n === sequence && e.name !== "AbortError") {
          ctx.stop();
          review = true;
          error.textContent = e.message;
          sync();
        }
      }
    }
    async function readIdentity() {
      if (busy || ctx.reading || p.firstIntent?.method !== "POST") return;
      capture();
      const n = ++sequence;
      controller = new AbortController();
      sync();
      try {
        const found = await protectedRead(
          ctx,
          (authorized) => identity(p, authorized),
          controller.signal,
        );
        if (!live(ctx) || n !== sequence) return;
        if (found.confirmed) {
          if (found.original) {
            window.PortalApi.decodeCreateAcknowledgement(
              {
                ok: true,
                collection: "expenses",
                createKey: state(p).key,
                id: found.id,
                original: found.original,
              },
              "expenses",
              state(p).key,
              p.firstIntent.body,
            );
            const original = a().decodeLegacyRecord(
              found.original,
              "expenses",
              found.id,
            );
            accept("identity", original);
            review = true;
            status.textContent =
              found.state === "deleted"
                ? "Початкову статтю створено й видалено. Повтор не відновлює її."
                : "Початкове створення підтверджено. Поточне читання та узгодження — окремі дії.";
          } else {
            const event = {
              type: "identityLegacy",
              id: found.id,
              revision: found.current?.revision || null,
              terms: null,
              draft: values(),
            };
            const next = c().confirmExpensePayload(p, event);
            f().store.confirmed(state(p).recordId, event);
            p = next;
            ctx.p = p;
            creates.set(state(p).original.group, p);
            status.textContent =
              "Початковий ID підтверджено, але історична квитанція не містить початкових полів. Повтор CREATE заблоковано; поточне читання лише для перегляду, baseline не вигадано.";
            review = true;
          }
        } else
          status.textContent =
            "Квитанції не знайдено. Доступний лише явний повтор того самого початкового запиту.";
        sync();
      } catch (e) {
        if (live(ctx) && n === sequence && e.name !== "AbortError") {
          error.textContent = e.message;
          sync();
        }
      }
    }
    async function write(exact = false) {
      if (busy || ctx.reading || ctx.hidden || comparison) return;
      if (!exact && (review || p.firstIntent || p.confirmation)) return;
      let intent;
      try {
        capture();
        if (exact) {
          if (p.firstIntent?.method !== "POST") return;
          intent = p.firstIntent;
        } else {
          const value = terms();
          value.name = value.name.trim();
          const base = state(p);
          intent = base.id
            ? {
                method: "PATCH",
                path: "/api/docs/expenses/" + base.id,
                key: base.key,
                body: Object.fromEntries(
                  base.units
                    .filter((k) => value[k] !== base.original[k])
                    .map((k) => [k, value[k]]),
                ),
                revision: base.revision,
                possiblySent: true,
              }
            : {
                method: "POST",
                path: "/api/expenses",
                key: base.key,
                body: {
                  ...value,
                  name: value.name.trim(),
                  amount: Number(value.amount),
                  order: base.order,
                },
                revision: null,
                possiblySent: true,
              };
          p = capturePayload({ ...p, firstIntent: intent, confirmation: null });
          ctx.p = p;
        }
      } catch (e) {
        error.textContent = e.message;
        error.focus();
        return;
      }
      busy = true;
      ctx.protected = true;
      sync();
      error.textContent = "";
      try {
        const actor = await f().controller.verify(state(p).recordId);
        if (!actor || !live(ctx)) throw canceled();
        reveal(ctx);
        const generation = ctx.generation,
          path = location.hash,
          guard = () =>
            live(ctx) &&
            !ctx.hidden &&
            generation === ctx.generation &&
            path === location.hash &&
            document.visibilityState !== "hidden";
        ctx.protected = false;
        const ack = await request(
          intent.path,
          intent.method,
          intent.method === "POST"
            ? { key: intent.key, body: intent.body }
            : intent.body,
          intent.revision,
          undefined,
          guard,
          actor,
        );
        if (!live(ctx)) return;
        let r;
        if (intent.method === "POST") {
          window.PortalApi.decodeCreateAcknowledgement(
            ack,
            "expenses",
            intent.key,
            intent.body,
          );
          r = a().decodeLegacyRecord(ack.original, "expenses", ack.id);
        } else {
          if (
            !ack ||
            ack.ok !== true ||
            ack.id !== state(p).id ||
            typeof ack.revision !== "string" ||
            !/^[a-f0-9]{32}$/.test(ack.revision)
          )
            throw Error("Результат запису не підтверджено.");
          r = {
            collection: "expenses",
            id: ack.id,
            revision: ack.revision,
            data: { ...state(p).original, ...intent.body },
            permissions: { canEdit: true, canDelete: true },
            managed: false,
            initiative: null,
          };
        }
        accept("saved", r);
        review = true;
        busy = false;
        sync();
        status.textContent =
          "Запис підтверджено. Поточний стан читаємо окремо.";
        controller = new AbortController();
        const latest = await protectedRead(
          ctx,
          (authorized) => current(r.id, authorized),
          controller.signal,
        );
        if (!live(ctx)) return;
        const remaining = accept("complete", latest);
        if (!remaining) {
          onConfirmed?.();
          d.close();
          await window.TSUKENYA_REFRESH_AFTER_WRITE?.().catch(() => {});
          return true;
        } else {
          review = true;
          fill();
          sync();
          status.textContent =
            "Початковий запис підтверджено. Новіше введення лишається для узгодження.";
        }
      } catch (e) {
        if (live(ctx)) {
          review = true;
          error.textContent = e.message;
          status.textContent =
            "Запис не повторюється автоматично. Прочитайте поточний запис або квитанцію.";
          if ([401, 403].includes(e.status))
            await f().controller.verifyRead(state(p).recordId, async () => {
              throw e;
            });
        }
      } finally {
        ctx.protected = false;
        busy = false;
        if (live(ctx)) sync();
      }
    }
    form.onsubmit = (e) => {
      e.preventDefault();
      void write();
    };
    read.onclick = () => void readCurrent();
    identityButton.onclick = () => void readIdentity();
    exactButton.onclick = () => void write(true);
    document.body.append(d);
    d.showModal();
    fill();
    sync();
    try {
      ctx.protected = true;
      const actor =
        authorizedSession?.recordId === s.recordId
          ? authorizedSession.actor
          : null;
      if (
        signal?.aborted ||
        token !== opening ||
        route !== location.hash ||
        !live(ctx)
      )
        throw canceled();
      if (!actor) throw Error("Доступ до форми не підтверджено.");
      ctx.protected = false;
      reveal(ctx);
      form
        .querySelector("input:not([disabled]),select:not([disabled])")
        ?.focus();
      ctx.write = write;
      return d;
    } catch (error) {
      ctx.protected = false;
      if (restored) {
        d.close();
        throw error;
      }
      hide();
      return d;
    }
  }
  window.ExpenseDraftRecovery = {
    mountInline: () => {
      register();
      const panel = document.querySelector("[data-expense-private]");
      if (panel && !panel.closest("#catalogBudget")?.hidden) {
        if (active?.d.open) {
          panel.hidden = true;
          return;
        }
        if (inlineReady && f().controller.snapshot().state === "ready") {
          panel.hidden = false;
        } else {
          hide();
          void prepareInline();
        }
      }
    },
    track,
    trackNew,
    edit: (item, options = {}) => open({ item, ...options }),
    update: async (item, patch, onConfirmed) => {
      if (active?.d.open) {
        active.d.focus();
        return false;
      }
      try {
        track(
          item,
          Object.fromEntries(
            Object.entries(patch).map(([k, v]) => [
              k,
              v === null ? "" : String(v),
            ]),
          ),
        );
        const d = await open({
          item,
          patch: Object.fromEntries(
            Object.entries(patch).map(([k, v]) => [
              k,
              v === null ? "" : String(v),
            ]),
          ),
          units: Object.keys(patch),
          onConfirmed,
        });
        return d?.open && active?.d === d ? !!(await active.write()) : false;
      } catch (e) {
        window.alert(e.message);
        return false;
      }
    },
    create: async (group, name) => {
      if (active?.d.open) {
        active.d.focus();
        return false;
      }
      const d = await open({
        group,
        patch: { name },
        onConfirmed: () => {
          const input = document.querySelector('[data-newexp="' + group + '"]');
          if (input?.value === name) input.value = "";
        },
      });
      if (d?.open && active?.d === d) return active.write();
    },
    discardInline: async (id) => {
      try {
        await f().controller.check(false);
        const p = existing(rows, id);
        if (p) f().store.discard(state(p).recordId);
        rows.delete(id);
        f().controller.refreshEntries();
        return true;
      } catch (error) {
        window.alert("Не вдалося відкинути чернетку. Введення збережено.");
        return false;
      } finally {
        await prepareInline();
      }
    },
    pending: () => !!active?.d.open,
    isPending: (id) => !!active?.d.open && state(active.p).id === id,
    canLeave: () => {
      if (active?.d.open) {
        active.d.querySelector("[data-close]").click();
        return !active.d.open;
      }
      return true;
    },
  };
  window.addEventListener("tsukenya:native-conflict-ready", register);
  window.addEventListener("hashchange", () => {
    opening++;
    openingController?.abort();
  });
  window.addEventListener("pagehide", () => {
    opening++;
    openingController?.abort();
  });
  window.addEventListener("beforeunload", (e) => {
    if (rows.size || creates.size || active?.d.open) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
})();
