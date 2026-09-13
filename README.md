# Open mSupply screenshot tool

Captures documentation screenshots from a running Open mSupply web client, in
every language the docs are published in, cropped to the region of the screen
the documentation actually shows, with arrows and callouts drawn on.

Rewritten for Playwright and the **new** web client (CSS modules, native
`<dialog>`, store-scoped routes). The previous Selenium version targeted the
MUI client and its `/distribution/outbound-shipment` style URLs, which no longer
resolve.

## Quick start

```bash
yarn install
export OMS_URL=https://release-demo-open.msupply.org
export OMS_USERNAME=Documentation
export OMS_PASSWORD=...          # never commit this
yarn stores                   # list store codes on the server
yarn shoot --lang en --only outbound --headed
```

Credentials are read from the environment only. Nothing in `config.json` holds a
password.

## Commands

| Command | Does |
|---|---|
| `yarn shoot` | every shot, every language, into `images/<lang>/` |
| `yarn shoot --lang fr` | one language |
| `yarn shoot --only outbound` | shots whose id contains a string |
| `yarn shoot --tag replenishment` | shots carrying a tag |
| `yarn shoot --headed` | watch the browser |
| `yarn shoot --in-place` | write over the images in the docs repo (English only) |
| `yarn shot-list` | print the shot list without running |
| `yarn stores` | list store codes |
| `yarn import-manifest <manifest.yaml>` | generate shot stubs from the docs catalogue |

## How a shot is defined

Shot definitions live in `shots/*.yaml`. `shots/_schema.yaml` is the full
reference; `shots/distribution.yaml` is a worked set covering every region and
annotation type. The short version:

```yaml
- id: outbound-add-item-modal
  file: content/docs/.../images/os_additem.png   # where it lives in the docs
  route: distribution/outbound-shipment          # store id is added automatically
  store: STR-BDR-DST
  region: modal                                  # what to crop to
  openFirstRow: true                             # open a record rather than hard-code an id
  steps:
    - click: '[data-testid="add-item-button"]'
    - waitFor: 'dialog[open]'
  annotate:
    - type: arrow
      to: '[data-testid="item-search-input"]'
      from: above-right
      text: Start typing to filter by name
```

## Steps: getting the screen into the right state

Most documented screenshots are not of a bare route. They show a dialog open,
a dropdown expanded, two rows ticked, a field half filled in. A shot therefore
carries a `steps:` list that runs after the page loads and before the capture.

Every shot executes in this fixed order:

```
navigate to route → dismiss stray overlays → openFirstRow → steps → annotate → capture
```

So `openFirstRow` has already opened a record by the time `steps` run, and the
annotation overlay is drawn on whatever state the steps leave behind.

### The common case: a modal

```yaml
- id: outbound-add-item-modal
  route: distribution/outbound-shipment
  store: STR-BDR-DST
  region: modal                 # crops to dialog[open]
  openFirstRow: true            # the button lives on the detail view, not the list
  steps:
    - click: '[data-testid="add-item-button"]'
    - waitFor: 'dialog[open]'
```

`region: modal` already resolves to `dialog[open]`, so once the step has opened
it the crop finds it with nothing more to say. Keep the `waitFor` — without it
the capture can race the dialog's render.

### Vocabulary

| Step | Does |
|---|---|
| `click: '<selector>'` | click an element |
| `hover: '<selector>'` | hover — tooltips, the status-history popup |
| `fill: {selector, text}` | type into a field |
| `select: {selector, option}` | open a dropdown, then click `option` inside its `[role="menu"]` |
| `check: '<selector>'` | tick a checkbox |
| `press: Escape` | press a key |
| `waitFor: '<selector>'` | wait until visible |
| `waitForHidden: '<selector>'` | wait until gone |
| `networkIdle: true` | wait for in-flight requests to finish — use after a click that loads data |
| `wait: 400` | milliseconds — for animation the selectors can't see; **not** for data loading |
| `scrollTo: '<selector>'` | scroll into view |
| `openDetailPanel: true` | open the right-hand "More" panel (needed for `panel` shots) |
| `selectRows: 2` | tick the first N table rows — for bulk-action-bar shots |
| `textClick: 'Log in'` | click by visible text — **avoid**, see below |

