const express = require('express');
const path = require('path');
const app = express();
app.use(express.json());
app.use(express.static(__dirname));

const SHOPIFY_STORE  = process.env.SHOPIFY_STORE;
const CLIENT_ID      = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET  = process.env.SHOPIFY_CLIENT_SECRET;
// OpenRouter replaces Gemini
const PORT           = 3000;

let cachedToken = null, tokenExpiry = 0;

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const r = await fetch(`https://${SHOPIFY_STORE}/admin/oauth/access_token`, {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: 'client_credentials'})
  });
  const {access_token} = await r.json();
  cachedToken = access_token;
  tokenExpiry = Date.now() + 55 * 60 * 1000;
  return access_token;
}

async function gql(query, variables = {}) {
  const token = await getToken();
  const res = await fetch(`https://${SHOPIFY_STORE}/admin/api/2025-01/graphql.json`, {
    method: 'POST',
    headers: {'Content-Type':'application/json','X-Shopify-Access-Token': token},
    body: JSON.stringify({ query, variables })
  });
  return res.json();
}

async function fetchAllVariants() {
  let cursor = null, hasNext = true, variants = [];
  while (hasNext) {
    const data = await gql(`
      query ($cursor: String) {
        productVariants(first: 250, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id sku price inventoryQuantity
            inventoryItem { unitCost { amount } }
            product { title status tags productType }
          }
        }
      }
    `, { cursor });
    const nodes = data.data?.productVariants?.nodes || [];
    for (const v of nodes) {
      if (v.product.status !== 'ACTIVE') continue;
      const cost  = parseFloat(v.inventoryItem?.unitCost?.amount || 0);
      const price = parseFloat(v.price || 0);
      const qty   = parseInt(v.inventoryQuantity || 0);
      variants.push({
        id: v.id, sku: v.sku || '',
        product: v.product.title,
        type: detectCategory(v.product.tags, v.product.title),
        price, cost, qty,
        hasCost: cost > 0,
        margin: cost > 0 && price > 0 ? ((1 - cost/price)*100) : null,
        stockValueCost: cost * Math.max(qty, 0),
        stockValueRetail: price * Math.max(qty, 0),
      });
    }
    hasNext = data.data?.productVariants?.pageInfo?.hasNextPage;
    cursor  = data.data?.productVariants?.pageInfo?.endCursor;
  }
  return variants;
}

function detectCategory(tags, title) {
  const t = ((tags || '') + ' ' + title).toUpperCase();
  if (t.includes('ΡΟΥΧΑ') || t.includes('PANTS') || t.includes('TOP') || t.includes('DRESS') || t.includes('JACKET') || t.includes('BRALETTE') || t.includes('BODYSUIT') || t.includes('SHORTS') || t.includes('CARDI') || t.includes('SWEATER') || t.includes('JEANS')) return 'ΡΟΥΧΑ';
  if (t.includes('ΚΟΣΜΗΜΑΤΑ') || t.includes('RING') || t.includes('NECKLACE') || t.includes('EARRING') || t.includes('BRACELET') || t.includes('PENDANT') || t.includes('HOOPS') || t.includes('ANKLET') || t.includes('CUFF')) return 'ΚΟΣΜΗΜΑΤΑ';
  if (t.includes('ΑΞΕΣΟΥΑΡ') || t.includes('SCARF') || t.includes('BAG') || t.includes('THERMOS') || t.includes('SUNGLASSES') || t.includes('SANDAL') || t.includes('THERMOS') || t.includes('SCRUNCHIE') || t.includes('TURBAN')) return 'ΑΞΕΣΟΥΑΡ';
  return 'ΑΛΛΟ';
}

