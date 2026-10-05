/* Ordinary portal drafts; managed alerts and initiative actions retain their own workflows. */
(() => {
  "use strict";
  const NAME = "native-portal-record-v1",
    DELETE = "native-portal-delete-v1",
    slots = new Map();
  let options = null,
    registered = false,
    active = null,
    openSequence = 0,
    preparing = false,
    privateReady = false,
    inlineSequence = 0,
    protectedCount = 0,
    restoring = null,
    authorized = null;
  const f = () => window.NativeDraftRecovery,
    c = () => window.NativePortalPersistence,
    a = () => window.NativeLegacyEditor;
  const canceled = () => new DOMException("Скасовано", "AbortError");
  const esc = (v) =>
    String(v ?? "").replace(
      /[&<>"']/g,
      (ch) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[ch],
    );
  const state = (p) => c().decodePortalState(p.baseline),
    name = (p) => (state(p).mode === "delete" ? DELETE : NAME);
  const owner = (s) =>
    JSON.stringify([
      s.draftOwner,
      s.draftSession,
      s.role,
      s.storeId,
      s.networkOwner,
    ]);
  const live = (ctx) =>
    active === ctx && ctx.d.open && ctx.d.isConnected && !ctx.hidden;
  function controls(entry) {
    const sel = {
      addWork: ["#newWork", "#newWorkDue"],
      addTask: ["#newTask", "#newTaskStage"],
      addIdea: ["#newIdea"],
    };
    return {
      fields: (sel[entry] || [])
        .map((s) => document.querySelector(s))
        .filter(Boolean),
      button: document.querySelector('[data-act="' + entry + '"]'),
    };
  }
  function rawFromFields(entry, p) {
    const s = state(p),
      { fields } = controls(entry);
    if (!fields.length) return p.draft;
    if (s.collection === "ideas") return { ...p.draft, title: fields[0].value };
    return {
      ...p.draft,
      title: fields[0].value,
      ...(entry === "addWork"
        ? { dueDate: fields[1].value }
        : entry === "addTask"
          ? { stage: fields[1].value }
          : {}),
    };
  }
  function store(ctx, p) {
    const decoded = c().decodePortalPayload(p);
    f().store.save(state(decoded).recordId, name(decoded), decoded);
    ctx.p = decoded;
    return decoded;
  }
  function updateRaw(ctx) {
    if (ctx.hidden) throw Error("Спочатку підтвердьте доступ до чернетки.");
    const raw = ctx.form
      ? rawFromForm(ctx)
      : rawFromFields(state(ctx.p).entry, ctx.p);
    return store(ctx, { ...ctx.p, draft: raw });
  }
  function rawFromForm(ctx) {
    if (state(ctx.p).mode === "delete") return {};
    return Object.fromEntries(
      Object.keys(ctx.p.draft).map((k) => [
        k,
        ctx.form.elements[k]?.value ?? ctx.p.draft[k],
      ]),
    );
  }
  async function request(
    path,
    method = "GET",
    body,
    revision,
    signal,
    guard,
    binding,
  ) {
    const gate = () => {
      if (signal?.aborted || (guard && !guard())) throw canceled();
    };
    gate();
    const actor = await window.PortalApi.session(signal);
    gate();
    if (binding && owner(actor) !== owner(binding)) {
      await f()
        .controller.check(false)
        .catch(() => {});
      throw canceled();
    }
    gate();
    let r, v;
    try {
      r = await fetch(path, {
        method,
        signal,
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": actor.csrf,
          ...(revision ? { "If-Match": revision } : {}),
          ...(method === "POST" && !path.includes("identity")
            ? { "Idempotency-Key": body.key }
            : {}),
        },
        body:
          body === undefined
            ? undefined
            : JSON.stringify(
                method === "POST" && !path.includes("identity")
                  ? body.body
                  : body,
              ),
      });
    } catch (e) {
      gate();
      throw Object.assign(
        Error(
          "Результат не підтверджено. Чернетка збережена; повторіть лише читання.",
        ),
        { uncertain: method !== "GET" },
      );
    }
    gate();
    if (r.status === 401) {
      window.dispatchEvent(new Event("tsukenya:session-invalidated"));
      location.href = "/";
      throw Object.assign(Error("Сеанс завершився."), { status: 401 });
    }
    try {
      v = await r.json();
    } catch {
      gate();
      throw Object.assign(
        Error("Некоректна відповідь сервера. Повторіть читання."),
        { status: r.ok ? undefined : r.status, uncertain: method !== "GET" },
      );
    }
    gate();
    if (!r.ok)
      throw Object.assign(
        Error(typeof v?.error === "string" ? v.error : "Дія недоступна."),
        {
          status: r.status,
          code: v?.code,
          uncertain: method !== "GET" && r.status >= 500,
        },
      );
    return v;
  }
  async function context(p, actor, signal, guard) {
    const s = state(p),
      targetId = s.id || p.confirmation?.id || null,
      q = new URLSearchParams({
        collection: s.collection,
        ...(targetId ? { id: targetId } : {}),
        ...(s.metadata.scope ? { scope: s.metadata.scope } : {}),
        ...(s.metadata.store ? { store: String(s.metadata.store) } : {}),
        ...(s.metadata.ideaId ? { ideaId: s.metadata.ideaId } : {}),
      });
    const value = await request(
      "/api/v1/portal/records/recovery-context?" + q,
      "GET",
      undefined,
      undefined,
      signal,
      guard,
      actor,
    );
    return c().decodePortalContext(value, s, actor, targetId);
  }
  async function current(ctx, signal, actor) {
    const s = state(ctx.p),
      id = s.id || ctx.p.confirmation?.id;
    try {
      return a().decodeLegacyRecord(
        await request(
          "/api/v1/portal/records/" + s.collection + "/" + id,
          "GET",
          undefined,
          undefined,
          signal,
          undefined,
          actor,
        ),
        s.collection,
        id,
      );
    } catch (error) {
      if (error.status === 409 && error.code === "record_missing")
        return { missing: true };
      throw error;
    }
  }
  function hide() {
    privateReady = false;
    document
      .querySelectorAll("[data-portal-draft-inline]")
      .forEach((el) => (el.hidden = true));
    for (const entry of ["addWork", "addTask", "addIdea"]) {
      const { fields, button } = controls(entry);
      fields.forEach((el) => (el.hidden = true));
      if (button) button.hidden = true;
    }
    if (!active?.d.open) return;
    const ctx = active;
    ctx.hidden = true;
    if (!ctx.reading) ctx.stop();
    ctx.d.querySelector(".trade-dialog-body").hidden = true;
    ctx.d.querySelector("h2").textContent = "Локальна чернетка призупинена";
    let gate = ctx.d.querySelector("[data-portal-access]");
    if (!gate) {
      gate = document.createElement("section");
      gate.className = "trade-dialog-body";
      gate.dataset.portalAccess = "";
      gate.innerHTML =
        '<p role="status">Форму приховано до підтвердження доступу.</p><button type="button" class="btn soft" data-access-retry>Перевірити доступ</button><button type="button" class="btn soft" data-access-cancel>Скасувати читання</button>';
      gate.querySelector("[data-access-retry]").onclick = () => void warm(ctx);
      gate.querySelector("[data-access-cancel]").onclick = () => {
        ctx.stop();
        f().controller.dismiss();
        ctx.sync();
      };
      ctx.d.append(gate);
    }
    gate.querySelector("[data-access-retry]").disabled =
      !!ctx.reading || !!ctx.busy;
    gate.querySelector("[data-access-cancel]").hidden = !ctx.reading;
  }
  function reveal(ctx) {
    if (active !== ctx || !ctx.d.open) return;
    ctx.hidden = false;
    ctx.d.querySelector(".trade-dialog-body").hidden = false;
    ctx.d.querySelector("h2").textContent = ctx.title;
    ctx.d.querySelector("[data-portal-access]")?.remove();
    ctx.sync();
  }
  async function protectedRead(ctx, read, signal) {
    protectedCount++;
    ctx.reading = (ctx.reading || 0) + 1;
    let result;
    try {
      result = await f().controller.verifyRead(
        state(ctx.p).recordId,
        (authorizedSignal, actor) => {
          const combined = signal
            ? AbortSignal.any([signal, authorizedSignal])
            : authorizedSignal;
          if (combined.aborted || active !== ctx || !ctx.d.open)
            throw canceled();
          return read(combined, actor);
        },
      );
      if (signal?.aborted || active !== ctx || !ctx.d.open) throw canceled();
      if (!result)
        throw Error(
          "Доступ або поточний запис не підтверджено. Повторіть перевірку доступу.",
        );
      reveal(ctx);
      return result.value;
    } finally {
      protectedCount--;
      ctx.reading--;
      ctx.sync();
    }
  }
  async function warm(ctx) {
    if (ctx.reading || ctx.busy) return;
    try {
      await protectedRead(ctx, async () => true);
    } catch (e) {
      ctx.error.textContent = e.message;
    }
  }
  function register() {
    if (registered || !f() || !c() || !a()) return;
    registered = true;
    for (const codecName of [NAME, DELETE])
      f().register({
        name: codecName,
        version: 1,
        label:
          codecName === DELETE
            ? "Видалення задачі або статті витрат"
            : "Задача або ідея",
        decode: (p) => {
          const d = c().decodePortalPayload(p);
          if ((state(d).mode === "delete") !== (codecName === DELETE))
            throw Error("Некоректний тип чернетки.");
          return d;
        },
        authorize: async (p, actor, signal) => {
          authorized = {
            id: state(p).recordId,
            actor,
            policy: await context(p, actor, signal),
          };
          return true;
        },
        suspend: hide,
        confirm: c().confirmPortalPayload,
        restore: async (p, signal) => {
          if (signal.aborted) throw canceled();
          await open({
            restored: p,
            signal,
            actor:
              authorized?.id === state(p).recordId ? authorized.actor : null,
          });
          if (!signal.aborted) restoring = signal;
        },
      });
    f().controller.subscribe(() => {
      if (f().controller.snapshot().state !== "ready") return;
      if (restoring) {
        const signal = restoring;
        restoring = null;
        queueMicrotask(() => {
          if (!signal.aborted) {
            f().close();
            active?.form?.querySelector("input,textarea,select")?.focus();
          }
        });
      }
      if (active?.hidden && !protectedCount && !active.busy && !active.reading)
        void warm(active);
    });
  }
  async function prepareInline() {
    register();
    if (
      !registered ||
      preparing ||
      active?.d.open ||
      window.ManagedAlerts?.pending()
    )
      return;
    preparing = true;
    const token = ++inlineSequence,
      path = location.hash,
      mountNodes = ["addWork", "addTask", "addIdea"].flatMap(
        (entry) => controls(entry).fields,
      );
    try {
      const actor = await f().controller.check(false);
      if (token !== inlineSequence || path !== location.hash) return;
      for (const entry of ["addWork", "addTask", "addIdea"]) {
        const { fields, button } = controls(entry);
        if (!fields.length) continue;
        let slot = slots.get(entry);
        if (
          slot &&
          !f()
            .store.entries()
            .some((e) => e.id === state(slot.p).recordId)
        ) {
          slots.delete(entry);
          slot = null;
        }
        if (!slot) {
          const key = crypto.randomUUID(),
            collection = entry === "addIdea" ? "ideas" : "tasks",
            scope =
              entry === "addWork"
                ? "operations"
                : collection === "tasks"
                  ? "development"
                  : null;
          slot = {
            p: {
              baseline: {
                recordId: "portal_" + key,
                key,
                collection,
                mode: "create",
                entry,
                id: null,
                revision: null,
                original:
                  collection === "ideas"
                    ? { title: "", text: "Ідея власника", reaction: null }
                    : scope === "operations"
                      ? { title: "", status: "todo", dueDate: null }
                      : { title: "", status: "todo", dueDate: null, stage: 1 },
                metadata: {
                  scope,
                  store:
                    collection === "tasks" && actor.role === "manager"
                      ? actor.storeId
                      : null,
                  ideaId: null,
                  order: Date.now(),
                  byOwner: collection === "ideas" ? true : null,
                },
                review: false,
              },
              draft:
                collection === "ideas"
                  ? { title: "", text: "Ідея власника", reaction: "" }
                  : {
                      title: "",
                      status: "todo",
                      dueDate: "",
                      stage: scope === "operations" ? "" : "1",
                    },
              firstIntent: null,
              confirmation: null,
            },
            hidden: false,
          };
        }
        const policy = await context(
          slot.p,
          actor,
          undefined,
          () =>
            token === inlineSequence &&
            path === location.hash &&
            fields.every((el) => el.isConnected),
        );
        if (token !== inlineSequence || path !== location.hash) return;
        if (!policy.canWrite) {
          fields.forEach((el) => (el.hidden = true));
          if (button) button.hidden = true;
          continue;
        }
        fields.forEach((el) => (el.hidden = false));
        if (button) button.hidden = false;
        privateReady = true;
        slots.set(entry, slot);
        fillInline(slot);
        slot.restored = false;
        syncInline(slot);
      }
    } catch {
      hide();
    } finally {
      preparing = false;
      const currentNodes = ["addWork", "addTask", "addIdea"].flatMap(
        (entry) => controls(entry).fields,
      );
      if (
        currentNodes.length &&
        (path !== location.hash ||
          token !== inlineSequence ||
          currentNodes.length !== mountNodes.length ||
          currentNodes.some((node, index) => node !== mountNodes[index]))
      )
        void prepareInline();
      if (
        active?.hidden &&
        !active.busy &&
        !active.reading &&
        !protectedCount &&
        f().controller.snapshot().state !== "error"
      )
        void warm(active);
    }
  }
  function fillInline(ctx) {
    const s = state(ctx.p),
      { fields } = controls(s.entry);
    if (!fields.length) return;
    fields[0].value = ctx.p.draft.title;
    const second = s.entry === "addWork" ? "dueDate" : "stage";
    if (fields[1]) fields[1].value = ctx.p.draft[second];
  }
  function syncInline(ctx) {
    const entry = state(ctx.p).entry,
      { fields, button } = controls(entry);
    if (button)
      button.disabled =
        state(ctx.p).mode !== "create" ||
        !!ctx.p.firstIntent ||
        !!ctx.p.confirmation ||
        !!ctx.busy;
    let panel = [
      ...document.querySelectorAll("[data-portal-draft-inline]"),
    ].find((el) => el.dataset.portalDraftInline === entry);
    if (!panel && fields.length) {
      panel = document.createElement("section");
      panel.dataset.portalDraftInline = entry;
      panel.className = "legacy-record-recovery";
      fields.at(-1).closest(".row").after(panel);
    }
    if (!panel) return;
    panel.hidden = !privateReady;
    panel.innerHTML =
      ctx.p.firstIntent || ctx.p.confirmation || state(ctx.p).mode !== "create"
        ? `<p role="status">${esc(ctx.message || "Початковий запит збережено. Новіше введення лишається окремою чернеткою.")}</p><button type="button" class="btn soft" data-portal-exact="${esc(entry)}" ${!ctx.p.firstIntent || ctx.p.firstIntent.method !== "POST" || ctx.busy ? "hidden" : ""}>Повторити початковий запит</button><button type="button" class="btn soft" data-portal-review="${esc(entry)}">Відкрити відновлення</button>`
        : "";
  }
  function newState(record, mode = "edit") {
    const safe = c().safePortalRecord(record),
      key = crypto.randomUUID();
    return {
      recordId: "portal_" + key,
      key,
      collection: record.collection,
      mode,
      entry: mode + ":" + record.id,
      id: record.id,
      revision: record.revision,
      original: safe.terms,
      metadata: safe.metadata,
      review: false,
    };
  }
  function rawTerms(s) {
    if (s.mode === "delete") return {};
    const t = s.original;
    return s.collection === "ideas"
      ? { title: t.title, text: t.text ?? "", reaction: t.reaction ?? "" }
      : {
          title: t.title,
          status: t.status ?? "",
          dueDate: t.dueDate ?? "",
          stage:
            t.stage === null || t.stage === undefined ? "" : String(t.stage),
        };
  }
  function findRecord(collection, id, mode) {
    return [...known.values()]
      .map((ctx) => ctx.p)
      .find(
        (p) =>
          state(p).collection === collection &&
          state(p).id === id &&
          state(p).mode === mode &&
          f()
            .store.entries()
            .some((e) => e.id === state(p).recordId),
      );
  }
  function accepted(ctx, type, id, revision, original, missing = false) {
    const event = {
      type,
      id,
      revision,
      original,
      draft: ctx.form
        ? rawFromForm(ctx)
        : rawFromFields(state(ctx.p).entry, ctx.p),
      missing,
    };
    const p = c().confirmPortalPayload(ctx.p, event);
    f().store.confirmed(state(ctx.p).recordId, event);
    ctx.p = p;
    const inline = slots.get(state(p).entry);
    if (inline && inline !== ctx) {
      inline.p = p;
      syncInline(inline);
    }
    return p;
  }
  async function verifyWrite(ctx) {
    protectedCount++;
    ctx.busy = true;
    let actor;
    try {
      actor = await f().controller.verify(state(ctx.p).recordId);
    } finally {
      protectedCount--;
    }
    if (
      !actor ||
      (ctx.form && (!ctx.d.open || active !== ctx)) ||
      (!ctx.form && !controls(state(ctx.p).entry).fields.length)
    )
      throw canceled();
    if (authorized?.id !== state(ctx.p).recordId || !authorized.policy.canWrite)
      throw Error(
        "Редагування поточного запису недоступне. Прочитайте його стан.",
      );
    ctx.hidden = false;
    if (ctx.form) reveal(ctx);
    else {
      privateReady = true;
      fillInline(ctx);
      syncInline(ctx);
    }
    return actor;
  }
  async function send(ctx, exact = false) {
    if (ctx.busy) return false;
    let first = ctx.p.firstIntent,
      s = state(ctx.p);
    const wasUnknown = !!first;
    try {
      if (!exact) {
        updateRaw(ctx);
        if (first || ctx.p.confirmation)
          throw Error(
            "Спочатку прочитайте початковий запис і явно узгодьте зміни.",
          );
        const body =
          s.mode === "create"
            ? c().createPortalBody(s, ctx.p.draft)
            : s.mode === "delete"
              ? null
              : a().legacyPatch(
                  c().recordForState(s),
                  c().capturePortalTerms(s, ctx.p.draft),
                );
        first = {
          method:
            s.mode === "create"
              ? "POST"
              : s.mode === "delete"
                ? "DELETE"
                : "PATCH",
          path:
            s.mode === "create"
              ? "/api/" + s.collection
              : "/api/docs/" + s.collection + "/" + s.id,
          key: s.key,
          body,
          revision: s.revision,
          possiblySent: true,
        };
        store(ctx, { ...ctx.p, firstIntent: first });
      }
      if (!first) throw Error("Початковий запит відсутній.");
      ctx.busy = true;
      ctx.sync?.();
      syncInline(ctx);
      const frozen = f().store.beforeSend(s.recordId),
        requestHash = location.hash;
      const actor = await verifyWrite(ctx);
      const guard = () =>
        location.hash === requestHash &&
        (ctx.form
          ? live(ctx)
          : privateReady &&
            slots.get(s.entry) === ctx &&
            controls(s.entry).fields.length > 0);
      if (!guard()) throw canceled();
      if (frozen.method === "POST") {
        const identity = await request(
          "/api/v1/portal/create-identity?" +
            new URLSearchParams({ collection: s.collection, createKey: s.key }),
          "GET",
          undefined,
          undefined,
          undefined,
          guard,
          actor,
        );
        window.PortalApi.decodeCreateIdentity(identity, s.collection, s.key);
        if (identity.confirmed) {
          if (identity.original)
            window.PortalApi.decodeCreateAcknowledgement(
              {
                ok: true,
                collection: s.collection,
                createKey: s.key,
                id: identity.id,
                original: identity.original,
              },
              s.collection,
              s.key,
              frozen.body,
            );
          accepted(
            ctx,
            "identity",
            identity.id,
            identity.original?.revision ?? null,
            identity.original
              ? a().legacyProjection(
                  a().decodeLegacyRecord(
                    identity.original,
                    s.collection,
                    identity.id,
                  ),
                )
              : null,
            identity.state === "deleted",
          );
          ctx.message =
            "Початковий ID підтверджено. CREATE не повторюється; прочитайте поточний запис окремо.";
          return false;
        }
      }
      ctx.busy = true;
      ctx.sync?.();
      syncInline(ctx);
      const result = await request(
        frozen.path,
        frozen.method,
        frozen.method === "POST"
          ? { key: frozen.key, body: frozen.body }
          : frozen.body === null
            ? undefined
            : frozen.body,
        frozen.revision,
        undefined,
        guard,
        actor,
      );
      if (!guard()) throw canceled();
      if (frozen.method === "POST") {
        window.PortalApi.decodeCreateAcknowledgement(
          result,
          s.collection,
          s.key,
          frozen.body,
        );
        accepted(
          ctx,
          "saved",
          result.id,
          result.original.revision,
          a().legacyProjection(
            a().decodeLegacyRecord(result.original, s.collection, result.id),
          ),
        );
      } else {
        if (
          result?.ok !== true ||
          result.id !== s.id ||
          (frozen.method !== "DELETE" &&
            !(
              typeof result.revision === "string" &&
              /^[a-f0-9]{32}$/.test(result.revision)
            ))
        )
          throw Object.assign(
            Error("Некоректне підтвердження; повторіть лише читання."),
            { uncertain: true },
          );
        if (frozen.method === "DELETE")
          accepted(ctx, "saved", s.id, null, null, true);
        else
          accepted(ctx, "saved", s.id, result.revision, {
            ...s.original,
            ...frozen.body,
          });
      }
      ctx.message =
        "Підтверджено. Новіше введення збережене; повторне надсилання заблоковано.";
      await window.TSUKENYA_REFRESH_AFTER_WRITE?.().catch(() => {});
      ctx.onConfirmed?.();
      return true;
    } catch (error) {
      if (error.name === "AbortError") return false;
      if ([401, 403].includes(error.status)) {
        try {
          if (ctx.form)
            await protectedRead(ctx, async () => {
              throw error;
            });
          else
            await f().controller.verifyRead(state(ctx.p).recordId, async () => {
              throw error;
            });
        } catch {}
      }
      // Only a definite first live validation rejection proves this attempt rolled back.
      if (!wasUnknown && error.status === 400 && !error.uncertain) {
        store(ctx, { ...ctx.p, firstIntent: null });
      }
      ctx.message = error.message;
      if (ctx.error) ctx.error.textContent = error.message;
      return false;
    } finally {
      ctx.busy = false;
      ctx.sync?.();
      syncInline(ctx);
      if (!ctx.form && !privateReady && !active?.d.open) void prepareInline();
      // A simultaneous directory/metadata refresh may suspend the form while
      // this write is busy. Re-authorize it after the write; never reveal it
      // merely because the transport finished.
      if (
        ctx.form &&
        ctx.hidden &&
        active === ctx &&
        ctx.d.open &&
        f().controller.snapshot().state !== "error"
      )
        void warm(ctx);
    }
  }
  async function createInline(entry, collection, payload, fields, onConfirmed) {
    register();
    if (!registered) throw Error("Локальні чернетки ще не готові.");
    await prepareInline();
    const ctx = slots.get(entry);
    if (!ctx || !privateReady) throw Error("Доступ до форми не підтверджено.");
    ctx.onConfirmed = onConfirmed;
    updateRaw(ctx);
    const result = await send(ctx);
    if (
      result &&
      JSON.stringify(rawFromFields(entry, ctx.p)) ===
        JSON.stringify(
          rawTerms({ ...state(ctx.p), original: ctx.p.confirmation.original }),
        )
    ) {
      f().store.discard(state(ctx.p).recordId);
      slots.delete(entry);
      fields.forEach((el) => {
        if (el.tagName === "INPUT") el.value = "";
      });
      ctx.p = { ...ctx.p, firstIntent: null, confirmation: null };
      syncInline(ctx);
    }
    return result;
  }
  async function edit(collection, item, onConfirmed) {
    const sourceHash = location.hash;
    register();
    const record = window.LegacyEditors.snapshot(collection, item);
    if (record.managed || record.initiative || !record.permissions.canEdit)
      throw Error("Запис змінюється в окремому робочому процесі.");
    await f().controller.check(false);
    if (sourceHash !== location.hash) throw canceled();
    const p = findRecord(collection, record.id, "edit") || {
      baseline: newState(record),
      draft: rawTerms(newState(record)),
      firstIntent: null,
      confirmation: null,
    };
    await open({ initial: p, onConfirmed });
  }
  async function update(collection, item, patch, onConfirmed) {
    const sourceHash = location.hash;
    register();
    const record = window.LegacyEditors.snapshot(collection, item);
    if (record.managed || record.initiative || !record.permissions.canEdit)
      throw Error("Запис змінюється в окремому робочому процесі.");
    await f().controller.check(false);
    if (sourceHash !== location.hash) throw canceled();
    const existing = findRecord(collection, record.id, "edit");
    if (existing) {
      await open({ restored: existing, onConfirmed });
      return false;
    }
    const s = newState(record),
      ctx = {
        p: {
          baseline: s,
          draft: {
            ...rawTerms(s),
            ...Object.fromEntries(
              Object.entries(patch).map(([k, v]) => [
                k,
                v === null ? "" : String(v),
              ]),
            ),
          },
        },
        hidden: false,
        onConfirmed,
      };
    ctx.p.firstIntent = null;
    ctx.p.confirmation = null;
    store(ctx, ctx.p);
    await open({ initial: ctx.p, onConfirmed, automatic: true });
    return true;
  }
  async function remove(collection, item, onConfirmed) {
    const sourceHash = location.hash;
    register();
    const record = window.LegacyEditors.snapshot(collection, item);
    if (record.managed || record.initiative || !record.permissions.canDelete)
      throw Error("Видалення цього запису недоступне.");
    await f().controller.check(false);
    if (sourceHash !== location.hash) throw canceled();
    const p = findRecord(collection, record.id, "delete");
    if (p) {
      await open({ restored: p, onConfirmed });
      return false;
    }
    if (
      !confirm(
        "Видалити запис «" + (record.data.title || record.data.name) + "»?",
      )
    )
      return false;
    const s = newState(record, "delete");
    await open({
      initial: {
        baseline: s,
        draft: {},
        firstIntent: null,
        confirmation: null,
      },
      onConfirmed,
      automatic: true,
    });
    return true;
  }
  async function open({
    initial,
    restored,
    signal,
    actor,
    onConfirmed,
    automatic = false,
  }) {
    if (active?.d.open) {
      active.d.focus();
      return;
    }
    register();
    const opening = ++openSequence,
      path = location.hash;
    let p = c().decodePortalPayload(restored || initial);
    if (!actor) actor = await f().controller.check(false);
    if (signal?.aborted) throw canceled();
    if (opening !== openSequence || path !== location.hash) throw canceled();
    await context(
      p,
      actor,
      signal,
      () => opening === openSequence && path === location.hash,
    );
    if (signal?.aborted || opening !== openSequence || path !== location.hash)
      throw canceled();
    const s = state(p),
      opener = document.activeElement,
      d = document.createElement("dialog");
    d.className = "trade-dialog";
    d.setAttribute("aria-labelledby", "portalDraftTitle");
    const title =
      s.mode === "delete"
        ? "Видалення · перевірка поточного запису"
        : s.collection === "tasks"
          ? "Задача · локальна чернетка"
          : "Ідея · локальна чернетка";
    const field = (key, label, type = "text") =>
      `<label>${label}<input name="${key}" type="${type}" ${key === "title" ? 'required maxlength="250"' : ""}></label>`;
    const select = (key, label, choices) =>
      `<label>${label}<select name="${key}"><option value="">Не задано</option>${choices.map(([value, label]) => `<option value="${value}">${label}</option>`).join("")}</select></label>`;
    const fields =
      s.mode === "delete"
        ? `<p data-observed-title>${esc(s.original.title || s.original.name)}</p><p>Після непідтвердженої відповіді читається лише стан запису. Відсутність не доводить, хто його видалив.</p>`
        : field("title", "Назва") +
          (s.collection === "tasks"
            ? select("status", "Статус", [
                ["todo", "Не почато"],
                ["doing", "В роботі"],
                ["done", "Готово"],
              ]) +
              field("dueDate", "Термін", "date") +
              (s.metadata.scope === "operations"
                ? ""
                : select(
                    "stage",
                    "Етап розвитку",
                    [1, 2, 3, 4].map((n) => [n, "Етап " + n]),
                  ))
            : '<label>Опис<textarea name="text" maxlength="4000"></textarea></label>' +
              select("reaction", "Рішення", [
                ["yes", "Обрано для реалізації"],
                ["no", "Відкладено"],
              ]));
    d.innerHTML = `<div class="trade-dialog-head"><h2 id="portalDraftTitle">${title}</h2><button type="button" class="btn soft" data-close>Закрити</button></div><div class="trade-dialog-body"><form id="legacyRecordForm"><div class="trade-form-grid">${fields}</div><button type="submit" class="btn" ${s.mode === "delete" ? "hidden" : ""}>Зберегти</button></form><p role="alert" tabindex="-1" class="trade-error" data-error></p><p role="status" data-status></p><div class="row"><button type="button" class="btn soft" data-exact>Повторити початковий запит</button><button type="button" class="btn soft" data-read>Прочитати поточний запис</button><button type="button" class="btn soft" data-cancel>Скасувати читання</button><button type="button" class="btn" data-delete>Підтвердити видалення поточної версії</button><button type="button" class="btn soft" data-finish>Завершити відновлення</button></div><div data-comparison></div></div>`;
    document.body.append(d);
    const form = d.querySelector("form"),
      ctx = {
        p,
        d,
        form,
        title,
        onConfirmed,
        busy: false,
        reading: 0,
        hidden: false,
        comparison: null,
        controller: null,
        readToken: 0,
        current: null,
        error: d.querySelector("[data-error]"),
        status: d.querySelector("[data-status]"),
      };
    active = ctx;
    known.set(s.recordId, ctx);
    ctx.sync = () => {
      const ss = state(ctx.p),
        blocked = ctx.busy || ctx.reading || !!ctx.comparison;
      form
        .querySelectorAll("input,select,textarea")
        .forEach((el) => (el.disabled = blocked));
      form.querySelector("[type=submit]").disabled =
        blocked || !!ctx.p.firstIntent || !!ctx.p.confirmation || ss.review;
      d.querySelector("[data-exact]").hidden =
        ctx.p.firstIntent?.method !== "POST";
      d.querySelector("[data-exact]").disabled = blocked;
      d.querySelector("[data-read]").hidden =
        !!ctx.comparison ||
        (!ctx.p.firstIntent && !ctx.p.confirmation && !ss.review);
      d.querySelector("[data-read]").disabled = blocked;
      d.querySelector("[data-cancel]").hidden =
        !ctx.reading || !!ctx.comparison;
      d.querySelector("[data-delete]").hidden = ss.mode !== "delete";
      d.querySelector("[data-delete]").disabled =
        blocked ||
        !!ctx.p.firstIntent ||
        !!ctx.p.confirmation ||
        ss.review ||
        !ctx.current?.permissions.canDelete;
      d.querySelector("[data-finish]").hidden = !ctx.p.confirmation;
      d.querySelector("[data-finish]").disabled = blocked;
      d.querySelector("[data-close]").disabled = ctx.busy;
      const gate = d.querySelector("[data-portal-access]");
      if (gate) {
        gate.querySelector("[data-access-retry]").disabled =
          !!ctx.reading || ctx.busy;
        gate.querySelector("[data-access-cancel]").hidden = !ctx.reading;
      }
    };
    ctx.stop = () => {
      ctx.readToken++;
      ctx.controller?.abort();
      ctx.controller = null;
      ctx.comparison?.unmount();
      ctx.comparison = null;
      d.querySelector("[data-comparison]").replaceChildren();
      ctx.sync();
    };
    const fill = () => {
      for (const [key, value] of Object.entries(ctx.p.draft))
        if (form.elements[key]) form.elements[key].value = value;
    };
    fill();
    for (const key of ["status", "stage"]) {
      if (s.original[key] != null)
        form.elements[key]
          ?.querySelector('option[value=""]')
          ?.setAttribute("disabled", "");
    }
    store(ctx, p);
    const capture = () => {
      if (ctx.hidden || !d.open) return;
      try {
        updateRaw(ctx);
        ctx.error.textContent = "";
      } catch (e) {
        ctx.error.textContent = e.message;
      }
    };
    form.addEventListener("input", capture);
    form.addEventListener("change", capture);
    const close = () => {
      if (ctx.busy) return;
      if (!ctx.hidden) capture();
      if (
        !confirm(
          "Закрити редактор? Локальну чернетку залишено для явного відновлення.",
        )
      )
        return;
      d.close();
    };
    d.querySelector("[data-close]").onclick = close;
    d.addEventListener("cancel", (e) => {
      e.preventDefault();
      close();
    });
    d.addEventListener(
      "close",
      () => {
        ctx.stop();
        openSequence++;
        if (active === ctx) active = null;
        if (["addWork", "addTask", "addIdea"].includes(state(ctx.p).entry)) {
          const slot = {
            p: ctx.p,
            hidden: false,
            message: ctx.status.textContent,
          };
          slots.set(state(ctx.p).entry, slot);
          fillInline(slot);
          syncInline(slot);
        }
        d.remove();
        void prepareInline();
        if (opener?.isConnected) opener.focus();
      },
      { once: true },
    );
    d.querySelector("[data-cancel]").onclick = () => {
      ctx.stop();
      f().controller.dismiss();
      ctx.status.textContent = "Читання скасовано. Чернетка збережена.";
      ctx.sync();
    };
    async function readCurrent() {
      if (ctx.busy || ctx.reading || ctx.comparison) return;
      const n = ++ctx.readToken;
      ctx.controller = new AbortController();
      const controller = ctx.controller;
      capture();
      ctx.error.textContent = "";
      ctx.status.textContent = "Читаємо без збереження…";
      try {
        if (ctx.p.firstIntent?.method === "POST") {
          const first = structuredClone(ctx.p.firstIntent),
            ss = state(ctx.p);
          const identity = await protectedRead(
            ctx,
            async (sig, session) => {
              const v = await request(
                "/api/v1/portal/create-identity?" +
                  new URLSearchParams({
                    collection: ss.collection,
                    createKey: ss.key,
                  }),
                "GET",
                undefined,
                undefined,
                sig,
                undefined,
                session,
              );
              window.PortalApi.decodeCreateIdentity(v, ss.collection, ss.key);
              if (v.confirmed && v.original)
                window.PortalApi.decodeCreateAcknowledgement(
                  {
                    ok: true,
                    collection: ss.collection,
                    createKey: ss.key,
                    id: v.id,
                    original: v.original,
                  },
                  ss.collection,
                  ss.key,
                  first.body,
                );
              return v;
            },
            controller.signal,
          );
          if (
            controller.signal.aborted ||
            active !== ctx ||
            !d.open ||
            n !== ctx.readToken
          )
            return;
          if (!identity.confirmed) {
            ctx.status.textContent =
              "Квитанцію не знайдено. Початковий запит лишається незмінним; це не доказ відсутності запису.";
            return;
          }
          accepted(
            ctx,
            "identity",
            identity.id,
            identity.original?.revision ?? null,
            identity.original
              ? a().legacyProjection(
                  a().decodeLegacyRecord(
                    identity.original,
                    ss.collection,
                    identity.id,
                  ),
                )
              : null,
            identity.state === "deleted",
          );
        }
        if (ctx.p.confirmation?.missing) {
          ctx.status.textContent =
            "Запис відсутній. Повторне видалення або створення не виконується; авторство відсутності не встановлено.";
          return;
        }
        const latest = await protectedRead(
          ctx,
          (sig, session) => current(ctx, sig, session),
          controller.signal,
        );
        if (
          controller.signal.aborted ||
          active !== ctx ||
          !d.open ||
          n !== ctx.readToken
        )
          return;
        const ss = state(ctx.p);
        if (latest.missing) {
          if (ss.mode === "delete") {
            accepted(ctx, "missing", ss.id, null, null, true);
            ctx.status.textContent =
              "Запис відсутній. Авторство не встановлено; повтор DELETE не виконується.";
            return;
          }
          throw Error(
            "Запис відсутній. CREATE або UPDATE не повторюється; чернетка збережена.",
          );
        }
        if (
          !c().portalIdentityMatches(ss, latest) ||
          !latest.permissions.canEdit
        )
          throw Error(
            "Джерело або права запису змінилися. Узгодження недоступне.",
          );
        if (ss.mode === "delete") {
          ctx.current = latest;
          ctx.p = { ...ctx.p, baseline: { ...ss, review: true } };
          store(ctx, ctx.p);
          const server = a().legacyProjection(latest);
          ctx.comparison = window.NativeConflictComparison.mount(
            d.querySelector("[data-comparison]"),
            {
              base: ss.original,
              mine: ss.original,
              server,
              fields: a().legacyFields(latest),
              title: "Перевірити поточний запис перед видаленням",
              onCancel: () => {
                ctx.stop();
                ctx.status.textContent = "Видалення не виконано.";
              },
              onApply: () => {
                if (!live(ctx) || n !== ctx.readToken) return;
                accepted(ctx, "apply", latest.id, latest.revision, server);
                d.querySelector("[data-observed-title]").textContent =
                  server.title || server.name;
                ctx.stop();
                ctx.status.textContent =
                  "Поточну версію прийнято лише для нового підтвердження видалення.";
                ctx.sync();
                d.querySelector("[data-delete]").focus();
              },
            },
          );
          ctx.status.textContent =
            "Поточну версію прочитано. Потрібне окреме підтвердження видалення.";
          ctx.sync();
          return;
        }
        const base = ctx.p.confirmation?.original || ss.original;
        if (ctx.p.confirmation && !ctx.p.confirmation.original)
          throw Error(
            "Історична квитанція не містить початкових полів; узгодження недоступне.",
          );
        let mine;
        try {
          mine = c().capturePortalTerms(ss, rawFromForm(ctx));
        } catch {
          ctx.status.textContent =
            "Поточний запис підтверджено. Спочатку виправте новіші поля; підтверджений ID лишається збереженим.";
          return;
        }
        const server = a().legacyProjection(latest);
        ctx.comparison = window.NativeConflictComparison.mount(
          d.querySelector("[data-comparison]"),
          {
            base,
            mine,
            server,
            fields: a().legacyFields(latest),
            title: "Узгодити зміни запису",
            onCancel: () => {
              ctx.stop();
              ctx.status.textContent = "Чернетка збережена.";
            },
            onApply: (merged) => {
              if (!live(ctx) || n !== ctx.readToken) return;
              try {
                a().legacyPatch(latest, merged);
                const draft = rawTerms({ ...ss, original: merged });
                const next = c().confirmPortalPayload(ctx.p, {
                  type: "apply",
                  id: latest.id,
                  revision: latest.revision,
                  original: server,
                  draft,
                  missing: false,
                });
                f().store.confirmed(ss.recordId, {
                  type: "apply",
                  id: latest.id,
                  revision: latest.revision,
                  original: server,
                  draft,
                  missing: false,
                });
                ctx.p = next;
                ctx.stop();
                fill();
                ctx.sync();
                ctx.status.textContent =
                  "Узгоджено лише локальну чернетку. Натисніть «Зберегти».";
                form.querySelector("[type=submit]").focus();
              } catch (e) {
                ctx.error.textContent = e.message;
              }
            },
          },
        );
        ctx.status.textContent =
          "Поточну версію прочитано. Узгодження змінить лише локальну чернетку.";
        ctx.sync();
      } catch (e) {
        if (
          controller.signal.aborted ||
          active !== ctx ||
          !d.open ||
          n !== ctx.readToken
        )
          return;
        if (e.code === "record_missing" && state(ctx.p).mode === "delete") {
          accepted(ctx, "missing", state(ctx.p).id, null, null, true);
          ctx.status.textContent =
            "Запис відсутній. Авторство не встановлено; повтор DELETE не виконується.";
        } else {
          ctx.error.textContent = e.message;
          ctx.status.textContent =
            "Поточний запис не підтверджено. Чернетка збережена.";
        }
      } finally {
        if (active === ctx && d.open && n === ctx.readToken) ctx.sync();
      }
    }
    d.querySelector("[data-read]").onclick = () => void readCurrent();
    d.querySelector("[data-exact]").onclick = () => void send(ctx, true);
    async function saveAndFinish() {
      const done = await send(ctx);
      if (!done || !ctx.p.confirmation?.original || !d.open) return;
      if (
        JSON.stringify(rawFromForm(ctx)) !==
        JSON.stringify(
          rawTerms({ ...state(ctx.p), original: ctx.p.confirmation.original }),
        )
      )
        return;
      f().store.discard(state(ctx.p).recordId);
      known.delete(state(ctx.p).recordId);
      d.close();
    }
    form.onsubmit = (e) => {
      e.preventDefault();
      void saveAndFinish();
    };
    d.querySelector("[data-delete]").onclick = () => {
      if (confirm("Видалити перевірену поточну версію запису?"))
        void (async () => {
          if (!(await send(ctx)) || !d.open || !ctx.p.confirmation?.missing)
            return;
          f().store.discard(state(ctx.p).recordId);
          known.delete(state(ctx.p).recordId);
          d.close();
        })();
    };
    d.querySelector("[data-finish]").onclick = () => {
      if (
        !ctx.p.confirmation ||
        !confirm(
          "Завершити відновлення й прибрати локальну чернетку? Бізнес-запис не зміниться.",
        )
      )
        return;
      f().store.discard(state(ctx.p).recordId);
      known.delete(state(ctx.p).recordId);
      slots.delete(state(ctx.p).entry);
      d.close();
      options?.render?.();
    };
    d.showModal();
    ctx.sync();
    if (ctx.p.firstIntent || ctx.p.confirmation || s.review)
      d.querySelector("[data-read]").focus();
    else form.querySelector("input")?.focus();
    if (automatic && state(ctx.p).mode !== "delete") {
      await saveAndFinish();
    } else if (automatic) {
      const done = await send(ctx);
      if (done && state(ctx.p).mode !== "create") {
        f().store.discard(state(ctx.p).recordId);
        known.delete(state(ctx.p).recordId);
        d.close();
      }
    }
  }
  async function createIdeaTask(idea, onConfirmed) {
    register();
    const source = location.hash,
      token = ++openSequence;
    const actor = await f().controller.check(false);
    if (source !== location.hash || token !== openSequence) return false;
    const entry = "ideaTask:" + idea.id;
    const previous = [...known.values()].find(
      (ctx) =>
        state(ctx.p).entry === entry &&
        f()
          .store.entries()
          .some((e) => e.id === state(ctx.p).recordId),
    );
    if (previous) {
      await open({ initial: previous.p, onConfirmed, actor });
      return false;
    }
    const key = crypto.randomUUID(),
      s = {
        recordId: "portal_" + key,
        key,
        collection: "tasks",
        mode: "create",
        entry,
        id: null,
        revision: null,
        original: { title: "", status: "todo", dueDate: null, stage: 1 },
        metadata: {
          scope: "development",
          store: null,
          ideaId: idea.id,
          order: Date.now(),
          byOwner: null,
        },
        review: false,
      };
    await open({
      initial: {
        baseline: s,
        draft: { title: idea.title, status: "todo", dueDate: "", stage: "1" },
        firstIntent: null,
        confirmation: null,
      },
      onConfirmed,
      actor,
      automatic: true,
    });
    return true;
  }
  const known = new Map();
  window.PortalDraftRecovery = {
    configure(value) {
      options = value;
      register();
    },
    mountInline() {
      for (const entry of ["addWork", "addTask", "addIdea"]) {
        const { fields, button } = controls(entry);
        fields.forEach((el) => (el.hidden = true));
        if (button) button.hidden = true;
      }
      void prepareInline();
    },
    createInline,
    createIdeaTask,
    edit,
    update,
    remove,
    pending: () => !!active?.d.open || [...slots.values()].some((x) => x.busy),
    isPending: (collection, id) =>
      !!active?.d.open &&
      state(active.p).collection === collection &&
      state(active.p).id === id,
    canLeave: () => {
      if (active?.busy || [...slots.values()].some((ctx) => ctx.busy))
        return false;
      if (active?.d.open) active.d.querySelector("[data-close]").click();
      return !active?.d.open;
    },
  };
  document.addEventListener("input", (e) => {
    const entry =
      e.target.id === "newWork" || e.target.id === "newWorkDue"
        ? "addWork"
        : e.target.id === "newTask" || e.target.id === "newTaskStage"
          ? "addTask"
          : e.target.id === "newIdea"
            ? "addIdea"
            : null;
    if (!entry || !privateReady) return;
    const ctx = slots.get(entry);
    if (!ctx) return;
    try {
      updateRaw(ctx);
      syncInline(ctx);
    } catch (error) {
      ctx.message = error.message;
      syncInline(ctx);
    }
  });
  document.addEventListener("change", (e) => {
    if (["newWorkDue", "newTaskStage"].includes(e.target.id))
      e.target.dispatchEvent(new Event("input", { bubbles: true }));
  });
  document.addEventListener("click", (e) => {
    const exact = e.target.closest("[data-portal-exact]"),
      review = e.target.closest("[data-portal-review]");
    if (exact) {
      const ctx = slots.get(exact.dataset.portalExact);
      if (ctx) void send(ctx, true);
    }
    if (review) {
      const ctx = slots.get(review.dataset.portalReview);
      if (ctx)
        void open({ initial: ctx.p }).catch((error) => {
          if (error.name === "AbortError") return;
          ctx.message = error.message;
          syncInline(ctx);
        });
    }
  });
  window.addEventListener("hashchange", () => {
    inlineSequence++;
    openSequence++;
    hide();
    queueMicrotask(() => {
      if (![...slots.values()].some((ctx) => ctx.busy)) void prepareInline();
    });
  });
  window.addEventListener("tsukenya:native-conflict-ready", () => {
    register();
    void prepareInline();
  });
})();
