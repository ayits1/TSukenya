/* Global owner settings: frozen intent/identity and current comparison are separate transitions. */
(() => {
  "use strict";
  let config;
  const codec = () => window.NativeSettingPersistence;
  const titles = {
    period: "Обліковий період",
    fiscal: "Облік чеків ПРРО",
    "discount-limit": "Максимальна знижка касира",
  };
  window.TradeSettingEditor = {
    configure(value) {
      config = value;
    },
    async open(setting, restored = null) {
      const c = config,
        opening = c.context(),
        openingLive = () =>
          c.contextMatches(opening) && !restored?.signal.aborted;
      let session, s, initial;
      try {
        if (restored) {
          s = codec().decodeState(restored.payload.baseline);
          session = restored.session;
        } else {
          await window.TradeDraftPersistence.ensure();
          if (!openingLive()) return;
          session = await window.TradeSettingPersistence.prepare(
            { setting },
            undefined,
            openingLive,
          );
          if (!openingLive()) return;
          initial = codec().decodeCurrent(
            await c.api(
              "../v1/trading/settings/" + setting + "/current",
              "GET",
              undefined,
              undefined,
              false,
              openingLive,
            ),
            setting,
          );
          if (!openingLive()) return;
          if (
            initial.editing.role !== session.role ||
            initial.editing.storeId !== session.storeId ||
            initial.editing.networkOwner !== session.networkOwner
          )
            throw Object.assign(Error("Контекст доступу змінився."), {
              status: 403,
            });
          s = {
            recordId: "settings_" + crypto.randomUUID(),
            key: crypto.randomUUID(),
            setting,
            original: initial,
            needsReview: false,
          };
        }
      } catch (error) {
        if (openingLive() && error.name !== "AbortError") c.openError(error);
        return;
      }
      if (!openingLive()) return;
      const raw = restored
        ? codec().decodeRaw(restored.payload.draft)
        : { ...codec().rawFrom(setting, s.original.value), reason: "" };
      const html =
        setting === "period"
          ? c.alert(
              "Дата включно закриває редагування й проведення документів. Порожня дата відкриває період; усі зміни записуються в журнал.",
            ) +
            c.field(
              "Закрити по",
              c.input("date", raw.date, "date", `max="${c.yesterday()}"`),
            ) +
            c.field(
              "Причина",
              c.input(
                "reason",
                raw.reason,
                "text",
                'required maxlength="4000"',
              ),
            )
          : setting === "fiscal"
            ? c.alert(
                "Автоматичний зв’язок з ПРРО потребує налаштування провайдера. Тут змінюється вимога ручного номера вже виданого чека.",
              ) +
              c.field(
                "Номер чека",
                c.select(
                  "mode",
                  [
                    {
                      id: "optional",
                      name: "Необов’язковий — тільки управлінський облік",
                    },
                    { id: "required", name: "Обов’язковий номер чека ПРРО" },
                  ],
                  raw.mode,
                  true,
                ),
              )
            : c.alert(
                "Єдиний ліміт для мережі. Більшу знижку або продаж нижче собівартості менеджер чи власник проводить із причиною. Зміна ліміту записується в журнал.",
              ) +
              c.field(
                "Максимальна знижка, %",
                c.input(
                  "percent",
                  raw.percent,
                  "text",
                  'inputmode="decimal" required',
                ),
              );
      const d = c.modal(
        titles[setting],
        `<form id="tradeSettingForm"><div class="trade-form-grid">${html}</div><section class="wide" data-setting-recovery><p role="status"></p><button type="button" class="btn soft" data-setting-exact>Повторити початковий запит</button><button type="button" class="btn soft" data-setting-identity>Перевірити початкову операцію</button><button type="button" class="btn soft" data-setting-current>Перечитати поточне налаштування</button></section><section data-setting-result></section><div data-setting-comparison></div><button type="button" class="btn soft" data-setting-finish hidden>Завершити перегляд і оновити список</button><button type="submit" class="btn">Зберегти</button></form>`,
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
      for (const [key, value] of Object.entries(raw)) {
        const el = form.elements.namedItem(key);
        if (el) el.value = value;
      }
      let latest = null,
        reading = false,
        sending = false,
        comparison = null,
        transport = null,
        readGeneration = 0,
        ambiguous = Boolean(restored?.payload.firstIntent);
      const captureRaw = () =>
        Object.fromEntries(
          codec().rawKeys.map((key) => {
            const el = form.elements.namedItem(key);
            return [key, el ? el.value : raw[key] || ""];
          }),
        );
      const button = (key) => form.querySelector("[data-setting-" + key + "]");
      const stop = () => {
        readGeneration++;
        transport?.abort();
        transport = null;
        comparison?.unmount();
        comparison = null;
        reading = false;
        render();
      };
      if (restored) s.needsReview = true;
      const persistence = window.TradeSettingPersistence.enroll({
        d,
        form,
        initial: s,
        restored: restored ? { ...restored.payload, baseline: s } : null,
        captureRaw,
        cancel: stop,
        changed: () => render(),
        live,
      });
      function render() {
        const p = persistence.payload;
        s = codec().decodeState(p.baseline);
        const frozen = Boolean(p.firstIntent),
          confirmed = Boolean(p.confirmation),
          blocked = reading || sending || Boolean(comparison);
        button("exact").hidden = !frozen;
        button("exact").disabled = blocked;
        button("identity").hidden = !frozen;
        button("identity").disabled = blocked;
        button("current").disabled = blocked;
        button("finish").hidden = !confirmed || !latest;
        button("finish").disabled = blocked;
        form.querySelector("[type=submit]").disabled =
          blocked || frozen || confirmed || s.needsReview;
        form.querySelector("[data-setting-recovery] p").textContent = confirmed
          ? "Початкову операцію підтверджено. Повторний POST заборонено; новіші поля узгоджуйте окремо."
          : frozen
            ? "Результат початкового запиту не підтверджено. Точний повтор використовує лише початкові поля."
            : s.needsReview
              ? "Чернетку відновлено або версія змінилася. Перечитайте й явно узгодьте поточне налаштування."
              : "Зберігається поточна чернетка. Налаштування змінює лише власник.";
      }
      function showCurrent(row) {
        const current = codec().rawFrom(setting, row.value),
          visible =
            setting === "period"
              ? `Закрито включно: ${current.date || "Період відкрито"}. Причина: ${current.reason || "Не вказано в історії"}`
              : setting === "fiscal"
                ? `Номер чека: ${current.mode === "required" ? "Обов’язковий" : "Необов’язковий"}`
                : `Максимальна знижка: ${current.percent}%`;
        const host = form.querySelector("[data-setting-result]");
        host.replaceChildren();
        const p = document.createElement("p");
        p.className = "trade-caption";
        p.textContent = "Поточне серверне налаштування · " + visible;
        host.append(p);
      }
      async function currentRead(compare = true) {
        if (!live() || reading || sending) return;
        stop();
        reading = true;
        const g = ++readGeneration,
          controller = (transport = new AbortController());
        render();
        try {
          const row = await persistence.read(async (signal, grant) => {
            const input = await c.api(
              "../v1/trading/settings/" + setting + "/current",
              "GET",
              undefined,
              signal,
              false,
              () => live() && !signal.aborted && g === readGeneration,
            );
            const row = codec().decodeCurrent(input, setting);
            if (
              row.editing.role !== grant.role ||
              row.editing.storeId !== grant.storeId ||
              row.editing.networkOwner !== grant.networkOwner
            )
              throw Object.assign(Error("Контекст доступу змінився."), {
                status: 403,
              });
            return row;
          }, controller.signal);
          if (!live() || g !== readGeneration) return;
          latest = row;
          showCurrent(row);
          if (!compare || persistence.payload.firstIntent) return;
          const mine = captureRaw();
          codec().capture(setting, mine);
          comparison = window.NativeConflictComparison.mount(
            form.querySelector("[data-setting-comparison]"),
            {
              title: "Узгодження налаштування",
              base: codec().rawFrom(setting, s.original.value),
              mine,
              server: codec().rawFrom(setting, row.value),
              fields: codec().fields(setting),
              onCancel: stop,
              onApply: (merged) => {
                if (!live() || g !== readGeneration || latest !== row) return;
                try {
                  const next = { ...captureRaw(), ...merged };
                  codec().capture(setting, next);
                  persistence.confirm("apply", {
                    current: row,
                    merged: next,
                    key: crypto.randomUUID(),
                  });
                  for (const [key, value] of Object.entries(next)) {
                    const el = form.elements.namedItem(key);
                    if (el) el.value = value;
                  }
                  ambiguous = false;
                  d.dataset.dirty = "1";
                  form.dispatchEvent(new Event("tsukenya:draft-change"));
                  stop();
                } catch (error) {
                  c.formError(error, d);
                }
              },
            },
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
      async function identityRead() {
        if (!live() || reading || sending || !persistence.payload.firstIntent)
          return;
        stop();
        reading = true;
        const g = ++readGeneration,
          controller = (transport = new AbortController());
        render();
        try {
          const frozen = persistence.payload.firstIntent.body;
          const found = await persistence.read(async (signal) => {
            const result = await c.api(
              "../v1/trading/settings/" + setting + "/identity",
              "POST",
              { request: frozen },
              signal,
              false,
              () => live() && !signal.aborted && g === readGeneration,
            );
            codec().decodeIdentity(result, setting, s.key, frozen);
            return result;
          }, controller.signal);
          if (!live() || g !== readGeneration) return;
          if (found.confirmed) {
            persistence.confirm("identity", found);
            reading = false;
            render();
            await currentRead(false);
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
        if (!live() || sending || reading || comparison) return;
        try {
          let body;
          if (exact) {
            body = persistence.payload.firstIntent?.body;
            if (!body) return;
          } else {
            if (
              persistence.payload.confirmation ||
              persistence.payload.firstIntent ||
              s.needsReview
            )
              return;
            body = {
              ...codec().capture(setting, captureRaw()),
              revision: s.original.revision,
              idempotency_key: s.key,
            };
            codec().normalizeBody(setting, body);
          }
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
            await currentRead(false);
            return;
          }
          const controller = (transport = new AbortController());
          try {
            if (
              !live() ||
              controller.signal.aborted ||
              persistence.hidden ||
              document.visibilityState === "hidden"
            )
              return;
            const ack = await c.api(
              setting,
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
            await currentRead(false);
          } catch (error) {
            if (!live() || controller.signal.aborted) return;
            if (
              knownFirst &&
              [400, 409].includes(error.status) &&
              error.detail?.write_rejected === true
            )
              persistence.confirm("rejected", error.detail);
            else ambiguous = true;
            if (error.status === 401 || error.status === 403)
              await window.NativeDraftRecovery.controller
                .check(false)
                .catch(() => {});
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
        void c.refresh(null, external.tab);
      };
      button("exact").onclick = () => void save(true);
      button("identity").onclick = () => void identityRead();
      button("current").onclick = () => void currentRead();
      form.onsubmit = (e) => {
        e.preventDefault();
        void save();
      };
      form.addEventListener("input", render);
      form.addEventListener("change", render);
      d.addEventListener("close", stop, { once: true });
      render();
      return d;
    },
  };
})();
