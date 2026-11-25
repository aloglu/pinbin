// Built-in electrical compatibility rules and project readiness helpers.
import { state, partById, shoppingById, esc, termButton, sevGlyph, parsePriceNumber, money, currencyLabel } from './state.js';

const boards = () => state.parts.filter((p) => p.category === 'Microcontrollers');

/**
 * Compute compatibility relationships between a part/shopping item and owned inventory.
 * Mirrors the prototype's "With your other parts" inspector section.
 */
export function computeRelations(obj, selfId) {
  const f = (obj && obj.electrical_facts) || {};
  const out = [];
  if (f.logic === 'none') return out;

  if (obj.category === 'Microcontrollers' && f.io) {
    state.parts
      .filter((x) => x.id !== selfId)
      .forEach((x) => {
        const xf = x.electrical_facts || {};
        const outs = xf.out ? Object.entries(xf.out) : [];
        const maxOut = outs.reduce((m, [, v]) => Math.max(m, Number(v) || 0), 0);
        if (maxOut && maxOut > f.io) {
          out.push([
            'check',
            x,
            `Its ${esc(outs[0][0])} pin sends ${maxOut} V. Add a ${termButton('voltage-divider', 'voltage divider')} before it reaches this board.`,
          ]);
        } else if (xf.vin && xf.vin[1] < 4 && f.io > 4) {
          out.push(['danger', x, '3.3 V only. This board’s pins send 5 V: use a level shifter.']);
        } else if (xf.vin && xf.vin[0] > 3.6 && f.io < 4) {
          out.push(['info', x, 'Needs 5 V power. Feed it from this board’s 5V/VIN pin; its signals are fine.']);
        }
      });
    const okCount = state.parts.filter(
      (x) => x.category !== 'Microcontrollers' && x.electrical_facts && x.electrical_facts.vin && !out.some((r) => r[1] === x)
    ).length;
    if (okCount) {
      out.push(['ok', null, `${okCount} of your sensors and screens connect to it directly.`]);
    }
  } else if (f.vin || f.out) {
    boards().forEach((b) => {
      const bf = b.electrical_facts || {};
      if (!bf.io) return;
      const outs = f.out ? Object.entries(f.out) : [];
      const maxOut = outs.reduce((m, [, v]) => Math.max(m, Number(v) || 0), 0);
      if (maxOut && maxOut > bf.io) {
        out.push([
          'check',
          b,
          `Needs a ${termButton('voltage-divider', 'voltage divider')} on ${esc(outs[0][0])}: it sends ${maxOut} V, the board takes ${bf.io} V.`,
        ]);
      } else if (f.vin && f.vin[1] < 4 && bf.io > 4) {
        out.push(['danger', b, 'The board sends 5 V on its pins. Use a level shifter.']);
      } else if (f.vin && f.vin[0] > 3.6 && bf.io < 4) {
        out.push(['info', b, 'Power it from the board’s 5V/VIN pin. Signals connect directly.']);
      } else {
        out.push(['ok', b, 'Connects directly.']);
      }
    });
  }

  if (f.i2c) {
    const others = state.parts.filter((x) => x.id !== selfId && x.electrical_facts && x.electrical_facts.i2c);
    const clash = others.filter((x) => x.electrical_facts.i2c.toLowerCase() === f.i2c.toLowerCase());
    clash.forEach((x) =>
      out.push([
        'danger',
        x,
        `Same ${termButton('i2c', 'I2C')} address (${esc(f.i2c)}). They cannot share the same two wires.`,
      ])
    );
    if (!clash.length && others.length) {
      const list = others.map((x) => `${esc(x.name.split(' (')[0])} ${esc(x.electrical_facts.i2c)}`).join(', ');
      out.push(['ok', null, `I2C ${esc(f.i2c)} differs from your other I2C parts (${list}). They can share the wires.`]);
    }
  }

  (f.pairs || []).forEach((pid) => {
    const x = partById(pid);
    if (x) out.push(['pair', x, 'Goes with this part. You own one.']);
  });

  return out;
}

