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

async function getData(forceRefresh = false) {
  if (!forceRefresh && dataCache && Date.now() - cacheTime < 5 * 60 * 1000) return dataCache;
  console.log('Fetching from Shopify...');
  const variants  = await fetchAllVariants();
  const analytics = computeAnalytics(variants);
  dataCache = { variants, analytics, fetchedAt: new Date().toISOString() };
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
    if (!process.env.OPENROUTER_API_KEY) return res.status(400).json({ error: 'GEMINI_API_KEY δεν έχει οριστεί' });
    const { question } = req.body;
    const data = await getData();
    const { analytics } = data;

    const context = [
      'Είσαι σύμβουλος για το eshop MYFASHIONFRUIT (myfashionfruit.com) - γυναικείο eshop με ρούχα, κοσμήματα, αξεσουάρ.',
      '',
      'LIVE ΔΕΔΟΜΕΝΑ SHOPIFY:',
      'Σύνολο variants: ' + analytics.total,
      'Variants με cost: ' + analytics.withCost + ' (' + analytics.coveragePct + '%)',
      'Stock (τεμάχια): ' + analytics.totalStockQty,
      'Αξία stock κόστος: ' + analytics.totalStockCost.toFixed(0) + ' EUR',
      'Αξία stock πώληση: ' + analytics.totalStockRetail.toFixed(0) + ' EUR',
      'Μέσο margin: ' + analytics.avgMargin.toFixed(1) + '%',
      '',
      'ΑΝΑ ΚΑΤΗΓΟΡΙΑ:',
      ...analytics.categories.map(c => c.name + ': ' + c.stockQty + ' τεμ, κόστος ' + c.stockCost.toFixed(0) + ' EUR, πώληση ' + c.stockRetail.toFixed(0) + ' EUR, margin ' + c.avgMargin.toFixed(1) + '%'),
      '',
      'TOP 10 ΠΡΟΙΟΝΤΑ (αξία stock):',
      ...analytics.topByStockValue.slice(0,10).map(p => p.product + ': ' + p.totalQty + ' τεμ, ' + p.totalRetail.toFixed(0) + ' EUR, margin ' + p.avgMargin.toFixed(1) + '%'),
      '',
      'TOP 10 MARGIN:',
      ...analytics.topByMargin.slice(0,10).map(p => p.product + ': ' + p.avgMargin.toFixed(1) + '%, αξία ' + p.totalRetail.toFixed(0) + ' EUR'),
      '',
      'Απάντα στα ελληνικά με πρακτικές συμβουλές και νούμερα.',
      '',
      'Ερώτηση: ' + question
    ].join('\n');

    // OpenRouter API — αλλαξε το model εδω αν θες:
    // 'google/gemini-2.0-flash-exp:free'  → Gemini 2.0 Flash (δωρεαν)
    // 'meta-llama/llama-3.3-70b-instruct' → Llama 3.3 70B
    // 'anthropic/claude-3.5-haiku'        → Claude 3.5 Haiku (πιο έξυπνο)
    const MODEL = 'google/gemini-2.0-flash-exp:free';

    const orRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + process.env.OPENROUTER_API_KEY,
        'HTTP-Referer': 'https://mff-dashboard.onrender.com',
        'X-Title': 'MFF Intelligence Dashboard'
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: context }],
        temperature: 0.7,
        max_tokens: 1500
      })
    });
    const gd = await orRes.json();
    const answer = gd.choices?.[0]?.message?.content || JSON.stringify(gd);
    res.json({ answer });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

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
