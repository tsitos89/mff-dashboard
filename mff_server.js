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

async function fetchSalesData() {
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    
    // Paginate through ALL orders
    let allOrders = [];
    let cursor = null;
    let hasNext = true;
    
    while (hasNext) {
      const data = await gql(`
        query ($cursor: String) {
          orders(first: 250, after: $cursor, query: "created_at:>${thirtyDaysAgo} status:any", sortKey: CREATED_AT, reverse: true) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id name createdAt totalPriceSet { shopMoney { amount } }
              customer { id numberOfOrders }
              lineItems(first: 20) {
                nodes { title quantity variant { sku product { title productType } } }
              }
            }
          }
        }
      `, { cursor });

      const nodes = data.data?.orders?.nodes || [];
      allOrders = allOrders.concat(nodes);
      hasNext = data.data?.orders?.pageInfo?.hasNextPage;
      cursor = data.data?.orders?.pageInfo?.endCursor;
      console.log('Sales page fetched:', nodes.length, 'orders, total so far:', allOrders.length);
    }

    const totalRevenue30 = allOrders.reduce((s, o) => s + parseFloat(o.totalPriceSet?.shopMoney?.amount || 0), 0);
    const orderCount30 = allOrders.length;
    const avgOrderValue30 = orderCount30 > 0 ? totalRevenue30 / orderCount30 : 0;

    let newCustomers30 = 0, returningCustomers30 = 0;
    allOrders.forEach(o => {
      if (o.customer) {
        if (o.customer.numberOfOrders <= 1) newCustomers30++;
        else returningCustomers30++;
      }
    });

    const productSales = {};
    allOrders.forEach(o => {
      (o.lineItems?.nodes || []).forEach(li => {
        const title = li.variant?.product?.title || li.title;
        if (!productSales[title]) productSales[title] = { title, qty: 0 };
        productSales[title].qty += li.quantity;
      });
    });

    const topSelling = Object.values(productSales).sort((a,b) => b.qty - a.qty).slice(0, 10);

    console.log('Sales total:', orderCount30, 'orders,', totalRevenue30.toFixed(0), 'EUR');
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

    // Pre-fetch 7-day data in parallel — AI gets everything ready
    const now = new Date();
    const sevenDaysAgo = new Date(now - 7 * 86400000).toISOString();
    const yesterday = new Date(now - 86400000);
    const yesterdayStart = new Date(yesterday.setHours(0,0,0,0)).toISOString();
    const yesterdayEnd = new Date(yesterday.setHours(23,59,59,999)).toISOString();

    // Fetch 7-day orders + product sales in parallel
    const [weekOrders, weekProductSales] = await Promise.all([
      // Weekly orders
      (async () => {
        let all = [], cur = null, hn = true;
        while (hn) {
          const cs = cur ? `, after: "${cur}"` : '';
          const d = await gql(`query {
            orders(first:250${cs}, query:"created_at:>${sevenDaysAgo} status:any", sortKey:CREATED_AT, reverse:true) {
              pageInfo { hasNextPage endCursor }
              nodes { name createdAt totalPriceSet { shopMoney { amount } } customer { id numberOfOrders } lineItems(first:10) { nodes { title quantity } } }
            }
          }`);
          all = all.concat(d.data?.orders?.nodes || []);
          hn = d.data?.orders?.pageInfo?.hasNextPage;
          cur = d.data?.orders?.pageInfo?.endCursor;
        }
        return all;
      })(),
      // Weekly product sales
      (async () => {
        let all = [], cur = null, hn = true;
        while (hn) {
          const cs = cur ? `, after: "${cur}"` : '';
          const d = await gql(`query {
            orders(first:250${cs}, query:"created_at:>${sevenDaysAgo} status:any") {
              pageInfo { hasNextPage endCursor }
              nodes { lineItems(first:20) { nodes { title quantity originalUnitPriceSet { shopMoney { amount } } } } }
            }
          }`);
          all = all.concat(d.data?.orders?.nodes || []);
          hn = d.data?.orders?.pageInfo?.hasNextPage;
          cur = d.data?.orders?.pageInfo?.endCursor;
        }
        return all;
      })()
    ]);

    // Process weekly data
    const weekRevenue = weekOrders.reduce((s,o) => s + parseFloat(o.totalPriceSet?.shopMoney?.amount||0), 0);
    const weekOrderCount = weekOrders.length;

    // Product sales this week
    const weekProdMap = {};
    weekProductSales.forEach(o => {
      (o.lineItems?.nodes||[]).forEach(li => {
        if (!weekProdMap[li.title]) weekProdMap[li.title] = { title: li.title, qty: 0, revenue: 0 };
        weekProdMap[li.title].qty += li.quantity;
        weekProdMap[li.title].revenue += parseFloat(li.originalUnitPriceSet?.shopMoney?.amount||0) * li.quantity;
      });
    });
    const topWeekProducts = Object.values(weekProdMap).sort((a,b) => b.qty - a.qty).slice(0, 20);

    // Days of stock remaining per product
    const stockWithDays = data.variants
      .filter(v => v.qty > 0 && v.hasCost)
      .map(v => {
        const weekSales = weekProdMap[v.product]?.qty || 0;
        const dailyRate = weekSales / 7;
        const daysLeft = dailyRate > 0 ? Math.round(v.qty / dailyRate) : 999;
        return { product: v.product, type: v.type, qty: v.qty, price: v.price, cost: v.cost, margin: v.margin, weekSales, daysLeft };
      })
      .sort((a,b) => a.daysLeft - b.daysLeft);

    // Critical stock (< 14 days)
    const criticalStock = stockWithDays.filter(v => v.daysLeft < 14 && v.daysLeft < 999).slice(0,10);
    // Dead stock (> 90 days or no sales)
    const deadStock = stockWithDays.filter(v => v.daysLeft > 90).sort((a,b) => b.qty*b.cost - a.qty*a.cost).slice(0,10);

    console.log('Pre-fetched: weekOrders=' + weekOrderCount + ', products=' + topWeekProducts.length);

    // Build comprehensive context — NO function calls needed
    const context = [
      'Είσαι σύμβουλος για το eshop MYFASHIONFRUIT. Απαντάς ΠΑΝΤΑ στα ελληνικά με markdown.',
      'Σήμερα: ' + now.toISOString().split('T')[0],
      '',
      '=== STOCK ΑΝΑΛΥΣΗ ===',
      'Σύνολο variants: ' + analytics.total + ' | Αξία πώλησης: ' + analytics.totalStockRetail.toFixed(0) + ' EUR | Κόστος: ' + analytics.totalStockCost.toFixed(0) + ' EUR | Δυνητικό κέρδος: ' + (analytics.totalStockRetail - analytics.totalStockCost).toFixed(0) + ' EUR | Μέσο margin: ' + analytics.avgMargin.toFixed(1) + '%',
      '',
      '=== ΑΝΑ ΚΑΤΗΓΟΡΙΑ ===',
      ...analytics.categories.map(c =>
        c.name + ': ' + c.stockQty + ' τεμ | πώληση ' + c.stockRetail.toFixed(0) + ' EUR | κόστος ' + c.stockCost.toFixed(0) + ' EUR | κέρδος ' + (c.stockRetail-c.stockCost).toFixed(0) + ' EUR | margin ' + c.avgMargin.toFixed(1) + '%'
      ),
      '',
      '=== ΠΩΛΗΣΕΙΣ ΤΕΛΕΥΤΑΙΩΝ 7 ΗΜΕΡΩΝ ===',
      'Παραγγελίες: ' + weekOrderCount + ' | Έσοδα: ' + weekRevenue.toFixed(0) + ' EUR | Μέσος ημερήσιος τζίρος: ' + (weekRevenue/7).toFixed(0) + ' EUR',
      'Top προϊόντα εβδομάδας: ' + topWeekProducts.slice(0,10).map(p => p.title + ' (' + p.qty + ' τεμ, ' + p.revenue.toFixed(0) + ' EUR)').join(' | '),
      '',
      '=== ΠΩΛΗΣΕΙΣ ΤΕΛΕΥΤΑΙΩΝ 30 ΗΜΕΡΩΝ ===',
      'Παραγγελίες: ' + (sales.orderCount30||0) + ' | Έσοδα: ' + (sales.totalRevenue30||0).toFixed(0) + ' EUR | Μέσο καλάθι: ' + (sales.avgOrderValue30||0).toFixed(0) + ' EUR',
      'Νέοι πελάτες: ' + (sales.newCustomers30||0) + ' | Επαναλαμβανόμενοι: ' + (sales.returningCustomers30||0),
      '',
      '=== ΚΡΙΣΙΜΟ STOCK (τελειωνει < 14 μερες) ===',
      criticalStock.length > 0
        ? criticalStock.map(v => v.product + ': ' + v.qty + ' τεμ, ' + v.daysLeft + ' μέρες, πωλήσεις εβδ. ' + v.weekSales).join(' | ')
        : 'Κανένα προϊόν σε κρίσιμο επίπεδο',
      '',
      '=== ΝΕΚΡΟ STOCK (δεν πουλαει, > 90 μερες απομενουν) ===',
      deadStock.length > 0
        ? deadStock.map(v => v.product + ': ' + v.qty + ' τεμ, κεφάλαιο ' + (v.qty*(v.cost||0)).toFixed(0) + ' EUR').join(' | ')
        : 'Κανένα',
      '',
      '=== TOP 15 ΠΡΟΙΟΝΤΑ (αξία stock) ===',
      ...analytics.topByStockValue.slice(0,15).map(p =>
        p.product + ': ' + p.totalQty + ' τεμ | ' + p.totalRetail.toFixed(0) + ' EUR | margin ' + p.avgMargin.toFixed(1) + '%'
      ),
      '',
      'Όλα τα δεδομένα είναι live από το Shopify. Δώσε αναλυτική, πρακτική απάντηση με συγκεκριμένα νούμερα.'
    ].join('\n');

    // Single AI call — no function calling needed
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + process.env.OPENROUTER_API_KEY,
        'HTTP-Referer': 'https://mff-dashboard.onrender.com',
        'X-Title': 'MFF Intelligence'
      },
      body: JSON.stringify({
        model: 'minimax/minimax-m2.5',
        messages: [
          { role: 'system', content: context },
          { role: 'user', content: question }
        ],
        temperature: 0.3,
        max_tokens: 2000
      })
    });

    clearTimeout(timeout);
    const gd = await resp.json();

    if (gd.error) {
      console.log('AI error:', JSON.stringify(gd.error));
      return res.json({ answer: 'Σφάλμα AI: ' + (gd.error.message || JSON.stringify(gd.error)) });
    }

    const answer = gd.choices?.[0]?.message?.content || 'Δεν ήρθε απάντηση';
    console.log('AI answered, tokens:', gd.usage?.total_tokens);
    res.json({ answer });

  } catch(e) {
    console.log('AI error:', e.message);
    if (e.name === 'AbortError') {
      res.json({ answer: 'Η απάντηση άργησε. Δοκίμασε ξανά.' });
    } else {
      res.status(500).json({ error: e.message });
    }
  }
});

;

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
