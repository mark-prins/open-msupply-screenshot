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

/**
 * Elements whose contents change between runs and would otherwise make every
 * capture differ. Masked with a solid block unless the shot is *about* them.
 */
export const DEFAULT_MASKS = [
  '[data-testid="footer-sync"]', // "Synced just now" / "last synced 34 min ago"
];

export async function capture(page, { outFile, clipSelector, pad = 0, masks = [], fullPage = false }) {
  await fs.mkdir(path.dirname(outFile), { recursive: true });

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
  await locator.waitFor({ state: 'visible', timeout: 10000 });

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