export function relHtml(rels) {
  return rels
    .map(
      ([s, x, t]) =>
        `<div class="rel"><span class="sev ${s === 'pair' ? 'ok' : s}" style="${
          s === 'info' ? 'background:var(--ink-3)' : s === 'pair' ? 'background:var(--spi)' : ''
        }">${s === 'pair' ? '↔' : s === 'info' ? 'i' : sevGlyph(s)}</span><div>${
          x ? `<button class="lk" type="button" data-sel="part:${esc(x.id)}"><b>${esc(x.name)}</b></button>` : ''
        }<p>${t}</p></div></div>`
    )
    .join('');
}

export function careHtml(care) {
  return (care || [])
    .map((c) => {
      const s = c.severity || 'info';
      const txt = c.text || '';
      return `<div class="care ${esc(s)}"><span class="sev ${esc(s)}">${s === 'info' ? 'i' : sevGlyph(s)}</span><span>${esc(txt)}</span></div>`;
    })
    .join('');
}

/**
 * Find relevant glossary term IDs for a part based on its electrical facts.
 */
export function glossaryTermsFor(obj) {
  const f = (obj && obj.electrical_facts) || {};
  const ids = [];
  const ifaces = f.interfaces || [];
  if (ifaces.includes('I2C')) ids.push('i2c');
  if (ifaces.includes('SPI')) ids.push('spi');
  if (ifaces.includes('PWM')) ids.push('pwm');
  if (ifaces.includes('UART')) ids.push('uart');
  if (f.logic === 'v33' || f.logic === 'v5') ids.push('logic-level');
  if (f.out && Object.keys(f.out).length) ids.push('voltage-divider');
  if (f.strap && f.strap.length) ids.push('gpio');

  const present = new Set(state.glossary.map((g) => g.id));
  return [...new Set(ids)].filter((id) => present.has(id));
}

/**
 * Resolve a project item record with its live owned part or shopping item.
 */
export function resolveProjectItem(proj, ref) {
  const q = (proj.items || []).find((it) => it.ref === ref);
  if (!q) return null;
  if (q.part_id) {
    const pt = partById(q.part_id);
    return {
      ...q,
      owned: true,
      displayName: q.label || (pt ? pt.name : q.name),
      fullName: pt ? pt.name : q.name,
      facts: (pt && pt.electrical_facts) || q.electrical_facts || {},
      src: pt,
    };
  }
  const it = shoppingById(q.shopping_item_id);
  return {
    ...q,
    owned: false,
    displayName: q.label || (it ? it.name : q.name),
    fullName: it ? it.name : q.name,
    facts: (it && it.electrical_facts) || q.electrical_facts || {},
    src: it,
  };
}

/**
 * Run built-in electrical safety rules on a project's wiring nets.
 */
