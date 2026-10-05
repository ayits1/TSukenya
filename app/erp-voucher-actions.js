/* Standalone post/reverse/delete: exact action receipt, explicit same-tab restore. */
(() => {
  "use strict";
  const NAME = "native-voucher-action-v1",
    prefix = "../v1/trading/voucher-actions/";
  const labels = {
    post: "Проведення документа",
    reverse: "Скасування документа",
    delete: "Видалення чернетки",
  };
  const statusLabel = (value) =>
    ({ draft: "Чернетка", posted: "Проведено", reversed: "Сторновано" })[value];
  let options,
    registered = false,
    active = null,
    warm = false,
    restoredSignal = null;
  const codec = () => window.NativeVoucherAction;
  const f = () => {
    if (!window.NativeDraftRecovery || !codec())
      throw Error("Модуль відновлення ще не готовий. Повторіть відкриття.");
    return window.NativeDraftRecovery;
  };
  const state = (p) => codec().decodeState(p.baseline);
  const abort = () => new DOMException("Скасовано", "AbortError");
  function hide() {
    if (!active?.d.open) return;
    const a = active;
    a.hidden = true;
    if (!a.reading && !a.guarding) a.cancel();
    a.d.querySelector("#tradeDialogTitle").textContent =
      "Дія документа призупинена";
    a.d.querySelector(".trade-dialog-body").hidden = true;
    a.d
      .querySelectorAll(".trade-dialog-foot")
      .forEach((el) => (el.hidden = true));
    let gate = a.d.querySelector("[data-action-access]");
    if (!gate) {
      gate = document.createElement("section");
      gate.className = "trade-dialog-body";
      gate.dataset.actionAccess = "";
      gate.innerHTML =
        '<p role="status">Дію приховано до підтвердження доступу. Запит автоматично не повторюється.</p><button type="button" class="btn soft" data-check>Перевірити доступ</button><button type="button" class="btn soft" data-cancel>Скасувати читання</button>';
      gate.querySelector("[data-check]").onclick = () =>
        f()
          .controller.check()
          .catch(() => {});
      gate.querySelector("[data-cancel]").onclick = () => {
        a.cancel();
        f().controller.dismiss();
      };
      a.d.append(gate);
    }
    gate.querySelector("[data-check]").disabled = a.reading || a.sending;
    gate.querySelector("[data-cancel]").hidden = !a.reading;
  }
  function reveal(a) {
    if (active !== a || !a.d.open || document.visibilityState === "hidden")
      return false;
    a.hidden = false;
    a.d.querySelector("#tradeDialogTitle").textContent =
      labels[state(a.p).terms.action];
    a.d.querySelector(".trade-dialog-body").hidden = false;
    a.d
      .querySelectorAll(".trade-dialog-foot")
      .forEach((el) => (el.hidden = false));
    a.d.querySelector("[data-action-access]")?.remove();
    a.render?.();
    return true;
  }
  async function context(p, session, signal) {
    const s = state(p),
      t = s.terms;
    const raw = await options.api(
      prefix +
        "context?" +
        new URLSearchParams({
          id: t.id,
          kind: t.kind,
          store: t.store,
          expenseScope: t.expenseScope,
          action: t.action,
        }),
      "GET",
      undefined,
      signal,
      false,
    );
    if (signal.aborted) throw abort();
    return codec().decodeContext(raw, t, session);
  }
  function register() {
    if (registered) return;
    f().register({
      name: NAME,
      version: 1,
      label: "Проведення, сторно або видалення документа",
      decode: codec().decodePayload,
      authorize: async (p, session, signal) => {
        await context(p, session, signal);
        return true;
      },
      restore: async (p, signal) => {
        await options.restore(codec().decodePayload(p), signal);
        if (!signal.aborted) restoredSignal = signal;
      },
      suspend: hide,
      confirm: codec().confirm,
    });
    registered = true;
    f().controller.subscribe(() => {
      if (f().controller.snapshot().state !== "ready") return;
      if (restoredSignal) {
        const signal = restoredSignal;
        restoredSignal = null;
        queueMicrotask(() => {
          if (!signal.aborted) {
            f().close();
            active?.form.querySelector("textarea,button")?.focus();
          }
        });
      }
      if (!active?.hidden || warm || active.reading || active.sending) return;
      const a = active,
        id = state(a.p).recordId;
      if (
        !f()
          .store.entries()
          .some((e) => e.id === id)
      ) {
        a.d.close();
        return;
      }
      warm = true;
      void f()
        .controller.verify(id)
        .then((session) => {
          if (session && active === a && a.d.open) reveal(a);
          else if (
            active === a &&
            !f()
              .store.entries()
              .some((e) => e.id === id)
          )
            a.d.close();
        })
        .finally(() => {
          warm = false;
        });
    });
  }
  async function open(
    record,
    action,
    restored,
    restoreSignal,
    openingLive = () => true,
  ) {
    register();
    let p;
    if (restored) p = codec().decodePayload(restored);
    else {
      const key = crypto.randomUUID();
      const terms = codec().decodeTerms({
        key,
        action,
        id: record.id,
        kind: record.kind,
        store: record.store,
        expenseScope:
          record.kind === "expense"
            ? record.payload?.expense_scope || "store"
            : "store",
        revision: record.revision,
        reason: "",
      });
      const session = await f().controller.check(false);
      const controller = new AbortController();
      const raw = await options.api(
        prefix +
          "context?" +
          new URLSearchParams({
            id: terms.id,
            kind: terms.kind,
            store: terms.store,
            expenseScope: terms.expenseScope,
            action,
          }),
        "GET",
        undefined,
        controller.signal,
        false,
        openingLive,
      );
      const c = codec().decodeContext(raw, terms, session);
      if (!openingLive() || restoreSignal?.aborted) throw abort();
      if (!c.exists) throw Error("Документ більше не існує.");
      p = codec().decodePayload({
        baseline: {
          recordId: "voucher_action_" + crypto.randomUUID(),
          terms,
          observedStatus: c.status,
          observedDate: c.date,
          needsReview: c.revision !== terms.revision,
          outcome: null,
        },
        draft: { reason: "" },
        firstIntent: null,
        confirmation: null,
      });
    }
    if (restoreSignal?.aborted) throw abort();
    const s = state(p),
      d = options.modal(
        labels[s.terms.action],
        `<form id="tradeActionForm"><fieldset data-action-fields><p>Документ № ${options.esc(s.terms.id)} · <span data-observed></span></p>${s.terms.action === "reverse" ? '<label>Причина скасування<textarea name="reason" rows="3" maxlength="4000" required></textarea></label>' : "<p>Дія стосується саме перевіреної версії документа. Поточні складські та грошові обмеження перевіряє сервер.</p>"}</fieldset><p role="status" tabindex="-1" data-action-status></p><div data-action-current></div><div class="row"><button type="submit" class="btn" data-action-send>${s.terms.action === "post" ? "Провести" : s.terms.action === "reverse" ? "Скасувати документ" : "Видалити чернетку"}</button><button type="button" class="btn soft" data-action-exact>Повторити початкову дію</button><button type="button" class="btn soft" data-action-identity>Перевірити початкову дію</button><button type="button" class="btn soft" data-action-read>Прочитати поточний документ</button><button type="button" class="btn soft" data-action-stop>Скасувати читання</button><button type="button" class="btn soft" data-action-apply>Застосувати поточну версію</button><button type="button" class="btn soft" data-action-done>Завершити</button></div></form>`,
        "",
        true,
      );
    const form = d.querySelector("form");
    form.onsubmit = (e) => e.preventDefault();
    const a = {
      p,
      d,
      form,
      reading: false,
      sending: false,
      hidden: false,
      epoch: 0,
      controller: null,
      review: null,
      cancel() {
        this.epoch++;
        this.controller?.abort();
        this.controller = null;
        this.reading = false;
        this.review = null;
        const gate = this.d.querySelector("[data-action-access]");
        if (gate) {
          gate.querySelector("[data-check]").disabled = this.sending;
          gate.querySelector("[data-cancel]").hidden = true;
        }
      },
    };
    active = a;
    if (form.elements.reason)
      form.elements.reason.value = codec().decodeRaw(p.draft).reason;
    const raw = () => ({ reason: form.elements.reason?.value || "" });
    const live = () =>
      active === a &&
      d.open &&
      !a.hidden &&
      document.visibilityState !== "hidden";
    function save(next) {
      const decoded = codec().decodePayload(next);
      f().store.save(state(decoded).recordId, NAME, decoded);
      p = a.p = decoded;
    }
    function confirm(type, value) {
      const event = { type, raw: value, draft: raw() },
        next = codec().confirm(p, event);
      f().store.confirmed(state(p).recordId, event);
      if (next) p = a.p = next;
      return next;
    }
    function render(message) {
      if (!d.open) return;
      const s = state(p),
        unknown = Boolean(p.firstIntent);
      form.querySelector("[data-observed]").textContent =
        s.observedDate + " · " + statusLabel(s.observedStatus);
      form.querySelector("[data-action-status]").textContent =
        message ||
        (s.outcome
          ? "Початкова дія підтверджена: " +
            {
              posted: "проведено",
              reversed: "сторновано",
              deleted: "видалено",
            }[s.outcome] +
            ". Це підтвердження не є новою ревізією документа."
          : unknown
            ? "Результат початкової дії невідомий. Повторіть лише незмінний запит або перевірте його окремо."
            : s.needsReview
              ? "Прочитайте поточний документ і застосуйте перевірену версію окремо."
              : "Намір збережено у цій вкладці. Дія виконується лише після натискання.");
      const busy = a.reading || a.sending;
      form.querySelector("[data-action-fields]").disabled = busy;
      form.querySelector("[data-action-send]").disabled =
        busy || unknown || s.needsReview || Boolean(s.outcome);
      form.querySelector("[data-action-exact]").hidden = !unknown;
      form.querySelector("[data-action-exact]").disabled = busy;
      form.querySelector("[data-action-identity]").hidden = !unknown;
      form.querySelector("[data-action-identity]").disabled = busy;
      form.querySelector("[data-action-read]").disabled = busy;
      form.querySelector("[data-action-stop]").hidden = !a.reading;
      form.querySelector("[data-action-apply]").hidden =
        !a.review || unknown || Boolean(s.outcome);
      form.querySelector("[data-action-done]").hidden = !s.outcome;
    }
    a.render = render;
    form.addEventListener("input", () => {
      if (!live() || a.sending) return;
      a.review = null;
      form.querySelector("[data-action-current]").replaceChildren();
      try {
        save({ ...p, draft: raw() });
        d.dataset.dirty = "1";
        render();
      } catch (error) {
        options.formError(error, d);
      }
    });
    let captureError;
    try {
      save(p);
      if (restored && !p.firstIntent && !s.outcome)
        save({ ...p, baseline: { ...state(p), needsReview: true } });
    } catch (error) {
      captureError = error;
      options.formError(error, d);
    }
    render(captureError?.message);
    async function read(identity = false) {
      if (a.reading || a.sending || !live()) return;
      a.reading = true;
      const epoch = ++a.epoch;
      render();
      let failure;
      const checked = await f().controller.verifyRead(
        state(p).recordId,
        async (signal, session) => {
          if (epoch !== a.epoch || active !== a || !d.open) throw abort();
          try {
            if (identity) {
              const request = p.firstIntent
                ? codec().decodeTerms(p.firstIntent.body)
                : null;
              if (!request) throw Error("Немає початкового запиту.");
              const value = await options.api(
                prefix + "identity",
                "POST",
                { request },
                signal,
                false,
                () => epoch === a.epoch && active === a && d.open,
              );
              if (signal.aborted || epoch !== a.epoch) throw abort();
              codec().decodeIdentity(value, request);
              confirm("identity", value);
              return { identity: true };
            }
            const c = await context(p, session, signal);
            if (signal.aborted || epoch !== a.epoch) throw abort();
            let row = null;
            if (c.exists) {
              const value = await options.api(
                "vouchers/" + s.terms.id + "?purpose=recovery",
                "GET",
                undefined,
                signal,
                false,
                () => epoch === a.epoch && active === a && d.open,
              );
              row = window.NativeVoucherEditor.decodeVoucher(value, {
                id: s.terms.id,
                kind: s.terms.kind,
              });
              row.lines = row.lines.map((line, index) => ({
                ...line,
                name: value.lines[index].name,
              }));
              if (
                row.store !== s.terms.store ||
                row.status !== c.status ||
                row.revision !== c.revision
              )
                throw Error(
                  "Документ змінився між читаннями. Повторіть читання.",
                );
            }
            return { c, row };
          } catch (error) {
            failure = error;
            throw error;
          }
        },
      );
      if (epoch !== a.epoch || active !== a || !d.open) return;
      a.reading = false;
      if (!checked) {
        hide();
        return;
      }
      reveal(a);
      if (checked.value.identity) {
        render(
          state(p).outcome
            ? "Початкова дія підтверджена. Поточний документ читається окремою дією."
            : "Підтвердження початкової дії поки немає. Це не доказ відсутності попереднього запису.",
        );
        return;
      }
      const { c, row } = checked.value;
      a.review = c;
      const host = form.querySelector("[data-action-current]");
      host.replaceChildren();
      const heading = document.createElement("h3");
      heading.textContent = c.exists
        ? "Поточний документ: " + c.date + " · " + statusLabel(c.status)
        : "Документ більше не існує";
      host.append(heading);
      if (row) {
        const pre = document.createElement("pre");
        pre.className = "trade-caption";
        pre.style.whiteSpace = "pre-wrap";
        pre.textContent = [
          "Сума: " + row.total + " грн",
          "Примітка: " + row.note,
          ...[
            ["store", "Магазин"],
            ["warehouse", "Склад"],
            ["target", "Склад призначення"],
            ["party", "Контрагент"],
            ["employee", "Працівник"],
            ["account", "Рахунок"],
            ["shift", "Касова зміна"],
            ["reference", "Вихідний документ"],
          ]
            .filter(([key]) => row[key])
            .map(([key, label]) => label + ": № " + row[key]),
          ...row.lines.map(
            (l) =>
              `${l.name} · ${l.quantity} × ${l.price} грн · партія ${l.lot || "—"} · дата ${l.expiry || "—"}`,
          ),
          "Категорія: " + row.payload.category,
          "Додаткові витрати: " + row.payload.additional_cost + " грн",
          "Причина знижки: " + row.payload.discount_reason,
          "Фіскальний чек: " + row.payload.fiscal_ref,
          "Строк оплати: " + (row.payload.due_date || "—"),
          ...row.payload.payments.map(
            (x) => `Оплата: рахунок № ${x.account} · ${x.amount} грн`,
          ),
          ...(row.allocations || []).map(
            (x) => `Розподіл: документ № ${x.source} · ${x.amount} грн`,
          ),
          "Табелі: " + row.payload.shift_ids.join(", "),
          ...(row.payload.production
            ? [
                `Рецептура: ${row.payload.production.recipeVersion}`,
                `Плановий випуск: ${row.payload.production.plannedOutput}`,
                `Причина відхилення: ${row.payload.production.varianceReason}`,
                ...row.payload.production.actualComponents.map(
                  (x) => `Фактична сировина ${x.product}: ${x.quantity}`,
                ),
              ]
            : []),
        ].join("\n");
        host.append(pre);
      }
      render(
        failure?.message ||
          "Поточні дані прочитано. Застосування не виконує бізнес-дію.",
      );
    }
    form.querySelector("[data-action-apply]").onclick = () => {
      if (
        !live() ||
        !a.review ||
        p.firstIntent ||
        state(p).outcome ||
        a.reading ||
        a.sending
      )
        return;
      const c = a.review;
      if (!c.exists || !c.canExecute) {
        render(
          "Ця дія недоступна за поточним станом або періодом. Намір збережено.",
        );
        return;
      }
      save({
        ...p,
        baseline: {
          ...state(p),
          terms: {
            ...state(p).terms,
            key: crypto.randomUUID(),
            revision: c.revision,
            reason: "",
          },
          observedDate: c.date,
          observedStatus: c.status,
          needsReview: false,
        },
        draft: raw(),
      });
      a.review = null;
      render(
        "Поточна версія застосована лише до наміру. Натисніть дію окремо.",
      );
      form.querySelector("[data-action-send]").focus();
    };
    async function send(exact = false) {
      if (a.sending || a.reading || !live()) return;
      const initial = state(p);
      if (initial.outcome || (!exact && (p.firstIntent || initial.needsReview)))
        return;
      let firstLive = !p.firstIntent,
        attempted = false;
      try {
        let terms;
        if (p.firstIntent) terms = codec().decodeTerms(p.firstIntent.body);
        else {
          terms = codec().decodeTerms({
            ...initial.terms,
            reason: initial.terms.action === "reverse" ? raw().reason : "",
          });
          if (terms.action === "reverse" && !terms.reason.trim())
            throw Error("Вкажіть причину скасування.");
          save({
            ...p,
            baseline: { ...initial, terms },
            draft: raw(),
            firstIntent: {
              method: "POST",
              path: "/api/v1/trading/voucher-actions/execute",
              key: terms.key,
              body: terms,
              revision: terms.revision,
              possiblySent: true,
            },
          });
        }
        const frozen = f().store.beforeSend(state(p).recordId);
        a.sending = true;
        render();
        warm = true;
        const epoch = ++a.epoch;
        a.guarding = true;
        let session;
        try {
          session = await f().controller.verify(state(p).recordId);
        } finally {
          a.guarding = false;
        }
        warm = false;
        if (
          !session ||
          epoch !== a.epoch ||
          active !== a ||
          !d.open ||
          document.visibilityState === "hidden"
        )
          throw abort();
        reveal(a);
        a.controller = new AbortController();
        const valid = () =>
          epoch === a.epoch &&
          active === a &&
          d.open &&
          !a.hidden &&
          !a.controller?.signal.aborted;
        attempted = true;
        const response = await options.api(
          prefix + "execute",
          "POST",
          frozen.body,
          a.controller.signal,
          false,
          valid,
        );
        if (!valid()) return;
        codec().decodeAck(response, terms);
        confirm("ack", response);
        d.dataset.dirty = "";
        render(
          "Дію підтверджено й збережено у вкладці. Поточний документ можна прочитати окремо.",
        );
      } catch (error) {
        warm = false;
        if (active !== a || !d.open || error.name === "AbortError") return;
        if (
          firstLive &&
          attempted &&
          (error.status === 400 || error.status === 409) &&
          error.detail?.write_rejected === true
        ) {
          try {
            confirm("rejected", error.detail);
          } catch {}
        }
        if (error.status === 403) {
          hide();
          void f().controller.verify(state(p).recordId);
          return;
        }
        options.formError(error, d);
        render(error.message);
      } finally {
        a.sending = false;
        render();
      }
    }
    form.onsubmit = (e) => {
      e.preventDefault();
      void send();
    };
    form.querySelector("[data-action-exact]").onclick = () => send(true);
    form.querySelector("[data-action-identity]").onclick = () => read(true);
    form.querySelector("[data-action-read]").onclick = () => read();
    form.querySelector("[data-action-stop]").onclick = () => {
      a.cancel();
      f().controller.dismiss();
      render("Читання скасовано. Намір збережено.");
    };
    form.querySelector("[data-action-done]").onclick = async () => {
      if (!live() || !state(p).outcome) return;
      confirm("complete", null);
      d.dataset.dirty = "";
      d.close();
      await options.after(state(p).terms, state(p).outcome, d);
    };
    d.addEventListener(
      "close",
      () => {
        a.cancel();
        if (active === a) active = null;
      },
      { once: true },
    );
    form.querySelector("textarea,button")?.focus();
    return d;
  }
  window.TradeVoucherActions = {
    configure(value) {
      options = value;
    },
    open,
  };
  window.addEventListener("tsukenya:native-conflict-ready", () => register());
})();
