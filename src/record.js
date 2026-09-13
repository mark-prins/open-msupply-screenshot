#!/usr/bin/env node
/**
 * yarn record <route> [--store CODE] [--server central] [--no-login]
 *
 * Opens the app in a visible browser with an authoring overlay. Press Record
 * and use the app; clicks and typing become `steps`. Press Region and hover
 * to see the capture regions under the cursor, click to choose. Press
 * Annotate, pick a type and direction, click the element to anchor to - the
 * preview is drawn by the same code `yarn shoot` uses. Save writes the shot
 * to shots/recorded/<id>.yaml.
 *
 * Node owns the shot. The page only reports events and renders whatever Node
 * hands back, so a full navigation mid-recording loses nothing.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { launch, login, resolveStore, gotoRoute } from './session.js';
import { REGIONS } from './regions.js';
import { renderAnnotations, DEFAULT_STYLE } from './annotate.js';
import { overlayMain } from './overlay.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Regions offered by the picker, smallest-first order does not matter here. */
const PICKABLE = ['modal', 'menu', 'panel-part', 'panel', 'filter-bar', 'detail-header', 'tab', 'footer', 'footer-app', 'nav-part', 'nav', 'content-top', 'content'];

/**
 * Attach the recorder to a page. Returns a controller you can read the shot
 * from; the CLI waits on `done`. Exported so it can be driven headless in
 * tests without a human at the keyboard.
 */
