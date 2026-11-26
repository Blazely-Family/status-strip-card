# Status Strip Card

A row of status pills for Home Assistant wall panels: informative pills on the
left, a weather warning bar filling the middle, actionable alerts on the right.

The card holds no house logic. Each pill shows or hides on one entity's state
and displays entity states, countdowns or elapsed times. The rules behind those
entities (tariff periods, what counts as "open", room averages) belong in Home
Assistant helpers, where they can be changed without touching code.

## Install

HACS (or the Marketplace) → custom repositories → add this repository's URL as a
**Dashboard** repository, then download it. HACS registers the dashboard
resource.

## Config

Write the pill list once at the top level of the dashboard (raw configuration
editor) under `status_strip`; every card on that dashboard reads it. Anything
set on a card overrides the shared block.

```yaml
status_strip:
  # Room pill: logged-in user -> room key. A card's own `room:` is the fallback.
  rooms:
    Example Panel: living_room
  room_names:
    living_room: Living Room
  room_temperature: sensor.{room}_average_temperature   # default
  room_humidity: sensor.{room}_average_humidity         # default
  weather:
    show: { entity: binary_sensor.example_warning_active, state: "on" }
    text: sensor.example_warning_text
  left:
    - show: { entity: binary_sensor.example_peak, state: "off" }
      icon: mdi:flash
      colour: green
      tap: false
      chips:
        - { entity: sensor.example_peak_next_change, value: countdown, icon: mdi:timer-sand }
  right:
    - show: { entity: sensor.example_offline_count, above: 0 }
      icon: mdi:access-point-network-off
      label: Offline
      colour: yellow
      tap: group.example_offline
      chips:
        - { entity: sensor.example_offline_count }
```

Each card:

```yaml
type: custom:status-strip-card
room: living_room      # optional
only: weather          # optional: just the weather bar ("left": left pills + weather, no alerts)
strip: status_strip    # optional: name of the shared block
debug: true            # optional: show every pill with sample values
```

### Rooms

`rooms` can also be a list, which is what the visual editor writes:

```yaml
status_strip:
  rooms:
    - key: living_room
      name: Living Room
      users: [Example Panel]          # logins that belong to this room
      temperature: sensor.example_temperature
      humidity: sensor.example_humidity
      pills: shared                   # or `own`, with its own left/right lists
```

## Visual editor

Edit any strip card in the dashboard editor. The top of the form holds this
card's settings; below it you can add, remove, reorder and edit the shared
pills (entity, show rule, label, MDI icon or emoji, colour, value and tap),
and switch on **Debug** to show every pill on every strip with sample values.

HA's card dialog saves the dashboard from the copy it took when it opened, so
shared-pill edits are saved on the card as `_shared_draft`. The first time an
admin views the dashboard afterwards (out of edit mode), the card moves the
draft into the shared block.

### Pill keys

| Key | Meaning |
| --- | --- |
| `show` | `{ entity, state, not, above, below }`, or a list of them (all must pass), or `{ any: [...] }` (one must pass). With only `entity`, shows when the state is not off/0/unknown. |
| `icon`, `label` | Lead chip icon and optional text. |
| `colour` | Lead chip colour: `yellow`, `green`, `blue`, `grey`, `quiet` (default). |
| `icon_colour`, `glow` | Icon colour on a quiet chip; `glow: true` adds a soft glow. |
| `chips` | Value chips: `{ entity, attribute?, value: state \| countdown \| elapsed, icon?, colour?, unit?, round?, hide_zero?, text? }`. `countdown`/`elapsed` read a timestamp. `text` is a fixed label shown only while the value is true (on, true, or above 0). |
| `tap` | Entity to open in more-info, a `/path` to navigate to, `false`, or a standard HA action object (e.g. `fire-dom-event` for a Browser Mod pop-up). Defaults to the `show` entity. |

### Opening a list pop-up

To show a list from a pill, install [list-popup](https://github.com/Blazely-Family/list-popup)
and give the pill a `fire-dom-event` tap:

```yaml
tap:
  action: fire-dom-event
  list_popup:
    entity: sensor.example_offline_devices
    attribute: devices
    title: Offline
    icon: mdi:access-point-network-off
    colour: yellow
    noun: device
```

Styling uses HA theme variables; override with `--status-strip-pill-background`,
`--status-strip-pill-border`, `--status-strip-pill-radius`,
`--status-strip-pill-shadow` and `--status-strip-pill-backdrop`.