function computeAnalytics(variants) {
  const withCost = variants.filter(v => v.hasCost);
  const withCostAndStock = variants.filter(v => v.hasCost && v.qty > 0);

  const categories = {};
  const byProduct  = {};

  for (const v of variants) {
    // Categories
    if (!categories[v.type]) categories[v.type] = { name: v.type, count: 0, stockQty: 0, stockCost: 0, stockRetail: 0, margins: [] };
    categories[v.type].count++;
    categories[v.type].stockQty    += Math.max(v.qty, 0);
    categories[v.type].stockCost   += v.stockValueCost;
    categories[v.type].stockRetail += v.stockValueRetail;
    if (v.margin !== null) categories[v.type].margins.push(v.margin);

    // By product
    if (!byProduct[v.product]) byProduct[v.product] = { product: v.product, type: v.type, totalQty: 0, totalCost: 0, totalRetail: 0, margins: [] };
    byProduct[v.product].totalQty    += Math.max(v.qty, 0);
    byProduct[v.product].totalCost   += v.stockValueCost;
    byProduct[v.product].totalRetail += v.stockValueRetail;
    if (v.margin !== null) byProduct[v.product].margins.push(v.margin);
  }

  for (const c of Object.values(categories)) {
    c.avgMargin = c.margins.length > 0 ? c.margins.reduce((a,b)=>a+b,0)/c.margins.length : 0;
  }
  for (const p of Object.values(byProduct)) {
    p.avgMargin = p.margins.length > 0 ? p.margins.reduce((a,b)=>a+b,0)/p.margins.length : 0;
  }

  const buckets = {'<30%':0,'30-40%':0,'40-50%':0,'50-60%':0,'60-70%':0,'>70%':0};
  for (const v of withCost) {
    const m = v.margin;
    if (m < 30) buckets['<30%']++;
    else if (m < 40) buckets['30-40%']++;
    else if (m < 50) buckets['40-50%']++;
    else if (m < 60) buckets['50-60%']++;
    else if (m < 70) buckets['60-70%']++;
    else buckets['>70%']++;
  }

  return {
    total:           variants.length,
    withCost:        withCost.length,
    coveragePct:     (withCost.length/variants.length*100).toFixed(1),
    totalStockQty:   variants.filter(v=>v.qty>0).reduce((s,v)=>s+v.qty,0),
    totalStockCost:  withCostAndStock.reduce((s,v)=>s+v.stockValueCost,0),
    totalStockRetail:withCostAndStock.reduce((s,v)=>s+v.stockValueRetail,0),
    avgMargin:       withCost.length > 0 ? withCost.reduce((s,v)=>s+v.margin,0)/withCost.length : 0,
    categories:      Object.values(categories).sort((a,b)=>b.stockRetail-a.stockRetail),
    topByStockValue: Object.values(byProduct).sort((a,b)=>b.totalRetail-a.totalRetail).slice(0,20),
    topByMargin:     Object.values(byProduct).filter(p=>p.margins.length>0).sort((a,b)=>b.avgMargin-a.avgMargin).slice(0,20),
    topByQty:        Object.values(byProduct).sort((a,b)=>b.totalQty-a.totalQty).slice(0,20),
    marginBuckets:   buckets,
  };
}

let dataCache = null, cacheTime = 0;

async function fetchSalesData(token) {
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const data = await gql(`
      query {
        orders(first: 250, query: "created_at:>${thirtyDaysAgo} status:any", sortKey: CREATED_AT, reverse: true) {
          nodes {
            id name createdAt totalPriceSet { shopMoney { amount } }
            customer { id numberOfOrders }
            lineItems(first: 50) {
              nodes { title quantity variant { sku product { title productType tags } } }
            }
          }
        }
      }
    `);

    const orders = data.data?.orders?.nodes || [];
    const totalRevenue30 = orders.reduce((s, o) => s + parseFloat(o.totalPriceSet?.shopMoney?.amount || 0), 0);
    const orderCount30 = orders.length;
    const avgOrderValue30 = orderCount30 > 0 ? totalRevenue30 / orderCount30 : 0;

    // Customers
    const customerIds = new Set();
    let newCustomers30 = 0, returningCustomers30 = 0;
    orders.forEach(o => {
      if (o.customer) {
        customerIds.add(o.customer.id);
        if (o.customer.numberOfOrders <= 1) newCustomers30++;
        else returningCustomers30++;
      }
    });

    // Top selling products
    const productSales = {};
    orders.forEach(o => {
      (o.lineItems?.nodes || []).forEach(li => {
        const title = li.variant?.product?.title || li.title;
        if (!productSales[title]) productSales[title] = { title, qty: 0, revenue: 0 };
        productSales[title].qty += li.quantity;
      });
    });

    const topSelling = Object.values(productSales)
      .sort((a, b) => b.qty - a.qty)
      .slice(0, 10);

    console.log('Sales fetched:', orderCount30, 'orders,', totalRevenue30.toFixed(0), 'EUR');
    return { totalRevenue30, orderCount30, avgOrderValue30, newCustomers30, returningCustomers30, topSelling };
  } catch(e) {
    console.log('Sales fetch error:', e.message);
    return {};
  }
}

async function getData(forceRefresh = false) {
  if (!forceRefresh && dataCache && Date.now() - cacheTime < 5 * 60 * 1000) return dataCache;
  console.log('Fetching from Shopify...');
  const [variants, sales] = await Promise.all([fetchAllVariants(), fetchSalesData()]);
  const analytics = computeAnalytics(variants);
  dataCache = { variants, analytics, sales, fetchedAt: new Date().toISOString() };
  cacheTime = Date.now();
  return dataCache;
}

