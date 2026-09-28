// Recorder regression suite. Runs headless against a local fixture - no
// server, no credentials. `yarn test`.
//
// Every case here is a bug that shipped once:
//   - panel matched itself as a `menu` region
//   - clicking the panel closed the modal being captured
//   - a dialog unmounting took the panel with it
//   - window.prompt() is auto-dismissed by Playwright, dropping arrow/label
//   - waitForEvent('close') timed out after 30s and closed the recorder
import { chromium } from 'playwright';
import { attachRecorder, recoverUnsaved } from '../src/record.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const HTML = `<!doctype html><body>
<nav data-testid="drawer"><button data-testid="nav-dispensary">Dispensary</button></nav>
<button id="open" data-testid="open-dialog">open</button>
<button id="menu-btn" data-testid="menu-trigger">menu</button>
<div id="menu" role="menu" hidden data-testid="the-menu"><div>Item A</div></div>
<table><tbody>
  <tr data-testid="table-row"><td data-testid="cell-code">PT001</td><td data-testid="cell-firstName">Schendrik</td></tr>
</tbody></table>
<input data-testid="search" placeholder="search">
<dialog id="d" data-testid="the-dialog"><form method="dialog"><p>Search for a patient</p>
  <input data-testid="dlg-search"><button data-testid="dlg-ok">OK</button></form></dialog>
<footer data-testid="app-footer"><span data-testid="footer-sync">Synced <span data-testid="footer-sync-details">just now</span></span></footer>
<script>
  const d = document.getElementById('d'), m = document.getElementById('menu');
  document.getElementById('open').onclick = () => d.showModal();
  document.getElementById('menu-btn').onclick = () => (m.hidden = false);
  const outside = (el, e) => !el.contains(e.target);
  document.addEventListener('pointerdown', (e) => { if (d.open && outside(d, e)) d.close(); }, true);
  document.addEventListener('mousedown', (e) => { if (!m.hidden && outside(m, e) && e.target.id !== 'menu-btn') m.hidden = true; });
  window.formSubmits = 0; d.querySelector('form').addEventListener('submit', () => window.formSubmits++);
</script></body>`;

const failures = [];
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : `  -> ${detail}`}`); if (!ok) failures.push(name); };

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const saved = [];
const rec = await attachRecorder(page, { route: 'dispensary/patients', store: 'STR-BDR-HCC', server: 'remote',
  onSave: async (y, id) => { saved.push({ id, y }); return `/v/${id}.yaml`; } });
await page.route('https://fixture.test/**', (r) => r.fulfill({ body: HTML, contentType: 'text/html' }));
await page.goto('https://fixture.test/p');
await page.waitForFunction(() => !!document.getElementById('__oms_rec_bar'));
const centre = async (sel) => { const b = await page.locator(sel).boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2]; };
const mode = () => page.evaluate(() => window.__oms.getMode());
const shot = () => rec.getShot();

// --- recording is the default and captures without a mode change ----------
check('starts in record mode', (await mode()) === 'record');
await page.mouse.click(...(await centre('[data-testid="search"]')));
await page.keyboard.type('sch');
await page.mouse.click(...(await centre('[data-testid="open-dialog"]')));
await page.waitForTimeout(600);
const steps = shot().steps.map((s) => s.step);
check('click recorded with test id', JSON.stringify(steps[0]) === '{"click":"[data-testid=\\"search\\"]"}', JSON.stringify(steps[0]));
check('typing coalesced into one fill', JSON.stringify(steps[1]) === '{"fill":{"selector":"[data-testid=\\"search\\"]","text":"sch"}}', JSON.stringify(steps[1]));
check('dialog-opening click gets an auto waitFor', JSON.stringify(steps.at(-1)) === '{"waitFor":"dialog[open]"}', JSON.stringify(steps.at(-1)));

// --- panel lives inside the open dialog; clicking it does not close it -----
check('dialog opened', await page.evaluate(() => document.getElementById('d').open));
check('panel re-parented into dialog', (await page.evaluate(() => document.getElementById('__oms_rec_bar').closest('dialog')?.id)) === 'd');
await page.mouse.click(...(await centre('#__oms_rec_bar button:text-is("▭ Region")')));
await page.waitForTimeout(150);
check('panel click leaves dialog open', await page.evaluate(() => document.getElementById('d').open));
check('panel click does not submit dialog form', (await page.evaluate(() => window.formSubmits)) === 0);
check('panel click switched mode', (await mode()) === 'region');

// --- region picking -------------------------------------------------------
const [px, py] = await centre('#d p');
await page.mouse.move(px, py); await page.waitForTimeout(100);
check('hover names the region, not the panel', (await page.evaluate(() => document.querySelector('#__oms_rec_layer span')?.textContent)) === 'region: modal');
await page.mouse.click(px, py); await page.waitForTimeout(150);
check('click picks region', shot().region === 'modal');
check('pick drops back to pause', (await mode()) === 'pause');
check('pick did not close dialog', await page.evaluate(() => document.getElementById('d').open));

