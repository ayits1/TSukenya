/* Monthly planning enrollment: frozen scope, raw rows and shared P0 privacy. */
(() => {
  "use strict";
  const NAME = "native-monthly-v1";
  let options,
    registered = false,
    active = null,
    sequence = 0,
    warm = false,
    reads = 0,
    authorized = null,
    restoredSignal = null;
  const foundation = () => {
    if (!window.NativeDraftRecovery || !window.NativeMonthlyPersistence)
      throw Error("Модуль локальних чернеток ще не готовий.");
    return window.NativeDraftRecovery;
  };
  const codec = () => window.NativeMonthlyPersistence,
    state = (p) => codec().decodeMonthlyState(p.baseline);
  const live = (a) => active === a && a.host.isConnected && a.isLive();
  function reveal(a) {
    if (!live(a)) return;
    a.hidden = false;
    a.host.querySelector("[data-monthly-private]").hidden = false;
    a.host.querySelector("[data-monthly-access]")?.remove();
  }
  function hide() {
    sequence++;
    const a = active;
    if (!a || !live(a)) return;
    a.hidden = true;
    if (!a.reading && !a.guardPending) a.cancel();
    a.host.querySelector("[data-monthly-private]").hidden = true;
    a.host.querySelectorAll(".tk-popover").forEach((x) => (x.hidden = true));
    let gate = a.host.querySelector("[data-monthly-access]");
    if (!gate) {
      gate = document.createElement("section");
      gate.className = "panel";
      gate.dataset.monthlyAccess = "";
      gate.innerHTML =
        '<p role="status">Бюджет приховано до підтвердження доступу.</p><button type="button" class="btn soft">Перевірити доступ до бюджету</button><button type="button" class="btn soft" data-monthly-read-cancel>Скасувати читання</button>';
      gate.querySelector("button").onclick = () =>
        foundation()
          .controller.check()
          .catch(() => {});
      gate.querySelector("[data-monthly-read-cancel]").onclick = () => {
        a.cancel();
        foundation().controller.dismiss();
      };
      a.host.append(gate);
    }
    gate.querySelector("button").disabled = Boolean(
      a.reading || a.guardPending,
    );
    gate.querySelector("[data-monthly-read-cancel]").hidden = !a.reading;
  }
  async function authorize(p, session, signal) {
    authorized = null;
    options.onSession?.(session);
    let receipt = null;
    const s = state(p),
      raw = await options.api(
        "monthly-budgets/recovery-context?" +
          new URLSearchParams({
            month: s.month,
            store: s.store ?? "",
            ...(s.id ? { id: s.id } : {}),
          }),
        "GET",
        undefined,
        signal,
      );
    codec().decodeMonthlyContext(raw, s, session);
    if (p.firstIntent?.method === "POST") {
      receipt = await options.api(
        "monthly-budgets/identity",
        "POST",
        { request: p.firstIntent.body },
        signal,
      );
      window.NativeMonthlyBudgetEditor.decodeIdentity(
        receipt,
        p.firstIntent.body,
      );
    }
    if (signal.aborted) throw new DOMException("Скасовано", "AbortError");
    authorized = { recordId: s.recordId, session, signal, payload: p, receipt };
    return true;
  }
  // Storage.authorized fences an unchanged record while codec.authorize runs.
  // Confirm only after that guard succeeds, before any independent current read.
  function finishAuthorization(p) {
    const auth = authorized;
    if (
      !auth ||
      auth.signal.aborted ||
      auth.recordId !== state(p).recordId ||
      JSON.stringify(auth.payload) !== JSON.stringify(p) ||
      !auth.receipt?.confirmed
    )
      return p;
    const event = { type: "identity", raw: auth.receipt, draft: p.draft },
      next = codec().confirmMonthlyPayload(p, event);
    foundation().store.confirmed(auth.recordId, event);
    auth.receipt = null;
    if (
      active &&
      live(active) &&
      state(active.payload).recordId === auth.recordId
    )
      active.adopt(next);
    return next;
  }
  function register() {
    if (registered) return;
    const f = foundation();
    f.register({
      name: NAME,
      version: 1,
      label: "План місячного бюджету",
      decode: codec().decodeMonthlyPayload,
      authorize,
      restore: async (p, signal) => {
        const session =
          authorized?.recordId === state(p).recordId
            ? authorized.session
            : null;
        if (!session) throw Error("Доступ не підтверджено.");
        await options.restore(
          finishAuthorization(codec().decodeMonthlyPayload(p)),
          signal,
          session,
        );
        if (!signal.aborted) restoredSignal = signal;
      },
      suspend: hide,
      confirm: codec().confirmMonthlyPayload,
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
            active?.host.querySelector("[name=planned_revenue]")?.focus();
          }
        });
      }
      if (!active?.hidden || warm || reads) return;
      const a = active,
        id = state(a.payload).recordId;
      if (!f.store.entries().some((e) => e.id === id)) {
        a.close();
        return;
      }
      warm = true;
      const pending = f.controller.verify(id),
        t = sequence;
      void pending
        .then((session) => {
          if (
            t !== sequence ||
            !live(a) ||
            document.visibilityState === "hidden"
          )
            return;
          if (session) {
            finishAuthorization(a.payload);
            reveal(a);
          } else if (!f.store.entries().some((e) => e.id === id)) a.close();
        })
        .finally(() => (warm = false));
    });
  }
  async function prepare(s, signal) {
    register();
    const session = await foundation().controller.check(false);
    options.onSession?.(session);
    if (signal?.aborted) throw new DOMException("Скасовано", "AbortError");
    const raw = await options.api(
      "monthly-budgets/recovery-context?" +
        new URLSearchParams({
          month: s.month,
          store: s.store ?? "",
          ...(s.id ? { id: s.id } : {}),
        }),
      "GET",
      undefined,
      signal,
    );
    codec().decodeMonthlyContext(raw, s, session);
    return session;
  }
  function enroll({
    host,
    initial,
    restored,
    captureRaw,
    isLive,
    cancel,
    close,
    onConfirmed,
  }) {
    register();
    let p = restored
      ? codec().decodeMonthlyPayload(restored)
      : codec().decodeMonthlyPayload({
          baseline: initial,
          draft: captureRaw(),
          firstIntent: null,
          confirmation: null,
        });
    const id = state(p).recordId,
      a = { host, payload: p, isLive, cancel, close, hidden: false };
    active = a;
    a.adopt = (next) => {
      p = next;
      a.payload = p;
      onConfirmed?.(p);
    };
    function capture(machine) {
      if (a.hidden) throw Error("Спочатку підтвердьте доступ до бюджету.");
      const next = codec().decodeMonthlyPayload({
        ...p,
        baseline: machine || p.baseline,
        draft: captureRaw(),
      });
      foundation().store.save(id, NAME, next);
      p = next;
      a.payload = p;
      return p;
    }
    const captureEvent = () => {
      if (!live(a) || a.hidden) return;
      try {
        capture();
        host.querySelector("[data-monthly-storage-error]")?.remove();
      } catch (error) {
        let el = host.querySelector("[data-monthly-storage-error]");
        if (!el) {
          el = document.createElement("p");
          el.dataset.monthlyStorageError = "";
          el.className = "trade-error";
          el.setAttribute("role", "alert");
          host.querySelector("[data-monthly-private]").prepend(el);
        }
        el.textContent = error.message;
      }
    };
    return {
      get payload() {
        return p;
      },
      capture,
      captureEvent,
      async read(read, signal) {
        if (!live(a)) throw new DOMException("Скасовано", "AbortError");
        warm = true;
        a.reading = (a.reading || 0) + 1;
        reads++;
        const pending = foundation().controller.verifyRead(
            id,
            (authorizedSignal) => {
              const combined = signal
                ? AbortSignal.any([signal, authorizedSignal])
                : authorizedSignal;
              if (combined.aborted || !live(a))
                throw new DOMException("Скасовано", "AbortError");
              finishAuthorization(p);
              return read(combined);
            },
          ),
          t = sequence;
        try {
          const result = await pending;
          if (signal?.aborted || t !== sequence || !live(a))
            throw new DOMException("Скасовано", "AbortError");
          if (!result)
            throw Error(
              "Доступ або поточний запис не підтверджено. Повторіть лише перевірку доступу.",
            );
          reveal(a);
          return result.value;
        } finally {
          a.reading--;
          reads--;
          warm = Boolean(a.reading);
          const gate = host.querySelector("[data-monthly-access]");
          if (gate) {
            gate.querySelector("button").disabled = Boolean(
              a.reading || a.guardPending,
            );
            gate.querySelector("[data-monthly-read-cancel]").hidden =
              !a.reading;
          }
        }
      },
      async before(body, method, path, machine) {
        capture(machine);
        if (!p.firstIntent) {
          const next = codec().decodeMonthlyPayload({
            ...p,
            firstIntent: {
              method,
              path: "/api/erp/" + path,
              key: state(p).key,
              body: structuredClone(body),
              revision: body.revision ?? null,
              possiblySent: true,
            },
          });
          foundation().store.save(id, NAME, next);
          p = next;
          a.payload = p;
        }
        const frozen = foundation().store.beforeSend(id);
        if (
          frozen.method !== method ||
          frozen.path !== "/api/erp/" + path ||
          JSON.stringify(frozen.body) !== JSON.stringify(body)
        )
          throw Error(
            "Початковий запит незмінний. Повторіть точний запит або прочитайте запис.",
          );
        warm = true;
        a.guardPending = true;
        let session;
        try {
          session = await foundation().controller.verify(id);
        } finally {
          warm = false;
          a.guardPending = false;
        }
        if (!session || !live(a))
          throw Error("Доступ не підтверджено. Запит не надіслано.");
        const prior = p;
        finishAuthorization(p);
        reveal(a);
        if (p !== prior)
          throw Object.assign(
            Error(
              "Початкове створення підтверджено. Прочитайте поточний бюджет і явно узгодьте чернетку.",
            ),
            { code: "create_confirmed" },
          );
        return frozen.body;
      },
      sendGuard() {
        const generation = sequence,
          hash = location.hash;
        return () =>
          generation === sequence &&
          hash === location.hash &&
          live(a) &&
          !a.hidden &&
          document.visibilityState !== "hidden";
      },
      confirm(type, raw) {
        const event = { type, raw, draft: captureRaw() },
          next = codec().confirmMonthlyPayload(p, event);
        foundation().store.confirmed(id, event);
        if (next) {
          p = next;
          a.payload = p;
        }
        return next;
      },
      detach() {
        if (active === a) {
          active = null;
          sequence++;
        }
      },
    };
  }
  window.MonthlyBudgetPersistence = {
    configure(v) {
      options = v;
    },
    prepare,
    enroll,
  };
  window.addEventListener("tsukenya:native-conflict-ready", register);
})();
