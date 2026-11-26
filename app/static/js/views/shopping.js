// Shopping screen: one section per store, status progression, Store consolidation helper, Move to inventory.
import { api } from '../api.js';
import {
  state,
  esc,
  phPart,
  stepHtml,
  parsePriceNumber,
  money,
  currencyLabel,
  storeDisplayName,
  toast,
  isGuest,
  appHref,
} from '../state.js';
import { renderShoppingInspector } from '../inspectors.js';

function selectedOfferOf(it) {
  const offers = it.offers || [];
  return offers.find((o) => o.is_selected) || offers[0] || null;
}

function storeKeyOf(it) {
  const off = selectedOfferOf(it);
  const raw = (off && off.retailer) || it.retailer || '';
  return raw.trim().toLowerCase() || '__other__';
}

function unitPriceOf(it) {
  const off = selectedOfferOf(it);
  return parsePriceNumber((off && off.price) || it.price || '');
}

function retailerMeta(storeKey) {
  return (state.retailers || []).find((r) => (r.domain || '').toLowerCase() === storeKey) || null;
}

function renderOptimizerPanel() {
  const opt = state.shopOpt;
  if (!opt || !opt.open) return '';
  const cur = currencyLabel();

  let body = '';
  if (opt.loading) {
    body = '<p class="faint">Checking store combinations…</p>';
  } else if (opt.error) {
    body = `<p class="dim">${esc(opt.error)}</p>`;
  } else if (opt.result) {
    const res = opt.result;
    const curCart = res.current || {};
    const recCart = res.recommended || curCart;
    const changes = res.changes || [];
    const sumCarts = (plan) => {
      if (plan.total != null) return plan.total;
      const carts = plan.carts || [];
      if (!carts.length) return null;
      return carts.reduce((acc, c) => acc + (Number(c.total) || Number(c.subtotal) || 0), 0);
    };
    const curSum = sumCarts(curCart);
    const recSum = sumCarts(recCart);
    const curTotal = curSum != null ? `${money(curSum)} ${cur}` : '—';
    const recTotal = recSum != null ? `${money(recSum)} ${cur}` : '—';

    body = `<div class="opt-summary">
        <span><span class="k">Now</span> <b>${curCart.store_count ?? 0} store${curCart.store_count === 1 ? '' : 's'}</b> · <span class="num">${esc(curTotal)}</span></span>
        <span>→</span>
        <span><span class="k">Suggested</span> <b>${recCart.store_count ?? 0} store${recCart.store_count === 1 ? '' : 's'}</b> · <span class="num">${esc(recTotal)}</span></span>
      </div>
      ${
        changes.length
          ? `<div class="opt-changes">${changes
              .map(
                (c) =>
                  `<div class="opt-change"><span><b>${esc(c.name)}</b></span><span class="dim">${esc(
                    storeDisplayName(c.from_retailer || '—')
                  )} → <b>${esc(storeDisplayName(c.to_retailer || '—'))}</b>${
                    c.to_price ? ` <span class="mono">(${esc(c.to_price)})</span>` : ''
                  }</span></div>`
              )
              .join('')}</div>
             <div class="opt-acts">
               <button class="btn ink" type="button" data-opt-apply>Apply ${changes.length} store switch${
                 changes.length === 1 ? '' : 'es'
               }</button>
               <button class="btn quiet" type="button" data-opt-toggle>Close</button>
             </div>`
          : `<p class="faint">Your cart is already as consolidated as possible with the current store offers. Add a second store offer to any item (or ask your assistant to compare stores) to combine orders.</p>`
      }`;
  }

  return `<section class="optpanel" aria-label="Consolidate stores">
    <div class="optpanel-h">
      <div>
        <h2>Consolidate stores</h2>
        <span class="faint">Combine items into fewer orders or lower total cost (including shipping).</span>
      </div>
      <div class="tabs" role="group" aria-label="Optimization goal">
        <button type="button" data-opt-mode="fewest_orders" aria-pressed="${opt.mode === 'fewest_orders'}">Fewest orders</button>
        <button type="button" data-opt-mode="lowest_cost" aria-pressed="${opt.mode === 'lowest_cost'}">Lowest total</button>
      </div>
    </div>
    ${body}
  </section>`;
}

