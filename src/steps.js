/**
 * Per-shot interaction steps.
 *
 * Most catalogued screenshots are not of a bare route - they show a dialog, an
 * open dropdown, selected rows or a filled-in field. A shot therefore carries a
 * short list of steps to run after navigating and before capturing.
 *
 * Steps are deliberately declarative so the whole shot definition stays data,
 * and so the same definition can be replayed in four languages: selectors are
 * test ids, never visible text, unless the shot opts into `textClick`.
 */

const DEFAULT_TIMEOUT = 10000;

/**
 * @typedef {object} Step
 * @property {string} [click]        selector to click
 * @property {string} [textClick]    click by accessible name (avoid: breaks per language)
 * @property {string} [hover]        selector to hover
 * @property {object} [fill]         {selector, text}
 * @property {object} [select]       {selector, option} - click trigger then a [role=menuitem]
 * @property {string} [check]        selector of a checkbox to tick
 * @property {string} [press]        key to press, e.g. "Escape"
 * @property {string} [waitFor]      selector to wait for
 * @property {string} [waitForHidden] selector to wait to disappear
 * @property {number} [wait]         milliseconds
 * @property {string} [scrollTo]     selector to scroll into view
 * @property {boolean} [openDetailPanel] open the right-hand panel
 * @property {number} [selectRows]   tick the first N table rows
 */

export async function runSteps(page, steps = []) {
  for (const step of steps) {
    await runStep(page, step);
  }
}

async function runStep(page, step) {
  if (step.wait != null) {
    await page.waitForTimeout(step.wait);
    return;
  }
  if (step.waitFor) {
    await page.locator(step.waitFor).first().waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT });
    return;
  }
  if (step.waitForHidden) {
    await page.locator(step.waitForHidden).first().waitFor({ state: 'hidden', timeout: DEFAULT_TIMEOUT });
    return;
  }
  if (step.openDetailPanel) {
    await page.locator('[data-testid="open-detail-panel-button"]').click({ timeout: DEFAULT_TIMEOUT });
    await page.locator('[data-testid="detail-panel"]').waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT });
    await page.waitForTimeout(250);
    return;
  }
  if (step.selectRows != null) {
    const boxes = page.locator('[data-testid="select-row-checkbox"]');
    const n = Math.min(step.selectRows, await boxes.count());
    for (let i = 0; i < n; i++) await boxes.nth(i).click();
    await page.waitForTimeout(200);
    return;
  }
  if (step.click) {
    await page.locator(step.click).first().click({ timeout: DEFAULT_TIMEOUT });
    await page.waitForTimeout(200);
    return;
  }
  if (step.textClick) {
    await page.getByRole('button', { name: step.textClick }).first().click({ timeout: DEFAULT_TIMEOUT });
    await page.waitForTimeout(200);
    return;
  }
  if (step.hover) {
    await page.locator(step.hover).first().hover({ timeout: DEFAULT_TIMEOUT });
    await page.waitForTimeout(250);
    return;
  }
  if (step.check) {
    await page.locator(step.check).first().check({ timeout: DEFAULT_TIMEOUT });
    return;
  }
  if (step.fill) {
    await page.locator(step.fill.selector).first().fill(step.fill.text, { timeout: DEFAULT_TIMEOUT });
    await page.waitForTimeout(250);
    return;
  }
  if (step.select) {
    await page.locator(step.select.selector).first().click({ timeout: DEFAULT_TIMEOUT });
    await page.locator('[role="menu"]').waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT });
    await page.locator(step.select.option).first().click({ timeout: DEFAULT_TIMEOUT });
    await page.waitForTimeout(250);
    return;
  }
  if (step.press) {
    await page.keyboard.press(step.press);
    await page.waitForTimeout(200);
    return;
  }
  if (step.scrollTo) {
    await page.locator(step.scrollTo).first().scrollIntoViewIfNeeded({ timeout: DEFAULT_TIMEOUT });
    await page.waitForTimeout(200);
    return;
  }
  throw new Error(`Unrecognised step: ${JSON.stringify(step)}`);
}

/**
 * Open the first row of a list and return once the detail route has loaded.
 * Detail-view shots use this rather than hard-coding a record id, which would
 * not survive a database refresh.
 */
export async function openFirstRow(page) {
  const row = page.locator('[data-testid="table-row"]').first();
  await row.waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT });
  await row.click();
  await page.waitForURL(/\/[0-9a-f-]{8,}$/i, { timeout: DEFAULT_TIMEOUT }).catch(() => {});
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(400);
}
