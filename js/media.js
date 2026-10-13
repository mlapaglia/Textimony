/*
 * Attachments: small previews in the message list and the Attachments panel, and a
 * full-size viewer.
 *
 * Memory: an attachment's full bytes are only read (from the export file it points
 * into, see att.z) to make a small JPEG preview, then dropped; previews live in a
 * capped LRU cache. Tiles show a preview only while near the screen and let it go
 * when they scroll away. Full content is loaded only in the viewer, one item at a
 * time, and released when the viewer moves on or closes.
 */

const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
  heic: 'image/heic', heif: 'image/heif', svg: 'image/svg+xml',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', '3gp': 'video/3gpp',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', amr: 'audio/amr',
  pdf: 'application/pdf',
};
const ATT_ICON = { ph: '📷', gf: '🎞️', vd: '🎬', au: '🎤', ot: '📎' };
const ATT_KINDS = [
  { key: 'all', label: 'All' },
  { key: 'ph', label: 'Photos' },
  { key: 'vd', label: 'Videos' },
  { key: 'gf', label: 'GIFs' },
  { key: 'au', label: 'Audio' },
  { key: 'ot', label: 'Files' },
];
const THUMB_WIDTH = 320;
const THUMB_CACHE_MAX = 300; // ~20 KB each
const THUMB_CONCURRENCY = 3;
const GALLERY_BATCH = 120;

let zipReader = null;

function mimeOf(name) {
  const dot = name.lastIndexOf('.');
  return MIME[dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''] || '';
}

function attType(a) {
  return (a.t && a.t !== 'application/octet-stream' ? a.t : '') || mimeOf(a.n) || mimeOf(a.p || '');
}

/** Whether the attachment's bytes are in a loaded export file. */
const attLoadable = (a) => a.z != null && !!S.archives[a.z];
const attKey = (a) => `${a.z}:${a.b ?? a.o}`;

/** The attachment's bytes: base64 inside an SMS backup (att.b/att.l) or an entry in a zip. */
async function attachmentBlob(a, type = attType(a)) {
  const file = S.archives[a.z];
  if (a.b != null) {
    const b64 = (await file.slice(a.b, a.b + a.l).text()).replace(/&#(?:10|13);|\s/g, '');
    const res = await fetch(`data:${type || 'application/octet-stream'};base64,${b64}`);
    return res.blob();
  }
  zipReader = zipReader || zipLib();
  return zipReader.readEntryBlob({ file, offset: a.o, csize: a.c, method: a.m, name: a.p }, type);
}

/** Who sent a message, for captions. */
function messageSender(m) {
  if (m.o) return 'You';
  if (m.k.startsWith('g:') && (m.sn || m.sk)) return senderLabel(m.sn || m.sk);
  return labelFor(m.k);
}

// ------------------------------------------------------------------ previews

const Thumbs = {
  cache: new Map(), // attKey -> object URL of a small JPEG (insertion order = LRU order)
  inflight: new Map(), // attKey -> Promise<url | null>
  failed: new Set(), // attKey of attachments that can't be previewed
  queue: [], // { a, resolve } waiting for a slot
  active: 0,
  wants: new Map(), // attKey -> number of tiles currently near the screen that want it

  want(a, d) {
    const key = attKey(a);
    const n = (this.wants.get(key) || 0) + d;
    if (n > 0) this.wants.set(key, n);
    else this.wants.delete(key);
  },

  /** A preview URL for the attachment, or null if it can't be previewed. */
  get(a) {
    const key = attKey(a);
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key); // refresh LRU position
      this.cache.set(key, hit);
      return Promise.resolve(hit);
    }
    if (this.failed.has(key)) return Promise.resolve(null);
    let p = this.inflight.get(key);
    if (!p) {
      p = new Promise((resolve) => this.queue.push({ a, resolve })).finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
      this.pump();
    }
    return p;
  },

  pump() {
    while (this.active < THUMB_CONCURRENCY && this.queue.length) {
      // Newest requests first: those are the tiles the user just scrolled to.
      const job = this.queue.pop();
      if (!this.wants.has(attKey(job.a))) { job.resolve(null); continue; } // scrolled away meanwhile
      this.active++;
      makeThumb(job.a)
        .catch(() => null)
        .then((url) => {
          const key = attKey(job.a);
          if (url) this.put(key, url);
          else this.failed.add(key);
          job.resolve(url);
        })
        .finally(() => {
          this.active--;
          this.pump();
        });
    }
  },

  put(key, url) {
    this.cache.set(key, url);
    while (this.cache.size > THUMB_CACHE_MAX) {
      const [oldKey, oldUrl] = this.cache.entries().next().value;
      this.cache.delete(oldKey);
      URL.revokeObjectURL(oldUrl); // tiles already showing it keep their decoded image
    }
  },

};

