/* Owner settings enrollment: P0 binding, raw capture and frozen intent remain independent. */
(() => {
  "use strict";
  const NAME = "native-settings-v1";
  let registered = false,
    options = null,
    active = null,
    sequence = 0,
    warm = false,
    authorizedReads = 0,
    restoredSignal = null,
    authorizedSession = null;
  const foundation = () => {
    if (!window.NativeDraftRecovery || !window.NativeSettingPersistence)
      throw Error(
        "Модуль локальних чернеток ще не готовий. Повторіть відкриття.",
      );
    return window.NativeDraftRecovery;
  };
  const codec = () => window.NativeSettingPersistence;
  const state = (p) => codec().decodeState(p.baseline);
  function hide() {
    sequence++;
    if (!active?.d.open) return;
    const a = active;
    a.hidden = true;
    if (!a.reading) a.cancel();
    a.d.querySelector("#tradeDialogTitle").textContent =
      "Локальна чернетка призупинена";
    a.d.querySelector(".trade-dialog-body").hidden = true;
    a.d.querySelectorAll(".tk-popover").forEach((el) => (el.hidden = true));
    let gate = a.d.querySelector("[data-settings-access]");
    if (!gate) {
      gate = document.createElement("section");
      gate.className = "trade-dialog-body";
      gate.dataset.settingsAccess = "";
      gate.innerHTML =
        '<p role="status">Форму приховано до підтвердження доступу.</p><button type="button" class="btn soft">Перевірити доступ до форми</button>';
      gate.querySelector("button").onclick = () =>
        foundation()
          .controller.check()
          .catch(() => {});
      a.d.append(gate);
    }
    gate.querySelector("button").disabled = Boolean(
      a.reading || a.guardPending,
    );
    let cancelRead = gate.querySelector("[data-settings-read-cancel]");
    if (!cancelRead) {
      cancelRead = document.createElement("button");
      cancelRead.type = "button";
      cancelRead.className = "btn soft";
      cancelRead.dataset.settingsReadCancel = "";
      cancelRead.textContent = "Скасувати читання";
      cancelRead.onclick = () => {
        a.cancel();
        foundation().controller.dismiss();
      };
      gate.append(cancelRead);
    }
    cancelRead.hidden = !a.reading;
  }
  function contextPath(s) {
    return "../v1/trading/settings/" + s.setting + "/recovery-context";
  }

  async function authorize(p, session, signal) {
    const s = state(p),
      raw = await options.api(
        contextPath(s),
        "GET",
        undefined,
        signal,
        false,
        () => !signal?.aborted,
      );
    if (signal.aborted) throw new DOMException("Скасовано", "AbortError");
    codec().decodeContext(raw, s, session);
    authorizedSession = { recordId: s.recordId, session };
    return true;
  }
  function register() {
    if (registered) return;
    const f = foundation();
    f.register({
      name: NAME,
      version: 1,
      label: "Налаштування обліку",
      decode: codec().decodePayload,
      authorize,
      restore: async (p, signal) => {
        if (signal.aborted) return;
        const session =
          authorizedSession?.recordId === state(p).recordId
            ? authorizedSession.session
            : null;
        if (!session) throw Error("Доступ до чернетки не підтверджено.");
        await options.restore(codec().decodePayload(p), signal, session);
        if (!signal.aborted) restoredSignal = signal;
      },
      suspend: hide,
      confirm: codec().confirmPayload,
    });
    registered = true;
    f.controller.subscribe(() => {
      if (f.controller.snapshot().state !== "ready") return;
      if (restoredSignal) {
        const signal = restoredSignal;
        restoredSignal = null;
        queueMicrotask(() => {
          if (!signal.aborted) {
            f.close();
            active?.form
              .querySelector("input:not([type=hidden]),textarea,select")
              ?.focus();
          }
        });
      }
      if (!active?.hidden || warm || authorizedReads) return;
      const a = active,
        id = state(a.payload).recordId;
      if (!f.store.entries().some((e) => e.id === id)) {
        a.d.close();
        return;
      }
      warm = true;
      const check = f.controller.verify(id),
        t = sequence;
      void check
        .then((session) => {
          if (
            t !== sequence ||
            active !== a ||
            !a.d.open ||
            document.visibilityState === "hidden"
          )
            return;
          if (!session) {
            if (!f.store.entries().some((e) => e.id === id)) a.d.close();
            return;
          }
          a.hidden = false;
          a.d.querySelector("#tradeDialogTitle").textContent = a.heading;
          a.d.querySelector(".trade-dialog-body").hidden = false;
          a.d
            .querySelectorAll(".tk-popover")
            .forEach((el) => (el.hidden = false));
          a.d.querySelector("[data-settings-access]")?.remove();
          a.changed?.();
        })
        .finally(() => (warm = false));
    });
  }
  async function prepare(s, signal, live = () => true) {
    register();
    const session = await foundation().controller.check(false);
    if (signal?.aborted || !live())
      throw new DOMException("Скасовано", "AbortError");
    const raw = await options.api(
      contextPath(s),
      "GET",
      undefined,
      signal,
      false,
      () => live() && !signal?.aborted,
    );
    if (signal?.aborted || !live())
      throw new DOMException("Скасовано", "AbortError");
    codec().decodeContext(raw, s, session);
    return session;
  }
  function enroll({
    d,
    form,
    initial,
    restored,
    captureRaw,
    cancel,
    changed,
    live,
  }) {
    register();
    let p = restored
      ? codec().decodePayload(restored)
      : {
          baseline: initial,
          draft: captureRaw(),
          firstIntent: null,
          confirmation: null,
        };
    const id = state(p).recordId,
      a = {
        d,
        form,
        payload: p,
        hidden: false,
        cancel,
        changed,
        heading: d.querySelector("#tradeDialogTitle").textContent,
      };
    active = a;
    function capture(machine) {
      if (a.hidden) throw Error("Спочатку підтвердьте доступ до форми.");
      const next = {
        ...p,
        baseline: machine || p.baseline,
        draft: captureRaw(),
      };
      const decoded = codec().decodePayload(next);
      foundation().store.save(id, NAME, decoded);
      p = decoded;
      a.payload = p;
      return p;
    }
    const captureEvent = () => {
      if (!d.open || a.hidden) return;
      try {
        capture();
        form.querySelector("[data-settings-storage-error]")?.remove();
      } catch (error) {
        let el = form.querySelector("[data-settings-storage-error]");
        if (!el) {
          el = document.createElement("p");
          el.dataset.settingsStorageError = "";
          el.className = "trade-error";
          el.setAttribute("role", "alert");
          form.prepend(el);
        }
        el.textContent = error.message;
      }
    };
    form.addEventListener("input", captureEvent);
    form.addEventListener("change", captureEvent);
    form.addEventListener("tsukenya:draft-change", captureEvent);
    d.addEventListener(
      "close",
      () => {
        sequence++;
        if (active === a) active = null;
      },
      { once: true },
    );
    captureEvent();
    return {
      capture,
      get hidden() {
        return a.hidden;
      },
      get payload() {
        return p;
      },
      async read(read, signal) {
        if (active !== a || !d.open)
          throw new DOMException("Скасовано", "AbortError");
        warm = true;
        a.reading = (a.reading || 0) + 1;
        authorizedReads++;
        const pending = foundation().controller.verifyRead(
            id,
            async (authorizedSignal, session) => {
              const combined = signal
                ? AbortSignal.any([signal, authorizedSignal])
                : authorizedSignal;
              if (combined.aborted || active !== a || !d.open)
                throw new DOMException("Скасовано", "AbortError");
              return read(combined, session);
            },
          ),
          t = sequence;
        try {
          const result = await pending;
          if (
            signal?.aborted ||
            t !== sequence ||
            active !== a ||
            !d.open ||
            !live()
          )
            throw new DOMException("Скасовано", "AbortError");
          if (!result)
            throw Error(
              "Доступ або поточний запис не підтверджено. Повторіть лише перевірку доступу.",
            );
          a.hidden = false;
          a.d.querySelector("#tradeDialogTitle").textContent = a.heading;
          a.d.querySelector(".trade-dialog-body").hidden = false;
          a.d
            .querySelectorAll(".tk-popover")
            .forEach((el) => (el.hidden = false));
          a.d.querySelector("[data-settings-access]")?.remove();
          a.changed?.();
          return result.value;
        } finally {
          a.reading--;
          authorizedReads--;
          warm = Boolean(a.reading);
          const gate = a.d.querySelector("[data-settings-access]");
          if (gate) {
            gate.querySelector("button").disabled = Boolean(
              a.reading || a.guardPending,
            );
            gate.querySelector("[data-settings-read-cancel]").hidden =
              !a.reading;
          }
        }
      },
      async before(body) {
        capture();
        let next = p;
        if (!p.firstIntent) {
          const s = state(p);
          codec().normalizeBody(s.setting, body);
          next = {
            ...p,
            baseline: s,
            firstIntent: {
              method: "POST",
              path: "/api/erp/" + s.setting,
              key: s.key,
              body: structuredClone(body),
              revision: body.revision ?? null,
              possiblySent: true,
            },
          };
          foundation().store.save(id, NAME, codec().decodePayload(next));
          p = codec().decodePayload(next);
          a.payload = p;
        }
        const frozen = foundation().store.beforeSend(id);
        if (JSON.stringify(frozen.body) !== JSON.stringify(body))
          throw Error(
            "Початковий запит незмінний. Повторіть точний запит або перевірте запис.",
          );
        warm = true;
        a.guardPending = true;
        let session;
        try {
          session = await foundation().controller.verify(id);
        } finally {
          warm = false;
          a.guardPending = false;
          const gate = a.d.querySelector("[data-settings-access]");
          if (gate) gate.querySelector("button").disabled = Boolean(a.reading);
        }
        if (
          !session ||
          active !== a ||
          !d.open ||
          !live() ||
          document.visibilityState === "hidden"
        )
          throw Error("Доступ не підтверджено. Запит не надіслано.");
        a.hidden = false;
        a.d.querySelector("#tradeDialogTitle").textContent = a.heading;
        a.d.querySelector(".trade-dialog-body").hidden = false;
        a.d
          .querySelectorAll(".tk-popover")
          .forEach((el) => (el.hidden = false));
        a.d.querySelector("[data-settings-access]")?.remove();
        a.changed?.();
        // Every retry consults the immutable receipt before any business fetch.
        const found = await this.read(async (signal) => {
          if (signal.aborted || !live())
            throw new DOMException("Скасовано", "AbortError");
          const raw = await options.api(
            "../v1/trading/settings/" + state(p).setting + "/identity",
            "POST",
            { request: frozen.body },
            signal,
            false,
            () => live() && !signal.aborted,
          );
          if (signal.aborted || !live())
            throw new DOMException("Скасовано", "AbortError");
          codec().decodeIdentity(
            raw,
            state(p).setting,
            state(p).key,
            frozen.body,
          );
          return raw;
        });
        if (!live() || document.visibilityState === "hidden")
          throw new DOMException("Скасовано", "AbortError");
        if (found.confirmed) {
          this.confirm("identity", found);
          return { confirmed: true, body: frozen.body };
        }
        return { confirmed: false, body: frozen.body };
      },
      confirm(type, raw) {
        const event = { type, raw, draft: captureRaw() },
          next = codec().confirmPayload(p, event);
        foundation().store.confirmed(id, event);
        if (next) {
          p = next;
          a.payload = p;
        }
        return next;
      },
    };
  }
  window.TradeSettingPersistence = {
    configure(value) {
      options = value;
    },
    prepare,
    enroll,
  };
  window.addEventListener("tsukenya:native-conflict-ready", () => register());
})();
