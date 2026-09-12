/* global document, window */
import assert from 'node:assert/strict';
import process from 'node:process';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL, URL } from 'node:url';
import { log } from 'node:console';

// Uses an independently installed Playwright, without changing project dependencies.
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright'
);
const origin = process.env.FRONTEND_URL ?? 'http://127.0.0.1:5175';
const output = process.env.QA_OUTPUT ?? '/private/tmp/rescuemesh-qa';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {})
});
try {
  for (const [name, viewport] of [
    ['desktop', { width: 1440, height: 1000 }],
    ['mobile', { width: 390, height: 844 }]
  ]) {
    const context = await browser.newContext({ viewport });
    // Test browser may reach only this isolated frontend. No backend or provider calls.
    await context.route('**/*', (route) =>
      new URL(route.request().url()).origin === origin ? route.continue() : route.abort()
    );
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(origin);
    await page.getByRole('form', { name: 'Synthetic exercise builder' }).waitFor();
    await page.screenshot({ path: `${output}/${name}-overview.png`, fullPage: true });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
      `${name}: no horizontal overflow`
    );
    assert.equal(await page.getByLabel('Disaster 1 type').inputValue(), 'flash_flood');
    assert.equal(await page.getByLabel('Disaster 1 zone').inputValue(), 'zone-oakland');
    await page.getByRole('button', { name: 'Add second disaster', exact: true }).click();
    await page.getByLabel('Disaster 1 zone').selectOption('zone-downtown');
    await page.getByLabel('Disaster 2 type').selectOption('structural_fire');
    await page.getByLabel('Disaster 2 zone').selectOption('zone-oakland');
    const simulate = page.getByRole('button', { name: 'Simulate', exact: true });
    await simulate.click();
    assert.equal(
      await page.getByRole('button', { name: 'Starting…', exact: true }).isDisabled(),
      true
    );
    const planAction = page.locator('.plan-actions .primary');
    assert.equal(await planAction.isDisabled(), true, 'No approval during deliberation');
    await page.getByRole('button', { name: 'Approve Plan', exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector('.plan-actions .primary')?.disabled);
    assert.equal(await page.locator('.chief-position').count(), 5);
    assert.equal(await page.locator('.debate-row').count(), 5);
    assert.equal(
      (await page.getByText('Flash flood · Downtown / Uptown / Strip').count()) > 0,
      true
    );
    assert.equal(
      (await page.getByText('Structural fire · Oakland / Bates Street').count()) > 0,
      true
    );
    assert.equal(
      await page
        .locator('.deliberation-provenance strong')
        .allTextContents()
        .then((items) => items.every((text) => text === 'Scripted fallback')),
      true
    );
    await page
      .locator('.deliberation-panel')
      .screenshot({ path: `${output}/${name}-deliberation.png` });
    await page
      .locator('.chief-position')
      .first()
      .screenshot({ path: `${output}/${name}-chief.png` });
    await page
      .locator('.debate-row')
      .first()
      .screenshot({ path: `${output}/${name}-debate.png` });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
      `${name}: deliberation fits width`
    );
    await page.getByRole('button', { name: 'Approve Plan', exact: true }).click();
    await page
      .getByText('Plan approval complete · mock simulation.', { exact: true })
      .first()
      .waitFor();
    await page.getByRole('button', { name: 'Close a Bridge', exact: false }).click();
    await page.getByRole('button', { name: 'Disconnect Zone', exact: false }).click();
    await page
      .getByLabel('Report an incident', { exact: false })
      .fill('Synthetic field report: evacuation assistance needed at the school.');
    await page.getByRole('button', { name: 'Queue report', exact: false }).click();
    await page
      .getByText('Synthetic field report: evacuation assistance needed at the school.', {
        exact: true
      })
      .first()
      .waitFor();
    await page.getByRole('button', { name: 'Reconnect Network', exact: false }).click();
    // Reset while a second session is running, then ensure late results cannot return.
    await page.getByRole('button', { name: 'Simulate', exact: true }).click();
    await page.getByRole('button', { name: 'Reset Simulation', exact: false }).click();
    await page.getByRole('button', { name: 'Reset scenario', exact: true }).click();
    await page
      .getByText('Scenario reset complete · mock simulation.', { exact: true })
      .first()
      .waitFor();
    assert.equal(await page.locator('.chief-position').count(), 0);
    assert.equal(await page.getByLabel('Disaster 1 type').inputValue(), 'flash_flood');
    assert.equal(await page.getByLabel('Disaster 1 zone').inputValue(), 'zone-oakland');
    assert.equal(await page.getByLabel('Disaster 2 type').count(), 0);
    await page.getByRole('button', { name: 'Add second disaster', exact: true }).click();
    await page.getByLabel('Disaster 1 type').selectOption('multi_vehicle_collision');
    await page.getByLabel('Disaster 1 zone').selectOption('zone-east');
    await page.getByLabel('Disaster 2 type').selectOption('structural_fire');
    await page.getByLabel('Disaster 2 zone').selectOption('zone-east');
    await page.getByRole('button', { name: 'Simulate', exact: true }).click();
    await page.getByRole('button', { name: 'Close a Bridge', exact: false }).click();
    await page
      .getByText(
        'Scenario changed while the chiefs were deliberating. Run a new simulation to generate a current plan.',
        { exact: true }
      )
      .waitFor();
    assert.equal(await page.locator('.plan-actions .primary').isDisabled(), true);
    // Keyboard focus is visible and native buttons remain keyboard reachable.
    await page.keyboard.press('Tab');
    assert.notEqual(await page.evaluate(() => document.activeElement?.tagName), 'BODY');
    assert.deepEqual(errors, [], 'No browser runtime errors');
    log(`${name}: full offline/approval/reset/stale flow passed; screenshots in ${output}`);
    await context.close();
  }
} finally {
  await browser.close();
}
