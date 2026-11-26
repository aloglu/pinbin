// Shared mobile sticky section picker (.secbar) used by Edit pages, Settings, and Bench.
import { esc, caret } from './state.js';

let spyObs = null;
let jumpLock = false;
let jumpTimer = null;

/**
 * Render the collapsible mobile section picker bar.
 * items: array of [key, label, optionalGroup]
 */
export function secBarHtml(kind, items, currentKey) {
  const valid = items.filter(([, label]) => Boolean(label));
  if (!valid.length) return '';
  const idx = Math.max(0, valid.findIndex(([k]) => k === currentKey));
  return `<div class="sbwrap"><div class="secbar" data-secbar="${esc(kind)}" style="--n:${valid.length}">
    <button type="button" class="sb-cur" data-sbtoggle aria-haspopup="menu" aria-expanded="false">
      <span class="sb-idx"><b>${idx + 1}</b>/${valid.length}</span>
      <span class="sb-t"><span>${esc(valid[idx][1])}</span></span>
      <span class="sb-chev">${caret}</span>
    </button>
    <div class="sb-rail" aria-hidden="true">${valid
      .map(([k], j) => `<i data-sbseg="${esc(k)}" class="${j === idx ? 'on' : j < idx ? 'past' : ''}"></i>`)
      .join('')}</div>
    <div class="sb-list" role="menu">${valid
      .map(
        ([k, label, group], j) =>
          `${group && (j === 0 || valid[j - 1][2] !== group) ? `<span class="sb-g">${esc(group)}</span>` : ''}` +
          `<button type="button" role="menuitemradio" aria-checked="${j === idx}" data-sbgo="${esc(k)}">` +
          `<span class="sb-num">${j + 1}</span><span class="sb-name">${esc(label)}</span><span class="sb-mk"></span></button>`
      )
      .join('')}</div>
  </div></div>`;
}

export function sbStick() {
  const w = document.querySelector('.sbwrap');
  if (!w) return;
  const bar = w.firstElementChild;
  const narrow = window.matchMedia('(max-width: 980px)').matches;
  const hdrEl = document.querySelector('.bar');
  const hdr = hdrEl ? hdrEl.getBoundingClientRect().bottom : 44;
  if (!narrow) {
    bar.classList.remove('stuck');
    bar.style.top = '';
    w.style.height = '';
    return;
  }
  if (!bar.classList.contains('stuck')) {
    w.style.height = `${bar.offsetHeight}px`;
  }
  const stick = w.getBoundingClientRect().top < hdr;
  bar.classList.toggle('stuck', stick);
  bar.style.top = stick ? `${hdr}px` : '';
}

export function sbOpen(open) {
  const bar = document.querySelector('.secbar');
  if (!bar) return;
  bar.classList.toggle('open', open);
  const toggle = bar.querySelector('[data-sbtoggle]');
  if (toggle) toggle.setAttribute('aria-expanded', String(open));
  if (open) {
    const cur = bar.querySelector('[aria-checked="true"]');
    if (cur) cur.focus({ preventScroll: true });
  }
}

export function sbSet(key) {
  const bar = document.querySelector('.secbar');
  if (!bar) return;
  const items = [...bar.querySelectorAll('[data-sbgo]')];
  const i = items.findIndex((b) => b.dataset.sbgo === key);
  if (i < 0) return;

  const titleBox = bar.querySelector('.sb-t');
  const name = items[i].querySelector('.sb-name').textContent;
  while (titleBox.children.length > 1) titleBox.firstElementChild.remove();
  const old = titleBox.lastElementChild;
  if (old && old.textContent !== name) {
    const prev = items.findIndex((b) => b.getAttribute('aria-checked') === 'true');
    const nu = document.createElement('span');
    nu.textContent = name;
    nu.className = i > prev ? 'in-up' : 'in-down';
    old.className = i > prev ? 'out-up' : 'out-down';
    titleBox.appendChild(nu);
    setTimeout(() => {
      if (old.parentNode) old.remove();
    }, 260);
  }
  const idxB = bar.querySelector('.sb-idx b');
  if (idxB) idxB.textContent = String(i + 1);
  items.forEach((b, j) => b.setAttribute('aria-checked', String(j === i)));
  bar.querySelectorAll('[data-sbseg]').forEach((seg, j) => {
    seg.className = j === i ? 'on' : j < i ? 'past' : '';
    seg.classList.toggle('chg', Boolean(items[j] && items[j].classList.contains('chg')));
  });
}

export function jumpToSection(key) {
  const el = document.getElementById(`e-${key}`);
  if (!el) return;
  sbSet(key);
  jumpLock = true;
  clearTimeout(jumpTimer);
  const unlock = () => { jumpLock = false; };
  jumpTimer = setTimeout(unlock, 900);
  window.addEventListener('scrollend', () => { clearTimeout(jumpTimer); unlock(); }, { once: true });
  const reduce =
    window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
    document.documentElement.classList.contains('reduce');
  el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
}

export function disconnectEditScrollSpy() {
  if (spyObs) {
    spyObs.disconnect();
    spyObs = null;
  }
}

export function initEditScrollSpy() {
  disconnectEditScrollSpy();
  if (!('IntersectionObserver' in window)) return;
  const links = [...document.querySelectorAll('.enav a')];
  if (!links.length) return;
  if (!links.some((a) => a.hasAttribute('aria-current')) && window.scrollY < 40) {
    links[0].setAttribute('aria-current', '');
  }
  spyObs = new IntersectionObserver(
    (entries) => {
      entries.forEach((en) => {
        if (en.isIntersecting) {
          links.forEach((a) => a.toggleAttribute('aria-current', a.dataset.jump === en.target.id));
          if (!jumpLock) sbSet(en.target.id.slice(2));
        }
      });
    },
    { rootMargin: '-35% 0px -60% 0px' }
  );
  document.querySelectorAll('.esec').forEach((sec) => spyObs.observe(sec));
}

window.addEventListener('scroll', sbStick, { passive: true });
window.addEventListener('resize', sbStick);