Steps chain, so a deeper state is just a longer list:

```yaml
steps:
  - click: '[data-testid="add-item-button"]'
  - waitFor: 'dialog[open]'
  - click: '[data-testid="item-search-input"]'
  - fill: {selector: '[data-testid="item-search-input"]', text: 'Amox'}
  - wait: 500
```

### Rules

**Selectors must be test ids or structure, never visible text.** The same steps
replay in English, French, Spanish and Portuguese, and `textClick: 'Add item'`
finds nothing on the French run. Nearly every toolbar and dialog control has a
`data-testid` — `add-item-button`, `dialog-button-ok`,
`status-change-button-dropdown`, `filters-menu` — so this is rarely a
constraint. `textClick` exists for the one-off where it genuinely isn't.

**Steps are per shot, not shared.** Ten shots of the same dialog each carry the
same two lines. That's deliberate — a shot should read as a complete recipe.
If it gets tedious, a `defaults:` block at the top of a file merges into every
shot in that file, so a file that is all one modal can declare `steps` once.

**Wait for content, not containers.** A table renders empty and fills in when
its query returns, so `waitFor: 'div[data-datatable]'` is satisfied before any
rows exist. Wait for a row instead — `waitFor: 'dialog[open]
[data-testid="table-row"]'` — or use `networkIdle: true` when you don't know
what the data looks like. Reach for `wait: N` only for animation; if you find
yourself adding `wait: 2000` to make a capture come out right, that's the
signal you're waiting for the wrong thing.

**A step that fails fails the shot, not the run.** The runner reports it,
moves on, and exits non-zero at the end.

## Recording a shot instead of writing one

```bash
yarn record dispensary/patients --store STR-BDR-HCC
yarn record manage/stores --server central
```

Opens the app in a visible browser with a small authoring panel in the corner.
**It starts recording immediately** — the actions you take to reach the screen
are the shot's steps, so there is nothing to switch on first. The panel header
is red while recording and grey when paused. Four modes:

| Mode | What happens |
|---|---|
| **Record** (default) | Use the app normally. Clicks become `click:` steps, typing becomes a single `fill:` per field, Enter becomes `press: Enter`. If a click opens a dialog or menu, the matching `waitFor:` is added for you. Clicking a table row that opens a record becomes `openFirstRow: true`. |
| **Region** | Hover the page. Every capture region under the cursor is outlined and named — `region: modal`, `region: filter-bar` — smallest first. Anything that isn't a named region is offered as a `clip:` on that element. Click to choose. |
| **Annotate** | Pick a type (arrow, ring, box, label, number) and, where relevant, a `from` direction. Click the element to anchor to. The preview is drawn by the **same code `yarn shoot` uses**, so it is exactly what will be captured. |
| **Pause** | The app behaves normally and nothing is recorded — for actions you do *not* want replayed, like dismissing a banner or exploring. Anything done while paused is lost, so saving a dialog or menu shot with no steps produces a warning. |

Keyboard shortcuts — `Ctrl+Alt+R` record, `G` region, `A` annotate, `P` pause,
`S` save — do the same as the buttons. Use them while a dialog or menu is open:
the panel moves inside an open dialog so clicking it is safe, but menus close
on any outside click, and a key press doesn't count as one.

**Save** writes `shots/recorded/<id>.yaml`; **Done** closes. The panel lists every
step and annotation with a `×` to remove it, and shows the shot's YAML shape
as it grows.

Two honesty rules the recorder enforces:

