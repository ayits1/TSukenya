/* Same-tab drafts: explicit raw capture, frozen sent intent, and read-only authorization. */
(() => {
  "use strict";
  const NAME = "native-voucher-v1";
  let registered = false,
    options = null,
    active = null,
    sequence = 0,
    pendingClose = null,
    warmPending = false;
  const foundation = () => {
    const f = window.NativeDraftRecovery;
    if (!f || !window.NativeVoucherPersistence)
      throw Error(
        "Модуль локальних чернеток ще не готовий. Повторіть відкриття.",
      );
    return f;
  };
  const codec = () => window.NativeVoucherPersistence;
  const state = (payload) => codec().decodeVoucherState(payload.baseline);
  async function authorize(payload, session, signal) {
    const s = state(payload);
    if (s.identity.id) {
      const raw = await options.api(
        "vouchers/" + s.identity.id + "?purpose=recovery",
        "GET",
        undefined,
        signal,
      );
      const row = window.NativeVoucherEditor.decodeVoucher(raw, {
        id: s.identity.id,
        kind: s.identity.kind,
      });
      if (
        row.editing.role !== session.role ||
        row.editing.storeId !== session.storeId
      )
        throw Object.assign(Error("Доступ змінився."), { status: 403 });
    } else {
      const input = s.identity,
        raw = await options.api(
          "vouchers/recovery-context?" +
            new URLSearchParams({
              kind: input.kind,
              store: String(input.store),
              date: payload.draft.fields.date,
              expense_scope:
                payload.firstIntent?.body.payload?.expense_scope ||
                (s.projection
                  ? window.NativeVoucherEditor.voucherFromProjection(
                      s.projection,
                    ).payload.expense_scope
                  : "store") ||
                "store",
            }),
          "GET",
          undefined,
          signal,
        );
      if (
        raw?.editing &&
        (raw.editing.role !== session.role ||
          raw.editing.storeId !== session.storeId)
      )
        throw Object.assign(Error("Доступ змінився."), { status: 403 });
      codec().decodeContext(raw, input, session);
    }
    const production = payload.draft.production;
    if (production?.mode === "version") {
      const original = production.terms,
        current = window.NativeRecipeEditor.decodeVersion(
          await options.api(
            "recipes/versions/" + original.id,
            "GET",
            undefined,
            signal,
          ),
          original.product,
          original.id,
        ),
        terms = (r) =>
          JSON.stringify({
            id: r.id,
            product: r.product,
            outputQuantity: r.outputQuantity,
            expiryPolicy: r.expiryPolicy,
            shelfLifeDays: r.shelfLifeDays,
            components: r.components.map((c) => ({
              product: c.product,
              quantity: c.quantity,
            })),
          });
      if (terms(current) !== terms(original))
        throw Error(
          "Збережені умови рецептури не підтверджено. Чернетку не підмінено.",
        );
    }
    return true;
  }
  function suspended() {
    ++sequence;
    if (active?.d.open) {
      const a = active;
      a.suspended = true;
      a.d.querySelector("#tradeDialogTitle").textContent =
        "Локальна чернетка призупинена";
      a.d.querySelector(".trade-dialog-body").hidden = true;
      const foot = a.d.querySelector(".trade-dialog-foot");
      if (foot) foot.hidden = true;
      let gate = a.d.querySelector("[data-draft-access-gate]");
      if (!gate) {
        gate = document.createElement("section");
        gate.dataset.draftAccessGate = "";
        gate.className = "trade-dialog-body";
        gate.innerHTML =
          '<p role="status">Форму приховано до підтвердження доступу. Перевірка не записує бізнес-дані.</p><button type="button" class="btn soft">Перевірити доступ до форми</button>';
        gate.querySelector("button").onclick = () =>
          foundation()
            .controller.check()
            .catch(() => {});
        a.d.append(gate);
      }
    }
  }
  function register() {
    if (registered) return;
    const f = foundation();
    f.register({
      name: NAME,
      version: 1,
      label: "Документ або платіж",
      decode: codec().decodeVoucherPayload,
      authorize: async (payload, session, signal) => {
        return authorize(payload, session, signal);
      },
      restore: async (payload, signal) => {
        if (signal.aborted) return;
        await options.restore(codec().decodeVoucherPayload(payload), signal);
        if (signal.aborted) return;
        pendingClose = signal;
      },
      suspend: suspended,
      confirm: codec().confirmVoucherPayload,
    });
    registered = true;
    // Warm editor focus is an authorization-only re-show; cold records always need explicit Restore.
    f.controller.subscribe(() => {
      if (f.controller.snapshot().state === "ready" && pendingClose) {
        const signal = pendingClose;
        pendingClose = null;
        queueMicrotask(() => {
          if (!signal.aborted) {
            f.close();
            active?.d
              .querySelector("input:not([type=hidden]),textarea,button")
              ?.focus();
          }
        });
      }
      if (
        f.controller.snapshot().state !== "ready" ||
        !active?.suspended ||
        warmPending
      )
        return;
      const a = active,
        id = state(a.payload).identity.recordId;
      if (
        !f.store
          .entries()
          .some((entry) => entry.id === id && entry.state !== "unreadable")
      ) {
        a.d.close();
        a.d.remove();
        return;
      }
      warmPending = true;
      const pending = f.controller.verify(id),
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
            if (!f.store.entries().some((entry) => entry.id === id)) {
              a.d.close();
              a.d.remove();
            }
            return;
          }
          a.suspended = false;
          a.d.querySelector("#tradeDialogTitle").textContent = a.heading;
          a.d.querySelector(".trade-dialog-body").hidden = false;
          const foot = a.d.querySelector(".trade-dialog-foot");
          if (foot) foot.hidden = false;
          a.d.querySelector("[data-draft-access-gate]")?.remove();
        })
        .finally(() => {
          warmPending = false;
        });
    });
  }
  async function ensure() {
    register();
    const session = await foundation().controller.check(false);
    return session;
  }
  function fields(form) {
    return Object.fromEntries(
      codec().fieldNames.map((key) => [
        key,
        form.elements.namedItem(key)?.value || "",
      ]),
    );
  }
  function lineValues(form) {
    return [...form.querySelectorAll(".trade-line")].map((row) =>
      Object.fromEntries(
        codec().lineNames.map((key) => [
          key,
          row.querySelector("[data-line=" + key + "]")?.value || "",
        ]),
      ),
    );
  }
  function enroll({ d, form, v, captureRaw, restored }) {
    register();
    const initial = restored ? codec().decodeVoucherPayload(restored) : null,
      id = initial
        ? state(initial).identity.recordId
        : "voucher_" + crypto.randomUUID();
    let payload = initial || {
      baseline: {
        identity: {
          recordId: id,
          kind: v.kind,
          store: Number(v.store),
          id: v.id || null,
          revision: v.revision || null,
          key: v.idempotency_key,
        },
        projection: v.id
          ? window.NativeVoucherEditor.voucherProjection(
              window.NativeVoucherEditor.voucherBodyFromRecord(v),
            )
          : null,
        needsReview: false,
        postUnknown: false,
        confirmedId: null,
        confirmedRead: false,
      },
      draft: captureRaw(),
      firstIntent: null,
      confirmation: null,
    };
    const a = {
      d,
      form,
      payload,
      suspended: false,
      heading: d.querySelector("#tradeDialogTitle").textContent,
    };
    active = a;
    function capture(machine) {
      if (machine) {
        payload.baseline = {
          ...payload.baseline,
          ...machine,
          identity: {
            ...payload.baseline.identity,
            id: v.id || null,
            revision: v.revision || null,
            store: Number(v.store),
          },
        };
      }
      payload.draft = captureRaw();
      payload = codec().decodeVoucherPayload(payload);
      foundation().store.save(id, NAME, payload);
      a.payload = payload;
      return payload;
    }
    function before(method, path, body, machine) {
      capture(machine);
      if (payload.firstIntent) {
        const frozen = foundation().store.beforeSend(id);
        if (
          frozen.method !== method ||
          frozen.path !== path ||
          JSON.stringify(frozen.body) !== JSON.stringify(body)
        )
          throw Error(
            "Первісний запит ще не підтверджено. Перевірте поточний документ.",
          );
        return frozen.body;
      }
      payload.firstIntent = {
        method,
        path,
        key: state(payload).identity.key,
        body: structuredClone(body),
        revision: body.revision ?? null,
        possiblySent: true,
      };
      capture();
      return foundation().store.beforeSend(id).body;
    }
    function confirmed(type, raw) {
      const event = { type, raw, draft: captureRaw() },
        next = codec().confirmVoucherPayload(payload, event);
      foundation().store.confirmed(id, event);
      if (next) {
        payload = next;
        a.payload = payload;
      } else {
        active = null;
      }
      return next;
    }
    const captureEvent = () => {
      if (!d.open || a.suspended) return;
      try {
        capture();
        form.querySelector("[data-draft-storage-error]")?.remove();
      } catch (error) {
        let p = form.querySelector("[data-draft-storage-error]");
        if (!p) {
          p = document.createElement("p");
          p.dataset.draftStorageError = "";
          p.className = "trade-error";
          p.setAttribute("role", "alert");
          form.prepend(p);
        }
        p.textContent = error.message;
      }
    };
    form.addEventListener("input", captureEvent);
    form.addEventListener("change", captureEvent);
    form.addEventListener("tsukenya:draft-change", captureEvent);
    d.addEventListener(
      "close",
      () => {
        ++sequence;
        if (active === a) active = null;
      },
      { once: true },
    );
    captureEvent();
    return {
      capture,
      before,
      confirmed,
      get payload() {
        return payload;
      },
      get state() {
        return state(payload);
      },
      get first() {
        return payload.firstIntent;
      },
    };
  }
  function seed(payload) {
    const s = state(payload),
      r = codec().decodeRawVoucher(payload.draft),
      f = r.fields;
    const production = r.production;
    return {
      ...f,
      id: s.identity.id,
      revision: s.identity.revision,
      kind: s.identity.kind,
      store: Number(f.store) || s.identity.store,
      idempotency_key: s.identity.key,
      lines: r.lines.map((row) => ({
        ...row,
        reference_line: row.reference_line ? Number(row.reference_line) : null,
      })),
      allocations: r.allocations,
      reference: r.reference ?? (f.reference ? Number(f.reference) : null),
      unallocated: r.available,
      payload: {
        ...f,
        payments: r.payments,
        shift_ids: r.payrollIds,
        recipe: production?.recipe || [],
        ...(production?.terms
          ? {
              production: {
                source: "version",
                terms: production.terms,
                plannedOutput: production.plannedOutput,
                components: production.components,
                varianceReason: production.varianceReason,
                expiryOverride: production.ownerExpiry
                  ? {
                      date: production.ownerExpiry,
                      reason: production.ownerExpiryReason,
                    }
                  : null,
              },
            }
          : {}),
      },
    };
  }
  window.addEventListener("tsukenya:native-conflict-ready", () => {
    register();
    const account = document.getElementById("accountLink");
    if (account && !document.querySelector("[data-native-drafts]")) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "btn soft";
      button.dataset.nativeDrafts = "";
      button.textContent = "Локальні чернетки";
      button.onclick = () => foundation().open();
      account.after(button);
    }
  });
  window.TradeDraftPersistence = {
    configure(value) {
      options = value;
    },
    ensure,
    enroll,
    fields,
    lineValues,
    seed,
    open() {
      register();
      foundation().open();
    },
  };
})();