function canvasToUrl(canvas) {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b ? URL.createObjectURL(b) : null), 'image/jpeg', 0.8));
}

/** Small JPEG preview of an image (first frame for GIFs) or a frame of a video. */
async function makeThumb(a) {
  const type = attType(a);
  if (!type.startsWith('image/') && !type.startsWith('video/')) return null;
  const blob = await attachmentBlob(a, type);
  if (type.startsWith('image/')) {
    const bmp = await createImageBitmap(blob, { resizeWidth: THUMB_WIDTH, resizeQuality: 'medium' });
    const canvas = document.createElement('canvas');
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    canvas.getContext('2d').drawImage(bmp, 0, 0);
    bmp.close();
    return canvasToUrl(canvas);
  }
  return videoFrame(blob);
}

/** Grab a frame from early in a video; gives up after a few seconds. */
function videoFrame(blob) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const video = document.createElement('video');
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), 5000);
    video.muted = true;
    video.preload = 'auto';
    video.playsInline = true;
    video.onerror = () => finish(null);
    video.onloadeddata = () => { video.currentTime = Math.min(0.5, (video.duration || 1) / 2); };
    video.onseeked = async () => {
      const w = THUMB_WIDTH;
      const h = Math.round((w * video.videoHeight) / (video.videoWidth || 1)) || Math.round(w * 0.75);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(video, 0, 0, w, h);
      finish(await canvasToUrl(canvas));
    };
    video.src = url;
  });
}

// ------------------------------------------------------------------ tiles

/**
 * A preview tile: icon and name until it nears the screen, then the preview image.
 * `observer` (from tileObserver) loads and unloads it as it scrolls.
 */
function makeTile(a, cls, observer, onOpen) {
  const tile = document.createElement('button');
  tile.type = 'button';
  tile.className = `tile tile-${a.k} ${cls}`;
  tile.title = a.n;
  const icon = document.createElement('span');
  icon.className = 'tile-icon';
  icon.textContent = ATT_ICON[a.k] || '📎';
  const name = document.createElement('span');
  name.className = 'tile-name';
  name.textContent = a.n;
  tile.append(icon, name);
  if (a.k === 'vd') tile.insertAdjacentHTML('beforeend', '<span class="tile-badge">▶</span>');
  if (a.k === 'gf') tile.insertAdjacentHTML('beforeend', '<span class="tile-badge">GIF</span>');
  if (!attLoadable(a)) {
    tile.classList.add('missing');
    tile.title = `${a.n} (not in the loaded export)`;
    tile.disabled = true;
    return tile;
  }
  tile._att = a;
  tile.onclick = onOpen;
  observer.observe(tile);
  return tile;
}

/** Shows previews on tiles near the viewport of `root` and drops them when far away. */
function tileObserver(root) {
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const tile = e.target;
      const a = tile._att;
      if (e.isIntersecting) {
        if (!tile._wanted) Thumbs.want(a, 1);
        tile._wanted = true;
        Thumbs.get(a).then((url) => {
          if (!tile._wanted || !tile.isConnected) return;
          if (!url) { tile.classList.add('no-preview'); return; }
          let img = tile.querySelector('img');
          if (!img) {
            img = document.createElement('img');
            img.alt = '';
            img.decoding = 'async';
            tile.prepend(img);
          }
          img.src = url;
          tile.classList.add('loaded');
        });
      } else {
        if (tile._wanted) Thumbs.want(a, -1);
        tile._wanted = false;
        const img = tile.querySelector('img');
        if (img) img.remove(); // lets the browser free the decoded image
        tile.classList.remove('loaded');
      }
    }
  }, { root, rootMargin: '300px 0px' });
  return io;
}