- Every selector it emits prefers a `data-testid`. When an element has none —
  a nav leaf, a bare heading — it falls back to a structural path and marks it
  **red** in the panel, and the saved file starts with a comment counting the
  fragile selectors. Those are the ones that will break when the layout changes.
- Password fields are never recorded.

The recorder holds the shot in Node, not in the page, so a full navigation
mid-recording loses nothing — the panel is rebuilt from Node's copy.

## Cropping

`region` names the part of the screen to capture. The selectors were verified
against the live demo at 1440x900 on 2026-09-10 (client `v0.0.368-rc0`):

| Region | Selector |
|---|---|
| `full` | *(viewport screenshot)* |
| `content` | `div[class^="_main_"]:has(> div[class^="_content_"])` |
| `content-top` | `div[class^="_page_"] > div[class^="_main_"] > header` — breadcrumb + action buttons; **not** the filter bar |
| `filter-bar` | `div[class^="_toolbar_"]:has([data-testid="filters-menu"])` — search/filter bar above a table |
| `detail-header` | `… > header div[class^="_toolbar_"]` — the field row; **detail views only** |
| `tab` | `div[class^="_list_"]:has(> [data-testid^="tab-"])` |
| `footer` | `div[class^="_footer_"]:has([data-testid="status-crumbs"])` — hold, status crumbs, confirm |
| `footer-app` | `[data-testid="app-footer"]` — store, user, sync |
| `nav` | `[data-testid="drawer"]` |
| `panel` | `[data-testid="detail-panel"]` |
| `panel-part` | `[data-testid^="panel-section-"]` |
| `modal` | `dialog[open]` — every modal is a native `<dialog>` |
| `menu` | `[role="menu"], [popover]:popover-open` |
| `toast` | **unconfirmed** — see `src/regions.js` |
| `nav-part`, `modal-part`, `content-part`, `control` | supply `clip:` per shot |

CSS-module class names carry a build hash, so all structural selectors
prefix-match. Anything with a `data-testid` uses it instead.

Several regions only exist on one kind of page. `detail-header`, `tab` and
`footer` are parts of an opened record — on a list route they resolve to
nothing, so set `openFirstRow: true`. `panel` is closed until a step opens it.
When a region isn't found the error says which of these applies.

`pad` widens the crop; it defaults to 24px when a shot has annotations so a ring
drawn just outside a button is not sliced off.

## Arrows and callouts

Annotations are **not** baked into the PNG by hand. Each one is anchored to a
selector and drawn as SVG in the page immediately before the capture, so the
arrow follows the button it points at — across releases, and across all four
languages, where a translated label changes the button's width.

```yaml
annotate:
  - type: arrow   to: '[data-testid="new-shipment-button"]'  from: below-left  length: 100
  - type: ring    around: '[data-testid="add-item-button"]'
  - type: box     around: '[data-testid="status-crumbs"]'
  - type: label   at: '[data-testid="store-selector-trigger"]'  from: above  text: Current store
  - type: number  at: '[data-testid="tab-details"]'  index: 1
```

`from` is one of `left right above below above-left above-right below-left
below-right`. Arrows are drawn with a slight bow so they read like the
hand-drawn ones already in the docs, in the same orange (`#e35f2a`, override in
`config.json`).

The overlay is rendered as a `popover` so it enters the top layer. Native
`<dialog>` elements are also top-layer, so a plain high-`z-index` div would be
painted underneath them — verified, this approach paints above an open dialog.

## Output layout

The filename is the same in every language; only the folder changes.

```
images/
  en/outbound-goto.png
  fr/outbound-goto.png
  es/outbound-goto.png
  pt/outbound-goto.png
```

So a locale can be diffed against another, or cleared and re-shot, in one go.
`--out-dir` changes the root.

The name is the shot **id**, not the original docs filename. Docs basenames are
only unique within their page bundle - `export.png` occurs 8 times across the
catalogue, and 18 basenames collide in total - so a flat per-language folder
keyed on them would silently overwrite 32 captures. Shot ids are unique.