export async function attachRecorder(page, { route, store, server, onSave }) {
  const shot = {
    id: '',
    route,
    store,
    server: server === 'central' ? 'central' : undefined,
    region: null,
    clip: null,
    clipStable: true,
    pad: null,
    openFirstRow: false,
    steps: [],
    annotate: [],
    savedTo: null,
    error: null,
    ui: { pos: null, collapsed: false }, // panel position/state - not part of the saved shot
  };
  let resolveDone;
  const done = new Promise((r) => (resolveDone = r));

  const publicState = () => ({ ...shot });

  const handle = async (evt) => {
    shot.error = null;
    switch (evt.type) {
      case 'id':
        shot.id = String(evt.id || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        break;
      case 'step':
        shot.steps.push({ step: evt.step, stable: evt.stable !== false, auto: !!evt.auto, label: evt.label });
        break;
      case 'removeStep':
        shot.steps.splice(evt.index, 1);
        break;
      case 'navigate': {
        // A click on a table row that lands on a record id IS `openFirstRow`.
        const last = shot.steps.at(-1);
        const gainedId = /\/[0-9a-f-]{8,}$/i.test(evt.path);
        if (last && last.step.click?.includes('table-row') && gainedId && shot.steps.length === 1) {
          shot.steps.pop();
          shot.openFirstRow = true;
        } else {
          shot.steps.push({ step: { '#navigated': evt.path.replace(/^\/[0-9A-F]{32}\//i, '') }, stable: true, auto: true });
        }
        break;
      }
      case 'region':
        shot.region = evt.region;
        shot.clip = evt.clip || null;
        shot.clipStable = evt.stable !== false;
        break;
      case 'pad':
        shot.pad = evt.pad;
        break;
      case 'annotation':
        shot.annotate.push(evt.annotation);
        if (evt.stable === false) shot.error = 'That anchor has no data-testid - the arrow will break if the layout changes.';
        break;
      case 'removeAnnotation':
        shot.annotate.splice(evt.index, 1);
        break;
      case 'ui':
        shot.ui = { ...shot.ui, ...evt.ui };
        break;
      case 'save': {
        if (!shot.id) { shot.error = 'Give the shot an id first.'; break; }
        if (!shot.region) { shot.error = 'Choose a region first.'; break; }
        const file = await (onSave ?? defaultSave)(toShotYaml(shot), shot.id);
        shot.savedTo = path.relative(ROOT, file);
        shot.closeArmed = false;
        break;
      }
      case 'done':
        // A checkmark-shaped "Done" read as "confirm my selection" and threw
        // away unsaved work. Closing with nothing saved now takes two clicks.
        if (!shot.savedTo && !shot.closeArmed) {
          shot.closeArmed = true;
          shot.error = 'Nothing has been saved. Click "Save shot" first, or click again to close and discard.';
          break;
        }
        resolveDone();
        break;
      default:
        shot.error = `Unknown event ${evt.type}`;
    }
    return publicState();
  };

  await page.exposeFunction('__omsEvent', handle);
  await page.exposeFunction('__omsGetState', async () => publicState());

  const cfg = {
    regions: Object.fromEntries(PICKABLE.map((r) => [r, REGIONS[r]?.selector]).filter(([, s]) => s)),
    regionOrder: PICKABLE,
    style: DEFAULT_STYLE,
  };
  await page.addInitScript(
    `window.__omsRender = ${renderAnnotations.toString()};\n(${overlayMain.toString()})(${JSON.stringify(cfg)});`
  );

  return {
    done,
    getShot: () => publicState(),
    getYaml: () => toShotYaml(shot),
    handle, // for tests
  };
}

/** The recorder's working state -> a shot as shots/*.yaml expects it. */
export function toShotYaml(shot) {
  const out = { id: shot.id, route: shot.route };
  if (shot.server) out.server = shot.server;
  if (shot.store) out.store = shot.store;
  out.region = shot.region;
  if (shot.clip) out.clip = shot.clip;
  if (shot.pad != null) out.pad = shot.pad;
  if (shot.openFirstRow) out.openFirstRow = true;
  const steps = shot.steps.map((s) => s.step).filter((s) => !('#navigated' in s));
  if (steps.length) out.steps = steps;
  if (shot.annotate.length) out.annotate = shot.annotate;
  const fragile = shot.steps.filter((s) => !s.stable).length + (shot.clipStable === false ? 1 : 0);
  let text = YAML.stringify({ shots: [out] }, { lineWidth: 100 });
  if (fragile) {
    text = `# ${fragile} selector(s) below have no data-testid and may break when the layout changes.\n` + text;
  }
  return text;
}

/**
 * If the recorder closes with unsaved work - browser crash, accidental close,
 * a bug like the 30s timeout - write it to a recovery file. The leading
 * underscore keeps it out of `yarn shoot` (loadShots skips `_*.yaml`) until
 * someone renames it deliberately.
 */
export async function recoverUnsaved(shot, dir = path.join(ROOT, 'shots', 'recorded')) {
  const hasWork = shot.steps.length || shot.annotate.length || shot.region;
  if (!hasWork) return null;
  await fs.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(dir, `_recovered-${shot.id || 'untitled'}-${stamp}.yaml`);
  const body = toShotYaml({ ...shot, id: shot.id || 'untitled', region: shot.region || 'full' });
  await fs.writeFile(file, `# Recovered from a recorder session that closed without saving.\n# Review, rename without the leading underscore, and fix region/id.\n${body}`);
  return file;
}

async function defaultSave(yamlText, id) {
  const dir = path.join(ROOT, 'shots', 'recorded');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${id}.yaml`);
  await fs.writeFile(file, yamlText);
  return file;
}

function parseArgs(argv) {
  const args = { route: null, store: null, server: 'remote', login: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--store') args.store = argv[++i];
    else if (a === '--server') args.server = argv[++i];
    else if (a === '--no-login') args.login = false;
    else if (!a.startsWith('--') && !args.route) args.route = a;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.route) {
    console.error('usage: yarn record <route> [--store CODE] [--server central]\n  e.g. yarn record dispensary/patients --store STR-BDR-HCC');
    process.exit(1);
  }
  const cfg = JSON.parse(await fs.readFile(path.join(ROOT, 'config.json'), 'utf8'));
  const baseUrl = args.server === 'central' ? cfg.centralUrl : process.env.OMS_URL || cfg.baseUrl;
  const creds = { username: process.env.OMS_USERNAME, password: process.env.OMS_PASSWORD };
  if (args.login && (!creds.username || !creds.password)) {
    console.error('Set OMS_USERNAME and OMS_PASSWORD (or pass --no-login).');
    process.exit(1);
  }

  const { browser, context, page } = await launch({
    headed: true,
    viewport: cfg.viewport ?? { width: 1440, height: 900 },
    deviceScaleFactor: 1, // authoring, not capture
  });

  try {
    let storeId = null;
    if (args.login) {
      await login(page, { baseUrl, ...creds });
      storeId = await resolveStore(page, { baseUrl, storeCode: args.store });
    }
    const rec = await attachRecorder(page, { route: args.route, store: args.store, server: args.server });
    if (storeId) await gotoRoute(page, { baseUrl, storeId, route: args.route });
    else await page.goto(`${baseUrl}/${args.route.replace(/^\/+/, '')}`);

    console.log('Recorder open. Press Record in the overlay and use the app; Save writes shots/recorded/<id>.yaml; Done closes.');
    // timeout: 0 is essential. waitForEvent defaults to a 30 SECOND timeout,
    // and the .catch turned that into a resolved promise - so the recorder
    // silently closed itself half a minute in, mid-recording.
    await Promise.race([rec.done, page.waitForEvent('close', { timeout: 0 }).catch(() => {})]);
    const s = rec.getShot();
    if (s.savedTo) {
      console.log(`\nSaved: ${s.savedTo}`);
    } else {
      const recovered = await recoverUnsaved(s);
      console.log('\nRecorder closed WITHOUT saving.' + (recovered ? ` Work recovered to ${path.relative(ROOT, recovered)}` : ''));
      console.log(rec.getYaml());
    }
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
