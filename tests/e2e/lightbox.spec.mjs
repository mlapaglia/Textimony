import { test, expect, loadFiles, scrollTo } from './fixtures.mjs';
import { FIXTURES, takeoutWithAttachments } from '../helpers/takeout.mjs';

test.describe('lightbox', () => {
  test.beforeEach(async ({ page }) => {
    await loadFiles(page, takeoutWithAttachments([
      { name: 'portrait.heic', data: FIXTURES.portraitHeic() },
      { name: 'landscape.jpg', data: FIXTURES.landscapeJpg(), fromMe: true },
    ]));
    await scrollTo(page, '#galleryCard');
  });

  /** Opens a photo and returns where the picture is drawn inside its (stage-filling) <img>. */
  async function open(page, name) {
    await page.click(`#galleryGrid .tile[title="${name}"]`);
    await page.waitForFunction(() => document.querySelector('#viewer .viewer-stage img:not(.viewer-preview)')?.naturalWidth, null, { timeout: 60_000 });
    return page.$eval('#viewer .viewer-stage img', (img) => {
      const r = img.getBoundingClientRect();
      const s = Math.min(r.width / img.naturalWidth, r.height / img.naturalHeight);
      const w = img.naturalWidth * s;
      const h = img.naturalHeight * s;
      return { el: { x: r.left, y: r.top }, pic: { x: r.left + (r.width - w) / 2, y: r.top + (r.height - h) / 2, w, h } };
    });
  }
  const viewer = (page) => page.locator('#viewer');

  test('stays open when clicking the picture', async ({ page }) => {
    const { pic } = await open(page, 'portrait.heic');
    await page.mouse.click(pic.x + pic.w / 2, pic.y + pic.h / 2);
    await page.mouse.click(pic.x + 3, pic.y + pic.h / 2);
    await expect(viewer(page)).toHaveAttribute('open', '');
  });

  test('closes when clicking the empty band beside a portrait photo', async ({ page }) => {
    const { el, pic } = await open(page, 'portrait.heic');
    await page.mouse.click((el.x + pic.x) / 2, pic.y + pic.h / 2);
    await expect(viewer(page)).not.toHaveAttribute('open');
  });

  test('closes when clicking the backdrop or the caption text', async ({ page }) => {
    await open(page, 'landscape.jpg');
    await page.mouse.click(20, 20);
    await expect(viewer(page)).not.toHaveAttribute('open');
    await open(page, 'landscape.jpg');
    await page.mouse.click(300, 900 - 22);
    await expect(viewer(page)).not.toHaveAttribute('open');
  });

  test('stays open for the arrows and download link; the X closes it', async ({ page }) => {
    await open(page, 'landscape.jpg');
    await page.click('#viewer .next');
    await expect(page.locator('#viewer .viewer-caption')).toContainText('portrait.heic');
    await expect(viewer(page)).toHaveAttribute('open', '');
    await page.waitForSelector('#viewer .viewer-caption a');
    await page.click('#viewer .viewer-caption a');
    await expect(viewer(page)).toHaveAttribute('open', '');
    await page.click('#viewer .viewer-close');
    await expect(viewer(page)).not.toHaveAttribute('open');
  });

  test('Escape closes it', async ({ page }) => {
    await open(page, 'landscape.jpg');
    await page.keyboard.press('Escape');
    await expect(viewer(page)).not.toHaveAttribute('open');
  });
});