// ------------------------------------------------------------------ viewer

const Viewer = {
  items: [], // [{ a, m }]
  index: 0,
  url: null,
  token: 0,

  open(items, index) {
    this.items = items;
    this.index = index;
    const dlg = $('#viewer');
    if (!dlg.open) dlg.showModal();
    this.show();
  },

  close() {
    const dlg = $('#viewer');
    if (dlg.open) dlg.close();
  },

  release() {
    const stage = $('#viewer .viewer-stage');
    for (const el of stage.querySelectorAll('video, audio')) { el.pause(); el.removeAttribute('src'); el.load(); }
    stage.replaceChildren();
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
  },

  step(d) {
    const i = this.index + d;
    if (i < 0 || i >= this.items.length) return;
    this.index = i;
    this.show();
  },

  async show() {
    const { a, m } = this.items[this.index];
    const token = ++this.token;
    this.release();
    const stage = $('#viewer .viewer-stage');
    stage.innerHTML = '<div class="viewer-loading">Loading…</div>';
    $('#viewer .prev').hidden = this.index === 0;
    $('#viewer .next').hidden = this.index >= this.items.length - 1;
    const when = new Date(m.t).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const caption = $('#viewer .viewer-caption');
    caption.textContent = `${a.n} · ${messageSender(m)} · ${when}${this.items.length > 1 ? ` · ${this.index + 1} of ${this.items.length}` : ''}`;

    const type = attType(a);
    let blob;
    try {
      blob = await attachmentBlob(a, type);
    } catch (err) {
      if (token === this.token) stage.innerHTML = '<div class="viewer-loading">Could not read this file from the export.</div>';
      return;
    }
    if (token !== this.token) return; // moved on while loading
    this.url = URL.createObjectURL(blob);
    const url = this.url;
    const download = () => {
      const box = document.createElement('div');
      box.className = 'viewer-file';
      box.innerHTML = `<div class="viewer-file-icon">${ATT_ICON[a.k] || '📎'}</div><div>${escapeHtml(a.n)} · ${fmtBytes(blob.size)}</div><div class="viewer-file-note">Your browser can't show this file type.</div>`;
      const link = document.createElement('a');
      link.className = 'btn small';
      link.href = url;
      link.download = a.n;
      link.textContent = 'Download';
      box.appendChild(link);
      stage.replaceChildren(box);
    };
    let el;
    if (type.startsWith('image/')) {
      el = new Image();
      el.alt = a.n;
    } else if (type.startsWith('video/')) {
      el = document.createElement('video');
      el.controls = true;
      el.autoplay = true;
      el.playsInline = true;
    } else if (type.startsWith('audio/')) {
      el = document.createElement('audio');
      el.controls = true;
      el.autoplay = true;
    } else {
      download();
      return;
    }
    el.onerror = download;
    el.src = url;
    stage.replaceChildren(el);
    const link = document.createElement('a');
    link.href = url;
    link.download = a.n;
    link.textContent = 'Download';
    caption.append(' · ', link);
  },
};

function initViewer() {
  const dlg = $('#viewer');
  dlg.addEventListener('close', () => Viewer.release());
  dlg.addEventListener('click', (e) => {
    // Clicks on the dimmed backdrop (the dialog itself) or the empty stage close it.
    if (e.target === dlg || e.target.classList.contains('viewer-stage')) Viewer.close();
  });
  dlg.querySelector('.prev').onclick = () => Viewer.step(-1);
  dlg.querySelector('.next').onclick = () => Viewer.step(1);
  dlg.querySelector('.viewer-close').onclick = () => Viewer.close();
  dlg.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') Viewer.step(-1);
    if (e.key === 'ArrowRight') Viewer.step(1);
  });
}

// ------------------------------------------------------------------ message list

let messageTiles = null; // tileObserver for the message list

