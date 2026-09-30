/* Browser adapter for the original Claude Artifact data interface. */
(() => {
  let data = null;
  let csrf = "";
  const listeners = new Map();
  let loading = null;

  function snapshot(path) {
    if (path.includes("/")) {
      const value = data[path];
      return { exists: !!value && Object.keys(value).length > 0, data: () => structuredClone(value || {}) };
    }
    return { docs: (data[path] || []).map(item => ({ id: item.id, data: () => structuredClone(item.data) })) };
  }

  function notify() {
    for (const [path, callbacks] of listeners) {
      const value = snapshot(path);
      for (const callback of callbacks) callback(value);
    }
  }

  async function refresh() {
    if (loading) return loading;
    loading = (async () => {
      const response = await fetch("/api/state", { credentials: "same-origin", cache: "no-store" });
      if (response.status === 401) { location.href = "/"; throw new Error("Session expired"); }
      if (!response.ok) throw new Error("Database unavailable");
      const result = await response.json();
      const changed = JSON.stringify(data) !== JSON.stringify(result.data);
      data = result.data;
      csrf = result.csrf;
      if (changed) notify();
    })().finally(() => { loading = null; });
    return loading;
  }

  async function mutate(method, path, value) {
    const response = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: value === undefined ? undefined : JSON.stringify(value),
    });
    if (response.status === 401) { location.href = "/"; throw new Error("Session expired"); }
    if (!response.ok) throw new Error((await response.json()).error || "Save failed");
    const result = await response.json();
    await refresh();
    return result;
  }

  function doc(path) {
    const id = path.split("/").at(-1);
    return {
      id,
      async get() { await refresh(); return snapshot(path); },
      set(value) { return mutate("PUT", `/api/docs/${path}`, value); },
      update(value) { return mutate("PATCH", `/api/docs/${path}`, value); },
      delete() { return mutate("DELETE", `/api/docs/${path}`); },
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
        async add(value) { const result = await mutate("POST", `/api/${name}`, value); return doc(`${name}/${result.id}`); },
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

  window.TSUKENYA_SERVER = true;
  window.claude = {
    use(name) {
      if (name === "db") return refresh().then(() => db);
      if (name === "downloads") return Promise.resolve(downloads);
      return Promise.reject(new Error("Google connector is not configured on this server"));
    },
  };
  setInterval(() => { if (!document.hidden && data) refresh().catch(() => {}); }, 5000);
})();
