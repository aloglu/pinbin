// Full 7-section Settings screen backed by live SQLite & MCP runtime APIs.
import { api } from '../api.js';
import {
  state,
  SORTS,
  esc,
  menuHtml,
  currencyLabel,
  storeDisplayName,
  ago,
  toast,
} from '../state.js';
import { secBarHtml } from '../secbar.js';

export const SETTINGS_SECTIONS = [
  ['appearance', 'Appearance'],
  ['inventory', 'Inventory'],
  ['shopping', 'Shopping'],
  ['assistant', 'Assistant'],
  ['guest', 'Guest pass'],
  ['checks', 'Safety checks'],
  ['data', 'Data and backup'],
  ['about', 'About'],
];

const CURRENCIES = [
  ['TRY', 'Turkish lira (TL)'],
  ['EUR', 'Euro (€)'],
  ['USD', 'US dollar ($)'],
];

const srow = (title, desc, control, extra = '') =>
  `<div class="srow ${extra}"><div class="sl"><b>${esc(title)}</b>${desc ? `<span>${desc}</span>` : ''}</div><div class="sc">${control}</div></div>`;

const swBtn = (attr, val, label) =>
  `<button type="button" class="switch" role="switch" aria-checked="${Boolean(val)}" aria-label="${esc(label)}" ${attr}><i></i></button>`;

