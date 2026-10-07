// Invoked by the opt-in Go integration test against real Go HTTP + isolated DB.
import assert from 'node:assert/strict';
import { createCoreAdapter } from '../core-adapter.mjs';
import { createServer } from 'node:http';
import { createMcpHandler, MCP_PROTOCOL_VERSION } from '../mcp.mjs';

const { urls, inputs, previews, expected, template } = JSON.parse(process.env.CORE_ADAPTER_FIXTURE);
const adapter = createCoreAdapter({ restaurants: urls.map((baseUrl, index) => ({
  id: `restaurant-${index}`, name: `Fixture ${index}`, cuisine: 'saudi', baseUrl,
})) });
let handler;
const mcpServer = createServer((req, res) => handler(req, res));
await new Promise(resolve => mcpServer.listen(0, '127.0.0.1', resolve));
const mcpBase = `http://127.0.0.1:${mcpServer.address().port}`;
handler = createMcpHandler({ baseUrl: mcpBase, authenticate: async () => null, coreAdapter: adapter });
async function rpc(method, params = {}) {
  const response = await fetch(`${mcpBase}/mcp`, { method: 'POST', headers: {
    'content-type': 'application/json', accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': MCP_PROTOCOL_VERSION, 'Mcp-Method': method,
    ...(params.name ? { 'Mcp-Name': params.name } : {}),
  }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: {
    'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION,
    'io.modelcontextprotocol/clientInfo': { name: 'core-parity-test', version: '1' },
    'io.modelcontextprotocol/clientCapabilities': {},
  } } }) });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.error, undefined, JSON.stringify(result));
  return result.result;
}
try {
const discovery = await rpc('tools/list');
assert.deepEqual(discovery.tools.map(tool => tool.name), ['search_restaurants', 'get_restaurant_opening_status', 'get_restaurant_menu', 'quote_cart']);
assert.ok(discovery.tools.every(tool => tool.annotations.readOnlyHint));
for (const [index] of urls.entries()) {
  const tenantId = `restaurant-${index}`;
  const status=await adapter.openingStatus(tenantId);
  assert.equal(status.tenantId,tenantId);assert.equal(status.scheduleEnabled,false);assert.equal(status.withinHours,null);
  const statusTool=await rpc('tools/call',{name:'get_restaurant_opening_status',arguments:{tenantId}});
  assert.equal(statusTool.structuredContent.tenantId,tenantId);assert.equal(statusTool.structuredContent.acceptingOrders,status.acceptingOrders);
  const menu = await adapter.getMenu(tenantId);
  assert.equal(menu.tenantId, tenantId);
  assert.equal(menu.settings.brand.storefrontTemplate, template);
  assert.equal(menu.tables, undefined);
  assert.equal(menu.items[0].id, 'rice');
  const quote = await adapter.quote(tenantId, inputs[index]);
  assert.deepEqual(quote, { tenantId, ...expected[index] });
  const previewInput = previews[index];
  if (previewInput.mode !== 'delivery') delete previewInput.address;
  const preview = await adapter.preview(tenantId, previewInput);
  assert.deepEqual(preview, quote, 'Contact-free preview must preserve original amounts and payment choices');
  const menuTool = await rpc('tools/call', { name: 'get_restaurant_menu', arguments: { tenantId } });
  assert.deepEqual(menuTool.structuredContent, menu);
  const quoteTool = await rpc('tools/call', { name: 'quote_cart', arguments: { tenantId, ...previewInput } });
  assert.deepEqual(quoteTool.structuredContent, preview);
}
assert.notEqual(expected[0].totalMinor, expected[1].totalMinor, 'Fixtures must prove routing with distinct prices');
await assert.rejects(adapter.getMenu('other-restaurant'), { code: 'restaurant_not_found' });
console.log(`Verified real Go catalog and quote parity for ${template}, two isolated restaurants`);
} finally { mcpServer.closeAllConnections(); await new Promise(resolve => mcpServer.close(resolve)); }
