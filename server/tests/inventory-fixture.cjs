'use strict';
// Synthetic server contract: the UI only receives the requested page.
function inventoryResponse(hosts, f) {
  const summary = {total:hosts.length,online:0,offline:0,unknown:0};
  hosts.forEach(h => summary[['online','offline'].includes(h.status) ? h.status : 'unknown']++);
  const items = hosts.filter(h => {
    const search = (f.search || '').toLowerCase();
    return (!search || [h.hostname,h.fqdn,...(h.ip_addresses || [])].some(v => (v || '').toLowerCase().includes(search))) &&
      (!f.status || (['online','offline'].includes(h.status) ? h.status : 'unknown') === f.status) &&
      (!f.os || (h.os || '').toLowerCase().includes(f.os)) &&
      (!f.group || (f.group === '__ungrouped__' ? !h.group_id : h.group_id === f.group));
  });
  const rank = {offline:0,unknown:1,online:2};
  items.sort((a,b) => {
    if (f.sort === 'seen') { const diff = (Date.parse(b.last_seen)||0)-(Date.parse(a.last_seen)||0); if(diff) return diff; }
    if (f.sort === 'status') { const diff = (rank[a.status]??1)-(rank[b.status]??1); if(diff) return diff; }
    return a.hostname.toLowerCase().localeCompare(b.hostname.toLowerCase()) || a.id.localeCompare(b.id);
  });
  const page = Math.min(f.page || 1,Math.max(1,Math.ceil(items.length/f.page_size)));
  return {success:true,data:{items:items.slice((page-1)*f.page_size,page*f.page_size),total:items.length,page,page_size:f.page_size,summary}};
}

module.exports = inventoryResponse;