function fmtBytes(b) {
  const n = Number(b) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtWhen(iso) {
  if (!iso) return 'never';
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return iso;
  const diffMin = Math.floor((Date.now() - ts) / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? '' : 's'} ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hour${diffHr === 1 ? '' : 's'} ago`;
  return new Date(ts).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export async function loadSettingsExtras(renderFn) {
  if (state.set.loading) return;
  state.set.loading = true;
  try {
    const [stats, mcp, guest] = await Promise.all([api.getStats(), api.getMcpSettings(), api.getGuestPass()]);
    state.set.stats = stats;
    state.set.mcp = mcp;
    state.set.guest = guest;
    state.set.loaded = true;
    renderFn();
  } catch (err) {
    toast(err.message);
  } finally {
    state.set.loading = false;
  }
}

export function renderSettingsView() {
  const ui = state.config.ui_settings || {};
  const set = state.set;
  const sec = set.sec || 'appearance';
  const curIdx = SETTINGS_SECTIONS.findIndex(([k]) => k === sec);
  const nextSec = SETTINGS_SECTIONS[curIdx + 1] || null;
  const cur = currencyLabel();

  const th = ui.theme || 'system';
  const font = ui.font || 'plex';
  const motion = ui.motion || 'system';

  // Group parts by bin for Inventory → Bins table
  const binMap = new Map();
  for (const p of state.parts || []) {
    const k = (p.location || '').trim();
    if (!binMap.has(k)) binMap.set(k, []);
    binMap.get(k).push(p);
  }
  const bins = [...binMap.entries()].sort((a, b) => {
    if (!a[0]) return 1;
    if (!b[0]) return -1;
    return a[0].localeCompare(b[0], undefined, { numeric: true });
  });
  const namedBinCount = bins.filter(([b]) => b).length;
  const noBinCount = (binMap.get('') || []).length;

  // Build Stores table from retailers + shopping items
  const storeDomains = [
    ...new Set([
      ...(state.retailers || []).map((r) => (r.domain || '').toLowerCase()).filter(Boolean),
      ...(state.shopping || [])
        .map((it) => {
          const off = (it.offers || []).find((o) => o.is_selected) || (it.offers || [])[0];
          return ((off && off.retailer) || it.retailer || '').trim().toLowerCase();
        })
        .filter(Boolean),
    ]),
  ].sort();

  const confirmBox = (id, htmlText, btnLabel, extra = '') =>
    set.confirm === id
      ? `<div class="confirm"><p>${htmlText}</p>${extra}<div class="acts"><button class="btn" type="button" data-confirm-cancel>Cancel</button><button class="btn dangerbtn" type="button" data-confirm-do="${esc(
          id
        )}" ${id === 'wipe' && (set.wipeText || '') !== 'delete' ? 'disabled' : ''}>${esc(btnLabel)}</button></div></div>`
      : '';

  const mcp = set.mcp || {
    enabled: false,
    access: 'rw',
    can_parts: true,
    can_projects: true,
    can_shopping: true,
    can_delete: false,
    token: '',
    last_request_at: '',
    weekly_requests: 0,
    activity: [],
  };
  const mcpUrl = `${location.origin}/mcp`;
  const stats = set.stats || {
    parts_count: state.parts.length,
    projects_count: state.projects.length,
    shopping_count: state.shopping.length,
    images_count: 0,
    images_bytes: 0,
  };

  const guestCfg = set.guest || {
    enabled: false,
    token: '',
    created_at: '',
    last_used_at: '',
    path: '',
  };
  const guestUrl = guestCfg.token ? `${location.origin}/guest/pass/${guestCfg.token}` : '';
  const maskedGuestUrl = guestCfg.token ? `${location.origin}/guest/pass/••••••••••••••••••••` : '';

  const curCurrencyPair = CURRENCIES.find(([c]) => c === (ui.currency || 'TRY')) || CURRENCIES[0];

  const blocks = {
    appearance: `<section class="sgroup" id="s-appearance">
      <h2>Appearance</h2>
      ${srow(
        'Theme',
        'Follow your device, or pick one.',
        `<div class="tabs" role="group">${[
          ['system', 'System'],
          ['light', 'Light'],
          ['dark', 'Dark'],
        ]
          .map(([v, l]) => `<button type="button" data-ui-set="theme|${v}" aria-pressed="${th === v}">${l}</button>`)
          .join('')}</div>`
      )}
      ${srow(
        'Typeface',
        'IBM Plex is sturdier at small sizes. Instrument Sans is the earlier look.',
        `<div class="tabs" role="group">${[
          ['plex', 'IBM Plex'],
          ['instrument', 'Instrument Sans'],
        ]
          .map(([v, l]) => `<button type="button" data-ui-set="font|${v}" aria-pressed="${font === v}">${l}</button>`)
          .join('')}</div>`
      )}
      ${srow(
        'Motion',
        'Panels sliding, map focus transitions, numbers updating. Reduced keeps changes instant.',
        `<div class="tabs" role="group">${[
          ['system', 'Follow device'],
          ['full', 'Full'],
          ['reduced', 'Reduced'],
        ]
          .map(([v, l]) => `<button type="button" data-ui-set="motion|${v}" aria-pressed="${motion === v}">${l}</button>`)
          .join('')}</div>`
      )}
    </section>`,

    inventory: `<section class="sgroup" id="s-inventory">
      <h2>Inventory</h2>
      ${srow(
        'Default view',
        '',
        `<div class="tabs" role="group">
          <button type="button" data-ui-set="view_mode|grid" aria-pressed="${(ui.view_mode || 'grid') === 'grid'}">Grid</button>
          <button type="button" data-ui-set="view_mode|list" aria-pressed="${ui.view_mode === 'list'}">List</button>
        </div>`
      )}
      ${srow(
        'Default sort',
        '',
        menuHtml(
          'defsort',
          '',
          (SORTS.find(([k]) => k === (state.inv.sort || 'recent')) || SORTS[0])[1],
          SORTS.map(([k, t]) => [k, t, (state.inv.sort || 'recent') === k])
        )
      )}
      ${srow(
        'Warning marks on cards',
        'Show a part’s red ! or yellow ? on its card when a project has an open warning about it.',
        swBtn('data-ui-tog="show_caution_badge"', ui.show_caution_badge !== false, 'Warning marks on cards')
      )}
      <div class="ssub">
        <div class="sl">
          <b>Bins</b>
          <span>Rename a bin and every part in it follows. ${namedBinCount} bin${namedBinCount === 1 ? '' : 's'}, ${noBinCount} part${
      noBinCount === 1 ? '' : 's'
    } without one.</span>
        </div>
        <div class="bintable">${bins
          .map(
            ([b, ps]) =>
              `<div class="binrow">
                <span class="bin ${b ? '' : 'none'}">${esc(b || 'No bin')}</span>
                <span class="dim">${ps
                  .map((p) => esc(p.name.split(' (')[0]))
                  .slice(0, 3)
                  .join(', ')}${ps.length > 3 ? ` +${ps.length - 3}` : ''}</span>
                <span class="mono">${ps.length}</span>
                ${
                  b
                    ? set.renaming === b
                      ? `<form class="ren" data-renform="${esc(b)}"><input name="v" value="${esc(
                          b
                        )}" aria-label="New name for bin ${esc(b)}" maxlength="16" autocomplete="off"><button class="btn" type="submit">Save</button></form>`
                      : `<button class="btn quiet" type="button" data-rename-bin="${esc(b)}">Rename</button>`
                    : '<span></span>'
                }
              </div>`
          )
          .join('')}</div>
      </div>
    </section>`,

    shopping: `<section class="sgroup" id="s-shopping">
      <h2>Shopping</h2>
      ${srow(
        'Currency',
        'Shown on totals and price fields.',
        menuHtml(
          'cur',
          '',
          curCurrencyPair[1],
          CURRENCIES.map(([k, t]) => [k, t, curCurrencyPair[0] === k])
        )
      )}
      <div class="ssub">
        <div class="sl">
          <b>Stores</b>
          <span>Shipping costs let Pinbin show how close you are to free shipping and optimize orders.</span>
        </div>
        ${
          storeDomains.length
            ? `<div class="storetable">
                <div class="sth"><span>Store</span><span>Shipping</span><span>Free over</span><span>Items</span></div>
                ${storeDomains
                  .map((dom) => {
                    const rm = (state.retailers || []).find((r) => (r.domain || '').toLowerCase() === dom) || {};
                    const count = (state.shopping || []).filter((it) => {
                      const off = (it.offers || []).find((o) => o.is_selected) || (it.offers || [])[0];
                      return (((off && off.retailer) || it.retailer || '').trim().toLowerCase()) === dom;
                    }).length;
                    return `<div class="str">
                      <span><b>${esc(storeDisplayName(dom))}</b></span>
                      <span class="inu"><input type="number" inputmode="decimal" step="any" value="${
                        rm.shipping_cost ?? ''
                      }" placeholder="0" data-ship="${esc(dom)}|shipping_cost" aria-label="${esc(dom)} shipping cost"><em>${esc(cur)}</em></span>
                      <span class="inu"><input type="number" inputmode="decimal" step="any" value="${
                        rm.free_shipping_threshold ?? ''
                      }" placeholder="0" data-ship="${esc(dom)}|free_shipping_threshold" aria-label="${esc(
                      dom
                    )} free shipping over"><em>${esc(cur)}</em></span>
                      <span class="mono">${count}</span>
                    </div>`;
                  })
                  .join('')}
              </div>`
            : '<p class="faint" style="margin-top:8px">Stores appear here automatically once you add items to Shopping.</p>'
        }
      </div>
    </section>`,

    assistant: `<section class="sgroup" id="s-assistant">
      <h2>Assistant</h2>
      <div class="statusline">
        <span class="status"><i style="background:${mcp.enabled ? 'var(--ok)' : 'var(--ink-3)'}"></i>${
          mcp.enabled ? 'Connected' : 'Disabled on server'
        }</span>
        <span class="dim">${
          mcp.last_request_at ? `Last request ${fmtWhen(mcp.last_request_at)}` : 'No assistant requests yet'
        } · ${mcp.weekly_requests || 0} request${mcp.weekly_requests === 1 ? '' : 's'} this week</span>
      </div>
      ${srow(
        'Server address',
        'Paste this into your assistant’s MCP settings.',
        `<span class="copyfield"><code>${esc(mcpUrl)}</code><button class="btn" type="button" data-copy="${esc(
          mcpUrl
        )}">Copy</button></span>`
      )}
      ${srow(
        'Access',
        'Read only lets the assistant look and plan, but not change anything.',
        `<div class="tabs" role="group">
          <button type="button" data-mcp-set="access|rw" aria-pressed="${mcp.access !== 'ro'}">Read and write</button>
          <button type="button" data-mcp-set="access|ro" aria-pressed="${mcp.access === 'ro'}">Read only</button>
        </div>`
      )}
      ${srow(
        'Access token',
        'A second lock on top of Cloudflare Access.',
        `<span class="copyfield"><code>${
          mcp.token
            ? set.tokenShown
              ? esc(mcp.token)
              : '••••••••••••••••••••••'
            : 'No token set'
        }</code>${
          mcp.token
            ? `<button class="btn" type="button" data-tok-tog>${set.tokenShown ? 'Hide' : 'Show'}</button>
               <button class="btn" type="button" data-copy="${esc(mcp.token)}">Copy</button>`
            : ''
        }<button class="btn" type="button" data-confirm="token">New token</button></span>`
      )}
      ${confirmBox(
        'token',
        'Your assistant stops working until you paste the new token into its settings. The old token stops working at once.',
        'Make a new token'
      )}
      <div class="ssub">
        <div class="sl">
          <b>The assistant can</b>
          <span>${
            mcp.access === 'ro'
              ? 'Read only is on, so these are paused.'
              : 'Turn off anything you would rather do yourself.'
          }</span>
        </div>
        <div class="perm ${mcp.access === 'ro' ? 'off' : ''}">
          ${[
            ['can_parts', 'Add and edit parts', 'Names, photos and pinout images from store pages, voltages, pins, care notes'],
            ['can_projects', 'Plan projects', 'Parts lists, wiring, checks and notes'],
            ['can_shopping', 'Manage shopping', 'Find stores, compare prices, add items'],
            ['can_delete', 'Delete things', 'Parts, projects and shopping items. Off is safer.'],
          ]
            .map(
              ([k, t, d]) =>
                `<div class="prm"><div><b>${esc(t)}</b><span>${esc(d)}</span></div>${swBtn(
                  `data-mcp-tog="${k}"`,
                  mcp[k],
                  t
                )}</div>`
            )
            .join('')}
        </div>
      </div>
      <div class="ssub">
        <div class="sl">
          <b>Recent changes by the assistant</b>
          <span>Everything it changed, newest first.</span>
        </div>
        <div class="acty">${
          (mcp.activity || []).length
            ? mcp.activity
                .slice(0, 12)
                .map(
                  (a) =>
                    `<div class="act"><span class="dot"></span><div><b>${esc(a.summary || a.tool_name)}</b><span class="faint">${esc(
                      a.scope || 'Assistant'
                    )} · ${esc(fmtWhen(a.created_at))}</span></div></div>`
                )
                .join('')
            : '<p class="faint" style="padding:8px 0">No changes logged by your assistant yet.</p>'
        }</div>
      </div>
    </section>`,

    guest: `<section class="sgroup" id="s-guest">
      <h2>Guest pass</h2>
      <div class="statusline">
        <span class="status"><i style="background:${guestCfg.enabled ? 'var(--ok)' : 'var(--ink-3)'}"></i>${
          guestCfg.enabled ? 'Active' : 'Off'
        }</span>
        <span class="dim">${
          guestCfg.last_used_at ? `Last opened ${fmtWhen(guestCfg.last_used_at)}` : 'Not opened yet'
        }${guestCfg.created_at ? ` · Link created ${ago(guestCfg.created_at) || fmtWhen(guestCfg.created_at)}` : ''}</span>
      </div>
      ${srow(
        'Allow read-only guest access',
        'People with the link can browse Inventory, Projects, Shopping, Glossary and Bench. All editing, Settings, backups and assistant controls are blocked on the server.',
        swBtn('data-guest-tog', guestCfg.enabled, 'Allow read-only guest access')
      )}
      ${
        guestCfg.enabled && guestUrl
          ? `<div class="ssub">
              <div class="sl">
                <b>Guest link</b>
                <span>Anyone with this link can view your workbench in read-only mode.</span>
              </div>
              <div class="guest-link-box">
                <code>${set.guestLinkShown ? esc(guestUrl) : esc(maskedGuestUrl)}</code>
                <div class="guest-link-acts">
                  <button class="btn" type="button" data-guest-link-tog>${set.guestLinkShown ? 'Hide' : 'Show'}</button>
                  <button class="btn" type="button" data-copy="${esc(guestUrl)}">Copy</button>
                  <a class="btn" href="${esc(guestUrl)}" target="_blank" rel="noopener">Preview</a>
                  <button class="btn" type="button" data-confirm="guest-rotate">New link</button>
                </div>
              </div>
              ${confirmBox(
                'guest-rotate',
                'The old link stops working immediately and any open guest sessions are signed out.',
                'Make a new link'
              )}
            </div>`
          : ''
      }
      <p class="faint snote">${
        state.config.local_dev_mode
          ? 'In production behind Cloudflare Access, add one Bypass rule for <code>/guest/*</code> on this domain so guests can open the link without a Cloudflare login. Everything outside <code>/guest/*</code> stays locked.'
          : 'Cloudflare Access setup: add one Bypass policy for <code>' +
            esc(location.host) +
            '/guest/*</code>. Guests only ever reach <code>/guest/*</code>, while your main app stays locked behind Cloudflare Access.'
      }</p>
    </section>`,

    checks: `<section class="sgroup" id="s-checks">
      <h2>Safety checks</h2>
      ${srow(
        'Show “works together” checks',
        'The green ✓ marks that confirm parts are compatible. Turn off to see only problems.',
        swBtn('data-ui-tog="show_ok_checks"', ui.show_ok_checks !== false, 'Show works together checks')
      )}
      ${srow(
        'Strapping pin checks',
        'Warns when a wire uses a pin the board reads at start-up. Usually harmless, so some people find it noisy.',
        swBtn('data-ui-tog="strap_pin_checks"', ui.strap_pin_checks !== false, 'Strapping pin checks')
      )}
      ${srow(
        'Explain words in text',
        'Underline glossary words in warnings and notes. Tap one for a plain explanation.',
        swBtn('data-ui-tog="inline_tooltips"', ui.inline_tooltips !== false, 'Explain words in text')
      )}
      <p class="faint snote">Dangerous problems, like 5 V into a 3.3 V pin, are always shown.</p>
    </section>`,

    data: `<section class="sgroup" id="s-data">
      <h2>Data and backup</h2>
      <div class="storage">
        <div><b class="num">${stats.parts_count}</b><span>parts</span></div>
        <div><b class="num">${stats.projects_count}</b><span>projects</span></div>
        <div><b class="num">${stats.shopping_count}</b><span>to buy</span></div>
        <div><b class="num">${stats.images_count}</b><span>photos · ${fmtBytes(stats.images_bytes)}</span></div>
      </div>
      ${srow(
        'Back up',
        `Everything, photos included, in one .zip file. Last backup: ${
          ui.last_backup_at ? esc(ago(ui.last_backup_at) || fmtWhen(ui.last_backup_at)) : 'never'
        }.`,
        `<a class="btn ink" href="/api/backup" download data-backup-dl>Download backup</a>`
      )}
      ${srow(
        'Restore',
        'Replace everything with a backup file.',
        `<button class="btn" type="button" data-confirm="restore">Choose a backup…</button>`
      )}
      ${confirmBox(
        'restore',
        'Restoring replaces all your parts, projects, shopping items and photos with what is in the file. Pinbin makes a backup of the current state first, so you can go back.',
        'Choose file and restore'
      )}
      <input type="file" id="restoreZipInput" accept=".zip,application/zip" hidden>
      ${srow(
        'Spreadsheet',
        'Parts only, as CSV. Good for editing many parts at once.',
        `<span class="copyfield">
          <a class="btn" href="/api/export/csv" download>Export CSV</a>
          <label class="btn" style="cursor:pointer">Import CSV…<input type="file" id="importCsvInput" accept=".csv,text/csv" hidden></label>
        </span>`
      )}
      <div class="dzone">
        <div class="sl">
          <b>Delete everything</b>
          <span>Removes all parts, projects, shopping items and photos. This cannot be undone. Make a backup first.</span>
        </div>
        <button class="btn dangerout" type="button" data-confirm="wipe">Delete everything…</button>
      </div>
      ${confirmBox(
        'wipe',
        'Type <b>delete</b> to confirm.',
        'Delete everything',
        `<input class="wipein" id="wipeIn" value="${esc(set.wipeText || '')}" autocomplete="off" aria-label="Type delete to confirm">`
      )}
    </section>`,

    about: `<section class="sgroup" id="s-about">
      <h2>About</h2>
      ${srow('Version', '', '<span class="mono">Pinbin 2.0</span>')}
      ${srow(
        'Protected by',
        state.config.local_dev_mode
          ? 'Running in local development mode without Cloudflare Access.'
          : 'Only people allowed by your Cloudflare Access policy can open Pinbin.',
        `<span class="status"><i style="background:${
          state.config.local_dev_mode ? 'var(--check)' : 'var(--ok)'
        }"></i>${state.config.local_dev_mode ? 'Local dev mode' : 'Cloudflare Access'}</span>`
      )}
      ${srow('Source', '', '<span class="mono">github.com/aloglu/pinbin</span>')}
    </section>`,
  };

  const nav = `<nav class="setnav" aria-label="Settings sections">${SETTINGS_SECTIONS.map(
    ([k, label]) =>
      `<a href="/settings" data-setsec="${esc(k)}" ${k === sec ? 'aria-current="true"' : ''}>${esc(label)}</a>`
  ).join('')}</nav>`;

  return `<div class="screen full"><div class="work">
    <div class="pagehead">
      <div class="ph-title">
        <h1>Settings</h1>
        <span class="sub">Changes save as you make them</span>
      </div>
    </div>
    ${secBarHtml('set', SETTINGS_SECTIONS, sec)}
    <div class="setgrid">
      ${nav}
      <div class="setbody">
        ${blocks[sec] || blocks.appearance}
        ${
          nextSec
            ? `<button type="button" class="setnext" data-setsec="${esc(nextSec[0])}"><span>Next</span><b>${esc(
                nextSec[1]
              )}</b><span aria-hidden="true">→</span></button>`
            : ''
        }
      </div>
    </div>
  </div></div>`;
}

/* =========================================================== Settings Actions */
export async function renameBinWithUndo(oldBin, newBin, renderFn) {
  const clean = String(newBin || '').trim().toUpperCase();
  state.set.renaming = null;
  if (!clean || clean === oldBin) {
    renderFn();
    return;
  }
  try {
    await api.renameBin(oldBin, clean);
    state.parts = await api.listParts();
    renderFn();
    toast(`Bin ${oldBin} renamed to ${clean}`, async () => {
      try {
        await api.renameBin(clean, oldBin);
        state.parts = await api.listParts();
        renderFn();
        toast(`Restored bin ${oldBin}`);
      } catch (err) {
        toast(err.message);
      }
    });
  } catch (err) {
    renderFn();
    toast(err.message);
  }
}

export async function saveRetailerShipping(domain, field, rawVal, renderFn) {
  const existing = (state.retailers || []).find((r) => (r.domain || '').toLowerCase() === domain) || {};
  const val = rawVal === '' ? null : Number(rawVal);
  if (val !== null && (!Number.isFinite(val) || val < 0)) return;
  const payload = {
    display_name: existing.display_name || storeDisplayName(domain),
    shipping_cost: field === 'shipping_cost' ? val : existing.shipping_cost ?? null,
    free_shipping_threshold:
      field === 'free_shipping_threshold' ? val : existing.free_shipping_threshold ?? null,
    currency: existing.currency || currencyLabel(),
  };
  try {
    await api.upsertRetailer(domain, payload);
    state.retailers = await api.listRetailers();
    toast(`Saved ${payload.display_name} shipping`);
    renderFn();
  } catch (err) {
    toast(err.message);
  }
}

export async function patchMcpSetting(patch, renderFn) {
  try {
    const updated = await api.patchMcpSettings(patch);
    state.set.mcp = updated;
    renderFn();
  } catch (err) {
    toast(err.message);
  }
}

export async function rotateMcpTokenNow(renderFn) {
  try {
    const updated = await api.rotateMcpToken();
    state.set.mcp = updated;
    state.set.tokenShown = true;
    state.set.confirm = null;
    renderFn();
    toast('New access token created');
  } catch (err) {
    toast(err.message);
  }
}

export async function toggleGuestPassNow(renderFn) {
  const curEnabled = Boolean(state.set.guest && state.set.guest.enabled);
  try {
    const updated = await api.patchGuestPass({ enabled: !curEnabled });
    state.set.guest = updated;
    state.set.confirm = null;
    if (updated.enabled) state.set.guestLinkShown = true;
    renderFn();
    toast(updated.enabled ? 'Guest pass enabled' : 'Guest pass turned off — guest sessions revoked');
  } catch (err) {
    toast(err.message);
  }
}

export async function rotateGuestPassNow(renderFn) {
  try {
    const updated = await api.rotateGuestPass();
    state.set.guest = updated;
    state.set.guestLinkShown = true;
    state.set.confirm = null;
    renderFn();
    toast('New guest link created — old links revoked');
  } catch (err) {
    toast(err.message);
  }
}

export async function uploadRestoreZip(file, reloadAllFn) {
  const fd = new FormData();
  fd.append('file', file);
  try {
    const res = await fetch('/api/restore', { method: 'POST', body: fd });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `Restore failed (${res.status})`);
    }
    state.set.confirm = null;
    await reloadAllFn();
    toast('Backup restored');
  } catch (err) {
    toast(err.message);
  }
}

export async function uploadImportCsv(file, reloadAllFn) {
  const fd = new FormData();
  fd.append('file', file);
  try {
    const res = await fetch('/api/import/csv', { method: 'POST', body: fd });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `CSV import failed (${res.status})`);
    }
    const data = await res.json().catch(() => ({}));
    await reloadAllFn();
    toast(`Imported ${data.imported ?? data.created ?? 'CSV'} parts`);
  } catch (err) {
    toast(err.message);
  }
}

export async function wipeEverythingNow(reloadAllFn) {
  try {
    await api.wipeAllData('delete');
    state.set.confirm = null;
    state.set.wipeText = '';
    await reloadAllFn();
    toast('All data deleted');
  } catch (err) {
    toast(err.message);
  }
}