export function runProjectRules(proj) {
  const out = [];
  if (!proj || !proj.nets || !proj.nets.length) return out;
  const mcuItem = (proj.items || []).find((it) => it.role === 'mcu');
  if (!mcuItem) return out;
  const mcu = resolveProjectItem(proj, mcuItem.ref);
  if (!mcu) return out;
  const mf = mcu.facts || {};
  const add = (o) => out.push({ src: 'rule', ...o });

  for (const n of proj.nets) {
    const conns = n.conns || [];
    const mEntry = conns.find(([r]) => r === mcu.ref);
    const mpin = mEntry ? mEntry[1] : '';

    if (n.kind === 'bat' && mpin) {
      const v = Math.max(0, ...conns.map(([r]) => {
        const rec = resolveProjectItem(proj, r);
        return (rec && rec.facts && rec.facts.vout) || 0;
      }));
      const rng = (mf.power || {})[mpin];
      if (rng && v > rng[1]) {
        add({
          id: `r-bat-${n.id}`,
          sev: 'danger',
          on: { nets: [n.id] },
          t: `Battery (${v} V) goes into ${esc(mpin)}, which takes ${rng[1]} V at most.`,
          b: 'Move it to a regulated 5V/VIN pin.',
        });
      } else if (rng && v > 0) {
        add({
          id: `r-bat-${n.id}`,
          sev: 'ok',
          on: { nets: [n.id] },
          t: `Battery enters the ${esc(mpin)} pin, inside its range.`,
          b: `Up to ${v} V in; ${esc(mpin)} takes ${rng[0]}–${rng[1]} V.`,
        });
      }
    }

    if (n.rail) {
      const bad = [];
      const good = [];
      conns
        .filter(([r]) => r !== mcu.ref)
        .forEach(([r]) => {
          const x = resolveProjectItem(proj, r);
          const vin = x && x.facts && x.facts.vin;
          if (!vin) return;
          (n.rail < vin[0] || n.rail > vin[1] ? bad : good).push([x, vin]);
        });
      bad.forEach(([x, vin]) =>
        add({
          id: `r-rail-${n.id}-${x.ref}`,
          sev: 'danger',
          on: { nets: [n.id], nodes: [x.ref] },
          t: `${esc(x.displayName)} needs ${vin[0]}–${vin[1]} V. This rail gives ${n.rail} V.`,
          b: `Move it to a ${vin[0] > 3.6 ? '5 V' : '3.3 V'} pin.`,
        })
      );
      if (good.length && !bad.length) {
        add({
          id: `r-rail-${n.id}`,
          sev: 'ok',
          on: { nets: [n.id] },
          t: `Everything on the ${n.rail} V rail accepts ${n.rail} V.`,
          b: good.map(([x, vin]) => `${esc(x.displayName)}: ${vin[0]}–${vin[1]} V`).join(' · '),
        });
      }
    }

    if (mpin && !n.rail && n.kind !== 'bat') {
      conns
        .filter(([r]) => r !== mcu.ref)
        .forEach(([r, pin]) => {
          const x = resolveProjectItem(proj, r);
          const o = x && x.facts && x.facts.out && x.facts.out[pin];
          if (o && mf.io && o > mf.io) {
            add({
              id: `r-lvl-${n.id}-${r}`,
              sev: 'danger',
              on: { nets: [n.id], nodes: [r] },
              t: `${esc(x.displayName)} ${esc(pin)} sends ${o} V into ${esc(mpin)}. ${esc(mcu.displayName)} pins take ${mf.io} V at most.`,
              b: `This can damage the pin over time. Put a ${termButton('voltage-divider', 'voltage divider')} between them.`,
            });
          } else if (o && mf.io) {
            add({
              id: `r-lvl-${n.id}-${r}`,
              sev: 'ok',
              on: { nets: [n.id] },
              t: `${esc(pin)} reaches ${esc(mpin)} at ${o} V. Safe.`,
              b: `${esc(mcu.displayName)} pins take up to ${mf.io} V.`,
            });
          }
        });

      const straps = (mf.strap || []).filter((s) =>
        mpin.split(/[^\w]/).some((q) => q === s || `GPIO${q}` === s)
      );
      if (straps.length) {
        add({
          id: `r-strap-${n.id}`,
          sev: 'check',
          on: { nets: [n.id] },
          t: `${esc(straps.join(' and '))} ${straps.length > 1 ? 'are strapping pins' : 'is a strapping pin'}.`,
          b: 'Usually fine. If the board will not start or upload, unplug this wire and try again.',
        });
      }

      if (n.wake && mf.wake && mf.wake.length) {
        const ok = mf.wake.includes(mpin);
        add({
          id: `r-wake-${n.id}`,
          sev: ok ? 'ok' : 'check',
          on: { nets: [n.id] },
          t: ok ? `${esc(mpin)} can wake the chip from deep sleep.` : `${esc(mpin)} cannot wake the chip from deep sleep.`,
          b: ok ? `Only some pins can; ${esc(mpin)} is one of them.` : 'Use a wake-capable pin from the board pinout.',
        });
      }
    }

    if (n.kind === 'i2c') {
      const adds = conns
        .filter(([r]) => r !== mcu.ref)
        .map(([r]) => {
          const x = resolveProjectItem(proj, r);
          return x && x.facts && x.facts.i2c ? [x.displayName, x.facts.i2c] : null;
        })
        .filter(Boolean);
      const seen = {};
      let clash = null;
      adds.forEach(([nm, a]) => {
        const k = a.toLowerCase();
        if (seen[k]) clash = [seen[k], nm, a];
        seen[k] = nm;
      });
      if (clash) {
        add({
          id: `r-i2c-${n.id}`,
          sev: 'danger',
          on: { nets: [n.id] },
          t: `${esc(clash[0])} and ${esc(clash[1])} both use I2C address ${esc(clash[2])}.`,
          b: 'They will answer at the same time. Change one address or use a second bus.',
        });
      } else if (adds.length > 1) {
        add({
          id: `r-i2c-${n.id}`,
          sev: 'ok',
          on: { nets: [n.id] },
          t: 'Devices on I2C have different addresses.',
          b: `${adds.map(([nm, a]) => `${esc(nm)} ${esc(a)}`).join(', ')}. They can share the two wires.`,
        });
      }
    }
  }
  return out;
}

