/* Both recipe editors use P0 storage, fresh reads and the same privacy lifetime. */
(() => {
  "use strict";
  const NAME = "native-recipe-v1";
  let configured,
    registered = false,
    active = null,
    sequence = 0,
    warm = false,
    reads = 0,
    restoredSignal = null,
    authorized = null;
  const f = () => {
    if (!window.NativeDraftRecovery || !window.NativeRecipePersistence)
      throw Error(
        "Модуль локальних чернеток ще не готовий. Повторіть відкриття.",
      );
    return window.NativeDraftRecovery;
  };
  const c = () => window.NativeRecipePersistence,
    s = (p) => c().decodeState(p.baseline);
  function hide() {
    sequence++;
    if (!active?.d.open) return;
    const a = active;
    a.hidden = true;
    if (!a.reading && !a.guard) a.cancel();
    a.d.querySelector("#tradeDialogTitle").textContent =
      "Локальна чернетка призупинена";
    a.d.querySelector(".trade-dialog-body").hidden = true;
    a.d.querySelector(".trade-dialog-foot").hidden = true;
    a.d.querySelectorAll(".tk-popover").forEach((x) => (x.hidden = true));
    let gate = a.d.querySelector("[data-recipe-access]");
    if (!gate) {
      gate = document.createElement("section");
      gate.className = "trade-dialog-body";
      gate.dataset.recipeAccess = "";
      gate.innerHTML =
        '<p role="status">Форму приховано до підтвердження доступу.</p><button type="button" class="btn soft">Перевірити доступ до форми</button><button type="button" class="btn soft" data-recipe-read-cancel>Скасувати читання</button>';
      gate.querySelector("button").onclick = () =>
        f()
          .controller.check()
          .catch(() => {});
      gate.querySelector("[data-recipe-read-cancel]").onclick = () => {
        a.cancel();
        f().controller.dismiss();
      };
      a.d.append(gate);
    }
    gate.querySelector("button").disabled = Boolean(a.reading || a.guard);
    gate.querySelector("[data-recipe-read-cancel]").hidden = !a.reading;
  }
  function show(a) {
    a.hidden = false;
    a.d.querySelector("#tradeDialogTitle").textContent = a.heading;
    a.d.querySelector(".trade-dialog-body").hidden = false;
    a.d.querySelector(".trade-dialog-foot").hidden = false;
    a.d.querySelectorAll(".tk-popover").forEach((x) => (x.hidden = false));
    a.d.querySelector("[data-recipe-access]")?.remove();
  }
  async function context(mode, product, session, signal) {
    const raw = await configured.api(
      "recipes/recovery-context?" + new URLSearchParams({ mode, product }),
      "GET",
      undefined,
      signal,
      false,
    );
    return c().decodeContext(raw, mode, product, session);
  }
  async function authorize(p, session, signal) {
    const state = s(p);
    await context(state.mode, p.draft.product, session, signal);
    if (signal.aborted) throw new DOMException("Скасовано", "AbortError");
    authorized = { recordId: state.recordId, session };
    return true;
  }
  function register() {
    if (registered) return;
    const foundation = f();
    foundation.register({
      name: NAME,
      version: 1,
      label: "Рецептура або її затвердження",
      decode: c().decodePayload,
      authorize,
      restore: async (p, signal) => {
        if (signal.aborted) return;
        const session =
          authorized?.recordId === s(p).recordId ? authorized.session : null;
        if (!session) throw Error("Доступ до чернетки не підтверджено.");
        await configured.restore(c().decodePayload(p), signal, session);
        if (!signal.aborted) restoredSignal = signal;
      },
      suspend: hide,
      confirm: c().confirmPayload,
    });
    registered = true;
    foundation.controller.subscribe(() => {
      if (foundation.controller.snapshot().state !== "ready") return;
      if (restoredSignal) {
        const signal = restoredSignal;
        restoredSignal = null;
        queueMicrotask(() => {
          if (!signal.aborted) {
            foundation.close();
            active?.form.querySelector("input,select")?.focus();
          }
        });
      }
      if (!active?.hidden || warm || reads) return;
      const a = active,
        id = s(a.payload).recordId;
      if (!foundation.store.entries().some((e) => e.id === id)) {
        a.d.close();
        return;
      }
      warm = true;
      const pending = foundation.controller.verify(id),
        t = sequence;
      void pending
        .then((session) => {
          if (
            t !== sequence ||
            active !== a ||
            !a.d.open ||
            document.visibilityState === "hidden"
          )
            return;
          if (!session) {
            if (!foundation.store.entries().some((e) => e.id === id))
              a.d.close();
            return;
          }
          show(a);
        })
        .finally(() => (warm = false));
    });
  }
  async function prepare(mode, product, signal) {
    register();
    const session = await f().controller.check(false);
    if (signal?.aborted) throw new DOMException("Скасовано", "AbortError");
    await context(mode, product, session, signal);
    return session;
  }
  function enroll({ d, form, initial, restored, captureRaw, cancel }) {
    register();
    let p = restored
      ? c().decodePayload(restored)
      : {
          baseline: initial,
          draft: captureRaw(),
          firstIntent: null,
          confirmation: null,
        };
    const id = s(p).recordId,
      a = {
        d,
        form,
        payload: p,
        hidden: false,
        cancel,
        heading: d.querySelector("#tradeDialogTitle").textContent,
      };
    active = a;
    function capture(machine) {
      if (a.hidden) throw Error("Спочатку підтвердьте доступ до форми.");
      const next = c().decodePayload({
        ...p,
        baseline: machine || p.baseline,
        draft: captureRaw(),
      });
      f().store.save(id, NAME, next);
      p = next;
      a.payload = p;
      return p;
    }
    const captureEvent = () => {
      if (!d.open || a.hidden) return;
      try {
        capture();
        form.querySelector("[data-recipe-storage-error]")?.remove();
      } catch (error) {
        let el = form.querySelector("[data-recipe-storage-error]");
        if (!el) {
          el = document.createElement("p");
          el.dataset.recipeStorageError = "";
          el.className = "trade-error";
          el.setAttribute("role", "alert");
          form.prepend(el);
        }
        el.textContent = error.message;
      }
    };
    for (const event of ["input", "change", "tsukenya:draft-change"])
      form.addEventListener(event, captureEvent);
    d.addEventListener(
      "close",
      () => {
        sequence++;
        if (active === a) active = null;
      },
      { once: true },
    );
    captureEvent();
    async function guarded(read, signal) {
      if (active !== a || !d.open)
        throw new DOMException("Скасовано", "AbortError");
      warm = true;
      a.reading = (a.reading || 0) + 1;
      reads++;
      const pending = f().controller.verifyRead(id, (authorizedSignal) => {
          const combined = signal
            ? AbortSignal.any([signal, authorizedSignal])
            : authorizedSignal;
          if (combined.aborted || active !== a || !d.open)
            throw new DOMException("Скасовано", "AbortError");
          return read(combined);
        }),
        t = sequence;
      try {
        const result = await pending;
        if (signal?.aborted || t !== sequence || active !== a || !d.open)
          throw new DOMException("Скасовано", "AbortError");
        if (!result)
          throw Error(
            "Доступ або поточну рецептуру не підтверджено. Повторіть перевірку доступу.",
          );
        show(a);
        return result.value;
      } finally {
        a.reading--;
        reads--;
        warm = Boolean(a.reading);
        const gate = d.querySelector("[data-recipe-access]");
        if (gate) {
          gate.querySelector("button").disabled = Boolean(a.reading || a.guard);
          gate.querySelector("[data-recipe-read-cancel]").hidden = !a.reading;
        }
      }
    }
    return {
      capture,
      read: guarded,
      get payload() {
        return p;
      },
      get hidden() {
        return a.hidden;
      },
      async before(body) {
        capture();
        if (!p.firstIntent) {
          const state = s(p),
            next = c().decodePayload({
              ...p,
              firstIntent: {
                method: "POST",
                path:
                  state.mode === "legacy"
                    ? "/api/erp/recipes"
                    : "/api/erp/recipes/versions",
                key: state.key,
                body: structuredClone(body),
                revision: state.original.revision,
                possiblySent: true,
              },
            });
          f().store.save(id, NAME, next);
          p = next;
          a.payload = p;
        }
        const frozen = f().store.beforeSend(id);
        if (JSON.stringify(frozen.body) !== JSON.stringify(body))
          throw Error("Початковий запит незмінний. Перевірте його результат.");
        a.guard = true;
        warm = true;
        let session;
        try {
          session = await f().controller.verify(id);
        } finally {
          a.guard = false;
          warm = false;
        }
        if (!session || active !== a || !d.open)
          throw Error("Доступ не підтверджено. Запит не надіслано.");
        show(a);
        return frozen.body;
      },
      confirm(type, raw) {
        const event = { type, raw, draft: captureRaw() },
          next = c().confirmPayload(p, event);
        f().store.confirmed(id, event);
        if (next) {
          p = next;
          a.payload = p;
        }
        return next;
      },
    };
  }
  window.TradeRecipePersistence = {
    configure(value) {
      configured = value;
    },
    prepare,
    enroll,
    context,
  };
  window.addEventListener("tsukenya:native-conflict-ready", register);
})();