`--in-place` writes over the actual file in the docs repo instead, using the
`file:` recorded on the shot. It stays English-only: the translated pages share
the same image files, so writing a French capture over one would break the
English page.

## Migrating the existing catalogue

`msupply_docs/screenshots/manifest.yaml` records the route and region for all
734 images in the documentation. The importer turns that into shot stubs:

```bash
yarn import-manifest ../msupply_docs/screenshots/manifest.yaml
```

Current output: **632 shots** across 16 files in `shots/generated/`, 102 skipped
as not-a-web-client-screen. Of those 632:

- **149 need a `clip` selector** — the `content-part`, `modal-part` and
  `control` shots, where the catalogue records *what* is shown but not which
  element to crop to.
- **135 need annotation coordinates** — the importer marks them `TODO` with the
  description of what the existing image has drawn on it. Someone has to open
  the current image and translate the arrow into an anchor plus a direction.

Promote entries from `shots/generated/` into `shots/` as you verify them; the
importer never touches `shots/` itself.

## Which server

| | |
|---|---|
| Remote site | `https://release-demo-open.msupply.org` |
| Central server | `https://release-demo-open.msupply.org:8888` |

Routes are store-scoped (`/{storeId}/distribution/outbound-shipment`) and the
runner resolves the id from the store code. Which store matters:

- `/dispensary/*` needs a dispensary-mode store (`STR-BDR-HCC`).
- `/manage/*`, `/programs/*`, `/catalogue/assets/log-reasons`,
  `/replenishment/purchase-order` only exist on the **central** server; from a
  remote site they redirect to the Dashboard.
- `sync` is not a route — sync lives in the app footer.

## Determinism

- Fixed 1440x900 viewport at `deviceScaleFactor: 2`. The client is responsive
  and collapses the drawer below roughly 1000px, which matches none of the
  documented screenshots.
- Animations and transitions disabled, caret hidden.
- Locale pinned to `en-GB`, timezone to `Pacific/Auckland`, so dates are stable.
- `[data-testid="footer-sync"]` is masked by default — it renders "Synced just
  now" / "last synced 34 min ago" and would otherwise differ every run. Set
  `noMask: true` on shots that are *of* the sync widget.
- `clearOverlays` dismisses the unexpected-error modal and the "A new version is
  available" stale-bundle modal, both of which appear unprompted on the demos.

## Troubleshooting

**`Login did not complete: <message>`**
The server rejected the credentials, and `<message>` is its own wording (e.g.
"Invalid credentials"). Fix `OMS_USERNAME` / `OMS_PASSWORD`.

**`Bounced back to the login page at .../resolve-store`**
Login was skipped or silently failed. This should no longer happen - if it does,
run with `--headed` and watch whether the form is filled in.

**`Neither a login form nor a signed-in view appeared`**
The server did not render within 30s. Check it is up and `OMS_URL` is right.

**`Store "STR-..." is not available to this user`**
Run `yarn stores` to see the codes this account can actually open, and fix the
`store:` field on the shot.

**`This shot needs the "central" server but config.json has no centralUrl`**
Shots under `/manage/*`, `/programs/*` and `/replenishment/purchase-order` carry
`server: central`. Set `centralUrl` in `config.json`.

**`All N matching shots are unavailable: ... pending review`**
The shots exist but the importer left `clip:` or `annotate:` as `TODO`. Fill
those in, or pick a different filter. `yarn shot-list` lists what is pending.

## Known gaps

- **The `toast` selector is unverified.** No toast container exists in the DOM
  until one fires and none could be triggered during the walk. `src/regions.js`
  carries a candidate list; confirm it against a real toast and prune.
- **Non-English in-place writing is refused.** Translated docs pages reuse the
  English image files, so writing a French capture over one would break the
  English page. Non-English runs go to `--out-dir` until the docs adopt
  per-language image paths.
