/* One explicit till intent; persistence never recalculates cash or retries a confirmed action. */
(() => {
  "use strict";
  let config;
  const codec = () => window.NativeCashShiftPersistence;
  const state = (p) => codec().decodeState(p.baseline);
  window.TradeCashShiftEditor = {
    configure: (value) => {
      config = value;
    },
    async open(action, id, restored = null) {
      const c = config,
        opening = c.context(),
        openingLive = () =>
          c.contextMatches(opening) && !restored?.signal.aborted;
      if (!restored) await window.TradeDraftPersistence.ensure();
      if (!openingLive()) return;
      let s = restored
        ? state(restored.payload)
        : {
            recordId: "cashshift_" + crypto.randomUUID(),
            key: crypto.randomUUID(),
            action,
            id: id ? Number(id) : null,
            account: null,
            store: action === "open" ? c.openingStore() : null,
            original: null,
            needsReview: false,
          };
      try {
        if (!restored) {
          await window.TradeCashShiftPersistence.prepare(
            s,
            undefined,
            openingLive,
          );
          if (!openingLive()) return;
          if (action === "close") {
            s.original = codec().decodeCurrent(
              await c.api(
                "../v1/trading/cash-shifts/current?id=" + id,
                "GET",
                undefined,
                undefined,
                false,
                openingLive,
              ),
              Number(id),
            );
            if (!openingLive()) return;
            s.account = s.original.account;
            s.store = s.original.store;
          }
        }
      } catch (error) {
        if (openingLive()) c.openError(error);
        return;
      }
      if (!openingLive()) return;
      const raw = restored
        ? codec().decodeRaw(restored.payload.draft)
        : {
            account: "",
            employee: "",
            counted: "",
            note: s.original?.note || "",
          };
      const html =
        action === "open"
          ? c.field("Каса", c.select("account", [], raw.account, true)) +
            c.field(
              "Працівник",
              c.select("employee", [], raw.employee, false, "Без працівника"),
            )
          : c.field(
              "Порахована готівка, грн",
              c.input(
                "counted",
                raw.counted,
                "text",
                'inputmode="decimal" required',
              ),
            ) +
            c.field(
              "Примітка",
              c.input("note", raw.note, "text", 'maxlength="4000"'),
            );
      const d = c.modal(
        action === "open"
          ? "Відкриття касової зміни"
          : "Закриття касової зміни",
        `<form id="tradeCashShiftForm"><div class="trade-form-grid">${html}</div><section class="wide" data-cash-recovery><p role="status"></p><button type="button" class="btn soft" data-cash-exact>Повторити початковий запит</button><button type="button" class="btn soft" data-cash-identity>Перевірити початкову операцію</button><button type="button" class="btn soft" data-cash-current>Перечитати стан зміни</button></section><section data-cash-current-result></section><div data-cash-comparison></div><button type="button" class="btn soft" data-cash-finish hidden>Завершити перегляд і оновити список</button><button type="submit" class="btn">${action === "open" ? "Відкрити зміну" : "Закрити зміну"}</button></form>`,
        "",
        true,
      );
      const form = d.querySelector("form"),
        external = c.context(),
        live = () =>
          d.open &&
          d.isConnected &&
          c.contextMatches(external) &&
          !restored?.signal.aborted;
      if (action === "open") form.dataset.directoryPurpose = "shift_open";
      for (const [key, value] of Object.entries(raw)) {
        const el = form.elements.namedItem(key);
        if (el) el.value = value;
      }
      let latest = null,
        reading = false,
        transport = null,
        comparison = null,
        readGeneration = 0,
        ambiguous = Boolean(restored),
        sending = false;
      const captureRaw = () =>
        Object.fromEntries(
          codec().rawKeys.map((key) => {
            const el = form.elements.namedItem(key);
            return [key, el ? el.value : raw[key] || ""];
          }),
        );
      const stop = () => {
        readGeneration++;
        transport?.abort();
        transport = null;
        comparison?.unmount();
        comparison = null;
        reading = false;
        render();
      };
      s.needsReview =
        s.action === "close" && Boolean(restored || s.original?.closedAt);
      const persistence = window.TradeCashShiftPersistence.enroll({
        d,
        form,
        initial: s,
        restored: restored ? { ...restored.payload, baseline: s } : null,
        captureRaw,
        cancel: stop,
        changed: () => render(),
        live,
      });
      const button = (key) => form.querySelector("[data-cash-" + key + "]");
      function render() {
        const p = persistence.payload;
        s = state(p);
        const intent = Boolean(p.firstIntent),
          confirmed = Boolean(p.confirmation),
          readOnly = Boolean(latest?.closedAt || s.original?.closedAt),
          blocked = reading || sending || Boolean(comparison);
        button("exact").hidden = !intent;
        button("identity").hidden = !intent;
        button("current").hidden = !s.id || intent;
        button("finish").hidden = !confirmed || !latest;
        button("finish").disabled = blocked;
        for (const key of ["exact", "identity", "current"])
          button(key).disabled = blocked;
        form.querySelector("[type=submit]").disabled =
          blocked ||
          intent ||
          confirmed ||
          s.needsReview ||
          readOnly ||
          persistence.hidden;
        form.querySelector("[data-cash-recovery] [role=status]").textContent =
          confirmed
            ? `Початкову операцію підтверджено · зміна № ${s.id}. Повторний POST заборонено. Поточний стан читається окремо.`
            : intent
              ? "Результат початкового запиту не підтверджено. Новіші поля збережені; повтор використовує лише початковий зміст."
              : s.needsReview
                ? "Спочатку перечитайте стан і застосуйте порівняння. Збереження виконується окремою кнопкою."
                : "";
      }
      function currentResult(row) {
        const host = form.querySelector("[data-cash-current-result]");
        host.replaceChildren();
        const title = document.createElement("p");
        title.textContent = `Зміна № ${row.id} · ${row.closedAt ? "закрита" : "відкрита"}`;
        host.append(title);
        if (row.closedAt) {
          const text = document.createElement("p");
          text.textContent = `Очікувано: ${row.expectedCash} грн · пораховано: ${row.countedCash} грн. Збережені новіші поля не застосовані.`;
          host.append(text);
        }
      }
      async function currentRead() {
        if (
          !live() ||
          reading ||
          persistence.payload.firstIntent ||
          !state(persistence.payload).id
        )
          return;
        stop();
        reading = true;
        const g = ++readGeneration,
          controller = (transport = new AbortController());
        render();
        try {
          const row = await persistence.read(async (signal, session) => {
            const result = await c.api(
              "../v1/trading/cash-shifts/current?id=" + s.id,
              "GET",
              undefined,
              signal,
              false,
              () => live() && !signal.aborted && g === readGeneration,
            );
            const row = codec().decodeCurrent(result, s.id);
            if (
              row.editing.role !== session.role ||
              row.editing.storeId !== session.storeId ||
              row.editing.networkOwner !== session.networkOwner
            )
              throw Object.assign(Error("Контекст доступу змінився."), {
                status: 403,
              });
            return row;
          }, controller.signal);
          if (!live() || g !== readGeneration) return;
          if (row.store !== s.store || (s.account && row.account !== s.account))
            throw Error(
              "Магазин або каса зміни не збігаються. Ваші поля збережено.",
            );
          latest = row;
          currentResult(row);
          if (
            s.action === "close" &&
            !row.closedAt &&
            !persistence.payload.confirmation
          ) {
            const mine = codec().captureClose(captureRaw()),
              original = s.original;
            if (!original)
              throw Error("Початкову версію зміни не підтверджено.");
            const host = form.querySelector("[data-cash-comparison]");
            comparison = window.NativeConflictComparison.mount(host, {
              title: "Перевірте закриття касової зміни",
              base: {
                counted: original.countedCash || "",
                note: original.note,
              },
              mine,
              server: { counted: row.countedCash || "", note: row.note },
              fields: [
                {
                  id: "closing",
                  label: "Порахована готівка та примітка",
                  keys: ["counted", "note"],
                  decimals: ["counted"],
                },
              ],
              onCancel: stop,
              onApply: (merged) => {
                if (!live() || g !== readGeneration || latest !== row) return;
                try {
                  codec().captureClose({ ...captureRaw(), ...merged });
                  persistence.confirm("apply", row);
                  for (const [key, value] of Object.entries(merged))
                    form.elements.namedItem(key).value = value;
                  d.dataset.dirty = "1";
                  form.dispatchEvent(new Event("tsukenya:draft-change"));
                  stop();
                } catch (error) {
                  c.formError(error, d);
                }
              },
            });
          }
        } catch (error) {
          if (live() && g === readGeneration && error.name !== "AbortError")
            c.formError(error, d);
        } finally {
          if (live() && g === readGeneration) {
            reading = false;
            transport = null;
            render();
          }
        }
      }
      async function identityRead() {
        if (!live() || reading || !persistence.payload.firstIntent) return;
        stop();
        reading = true;
        const g = ++readGeneration,
          controller = (transport = new AbortController());
        render();
        try {
          const frozen = persistence.payload.firstIntent.body;
          const found = await persistence.read(async (signal) => {
            const raw = await c.api(
              "../v1/trading/cash-shifts/identity",
              "POST",
              { request: frozen },
              signal,
              false,
              () => live() && !signal.aborted && g === readGeneration,
            );
            codec().decodeIdentity(raw, s.key, frozen);
            return raw;
          }, controller.signal);
          if (!live() || g !== readGeneration) return;
          if (found.confirmed) {
            persistence.confirm("identity", found);
            reading = false;
            render();
            await currentRead();
          } else
            c.formError(
              Error(
                "Початковий receipt ще не знайдено. Це не доводить відсутність операції; початковий запит збережено.",
              ),
              d,
            );
        } catch (error) {
          if (live() && g === readGeneration && error.name !== "AbortError")
            c.formError(error, d);
        } finally {
          if (live() && g === readGeneration) {
            reading = false;
            transport = null;
            render();
          }
        }
      }
      async function save(exact = false) {
        if (
          !live() ||
          sending ||
          reading ||
          comparison ||
          persistence.payload.confirmation ||
          (!exact && state(persistence.payload).needsReview)
        )
          return;
        let body;
        try {
          if (exact) body = persistence.payload.firstIntent?.body;
          else {
            const r = captureRaw();
            body =
              s.action === "open"
                ? {
                    action: "open",
                    account: r.account,
                    employee: r.employee,
                    idempotency_key: s.key,
                  }
                : {
                    action: "close",
                    id: String(s.id),
                    ...codec().captureClose(r),
                    revision: s.original.revision,
                    idempotency_key: s.key,
                  };
            codec().normalizeBody(body);
          }
          if (!body) return;
          const knownFirst = !ambiguous && !persistence.payload.firstIntent;
          sending = true;
          d.dataset.busy = "1";
          d.setAttribute("aria-busy", "true");
          render();
          const verified = await persistence.before(body);
          if (
            !live() ||
            document.visibilityState === "hidden" ||
            persistence.hidden
          )
            return;
          if (verified.confirmed) {
            sending = false;
            render();
            await currentRead();
            return;
          }
          const controller = (transport = new AbortController());
          try {
            // Last live fence is after session/context/identity preflight and immediately before mutation.
            if (
              !live() ||
              controller.signal.aborted ||
              persistence.hidden ||
              document.visibilityState === "hidden"
            )
              return;
            const ack = await c.api(
              "shifts",
              "POST",
              verified.body,
              controller.signal,
              false,
              () => live() && !controller.signal.aborted,
            );
            if (!live() || controller.signal.aborted) return;
            persistence.confirm("ack", ack);
            sending = false;
            render();
            await currentRead();
          } catch (error) {
            if (!live() || controller.signal.aborted) return;
            if (
              knownFirst &&
              [400, 409].includes(error.status) &&
              error.detail?.write_rejected === true
            ) {
              persistence.confirm("rejected", error.detail);
            } else ambiguous = true;
            if (error.status === 401 || error.status === 403) {
              await window.NativeDraftRecovery.controller
                .check(false)
                .catch(() => {});
            }
            c.formError(error, d);
          }
        } catch (error) {
          if (live() && error.name !== "AbortError") c.formError(error, d);
        } finally {
          delete d.dataset.busy;
          d.removeAttribute("aria-busy");
          if (live()) {
            sending = false;
            transport = null;
            render();
          }
        }
      }
      button("finish").onclick = () => {
        if (!live() || sending || reading) return;
        d.dataset.dirty = "";
        d.close();
        void c.refresh(s.id, external.tab);
      };
      form.onsubmit = (e) => {
        e.preventDefault();
        void save();
      };
      button("exact").onclick = () => void save(true);
      button("identity").onclick = () => void identityRead();
      button("current").onclick = () => void currentRead();
      form.addEventListener("input", render);
      form.addEventListener("change", render);
      d.addEventListener("close", stop, { once: true });
      render();
      return d;
    },
  };
})();
