/* Five order controls: exact existing operation receipt, explicit same-tab restore. */
(() => {
  "use strict";
  const NAME = "native-order-action-v1",
    prefix = "../v1/trading/order-actions/";
  const labels = {
    reserve: "Резерв товару",
    release: "Звільнення невикористаного резерву",
    expire: "Звільнення прострочених резервів",
    close: "Закриття замовлення",
    expected_date: "Очікувана дата поставки",
  };
  const statusLabel = (value) =>
    ({
      draft: "Чернетка",
      approved: "Погоджено",
      partial: "Частково виконано",
      fulfilled: "Виконано",
      closed: "Закрито",
      cancelled: "Скасовано",
    })[value];
  const query = (t) =>
    new URLSearchParams({
      id: t.id,
      kind: t.kind,
      store: t.store,
      action: t.body.action,
      ...(t.body.action === "release"
        ? { reservation: t.body.reservation }
        : {}),
    });
  let options,
    registered = false,
    active = null,
    warm = false,
    restoredSignal = null,
    authorizedSession = null;
  const codec = () => window.NativeOrderAction;
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
      "Дія замовлення призупинена";
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
      labels[state(a.p).terms.body.action];
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
      prefix + "context?" + query(t),
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
      label: "Дії замовлення: резерви, закриття, дата",
      decode: codec().decodePayload,
      authorize: async (p, session, signal) => {
        await context(p, session, signal);
        if (signal.aborted) throw abort();
        authorizedSession = session;
        return true;
      },
      restore: async (p, signal) => {
        await options.restore(
          codec().decodePayload(p),
          signal,
          authorizedSession,
        );
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
            active?.form.querySelector("input,textarea,button")?.focus();
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
  function fields(t, raw, c) {
    const esc = options.esc,
      input = (name, value, caption) =>
        `<label>${esc(caption)}<input type="text" name="${name}" value="${esc(value)}" maxlength="80" ${name === "quantity" ? 'inputmode="decimal"' : ""}></label>`;
    let html = "";
    if (t.body.action === "reserve") {
      html =
        '<p class="trade-caption">Партії добираються сервером за найближчим строком придатності (FEFO). Резерв діє до кінця вибраного дня за Києвом. Строк не скорочується автоматично.</p>' +
        input(
          "expires_on",
          raw.expires_on,
          "Резерв діє включно до (РРРР-ММ-ДД)",
        );
      for (const l of raw.lines) {
        const current = c.lines.find((x) => x.line === l.line),
          limit = c.limits.find((x) => x.line === l.line);
        html += `<label>${esc(current?.name || "Недоступний рядок № " + l.line)} · ${esc(current?.unit || "")}<input type="text" name="line_${l.line}" data-order-line="${l.line}" inputmode="decimal" maxlength="80" value="${esc(l.quantity)}"></label><p class="trade-caption">${limit ? "Без резерву: " + esc(limit.needed) + "; вільного товару: " + esc(limit.available) + ". " + (limit.canReserveFull ? (limit.max_date ? "Для всього залишку максимальний строк: " + esc(limit.max_date) + ". Меншу кількість можна резервувати довше, якщо є придатні партії." : "Для всього залишку є партії без строку придатності.") : "Для всього залишку товару недостатньо — вкажіть меншу кількість.") : "Рядок потребує окремого перегляду."}</p>`;
      }
    } else if (t.body.action === "release")
      html =
        "<p>" +
        esc(c.selected.name) +
        " · партія " +
        esc(c.selected.code || "Без коду") +
        " · невикористано " +
        esc(c.selected.unused) +
        "</p>" +
        input("quantity", raw.quantity, "Кількість звільнення");
    else if (t.body.action === "expected_date")
      html = input(
        "expected_date",
        raw.expected_date,
        "Очікувана дата (РРРР-ММ-ДД; порожньо — очистити)",
      );
    else
      html =
        '<p class="trade-caption">' +
        (t.body.action === "close"
          ? "Нові резерви та виконання стануть недоступні. Невикористаний резерв буде звільнено; виконані документи й історія збережуться."
          : "Буде звільнено лише невикористані резерви, строк яких минув до поточного дня за Києвом.") +
        "</p>";
    if (["release", "close"].includes(t.body.action))
      html += `<label>Причина<textarea name="reason" rows="3" maxlength="4000">${esc(raw.reason)}</textarea></label>`;
    return html;
  }
  async function open(
    record,
    action,
    restored,
    restoreSignal,
    openingLive = () => true,
    restoreSession,
  ) {
    register();
    let p, openingContext;
    if (restored) p = codec().decodePayload(restored);
    else {
      // Capture the clicked source identity before session/context awaits.
      const key = crypto.randomUUID(),
        body = { action, revision: record.revision, idempotencyKey: key };
      if (action === "reserve")
        Object.assign(body, { expires_on: "", lines: [] });
      if (action === "release")
        Object.assign(body, {
          reservation: record.reservation,
          quantity: "",
          reason: "",
        });
      if (action === "close") body.reason = "";
      if (action === "expected_date") body.expected_date = "";
      const terms = codec().decodeTerms({
        id: record.id,
        kind: record.kind,
        store: record.store,
        body,
      });
      const session = await f().controller.check(false),
        controller = new AbortController();
      if (!openingLive() || restoreSignal?.aborted) throw abort();
      const value = await options.api(
        prefix + "context?" + query(terms),
        "GET",
        undefined,
        controller.signal,
        false,
        openingLive,
      );
      openingContext = codec().decodeContext(value, terms, session);
      if (!openingLive() || restoreSignal?.aborted) throw abort();
      const raw = {
        reason: "",
        quantity: "",
        expires_on: options.date(),
        expected_date: openingContext.expected_date || "",
        lines:
          action === "reserve"
            ? openingContext.limits
                .filter((l) => /[1-9]/.test(l.needed))
                .map((l) => ({ line: l.line, quantity: "" }))
            : [],
      };
      p = codec().decodePayload({
        baseline: {
          recordId: "order_action_" + crypto.randomUUID(),
          terms,
          observedState: openingContext.state,
          observedDate: openingContext.date,
          needsReview: openingContext.revision !== record.revision,
          outcome: null,
        },
        draft: raw,
        firstIntent: null,
        confirmation: null,
      });
    }
    if (restored) {
      if (!restoreSession || restoreSignal?.aborted) throw abort();
      openingContext = await context(p, restoreSession, restoreSignal);
      if (restoreSignal?.aborted) throw abort();
    }
    if (restoreSignal?.aborted) throw abort();
    const s = state(p),
      d = options.modal(
        labels[s.terms.body.action],
        `<form id="tradeOrderForm"><fieldset data-action-fields><p>Замовлення № ${options.esc(s.terms.id)} · <span data-observed></span></p>${fields(s.terms, codec().decodeRaw(p.draft), openingContext)}</fieldset><p role="status" tabindex="-1" data-action-status></p><div data-action-current></div><div class="row"><button type="submit" class="btn" data-action-send>Підтвердити</button><button type="button" class="btn soft" data-action-exact>Повторити початкову дію</button><button type="button" class="btn soft" data-action-identity>Перевірити початкову дію</button><button type="button" class="btn soft" data-action-read>Прочитати поточне замовлення</button><button type="button" class="btn soft" data-action-stop>Скасувати читання</button><button type="button" class="btn soft" data-action-apply>Застосувати поточну версію</button><button type="button" class="btn soft" data-action-done>Завершити</button></div></form>`,
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
    const raw = () =>
      codec().decodeRaw({
        reason: form.elements.reason?.value || "",
        quantity: form.elements.quantity?.value || "",
        expires_on: form.elements.expires_on?.value || "",
        expected_date: form.elements.expected_date?.value || "",
        lines: [...form.querySelectorAll("[data-order-line]")].map((el) => ({
          line: Number(el.dataset.orderLine),
          quantity: el.value,
        })),
      });
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
        s.observedDate + " · " + statusLabel(s.observedState);
      form.querySelector("[data-action-status]").textContent =
        message ||
        (s.outcome
          ? "Початкова дія підтверджена: " +
            statusLabel(s.outcome.state) +
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
            return { c };
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
      const { c } = checked.value;
      a.review = c;
      const host = form.querySelector("[data-action-current]");
      host.replaceChildren();
      const heading = document.createElement("h3");
      heading.textContent =
        "Поточне замовлення: " +
        c.date +
        " · " +
        statusLabel(c.state) +
        " · ревізія контролю " +
        c.revision;
      host.append(heading);
      const pre = document.createElement("pre");
      pre.className = "trade-caption";
      pre.style.whiteSpace = "pre-wrap";
      pre.textContent = [
        ...c.lines.map(
          (l) =>
            l.name + " · залишилось " + l.remaining + " · резерв " + l.reserved,
        ),
        ...(c.selected
          ? [
              "Обраний резерв № " +
                c.selected.id +
                " · " +
                c.selected.code +
                " · невикористано " +
                c.selected.unused,
            ]
          : []),
        ...(state(p).terms.body.action === "expected_date"
          ? ["Очікувана дата: " + (c.expected_date || "—")]
          : []),
      ].join("\n");
      host.append(pre);
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
      if (!c.canExecute) {
        render(
          "Ця дія недоступна за поточним станом або періодом. Намір збережено.",
        );
        return;
      }
      if (raw().lines.some((l) => !c.lines.some((x) => x.line === l.line))) {
        render(
          "Склад рядків змінився. Намір збережено; відкрийте нову дію після явного відкидання цієї чернетки.",
        );
        return;
      }
      save({
        ...p,
        baseline: {
          ...state(p),
          terms: {
            ...state(p).terms,
            body: {
              ...state(p).terms.body,
              idempotencyKey: crypto.randomUUID(),
              revision: c.revision,
            },
          },
          observedDate: c.date,
          observedState: c.state,
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
          terms = codec().capture(initial.terms, raw());
          save({
            ...p,
            baseline: { ...initial, terms },
            draft: raw(),
            firstIntent: {
              method: "POST",
              path: "/api/v1/trading/order-actions/execute",
              key: terms.body.idempotencyKey,
              body: terms,
              revision: terms.body.revision,
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
    form.querySelector("input,textarea,button")?.focus();
    return d;
  }
  window.TradeOrderRecovery = {
    configure(value) {
      options = value;
    },
    open,
  };
  window.addEventListener("tsukenya:native-conflict-ready", () => register());
})();
