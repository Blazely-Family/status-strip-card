/*
 * status-strip-card: a row of status pills for Home Assistant wall panels.
 *
 * The card holds no house logic. Each pill shows or hides on one entity's
 * state and displays entity states, countdowns or elapsed times; the rules
 * behind those entities live in Home Assistant helpers. The pill list is
 * normally written once at the top level of the dashboard config (key
 * `status_strip`) and shared by every card; a card's own keys override it.
 * See README.md for the config reference.
 */

const VERSION = "0.10.0";

const COLOURS = {
  yellow: { bg: "#ffc107", fg: "#1c1d21" },
  green: { bg: "#43a047", fg: "#f1f8f1" },
  blue: { bg: "#3a7ca5", fg: "#f2f8fc" },
  grey: { bg: "rgba(158, 158, 158, 0.35)", fg: "#eaebee" },
  quiet: { bg: "rgba(158, 158, 158, 0.25)", fg: "#eaebee" },
};

const EMPTY = ["unknown", "unavailable", "none", "None", ""];

// Find the dashboard config, to read the shared `status_strip` block.
function getLovelace() {
  let root = document.querySelector("home-assistant");
  root = root && root.shadowRoot;
  root = root && root.querySelector("home-assistant-main");
  root = root && root.shadowRoot;
  root = root && root.querySelector("ha-drawer partial-panel-resolver, app-drawer-layout partial-panel-resolver");
  root = (root && root.shadowRoot) || root;
  root = root && root.querySelector("ha-panel-lovelace");
  root = root && root.shadowRoot;
  root = root && root.querySelector("hui-root");
  return (root && root.lovelace) || null;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function duration(minutes) {
  const m = Math.max(0, Math.floor(minutes));
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
}

// A `show` test: { entity, state | not | above | below }. All given keys must pass.
// A list means all of its tests; { any: [...] } means at least one.
function passes(hass, test) {
  if (!test) return true;
  if (Array.isArray(test)) return test.every((t) => passes(hass, t));
  if (test.any) return test.any.some((t) => passes(hass, t));
  const st = hass.states[test.entity];
  if (!st) return false;
  const s = st.state;
  if (test.state !== undefined && ![].concat(test.state).map(String).includes(s)) return false;
  if (test.not !== undefined && [].concat(test.not).map(String).includes(s)) return false;
  if (test.above !== undefined && !(Number(s) > Number(test.above))) return false;
  if (test.below !== undefined && !(Number(s) < Number(test.below))) return false;
  if (test.state === undefined && test.not === undefined && test.above === undefined && test.below === undefined) {
    return !EMPTY.includes(s) && s !== "off" && s !== "0";
  }
  return true;
}

// A chip's value: the entity's state, or a time relative to a timestamp state.
function chipValue(hass, chip) {
  const st = hass.states[chip.entity];
  if (!st) return null;
  const raw = chip.attribute ? st.attributes[chip.attribute] : st.state;
  // `text`: a fixed label shown only while the value is true (e.g. "UPS" while
  // a helper's ups_on_battery is true), so helpers send facts, not wording.
  if (chip.text !== undefined) {
    const on = raw === true || (typeof raw === "number" ? raw > 0 : ["on", "true", "yes"].includes(String(raw).toLowerCase()) || Number(raw) > 0);
    return on ? String(chip.text) : null;
  }
  if (raw === undefined || raw === null || EMPTY.includes(String(raw))) return null;
  const mode = chip.value || "state";
  if (mode === "countdown" || mode === "elapsed") {
    const t = new Date(raw).getTime();
    if (Number.isNaN(t)) return null;
    const mins = mode === "countdown" ? (t - Date.now()) / 60000 : (Date.now() - t) / 60000;
    return duration(mins);
  }
  if (chip.round !== undefined && !Number.isNaN(Number(raw))) {
    return Number(raw).toFixed(chip.round) + (chip.unit ?? "");
  }
  return String(raw) + (chip.unit ?? "");
}

// Rooms as a list: { key, name, users, temperature, humidity, pills, left, right }.
// Also reads the older shape (`rooms` as user -> key, plus `room_names`).
function roomList(cfg) {
  if (Array.isArray(cfg.rooms)) return cfg.rooms.filter((r) => r && r.key);
  const names = cfg.room_names || {};
  const map = cfg.rooms || {};
  const keys = [...new Set([...Object.keys(names), ...Object.values(map)])];
  return keys.map((key) => ({
    key,
    name: names[key] || key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    users: Object.keys(map).filter((u) => map[u] === key),
    temperature: (cfg.room_temperature || "sensor.{room}_average_temperature").replace("{room}", key),
    humidity: (cfg.room_humidity || "sensor.{room}_average_humidity").replace("{room}", key),
    pills: "shared",
  }));
}

class StatusStripCard extends HTMLElement {
  setConfig(config) {
    this._own = config || {};
    this._sig = null;
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    // Redraw straight away on a config change (e.g. the editor's preview).
    if (this._hass) this._render(true);
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
    if (this._own && this._own._shared_draft && !this._isPreview()) this._promoteDraft(hass);
  }

  // True inside the card editor's preview, where the draft must stay put.
  _isPreview() {
    let n = this;
    while (n) {
      if (n.tagName && /^(HUI-DIALOG-EDIT-CARD|HUI-CARD-PREVIEW|HUI-CARD-ELEMENT-EDITOR)$/.test(n.tagName)) return true;
      n = n.parentNode || n.host;
    }
    return false;
  }

  connectedCallback() {
    this._timer = setInterval(() => this._render(true), 30000);
  }

  disconnectedCallback() {
    clearInterval(this._timer);
  }

  getCardSize() {
    return 1;
  }

  getGridOptions() {
    return { columns: "full", rows: 1 };
  }

  _config() {
    const key = this._own.strip || "status_strip";
    const ll = getLovelace();
    let shared = (ll && ll.config && ll.config[key]) || {};
    // A shared-pill edit made in the card editor rides on the card as
    // `_shared_draft` until it is moved into the dashboard (see _promoteDraft).
    if (this._own._shared_draft) shared = { ...shared, ...this._own._shared_draft };
    const own = { ...this._own };
    delete own._shared_draft;
    // Debug is on when either the shared block or this card turns it on.
    return { ...shared, ...own, debug: !!(shared.debug || own.debug) };
  }

  static getConfigElement() {
    return document.createElement("status-strip-card-editor");
  }

  static getStubConfig() {
    return {};
  }

  // HA's card dialog saves the whole dashboard from the copy it took when it
  // opened, so the editor cannot write the shared block itself without being
  // overwritten. Instead it saves the edit on the card as `_shared_draft`;
  // once that card is live, this moves the draft into the shared block.
  async _promoteDraft(hass) {
    if (!this._own._shared_draft || this._promoting || !(hass.user && hass.user.is_admin)) return;
    const ll = getLovelace();
    if (!ll || ll.editMode) return;
    this._promoting = true;
    try {
      const urlPath = ll.urlPath || null;
      const config = await hass.callWS({ type: "lovelace/config", url_path: urlPath });
      const key = this._own.strip || "status_strip";
      let draft = null;
      const strip = (cards) => {
        for (const c of cards || []) {
          if (c && c.type === "custom:status-strip-card" && c._shared_draft) {
            draft = c._shared_draft;
            delete c._shared_draft;
          }
          if (c && c.cards) strip(c.cards);
        }
      };
      for (const v of config.views || []) {
        strip(v.cards);
        for (const s of v.sections || []) strip(s.cards);
      }
      if (!draft) return;
      config[key] = { ...(config[key] || {}), ...draft };
      await hass.callWS({ type: "lovelace/config/save", url_path: urlPath, config });
    } catch (e) {
      console.warn("status-strip-card: could not save the shared pill list", e);
    } finally {
      this._promoting = false;
    }
  }

  // The room for this strip: the logged-in user's room, else the card's own.
  _room(hass, cfg) {
    const rooms = roomList(cfg);
    const norm = (s) => String(s || "").trim().toLowerCase();
    const who = [hass.user && hass.user.name, hass.user && hass.user.id].map(norm).filter(Boolean);
    // 1. The logged-in user belongs to a room (by name or user id, any case).
    // 2. This card names a room (the room's own view). That room is also
    //    remembered for this browser, so...
    // 3. ...shared views (Calendar, Cameras) keep showing the room this panel
    //    last displayed, even if its login isn't mapped to a room.
    const byUser = rooms.find((x) => (x.users || []).some((u) => who.includes(norm(u))));
    const byCard = rooms.find((x) => x.key === cfg.room);
    if (byCard) {
      try {
        localStorage.setItem("status-strip-card:room", byCard.key);
      } catch (e) {
        /* storage unavailable */
      }
    }
    let remembered = null;
    try {
      remembered = rooms.find((x) => x.key === localStorage.getItem("status-strip-card:room"));
    } catch (e) {
      /* storage unavailable */
    }
    if (!byUser && rooms.length && !this._loggedUser) {
      this._loggedUser = true;
      console.info(`status-strip-card: login "${hass.user && hass.user.name}" (${hass.user && hass.user.id}) isn't in any room's users`);
    }
    const r = byUser || byCard || remembered || (cfg.debug ? rooms[0] : null);
    return r || null;
  }

  _render(force) {
    const hass = this._hass;
    if (!hass || !this.shadowRoot) return;
    let cfg;
    try {
      cfg = this._config();
    } catch (e) {
      cfg = this._own;
    }
    const html = this._html(hass, cfg);
    if (!force && html === this._sig) return;
    this._sig = html;
    this.shadowRoot.innerHTML = `<style>${STYLE}</style>${html}`;
    this.shadowRoot.querySelectorAll("[data-tap]").forEach((el) =>
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this._tap(el.dataset.tap);
      })
    );
  }

  _tap(target) {
    if (!target) return;
    if (target.startsWith("json:")) {
      // Hand a full action to HA's own action handler, like any built-in card.
      const action = JSON.parse(target.slice(5));
      this.dispatchEvent(
        new CustomEvent("hass-action", { detail: { config: { tap_action: action }, action: "tap" }, bubbles: true, composed: true })
      );
      return;
    }
    if (target.startsWith("/")) {
      history.pushState(null, "", target);
      window.dispatchEvent(new CustomEvent("location-changed", { detail: { replace: false } }));
      return;
    }
    this.dispatchEvent(new CustomEvent("hass-more-info", { detail: { entityId: target }, bubbles: true, composed: true }));
  }

  _html(hass, cfg) {
    this._debug = !!cfg.debug;
    // `only`: "weather" = just the weather bar; "left" = the left (informative)
    // pills and the weather bar, without the right-hand alerts (e.g. a screensaver).
    const onlyWeather = cfg.only === "weather";
    const leftOnly = cfg.only === "left";
    const left = [];
    const right = [];
    if (!onlyWeather) {
      const room = this._room(hass, cfg);
      if (room) left.push(this._roomPill(hass, room));
      // A room can use the shared pills or its own.
      const own = room && room.pills === "own";
      for (const p of (own ? room.left : cfg.left) || []) left.push(this._pill(hass, p));
      if (!leftOnly) for (const p of (own ? room.right : cfg.right) || []) right.push(this._pill(hass, p));
    }
    const weather = this._weather(hass, cfg.weather);
    const middle = weather || (onlyWeather ? "" : '<div class="spacer"></div>');
    return `<div class="strip${onlyWeather ? " only-weather" : ""}">${left.join("")}${middle}${right.join("")}</div>`;
  }

  _roomPill(hass, room) {
    const chips = [];
    const t = hass.states[room.temperature];
    const h = hass.states[room.humidity];
    if (t && !EMPTY.includes(t.state) && !Number.isNaN(Number(t.state))) {
      chips.push(`<div class="chip grey tap" data-tap="${esc(room.temperature)}"><ha-icon icon="mdi:thermometer" class="temp"></ha-icon><span>${Number(t.state).toFixed(1)}°</span></div>`);
    }
    if (h && !EMPTY.includes(h.state) && !Number.isNaN(Number(h.state))) {
      chips.push(`<div class="chip grey tap" data-tap="${esc(room.humidity)}"><ha-icon icon="mdi:water-percent" class="hum"></ha-icon><span>${Math.round(Number(h.state))}%</span></div>`);
    }
    return `<div class="pill room"><span class="name">${esc(room.name)}</span>${chips.join("")}</div>`;
  }

  // A pill: a lead chip (icon, optional label, colour) and value chips.
  _pill(hass, p) {
    try {
      if (!this._debug && !passes(hass, p.show)) return "";
      const colour = COLOURS[p.colour] || COLOURS.quiet;
      const iconStyle = p.icon_colour ? ` style="color:${esc(p.icon_colour)}"` : "";
      const glow = p.glow ? " glow" : "";
      const glyph = p.emoji ? `<span class="emoji">${esc(p.emoji)}</span>` : p.icon ? `<ha-icon icon="${esc(p.icon)}"${iconStyle}></ha-icon>` : "";
      const lead = `<div class="chip lead${glow}" style="background:${colour.bg};color:${colour.fg}">${glyph}${p.label ? `<span>${esc(p.label)}</span>` : ""}</div>`;
      const chips = [];
      for (const c of p.chips || []) {
        let v = chipValue(hass, c);
        if (this._debug && (v === null || v === "0")) v = c.value === "countdown" || c.value === "elapsed" ? "1h 0m" : "1";
        if (v === null) continue;
        if (c.hide_zero && (v === "0" || Number(v) === 0)) continue;
        const cc = c.colour ? `--c:${esc(c.colour)}` : "";
        const cls = c.colour ? "chip tinted" : "chip grey";
        const cg = c.emoji ? `<span class="emoji">${esc(c.emoji)}</span>` : c.icon ? `<ha-icon icon="${esc(c.icon)}"></ha-icon>` : "";
        chips.push(`<div class="${cls}" style="${cc}">${cg}<span>${esc(v)}</span></div>`);
      }
      // `tap` may also be a standard HA action object (e.g. fire-dom-event to
      // open a list-popup or a Browser Mod pop-up).
      const tap =
        p.tap === false ? "" : typeof p.tap === "object" ? `json:${JSON.stringify(p.tap)}` : p.tap || (p.show && p.show.entity) || "";
      const tapAttr = tap ? ` data-tap="${esc(tap)}"` : "";
      return `<div class="pill${tap ? " tap" : ""}"${tapAttr}>${lead}${chips.join("")}</div>`;
    } catch (e) {
      return "";
    }
  }

  // Weather warning: a hazard bar with a scrolling marquee filling the middle.
  _weather(hass, w) {
    if (!w) return "";
    try {
      if (!this._debug && !passes(hass, w.show)) return "";
      const st = hass.states[w.text];
      let text = st && (w.attribute ? st.attributes[w.attribute] : st.state);
      if (this._debug && (!text || EMPTY.includes(String(text)))) text = "DEBUG: sample weather warning";
      if (!text || EMPTY.includes(String(text))) return "";
      const reps = Math.max(2, Math.floor(220 / (String(text).length + 7)) + 1);
      const seg = `${esc(text)}&nbsp;&nbsp;&nbsp;•&nbsp;&nbsp;&nbsp;`.repeat(reps);
      const tap = w.tap ? ` data-tap="${esc(w.tap)}"` : "";
      return `<div class="weather${w.tap ? " tap" : ""}"${tap}><ha-icon icon="mdi:alert-circle"></ha-icon><div class="belt"><span>${seg}${seg}</span></div></div>`;
    } catch (e) {
      return "";
    }
  }
}