export function warningsOfProject(proj) {
  if (!proj) return [];
  const ui = state.config.ui_settings;
  const assistant = (proj.checks || []).map((c) => ({
    id: c.id,
    src: 'assistant',
    sev: c.severity || 'check',
    t: esc(c.title),
    b: esc(c.body),
    on: { nodes: c.node_refs || [], nets: c.net_ids || [] },
    is_done: !!c.is_done,
  }));
  return [...runProjectRules(proj), ...assistant].filter(
    (w) => (ui.show_ok_checks || w.sev !== 'ok') && (ui.strap_pin_checks || !w.id.startsWith('r-strap'))
  );
}

export function openChecksOfProject(proj) {
  return warningsOfProject(proj).filter((w) => w.sev !== 'ok' && !(w.src === 'assistant' && w.is_done));
}

export function projectUseMap(proj) {
  const use = {};
  if (!proj) return use;
  const ws = warningsOfProject(proj);
  const roleLabel = { power: 'power', mcu: 'brain', periph: 'part', material: 'material' };
  (proj.items || []).forEach((q) => {
    const key = q.part_id ? `p:${q.part_id}` : q.shopping_item_id ? `i:${q.shopping_item_id}` : null;
    if (!key) return;
    const w = ws.filter(
      (x) => (x.on.nodes || []).includes(q.ref) && x.sev !== 'ok' && !(x.src === 'assistant' && x.is_done)
    );
    use[key] = { role: roleLabel[q.role] || 'part', warn: w };
  });
  return use;
}

export function nextStepOfProject(proj) {
  const ws = warningsOfProject(proj);
  const ruleDanger = ws.filter((w) => w.src === 'rule' && w.sev === 'danger');
  if (ruleDanger.length) {
    return {
      t: `Fix ${ruleDanger.length} wiring problem${ruleDanger.length > 1 ? 's' : ''}`,
      s: 'Found by the built-in checks.',
      act: `warn:${ruleDanger[0].id}`,
    };
  }
  const buys = (proj.items || []).filter((x) => x.item_type === 'shopping' && (x.shopping_status || 'order') === 'order');
  if (buys.length) {
    const stores = new Set(buys.map((x) => x.retailer || 'store'));
    const sum = buys.reduce((acc, x) => {
      const p = parsePriceNumber(x.price);
      const q = x.buy_quantity || x.quantity_needed || 1;
      return acc + (p ? p * q : 0);
    }, 0);
    return {
      t: `Order ${buys.length} part${buys.length === 1 ? '' : 's'}`,
      s: `${stores.size} store${stores.size === 1 ? '' : 's'}${sum > 0 ? ` · ${money(sum)} ${currencyLabel()}` : ''}`,
      href: '#shopping',
    };
  }
  const open = openChecksOfProject(proj);
  if (open.length) {
    return { t: `Go through ${open.length} check${open.length === 1 ? '' : 's'}`, s: 'Then you can build it.', act: `warn:${open[0].id}` };
  }
  return { t: 'Ready to build', s: 'Everything is on hand and checked.' };
}
