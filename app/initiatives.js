/* Owner-only idea projects. All state, sums and permissions remain authoritative on Django. */
(() => {
  "use strict";
  const esc = (v) =>
    String(v ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  const states = {
      planned: "Заплановано",
      active: "У роботі",
      completed: "Завершено",
      cancelled: "Скасовано",
    },
    taskStates = { todo: "Не почато", doing: "У роботі", done: "Готово" };
  const object = (v) =>
      v !== null && typeof v === "object" && !Array.isArray(v),
    integer = (v) => Number.isSafeInteger(v) && v > 0,
    string = (v) => typeof v === "string",
    money = (v) => string(v) && /^-?\d+(?:\.\d{1,4})?$/.test(v),
    nullable = (v, p) => v === null || p(v);
  const uuid = (v) =>
      string(v) &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v),
    revision = (v) => string(v) && /^[a-f0-9]{64}$/.test(v);
  const assert = (condition) => {
    if (!condition)
      throw Error(
        "Сервер повернув некоректні дані. Оновіть сторінку або повторіть читання.",
      );
  };
  function pageData(v, check) {
    assert(
      object(v) &&
        integer(v.page) &&
        integer(v.pages) &&
        Number.isSafeInteger(v.total) &&
        v.total >= 0 &&
        Array.isArray(v.items),
    );
    v.items.forEach(check);
    return v;
  }
  function decodeProject(v) {
    assert(
      object(v) &&
        uuid(v.id) &&
        integer(v.revision) &&
        string(v.idea) &&
        string(v.title) &&
        string(v.state) &&
        Object.hasOwn(states, v.state) &&
        nullable(v.store, integer) &&
        nullable(v.responsible, integer) &&
        nullable(v.responsibleName, string) &&
        nullable(v.responsibleActive, (x) => typeof x === "boolean") &&
        nullable(v.plannedBudget, money) &&
        money(v.actualExpenses) &&
        string(v.actualPolicy),
    );
    [
      "problem",
      "hypothesis",
      "metric",
      "metricUnit",
      "resultSummary",
      "cancelReason",
    ].forEach((k) => assert(string(v[k])));
    ["targetValue", "factValue"].forEach((k) => assert(nullable(v[k], money)));
    assert(
      nullable(v.resultDate, (x) => string(x) && /^\d{4}-\d{2}-\d{2}$/.test(x)),
    );
    pageData(v.tasks, (t) =>
      assert(
        object(t) &&
          string(t.id) &&
          string(t.title) &&
          string(t.status) &&
          Object.hasOwn(taskStates, t.status) &&
          string(t.phase) &&
          revision(t.revision),
      ),
    );
    pageData(v.expenses, (e) =>
      assert(
        object(e) &&
          integer(e.id) &&
          string(e.number) &&
          string(e.date) &&
          money(e.amount) &&
          string(e.status) &&
          nullable(e.store, integer) &&
          string(e.category) &&
          typeof e.canOpen === "boolean",
      ),
    );
    return v;
  }
  function decodeIdea(v) {
    assert(
      object(v) &&
        string(v.id) &&
        string(v.title) &&
        string(v.text) &&
        revision(v.revision) &&
        [null, "yes", "no"].includes(v.reaction) &&
        nullable(v.project, uuid),
    );
    return v;
  }
  function decodeOptions(v) {
    assert(
      object(v) &&
        typeof v.networkAllowed === "boolean" &&
        Array.isArray(v.stores) &&
        Array.isArray(v.users),
    );
    v.stores.forEach((s) =>
      assert(object(s) && integer(s.id) && string(s.name)),
    );
    v.users.forEach((u) =>
      assert(object(u) && integer(u.id) && string(u.username)),
    );
    return v;
  }
  const field = (label, name, value = "", extra = "", type = "text") =>
    `<label class="initiative-field">${esc(label)}<input name="${name}" type="${type}" value="${esc(value)}" ${extra}></label>`;
  const area = (label, name, value = "", required = false) =>
    `<label class="initiative-field initiative-wide">${esc(label)}<textarea name="${name}" maxlength="4000" ${required ? "required" : ""}>${esc(value)}</textarea></label>`;
  const button = (label, action, extra = "") =>
    `<button class="btn soft" type="button" data-initiative-act="${action}" ${extra}>${label}</button>`;
  function planFields(v, creating) {
    let users = options.users;
    if (v.responsible && !users.some((u) => u.id === v.responsible))
      users = [
        ...users,
        {
          id: v.responsible,
          username:
            (v.responsibleName || "Користувач № " + v.responsible) +
            " · неактивний",
        },
      ];
    return `${field("Назва проєкту", "title", v.title, 'required maxlength="250"')}${creating ? `<label class="initiative-field">Магазин<select name="store">${options.networkAllowed ? '<option value="">Уся мережа</option>' : ""}${options.stores.map((s) => `<option value="${s.id}" ${s.id === v.store ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select></label>` : ""}<label class="initiative-field">Відповідальний · необов’язково<select name="responsible"><option value="">Не призначено</option>${users.map((u) => `<option value="${u.id}" ${u.id === v.responsible ? "selected" : ""}>${esc(u.username)}</option>`).join("")}</select></label>${area("Проблема або можливість", "problem", v.problem)}${area("Гіпотеза: що має змінитися", "hypothesis", v.hypothesis)}${field("План бюджету, грн · необов’язково", "plannedBudget", v.plannedBudget ?? "", 'inputmode="decimal" pattern="[0-9]+([.,][0-9]{1,2})?"')}${field("Показник · необов’язково", "metric", v.metric, 'maxlength="160"')}${field("Одиниця показника, наприклад %", "metricUnit", v.metricUnit, 'maxlength="80"')}${field("Числова ціль · необов’язково", "targetValue", v.targetValue ?? "", 'inputmode="decimal"')}<p class="muted initiative-wide">Бюджет і показник можна залишити порожніми. Якщо задано показник, потрібні його одиниця та фактичне значення при завершенні. План бюджету не проводить кошти.</p>`;
  }
  const today = () =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Kyiv",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  function detailHtml() {
    const open = ["planned", "active"].includes(project.state);
    return `<p><strong>${states[project.state]}</strong> · ${esc(options.stores.find((s) => s.id === project.store)?.name || (!project.store ? "Уся мережа" : "Збережений магазин"))}</p><p><a href="#development/ideas" data-initiative-act="source-idea">Перейти до ідей</a> · ${esc(project.responsibleName || "Відповідального не призначено")}${project.responsibleActive === false ? " · збережене неактивне призначення" : ""}</p><dl class="initiative-facts"><div><dt>Проблема</dt><dd>${esc(project.problem || "Не зазначено")}</dd></div><div><dt>Гіпотеза</dt><dd>${esc(project.hypothesis || "Не зазначено")}</dd></div><div><dt>План бюджету</dt><dd>${project.plannedBudget === null ? "Не задано" : esc(project.plannedBudget) + " грн"}</dd></div><div><dt>Пов’язані витрати зараз</dt><dd>${esc(project.actualExpenses)} грн</dd></div><div><dt>Показник / ціль</dt><dd>${project.metric ? esc(project.metric) + " · " + esc(project.metricUnit) + (project.targetValue !== null ? " · ціль " + esc(project.targetValue) : "") : "Не задано"}</dd></div></dl><p class="muted">${esc(project.actualPolicy)}</p>${project.state === "completed" ? `<section><h3>Результат</h3><p>${esc(project.resultSummary)}</p><p>${esc(project.resultDate)}${project.factValue !== null ? " · факт " + esc(project.factValue) + " " + esc(project.metricUnit) : ""}</p></section>` : ""}${project.cancelReason ? `<p>Причина скасування: ${esc(project.cancelReason)}</p>` : ""}<div class="initiative-actions">${open ? button("Редагувати план", "edit") : ""}${project.state === "planned" ? button("Почати реалізацію", "start") : ""}${project.state === "active" ? button("Записати результат", "complete") : ""}${project.state === "completed" ? button("Виправити результат", "result_edit") : ""}${open ? button("Скасувати проєкт", "cancel") : ""}${button("Оновити поточний стан", "refresh")}</div><section><h3>Задачі проєкту · ${project.tasks.total}</h3>${project.tasks.items.map((t) => `<article class="initiative-item"><strong>${esc(t.title)}</strong><p>${esc(t.phase || "Етап не задано")} · ${taskStates[t.status]}</p>${open ? button("Змінити стан", "task-status", `data-id="${esc(t.id)}"`) : ""}</article>`).join("") || '<p class="muted">Пов’язаних задач ще немає.</p>'}${pager(project.tasks, "tasks")}<div class="initiative-actions">${open ? button("Додати нову задачу", "task_create") + button("Пов’язати стару задачу", "choose-tasks") : ""}</div></section><section><h3>Документи витрат · ${project.expenses.total}</h3>${project.expenses.items.map((e) => `<article class="initiative-item"><strong>№ ${esc(e.number)} · ${esc(e.amount)} грн</strong><p>${esc(e.category)} · ${esc(e.date)} · ${e.status === "posted" ? "Проведено" : e.status === "reversed" ? "Сторновано" : esc(e.status)}</p><div class="initiative-actions">${e.canOpen ? button("Відкрити джерело", "source-expense", `data-id="${e.id}"`) : ""}${button("Відв’язати", "expense_detach", `data-id="${e.id}"`)}</div></article>`).join("") || '<p class="muted">Витрати ще не пов’язані.</p>'}${pager(project.expenses, "expenses")}${button("Пов’язати проведену витрату", "choose-expenses")}<p class="muted">Один документ витрати належить одному проєкту цілою сумою. Розподілів між проєктами немає.</p></section>`;
  }
  function pager(v, kind) {
    return v.pages > 1
      ? `<div class="initiative-actions" aria-label="Сторінки ${kind === "tasks" ? "задач" : "витрат"}">${v.page > 1 ? button("Попередня", "page", `data-kind="${kind}" data-page="${v.page - 1}"`) : ""}<span>${v.page} / ${v.pages}</span>${v.page < v.pages ? button("Наступна", "page", `data-kind="${kind}" data-page="${v.page + 1}"`) : ""}</div>`
      : "";
  }
  const planKeys = [
    "title",
    "problem",
    "hypothesis",
    "responsible",
    "plannedBudget",
    "metric",
    "metricUnit",
    "targetValue",
  ];
  const resultKeys = ["resultSummary", "resultDate", "factValue"];
  const decimalValue = (v) =>
    v === null || v === undefined || String(v).trim() === ""
      ? null
      : String(v).trim().replace(",", ".");
  function projection(value, keys) {
    return Object.fromEntries(keys.map((key) => [key, value[key] ?? null]));
  }
  function localValues(formEl, keys) {
    // Comparison temporarily disables controls; disabled fields still own raw input.
    const values = Object.fromEntries(
      keys.map((key) => [key, formEl.elements[key]?.value ?? ""]),
    );
    return Object.fromEntries(
      keys.map((key) => [
        key,
        key === "responsible"
          ? values[key]
            ? Number(values[key])
            : null
          : ["plannedBudget", "targetValue", "factValue"].includes(key)
            ? decimalValue(values[key])
            : (values[key] ?? null),
      ]),
    );
  }
  function editorFields(action, latest) {
    const responsibleNames = Object.fromEntries(
      options.users.map((user) => [String(user.id), user.username]),
    );
    for (const value of [formBaseline, latest])
      if (value?.responsible)
        responsibleNames[String(value.responsible)] =
          (value.responsibleName || "Збережений відповідальний") +
          (value.responsibleActive === false ? " · неактивний" : "");
    if (action === "edit")
      return [
        ...[
          ["title", "Назва проєкту"],
          ["problem", "Проблема або можливість"],
          ["hypothesis", "Гіпотеза"],
          ["responsible", "Відповідальний"],
          ["plannedBudget", "План бюджету, грн"],
        ].map(([id, label]) => ({
          id,
          label,
          keys: [id],
          ...(id === "plannedBudget"
            ? { decimals: [id] }
            : id === "responsible"
              ? { valueLabels: responsibleNames }
              : {}),
        })),
        {
          id: "metric",
          label: "Показник, одиниця та ціль",
          keys: ["metric", "metricUnit", "targetValue"],
          decimals: ["targetValue"],
          labels: {
            metric: "Показник",
            metricUnit: "Одиниця",
            targetValue: "Ціль",
          },
        },
      ];
    return [
      ["resultSummary", "Опис результату"],
      ["resultDate", "Дата результату"],
      ["factValue", "Фактичний показник"],
    ].map(([id, label]) => ({
      id,
      label,
      keys: [id],
      ...(id === "factValue" ? { decimals: [id] } : {}),
    }));
  }
  const NAME = "native-initiative-v1";
  const c = () => window.NativeInitiativePersistence;
  const f = () => window.NativeDraftRecovery;
  const state = (p) => c().decodeState(p.baseline);
  const binding = (s) =>
    JSON.stringify([
      s.draftOwner,
      s.draftSession,
      s.role,
      s.storeId,
      s.networkOwner,
    ]);
  const canceled = () => new DOMException("Скасовано", "AbortError");
  let dialog,
    project = null,
    idea = null,
    options = { users: [], stores: [], networkAllowed: false },
    returnFocus,
    viewRequest = null,
    returnSelector = null,
    pendingReturn = null;
  let readGeneration = 0,
    listGeneration = 0,
    opening = null,
    draft = null;
  let registered = false,
    authorized = null,
    restoring = null,
    warm = false,
    privateHidden = false,
    denied = false;
  let formBaseline = null,
    comparisonHandle = null,
    comparisonController = null,
    comparisonGeneration = 0,
    comparisonReading = false;
  function live(a) {
    return draft === a && dialog?.open && a.form?.isConnected;
  }
  function fence(a, generation, signal) {
    if (signal?.aborted || generation !== readGeneration || (a && !live(a)))
      throw canceled();
  }
  function foundation() {
    if (!f() || !c())
      throw Error("Модуль чернеток ще завантажується. Повторіть відкриття.");
    register();
    return f();
  }
  function preserveListFocus(host) {
    const active = document.activeElement;
    if (
      !dialog?.open &&
      host?.contains(active) &&
      active?.dataset?.initiativeOpen
    ) {
      const anchor = document.querySelector("#pageTitle");
      anchor?.focus();
      pendingReturn = {
        selector:
          '[data-initiative-open="' + active.dataset.initiativeOpen + '"]',
        route: location.hash,
        anchor: document.activeElement,
      };
    }
  }
  function refreshListAfterSuspend() {
    const generation = listGeneration;
    queueMicrotask(() => {
      if (
        !denied &&
        generation === listGeneration &&
        !dialog?.open &&
        !opening &&
        document.visibilityState === "visible" &&
        document.querySelector("[data-initiatives]")
      )
        void mount();
    });
  }
  function hide() {
    readGeneration++;
    listGeneration++;
    authorized = null;
    const list = document.querySelector("[data-initiatives]");
    preserveListFocus(list);
    list?.replaceChildren();
    if (!dialog?.open) {
      refreshListAfterSuspend();
      return;
    }
    privateHidden = true;
    if (draft) {
      draft.hidden = true;
      draft.current = null;
    }
    if (!draft?.reading && !draft?.busy) stopComparison();
    dialog.querySelector("#initiativeTitle").textContent = "Проєкт призупинено";
    dialog.querySelector(".initiative-content").hidden = true;
    dialog.querySelector("[data-initiative-status]").textContent = "";
    let gate = dialog.querySelector("[data-initiative-access]");
    if (!gate) {
      gate = document.createElement("section");
      gate.dataset.initiativeAccess = "";
      gate.innerHTML =
        '<p role="status">Форму приховано до перевірки доступу.</p>' +
        button("Перевірити доступ", "access") +
        button("Скасувати читання", "access-cancel");
      dialog.append(gate);
    }
    gate.hidden = false;
    gate.querySelector("[data-initiative-act=access]").disabled = !!(
      draft?.busy || draft?.reading
    );
  }
  function reveal(a, restoreGateFocus = false) {
    if (!live(a)) throw canceled();
    a.hidden = false;
    privateHidden = false;
    dialog.querySelector("#initiativeTitle").textContent = a.title;
    dialog.querySelector(".initiative-content").hidden = false;
    const hadGateFocus = dialog
      .querySelector("[data-initiative-access]")
      ?.contains(document.activeElement);
    dialog.querySelector("[data-initiative-access]")?.remove();
    controls(a);
    if (hadGateFocus || restoreGateFocus)
      dialog.querySelector("#initiativeTitle").focus();
  }
  async function session(signal, guard, expected) {
    const check = () => {
      if (signal?.aborted || !guard()) throw canceled();
    };
    check();
    let actor;
    try {
      actor = await window.PortalApi.session(signal);
    } catch (error) {
      check();
      if ([401, 403].includes(error.status)) {
        denied = true;
        f()?.controller.revoke();
        hide();
      }
      throw error;
    }
    check();
    if (
      actor.role !== "owner" ||
      (expected && binding(actor) !== binding(expected))
    ) {
      denied = true;
      await f()
        ?.controller.check(false)
        .catch(() => {});
      hide();
      throw Object.assign(Error("Доступ до проєктів змінився."), {
        status: 403,
      });
    }
    denied = false;
    return actor;
  }
  async function api(path, body, signal, guard = () => true, expected) {
    const check = () => {
      if (signal?.aborted || !guard()) throw canceled();
    };
    const actor = await session(signal, guard, expected);
    check();
    let response;
    try {
      response = await fetch("/api/erp/" + path, {
        method: body === undefined ? "GET" : "POST",
        signal,
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": actor.csrf,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      check();
      throw Object.assign(
        Error("Відповідь не отримано. Введення й первісний запит збережено."),
        { cause: error },
      );
    }
    check();
    if (response.status === 401) {
      denied = true;
      window.dispatchEvent(new Event("tsukenya:session-invalidated"));
      throw Object.assign(Error("Сеанс завершено."), { status: 401 });
    }
    let value;
    try {
      value = await response.json();
    } catch {
      check();
      throw Error(
        "Некоректна відповідь. Введення й первісний запит збережено.",
      );
    }
    check();
    await session(signal, guard, actor);
    check();
    if (!response.ok)
      throw Object.assign(
        Error(string(value?.error) ? value.error : "Запит недоступний."),
        {
          status: response.status,
          code: value?.code,
          definitive: object(value) && string(value.error),
        },
      );
    return value;
  }
  async function context(p, actor, signal, guard) {
    const s = state(p),
      raw = c().decodeRaw(p.draft, s.action),
      selected = c().selection(s, raw);
    const value = await api(
      "initiatives/recovery-context?" + new URLSearchParams(c().query(s, raw)),
      undefined,
      signal,
      guard,
      actor,
    );
    const current = c().decodeContext(value, s.action, selected, actor);
    if (current.project && current.project.idea !== s.ideaId)
      throw Error("Ідентичність початкової ідеї змінилася.");
    if (signal?.aborted || !guard()) throw canceled();
    return current;
  }
  function register() {
    if (registered) return;
    if (!f() || !c()) return;
    f().register({
      name: NAME,
      version: 1,
      label: "Дія проєкту розвитку",
      decode: c().decodePayload,
      confirm: c().confirmPayload,
      suspend: hide,
      authorize: async (p, actor, signal) => {
        const generation = readGeneration,
          path = location.hash,
          s = state(p);
        const guard = () =>
          generation === readGeneration &&
          path === location.hash &&
          !signal.aborted;
        const id = await c().recordId(s.routeProject, s.ideaId);
        if (!guard()) throw canceled();
        if (id !== s.recordId) throw Error("Чернетка належить іншому проєкту.");
        const current = await context(p, actor, signal, guard);
        authorized = { id, actor, current };
        return true;
      },
      restore: async (p, signal) => {
        const s = state(p),
          grant = authorized,
          generation = readGeneration;
        if (signal.aborted || grant?.id !== s.recordId) throw canceled();
        const guard = () => generation === readGeneration && !signal.aborted;
        const latestOptions = decodeOptions(
          await api(
            "initiatives/options",
            undefined,
            signal,
            guard,
            grant.actor,
          ),
        );
        fence(null, generation, signal);
        if (dialog?.open && !close(false, false)) throw canceled();
        if (signal.aborted) throw canceled();
        options = latestOptions;
        p = c().decodePayload(p);
        p.baseline = { ...p.baseline, review: true };
        f().store.save(s.recordId, NAME, p);
        renderForm(p, grant.current, grant.actor);
        restoring = signal;
      },
    });
    registered = true;
    f().controller.subscribe(() => {
      if (f().controller.snapshot().state !== "ready") return;
      if (restoring) {
        const signal = restoring;
        restoring = null;
        queueMicrotask(() => {
          if (!signal.aborted) {
            f().close();
            draft?.form.querySelector("input,textarea,select")?.focus();
          }
        });
      }
      if (!draft?.hidden || draft.busy || draft.reading || warm) return;
      const a = draft;
      if (
        !f()
          .store.entries()
          .some((e) => e.id === state(a.p).recordId)
      ) {
        close(true);
        return;
      }
      warm = true;
      void guarded(a, async () => null)
        .catch(() => {})
        .finally(() => (warm = false));
    });
  }
  function notice(message, error = false) {
    const el = dialog?.querySelector("[data-initiative-status]");
    if (el && !privateHidden) {
      el.textContent = message;
      el.setAttribute("role", error ? "alert" : "status");
    }
  }
  function stopComparison() {
    comparisonGeneration++;
    comparisonController?.abort();
    comparisonController = null;
    comparisonHandle?.unmount();
    comparisonHandle = null;
    comparisonReading = false;
  }
  function close(force = false, resumeInline = true) {
    if (draft && !force && !draft.hidden) {
      try {
        capture(draft);
      } catch (error) {
        notice(error.message, true);
        return false;
      }
    }
    readGeneration++;
    opening?.abort();
    opening = null;
    stopComparison();
    draft = null;
    privateHidden = false;
    viewRequest = null;
    dialog?.close();
    dialog?.replaceChildren();
    const focus = returnFocus?.isConnected
      ? returnFocus
      : document.querySelector("#pageTitle");
    const target = returnSelector && document.querySelector(returnSelector);
    (target || focus)?.focus();
    pendingReturn =
      !target && returnSelector
        ? {
            selector: returnSelector,
            route: location.hash,
            anchor: document.activeElement,
          }
        : null;
    if (resumeInline) window.PortalDraftRecovery?.mountInline();
    return true;
  }
  function shell(title, html) {
    stopComparison();
    if (!dialog) {
      dialog = document.createElement("dialog");
      dialog.className = "initiative-dialog";
      dialog.setAttribute("aria-labelledby", "initiativeTitle");
      document.body.append(dialog);
      dialog.addEventListener("cancel", (e) => {
        e.preventDefault();
        close();
      });
      dialog.addEventListener("click", (e) => void click(e));
      dialog.addEventListener("submit", (e) => {
        if (!e.target.matches(".initiative-form")) return;
        e.preventDefault();
        if (draft) void write(draft, false);
      });
      const captureInput = (e) => {
        if (!draft || !e.target.closest(".initiative-form")) return;
        try {
          capture(draft);
          notice("Введення збережено локально.");
        } catch (error) {
          notice(error.message, true);
        }
      };
      dialog.addEventListener("input", captureInput);
      dialog.addEventListener("change", captureInput);
    }
    dialog.innerHTML = `<header class="initiative-header"><h2 id="initiativeTitle" tabindex="-1">${esc(title)}</h2>${button("Закрити", "close")}</header><div data-initiative-status role="status" aria-live="polite"></div><div class="initiative-content">${html}</div>`;
    privateHidden = false;
    if (!dialog.open) dialog.showModal();
    dialog.querySelector("h2").focus();
  }
  function capture(a) {
    if (!live(a) || a.hidden) throw Error("Спершу перевірте доступ до форми.");
    const s = state(a.p),
      raw = Object.fromEntries(
        c()
          .rawKeys(s.action)
          .map((k) => [k, a.form.elements[k]?.value ?? ""]),
      );
    const p = c().decodePayload({ ...a.p, draft: raw });
    f().store.save(s.recordId, NAME, p);
    a.p = p;
    return p;
  }
  function confirm(a, event) {
    const next = c().confirmPayload(a.p, event);
    f().store.confirmed(state(a.p).recordId, event);
    if (next) a.p = next;
    return next;
  }
  async function guarded(a, read, signal) {
    if (!live(a)) throw canceled();
    const restoreGateFocus = !!dialog
      .querySelector("[data-initiative-access]")
      ?.contains(document.activeElement);
    a.reading++;
    try {
      const pending = f().controller.verifyRead(
        state(a.p).recordId,
        async (own, actor) => {
          const combined = signal ? AbortSignal.any([signal, own]) : own,
            generation = readGeneration;
          fence(a, generation, combined);
          const value = await read(
            combined,
            actor,
            () => live(a) && generation === readGeneration,
          );
          fence(a, generation, combined);
          return value;
        },
      );
      const generation = readGeneration,
        result = await pending;
      fence(a, generation, signal);
      if (!result)
        throw Error("Доступ до чернетки або поточні умови не підтверджено.");
      a.actor = result.session;
      if (authorized?.id === state(a.p).recordId)
        a.current = authorized.current;
      reveal(a, restoreGateFocus);
      return result.value;
    } finally {
      a.reading--;
      if (live(a)) controls(a);
    }
  }
  function controls(a) {
    if (!live(a)) return;
    const s = state(a.p),
      first = !!a.p.firstIntent,
      confirmed = !!a.p.confirmation;
    a.form.querySelector("[type=submit]").disabled =
      a.busy ||
      a.reading ||
      a.hidden ||
      comparisonReading ||
      first ||
      confirmed ||
      s.review ||
      !a.current?.canWrite;
    a.form
      .querySelectorAll("input,textarea,select")
      .forEach((el) => (el.disabled = !!comparisonHandle || comparisonReading));
    const retry = dialog.querySelector("[data-initiative-act=retry]");
    retry.hidden = !first;
    retry.disabled = a.busy || !!a.reading || a.hidden;
    for (const act of ["read", "compare"])
      dialog.querySelector("[data-initiative-act=" + act + "]").disabled =
        a.busy || !!a.reading || a.hidden;
    dialog.querySelector("[data-initiative-act=compare]").hidden = first;
    dialog
      .querySelector("[data-initiative-act=access]")
      ?.toggleAttribute("disabled", a.busy || !!a.reading);
  }
  function initialRaw(s, current) {
    const values =
      s.action === "create"
        ? {
            title: current.idea.title,
            problem: current.idea.text,
            hypothesis: "",
            store: current.selection.store,
          }
        : current.project;
    return Object.fromEntries(
      c()
        .rawKeys(s.action)
        .map((k) => [
          k,
          String(
            (s.action === "task_create"
              ? { title: "", phase: "", stage: "1" }
              : s.action === "task_link"
                ? { phase: "" }
                : s.action === "task_update"
                  ? { status: current.source?.status ?? "todo" }
                  : k === "reason"
                    ? { reason: "" }
                    : values)?.[k] ?? (k === "resultDate" ? today() : ""),
          ),
        ]),
    );
  }
  function fieldsFor(s, raw) {
    const p = s.original;
    if (s.action === "create" || s.action === "edit")
      return (
        (s.action === "create"
          ? `<p class="initiative-wide">Обрана ідея: <strong>${esc(s.originalIdea.title)}</strong></p>`
          : "") +
        planFields(
          {
            ...p,
            ...raw,
            responsible: raw.responsible ? Number(raw.responsible) : null,
            responsibleName:
              raw.responsible === String(p?.responsible ?? "")
                ? p?.responsibleName
                : null,
            store: raw.store ? Number(raw.store) : null,
          },
          s.action === "create",
        )
      );
    if (s.action === "complete" || s.action === "result_edit")
      return (
        area("Опис результату", "resultSummary", raw.resultSummary, true) +
        field(
          "Дата результату за Києвом",
          "resultDate",
          raw.resultDate,
          'required max="' + today() + '"',
          "date",
        ) +
        `<div class="initiative-wide" data-initiative-fact>${p.metric ? field(`Фактичний показник: ${p.metric}, ${p.metricUnit}`, "factValue", raw.factValue, 'required inputmode="decimal"') : '<input type="hidden" name="factValue" value="' + esc(raw.factValue) + '">'}</div>` +
        (s.action === "result_edit"
          ? area("Причина виправлення", "reason", raw.reason, true)
          : "")
      );
    if (s.action === "cancel" || s.action === "expense_detach")
      return area(
        s.action === "cancel" ? "Причина скасування" : "Причина відв’язування",
        "reason",
        raw.reason,
        true,
      );
    if (s.action === "task_create")
      return (
        field("Назва задачі", "title", raw.title, 'required maxlength="250"') +
        field(
          "Етап у цьому проєкті · необов’язково",
          "phase",
          raw.phase,
          'maxlength="160"',
        ) +
        `<label class="initiative-field">Етап старого плану<select name="stage">${[1, 2, 3, 4].map((n) => `<option value="${n}" ${String(n) === raw.stage ? "selected" : ""}>${n}</option>`).join("")}</select></label>`
      );
    if (s.action === "task_link")
      return (
        `<p class="initiative-wide">${esc(s.source?.title || "Збережена задача")}</p>` +
        field(
          "Етап у цьому проєкті · необов’язково",
          "phase",
          raw.phase,
          'maxlength="160"',
        )
      );
    if (s.action === "task_update")
      return `<p class="initiative-wide">${esc(s.source?.title || "Збережена задача")}</p><label class="initiative-field">Стан<select name="status">${Object.entries(
        taskStates,
      )
        .map(
          ([k, label]) =>
            `<option value="${k}" ${k === raw.status ? "selected" : ""}>${label}</option>`,
        )
        .join("")}</select></label>`;
    if (s.action === "expense_attach")
      return `<p class="initiative-wide">№ ${esc(s.source?.number || s.sourceId)} · ${esc(s.source?.amount ?? "—")} грн. Уся сума належатиме цьому проєкту.</p>`;
    return '<p class="initiative-wide">Підтвердіть початок реалізації проєкту.</p>';
  }
  const actionLabels = {
    create: "Створити проєкт",
    edit: "Зберегти",
    start: "Почати реалізацію",
    complete: "Завершити проєкт",
    result_edit: "Зберегти виправлення",
    cancel: "Скасувати проєкт",
    task_create: "Додати задачу",
    task_link: "Пов’язати задачу",
    task_update: "Зберегти",
    expense_attach: "Пов’язати витрату",
    expense_detach: "Відв’язати витрату",
  };
  function renderForm(p, current, actor) {
    const s = state(p),
      raw = c().decodeRaw(p.draft, s.action);
    formBaseline = s.original;
    const title =
      s.action === "create"
        ? "Проєкт з обраної ідеї"
        : s.action === "edit"
          ? "План проєкту"
          : s.action === "complete"
            ? "Завершення проєкту"
            : s.action === "result_edit"
              ? "Виправлення результату"
              : s.action === "task_create"
                ? "Нова задача проєкту"
                : "Дія проєкту";
    shell(
      title,
      `<section data-initiative-recovery><p>Введення зберігається локально. Відновлення й застосування умов не виконують дії на сервері.</p><div class="initiative-actions">${button("Повторити ту саму дію", "retry")}${button("Перевірити підтвердження й умови", "read")}${button("Порівняти з поточною версією", "compare")}</div><div data-initiative-comparison></div></section><form class="initiative-form" data-action="${s.action}">${fieldsFor(s, raw)}<div class="initiative-actions initiative-wide"><button class="btn rasp" type="submit">${actionLabels[s.action]}</button>${button("Закрити зі збереженням чернетки", "back")}</div></form>`,
    );
    draft = {
      p,
      current,
      actor,
      title,
      form: dialog.querySelector(".initiative-form"),
      busy: false,
      reading: 0,
      hidden: false,
    };
    controls(draft);
    if (s.review || p.confirmation)
      notice(
        "Чернетку відновлено. Перевірте поточні умови, застосуйте локально й збережіть окремо.",
      );
    if (!current.canWrite) notice(current.reason, true);
  }
  async function begin(action, sourceId = null) {
    foundation();
    if (draft) return;
    const controller = new AbortController();
    opening = controller;
    try {
      const pending = f().controller.check(false),
        generation = readGeneration,
        route = location.hash;
      const actor = await pending;
      fence(null, generation, controller.signal);
      const guard = () =>
        generation === readGeneration &&
        opening === controller &&
        route === location.hash;
      const routeProject = action === "create" ? null : project.id,
        ideaId = action === "create" ? idea.id : project.idea;
      const id = await c().recordId(routeProject, ideaId),
        createId = await c().recordId(null, ideaId);
      if (!guard()) throw canceled();
      if (
        f()
          .store.entries()
          .some((e) => e.id === id || e.id === createId)
      ) {
        close(true);
        f().open();
        return;
      }
      const selected = {
        project: routeProject,
        idea: action === "create" ? ideaId : null,
        task: ["task_link", "task_update"].includes(action) ? sourceId : null,
        voucher: action.startsWith("expense_") ? sourceId : null,
        store: action === "create" ? (actor.storeId ?? null) : null,
      };
      const params = {
        action,
        ...Object.fromEntries(
          Object.entries(selected)
            .filter(
              ([k, v]) => v !== null || (k === "store" && action === "create"),
            )
            .map(([k, v]) => [k, v === null ? "" : String(v)]),
        ),
      };
      const current = c().decodeContext(
        await api(
          "initiatives/recovery-context?" + new URLSearchParams(params),
          undefined,
          controller.signal,
          guard,
          actor,
        ),
        action,
        selected,
        actor,
      );
      const s = {
        recordId: id,
        key: crypto.randomUUID(),
        action,
        routeProject,
        ideaId,
        original: current.project,
        originalIdea: current.idea,
        sourceId,
        source: current.source,
        review: !current.canWrite,
        frozenRaw: null,
      };
      const p = c().decodePayload({
        baseline: s,
        draft: initialRaw(s, current),
        firstIntent: null,
        confirmation: null,
      });
      fence(null, generation, controller.signal);
      f().store.save(id, NAME, p);
      renderForm(p, current, actor);
    } catch (error) {
      if (error.name !== "AbortError") notice(error.message, true);
    } finally {
      if (opening === controller) opening = null;
    }
  }
  async function run(a, fn) {
    if (!live(a) || a.busy) return;
    a.busy = true;
    controls(a);
    try {
      await fn();
    } catch (error) {
      if (live(a) && !a.hidden && error.name !== "AbortError")
        notice(error.message, true);
    } finally {
      a.busy = false;
      if (live(a)) controls(a);
    }
  }
  async function read(a) {
    capture(a);
    if (a.p.firstIntent) {
      // Identity authorizes only the primary receipt, never the editable raw/source.
      // Persist its positive result before the independent current selection grant.
      const pending = f().controller.check(false),
        generation = readGeneration;
      const actor = await pending;
      fence(a, generation);
      const guard = () => live(a) && generation === readGeneration;
      const identity = c().decodeIdentity(
        await api(
          "initiatives/operation-identity",
          {
            project: state(a.p).routeProject,
            request: f().store.beforeSend(state(a.p).recordId).body,
          },
          undefined,
          guard,
          actor,
        ),
        a.p,
      );
      fence(a, generation);
      if (identity.confirmed)
        confirm(a, { type: "identity", identity, draft: a.p.draft });
    }
    const current = await guarded(a, (signal, actor, guard) =>
      context(a.p, actor, signal, guard),
    );
    a.current = current;
    if (a.p.confirmation) {
      const projectId = a.p.confirmation.receipt.project;
      if (!confirm(a, { type: "complete", current })) {
        const opener = returnFocus;
        if (state(a.p).action === "create")
          returnSelector = '[data-initiative-open="' + projectId + '"]';
        close(true);
        await open(projectId, opener);
        void mount();
        return;
      }
    }
    if (!a.p.firstIntent) {
      const p = c().decodePayload({
        ...a.p,
        baseline: { ...a.p.baseline, review: true },
      });
      f().store.save(state(p).recordId, NAME, p);
      a.p = p;
    }
    notice(
      a.p.firstIntent
        ? "Первісну дію ще не підтверджено. Вона залишається незмінною."
        : "Поточні умови прочитано. Для локального застосування відкрийте порівняння.",
    );
    controls(a);
  }
  async function write(a, retry) {
    await run(a, async () => {
      capture(a);
      const firstLive = !a.p.firstIntent;
      if (retry !== !firstLive)
        throw Error("Перевірте збережений первісний запит.");
      await guarded(a, async () => null);
      capture(a);
      if (!retry && !a.current?.canWrite) throw Error(a.current.reason);
      const p = c().freeze(a.p);
      f().store.save(state(p).recordId, NAME, p);
      a.p = p;
      const intent = f().store.beforeSend(state(p).recordId),
        generation = readGeneration;
      try {
        const ack = await api(
          intent.path.slice("/api/erp/".length),
          intent.body,
          undefined,
          () => live(a) && generation === readGeneration,
          a.actor,
        );
        fence(a, generation);
        decodeProject(ack.project);
        const identity = c().decodeAcknowledgement(ack, a.p);
        confirm(a, { type: "identity", identity, draft: a.p.draft });
      } catch (error) {
        fence(a, generation);
        if (error.status === 403) {
          await guarded(a, async () => null);
          throw error;
        }
        if (
          firstLive &&
          error.definitive &&
          ((error.status === 400 && !error.code) ||
            (error.status === 409 &&
              ["revision_conflict", "initiative_exists"].includes(error.code)))
        ) {
          capture(a);
          confirm(a, {
            type: "rejected",
            key: intent.key,
            action: state(a.p).action,
            revision: intent.revision,
            status: error.status,
            code: error.code ?? null,
            draft: a.p.draft,
          });
        }
        throw error;
      }
      await read(a);
    });
  }
  async function apply(a, current, raw, metricAccepted = false) {
    capture(a);
    const fresh = await guarded(a, (signal, actor, guard) =>
      context(a.p, actor, signal, guard),
    );
    if (JSON.stringify(fresh) !== JSON.stringify(current))
      throw Error(
        "Умови змінилися ще раз. Повторіть порівняння; введення збережено.",
      );
    const next = confirm(a, {
      type: "apply",
      current: fresh,
      draft: raw,
      key: crypto.randomUUID(),
      metricAccepted,
    });
    const actor = a.actor;
    stopComparison();
    renderForm(next, fresh, actor);
    notice(
      "Застосовано тільки локально. Перевірте поля та збережіть окремою кнопкою.",
    );
    draft.form.querySelector("[type=submit]").focus();
  }
  async function compare() {
    const a = draft;
    if (!a || a.busy || a.p.firstIntent) return;
    capture(a);
    stopComparison();
    comparisonReading = true;
    const controller = new AbortController();
    comparisonController = controller;
    const generation = comparisonGeneration;
    try {
      const current = await guarded(
        a,
        (signal, actor, guard) => context(a.p, actor, signal, guard),
        controller.signal,
      );
      const valid = () =>
        live(a) &&
        !a.hidden &&
        !controller.signal.aborted &&
        generation === comparisonGeneration;
      if (!valid()) return;
      comparisonReading = false;
      const s = state(a.p),
        raw = c().decodeRaw(a.p.draft, s.action),
        out = dialog.querySelector("[data-initiative-comparison]");
      a.current = current;
      if (!current.canWrite) {
        out.innerHTML = '<p role="alert">' + esc(current.reason) + "</p>";
        controls(a);
        return;
      }
      if (!["edit", "complete", "result_edit"].includes(s.action)) {
        out.innerHTML = `<h3>Поточні умови</h3><p>${esc(current.project?.title ?? current.idea.title)}${current.project ? " · " + states[current.project.state] : ""}</p>${current.source ? `<p>${current.source.kind === "task" ? esc(current.source.title) + " · " + esc(taskStates[current.source.status]) : "№ " + esc(current.source.number) + " · " + esc(current.source.amount) + " грн · " + esc(current.source.status)}</p>` : ""}<p>Введення збережене. Застосування змінює лише локальні версії джерел.</p>${button("Використати поточну версію для чернетки", "rebase")}${button("Повернутися до чернетки", "compare-cancel")}`;
        out.querySelector("[data-initiative-act=rebase]").onclick = (e) => {
          e.stopPropagation();
          if (valid())
            void run(a, () =>
              apply(a, current, c().decodeRaw(a.p.draft, s.action)),
            );
        };
        return;
      }
      const keys = s.action === "edit" ? planKeys : resultKeys,
        base = projection(s.original, keys),
        mine = localValues(a.form, keys),
        latest = current.project;
      formBaseline = s.original;
      const mountComparison = (values, metricAccepted = false) => {
        if (!valid()) return;
        out.replaceChildren();
        comparisonHandle = window.NativeConflictComparison.mount(out, {
          base,
          mine: values,
          server: projection(latest, keys),
          fields: editorFields(s.action, latest),
          title: "Узгодити зміни проєкту",
          onCancel: () => {
            if (valid()) cancelComparison();
          },
          onApply: (merged) => {
            if (!valid()) return;
            const next = { ...c().decodeRaw(a.p.draft, s.action) };
            for (const k of keys) next[k] = String(merged[k] ?? "");
            void run(a, () => apply(a, current, next, metricAccepted));
          },
        });
        controls(a);
      };
      if (
        s.action !== "edit" &&
        c().metricKey(s.original) !== c().metricKey(latest)
      ) {
        out.innerHTML = `<h3 tabindex="-1">Показник проєкту змінився</h3><p>Зараз: ${esc(latest.metric || "Без показника")} · ${esc(latest.metricUnit)}. Попередній факт лишається у чернетці; повторно введіть факт для нового показника.</p>${latest.metric ? field("Факт для поточного показника", "newFact", "", 'inputmode="decimal"') : ""}<button type="button" class="btn soft" data-kpi-confirm>Підтвердити поточний показник</button>`;
        out.querySelector("h3").focus();
        out.querySelector("[data-kpi-confirm]").onclick = () => {
          if (!valid()) return;
          const input = out.querySelector("[name=newFact]"),
            value = input ? decimalValue(input.value) : null;
          if (input && (!value || !money(value))) {
            input.setCustomValidity("Введіть десяткове число до 4 знаків.");
            input.reportValidity();
            return;
          }
          mountComparison({ ...mine, factValue: value }, true);
        };
      } else mountComparison(mine);
      notice(
        "Порівняння готове. Виберіть потрібні значення й застосуйте їх локально.",
      );
    } catch (error) {
      if (live(a) && !a.hidden && error.name !== "AbortError")
        notice(error.message, true);
    } finally {
      comparisonReading = false;
      if (live(a)) controls(a);
    }
  }
  function cancelComparison() {
    stopComparison();
    dialog?.querySelector("[data-initiative-comparison]")?.replaceChildren();
    if (draft) controls(draft);
    notice("Введення збережено. За потреби повторіть порівняння.");
    dialog?.querySelector("[data-initiative-act=compare]")?.focus();
  }
  async function display(path, read) {
    const generation = ++readGeneration,
      route = location.hash,
      controller = new AbortController();
    opening = controller;
    const guard = () =>
      generation === readGeneration &&
      opening === controller &&
      route === location.hash &&
      dialog?.open;
    try {
      foundation();
      await read(controller.signal, guard);
    } catch (error) {
      if (guard() && error.name !== "AbortError") {
        if ([401, 403].includes(error.status)) {
          hide();
          await f()
            .controller.check(false)
            .catch(() => {});
        } else {
          shell(
            "Проєкт",
            button(
              "Повторити читання",
              path.action,
              `data-id="${esc(path.id)}"`,
            ),
          );
          notice(error.message, true);
        }
      }
    } finally {
      if (opening === controller) opening = null;
    }
  }
  function showDetail() {
    draft = null;
    shell(project.title, detailHtml());
  }
  async function open(
    id,
    opener = dialog?.open ? returnFocus : document.activeElement,
  ) {
    if (dialog?.open && !close()) return;
    returnFocus = opener;
    pendingReturn = null;
    if (opener?.dataset?.initiativeOpen)
      returnSelector =
        '[data-initiative-open="' + opener.dataset.initiativeOpen + '"]';
    else if (!returnSelector)
      returnSelector = '[data-initiative-open="' + id + '"]';
    viewRequest = { kind: "project", id };
    shell("Проєкт", '<p role="status">Завантаження…</p>');
    await display({ action: "open-retry", id }, async (signal, guard) => {
      const actor = await session(signal, guard);
      const v = decodeProject(
        await api("initiatives/" + id, undefined, signal, guard, actor),
      );
      const o = decodeOptions(
        await api("initiatives/options", undefined, signal, guard, actor),
      );
      const selected = {
        project: id,
        idea: null,
        task: null,
        voucher: null,
        store: null,
      };
      const current = c().decodeContext(
        await api(
          "initiatives/recovery-context?" +
            new URLSearchParams({ action: "edit", project: id }),
          undefined,
          signal,
          guard,
          actor,
        ),
        "edit",
        selected,
        actor,
      );
      if (!guard()) throw canceled();
      assert(
        v.id === id &&
          v.idea === current.project.idea &&
          v.store === current.project.store,
      );
      project = v;
      idea = null;
      options = o;
      showDetail();
    });
  }
  async function create(id) {
    if (dialog?.open && !close()) return;
    returnFocus = document.activeElement;
    returnSelector = '[data-initiative-create="' + id + '"]';
    pendingReturn = null;
    viewRequest = { kind: "idea", id };
    shell("Проєкт з ідеї", '<p role="status">Завантаження…</p>');
    await display({ action: "create-retry", id }, async (signal, guard) => {
      const actor = await session(signal, guard);
      const i = decodeIdea(
        await api("initiatives/ideas/" + id, undefined, signal, guard, actor),
      );
      const o = decodeOptions(
        await api("initiatives/options", undefined, signal, guard, actor),
      );
      const check = f().controller.check(false),
        generation = readGeneration;
      await check;
      fence(null, generation, signal);
      const record = await c().recordId(null, id);
      fence(null, generation, signal);
      if (
        f()
          .store.entries()
          .some((e) => e.id === record)
      ) {
        close(true);
        f().open();
        return;
      }
      idea = i;
      options = o;
      project = null;
      if (i.project) {
        opening = null;
        await open(i.project);
        return;
      }
      opening = null;
      await begin("create");
    });
  }
  let selection = null;
  async function choose(purpose, q = "", page = 1) {
    await display(
      { action: "open-retry", id: project.id },
      async (signal, guard) => {
        const value = await api(
          "initiatives/" +
            project.id +
            "/candidates?" +
            new URLSearchParams({ purpose, q, page }),
          undefined,
          signal,
          guard,
        );
        assert(object(value) && value.purpose === purpose);
        pageData(value, (v) => {
          assert(object(v));
          if (purpose === "tasks")
            assert(
              string(v.id) &&
                string(v.title) &&
                Object.hasOwn(taskStates, v.status) &&
                revision(v.revision),
            );
          else
            assert(
              integer(v.id) &&
                string(v.number) &&
                string(v.date) &&
                money(v.amount) &&
                string(v.category) &&
                integer(v.revision),
            );
        });
        if (!guard()) throw canceled();
        selection = value;
        shell(
          purpose === "tasks" ? "Пов’язати стару задачу" : "Пов’язати витрату",
          `<form class="initiative-search" data-purpose="${purpose}"><label class="initiative-field">Пошук<input name="q" maxlength="250" value="${esc(q)}"></label><button class="btn" type="submit">Знайти</button></form>${value.items.map((v, i) => `<article class="initiative-item"><strong>${purpose === "tasks" ? esc(v.title) : "№ " + esc(v.number) + " · " + esc(v.amount) + " грн"}</strong><p>${purpose === "tasks" ? taskStates[v.status] : esc(v.category) + " · " + esc(v.date)}</p>${button("Пов’язати", "choose", `data-index="${i}"`)}</article>`).join("") || "<p>Доступних записів немає.</p>"}${value.pages > 1 ? `<div class="initiative-actions">${value.page > 1 ? button("Попередня", "candidate-page", `data-page="${value.page - 1}" data-q="${esc(q)}"`) : ""}<span>${value.page} / ${value.pages}</span>${value.page < value.pages ? button("Наступна", "candidate-page", `data-page="${value.page + 1}" data-q="${esc(q)}"`) : ""}</div>` : ""}${button("До проєкту", "back")}`,
        );
        dialog.querySelector(".initiative-search").onsubmit = (e) => {
          e.preventDefault();
          void choose(purpose, new FormData(e.target).get("q"));
        };
      },
    );
  }
  async function sourceExpense(id) {
    await display(
      { action: "open-retry", id: project.id },
      async (signal, guard) => {
        const actor = await session(signal, guard),
          selected = {
            project: project.id,
            idea: null,
            task: null,
            voucher: id,
            store: null,
          },
          path =
            "initiatives/recovery-context?" +
            new URLSearchParams({
              action: "expense_detach",
              project: project.id,
              voucher: id,
            });
        const sourceGrant = async () => {
          const current = c().decodeContext(
            await api(path, undefined, signal, guard, actor),
            "expense_detach",
            selected,
            actor,
          );
          if (
            current.source?.kind !== "expense" ||
            current.source.id !== id ||
            !current.source.linkedHere
          )
            throw Object.assign(
              Error("Джерело більше не доступне цьому проєкту."),
              { status: 403 },
            );
        };
        await sourceGrant();
        const v = await api("vouchers/" + id, undefined, signal, guard, actor);
        assert(
          object(v) &&
            v.id === id &&
            v.kind === "expense" &&
            string(v.status) &&
            string(v.date) &&
            money(v.total) &&
            object(v.payload),
        );
        await sourceGrant();
        if (!guard()) throw canceled();
        shell(
          "Джерело витрати № " + String(v.id).padStart(6, "0"),
          `<p>Лише перегляд бухгалтерського джерела.</p><dl class="initiative-facts"><div><dt>Дата</dt><dd>${esc(v.date)}</dd></div><div><dt>Сума</dt><dd>${esc(v.total)} грн</dd></div><div><dt>Стан</dt><dd>${esc(v.status)}</dd></div><div><dt>Стаття</dt><dd>${esc(v.payload.category || "Інше")}</dd></div><div><dt>Примітка</dt><dd>${esc(v.note || "Не зазначено")}</dd></div></dl>${button("До проєкту", "back")}`,
        );
      },
    );
  }
  async function click(e) {
    const el = e.target.closest("[data-initiative-act]");
    if (!el) return;
    const act = el.dataset.initiativeAct;
    try {
      if (act === "close" || (act === "back" && draft)) {
        close();
        return;
      }
      if (act === "access-cancel") {
        readGeneration++;
        stopComparison();
        f()?.controller.dismiss();
        if (draft) controls(draft);
        return;
      }
      if (act === "access") {
        if (draft) await guarded(draft, async () => null);
        else if (viewRequest?.kind === "project") await open(viewRequest.id);
        else if (viewRequest?.kind === "idea") await create(viewRequest.id);
        return;
      }
      if (draft?.busy || draft?.reading) return;
      if (act === "compare-cancel") {
        cancelComparison();
        return;
      }
      if (act === "compare") {
        await compare();
        return;
      }
      if (act === "retry") {
        if (draft) await write(draft, true);
        return;
      }
      if (act === "read") {
        if (draft) await run(draft, () => read(draft));
        return;
      }
      if (act === "source-idea") {
        if (!close()) e.preventDefault();
        return;
      }
      if (act === "open-retry") {
        await open(el.dataset.id);
        return;
      }
      if (act === "create-retry") {
        await create(el.dataset.id);
        return;
      }
      if (act === "back" || act === "refresh") {
        await open(project.id);
        return;
      }
      if (act === "page") {
        const id = project.id;
        await display({ action: "open-retry", id }, async (signal, guard) => {
          const v = decodeProject(
            await api(
              "initiatives/" +
                id +
                "?" +
                new URLSearchParams({
                  tasksPage:
                    el.dataset.kind === "tasks"
                      ? el.dataset.page
                      : project.tasks.page,
                  expensesPage:
                    el.dataset.kind === "expenses"
                      ? el.dataset.page
                      : project.expenses.page,
                }),
              undefined,
              signal,
              guard,
            ),
          );
          if (guard()) {
            assert(v.id === id && v.idea === project.idea);
            project = v;
            showDetail();
          }
        });
        return;
      }
      if (
        [
          "edit",
          "start",
          "complete",
          "result_edit",
          "cancel",
          "task_create",
        ].includes(act)
      ) {
        await begin(act);
        return;
      }
      if (act === "task-status") {
        await begin("task_update", el.dataset.id);
        return;
      }
      if (act === "expense_detach") {
        await begin(act, Number(el.dataset.id));
        return;
      }
      if (act === "choose-tasks" || act === "choose-expenses") {
        await choose(act === "choose-tasks" ? "tasks" : "expenses");
        return;
      }
      if (act === "candidate-page") {
        await choose(selection.purpose, el.dataset.q, el.dataset.page);
        return;
      }
      if (act === "choose") {
        const v = selection.items[Number(el.dataset.index)];
        await begin(
          selection.purpose === "tasks" ? "task_link" : "expense_attach",
          v.id,
        );
        return;
      }
      if (act === "source-expense") await sourceExpense(Number(el.dataset.id));
    } catch (error) {
      if (error.name !== "AbortError") notice(error.message, true);
    }
  }
  async function mount(page = 1) {
    const host = document.querySelector("[data-initiatives]");
    if (!host || !window.TSUKENYA_SERVER || window.TSUKENYA_ROLE !== "owner")
      return;
    register();
    const gen = ++listGeneration,
      path = location.hash,
      guard = () =>
        host.isConnected && gen === listGeneration && path === location.hash;
    preserveListFocus(host);
    host.innerHTML = '<p role="status">Завантаження проєктів…</p>';
    try {
      const v = await api(
        "initiatives?page=" + page,
        undefined,
        undefined,
        guard,
      );
      pageData(v, (p) =>
        assert(
          object(p) &&
            uuid(p.id) &&
            string(p.title) &&
            Object.hasOwn(states, p.state) &&
            integer(p.revision),
        ),
      );
      if (!guard()) return;
      host.innerHTML = `<h3>Проєкти та результати · ${v.total}</h3><p class="muted">Проєкти з обраних ідей: план, задачі, пов’язані витрати та результат.</p>${button("Локальні чернетки проєктів", "recover")}${v.items.map((p) => `<article class="initiative-item"><strong>${esc(p.title)}</strong><p>${states[p.state]}</p><button class="btn soft" data-initiative-open="${p.id}">Відкрити проєкт</button></article>`).join("") || "<p>Проєктів поки немає.</p>"}${v.pages > 1 ? `<div class="initiative-actions">${v.page > 1 ? `<button class="btn soft" data-initiative-list-page="${v.page - 1}">Попередня</button>` : ""}<span>${v.page} / ${v.pages}</span>${v.page < v.pages ? `<button class="btn soft" data-initiative-list-page="${v.page + 1}">Наступна</button>` : ""}</div>` : ""}`;
      if (
        pendingReturn &&
        !dialog?.open &&
        pendingReturn.route === location.hash
      ) {
        const target = document.querySelector(pendingReturn.selector);
        if (target && document.activeElement === pendingReturn.anchor)
          target.focus();
        pendingReturn = null;
      }
    } catch (error) {
      if (guard()) {
        host.replaceChildren();
        if (error.name !== "AbortError" && ![401, 403].includes(error.status))
          host.innerHTML = `<p role="alert">${esc(error.message)}</p><button class="btn soft" data-initiative-list-page="${page}">Повторити читання</button>`;
      }
    }
  }
  document.addEventListener("click", (e) => {
    const b = e.target.closest(
      "[data-initiative-open],[data-initiative-create],[data-initiative-list-page],[data-initiative-act=recover]",
    );
    if (!b) return;
    e.preventDefault();
    if (b.dataset.initiativeOpen) void open(b.dataset.initiativeOpen);
    else if (b.dataset.initiativeCreate)
      void create(b.dataset.initiativeCreate);
    else if (b.dataset.initiativeListPage)
      void mount(Number(b.dataset.initiativeListPage));
    else {
      try {
        foundation();
        f().open();
      } catch (error) {
        notice(error.message, true);
      }
    }
  });
  window.addEventListener("tsukenya:native-conflict-ready", register);
  window.addEventListener("beforeunload", (e) => {
    if (draft) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
  window.BusinessInitiatives = {
    mount,
    canLeave: () => !dialog?.open || close(),
    pending: () => !!opening || !!dialog?.open,
    taskLink: (id) =>
      uuid(id)
        ? `<button class="btn soft" data-initiative-open="${id}">Проєкт</button>`
        : "",
  };
})();
