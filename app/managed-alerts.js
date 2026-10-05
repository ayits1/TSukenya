/* Managed lifecycle: durable raw fields and immutable requests; P0 guards every reveal. */
(() => {
  "use strict";
  const NAME = "native-managed-alert-v1";
  const states = {
    open: "Не прийнято",
    accepted: "Прийнято в роботу",
    deferred: "Відкладено",
    completed: "Роботу виконано",
    resolved: "Причину усунено",
  };
  const labels = {
    accept: "Прийняти",
    defer: "Відкласти до дати",
    complete: "Виконано",
    resume: "Повернути в роботу",
  };
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
  const f = () => window.NativeDraftRecovery,
    c = () => window.NativeManagedAlertPersistence;
  const state = (p) => c().decodeState(p.baseline),
    recordId = (id) => "managed_" + id;
  const canceled = () => new DOMException("Скасовано", "AbortError");
  const binding = (s) =>
    JSON.stringify([
      s.draftOwner,
      s.draftSession,
      s.role,
      s.storeId,
      s.networkOwner,
    ]);
  let configured,
    active = null,
    registered = false,
    generation = 0,
    opening = null,
    authorized = null,
    restoreSignal = null,
    warm = false;
  const records = new Map();
  function system(t) {
    return !!(t._alertKey || t._priceTask);
  }
  function taskState(t) {
    return (
      t._alertWorkState ||
      (t.status === "done"
        ? "completed"
        : t.status === "doing"
          ? "accepted"
          : "open")
    );
  }
  function row(t) {
    if (!system(t)) return "";
    const current = taskState(t),
      running = t._alertKey ? !!t._alertActive : t.status !== "done";
    const p = records.get(t.id),
      blocked = !!p || active?.taskId === t.id;
    return `<small class="task-date">${esc(states[current] || states.open)}${t._alertKey ? " · " + (running ? "Облікова умова активна" : "Причину усунено") : ""}${t._alertAcceptedBy ? " · " + esc(t._alertAcceptedBy) : ""}</small>${current === "deferred" ? `<small class="task-date">Повернутися ${esc(t._alertDeferredUntil)} · ${esc(t._alertDeferReason)}</small>` : ""}${t.permissions?.canEdit && (running || t._priceTask) ? `<span class="managed-alert-actions"><button type="button" class="btn soft" data-alert-action="${current === "completed" ? "resume" : current === "accepted" ? "complete" : "accept"}" data-alert-id="${esc(t.id)}" ${blocked ? "disabled" : ""}>${current === "completed" ? labels.resume : current === "accepted" ? labels.complete : labels.accept}</button>${running ? `<button type="button" class="btn soft" data-alert-action="defer" data-alert-id="${esc(t.id)}" ${blocked ? "disabled" : ""}>Відкласти</button>` : ""}</span>` : ""}${p ? `<button type="button" class="btn soft" data-alert-action="restore" data-alert-id="${esc(t.id)}">Відкрити локальну чернетку</button>` : ""}`;
  }
  function live(a) {
    return active === a && a.d.open && a.d.isConnected;
  }
  function gate(a, token, signal) {
    if (signal?.aborted || generation !== token || (a && !live(a)))
      throw canceled();
  }
  function hide() {
    ++generation;
    authorized = null;
    const rowsChanged = records.size > 0;
    for (const id of records.keys()) configured?.unpin?.(id);
    records.clear();
    if (active && live(active)) {
      const a = active;
      a.hidden = true;
      a.current = null;
      a.d.querySelector("#managedAlertTitle").textContent =
        "Локальна чернетка призупинена";
      a.body.hidden = true;
      a.foot.hidden = true;
      a.access.hidden = false;
      a.access.querySelector("[data-alert-access]").disabled = a.busy;
    }
    // P0 suspends every codec before each read, including inline draft mounts.
    // Only changed managed rows need a shell render; otherwise it remounts P0 forever.
    if (rowsChanged) configured?.render();
  }
  function show(a) {
    a.hidden = false;
    records.set(a.taskId, a.p);
    configured.pin?.(a.taskId);
    a.d.querySelector("#managedAlertTitle").textContent =
      labels[state(a.p).action];
    a.body.hidden = false;
    a.foot.hidden = false;
    a.access.hidden = true;
    controls(a);
  }
  async function request(path, method, body, session, signal, guard) {
    const check = () => {
      if (signal?.aborted || !guard()) throw canceled();
    };
    check();
    let actor;
    try {
      actor = await window.PortalApi.session(signal);
    } catch (error) {
      check();
      if ([401, 403].includes(error.status))
        await f()
          .controller.check(false)
          .catch(() => {});
      throw error;
    }
    check();
    if (binding(session) !== binding(actor)) {
      await f()
        .controller.check(false)
        .catch(() => {});
      throw canceled();
    }
    check();
    let response;
    try {
      response = await fetch(path, {
        method,
        signal,
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": actor.csrf,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      check();
      throw Error(
        "Відповідь не отримано. Первісний запит і введення збережено.",
      );
    }
    check();
    if (response.status === 401) {
      window.dispatchEvent(new Event("tsukenya:session-invalidated"));
      throw Object.assign(Error("Сеанс завершено."), { status: 401 });
    }
    let value;
    try {
      value = await response.json();
    } catch {
      check();
      throw Object.assign(
        Error("Некоректна відповідь. Первісний запит і введення збережено."),
        { status: response.status },
      );
    }
    check();
    if (!response.ok)
      throw Object.assign(
        Error(
          typeof value?.error === "string" ? value.error : "Дія недоступна.",
        ),
        {
          status: response.status,
          code: value?.code,
          definitive:
            !!value &&
            typeof value === "object" &&
            !Array.isArray(value) &&
            typeof value.error === "string",
        },
      );
    return value;
  }
  async function context(id, session, signal, guard) {
    const value = await request(
      "/api/erp/alerts/tasks/" + id + "/recovery-context",
      "GET",
      undefined,
      session,
      signal,
      guard,
    );
    if (!guard() || signal?.aborted) throw canceled();
    return c().decodeContext(value, id, session);
  }
  function register() {
    if (registered) return;
    if (!f() || !c())
      throw Error(
        "Модуль локальних чернеток ще завантажується. Повторіть відкриття.",
      );
    f().register({
      name: NAME,
      version: 1,
      label: "Робота над системною задачею",
      decode: c().decodePayload,
      confirm: c().confirmPayload,
      suspend: hide,
      authorize: async (p, session, signal) => {
        const t = generation,
          route = location.hash,
          s = state(p);
        const current = await context(
          s.original.id,
          session,
          signal,
          () => generation === t && location.hash === route,
        );
        gate(null, t, signal);
        authorized = { recordId: s.recordId, session, context: current };
        return true;
      },
      restore: (p, signal) => {
        if (signal.aborted || authorized?.recordId !== state(p).recordId)
          throw canceled();
        if (active) close(active, true);
        p = c().decodePayload(p);
        p.baseline = { ...p.baseline, review: true };
        f().store.save(state(p).recordId, NAME, p);
        create(p, authorized.session, authorized.context);
        restoreSignal = signal;
      },
    });
    registered = true;
    f().controller.subscribe(() => {
      if (f().controller.snapshot().state !== "ready") return;
      if (restoreSignal) {
        const signal = restoreSignal;
        restoreSignal = null;
        queueMicrotask(() => {
          if (!signal.aborted) {
            f().close();
            active?.form.querySelector("input,textarea")?.focus();
          }
        });
      }
      if (!active?.hidden || warm || active.busy) return;
      const a = active;
      if (
        !f()
          .store.entries()
          .some((e) => e.id === state(a.p).recordId)
      ) {
        close(a, true);
        return;
      }
      warm = true;
      void guarded(a, async () => null)
        .catch(() => {})
        .finally(() => {
          warm = false;
        });
    });
  }
  function capture(a) {
    if (!live(a) || a.hidden)
      throw Error("Спочатку підтвердьте доступ до форми.");
    const raw =
      state(a.p).action === "defer"
        ? {
            until: a.form.elements.until.value,
            reason: a.form.elements.reason.value,
          }
        : { until: "", reason: "" };
    const p = c().decodePayload({ ...a.p, draft: raw });
    f().store.save(state(p).recordId, NAME, p);
    a.p = p;
    records.set(a.taskId, p);
    return p;
  }
  function confirm(a, event) {
    const next = c().confirmPayload(a.p, event);
    f().store.confirmed(state(a.p).recordId, event); // Atomic durable transition BEFORE local model adoption.
    if (next) {
      a.p = next;
      records.set(a.taskId, next);
    } else {
      records.delete(a.taskId);
      configured.unpin?.(a.taskId);
    }
    return next;
  }
  async function guarded(a, read) {
    if (!live(a)) throw canceled();
    const pending = f().controller.verifyRead(
      state(a.p).recordId,
      async (signal, session) => {
        const t = generation;
        gate(a, t, signal);
        const result = await read(
          signal,
          session,
          () => live(a) && generation === t,
        );
        gate(a, t, signal);
        return result;
      },
    );
    const t = generation;
    const result = await pending;
    gate(a, t);
    if (!result)
      throw Error(
        "Доступ або поточні умови не підтверджено. Повторіть перевірку доступу.",
      );
    a.session = result.session;
    if (authorized?.recordId === state(a.p).recordId)
      a.current = authorized.context;
    show(a);
    return result.value;
  }
  function problem(a, e) {
    if (!live(a) || a.hidden || e.name === "AbortError") return;
    a.error.textContent = e.message;
    a.error.focus({ preventScroll: true });
    a.error.scrollIntoView({ block: "nearest" });
  }
  function controls(a) {
    const s = state(a.p),
      first = !!a.p.firstIntent,
      confirmed = !!a.p.confirmation;
    const permitted =
      a.current?.canAct &&
      (a.current.task.active ||
        (s.original.kind === "reprint" && s.action === "resume"));
    a.foot.querySelector("[type=submit]").disabled =
      a.busy || a.hidden || first || confirmed || s.review || !permitted;
    a.foot.querySelector("[data-alert-retry]").hidden = !first;
    a.foot.querySelector("[data-alert-retry]").disabled =
      a.busy || !a.current?.canAct;
    a.foot.querySelector("[data-alert-reload]").disabled = a.busy;
    a.foot.querySelector("[data-alert-apply]").hidden =
      first || (!s.review && !confirmed);
    a.foot.querySelector("[data-alert-apply]").disabled =
      a.busy || !a.current || !permitted;
    a.d.querySelector("[data-alert-access]").disabled = a.busy;
    const current = a.current?.task;
    a.status.textContent = first
      ? "Результат первісного запиту невідомий. Перевірте підтвердження або повторіть тільки цей запит."
      : confirmed
        ? "Первісну дію підтверджено. Доступне лише читання або окреме застосування нового введення."
        : s.review
          ? "Чернетку відновлено. Звірте поточні умови та застосуйте їх локально перед окремим збереженням."
          : "Введення зберігається локально у цій вкладці.";
    const describe = (task) =>
      `${task.title} · ${task.store === null ? "Вся мережа" : "Магазин № " + task.store} · ${states[task.workState]}, цикл ${task.cycle}; ${task.active ? "умова активна" : "умова неактивна"}${task.until ? "; повернення " + task.until + ", причина: " + task.reason : ""}`;
    a.comparison.textContent = current
      ? `Початково: ${describe(s.original)}. Зараз: ${describe(current)}. ${permitted ? "" : "Ця дія зараз недоступна."}`
      : "Поточні умови ще не підтверджено.";
  }
  async function read(a) {
    capture(a); // Never retire a request while newer visible raw input failed storage.
    if (a.p.firstIntent) {
      const identity = await guarded(a, async (signal, session, guard) => {
        const p = a.p;
        const value = await request(
          "/api/erp/alerts/tasks/" + a.taskId + "/identity",
          "POST",
          { request: p.firstIntent.body },
          session,
          signal,
          guard,
        );
        return c().decodeIdentity(value, p);
      });
      if (identity.confirmed)
        confirm(a, { type: "identity", identity, draft: a.p.draft });
    }
    // Identity confirmation is already durable even if this independent GET fails.
    let current = await guarded(a, (signal, session, guard) =>
      context(a.taskId, session, signal, guard),
    );
    a.current = current;
    if (a.p.confirmation) {
      await guarded(a, async () => {
        await configured.refresh(a.taskId);
      });
      current = await guarded(a, (signal, session, guard) =>
        context(a.taskId, session, signal, guard),
      );
      a.current = current;
      if (!confirm(a, { type: "complete", current: current.task })) {
        configured.toast(
          "Первісну дію підтверджено. Показано актуальний стан задачі.",
        );
        close(a, true);
        return;
      }
    } else if (!a.p.firstIntent) {
      const next = c().decodePayload({
        ...a.p,
        baseline: { ...a.p.baseline, review: true },
      });
      f().store.save(state(next).recordId, NAME, next);
      a.p = next;
    }
    controls(a);
  }
  async function work(a, action) {
    if (!live(a) || a.busy) return;
    a.busy = true;
    a.error.textContent = "";
    controls(a);
    try {
      await action();
    } catch (error) {
      if (error.status === 403 && live(a))
        await guarded(a, async () => null).catch(() => {});
      problem(a, error);
    } finally {
      a.busy = false;
      if (live(a)) controls(a);
    }
  }
  async function write(a, retry) {
    await work(a, async () => {
      capture(a);
      await guarded(a, async () => null);
      if (!a.current?.canAct)
        throw Error(
          "Немає доступу до цієї дії. Перевірте підтвердження без повтору запиту.",
        );
      if (
        !retry &&
        (!a.current?.canAct ||
          (!a.current.task.active &&
            !(
              a.current.task.kind === "reprint" &&
              state(a.p).action === "resume"
            )))
      )
        throw Error("Ця дія зараз недоступна.");
      if (
        !a.p.firstIntent &&
        a.current.task.revision !== state(a.p).original.revision
      ) {
        const changed = c().decodePayload({
          ...a.p,
          baseline: { ...a.p.baseline, review: true },
        });
        f().store.save(state(changed).recordId, NAME, changed);
        a.p = changed;
        throw Error(
          "Умови задачі змінилися. Звірте їх і застосуйте локально перед окремим записом.",
        );
      }
      const firstLive = !a.p.firstIntent;
      const p = c().decodePayload({
        ...a.p,
        firstIntent: c().firstIntent(a.p),
      });
      f().store.save(state(p).recordId, NAME, p);
      a.p = p;
      const intent = f().store.beforeSend(state(p).recordId);
      const t = generation;
      try {
        await request(
          intent.path,
          "POST",
          intent.body,
          a.session,
          undefined,
          () => live(a) && !a.hidden && generation === t,
        );
      } catch (error) {
        gate(a, t);
        if (
          firstLive &&
          error.definitive &&
          ((error.status === 400 && !error.code) ||
            (error.status === 409 && error.code === "revision_conflict"))
        ) {
          capture(a);
          const initial = state(a.p);
          confirm(a, {
            type: "rejected",
            key: initial.key,
            task: initial.original.id,
            action: initial.action,
            revision: initial.original.revision,
            status: error.status,
            code: error.code ?? null,
            draft: a.p.draft,
          });
        }
        throw error;
      }
      gate(a, t);
      // ACK does not substitute for immutable creator-bound receipt identity.
      await read(a);
    });
  }
  function close(a, force = false) {
    if (!live(a)) return true;
    if (!force && !a.hidden) {
      try {
        capture(a);
      } catch (error) {
        problem(a, error);
        return false;
      }
    }
    ++generation;
    a.d.close();
    return true;
  }
  function create(p, session, current) {
    const s = state(p),
      opener = document.activeElement,
      d = document.createElement("dialog");
    d.className = "trade-dialog small";
    d.dataset.managedDraft = "";
    d.setAttribute("aria-labelledby", "managedAlertTitle");
    d.innerHTML = `<div class="trade-dialog-head"><h2 id="managedAlertTitle">${esc(labels[s.action])}</h2><button type="button" class="btn soft" data-alert-close>Закрити</button></div><div class="trade-dialog-body"><p>${esc(s.original.title)}</p><p class="trade-caption">Ця дія змінює стан роботи над задачею. Причину сповіщення потрібно усунути окремо.</p><form id="managedAlertForm">${s.action === "defer" ? '<label class="form-field">Повернутися до задачі<input name="until" type="date" required></label><label class="form-field">Причина відкладення<textarea name="reason" required maxlength="500" rows="3"></textarea></label>' : "<p>Підтвердіть дію для цієї системної задачі.</p>"}</form><p data-alert-comparison class="trade-caption"></p><p data-alert-error class="trade-error" role="alert" tabindex="-1"></p><p data-alert-status role="status" aria-live="polite"></p></div><div class="trade-dialog-foot"><button type="submit" form="managedAlertForm" class="btn">${esc(labels[s.action])}</button><button type="button" class="btn soft" data-alert-retry>Підтвердити первісну дію</button><button type="button" class="btn soft" data-alert-reload>Перевірити підтвердження й умови</button><button type="button" class="btn soft" data-alert-apply>Застосувати умови локально</button></div><section class="trade-dialog-body" data-alert-gate hidden><p role="status">Форму приховано до підтвердження доступу.</p><button type="button" class="btn soft" data-alert-access>Перевірити доступ до форми</button><button type="button" class="btn soft" data-alert-cancel>Скасувати читання</button></section>`;
    document.body.append(d);
    const a = {
      d,
      form: d.querySelector("form"),
      body: d.querySelector(".trade-dialog-body"),
      foot: d.querySelector(".trade-dialog-foot"),
      access: d.querySelector("[data-alert-gate]"),
      error: d.querySelector("[data-alert-error]"),
      status: d.querySelector("[data-alert-status]"),
      comparison: d.querySelector("[data-alert-comparison]"),
      taskId: s.original.id,
      p,
      session,
      current,
      hidden: false,
      busy: false,
    };
    active = a;
    records.set(a.taskId, p);
    configured.pin?.(a.taskId);
    if (s.action === "defer") {
      a.form.elements.until.min = new Intl.DateTimeFormat("sv-SE", {
        timeZone: "Europe/Kyiv",
      }).format(new Date(Date.now() + 86400000));
      a.form.elements.until.value = p.draft.until;
      a.form.elements.reason.value = p.draft.reason;
    }
    a.form.oninput = () => {
      try {
        capture(a);
        a.error.textContent = "";
      } catch (e) {
        problem(a, e);
      }
    };
    a.form.onsubmit = (e) => {
      e.preventDefault();
      void write(a, false);
    };
    d.querySelector("[data-alert-close]").onclick = () => close(a);
    d.oncancel = (e) => {
      e.preventDefault();
      close(a);
    };
    d.querySelector("[data-alert-retry]").onclick = () => void write(a, true);
    d.querySelector("[data-alert-reload]").onclick = () =>
      void work(a, () => read(a));
    d.querySelector("[data-alert-apply]").onclick = () =>
      void work(a, async () => {
        capture(a);
        const current = await guarded(a, (signal, actor, guard) =>
          context(a.taskId, actor, signal, guard),
        );
        if (a.p.firstIntent) throw Error("Первісну дію ще не підтверджено.");
        a.current = current;
        if (
          !current.canAct ||
          (!current.task.active &&
            !(
              current.task.kind === "reprint" && state(a.p).action === "resume"
            ))
        )
          throw Error("Ця дія зараз недоступна.");
        confirm(a, {
          type: "apply",
          current: current.task,
          draft: a.p.draft,
          key: crypto.randomUUID(),
        });
        a.status.textContent =
          "Поточні умови застосовано локально. Для запису натисніть окрему кнопку дії.";
      });
    d.querySelector("[data-alert-access]").onclick = () =>
      void work(a, () => guarded(a, async () => null));
    d.querySelector("[data-alert-cancel]").onclick = () => {
      ++generation;
      f().controller.dismiss();
    };
    d.addEventListener(
      "close",
      () => {
        ++generation;
        if (active === a) active = null;
        d.remove();
        configured.render();
        if (opener?.isConnected) opener.focus();
        else
          document
            .querySelector(`[data-task-id="${CSS.escape(a.taskId)}"] button`)
            ?.focus();
      },
      { once: true },
    );
    d.showModal();
    controls(a);
    a.form.querySelector("input")?.focus();
    configured.render();
    return a;
  }
  async function handle(element) {
    if (!configured || opening || active) return;
    const id = element.dataset.alertId,
      operation = element.dataset.alertAction;
    if (operation === "recovery") {
      try {
        register();
        f().open();
      } catch (error) {
        configured.toast(error.message);
      }
      return;
    }
    const task =
      configured.lookup?.(id) || configured.tasks().find((t) => t.id === id);
    if (!task || !system(task)) return;
    try {
      register();
    } catch (error) {
      configured.toast(error.message);
      return;
    }
    const requestController = new AbortController();
    opening = requestController;
    const route = location.hash;
    try {
      const actorPromise = f().controller.check(false),
        t = generation;
      const actor = await actorPromise;
      gate(null, t, requestController.signal);
      const guard = () =>
        generation === t &&
        opening === requestController &&
        location.hash === route;
      if (!guard()) throw canceled();
      if (
        f()
          .store.entries()
          .some((e) => e.id === recordId(id))
      ) {
        f().open();
        return;
      }
      const current = await context(id, actor, requestController.signal, guard);
      gate(null, t, requestController.signal);
      if (!current.canAct || !c().actions.includes(operation))
        throw Error("Дія недоступна. Оновіть список.");
      const p = c().decodePayload({
        baseline: {
          recordId: recordId(id),
          key: crypto.randomUUID(),
          original: current.task,
          action: operation,
          review: false,
        },
        draft: { until: "", reason: "" },
        firstIntent: null,
        confirmation: null,
      });
      f().store.save(recordId(id), NAME, p);
      create(p, actor, current);
    } catch (e) {
      if (e.name !== "AbortError") configured.toast(e.message);
    } finally {
      if (opening === requestController) opening = null;
    }
  }
  function configure(options) {
    configured = options;
  }
  function canLeave() {
    opening?.abort();
    opening = null;
    if (active && !close(active)) return false;
    ++generation;
    return true;
  }
  window.addEventListener("tsukenya:native-conflict-ready", () => {
    try {
      register();
    } catch {}
  });
  window.ManagedAlerts = {
    row,
    system,
    configure,
    handle,
    canLeave,
    pending: () => !!opening || !!active,
    pinned: () => [...records.keys()],
    register,
  };
})();