const STYLE = `
/* Fill whatever height the layout gives the card (a sections row is 56px)
   and centre the 38px pills in it. */
:host { display: flex; align-items: center; height: 100%; min-height: 38px; }
.strip { flex: 1 1 auto; min-width: 0;
  display: flex; align-items: center; gap: 8px; min-height: 38px;
  font-family: var(--ha-font-family-body, var(--paper-font-body1_-_font-family, inherit));
}
.spacer { flex: 1 1 0; min-width: 0; }
.pill {
  display: flex; align-items: center; gap: 6px; height: 38px; padding: 0 6px; box-sizing: border-box;
  border-radius: var(--status-strip-pill-radius, 12px);
  background: var(--status-strip-pill-background, var(--ha-card-background, var(--card-background-color)));
  border: 1px solid var(--status-strip-pill-border, var(--ha-card-border-color, var(--divider-color)));
  box-shadow: var(--status-strip-pill-shadow, var(--frosted-glass-badge-shadow, none));
  -webkit-backdrop-filter: var(--status-strip-pill-backdrop, var(--ha-card-backdrop-filter, none));
  backdrop-filter: var(--status-strip-pill-backdrop, var(--ha-card-backdrop-filter, none));
  color: var(--primary-text-color, #eaebee); font-size: 14px; font-weight: 500; white-space: nowrap;
}
.tap { cursor: pointer; }
.room .name { padding: 0 4px 0 6px; }
.chip {
  display: flex; align-items: center; justify-content: center; gap: 4px; height: 26px; min-width: 26px;
  padding: 0 7px; box-sizing: border-box; border-radius: 8px; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
  --mdc-icon-size: 16px;
}
.chip.grey { background: rgba(158, 158, 158, 0.35); color: #eaebee; }
.chip.tinted { background: color-mix(in srgb, var(--c) 30%, transparent); color: color-mix(in srgb, var(--c) 88%, white); }
.chip.tinted span { color: color-mix(in srgb, var(--c) 30%, white); }
ha-icon { display: flex; line-height: 0; }
.emoji { font-size: 15px; line-height: 1; }
ha-icon.temp { color: #ff9a3c; }
ha-icon.hum { color: #4aa3ff; }
.glow ha-icon { color: #ffd54f; filter: drop-shadow(0 0 3px rgba(255, 200, 80, 0.95)) drop-shadow(0 0 6px rgba(255, 180, 60, 0.6)); }
.weather {
  flex: 1 1 0; min-width: 0; height: 36px; position: relative; overflow: hidden; display: flex; align-items: center;
  gap: 6px; padding: 0 10px; box-sizing: border-box; border-radius: 12px; background: #ffeb3b; color: #000;
  --mdc-icon-size: 20px;
}
.weather::before {
  content: ""; position: absolute; inset: 0; padding: 4px; border-radius: inherit; pointer-events: none;
  background: repeating-linear-gradient(45deg, rgba(0, 0, 0, 0) 0 9px, #000 9px 18px);
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor; mask-composite: exclude;
}
.weather ha-icon { color: #000; position: relative; z-index: 1; }
.weather .belt {
  flex: 1 1 0; min-width: 0; overflow: hidden;
  -webkit-mask-image: linear-gradient(to right, transparent, #000 6px, #000 calc(100% - 6px), transparent);
  mask-image: linear-gradient(to right, transparent, #000 6px, #000 calc(100% - 6px), transparent);
}
.weather .belt span {
  display: inline-block; white-space: nowrap; color: #000; font-weight: 700; font-size: 15px;
  animation: belt 45s linear infinite; transform: translate3d(0, 0, 0); -webkit-backface-visibility: hidden;
}
@keyframes belt { from { transform: translate3d(0, 0, 0); } to { transform: translate3d(-50%, 0, 0); } }
`;

