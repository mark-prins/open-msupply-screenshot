/**
 * Turning a resolved region into a PNG.
 *
 * Clipping is done with Playwright's element screenshot where a selector is
 * available, and a viewport screenshot otherwise. `pad` widens the clip by a
 * few pixels so a ring annotation drawn just outside a control is not sliced
 * off at the edge.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { REGIONS } from './regions.js';

/**
 * Text that changes between runs and would otherwise make every capture
 * differ - the footer's "Synced · just now" / "last synced 34 min ago".
 *
 * These are FROZEN to a fixed string, not masked. Playwright's `mask` paints
 * the element a solid colour (default magenta), which is fine for visual
 * regression tests and wrong for documentation. Freezing keeps the footer
 * looking real while making the PNG byte-stable across re-shoots.
 */
export const DEFAULT_FREEZE = [
  { selector: '[data-testid="footer-sync-details"]', text: 'just now' },
];

/** Solid-colour masking is still available per shot via `masks:`; nothing is masked by default. */
export const DEFAULT_MASKS = [];

/**
 * Runs in the page. Replaces volatile text under `selector` with `text`.
 * If the element holds a single run of text, replace it outright; otherwise
 * only replace the runs that look like relative times, so an icon or a
 * static label sitting alongside is left alone.
 */
function freezeInPage(rules) {
  const VOLATILE = /\b(just now|ago|\d{1,2}:\d{2}|\d+\s?(s|m|h|d|min|mins|minute|minutes|hour|hours|day|days))\b/i;
  for (const { selector, text } of rules) {
    for (const el of document.querySelectorAll(selector)) {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const runs = [];
      let n;
      while ((n = walker.nextNode())) if (n.textContent.trim()) runs.push(n);
      if (runs.length === 1) runs[0].textContent = text;
      else for (const run of runs) if (VOLATILE.test(run.textContent)) run.textContent = text;
    }
  }
}

export async function capture(
  page,
  { outFile, clipSelector, region, pad = 0, masks = [], freeze = [], fullPage = false }
) {
  await fs.mkdir(path.dirname(outFile), { recursive: true });

  if (freeze.length) await page.evaluate(freezeInPage, freeze).catch(() => {});
  const maskLocators = masks.map((m) => page.locator(m));

  if (!clipSelector) {
    await page.screenshot({ path: outFile, fullPage, mask: maskLocators, animations: 'disabled' });
    return outFile;
  }

  // Restrict to VISIBLE matches before taking the first. Loose prefix
  // selectors can match an element inside a closed <dialog> or a
  // screen-reader-only node that appears earlier in the DOM; without this
  // filter `.first()` would lock onto it and wait out the timeout.
  const locator = page.locator(clipSelector).filter({ visible: true }).first();
  try {
    await locator.waitFor({ state: 'visible', timeout: 10000 });
  } catch {
    throw new Error(describeMissingRegion(page, region, clipSelector));
  }

  if (!pad) {
    await locator.screenshot({ path: outFile, mask: maskLocators, animations: 'disabled' });
    return outFile;
  }

  // Padded clip: element screenshots cannot bleed outside the element, so fall
  // back to a viewport screenshot with an explicit clip rectangle.
  const box = await locator.boundingBox();
  if (!box) throw new Error(`Could not measure "${clipSelector}"`);
  const vp = page.viewportSize();
  const clip = {
    x: Math.max(0, box.x - pad),
    y: Math.max(0, box.y - pad),
    width: Math.min(vp.width - Math.max(0, box.x - pad), box.width + pad * 2),
    height: Math.min(vp.height - Math.max(0, box.y - pad), box.height + pad * 2),
  };
  await page.screenshot({ path: outFile, clip, mask: maskLocators, animations: 'disabled' });
  return outFile;
}

/**
 * A region that never appeared is nearly always a region that does not exist
 * on this kind of page - a detail-only element asked for on a list route, or
 * a panel that has to be opened first. Say that, rather than dumping the
 * selector and a timeout.
 */
function describeMissingRegion(page, region, clipSelector) {
  const def = region ? REGIONS[region] : null;
  const where = page.url().replace(/^https?:\/\/[^/]+\/[0-9A-F]{32}\//i, '');
  const lines = [
    `Region "${region ?? 'clip'}" was not visible on ${where}.`,
    `  selector: ${clipSelector}`,
  ];
  if (def?.hint) lines.push(`  hint: ${def.hint}`);
  if (def?.unverified) lines.push('  note: this region\'s selector is not yet confirmed against the app.');
  return lines.join('\n');
}

/**
 * Where a capture is written.
 *
 *   images/<lang>/<id>.png                      (default)
 *   <docs repo>/<manifest file path>            (--in-place, English only)
 *
 * The filename is identical in every language and only the folder changes, so
 * the same image can be diffed across locales and a whole language can be
 * copied or cleared in one go.
 *
 * The name is the shot id, not the original docs filename, because docs
 * basenames are only unique within their page bundle: `export.png` occurs 8
 * times across the catalogue and 18 basenames collide in total, which would
 * silently overwrite 32 captures in a flat per-language folder. Shot ids are
 * unique by construction.
 *
 * In-place writing is what makes this useful for the docs: the manifest already
 * records the exact path each image lives at, so a run can update the repo
 * directly rather than dumping into a folder someone then has to sort out.
 */
export function outputPath({ outDir, shot, language, inPlace, docsRoot }) {
  if (inPlace) {
    if (!shot.file) {
      throw new Error(`Shot "${shot.id}" has no "file" recorded, so it cannot be written in place`);
    }
    if (language !== 'en') {
      // Translated pages reuse the English image files, so writing a non-English
      // capture over them would corrupt the English docs. Only `images-en/`
      // bundles are language-specific, and those are English by definition.
      throw new Error(
        `Refusing to write ${language} in place over ${shot.file}: the translated ` +
          `pages share this file with English. Capture non-English runs to --out-dir.`
      );
    }
    return path.join(docsRoot, shot.file);
  }
  return path.join(outDir, language, `${shot.id}.png`);
}
