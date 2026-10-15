import { test, expect, loadFiles, scrollTo, HEIC_TO_URL, HEIC_TO_PATH } from './fixtures.mjs';
import { FIXTURES, takeoutWithAttachments } from '../helpers/takeout.mjs';

// Chromium can't decode HEIC itself, so these exercise the heic-to path.
const mixedExport = () => takeoutWithAttachments([
  { name: 'IMG_0001.HEIC', data: FIXTURES.landscapeHeic() },
  { name: 'IMG_0002.heic', data: FIXTURES.portraitHeic(), fromMe: true },
  { name: 'renamed.jpg', data: FIXTURES.portraitHeic() }, // a HEIC with the wrong extension
  { name: 'normal.jpg', data: FIXTURES.landscapeJpg(), fromMe: true },
]);

/** Size and top-left pixel color of each gallery preview, by file name. */
const previews = (page) => page.$$eval('#galleryGrid .tile', (tiles) => Object.fromEntries(tiles.map((t) => {
  const img = t.querySelector('img');
  if (!img) return [t.title, { state: t.classList.contains('no-preview') ? 'no-preview' : 'pending' }];
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  return [t.title, { state: 'loaded', w: img.naturalWidth, h: img.naturalHeight, topLeft: [...ctx.getImageData(10, 10, 1, 1).data.slice(0, 3)] }];
})));

const settled = (page) => page.waitForFunction(() => {
  const tiles = [...document.querySelectorAll('#galleryGrid .tile')];
  return tiles.length && tiles.every((t) => t.classList.contains('loaded') || t.classList.contains('no-preview'));
}, null, { timeout: 60_000 });

const RED = (c) => c[0] > 200 && c[1] < 60 && c[2] < 60;
const GREEN = (c) => c[0] < 60 && c[1] > 150 && c[2] < 60;

/** Opens an attachment in the viewer and waits for the final image (or the download box). */
async function openInViewer(page, name) {
  if (await page.locator('#viewer[open]').count()) await page.click('#viewer .viewer-close');
  await page.click(`#galleryGrid .tile[title="${name}"]`);
  await page.waitForFunction(() => {
    const stage = document.querySelector('#viewer .viewer-stage');
    const img = stage.querySelector('img:not(.viewer-preview)');
    return (img && img.complete && img.naturalWidth) || stage.querySelector('.viewer-file');
  }, null, { timeout: 60_000 });
}

/** The viewer's download links: text, file name, size and first bytes of what they point at. */
const viewerLinks = (page) => page.evaluate(async () => Promise.all(
  [...document.querySelectorAll('#viewer .viewer-caption a, #viewer .viewer-file a')].map(async (a) => {
    const b = await (await fetch(a.href)).blob();
    const head = [...new Uint8Array(await b.slice(0, 12).arrayBuffer())].map((x) => x.toString(16).padStart(2, '0')).join('');
    return { text: a.textContent, download: a.download, size: b.size, head };
  }),
));
const JPEG = /^ffd8ff/;
const HEIC = /^0000002[0-9a-f]6674797068656963/; // ....ftypheic