/* ------------------------------------------------------------------ editor */

const COLOUR_OPTIONS = [
  { value: "quiet", label: "Quiet (grey glass)" },
  { value: "grey", label: "Grey" },
  { value: "yellow", label: "Yellow (needs attention)" },
  { value: "green", label: "Green" },
  { value: "blue", label: "Blue" },
];

const PILL_SCHEMA = [
  { name: "entity", selector: { entity: {} } },
  {
    name: "show_when",
    selector: {
      select: {
        mode: "dropdown",
        options: [
          { value: "on", label: "Entity is on" },
          { value: "off", label: "Entity is off" },
          { value: "above_0", label: "Entity is above 0" },
          { value: "has_value", label: "Entity has any value" },
          { value: "always", label: "Always" },
        ],
      },
    },
  },
  { name: "label", selector: { text: {} } },
  {
    type: "grid",
    name: "",
    schema: [
      { name: "icon", selector: { icon: {} } },
      { name: "emoji", selector: { text: {} } },
    ],
  },
  { name: "colour", selector: { select: { mode: "dropdown", options: COLOUR_OPTIONS } } },
  {
    name: "value",
    selector: {
      select: {
        mode: "dropdown",
        options: [
          { value: "none", label: "No value" },
          { value: "state", label: "State" },
          { value: "countdown", label: "Time until (timestamp)" },
          { value: "elapsed", label: "Time since (timestamp)" },
        ],
      },
    },
  },
  {
    type: "grid",
    name: "",
    schema: [
      { name: "value_entity", selector: { entity: {} } },
      { name: "value_icon", selector: { icon: {} } },
    ],
  },
  {
    name: "tap",
    selector: {
      select: {
        mode: "dropdown",
        options: [
          { value: "more_info", label: "Open the entity" },
          { value: "entity", label: "Open another entity" },
          { value: "navigate", label: "Go to a page" },
          { value: "none", label: "Nothing" },
          { value: "custom", label: "Custom action (kept from YAML)" },
        ],
      },
    },
  },
  { name: "tap_target", selector: { text: {} } },
  { name: "extra_chips", selector: { object: {} } },
];

