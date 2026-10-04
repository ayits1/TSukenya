/* Live legacy UPDATE and immutable approved CREATE share raw drafts, not write semantics. */
(() => {
  "use strict";
  let opening = 0;
  async function open({
    mode,
    api,
    esc,
    field,
    input,
    num,
    select,
    modal,
    markDirty,
    busyDialog,
    formError,
    onSaved,
    restore,
  }) {
    const legacy = mode === "legacy",
      a = window.NativeRecipeEditor,
      codec = window.NativeRecipePersistence,
      persistence = window.TradeRecipePersistence;
    if (!a || !codec || !persistence)
      throw Error("Редактор рецептур ще завантажується. Повторіть дію.");
    const ticket = ++opening,
      hash = location.hash,
      previous = document.querySelector(".trade-dialog[open]");
    if (!restore) {
      try {
        await persistence.prepare(mode, "");
      } catch (error) {
        if (
          ticket !== opening ||
          location.hash !== hash ||
          document.querySelector(".trade-dialog[open]") !== previous
        )
          return;
        throw error;
      }
    }
    if (
      ticket !== opening ||
      location.hash !== hash ||
      restore?.signal.aborted ||
      document.querySelector(".trade-dialog[open]") !== previous
    )
      return;
    const id = legacy ? "tradeRecipeForm" : "recipeVersionForm",
      button = (label, action) =>
        `<button class="btn soft" type="button" data-recipe-action="${action}" ${legacy && action === "add" ? 'data-trade="add-recipe"' : legacy && action === "remove" ? 'data-trade="remove-recipe"' : ""}>${label}</button>`;
    const d = modal(
      legacy ? "Рецептура готового товару" : "Затвердити нову версію рецептури",
      `<form id="${id}" data-directory-purpose="${legacy ? "legacy_recipe" : "recipe"}" novalidate><div class="trade-form-grid">${field("Готовий товар", '<select name="product" required><option value="">Оберіть товар</option></select>', "wide")}${
        legacy
          ? ""
          : field(
              "Нормативний вихід",
              input(
                "outputQuantity",
                "1.000",
                "text",
                'inputmode="decimal" required',
              ),
            ) +
            field(
              "Технологічна політика придатності",
              select(
                "expiryPolicy",
                Object.entries(a.policies).map(([id, name]) => ({ id, name })),
                "unspecified",
                true,
              ),
            ) +
            field(
              "Технологічний строк, календарних днів",
              input(
                "shelfLifeDays",
                "",
                "text",
                'inputmode="numeric" disabled',
              ),
            ) +
            field(
              "Причина нового затвердження",
              input("reason", "", "text", 'required maxlength="500"'),
              "wide",
            )
      }</div><p class="trade-caption">${legacy ? "Кількість сировини на одну одиницю готового товару. Збереження змінює лише поточну рецептуру картки; затверджені версії та збережені виробничі документи залишаються незмінними." : "Норматив на вказаний вихід. Кожне збереження створює незмінну версію. Придатність визначає явно вибрана технологічна політика."}</p><p data-recipe-status role="status" aria-live="polite"></p><div data-recipe-rows id="tradeRecipeLines"></div><div class="trade-production-actions">${button("Додати інгредієнт", "add")}${button("Повторити читання", "read")}${button("Скасувати читання", "cancel")}${button("Повторити початкове затвердження", "exact")}</div><div data-recipe-comparison></div></form>`,
      `<button class="btn" type="submit" form="${id}">${legacy ? "Зберегти" : "Затвердити версію"}</button>`,
    );
    const form = d.querySelector("form"),
      rows = d.querySelector("[data-recipe-rows]"),
      product = form.elements.product,
      save = d.querySelector("[type=submit]"),
      status = d.querySelector("[data-recipe-status]"),
      host = d.querySelector("[data-recipe-comparison]"),
      readButton = d.querySelector("[data-recipe-action=read]"),
      cancel = d.querySelector("[data-recipe-action=cancel]"),
      exact = d.querySelector("[data-recipe-action=exact]");
    let state = restore
      ? codec.decodeState(restore.payload.baseline)
      : {
          recordId: "recipe_" + crypto.randomUUID(),
          key: crypto.randomUUID(),
          mode,
          original: null,
          needsReview: false,
        };
    let baseline = state.original,
      base = baseline?.projection || null,
      committed = baseline?.product.id || "",
      requested = "",
      reading = false,
      busy = false,
      review = !!restore && !!baseline,
      handle = null,
      controller = null,
      generation = 0,
      store = null;
    const live = (n) =>
      d.open && d.isConnected && generation === n && !restore?.signal.aborted;
    const row = (r) =>
      `<div data-row-key="${esc(r.rowKey || crypto.randomUUID())}" class="${legacy ? "trade-payment-row trade-recipe-row" : "trade-production-component"}">${field("Інгредієнт", `<select ${legacy ? "data-recipe" : "data-component"}="product" required><option value="">Оберіть інгредієнт</option>${r.product ? `<option value="${esc(r.product)}" selected>Завантажуємо вибраний товар…</option>` : ""}</select>`)}${field(legacy ? "Кількість на 1 од." : "Кількість на нормативний вихід", `<input ${legacy ? "data-recipe" : "data-component"}="quantity" type="text" inputmode="decimal" value="${esc(r.quantity ?? "")}" required>`)}${button("×", "remove").replace("<button ", '<button aria-label="Прибрати інгредієнт" ')}</div>`;
    const raw = () => ({
      product: product.value,
      components: [...rows.children].map((r) => ({
        rowKey: r.dataset.rowKey,
        product: r.querySelector("select").value,
        quantity: r.querySelector(
          "[data-recipe=quantity],[data-component=quantity]",
        ).value,
      })),
      outputQuantity: legacy ? "" : form.elements.outputQuantity.value,
      expiryPolicy: legacy ? "" : form.elements.expiryPolicy.value,
      shelfLifeDays: legacy ? "" : form.elements.shelfLifeDays.value,
      reason: legacy ? "" : form.elements.reason.value,
    });
    const rawDraft = () => codec.draftProjection(raw(), legacy),
      capture = () => a.validateDraft(rawDraft(), committed, legacy);
    const first = () => store?.payload.firstIntent,
      confirmed = () => store?.payload.confirmation;
    function remember() {
      state = { ...state, original: baseline, needsReview: review };
      return store.capture(state);
    }
    function controls() {
      const locked = busy || reading;
      form.querySelectorAll("input,select,textarea,button").forEach((e) => {
        if (!host.contains(e)) e.disabled = locked;
      });
      product.disabled = locked || !!first() || !!confirmed();
      save.disabled =
        locked || !committed || review || !!first() || !!confirmed();
      readButton.hidden =
        reading || (!review && !!baseline && !first() && !confirmed());
      readButton.disabled = busy || reading;
      readButton.textContent =
        first() && !legacy
          ? "Перевірити початкове затвердження"
          : baseline
            ? "Порівняти з поточною версією"
            : "Повторити читання";
      cancel.hidden = !reading || !!handle;
      cancel.disabled = busy;
      exact.hidden = legacy || !first();
      exact.disabled = busy || reading;
      form.querySelector("[data-recipe-action=add]").disabled =
        locked || !committed;
      if (!legacy)
        form.elements.shelfLifeDays.disabled =
          locked ||
          form.elements.expiryPolicy.value !== "minimum_with_shelf_life";
      window.TradeDirectories.sync(form);
    }
    function fillRaw(value) {
      product.innerHTML = `<option value="">Оберіть товар</option>${value.product ? `<option value="${esc(value.product)}" selected>${esc(baseline?.product.name || value.product)}</option>` : ""}`;
      rows.innerHTML = value.components.map(row).join("");
      if (!legacy)
        for (const key of [
          "outputQuantity",
          "expiryPolicy",
          "shelfLifeDays",
          "reason",
        ])
          form.elements[key].value = value[key] ?? "";
      window.TradeDirectories.scan(d);
    }
    function fill(draft) {
      const old = raw().components;
      rows.innerHTML = JSON.parse(draft.components)
        .map((r) =>
          row({
            ...r,
            rowKey: old.find((x) => x.product === r.product)?.rowKey,
          }),
        )
        .join("");
      if (!legacy)
        for (const key of [
          "outputQuantity",
          "expiryPolicy",
          "shelfLifeDays",
          "reason",
        ])
          form.elements[key].value = draft[key] ?? "";
      window.TradeDirectories.scan(d);
    }
    const stop = () => {
      ++generation;
      controller?.abort();
      controller = null;
      handle?.unmount();
      handle = null;
      host.replaceChildren();
      reading = false;
      controls();
    };
    async function fetchCurrent(id, signal) {
      const value = await api(
        legacy
          ? "recipes?" + new URLSearchParams({ product: id })
          : "recipes/versions?" + new URLSearchParams({ product: id }),
        "GET",
        undefined,
        signal,
      );
      return legacy ? a.decodeLegacy(value, id) : a.decodeList(value, id);
    }
    async function read({ initial = false, complete = false } = {}) {
      if (busy || reading) return;
      const id = initial ? requested : committed;
      if (!id) return;
      const n = ++generation;
      controller?.abort();
      controller = new AbortController();
      reading = true;
      controls();
      status.textContent = "Перевіряємо доступ і поточні умови без запису…";
      d.querySelector("#tradeFormError").textContent = "";
      try {
        const result = await store.read(async (signal) => {
          let identity = null;
          const request = first()?.body || confirmed()?.body;
          if (!legacy && request) {
            identity = await api(
              "recipes/versions/identity",
              "POST",
              { request },
              signal,
              false,
            );
            codec.decodeIdentity(identity, request);
            if (!identity.confirmed) return { identity, latest: null };
          }
          const latest = await fetchCurrent(id, signal);
          if (!(legacy ? latest.canEdit : latest.canApprove))
            throw Object.assign(
              Error("Поточна роль не дозволяє роботу з рецептурою."),
              { status: 403 },
            );
          return { identity, latest };
        }, controller.signal);
        if (!live(n)) return;
        if (!legacy && first()) {
          if (!result.identity?.confirmed) {
            reading = false;
            status.textContent =
              "Первісний запит ще не підтверджено. Можна повторити лише ті самі умови; нове введення збережено окремо.";
            controls();
            return;
          }
          store.confirm("identity", result.identity);
          state = codec.decodeState(store.payload.baseline);
          review = true;
        }
        const latest = result.latest;
        if (!latest) throw Error("Первісну версію не підтверджено.");
        if (baseline && latest.product.unit !== baseline.product.unit)
          throw Error(
            "Одиницю готового товару змінено. Чернетка збережена; автоматичне узгодження недоступне.",
          );
        if (initial) {
          baseline = codec.original(latest);
          base = baseline.projection;
          committed = id;
          requested = id;
          product.value = id;
          fill(base);
          review = false;
          remember();
          d.dataset.dirty = "";
          reading = false;
          status.textContent = legacy
            ? "Поточну рецептуру завантажено."
            : "Поточні умови завантажено. Задайте причину нового затвердження.";
          controls();
          return;
        }
        if (complete && confirmed()) {
          // A confirmed write is never retried, even if this read fails after the ACK.
          let done;
          try {
            done =
              store.confirm("complete", legacy ? latest : result.identity) ===
              null;
          } catch {
            done = false;
          }
          if (done) {
            d.dataset.dirty = "";
            d.close();
            await onSaved();
            return;
          }
        }
        let mine;
        try {
          mine = capture();
        } catch {
          throw Error(
            "Поточні умови прочитано, але нове введення потребує виправлення. Перевірте кількості та причину, потім повторіть порівняння.",
          );
        }
        const server = a.projection(latest),
          names = Object.fromEntries(
            [
              ...JSON.parse(base.components),
              ...JSON.parse(mine.components),
              ...JSON.parse(server.components),
            ].map((r) => [
              r.product,
              window.TradeDirectories.get("products", r.product)?.name ||
                r.product,
            ]),
          );
        status.textContent =
          "Порівняння готове. Застосування оновить лише чернетку; збереження — окрема дія.";
        handle = window.NativeConflictComparison.mount(host, {
          base,
          mine,
          server,
          fields: a.recipeFields([base, mine, server], names, legacy),
          title: "Узгодити рецептуру",
          onCancel: () => {
            if (live(n)) {
              stop();
              status.textContent = "Чернетка збережена.";
              readButton.focus();
            }
          },
          onApply: (merged) => {
            if (!live(n)) return;
            try {
              a.validateDraft(merged, id, legacy);
              fill(merged);
              store.confirm("apply", {
                current: latest,
                key: crypto.randomUUID(),
              });
              state = codec.decodeState(store.payload.baseline);
              baseline = state.original;
              base = baseline.projection;
              review = false;
              stop();
              markDirty(d);
              remember();
              controls();
              status.textContent =
                "Узгоджено лише чернетку. Збережіть її окремим натисканням.";
              save.focus();
            } catch (error) {
              formError(error, d);
            }
          },
        });
        controls();
      } catch (error) {
        if (!live(n) || error.name === "AbortError") return;
        stop();
        review = !!baseline;
        status.textContent =
          "Поточні умови не підтверджено. Введення збережено.";
        if (!store.hidden) {
          try {
            remember();
          } catch {}
          formError(error, d);
          readButton.hidden = false;
          readButton.focus();
        }
      }
    }
    async function write(exactRetry = false) {
      if (
        busy ||
        reading ||
        store.hidden ||
        (review && !exactRetry) ||
        !baseline
      )
        return;
      let payload;
      const priorIntent = !!first();
      try {
        if (exactRetry) {
          if (legacy || !first()) return;
          payload = first().body;
        } else {
          if (first() || confirmed()) return;
          const draft = capture();
          if (!form.reportValidity()) return;
          if (
            legacy &&
            !JSON.parse(draft.components).length &&
            JSON.parse(base.components).length &&
            !confirm("Зберегти порожню поточну рецептуру?")
          )
            return;
          payload = legacy
            ? {
                product: committed,
                recipe: JSON.parse(draft.components),
                revision: baseline.revision,
              }
            : {
                idempotencyKey: state.key,
                product: committed,
                expectedVersion: baseline.latestVersion,
                catalogRevision: baseline.revision,
                outputQuantity: draft.outputQuantity,
                components: JSON.parse(draft.components),
                expiryPolicy: draft.expiryPolicy,
                shelfLifeDays: draft.shelfLifeDays,
                reason: draft.reason,
              };
        }
        remember();
      } catch (error) {
        formError(error, d);
        return;
      }
      busy = true;
      controls();
      const finish = busyDialog(
        d,
        legacy
          ? "Збереження поточної рецептури…"
          : "Затвердження незмінної версії…",
      );
      if (!finish) {
        busy = false;
        controls();
        return;
      }
      let acknowledged = false;
      try {
        payload = await store.before(payload);
        const value = await api(
          legacy ? "recipes" : "recipes/versions",
          "POST",
          payload,
        );
        if (!d.open) return;
        store.confirm("ack", value);
        state = codec.decodeState(store.payload.baseline);
        review = true;
        acknowledged = true;
        status.textContent =
          "Запис підтверджено. Перевіряємо поточні умови; повторне збереження заблоковано.";
      } catch (error) {
        review = true;
        if (!store.hidden) {
          if (
            !legacy &&
            !priorIntent &&
            [400, 409].includes(error.status) &&
            error.detail?.write_rejected === true
          ) {
            try {
              const proof = error.detail;
              store.confirm("rejected", {
                write_rejected: proof.write_rejected,
                request_key: proof.request_key,
                product: proof.product,
                mode: proof.mode,
              });
              state = codec.decodeState(store.payload.baseline);
            } catch {}
          }
          try {
            remember();
          } catch {}
          status.textContent = legacy
            ? "Результат не підтверджено. Прочитайте поточний запис без повторного збереження."
            : "Результат не підтверджено. Перевірте UUID або повторіть початкове затвердження з незмінними умовами.";
          formError(error, d);
        }
      } finally {
        busy = false;
        finish();
        if (d.open) controls();
      }
      if (acknowledged && d.open) await read({ complete: true });
    }
    if (restore) {
      fillRaw(codec.decodeRawRecipe(restore.payload.draft));
      committed = baseline?.product.id || "";
      requested = product.value;
      state = { ...state, needsReview: !!baseline };
    }
    store = persistence.enroll({
      d,
      form,
      initial: state,
      restored: restore?.payload,
      captureRaw: raw,
      cancel: stop,
    });
    if (restore) {
      review = !!baseline;
      remember();
      status.textContent = first()
        ? legacy
          ? "Результат попереднього збереження невідомий. Перечитайте та узгодьте запис."
          : "Початкове затвердження збережено. Перевірте UUID або повторіть незмінний запит."
        : confirmed()
          ? "Збереження підтверджено. Потрібне лише читання поточних умов."
          : "Введення відновлено локально. Прочитайте й узгодьте поточну рецептуру перед збереженням.";
      markDirty(d);
    }
    product.addEventListener("change", () => {
      if (product.value === committed) return;
      if (first() || confirmed()) {
        product.value = committed;
        controls();
        return;
      }
      if (
        baseline &&
        d.dataset.dirty === "1" &&
        !confirm("Відкинути незбережені умови та вибрати інший готовий товар?")
      ) {
        product.value = committed;
        controls();
        return;
      }
      stop();
      requested = product.value;
      baseline = null;
      base = null;
      committed = "";
      review = false;
      rows.replaceChildren();
      remember();
      controls();
      if (requested) void read({ initial: true });
    });
    form.addEventListener("change", (event) => {
      if (!host.contains(event.target)) controls();
    });
    form.addEventListener("click", (event) => {
      const action = event.target.closest("[data-recipe-action]")?.dataset
        .recipeAction;
      if (!action) return;
      event.stopPropagation();
      if (action === "cancel") {
        stop();
        status.textContent = "Читання скасовано. Чернетка збережена.";
        readButton.focus();
      }
      if (action === "read")
        void read({ initial: !baseline, complete: !!confirmed() });
      if (action === "exact") void write(true);
      if (action === "add" && !busy && !reading) {
        rows.insertAdjacentHTML("beforeend", row({}));
        window.TradeDirectories.scan(d);
        window.TradeDirectories.focus(
          rows.lastElementChild.querySelector("select"),
        );
        markDirty(d);
      }
      if (action === "remove" && !busy && !reading) {
        event.target
          .closest(
            legacy ? ".trade-payment-row" : ".trade-production-component",
          )
          .remove();
        markDirty(d);
        window.TradeDirectories.focus(
          form.querySelector("[data-recipe-action=add]"),
        );
      }
    });
    form.onsubmit = (event) => {
      event.preventDefault();
      void write();
    };
    d.addEventListener("close", stop, { once: true });
    controls();
    return d;
  }
  window.TradeRecipeEditor = { open };
})();
