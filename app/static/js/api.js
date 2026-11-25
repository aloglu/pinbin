// Thin JSON API client for Pinbin backend endpoints.

async function request(url, opts = {}) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try {
      const data = await res.json();
      if (data && data.detail) msg = typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail);
    } catch (_) {}
    throw new Error(msg);
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  return res.text();
}

const jsonOpts = (method, body) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const api = {
  getConfig: () => request('/api/config'),
  getStats: () => request('/api/stats'),
  patchSettings: (patch) => request('/api/settings', jsonOpts('PATCH', patch)),

  // Parts
  listParts: () => request('/api/parts'),
  createPart: (data) => request('/api/parts', jsonOpts('POST', data)),
  patchPart: (id, patch) => request(`/api/parts/${encodeURIComponent(id)}`, jsonOpts('PATCH', patch)),
  deletePart: (id) => request(`/api/parts/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  uploadPartPhoto: (id, file, slot = 'main') => {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('slot', slot);
    return request(`/api/parts/${encodeURIComponent(id)}/photo`, { method: 'POST', body: fd });
  },
  deletePartPhoto: (id, slot = 'main') =>
    request(`/api/parts/${encodeURIComponent(id)}/photo?slot=${encodeURIComponent(slot)}`, { method: 'DELETE' }),
  scrapeUrl: (url, partId = null, slot = 'main') =>
    request('/api/scrape', jsonOpts('POST', { url, part_id: partId, slot })),
  renameBin: (oldBin, newBin) =>
    request('/api/bins/rename', jsonOpts('POST', { old_bin: oldBin, new_bin: newBin })),

  // Projects
  listProjects: () => request('/api/projects'),
  createProject: (data) => request('/api/projects', jsonOpts('POST', data)),
  patchProject: (id, patch) => request(`/api/projects/${encodeURIComponent(id)}`, jsonOpts('PATCH', patch)),
  deleteProject: (id) => request(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  addProjectItem: (pid, data) => request(`/api/projects/${encodeURIComponent(pid)}/items`, jsonOpts('POST', data)),
  patchProjectItem: (pid, iid, patch) =>
    request(`/api/projects/${encodeURIComponent(pid)}/items/${encodeURIComponent(iid)}`, jsonOpts('PATCH', patch)),
  deleteProjectItem: (pid, iid) =>
    request(`/api/projects/${encodeURIComponent(pid)}/items/${encodeURIComponent(iid)}`, { method: 'DELETE' }),
  replaceProjectNets: (pid, nets) =>
    request(`/api/projects/${encodeURIComponent(pid)}/nets`, jsonOpts('PUT', { nets })),
  replaceProjectChecks: (pid, checks) =>
    request(`/api/projects/${encodeURIComponent(pid)}/checks`, jsonOpts('PUT', { checks })),
  patchProjectCheck: (pid, cid, patch) =>
    request(`/api/projects/${encodeURIComponent(pid)}/checks/${encodeURIComponent(cid)}`, jsonOpts('PATCH', patch)),

  // Shopping & Retailers
  listShopping: () => request('/api/shopping'),
  createShoppingItem: (data) => request('/api/shopping', jsonOpts('POST', data)),
  patchShoppingItem: (id, patch) => request(`/api/shopping/${encodeURIComponent(id)}`, jsonOpts('PATCH', patch)),
  deleteShoppingItem: (id) => request(`/api/shopping/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  moveShoppingToInventory: (id) =>
    request(`/api/shopping/${encodeURIComponent(id)}/move-to-inventory`, { method: 'POST' }),
  addShoppingOffer: (id, data) =>
    request(`/api/shopping/${encodeURIComponent(id)}/offers`, jsonOpts('POST', data)),
  patchShoppingOffer: (id, oid, patch) =>
    request(`/api/shopping/${encodeURIComponent(id)}/offers/${encodeURIComponent(oid)}`, jsonOpts('PATCH', patch)),
  deleteShoppingOffer: (id, oid) =>
    request(`/api/shopping/${encodeURIComponent(id)}/offers/${encodeURIComponent(oid)}`, { method: 'DELETE' }),
  setStoreStatus: (retailer, status, itemIds = null) =>
    request('/api/shopping/store-status', jsonOpts('POST', { retailer, status, item_ids: itemIds })),
  optimizeShopping: (payload) => request('/api/shopping/optimize', jsonOpts('POST', payload)),

  listRetailers: () => request('/api/retailers'),
  upsertRetailer: (domain, data) =>
    request(`/api/retailers/${encodeURIComponent(domain)}`, jsonOpts('PUT', data)),

  // Glossary
  listGlossary: () => request('/api/glossary'),

  // MCP Settings & Data
  getMcpSettings: () => request('/api/mcp-settings'),
  patchMcpSettings: (patch) => request('/api/mcp-settings', jsonOpts('PATCH', patch)),
  rotateMcpToken: () => request('/api/mcp-settings/rotate-token', { method: 'POST' }),
  wipeAllData: (confirm) => request('/api/wipe', jsonOpts('POST', { confirm })),
};
