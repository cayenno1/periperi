// Footer year
document.getElementById('year').textContent = new Date().getFullYear();

/* ============================================================
   GRAPHIC ART — list your file names here (files live in /graphicArt)
   Example: const GRAPHIC_ART = ['dragon.png', 'moon-girl.jpg'];
   Leave it empty to auto-find graphic1.png, graphic2.jpg, ...
   ============================================================ */
const GRAPHIC_ART = [];

/* ---------- image helpers ---------- */
const EXTS = ['png', 'jpg', 'jpeg', 'webp'];
const SEPS = ['', '-', '_'];

const probe = (src) => new Promise((res) => {
  const i = new Image();
  i.onload = () => res(src);
  i.onerror = () => res(null);
  i.src = src;
});

async function findImage(dir, base, n) {
  const tries = [];
  SEPS.forEach((s) => EXTS.forEach((e) => tries.push(`${dir}/${base}${s}${n}.${e}`)));
  const found = await Promise.all(tries.map(probe));
  return found.find(Boolean) || null;
}

async function discover(dir, base, max = 30) {
  const out = [];
  for (let n = 1; n <= max; n++) {
    const f = await findImage(dir, base, n);
    if (!f) break;
    out.push(f);
  }
  return out;
}

function makeImg(src, alt) {
  const img = document.createElement('img');
  img.src = src;
  img.alt = alt;
  img.loading = 'lazy';
  img.dataset.full = src;
  return img;
}

/* ---------- UI/UX projects: auto-load donut1.. / plant1.. ---------- */
document.querySelectorAll('.uiux-project').forEach(async (proj) => {
  const { dir, base } = proj.dataset;
  const box = proj.querySelector('.screens');
  const files = await discover(dir, base);
  if (!files.length) return;
  box.innerHTML = '';
  const title = proj.querySelector('h3').textContent;
  files.forEach((f, i) => box.appendChild(makeImg(f, `${title} — screen ${i + 1}`)));
});

/* ---------- Graphic art ---------- */
(async function loadGallery() {
  const gallery = document.getElementById('gallery');
  let files = GRAPHIC_ART.map((f) => `graphicArt/${f}`);
  if (!files.length) files = await discover('graphicArt', 'graphic');
  if (!files.length) return;
  gallery.innerHTML = '';
  files.forEach((f, i) => gallery.appendChild(makeImg(encodeURI(f), `Illustration ${i + 1}`)));
})();

/* ---------- Scroll reveal ---------- */
const io = new IntersectionObserver((entries) => {
  entries.forEach((e) => {
    if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
  });
}, { threshold: 0.12 });
document.querySelectorAll('.reveal').forEach((el, i) => {
  el.style.transitionDelay = `${(i % 4) * 70}ms`;
  io.observe(el);
});

/* ---------- Active nav link ---------- */
const links = document.querySelectorAll('.nav-links a');
const sections = [...links].map((a) => document.querySelector(a.getAttribute('href')));
const spy = new IntersectionObserver((entries) => {
  entries.forEach((e) => {
    if (e.isIntersecting) {
      links.forEach((a) => a.classList.toggle('active', a.getAttribute('href') === `#${e.target.id}`));
    }
  });
}, { rootMargin: '-45% 0px -50% 0px' });
sections.forEach((s) => s && spy.observe(s));

/* ---------- Lightbox (UI/UX screens + graphic art) ---------- */
const lb = document.getElementById('lightbox');
const lbImg = document.getElementById('lb-img');
document.addEventListener('click', (e) => {
  const img = e.target.closest('.screens img, .masonry img');
  if (!img) return;
  lbImg.src = img.dataset.full;
  lbImg.alt = img.alt;
  lb.hidden = false;
});
lb.addEventListener('click', () => { lb.hidden = true; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') lb.hidden = true; });

/* ---------- Copy buttons ---------- */
const toast = document.getElementById('toast');
document.querySelectorAll('[data-copy]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(btn.dataset.copy);
      toast.textContent = 'Copied!';
    } catch {
      toast.textContent = 'Copy failed — select it manually';
    }
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 1800);
  });
});
