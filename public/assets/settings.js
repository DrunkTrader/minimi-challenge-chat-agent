/**
 * Settings dialog: add / remove / disable API keys, test each provider, set the fallback order
 * per role. Talks to /api/settings, which only ever returns masks ("…3f9a"), never a key.
 */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ROLES = [
  ["answer", "Answers", "writes the reply you read"],
  ["fast", "Planner", "plans searches, saves facts, small talk"],
  ["search", "Web search", "the agent's one tool"],
];

export function initSettings(dialog, opener, onChange) {
  let view = null;
  const $ = (s) => dialog.querySelector(s);
  const status = (t, bad) => { $("#set-status").textContent = t; $("#set-status").style.color = bad ? "#e5484d" : ""; };

  async function api(path, body) {
    const res = await fetch(path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
    return j;
  }
  async function save(patch, msg) {
    try { view = await api("/api/settings", patch); render(); status(msg); onChange?.(); }
    catch (e) { status(e.message, true); }
  }

  function row(p, kind) {
    const state = p.disabled ? `<span class="prov__state off">disabled${p.mask ? ` · ${esc(p.source === "ui" ? "set here" : "from .env")} ${esc(p.mask)}` : ""}</span>`
      : p.active ? `<span class="prov__state on">● active · ${p.source === "ui" ? "set here" : "from .env"} ${esc(p.mask)}</span>`
      : `<span class="prov__state off">not set${p.free ? " · free tier" : ""}</span>`;
    const remove = p.source === "ui" ? `<button class="btn" data-act="remove">Remove</button>`
      : p.source === "env" ? `<button class="btn" data-act="toggle">${p.disabled ? "Enable" : "Disable"}</button>` : "";
    const extra = kind === "llm" ? `
      <div class="prov__extra"><label for="m-${p.id}">Models, in order (blank = default: ${esc(p.defaultModels.join(", "))})</label>
        <input id="m-${p.id}" data-field="models" value="${esc(p.custom ? p.models.join(", ") : "")}" placeholder="${esc(p.defaultModels.join(", "))}" autocomplete="off" spellcheck="false" />
        <button class="btn" data-act="models">Save models</button></div>
      ${p.id === "openai" ? `<div class="prov__extra"><label for="b-openai">Base URL (any OpenAI-compatible server, e.g. Ollama http://localhost:11434/v1)</label>
        <input id="b-openai" data-field="base" value="${esc(view.openaiBase)}" autocomplete="off" spellcheck="false" />
        <button class="btn" data-act="base">Save URL</button></div>` : ""}` : "";
    return `<div class="prov" data-id="${p.id}">
      <div><span class="prov__name">${esc(p.label)}<a href="${esc(p.url)}" target="_blank" rel="noopener">get key ↗</a></span>${state}</div>
      <input type="password" data-field="key" placeholder="${p.active ? "paste a new key to replace" : `paste ${esc(p.env)}`}" autocomplete="off" spellcheck="false" aria-label="${esc(p.label)} API key" />
      <div class="prov__btns"><button class="btn btn--solid" data-act="save">Save</button><button class="btn" data-act="test" ${p.active ? "" : "disabled"}>Test</button>${remove}</div>
      ${extra}
      <div class="prov__test" data-test></div>
    </div>`;
  }

  function render() {
    $("#set-llms").innerHTML = view.llms.map((p) => row(p, "llm")).join("");
    $("#set-search").innerHTML = view.searches.map((p) => row(p, "search")).join("");
    const all = [...view.llms, ...view.searches];
    $("#set-order").innerHTML = ROLES.map(([role, title, sub]) => {
      const list = view.order[role];
      return `<div class="order__col"><h4>${title}<small>${sub}</small></h4>${list.map((id, i) => {
        const p = all.find((x) => x.id === id);
        return `<div class="order__item ${p.active ? "" : "off"}"><b>${i + 1}</b><span>${esc(p.label)}${p.active ? "" : " · no key"}</span>
          <button data-role="${role}" data-i="${i}" data-dir="-1" aria-label="Move ${esc(p.label)} up in ${title}" ${i === 0 ? "disabled" : ""}>↑</button>
          <button data-role="${role}" data-i="${i}" data-dir="1" aria-label="Move ${esc(p.label)} down in ${title}" ${i === list.length - 1 ? "disabled" : ""}>↓</button></div>`;
      }).join("")}</div>`;
    }).join("");
  }

  dialog.addEventListener("click", async (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.role) {
      const list = [...view.order[b.dataset.role]], i = +b.dataset.i, j = i + +b.dataset.dir;
      [list[i], list[j]] = [list[j], list[i]];
      return save({ order: { [b.dataset.role]: list } }, "Order saved. It applies from the next message.");
    }
    const rowEl = b.closest(".prov"); if (!rowEl) return;
    const id = rowEl.dataset.id, p = [...view.llms, ...view.searches].find((x) => x.id === id);
    const field = (f) => rowEl.querySelector(`[data-field="${f}"]`)?.value.trim() ?? "";
    switch (b.dataset.act) {
      case "save": { const k = field("key"); if (!k) return status("Paste a key first.", true); return save({ keys: { [id]: k }, disabled: { [id]: false } }, `${p.label} key saved.`); }
      case "remove": return save({ keys: { [id]: null } }, `${p.label} key removed${p.source === "ui" ? "" : ""}.`);
      case "toggle": return save({ disabled: { [id]: !p.disabled } }, `${p.label} ${p.disabled ? "enabled" : "disabled"}.`);
      case "models": return save({ models: { [id]: field("models") || null } }, `${p.label} models saved.`);
      case "base": return save({ openaiBase: field("base") || null }, "Base URL saved.");
      case "test": {
        const out = rowEl.querySelector("[data-test]");
        out.className = "prov__test"; out.textContent = "testing…"; b.disabled = true;
        try {
          const r = await api("/api/settings/test", { provider: id });
          out.className = `prov__test ${r.ok ? "ok" : "bad"}`;
          out.textContent = r.ok ? `✓ works · ${r.model} · ${r.ms} ms` : `✗ ${r.error}`;
        } catch (err) { out.className = "prov__test bad"; out.textContent = `✗ ${err.message}`; }
        b.disabled = false;
      }
    }
  });

  opener.addEventListener("click", async () => {
    status("");
    try { view = await api("/api/settings"); render(); dialog.showModal(); }
    catch (e) { alert(`Settings unavailable: ${e.message}`); }
  });
}