const PILL_LABELS = {
  entity: "Entity",
  show_when: "Show when",
  label: "Label (optional)",
  icon: "Icon",
  emoji: "or emoji",
  colour: "Colour",
  value: "Value shown",
  value_entity: "Value entity (default: the entity)",
  value_icon: "Value icon",
  tap: "On tap",
  tap_target: "Tap target (entity or /path)",
  extra_chips: "More value chips (advanced, YAML)",
};

// Pill config -> flat form data, and back. Anything the form can't express
// (an `any` show rule, extra chips) is kept as-is.
function pillToForm(p) {
  const s = p.show || {};
  let show_when = "has_value";
  if (!p.show) show_when = "always";
  else if (s.any || Array.isArray(s)) show_when = "advanced";
  else if (s.state === "on") show_when = "on";
  else if (s.state === "off") show_when = "off";
  else if (Number(s.above) === 0) show_when = "above_0";
  const [first, ...rest] = p.chips || [];
  let tap = "more_info";
  let tap_target = "";
  if (p.tap === false) tap = "none";
  else if (p.tap && typeof p.tap === "object") tap = "custom";
  else if (typeof p.tap === "string" && p.tap.startsWith("/")) [tap, tap_target] = ["navigate", p.tap];
  else if (typeof p.tap === "string" && p.tap !== s.entity) [tap, tap_target] = ["entity", p.tap];
  return {
    entity: s.entity || (s.any && s.any[0] && s.any[0].entity) || "",
    show_when,
    label: p.label || "",
    icon: p.icon || "",
    emoji: p.emoji || "",
    colour: p.colour || "quiet",
    value: first ? first.value || "state" : "none",
    value_entity: first && first.entity !== s.entity ? first.entity : "",
    value_icon: (first && first.icon) || "",
    tap,
    tap_target,
    extra_chips: rest.length ? rest : undefined,
  };
}