// --- annotations: every type saves on click; caption edits in panel --------
for (const type of ['arrow', 'ring', 'box', 'label', 'number']) {
  const before = shot().annotate.length;
  await page.evaluate((t) => { window.__oms.setMode('annotate'); window.__oms.setAnnotationType(t); }, type);
  await page.mouse.click(...(await centre('[data-testid="dlg-ok"]'))); await page.waitForTimeout(150);
  check(`${type} saved on click`, shot().annotate.length === before + 1);
}
check('no prompt was involved (arrow has anchor)', shot().annotate[0]?.to === '[data-testid="dlg-ok"]', JSON.stringify(shot().annotate[0]));
const cap = page.locator('#__oms_rec_bar input[data-ann="0"]');
check('caption field present for arrow', (await cap.count()) === 1);
await cap.click(); await cap.fill('Click OK'); await cap.press('Enter'); await page.waitForTimeout(150);
check('caption saved from panel', shot().annotate[0].text === 'Click OK', shot().annotate[0].text);
check('preview drawn in top layer', await page.evaluate(() => document.getElementById('__oms_shot_overlay__')?.matches(':popover-open')));

// --- hotkeys work with the dialog open -------------------------------------
await page.keyboard.press('Control+Alt+KeyP'); await page.waitForTimeout(80);
check('hotkey pause', (await mode()) === 'pause');
await rec.handle({ type: 'id', id: 'Recorder Test' });
await page.keyboard.press('Control+Alt+KeyS'); await page.waitForTimeout(200);
check('hotkey save wrote a file', saved.at(-1)?.id === 'recorder-test', JSON.stringify(saved.at(-1)?.id));
check('saved yaml has steps, region and annotations', /steps:/.test(saved.at(-1).y) && /region: modal/.test(saved.at(-1).y) && /annotate:/.test(saved.at(-1).y));

// --- dialog unmount must not take the panel with it ------------------------
await page.evaluate(() => document.getElementById('d').remove()); await page.waitForTimeout(150);
check('panel survives dialog unmount', await page.evaluate(() => document.getElementById('__oms_rec_bar')?.isConnected && document.getElementById('__oms_rec_bar').matches(':popover-open')));
check('state survives dialog unmount', shot().region === 'modal' && shot().annotate.length === 5);

// --- menu: panel click must not close it -----------------------------------
await page.mouse.click(...(await centre('#menu-btn'))); await page.waitForTimeout(100);
await page.mouse.click(...(await centre('#__oms_rec_bar button:text-is("❚❚ Pause")'))); await page.waitForTimeout(100);
check('panel click leaves menu open', await page.evaluate(() => !document.getElementById('menu').hidden));

// --- drag persists; close is armed; recovery file --------------------------
const hb = await page.locator('#__oms_rec_bar > div').first().boundingBox();
await page.mouse.move(hb.x + 40, hb.y + hb.height / 2); await page.mouse.down();
await page.mouse.move(hb.x - 400, hb.y + 200, { steps: 6 }); await page.mouse.up(); await page.waitForTimeout(150);
check('drag position stored', !!shot().ui.pos);
let closed = false; rec.done.then(() => (closed = true));
await rec.handle({ type: 'save' }); // now savedTo is set - close should be immediate
const closeBtn = page.locator('#__oms_rec_bar button:has-text("Close")');
const cb = await closeBtn.boundingBox();
const underCursor = await page.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); return e ? `${e.tagName}#${e.id}.${(typeof e.className === 'string' ? e.className : '').split(' ')[0]} "${(e.innerText || '').slice(0, 20)}"` : null; }, [cb.x + cb.width / 2, cb.y + cb.height / 2]);
await page.mouse.click(cb.x + cb.width / 2, cb.y + cb.height / 2); await page.waitForTimeout(150);
check('close after save is immediate', closed,
  `savedTo=${shot().savedTo} armed=${shot().closeArmed} err=${shot().error} box=${JSON.stringify(cb)} elementAtPoint=${underCursor} label=${await closeBtn.innerText()}`);
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oms-rec-'));
check('recovery skips empty session', (await recoverUnsaved({ id: '', steps: [], annotate: [], region: null }, dir)) === null);
const rf = await recoverUnsaved({ ...shot(), savedTo: null }, dir);
check('recovery file is underscore-prefixed', !!rf && path.basename(rf).startsWith('_recovered-'));

await browser.close();
console.log(`\n${failures.length ? `${failures.length} FAILED: ${failures.join(', ')}` : 'all recorder checks passed'}`);
process.exit(failures.length ? 1 : 0);