test.describe('HEIC attachments', () => {
  test('previews every photo with the right shape and orientation, loading heic-to once', async ({ page }) => {
    const heicRequests = [];
    page.on('request', (r) => { if (r.url() === HEIC_TO_URL) heicRequests.push(r.url()); });
    await loadFiles(page, mixedExport());
    expect(heicRequests, 'heic-to is only fetched when a HEIC needs it').toEqual([]);
    await scrollTo(page, '#galleryCard');
    await settled(page);
    const p = await previews(page);
    expect(p['IMG_0001.HEIC']).toMatchObject({ state: 'loaded', w: 320, h: 240 });
    expect(p['IMG_0002.heic']).toMatchObject({ state: 'loaded', w: 320, h: 427 });
    expect(p['renamed.jpg']).toMatchObject({ state: 'loaded', w: 320, h: 427 });
    expect(p['normal.jpg']).toMatchObject({ state: 'loaded', w: 320, h: 240 });
    expect(RED(p['IMG_0001.HEIC'].topLeft)).toBe(true);
    expect(GREEN(p['IMG_0002.heic'].topLeft)).toBe(true);
    expect(heicRequests).toHaveLength(1);
    await expect(page.locator('.tile.converting')).toHaveCount(0);
  });

  test('opens a HEIC as a full-size JPG with both downloads', async ({ page }) => {
    await loadFiles(page, mixedExport());
    await scrollTo(page, '#galleryCard');
    await settled(page);

    await openInViewer(page, 'IMG_0001.HEIC');
    const size = await page.$eval('#viewer .viewer-stage img', (i) => [i.naturalWidth, i.naturalHeight]);
    expect(size).toEqual([1600, 1200]);
    const links = await viewerLinks(page);
    expect(links.map((l) => [l.text, l.download])).toEqual([['Download JPG', 'IMG_0001.jpg'], ['Download original', 'IMG_0001.HEIC']]);
    expect(links[0].head).toMatch(JPEG);
    expect(links[1].head).toMatch(HEIC);
    expect(links[1].size).toBe(FIXTURES.landscapeHeic().length);

    await openInViewer(page, 'renamed.jpg');
    expect(await page.$eval('#viewer .viewer-stage img', (i) => [i.naturalWidth, i.naturalHeight])).toEqual([1200, 1600]);
    expect((await viewerLinks(page)).map((l) => l.text)).toEqual(['Download JPG', 'Download original']);

    await openInViewer(page, 'normal.jpg');
    expect((await viewerLinks(page)).map((l) => l.text)).toEqual(['Download']);
  });

  test('shows the native formats first and spins on HEIC until converted', async ({ page }) => {
    // Hold heic-to back so the waiting state can be seen.
    await page.route(HEIC_TO_URL, async (route) => {
      await new Promise((r) => setTimeout(r, 2500));
      await route.fulfill({ path: HEIC_TO_PATH, contentType: 'text/javascript' });
    });
    const files = [];
    for (let i = 0; i < 8; i++) {
      files.push(i % 2 ? { name: `photo_${i}.jpg`, data: FIXTURES.landscapeJpg() } : { name: `IMG_${i}.HEIC`, data: FIXTURES.landscapeHeic() });
    }
    await loadFiles(page, takeoutWithAttachments(files));
    await scrollTo(page, '#galleryCard');
    await expect(page.locator('#galleryGrid .tile[title$=".jpg"].loaded')).toHaveCount(4, { timeout: 2000 });
    await expect(page.locator('#galleryGrid .tile[title$=".HEIC"].converting')).toHaveCount(4);
    await settled(page);
    await expect(page.locator('#galleryGrid .tile.loaded')).toHaveCount(8);
    await expect(page.locator('.tile.converting')).toHaveCount(0);
  });

  test('converts one HEIC at a time, thumbnails and viewer alike', async ({ page }) => {
    await page.addInitScript(() => {
      window.__events = [];
      let real;
      Object.defineProperty(window, 'HeicTo', {
        configurable: true,
        get: () => real,
        set: (fn) => {
          real = async (args) => {
            window.__events.push('decode-start');
            try { return await fn(args); } finally { window.__events.push('decode-end'); }
          };
        },
      });
      const toBlob = HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob = function (cb, ...rest) {
        const track = this.width > 1 && window.__trackEncodes;
        if (track) window.__events.push('encode-start');
        return toBlob.call(this, (b) => { if (track) window.__events.push('encode-end'); cb(b); }, ...rest);
      };
    });
    await page.route(HEIC_TO_URL, async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
      await route.fulfill({ path: HEIC_TO_PATH, contentType: 'text/javascript' });
    });
    const files = [];
    for (let i = 0; i < 6; i++) files.push({ name: `IMG_${i}.HEIC`, data: FIXTURES.landscapeHeic() });
    await loadFiles(page, takeoutWithAttachments(files));
    await scrollTo(page, '#galleryCard');
    await page.evaluate(() => { window.__trackEncodes = true; });
    await page.click('#galleryGrid .tile[title="IMG_0.HEIC"]'); // a full-size conversion joins the queue
    await settled(page);
    await page.waitForFunction(() => document.querySelector('#viewer .viewer-stage img:not(.viewer-preview)')?.naturalWidth);
    const events = await page.evaluate(() => window.__events);
    let open = 0;
    let most = 0;
    for (const e of events) {
      if (e === 'decode-start') most = Math.max(most, ++open);
      if (e === 'encode-end') open--;
    }
    expect(events.filter((e) => e === 'decode-start')).toHaveLength(7); // 6 previews + 1 full size
    expect(most, events.join(' ')).toBe(1);
  });
});

test.describe('HEIC attachments without heic-to', () => {
  test.use({ failOnConsoleError: false }); // the blocked script logs a load error

  test('falls back to the original file when heic-to cannot load', async ({ page }) => {
    await page.route(HEIC_TO_URL, (route) => route.abort());
    await loadFiles(page, mixedExport());
    await scrollTo(page, '#galleryCard');
    await settled(page);
    const p = await previews(page);
    expect(p['IMG_0001.HEIC'].state).toBe('no-preview');
    expect(p['renamed.jpg'].state).toBe('no-preview');
    expect(p['normal.jpg'].state).toBe('loaded');

    await openInViewer(page, 'IMG_0001.HEIC');
    await expect(page.locator('#viewer .viewer-file-note')).toHaveText('Couldn’t convert this HEIC photo.'.replace('’', "'"));
    const links = await viewerLinks(page);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ text: 'Download', download: 'IMG_0001.HEIC' });
    expect(links[0].head).toMatch(HEIC);
  });
});