function formToPill(f, old) {
  const p = {};
  const keep = (k) => old && old[k] !== undefined && (p[k] = old[k]);
  if (f.show_when === "advanced") keep("show");
  else if (f.show_when !== "always" && f.entity) {
    p.show = { entity: f.entity };
    if (f.show_when === "on") p.show.state = "on";
    if (f.show_when === "off") p.show.state = "off";
    if (f.show_when === "above_0") p.show.above = 0;
  }
  if (f.icon) p.icon = f.icon;
  if (f.emoji) p.emoji = f.emoji;
  if (f.label) p.label = f.label;
  p.colour = f.colour || "quiet";
  ["icon_colour", "glow"].forEach(keep);
  if (f.tap === "none") p.tap = false;
  else if (f.tap === "custom" && old && typeof old.tap === "object") p.tap = old.tap;
  else if ((f.tap === "navigate" || f.tap === "entity") && f.tap_target) p.tap = f.tap_target;
  else if (f.show_when === "advanced" && old && old.tap !== undefined) p.tap = old.tap;
  const chips = [];
  if (f.value && f.value !== "none") {
    const firstOld = (old && old.chips && old.chips[0]) || {};
    const c = { ...firstOld, entity: f.value_entity || f.entity, value: f.value === "state" ? undefined : f.value };
    if (f.value_icon) c.icon = f.value_icon;
    else delete c.icon;
    if (c.value === undefined) delete c.value;
    chips.push(c);
  }
  if (Array.isArray(f.extra_chips)) chips.push(...f.extra_chips);
  if (chips.length) p.chips = chips;
  return p;
}

