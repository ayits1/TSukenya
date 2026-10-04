/* Scalar budget count: same-session raw recovery, independent count revision. */
(() => {
  "use strict";
  const NAME = "native-template-v1";
  let active = null,
    opening = 0,
    registered = false,
    warm = false,
    lastAuthorization = null,
    restoreSignal = null;
  const foundation = () => window.NativeDraftRecovery;
  const codec = () => window.NativeTemplatePersistence;
  const adapter = () => window.NativeBudgetTemplateEditor;
  const canceled = () => new DOMException("Скасовано", "AbortError");
  const live = (a) => active === a && a.d.open && a.d.isConnected;
  const sessionKey = (s) =>
    JSON.stringify([
      s.draftOwner,
      s.draftSession,
      s.role,
      s.storeId,
      s.networkOwner,
    ]);
  async function request(method, body, signal, guard, binding) {
    const gate = () => {
      if (signal?.aborted || (guard && !guard())) throw canceled();
    };
    gate();
    let session;
    try {
      session = await window.PortalApi.session(signal);
    } catch (error) {
      gate();
      if ([401, 403].includes(error.status))
        await foundation()
          .controller.check(false)
          .catch(() => {});
      throw error;
    }
    gate();
    if (binding && sessionKey(session) !== sessionKey(binding)) {
      await foundation()
        .controller.check(false)
        .catch(() => {});
      throw canceled();
    }
    // The final session await must not later send or expose a cancelled request.
    gate();
    let r;
    try {
      r = await fetch("/api/v1/portal/budget-template", {
        method,
        credentials: "same-origin",
        cache: "no-store",
        signal,
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": session.csrf,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      gate();
      if (error.name === "AbortError") throw error;
      throw Object.assign(
        Error(
          "Результат не підтверджено. Прочитайте поточну кількість; чернетка збережена.",
        ),
        { uncertain: method !== "GET" },
      );
    }
    gate();
    let value;
    try {
      value = await r.json();
    } catch {
      gate();
      throw Object.assign(
        Error("Некоректна відповідь сервера. Повторіть читання."),
        { uncertain: method !== "GET" },
      );
    }
    gate();
    if (r.status === 401) {
      window.dispatchEvent(new Event("tsukenya:session-invalidated"));
      location.href = "/";
    }
    if (!r.ok)
      throw Object.assign(
        Error(
          typeof value?.error === "string"
            ? value.error
            : "Дія недоступна. Чернетка збережена.",
        ),
        { status: r.status, uncertain: method !== "GET" && r.status >= 500 },
      );
    try {
      return adapter().decodeBudgetTemplate(value);
    } catch (error) {
      error.uncertain = method !== "GET";
      throw error;
    }
  }
  function hide() {
    const a = active;
    if (!a || !live(a)) return;
    a.generation++;
    a.hidden = true;
    if (!a.guarding && !a.reading) a.cancel();
    a.d.querySelector(".trade-dialog-body").hidden = true;
    a.d.querySelector("#budgetTemplateTitle").textContent =
      "Локальна чернетка призупинена";
    let gate = a.d.querySelector("[data-template-access]");
    if (!gate) {
      gate = document.createElement("section");
      gate.className = "trade-dialog-body";
      gate.dataset.templateAccess = "";
      gate.innerHTML =
        '<p role="status">Кількість приховано до підтвердження доступу.</p><button type="button" class="btn soft" data-template-access-retry>Перевірити доступ до форми</button><button type="button" class="btn soft" data-template-access-cancel>Скасувати читання</button>';
      gate.querySelector("[data-template-access-retry]").onclick = () =>
        foundation()
          .controller.check()
          .catch(() => {});
      gate.querySelector("[data-template-access-cancel]").onclick = () => {
        a.cancel();
        foundation().controller.dismiss();
      };
      a.d.append(gate);
    }
    gate.querySelector("[data-template-access-retry]").disabled = !!(
      a.guarding || a.reading
    );
    gate.querySelector("[data-template-access-cancel]").hidden = !a.reading;
  }
  function reveal(a) {
    if (!live(a)) return;
    a.hidden = false;
    a.d.querySelector(".trade-dialog-body").hidden = false;
    a.d.querySelector("#budgetTemplateTitle").textContent =
      "Планова кількість магазинів";
    a.d.querySelector("[data-template-access]")?.remove();
  }
  async function authorize(p, session, signal) {
    codec().decodeTemplatePayload(p);
    if (
      session.role !== "owner" ||
      !session.networkOwner ||
      session.storeId !== null
    )
      return false;
    await request("GET", undefined, signal, undefined, session); // Current actor/RR scalar access; never adopts revision.
    if (signal.aborted) throw canceled();
    lastAuthorization = {
      id: codec().decodeTemplateState(p.baseline).recordId,
      signal,
      session,
    };
    return true;
  }
  function register() {
    if (
      registered ||
      !foundation() ||
      !codec() ||
      !adapter() ||
      !window.NativeConflictComparison
    )
      return;
    const f = foundation();
    f.register({
      name: NAME,
      version: 1,
      label: "Кількість магазинів в орієнтирі",
      decode: codec().decodeTemplatePayload,
      authorize,
      restore: async (p, signal) => {
        const authorized = lastAuthorization;
        if (
          authorized?.signal !== signal ||
          authorized.id !== codec().decodeTemplateState(p.baseline).recordId
        )
          throw canceled();
        await open(
          codec().decodeTemplatePayload(p),
          signal,
          authorized.session,
        );
        if (!signal.aborted) restoreSignal = signal;
      },
      suspend: hide,
      confirm: codec().confirmTemplatePayload,
    });
    f.controller.subscribe(() => {
      if (f.controller.snapshot().state !== "ready") return;
      if (restoreSignal) {
        const signal = restoreSignal;
        restoreSignal = null;
        queueMicrotask(() => {
          if (!signal.aborted) {
            f.close();
            active?.input.focus();
          }
        });
      }
      const a = active;
      if (!a || !live(a) || !a.hidden || a.guarding || a.reading || warm)
        return;
      warm = true;
      const stored = f.store.entries().some((e) => e.id === a.id);
      if (!stored && a.p) {
        a.closeDenied();
        warm = false;
        return;
      }
      if (!stored && !a.binding) {
        a.retryOpen();
        warm = false;
        return;
      }
      let generation = a.generation;
      const route = location.hash,
        current = () =>
          live(a) &&
          generation === a.generation &&
          route === location.hash &&
          document.visibilityState !== "hidden",
        pending = stored
          ? f.controller.verify(a.id)
          : request("GET", undefined, undefined, current, a.binding);
      // verify() synchronously suspends the old view before its first await.
      generation = a.generation;
      void pending
        .then((result) => {
          if (!current()) return;
          if (result) {
            if (!a.initialized) {
              a.retryOpen();
              return;
            }
            reveal(a);
          } else if (stored && !f.store.entries().some((e) => e.id === a.id))
            a.closeDenied();
        })
        .catch((error) => {
          if (!stored && current() && [401, 403].includes(error.status))
            void f.controller
              .check(false)
              .then(() => {
                if (live(a)) a.closeDenied();
              })
              .catch(() => {});
        })
        .finally(() => (warm = false));
    });
    registered = true;
  }
  async function open(restored = null, externalSignal, restoredSession) {
    register();
    if (!registered)
      throw Error("Модуль чернеток ще не готовий. Повторіть відкриття.");
    if (restored && (!restoredSession || !externalSignal)) throw canceled();
    if (active?.d.open) {
      if (restored)
        throw Error("Спочатку закрийте поточний редактор кількості.");
      active.d.focus();
      return;
    }
    const openingId = ++opening,
      route = location.hash,
      opener = document.activeElement,
      d = document.createElement("dialog");
    d.className = "trade-dialog small";
    d.setAttribute("aria-labelledby", "budgetTemplateTitle");
    d.innerHTML =
      '<div class="trade-dialog-head"><h2 id="budgetTemplateTitle">Планова кількість магазинів</h2><button type="button" class="btn soft" data-close aria-label="Закрити редактор">×</button></div><div class="trade-dialog-body" hidden><p class="trade-caption">Це кількість для орієнтира за каталогом. Вона не змінює ERP-магазини чи підписи цінників. Зміни зберігаються лише кнопкою.</p><form><label class="trade-caption">Кількість магазинів<input name="budgetStores" type="text" inputmode="numeric" required maxlength="8000"></label><div class="row trade-section-title"><button class="btn" type="submit">Зберегти кількість</button></div></form><p role="status" aria-live="polite" data-status></p><p role="alert" class="trade-error" data-error tabindex="-1"></p><div class="row trade-section-title"><button type="button" class="btn soft" data-read>Повторити читання</button><button type="button" class="btn soft" data-cancel hidden>Скасувати читання</button></div><div class="tk-root" data-comparison></div></div><section class="trade-dialog-body" data-template-loading><p role="status">Підтверджуємо доступ і читаємо кількість…</p></section>';
    const form = d.querySelector("form"),
      input = form.elements.budgetStores,
      save = form.querySelector("[type=submit]"),
      read = d.querySelector("[data-read]"),
      cancel = d.querySelector("[data-cancel]"),
      close = d.querySelector("[data-close]"),
      status = d.querySelector("[data-status]"),
      error = d.querySelector("[data-error]"),
      host = d.querySelector("[data-comparison]");
    const key = restored
      ? codec().decodeTemplateState(restored.baseline).key
      : crypto.randomUUID();
    let p = restored,
      baseline = null,
      review = !!restored,
      reading = false,
      busy = false,
      dirty = !!restored,
      sequence = 0,
      controller = null,
      comparison = null;
    const a = (active = {
      d,
      input,
      id: "template_" + key,
      p,
      binding: restoredSession,
      hidden: true,
      generation: 0,
      guarding: true,
      reading: false,
      cancel: () => stop(),
      closeDenied: () => d.close(),
      initialized: false,
      retryOpen: () => {
        d.addEventListener(
          "close",
          () => void open().catch((error) => window.alert(error.message)),
          { once: true },
        );
        d.close();
      },
    });
    const valid = (n) => Number.isSafeInteger(n) && n >= 1 && n <= 1000;
    const raw = () => ({ budgetStores: input.value });
    const state = () => ({
      recordId: a.id,
      key,
      original: {
        budgetStores: baseline.budgetStores,
        revision: baseline.revision,
      },
      review,
    });
    function capture() {
      if (a.hidden) throw Error("Спочатку підтвердьте доступ до форми.");
      const next = codec().decodeTemplatePayload({
        baseline: state(),
        draft: raw(),
        firstIntent: p?.firstIntent || null,
        confirmation: p?.confirmation || null,
      });
      foundation().store.save(a.id, NAME, next);
      p = next;
      a.p = p;
      return p;
    }
    function confirmed(type, value, draft = raw()) {
      const event = { type, raw: value, draft },
        next = codec().confirmTemplatePayload(p, event);
      foundation().store.confirmed(a.id, event);
      p = next;
      a.p = p;
      return next;
    }
    const sync = () => {
      input.disabled = !baseline || reading || busy;
      save.disabled = !baseline || review || reading || busy || !dirty;
      close.disabled = busy;
      read.hidden = reading || busy || !!comparison;
      read.textContent = baseline
        ? "Порівняти з поточною версією"
        : "Повторити читання";
      cancel.hidden = !reading;
    };
    const stop = () => {
      sequence++;
      controller?.abort();
      controller = null;
      comparison?.unmount();
      comparison = null;
      host.replaceChildren();
      reading = false;
      a.reading = false;
      sync();
    };
    const shut = () => {
      if (busy) return false;
      if (
        dirty &&
        !confirm(
          "Закрити редактор? Введення залишиться локально для явного відновлення у цій вкладці.",
        )
      )
        return false;
      d.close();
      return true;
    };
    close.onclick = shut;
    d.addEventListener("cancel", (e) => {
      e.preventDefault();
      shut();
    });
    const externalAbort = () => {
      stop();
      d.close();
    };
    externalSignal?.addEventListener("abort", externalAbort, { once: true });
    d.addEventListener(
      "close",
      () => {
        stop();
        opening++;
        externalSignal?.removeEventListener("abort", externalAbort);
        if (active === a) active = null;
        d.remove();
        if (opener?.isConnected) opener.focus();
      },
      { once: true },
    );
    input.oninput = () => {
      dirty = true;
      error.textContent = "";
      try {
        capture();
      } catch (e) {
        error.textContent = e.message;
      }
      status.textContent = review
        ? "Чернетка збережена. Потрібно узгодити поточну версію."
        : "Є незбережені зміни. Натисніть «Зберегти кількість».";
      sync();
    };
    cancel.onclick = () => {
      stop();
      foundation().controller.dismiss();
      status.textContent = "Читання скасовано. Чернетка збережена.";
      read.focus();
    };
    async function protectedRead(callback, signal) {
      a.reading = true;
      warm = true;
      const pending = foundation().controller.verifyRead(
          a.id,
          (authorizedSignal, session) =>
            callback(AbortSignal.any([signal, authorizedSignal]), session),
        ),
        generation = a.generation;
      try {
        const result = await pending;
        if (signal.aborted || generation !== a.generation || !live(a))
          throw canceled();
        if (!result)
          throw Error(
            "Доступ або поточний стан не підтверджено. Повторіть лише перевірку доступу.",
          );
        reveal(a);
        return result.value;
      } finally {
        a.reading = false;
        warm = false;
        const gate = d.querySelector("[data-template-access]");
        if (gate) {
          gate.querySelector("[data-template-access-retry]").disabled = false;
          gate.querySelector("[data-template-access-cancel]").hidden = true;
        }
      }
    }
    async function latest() {
      if (reading || busy || comparison) return;
      try {
        capture();
      } catch (e) {
        error.textContent = e.message;
        return;
      }
      const n = Number(input.value),
        local = {
          budgetStores: input.value.trim() && valid(n) ? n : input.value,
        },
        requestId = ++sequence;
      controller = new AbortController();
      reading = true;
      error.textContent = "";
      status.textContent = "Читаємо поточну кількість магазинів…";
      sync();
      try {
        const fresh = await protectedRead(
          (signal, session) =>
            request("GET", undefined, signal, undefined, session),
          controller.signal,
        );
        if (!live(a) || requestId !== sequence) return;
        review = true;
        reading = false;
        status.textContent = p.firstIntent
          ? "Поточний стан прочитано. Це не квитанція вашого PATCH. Явно узгодьте значення; збереження окреме."
          : "Порівняння готове. Узгодьте зміни; збереження виконується окремо.";
        comparison = window.NativeConflictComparison.mount(host, {
          base: adapter().budgetTemplateProjection(baseline),
          mine: local,
          server: adapter().budgetTemplateProjection(fresh),
          fields: adapter().budgetTemplateFields(),
          title: "Узгодити кількість магазинів",
          onCancel: () => {
            if (!live(a) || requestId !== sequence) return;
            stop();
            status.textContent =
              "Чернетка збережена. Прочитайте поточну версію перед збереженням.";
            read.focus();
          },
          onApply: (merged) => {
            if (!live(a) || requestId !== sequence) return;
            let value;
            try {
              value = adapter().decodeBudgetTemplate({ ...fresh, ...merged });
            } catch {
              error.textContent =
                "Введіть ціле число від 1 до 1000 або виберіть актуальне значення сервера.";
              error.focus();
              return;
            }
            try {
              // Persist the selected raw value and current guard atomically before
              // changing the visible input or releasing an unknown PATCH intent.
              confirmed("apply", fresh, {
                budgetStores: String(value.budgetStores),
              });
              stop();
              baseline = fresh;
              input.value = String(value.budgetStores);
              review = false;
              dirty = true;
              status.textContent =
                "Зміни узгоджено в чернетці. Натисніть «Зберегти кількість».";
              sync();
              save.focus();
            } catch (failure) {
              error.textContent = failure.message;
              error.focus();
            }
          },
        });
        sync();
        input.disabled = true;
      } catch (e) {
        if (!live(a) || requestId !== sequence || e.name === "AbortError")
          return;
        stop();
        review = true;
        error.textContent = e.message;
        status.textContent =
          "Поточну кількість не підтверджено. Чернетка збережена.";
        sync();
      }
    }
    read.onclick = latest;
    form.onsubmit = async (e) => {
      e.preventDefault();
      if (
        !live(a) ||
        a.hidden ||
        !baseline ||
        review ||
        reading ||
        busy ||
        comparison ||
        !dirty ||
        !form.reportValidity()
      )
        return;
      const n = Number(input.value);
      if (!valid(n)) {
        error.textContent = "Введіть ціле число від 1 до 1000.";
        error.focus();
        return;
      }
      const body = { budgetStores: n, revision: baseline.revision };
      try {
        capture();
        const next = codec().decodeTemplatePayload({
          ...p,
          firstIntent: {
            method: "PATCH",
            path: "/api/v1/portal/budget-template",
            key,
            body,
            revision: baseline.revision,
            possiblySent: true,
          },
        });
        foundation().store.save(a.id, NAME, next);
        p = next;
        a.p = p;
      } catch (e) {
        error.textContent = e.message;
        error.focus();
        return;
      }
      busy = true;
      error.textContent = "";
      status.textContent = "Збереження…";
      sync();
      a.guarding = true;
      warm = true;
      let writeGuard;
      try {
        const session = await foundation().controller.verify(a.id);
        if (!session || !live(a)) throw canceled();
        reveal(a);
        a.guarding = false;
        const generation = a.generation,
          route = location.hash,
          guard = (writeGuard = () =>
            live(a) &&
            !a.hidden &&
            generation === a.generation &&
            route === location.hash &&
            document.visibilityState !== "hidden");
        const saved = await request(
          "PATCH",
          foundation().store.beforeSend(a.id).body,
          undefined,
          guard,
          session,
        );
        if (!guard()) throw canceled();
        confirmed("saved", saved);
        review = true;
        dirty = false;
        busy = false;
        sync();
        status.textContent =
          "Кількість збережено. Підтверджуємо поточний стан окремим читанням.";
        controller = new AbortController();
        const current = await protectedRead(
          (signal, session) =>
            request("GET", undefined, signal, undefined, session),
          controller.signal,
        );
        if (!live(a)) return;
        const remaining = confirmed("complete", current);
        if (!remaining) {
          baseline = current;
          review = false;
          dirty = false;
          d.close();
          await window.TSUKENYA_REFRESH_AFTER_WRITE?.().catch(() => {});
        } else {
          review = true;
          dirty = true;
          status.textContent =
            "Підтверджений запис збережено; новіше введення потребує узгодження.";
          sync();
        }
      } catch (e) {
        if (e.status === 403 && writeGuard?.()) {
          // Recheck both actor and this resource. P0 hides the private form,
          // erases changed-session records or only the denied resource record.
          a.guarding = true;
          await foundation().controller.verify(a.id);
        }
        if (live(a)) {
          review = true;
          dirty = true;
          error.textContent = e.message;
          status.textContent =
            "Чернетка збережена. Запис не повторюється: прочитайте поточну кількість і явно узгодьте.";
        }
      } finally {
        a.guarding = false;
        warm = false;
        busy = false;
        if (live(a)) {
          sync();
          const gate = d.querySelector("[data-template-access]");
          if (gate)
            gate.querySelector("[data-template-access-retry]").disabled = false;
          else if (review) read.focus();
        }
      }
    };
    document.body.append(d);
    d.showModal();
    sync();
    try {
      const requestId = sequence,
        session = restored
          ? restoredSession
          : await foundation().controller.check(false);
      if (
        externalSignal?.aborted ||
        openingId !== opening ||
        location.hash !== route ||
        !live(a)
      )
        throw canceled();
      a.binding = session;
      controller = new AbortController();
      const signal = externalSignal
        ? AbortSignal.any([controller.signal, externalSignal])
        : controller.signal;
      const generation = a.generation;
      const fresh = await request(
        "GET",
        undefined,
        signal,
        () =>
          live(a) &&
          openingId === opening &&
          location.hash === route &&
          generation === a.generation &&
          document.visibilityState !== "hidden",
        session,
      );
      if (
        signal.aborted ||
        requestId !== sequence ||
        !live(a) ||
        generation !== a.generation ||
        document.visibilityState === "hidden"
      )
        throw canceled();
      input.value = restored
        ? codec().decodeTemplateRaw(restored.draft).budgetStores
        : String(fresh.budgetStores);
      if (
        restored?.confirmation &&
        restored.confirmation.budgetStores === fresh.budgetStores &&
        restored.confirmation.revision === fresh.revision
      ) {
        const remaining = confirmed("complete", fresh);
        if (!remaining) {
          dirty = false;
          d.close();
          return;
        }
      }
      baseline = restored
        ? {
            ...fresh,
            ...codec().decodeTemplateState(restored.baseline).original,
          }
        : fresh;
      a.guarding = false;
      a.initialized = true;
      d.querySelector("[data-template-loading]").remove();
      reveal(a);
      sync();
      input.focus();
    } catch (e) {
      a.guarding = false;
      if (live(a)) {
        d.querySelector("[data-template-loading]").textContent = e.message;
        hide();
      }
      if (restored) {
        d.close();
        throw e;
      }
    }
  }
  window.addEventListener("tsukenya:native-conflict-ready", register);
  window.addEventListener("beforeunload", (e) => {
    if (active?.d.open) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
  document.addEventListener("click", (e) => {
    if (e.target.closest("[data-budget-template-edit]"))
      void open().catch((error) => window.alert(error.message));
  });
  window.BudgetTemplate = {
    open,
    canLeave: () => {
      if (!active?.d.open) return true;
      active.d.querySelector("[data-close]").click();
      return !active?.d.open;
    },
  };
})();