// ── API routes ────────────────────────────────────────────────
app.get('/api/data', async (req, res) => {
  try { res.json(await getData(req.query.refresh === '1')); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/discount', async (req, res) => {
  try {
    const { category, discount } = req.body;
    const data = await getData();
    // Χρησιμοποίησε ΟΛΑ τα variants με cost (ανεξάρτητα από filter)
    const catVariants = data.variants.filter(v => v.type === category && v.qty > 0 && v.hasCost && v.price > 0);
    const d = parseFloat(discount) / 100;
    const currentRevenue = catVariants.reduce((s,v)=>s+v.stockValueRetail,0);
    const currentProfit  = catVariants.reduce((s,v)=>s+(v.price-v.cost)*Math.max(v.qty,0),0);
    const newRevenue     = catVariants.reduce((s,v)=>s+(v.price*(1-d))*Math.max(v.qty,0),0);
    const newProfit      = catVariants.reduce((s,v)=>s+(v.price*(1-d)-v.cost)*Math.max(v.qty,0),0);
    console.log('Discount calc:', category, discount+'%', 'variants:', catVariants.length, 'revenue:', currentRevenue);
    res.json({ currentRevenue, currentProfit, newRevenue, newProfit });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/ai', async (req, res) => {
  try {
    if (!process.env.OPENROUTER_API_KEY) return res.status(400).json({ error: 'No API key' });
    const { question } = req.body;
    const data = await getData();
    const { analytics, sales } = data;

    // Shopify functions the AI can call
    const tools = [
      {
        type: 'function',
        function: {
          name: 'get_orders_by_date',
          description: 'Get orders for a specific date range. Use for questions like yesterday, this week, last month, specific dates.',
          parameters: {
            type: 'object',
            properties: {
              from_date: { type: 'string', description: 'Start date ISO format e.g. 2026-03-24T00:00:00Z' },
              to_date: { type: 'string', description: 'End date ISO format e.g. 2026-03-24T23:59:59Z' }
            },
            required: ['from_date', 'to_date']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_product_sales',
          description: 'Get sales per product for a date range.',
          parameters: {
            type: 'object',
            properties: {
              from_date: { type: 'string' },
              to_date: { type: 'string' }
            },
            required: ['from_date', 'to_date']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_inventory_status',
          description: 'Get inventory status - low stock, overstock, out of stock.',
          parameters: {
            type: 'object',
            properties: {
              category: { type: 'string', description: 'Category: ΡΟΥΧΑ, ΚΟΣΜΗΜΑΤΑ, ΑΞΕΣΟΥΑΡ or ALL' },
              low_stock_threshold: { type: 'number', description: 'Low stock threshold default 5' }
            }
          }
        }
      }
    ];

    async function executeFunction(name, args) {
      if (name === 'get_orders_by_date') {
        const d = await gql(`
          query {
            orders(first: 100, query: "created_at:>${args.from_date} created_at:<${args.to_date} status:any", sortKey: CREATED_AT, reverse: true) {
              nodes {
                name createdAt
                totalPriceSet { shopMoney { amount } }
                customer { firstName lastName numberOfOrders }
                lineItems(first: 10) { nodes { title quantity } }
              }
            }
          }
        `);
        const orders = d.data?.orders?.nodes || [];
        const total = orders.reduce((s,o) => s + parseFloat(o.totalPriceSet?.shopMoney?.amount||0), 0);
        return {
          order_count: orders.length,
          total_revenue: total.toFixed(2) + ' EUR',
          avg_order: orders.length > 0 ? (total/orders.length).toFixed(2) + ' EUR' : '0',
          orders: orders.slice(0,20).map(o => ({
            name: o.name,
            date: o.createdAt.split('T')[0],
            amount: parseFloat(o.totalPriceSet?.shopMoney?.amount||0).toFixed(2) + ' EUR',
            customer: o.customer ? (o.customer.firstName + ' ' + o.customer.lastName) : 'Guest',
            items: (o.lineItems?.nodes||[]).map(li => li.title + ' x' + li.quantity).join(', ')
          }))
        };
      }

      if (name === 'get_product_sales') {
        const d = await gql(`
          query {
            orders(first: 250, query: "created_at:>${args.from_date} created_at:<${args.to_date} status:any") {
              nodes {
                lineItems(first: 20) {
                  nodes { title quantity originalUnitPriceSet { shopMoney { amount } } }
                }
              }
            }
          }
        `);
        const pm = {};
        (d.data?.orders?.nodes||[]).forEach(o => {
          (o.lineItems?.nodes||[]).forEach(li => {
            if (!pm[li.title]) pm[li.title] = { title: li.title, qty: 0, revenue: 0 };
            pm[li.title].qty += li.quantity;
            pm[li.title].revenue += parseFloat(li.originalUnitPriceSet?.shopMoney?.amount||0) * li.quantity;
          });
        });
        return Object.values(pm).sort((a,b) => b.qty - a.qty).slice(0,20).map(p => ({
          product: p.title, qty_sold: p.qty, revenue: p.revenue.toFixed(2) + ' EUR'
        }));
      }

      if (name === 'get_inventory_status') {
        const cat = args.category || 'ALL';
        const thr = args.low_stock_threshold || 5;
        let variants = data.variants;
        if (cat !== 'ALL') variants = variants.filter(v => v.type === cat);
        return {
          low_stock: variants.filter(v => v.qty > 0 && v.qty <= thr).sort((a,b) => a.qty-b.qty).slice(0,10).map(v => ({ product: v.product, qty: v.qty, price: v.price })),
          out_of_stock: variants.filter(v => v.qty <= 0).length,
          over_stock: variants.filter(v => v.qty > 50).sort((a,b) => b.qty-a.qty).slice(0,10).map(v => ({ product: v.product, qty: v.qty })),
          total: variants.length
        };
      }
      return { error: 'Unknown: ' + name };
    }

    const today = new Date();
    const yesterday = new Date(today - 86400000);

    const systemPrompt = [
      'Είσαι σύμβουλος για το eshop MYFASHIONFRUIT. Απαντάς ΠΑΝΤΑ στα ελληνικά με markdown.',
      'Σήμερα: ' + today.toISOString().split('T')[0] + ' (UTC+2). Χθες: ' + yesterday.toISOString().split('T')[0],
      'Stock: ' + analytics.total + ' variants, αξία πώλησης ' + analytics.totalStockRetail.toFixed(0) + ' EUR, μέσο margin ' + analytics.avgMargin.toFixed(1) + '%',
      'Πωλήσεις 30 ημερών: ' + (sales.orderCount30||0) + ' παραγγελίες, ' + (sales.totalRevenue30||0).toFixed(0) + ' EUR, μέσο καλάθι ' + (sales.avgOrderValue30||0).toFixed(0) + ' EUR',
      'Για αναλυτικά δεδομένα (ημερήσια, εβδομαδιαία, ανά προϊόν) χρησιμοποίησε τα functions.'
    ].join(' | ');

    const messages = [{ role: 'user', content: question }];
    let finalAnswer = '';
    let rounds = 3;

    while (rounds > 0) {
      rounds--;
      const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + process.env.OPENROUTER_API_KEY,
          'HTTP-Referer': 'https://mff-dashboard.onrender.com',
          'X-Title': 'MFF Intelligence'
        },
        body: JSON.stringify({
          model: 'minimax/minimax-m2.5',
          messages: [{ role: 'system', content: systemPrompt }, ...messages],
          tools,
          tool_choice: 'auto',
          temperature: 0.3,
          max_tokens: 2000
        })
      });

      const gd = await resp.json();
      if (gd.error) { finalAnswer = 'Σφάλμα: ' + (gd.error.message||JSON.stringify(gd.error)); break; }

      const choice = gd.choices?.[0];
      const msg = choice?.message;
      console.log('AI finish_reason:', choice?.finish_reason, 'tool_calls:', msg?.tool_calls?.length || 0);

      if (msg?.tool_calls && msg.tool_calls.length > 0) {
        messages.push({ role: 'assistant', content: msg.content || null, tool_calls: msg.tool_calls });
        for (const tc of msg.tool_calls) {
          const args = JSON.parse(tc.function.arguments || '{}');
          console.log('Calling:', tc.function.name, JSON.stringify(args));
          const result = await executeFunction(tc.function.name, args);
          messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
        }
        continue;
      }

      finalAnswer = msg?.content || 'Δεν ήρθε απάντηση';
      break;
    }

    res.json({ answer: finalAnswer });
  } catch(e) {
    console.log('AI error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

;

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'mff_dashboard.html'));
});

app.listen(PORT, () => {
  console.log('\n╔══════════════════════════════════════╗');
  console.log('║   MFF Intelligence Dashboard         ║');
  console.log('║   http://localhost:' + PORT + '             ║');
  console.log('╚══════════════════════════════════════╝\n');
});

// ── Bundle products endpoint ─────────────────────────────────
app.get('/api/bundles', async (req, res) => {
  try {
    const token = await getToken();
    let cursor = null, hasNext = true, bundles = [];
    while (hasNext) {
      const data = await gql(`
        query ($cursor: String) {
          products(first: 50, after: $cursor, query: "product_type:Bundles") {
            pageInfo { hasNextPage endCursor }
            nodes {
              id title
              variants(first: 5) {
                nodes { sku price inventoryItem { unitCost { amount } } }
              }
            }
          }
        }
      `, { cursor });
      bundles = bundles.concat(data.data?.products?.nodes || []);
      hasNext = data.data?.products?.pageInfo?.hasNextPage;
      cursor  = data.data?.products?.pageInfo?.endCursor;
    }
    res.json({ bundles, count: bundles.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