/** Stop watching a set of tiles, releasing their claims on queued previews. */
function dropTiles(observer, root) {
  if (!observer) return;
  observer.disconnect();
  for (const tile of root.querySelectorAll('.tile')) {
    if (tile._wanted) Thumbs.want(tile._att, -1);
    tile._wanted = false;
  }
}

function resetMessageMedia(root) {
  dropTiles(messageTiles, root);
  messageTiles = tileObserver(root);
}

/** Preview tiles for one message's attachments; clicking opens them in the viewer. */
function messageAttachments(m) {
  const box = document.createElement('div');
  box.className = 'media-list';
  const items = m.att.filter(attLoadable).map((a) => ({ a, m }));
  for (const a of m.att) {
    box.appendChild(makeTile(a, 'tile-msg', messageTiles, () => Viewer.open(items, items.findIndex((x) => x.a === a))));
  }
  return box;
}

// ------------------------------------------------------------------ Attachments panel

const Gallery = { items: [], shown: 0, kind: 'all', observer: null, sentinel: null, more: null };

/** Attachments for the current selection, newest first, in the Attachments panel. */
function renderGallery(msgs) {
  const card = $('#galleryCard');
  const all = [];
  let unpreviewable = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.att) for (const a of m.att) all.push({ a, m });
    else unpreviewable += m.ph + m.gf + m.vd + m.au + m.ot;
  }
  card.hidden = !all.length && !unpreviewable;
  if (card.hidden) return;

  const counts = { all: all.length };
  for (const { a } of all) counts[a.k] = (counts[a.k] || 0) + 1;
  if (Gallery.kind !== 'all' && !counts[Gallery.kind]) Gallery.kind = 'all';
  $('#galleryKinds').innerHTML = ATT_KINDS
    .filter((k) => k.key === 'all' || counts[k.key])
    .map((k) => `<button data-kind="${k.key}" class="${k.key === Gallery.kind ? 'on' : ''}">${k.label} <span class="muted">${fmtNum(counts[k.key] || 0)}</span></button>`)
    .join('');

  Gallery.items = Gallery.kind === 'all' ? all : all.filter((x) => x.a.k === Gallery.kind);
  Gallery.shown = 0;
  $('#galleryCount').textContent = `${fmtNum(all.length)} attachment${all.length === 1 ? '' : 's'} in this selection, newest first. Click one to open it.`;
  $('#galleryNote').textContent = unpreviewable
    ? `${fmtNum(unpreviewable)} more from WhatsApp or iMessage exports can't be shown yet (those exports are only counted).`
    : '';

  const grid = $('#galleryGrid');
  dropTiles(Gallery.observer, grid);
  grid.replaceChildren();
  grid.scrollTop = 0;
  if (Gallery.more) Gallery.more.disconnect();
  Gallery.observer = tileObserver(grid);
  // Add tiles in batches as the end of the grid scrolls into view.
  Gallery.sentinel = document.createElement('div');
  Gallery.sentinel.className = 'gallery-sentinel';
  Gallery.more = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) appendGalleryBatch(); }, { root: grid, rootMargin: '600px 0px' });
  appendGalleryBatch();
  Gallery.more.observe(Gallery.sentinel);
}

function appendGalleryBatch() {
  const grid = $('#galleryGrid');
  const items = Gallery.items;
  const end = Math.min(items.length, Gallery.shown + GALLERY_BATCH);
  const frag = document.createDocumentFragment();
  for (let i = Gallery.shown; i < end; i++) {
    const { a } = items[i];
    const index = i;
    frag.appendChild(makeTile(a, 'tile-grid', Gallery.observer, () => {
      const openable = items.filter((x) => attLoadable(x.a));
      Viewer.open(openable, openable.indexOf(items[index]));
    }));
  }
  Gallery.shown = end;
  grid.appendChild(frag);
  grid.appendChild(Gallery.sentinel); // keep it last
  if (Gallery.shown >= items.length) Gallery.more.disconnect();
}

function initGallery() {
  $('#galleryKinds').onclick = (e) => {
    const b = e.target.closest('button[data-kind]');
    if (!b) return;
    Gallery.kind = b.dataset.kind;
    renderGallery(inRange(baseMessages()));
  };
}
