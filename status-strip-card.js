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

const VERSION = "0.2.0";

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

class StatusStripCard extends HTMLElement {
  setConfig(config) {
    this._own = config || {};
    this._sig = null;
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
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
    const shared = (ll && ll.config && ll.config[key]) || {};
    // Debug is on when either the shared block or this card turns it on.
    return { ...shared, ...this._own, debug: !!(shared.debug || this._own.debug) };
  }

  // The visual editor HA shows for this card: per-card settings only. The
  // shared pill list is edited on the strip's settings page (see README).
  static getConfigForm() {
    const ll = getLovelace();
    const shared = (ll && ll.config && ll.config.status_strip) || {};
    const names = shared.room_names || {};
    const rooms = Object.keys(names).map((k) => ({ value: k, label: names[k] }));
    return {
      schema: [
        {
          name: "room",
          selector: rooms.length ? { select: { mode: "dropdown", options: rooms } } : { text: {} },
        },
        { name: "only", selector: { select: { mode: "dropdown", options: [{ value: "weather", label: "Weather warning only" }] } } },
        { name: "debug", selector: { boolean: {} } },
      ],
      computeLabel: (s) =>
        ({ room: "Room (when the logged-in user isn't a panel)", only: "Show", debug: "Debug: show every pill" }[s.name]),
      computeHelper: (s) =>
        ({
          room: "Panel logins always show their own room.",
          only: "Leave empty for the full strip.",
          debug: "Shows all pills with sample values, on this card only.",
        }[s.name]),
    };
  }

  static getStubConfig() {
    return {};
  }

  _room(hass, cfg) {
    const user = hass.user && hass.user.name;
    const key = (cfg.rooms || {})[user] || cfg.room || (cfg.debug && Object.keys(cfg.room_names || {})[0]);
    if (!key) return null;
    const names = cfg.room_names || {};
    return {
      key,
      name: names[key] || key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      temperature: (cfg.room_temperature || "sensor.{room}_average_temperature").replace("{room}", key),
      humidity: (cfg.room_humidity || "sensor.{room}_average_humidity").replace("{room}", key),
    };
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
    if (target.startsWith("/")) {
      history.pushState(null, "", target);
      window.dispatchEvent(new CustomEvent("location-changed", { detail: { replace: false } }));
      return;
    }
    this.dispatchEvent(new CustomEvent("hass-more-info", { detail: { entityId: target }, bubbles: true, composed: true }));
  }

  _html(hass, cfg) {
    this._debug = !!cfg.debug;
    const onlyWeather = cfg.only === "weather";
    const left = [];
    const right = [];
    if (!onlyWeather) {
      const room = this._room(hass, cfg);
      if (room) left.push(this._roomPill(hass, room));
      for (const p of cfg.left || []) left.push(this._pill(hass, p));
      for (const p of cfg.right || []) right.push(this._pill(hass, p));
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
      const lead = `<div class="chip lead${glow}" style="background:${colour.bg};color:${colour.fg}"><ha-icon icon="${esc(p.icon)}"${iconStyle}></ha-icon>${p.label ? `<span>${esc(p.label)}</span>` : ""}</div>`;
      const chips = [];
      for (const c of p.chips || []) {
        let v = chipValue(hass, c);
        if (this._debug && (v === null || v === "0")) v = c.value === "countdown" || c.value === "elapsed" ? "1h 0m" : "1";
        if (v === null) continue;
        if (c.hide_zero && (v === "0" || Number(v) === 0)) continue;
        const cc = c.colour ? `--c:${esc(c.colour)}` : "";
        const cls = c.colour ? "chip tinted" : "chip grey";
        chips.push(`<div class="${cls}" style="${cc}">${c.icon ? `<ha-icon icon="${esc(c.icon)}"></ha-icon>` : ""}<span>${esc(v)}</span></div>`);
      }
      const tap = p.tap === false ? "" : p.tap || (p.show && p.show.entity) || "";
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
