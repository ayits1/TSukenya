/* Browser adapter for the original Claude Artifact data interface. */
(() => {
  let data = null;
  let csrf = "";
  let labelRevision = "";
  const listeners = new Map();
  const createIntents = new WeakMap();
  let loading = null, loadingId = 0, started = 0, polled = 0;
  const roles = new Set(['owner', 'manager', 'cashier', 'warehouse', 'accountant']);

  function snapshot(path) {
    if (path.includes("/")) {
      const value = data[path];
      // `revision` is the version this snapshot shows; editors pass it back as If-Match.
      return { exists: !!value && Object.keys(value).length > 0, data: () => structuredClone(value || {}), revision: path === "settings/main" ? labelRevision : undefined };
    }
    return { docs: (data[path] || []).map(item => ({ id: item.id, revision: item.revision, data: () => structuredClone(item.data), permissions: () => structuredClone(item.permissions || {}) })) };
  }

  function notify() {
    for (const [path, callbacks] of listeners) {
      const value = snapshot(path);
      for (const callback of callbacks) callback(value);
    }
  }

  // `after` is the last GET number started before a confirmed write. A GET that
  // began earlier may predate the write, so a fresh one is chained after it.
  async function refresh(after) {
    if (loading && !(after >= loadingId)) return loading;
    if (loading) return loading.catch(() => {}).then(() => refresh(after));
    const id = loadingId = ++started;
    loading = (async () => {
      const response = await fetch("/api/state", { credentials: "same-origin", cache: "no-store" });
      if (response.status === 401) { location.href = "/"; throw new Error("Session expired"); }
      if (!response.ok) throw new Error("Database unavailable");
      const result = await response.json();
      if (!result || typeof result.data !== 'object' || result.data === null || Array.isArray(result.data) ||
          typeof result.csrf !== 'string' || !roles.has(result.role) ||
          (result.labelRevision !== undefined && typeof result.labelRevision !== 'string')) {
        throw new Error('Invalid database response');
      }
      const changed = JSON.stringify(data) !== JSON.stringify(result.data) || window.TSUKENYA_ROLE !== result.role;
      data = result.data;
      window.TSUKENYA_ROLE = result.role;
      csrf = result.csrf;
      labelRevision = result.labelRevision || "";
      if (changed) { notify(); window.dispatchEvent(new Event('tsukenya:data-changed')); }
      window.dispatchEvent(new Event('tsukenya:refresh-succeeded'));
    })().catch(error => {
      window.dispatchEvent(new CustomEvent('tsukenya:refresh-failed', { detail: {
        message: 'Не вдалося оновити дані. Показано останній отриманий стан; повторіть оновлення.',
      } }));
      throw error;
    }).finally(() => { if (loadingId === id) loading = null; });
    return loading;
  }

  // options.revision: the version the edit started from. Without it the latest
  // received version is sent, which only suits immediate one-field actions.
  async function mutate(method, path, value, options) {
    const productId=path.startsWith('/api/docs/products/')?path.slice('/api/docs/products/'.length):null;
    const version=options?.revision||(productId?data?.products?.find(item=>item.id===productId)?.revision:path==='/api/docs/settings/main'?labelRevision:null);
    const response = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf, ...(options?.createKey?{"Idempotency-Key":options.createKey}:{}), ...(version?{"If-Match":version}:{}) },
      body: value === undefined ? undefined : JSON.stringify(value),
    });
    if (response.status === 401) { location.href = "/"; throw new Error("Session expired"); }
    if (!response.ok) {
      const failure = await response.json().catch(() => ({}));
      const error = new Error(typeof failure.error === "string" && failure.error ? failure.error : "Save failed");
      // Business refusals (4xx: rights, validation, version conflict) carry a Ukrainian reason meant for people.
      // Other failures keep the UI's own text, so English or internal details never reach it.
      if (response.status >= 400 && response.status < 500 && error.message === failure.error) error.serverMessage = failure.error;
      error.status = response.status;
      if (typeof failure.code === "string") error.code = failure.code;
      throw error;
    }
    const after = started, result = await response.json();
    if (options?.createKey && (!result || result.ok !== true || typeof result.id !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(result.id)))
      throw new Error('Unconfirmed create response');
    // The write's own layout version: valid even when the following read fails.
    if (path === '/api/docs/settings/main' && typeof result?.revision === 'string') labelRevision = result.revision;
    // The server already confirmed this write. A failed read is a separate UI
    // recovery state; retrying the write could create a second document.
    await refresh(after).catch(() => {});
    return result;
  }

  function doc(path) {
    const id = path.split("/").at(-1);
    return {
      id,
      async get() { await refresh(); return snapshot(path); },
      set(value, options) { return mutate("PUT", `/api/docs/${path}`, value, options); },
      update(value, options) { return mutate("PATCH", `/api/docs/${path}`, value, options); },
      delete(options) { return mutate("DELETE", `/api/docs/${path}`, undefined, options); },
      onSnapshot(callback) {
        const set = listeners.get(path) || new Set(); set.add(callback); listeners.set(path, set);
        if (data) callback(snapshot(path));
        return () => { set.delete(callback); if (!set.size) listeners.delete(path); };
      },
    };
  }

  const db = {
    doc,
    collection(name) {
      return {
        doc(id = crypto.randomUUID()) { return doc(`${name}/${id}`); },
        async add(value, options) {
          const protectedCreate = ['tasks','ideas','expenses'].includes(name);
          const intent = protectedCreate ? options?.createKey ? {key:options.createKey,value} :
            createIntents.get(value) || {key:crypto.randomUUID(),value:structuredClone(value),uncertain:false} : null;
          if (intent && !options?.createKey) createIntents.set(value,intent);
          try {
            const result = await mutate("POST", `/api/${name}`, intent ? intent.value : value,
              intent ? {createKey:intent.key} : undefined);
            if (intent && !options?.createKey) createIntents.delete(value);
            return doc(`${name}/${result.id}`);
          } catch (error) {
            if (intent && !options?.createKey) {
              if (error.status>=400 && error.status<500 && !intent.uncertain && !error.code?.startsWith('create_')) createIntents.delete(value);
              else intent.uncertain=true;
            }
            throw error;
          }
        },
        onSnapshot(callback) {
          const set = listeners.get(name) || new Set(); set.add(callback); listeners.set(name, set);
          if (data) callback(snapshot(name));
          return () => { set.delete(callback); if (!set.size) listeners.delete(name); };
        },
      };
    },
  };

  const downloads = {
    async save({ filename, data: value }) {
      const blob = value instanceof Blob ? value : new Blob([value]);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url; anchor.download = filename; anchor.style.display = "none";
      document.body.append(anchor); anchor.click(); anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    },
  };

  // Explicit refreshes follow writes made through other APIs (catalogue, import, pricing): a background
  // poll that is already in flight may predate them, so it is followed by a new read instead of shared.
  window.TSUKENYA_REFRESH = () => refresh(loading && loadingId === polled ? loadingId : undefined);
  window.TSUKENYA_SERVER = true;
  window.claude = {
    use(name) {
      if (name === "db") return refresh().then(() => db);
      if (name === "downloads") return Promise.resolve(downloads);
      return Promise.reject(new Error("Google connector is not configured on this server"));
    },
  };
  setInterval(() => { if (!document.hidden && data && !loading) { refresh().catch(() => {}); polled = loadingId; } }, 5000);
})();
