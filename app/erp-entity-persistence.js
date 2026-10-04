/* Entity enrollment shares P0 storage/privacy, without replacing the voucher codec. */
(() => {
  "use strict";
  const NAME = "native-entity-v1";
  let registered = false,
    options = null,
    active = null,
    sequence = 0,
    warm = false,
    restoredSignal = null,
    authorizedSession = null;
  const foundation = () => {
    if (!window.NativeDraftRecovery || !window.NativeEntityPersistence)
      throw Error(
        "Модуль локальних чернеток ще не готовий. Повторіть відкриття.",
      );
    return window.NativeDraftRecovery;
  };
  const codec = () => window.NativeEntityPersistence;
  const state = (p) => codec().decodeEntityState(p.baseline);
  function hide() {
    sequence++;
    if (!active?.d.open) return;
    const a = active;
    a.hidden = true;
    a.cancel();
    a.d.querySelector("#tradeDialogTitle").textContent =
      "Локальна чернетка призупинена";
    a.d.querySelector(".trade-dialog-body").hidden = true;
    a.d.querySelectorAll(".tk-popover").forEach((el) => (el.hidden = true));
    let gate = a.d.querySelector("[data-entity-access]");
    if (!gate) {
      gate = document.createElement("section");
      gate.className = "trade-dialog-body";
      gate.dataset.entityAccess = "";
      gate.innerHTML =
        '<p role="status">Форму приховано до підтвердження доступу.</p><button type="button" class="btn soft">Перевірити доступ до форми</button>';
      gate.querySelector("button").onclick = () =>
        foundation()
          .controller.check()
          .catch(() => {});
      a.d.append(gate);
    }
  }
  async function authorize(p, session, signal) {
    const s = state(p);
    const q = new URLSearchParams({
      ...(s.id ? { id: s.id } : {}),
      ...(s.store ? { store: String(s.store) } : {}),
    });
    const raw = await options.api(
      "../v1/trading/entities/" + s.resource + "/recovery-context?" + q,
      "GET",
      undefined,
      signal,
      false,
    );
    codec().decodeEntityContext(raw, s, session);
    if (p.firstIntent?.body.idempotency_key) {
      const receipt = await options.api(
        "../v1/trading/entities/" + s.resource + "/identity",
        "POST",
        { request: p.firstIntent.body },
        signal,
      );
      window.NativeEntityEditor.decodeEntityIdentity(
        s.resource,
        receipt,
        s.key,
        p.firstIntent.body,
      );
    }
    if (signal.aborted) throw new DOMException("Скасовано", "AbortError");
    authorizedSession = { recordId: s.recordId, session };
    return true;
  }
  function register() {
    if (registered) return;
    const f = foundation();
    f.register({
      name: NAME,
      version: 1,
      label: "Запис довідника",
      decode: codec().decodeEntityPayload,
      authorize,
      restore: async (p, signal) => {
        if (signal.aborted) return;
        const session =
          authorizedSession?.recordId === state(p).recordId
            ? authorizedSession.session
            : null;
        if (!session) throw Error("Доступ до чернетки не підтверджено.");
        await options.restore(codec().decodeEntityPayload(p), signal, session);
        if (!signal.aborted) restoredSignal = signal;
      },
      suspend: hide,
      confirm: codec().confirmEntityPayload,
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
            active?.form.querySelector("input,textarea,select")?.focus();
          }
        });
      }
      if (!active?.hidden || warm) return;
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
          a.d.querySelector("[data-entity-access]")?.remove();
        })
        .finally(() => (warm = false));
    });
  }
  async function prepare(s, signal) {
    register();
    const session = await foundation().controller.check(false);
    if (signal?.aborted) throw new DOMException("Скасовано", "AbortError");
    const q = new URLSearchParams({
      ...(s.id ? { id: s.id } : {}),
      ...(s.store ? { store: String(s.store) } : {}),
    });
    const raw = await options.api(
      "../v1/trading/entities/" + s.resource + "/recovery-context?" + q,
      "GET",
      undefined,
      signal,
      false,
    );
    codec().decodeEntityContext(
      raw,
      s.id ? { ...s, store: raw.store } : s,
      session,
    );
    return session;
  }
  function enroll({ d, form, initial, restored, captureRaw, cancel }) {
    register();
    let p = restored
      ? codec().decodeEntityPayload(restored)
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
      const decoded = codec().decodeEntityPayload(next);
      foundation().store.save(id, NAME, decoded);
      p = decoded;
      a.payload = p;
      return p;
    }
    const captureEvent = () => {
      if (!d.open || a.hidden) return;
      try {
        capture();
        form.querySelector("[data-entity-storage-error]")?.remove();
      } catch (error) {
        let el = form.querySelector("[data-entity-storage-error]");
        if (!el) {
          el = document.createElement("p");
          el.dataset.entityStorageError = "";
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
      get payload() {
        return p;
      },
      async before(body) {
        capture();
        let next = p;
        const creating = Boolean(body.idempotency_key);
        if (!p.firstIntent) {
          const s = state(p);
          if (creating) {
            s.store = body.store ? Number(body.store) : null;
            s.kind = body.kind ?? null;
          }
          next = {
            ...p,
            baseline: s,
            firstIntent: {
              method: "POST",
              path: "/api/erp/entities/" + s.resource,
              key: s.key,
              body: structuredClone(body),
              revision: body.revision ?? null,
              possiblySent: true,
            },
          };
          foundation().store.save(id, NAME, codec().decodeEntityPayload(next));
          p = codec().decodeEntityPayload(next);
          a.payload = p;
        }
        const frozen = foundation().store.beforeSend(id);
        if (JSON.stringify(frozen.body) !== JSON.stringify(body))
          throw Error(
            "Початковий запит незмінний. Повторіть точний запит або перевірте запис.",
          );
        warm = true;
        let session;
        try {
          session = await foundation().controller.verify(id);
        } finally {
          warm = false;
        }
        if (!session || active !== a || !d.open)
          throw Error("Доступ не підтверджено. Запит не надіслано.");
        a.hidden = false;
        a.d.querySelector("#tradeDialogTitle").textContent = a.heading;
        a.d.querySelector(".trade-dialog-body").hidden = false;
        a.d
          .querySelectorAll(".tk-popover")
          .forEach((el) => (el.hidden = false));
        a.d.querySelector("[data-entity-access]")?.remove();
        return frozen.body;
      },
      confirm(type, raw) {
        const event = { type, raw, draft: captureRaw() },
          next = codec().confirmEntityPayload(p, event);
        foundation().store.confirmed(id, event);
        if (next) {
          p = next;
          a.payload = p;
        }
        return next;
      },
    };
  }
  window.TradeEntityPersistence = {
    configure(value) {
      options = value;
    },
    prepare,
    enroll,
  };
  window.addEventListener("tsukenya:native-conflict-ready", () => register());
})();