const SHARED_KEYS = ["left", "right", "debug", "rooms"];

const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "room";

class StatusStripCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._open = {};
  }

  setConfig(config) {
    // HA hands our own change straight back; re-rendering then would steal
    // focus from the field being typed in.
    const echo = this._lastFired && JSON.stringify(config) === this._lastFired;
    this._config = config || {};
    if (echo) return;
    if (!this._shared) {
      const ll = getLovelace();
      const key = this._config.strip || "status_strip";
      const base = (ll && ll.config && ll.config[key]) || {};
      this._shared = JSON.parse(JSON.stringify({ ...base, ...(this._config._shared_draft || {}) }));
      this._shared.rooms = roomList(this._shared);
    }
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this.shadowRoot.querySelectorAll("ha-form").forEach((f) => (f.hass = hass));
    if (!this._rendered) this._render();
  }

  _fire(config) {
    this._config = config;
    this._lastFired = JSON.stringify(config);
    this.dispatchEvent(new CustomEvent("config-changed", { detail: { config }, bubbles: true, composed: true }));
  }

  _sharedChanged(rerender = true) {
    const draft = {};
    SHARED_KEYS.forEach((k) => this._shared[k] !== undefined && (draft[k] = JSON.parse(JSON.stringify(this._shared[k]))));
    this._fire({ ...this._config, _shared_draft: draft });
    if (rerender) this._render();
  }

  _form(schema, data, labels, onChange) {
    const f = document.createElement("ha-form");
    f.hass = this._hass;
    f.schema = schema;
    f.data = data;
    f.computeLabel = (s) => labels[s.name] || s.name;
    f.addEventListener("value-changed", (ev) => {
      ev.stopPropagation();
      f.data = ev.detail.value;
      onChange(ev.detail.value);
    });
    return f;
  }

  _render() {
    if (!this._hass || !this._config) return;
    this._rendered = true;
    const root = this.shadowRoot;
    root.innerHTML = `<style>${EDITOR_STYLE}</style>`;

    // This card.
    const rooms = (this._shared.rooms || []).map((r) => ({ value: r.key, label: r.name || r.key }));
    const cardSchema = [
      { name: "room", selector: rooms.length ? { select: { mode: "dropdown", options: rooms } } : { text: {} } },
      { name: "only", selector: { select: { mode: "dropdown", options: [{ value: "weather", label: "Weather warning only" }, { value: "left", label: "Left side and weather (no alerts)" }] } } },
    ];
    const h1 = document.createElement("h3");
    h1.textContent = "This card";
    root.append(h1);
    root.append(
      this._form(
        cardSchema,
        { room: this._config.room, only: this._config.only },
        { room: "Room (for logins that aren't a panel)", only: "Show (empty = full strip)" },
        (v) => {
          const c = { ...this._config };
          ["room", "only"].forEach((k) => (v[k] ? (c[k] = v[k]) : delete c[k]));
          this._fire(c);
        }
      )
    );

    // Shared pills.
    const h2 = document.createElement("h3");
    h2.textContent = "Pills on every strip";
    root.append(h2);
    const note = document.createElement("p");
    note.className = "note";
    note.textContent = "Changes here apply to all strips on this dashboard once you save this card.";
    root.append(note);
    root.append(
      this._form(
        [{ name: "debug", selector: { boolean: {} } }],
        { debug: !!this._shared.debug },
        { debug: "Debug: show every pill on every strip" },
        (v) => {
          this._shared.debug = !!v.debug;
          this._sharedChanged(false);
        }
      )
    );
    this._pillLists(root, this._shared, "shared");

    // Rooms.
    const h3 = document.createElement("h3");
    h3.textContent = "Rooms";
    root.append(h3);
    const rnote = document.createElement("p");
    rnote.className = "note";
    rnote.textContent = "Which panel logins belong to each room, what the room pill shows, and whether the room uses the pills above or its own.";
    root.append(rnote);
    const roomsList = this._shared.rooms;
    roomsList.forEach((r, i) => root.append(this._roomPanel(roomsList, r, i)));
    const addRoom = document.createElement("button");
    addRoom.className = "add";
    addRoom.textContent = "+ Add room";
    addRoom.addEventListener("click", () => {
      roomsList.push({ key: `room_${roomsList.length + 1}`, name: "New room", users: [], pills: "shared" });
      this._open[`room${roomsList.length - 1}`] = true;
      this._sharedChanged();
    });
    root.append(addRoom);
  }

  // Left and right pill lists of `owner` (the shared block or a room).
  _pillLists(root, owner, prefix) {
    for (const side of ["left", "right"]) {
      const h = document.createElement("h4");
      h.textContent = side === "left" ? "Left (informative)" : "Right (needs attention)";
      root.append(h);
      const list = (owner[side] = owner[side] || []);
      list.forEach((p, i) => root.append(this._pillPanel(`${prefix}-${side}`, list, p, i)));
      const add = document.createElement("button");
      add.className = "add";
      add.textContent = "+ Add pill";
      add.addEventListener("click", () => {
        list.push({ colour: "quiet", icon: "mdi:information-outline" });
        this._open[`${prefix}-${side}${list.length - 1}`] = true;
        this._sharedChanged();
      });
      root.append(add);
    }
  }

  _roomPanel(list, r, i) {
    const key = `room${i}`;
    const box = document.createElement("div");
    box.className = "pill";
    const head = document.createElement("div");
    head.className = "head";
    const sub = [(r.users || []).join(", "), r.pills === "own" ? "own pills" : "shared pills"].filter(Boolean).join(" · ");
    head.innerHTML = `<ha-icon icon="mdi:home-outline"></ha-icon><span class="title">${esc(r.name || r.key)}<span class="sub">${esc(sub)}</span></span>`;
    const del = document.createElement("button");
    del.textContent = "✕";
    del.addEventListener("click", (ev) => {
      ev.stopPropagation();
      list.splice(i, 1);
      this._sharedChanged();
    });
    head.append(del);
    head.addEventListener("click", () => {
      this._open[key] = !this._open[key];
      this._render();
    });
    box.append(head);
    if (this._open[key]) {
      const people = Object.values(this._hass.states)
        .filter((s) => s.entity_id.startsWith("person."))
        .map((s) => s.attributes.friendly_name || s.entity_id);
      const schema = [
        { name: "name", selector: { text: {} } },
        { name: "users", selector: { select: { multiple: true, custom_value: true, options: [...new Set([...people, ...(r.users || [])])] } } },
        {
          type: "grid",
          name: "",
          schema: [
            { name: "temperature", selector: { entity: { domain: "sensor" } } },
            { name: "humidity", selector: { entity: { domain: "sensor" } } },
          ],
        },
        {
          name: "pills",
          selector: { select: { mode: "dropdown", options: [{ value: "shared", label: "Shared pills" }, { value: "own", label: "Its own pills" }] } },
        },
      ];
      const labels = { name: "Name shown", users: "Panel logins in this room", temperature: "Temperature", humidity: "Humidity", pills: "Pills" };
      box.append(
        this._form(schema, { name: r.name, users: r.users || [], temperature: r.temperature, humidity: r.humidity, pills: r.pills || "shared" }, labels, (v) => {
          const wasOwn = r.pills === "own";
          r.name = v.name;
          r.users = v.users || [];
          r.temperature = v.temperature;
          r.humidity = v.humidity;
          r.pills = v.pills || "shared";
          // Going to own pills starts from a copy of the shared ones.
          if (r.pills === "own" && !wasOwn && !r.left && !r.right) {
            r.left = JSON.parse(JSON.stringify(this._shared.left || []));
            r.right = JSON.parse(JSON.stringify(this._shared.right || []));
          }
          const t = head.querySelector(".title");
          if (t) t.firstChild.textContent = v.name || r.key;
          this._sharedChanged((r.pills === "own") !== wasOwn);
        })
      );
      if (r.pills === "own") {
        const inner = document.createElement("div");
        inner.className = "inner";
        this._pillLists(inner, r, `room${i}`);
        box.append(inner);
      }
    }
    return box;
  }

  _pillPanel(prefix, list, p, i) {
    const key = `${prefix}${i}`;
    const box = document.createElement("div");
    box.className = "pill";
    const head = document.createElement("div");
    head.className = "head";
    const title = p.label || (p.show && p.show.entity) || p.emoji || p.icon || "New pill";
    head.innerHTML = `${p.emoji ? `<span class="emoji">${esc(p.emoji)}</span>` : p.icon ? `<ha-icon icon="${esc(p.icon)}"></ha-icon>` : ""}<span class="title">${esc(title)}</span>`;
    const btn = (label, fn, disabled) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.disabled = !!disabled;
      b.addEventListener("click", (ev) => {
        ev.stopPropagation();
        fn();
      });
      head.append(b);
    };
    btn("↑", () => {
      [list[i - 1], list[i]] = [list[i], list[i - 1]];
      this._sharedChanged();
    }, i === 0);
    btn("↓", () => {
      [list[i + 1], list[i]] = [list[i], list[i + 1]];
      this._sharedChanged();
    }, i === list.length - 1);
    btn("✕", () => {
      list.splice(i, 1);
      this._sharedChanged();
    });
    head.addEventListener("click", () => {
      this._open[key] = !this._open[key];
      this._render();
    });
    box.append(head);
    if (this._open[key]) {
      const data = pillToForm(p);
      const schema = data.show_when === "advanced"
        ? PILL_SCHEMA.map((s) => s.name === "show_when"
            ? { ...s, selector: { select: { mode: "dropdown", options: [{ value: "advanced", label: "Custom rule (kept from YAML)" }, ...s.selector.select.options] } } }
            : s)
        : PILL_SCHEMA;
      box.append(
        this._form(schema, data, PILL_LABELS, (v) => {
          list[i] = formToPill(v, list[i]);
          const t = head.querySelector(".title");
          if (t) t.textContent = v.label || v.entity || v.emoji || v.icon || "New pill";
          this._sharedChanged(false);
        })
      );
    }
    return box;
  }
}