export function renderShoppingView() {
  const guest = isGuest();
  const items = state.shopping || [];
  const cur = currencyLabel();

  // Group items by store
  const byStore = new Map();
  for (const it of items) {
    const key = storeKeyOf(it);
    if (!byStore.has(key)) byStore.set(key, []);
    byStore.get(key).push(it);
  }
  const stores = [...byStore.entries()].sort((a, b) => {
    if (a[0] === '__other__') return 1;
    if (b[0] === '__other__') return -1;
    return b[1].length - a[1].length;
  });

  const stillToOrderTotal = items
    .filter((i) => (i.status || 'order') === 'order')
    .reduce((acc, it) => {
      const p = unitPriceOf(it);
      return acc + (p ? p * (it.quantity || 1) : 0);
    }, 0);

  const sel = state.sel && state.sel.startsWith('item:') ? state.sel.slice(5) : null;
  const statusLabels = { order: 'to order', ordered: 'on the way', arrived: 'arrived' };

  const storeSections = stores.length
    ? stores
        .map(([storeKey, list]) => {
          const displayName = storeKey === '__other__' ? 'No store yet' : storeDisplayName(storeKey);
          const subtotal = list.reduce((acc, it) => {
            const p = unitPriceOf(it);
            return acc + (p ? p * (it.quantity || 1) : 0);
          }, 0);

          const allArrived = list.every((it) => (it.status || 'order') === 'arrived');
          const noneToOrder = list.every((it) => (it.status || 'order') !== 'order');
          const groupState = allArrived ? 'arrived' : noneToOrder ? 'ordered' : 'order';
          const btnLabel =
            groupState === 'order'
              ? 'Mark order placed'
              : groupState === 'ordered'
              ? 'Mark arrived'
              : 'Arrived ✓';

          // Shipping hint from retailers table if configured
          const rm = retailerMeta(storeKey);
          let shipHint = '';
          if (rm && rm.free_shipping_threshold && subtotal < rm.free_shipping_threshold) {
            shipHint = `· ${money(rm.free_shipping_threshold - subtotal)} ${cur} to free shipping`;
          } else if (rm && rm.free_shipping_threshold && subtotal >= rm.free_shipping_threshold) {
            shipHint = '· free shipping';
          } else if (rm && rm.shipping_cost) {
            shipHint = `· +${money(rm.shipping_cost)} ${cur} shipping`;
          }

          return `<section class="store">
            <div class="storeh">
              <div>
                <h2>${esc(displayName)}</h2>
                <span class="faint num">${list.length} item${list.length === 1 ? '' : 's'}${
            subtotal > 0 ? ` · ${money(subtotal)} ${esc(cur)}` : ''
          }</span>
                ${shipHint ? `<span class="ship-hint">${esc(shipHint)}</span>` : ''}
              </div>
              ${guest ? '' : `<button class="btn" type="button" data-store-act="${esc(storeKey)}|${groupState}">${btnLabel}</button>`}
            </div>
            ${list
              .map((it) => {
                const st = it.status || 'order';
                const unit = unitPriceOf(it);
                const lineTotal = unit !== null ? money(unit * (it.quantity || 1)) : '—';
                const why = it.why_needed || it.notes || '';
                return `<div class="lrow ${sel === it.id ? 'sel' : ''}" data-sel="item:${esc(it.id)}" role="button" tabindex="0">
                  ${phPart(it)}
                  <div class="n">${esc(it.name)}<small>${esc(why)}</small></div>
                  <span class="c3 dim">${
                    !guest && st === 'arrived'
                      ? `<button class="btn move-btn" type="button" data-move-inv="${esc(it.id)}">Move to inventory</button>`
                      : esc(statusLabels[st] || 'to order')
                  }</span>
                  <span class="c4 r">${
                    guest ? `<span class="mono">×${it.quantity || 1}</span>` : stepHtml('data-buy', it.id, it.quantity || 1, 'To buy')
                  }</span>
                  <span class="r mono">${esc(lineTotal)}</span>
                </div>`;
              })
              .join('')}
          </section>`;
        })
        .join('')
    : guest
    ? `<div class="map-empty" style="margin-top:16px"><p>Nothing on the shopping list right now.</p></div>`
    : `<div class="map-empty" style="margin-top:16px">
        <p>Nothing on your shopping list right now. Add an item yourself, or ask your assistant to find parts for a project.</p>
        <a class="btn ink" href="${appHref('/shopping/new')}">+ Add item</a>
      </div>`;

  return `<div class="screen full">
    <div class="work">
      <div class="pagehead">
        <div class="ph-title">
          <h1>Shopping</h1>
          <span class="sub">One section per store, because each store is one order</span>
        </div>
        <div class="shop-head-acts">
          <span class="pstat">
            <span class="k">Still to order</span>
            <b class="num">${money(stillToOrderTotal)} ${esc(cur)}</b>
          </span>
          ${
            !guest && items.length > 1
              ? `<button class="btn" type="button" data-opt-toggle aria-pressed="${Boolean(
                  state.shopOpt && state.shopOpt.open
                )}">Consolidate stores</button>`
              : ''
          }
          ${guest ? '' : `<a class="btn ink" href="${appHref('/shopping/new')}">+ Add item</a>`}
        </div>
      </div>

      ${guest ? '' : renderOptimizerPanel()}
      ${storeSections}
    </div>
    ${
      sel
        ? `<aside class="insp open float ${state.panelWasOpen ? '' : 'enter'}" id="insp" aria-label="Details">${renderShoppingInspector(
            sel
          )}</aside>`
        : ''
    }
  </div>`;
}

export async function advanceStoreStatus(storeKey, curState, renderFn) {
  const nextStatus = curState === 'order' ? 'ordered' : curState === 'ordered' ? 'arrived' : 'order';
  const items = (state.shopping || []).filter((it) => storeKeyOf(it) === storeKey);
  if (!items.length) return;
  const prevStatuses = items.map((it) => [it.id, it.status || 'order']);

  // Optimistic update
  items.forEach((it) => {
    it.status = nextStatus;
  });
  renderFn();

  try {
    await api.setStoreStatus(
      storeKey === '__other__' ? '' : storeKey,
      nextStatus,
      items.map((it) => it.id)
    );
    state.projects = await api.listProjects();
    renderFn();
    const msg =
      nextStatus === 'ordered'
        ? 'Marked order placed'
        : nextStatus === 'arrived'
        ? 'Marked arrived — move items to Inventory when ready'
        : 'Marked back to order';
    toast(msg, async () => {
      try {
        for (const [id, st] of prevStatuses) {
          await api.patchShoppingItem(id, { status: st });
        }
        state.shopping = await api.listShopping();
        state.projects = await api.listProjects();
        renderFn();
      } catch (err) {
        toast(err.message);
      }
    });
  } catch (err) {
    for (const [id, st] of prevStatuses) {
      const it = state.shopping.find((x) => x.id === id);
      if (it) it.status = st;
    }
    renderFn();
    toast(err.message);
  }
}

export async function runStoreOptimizer(mode, apply, renderFn) {
  state.shopOpt.mode = mode || state.shopOpt.mode || 'fewest_orders';
  state.shopOpt.loading = true;
  state.shopOpt.error = '';
  renderFn();
  try {
    const res = await api.optimizeShopping({
      mode: state.shopOpt.mode,
      apply: Boolean(apply),
    });
    state.shopOpt.result = res;
    if (apply) {
      state.shopping = await api.listShopping();
      state.projects = await api.listProjects();
      state.shopOpt.open = false;
      toast(`Updated ${res.changes_count || 0} store choice${res.changes_count === 1 ? '' : 's'}`);
    }
  } catch (err) {
    state.shopOpt.error = err.message;
  } finally {
    state.shopOpt.loading = false;
    renderFn();
  }
}