const EDITOR_STYLE = `
h3 { margin: 20px 0 4px; font-size: 16px; }
h4 { margin: 16px 0 6px; font-size: 14px; color: var(--secondary-text-color); }
.note { margin: 0 0 8px; font-size: 13px; color: var(--secondary-text-color); }
.pill { border: 1px solid var(--divider-color); border-radius: 10px; margin-bottom: 8px; overflow: hidden; }
.head { display: flex; align-items: center; gap: 8px; padding: 8px 10px; cursor: pointer; }
.head .title { flex: 1; }
.head button, .add {
  background: none; border: 1px solid var(--divider-color); border-radius: 6px; color: var(--primary-text-color);
  padding: 2px 8px; cursor: pointer; font: inherit;
}
.head button:disabled { opacity: 0.3; cursor: default; }
.add { margin-bottom: 8px; }
.pill ha-form { display: block; padding: 0 10px 10px; }
.head .sub { display: block; font-size: 12px; color: var(--secondary-text-color); }
.inner { padding: 0 10px 10px; }
.emoji { font-size: 16px; }
`;

if (!customElements.get("status-strip-card-editor")) {
  customElements.define("status-strip-card-editor", StatusStripCardEditor);
}

if (!customElements.get("status-strip-card")) {
  customElements.define("status-strip-card", StatusStripCard);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: "status-strip-card",
    name: "Status strip",
    description: "A row of status pills driven by entities, for wall panels.",
  });
  console.info(`%c STATUS-STRIP-CARD %c ${VERSION} `, "background:#43a047;color:#fff", "");
}
