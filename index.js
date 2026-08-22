require('dotenv').config();
const http = require('http');
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');

// 1. Health-Check Server (Satisfies Render Port Scan)
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('LMart Official Autonomous AI Agent Bot is active!\n');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🌐 Server listening on port ${PORT}`);
});

// 2. Clean Environment Variables
const cleanEnv = (val) => (val || '').toString().trim().replace(/[\r\n"']/g, '');

const TELEGRAM_BOT_TOKEN = cleanEnv(process.env.TELEGRAM_BOT_TOKEN);
const GEMINI_API_KEY = cleanEnv(process.env.GEMINI_API_KEY);
const GOOGLE_MAPS_API_KEY = cleanEnv(process.env.GOOGLE_MAPS_API_KEY);

if (!TELEGRAM_BOT_TOKEN) {
  console.error('❌ Error: TELEGRAM_BOT_TOKEN is missing.');
  process.exit(1);
}

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
const userSessions = new Map();
let discoveredActiveModel = null;

// Global Error Handler for Telegraf
bot.catch((err, ctx) => {
  console.error(`⚠️ Telegraf Error encountered for ${ctx.updateType}:`, err);
});

// Default coordinates fallback (Ichipatti / Samalapuram area)
const DEFAULT_LAT = 11.0168;
const DEFAULT_LNG = 77.2514;

// Helper: Escape HTML characters to prevent Telegram parse errors
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Helper: Haversine distance formula
function calculateDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth radius in km
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Helper: Safe JSON parser
function safeParseJson(raw) {
  if (!raw) return null;
  const clean = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
  try {
    return JSON.parse(clean);
  } catch {
    const match = clean.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

// Autonomous Model Discovery: Queries your API key for live supported models
async function getAvailableModel() {
  if (discoveredActiveModel) return discoveredActiveModel;

  try {
    const res = await axios.get(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_API_KEY}`,
      { timeout: 8000 }
    );
    const models = res.data?.models || [];
    
    // Filter models supporting generateContent
    const supported = models
      .filter((m) => m.supportedGenerationMethods && m.supportedGenerationMethods.includes('generateContent'))
      .map((m) => (m.name || '').replace('models/', ''));

    console.log('📋 Available models for your API key:', supported);

    // Prioritize latest Flash releases
    const preferredOrder = [
      'gemini-3.6-flash',
      'gemini-3.6',
      'gemini-3.0-flash',
      'gemini-2.5-flash',
      'gemini-2.0-flash'
    ];

    for (const pref of preferredOrder) {
      const match = supported.find((m) => m === pref || m.startsWith(pref));
      if (match) {
        discoveredActiveModel = match;
        console.log(`🎯 Auto-selected optimal model: ${discoveredActiveModel}`);
        return discoveredActiveModel;
      }
    }

    if (supported.length > 0) {
      discoveredActiveModel = supported[0];
      console.log(`🎯 Auto-selected fallback model: ${discoveredActiveModel}`);
      return discoveredActiveModel;
    }
  } catch (err) {
    console.warn('⚠️ Model list discovery failed:', err.response?.data?.error?.message || err.message);
  }

  // Last-resort fallback
  return 'gemini-3.6-flash';
}

// 3. /start command
bot.start((ctx) => {
  const welcomeText = 
    `👋 <b>Welcome to LMart</b> — Your Autonomous AI Shopping Agent!\n` +
    `<b>எல்மார்ட்</b> — அனைத்து பொருட்களையும் அருகிலுள்ள கடைகளில் கண்டறியும் AI உதவியாளர்!\n\n` +
    `Type any item in <b>English, தமிழ், or Tanglish</b>:\n` +
    `• <i>"1 inch PVC pipe"</i>\n` +
    `• <i>"Dolo 650"</i> or <i>"பாராசிட்டமால்"</i>\n` +
    `• <i>"Brownie cake"</i>\n` +
    `• <i>"Type-C fast charger"</i>\n\n` +
    `📍 Please share your live location below to find the nearest stores &amp; phone numbers.`;

  ctx.reply(welcomeText, {
    parse_mode: 'HTML',
    ...Markup.keyboard([
      [Markup.button.locationRequest('📍 Share Live Location / இருப்பிடம்')]
    ]).resize().oneTime()
  });
});

// 4. Handle Location sharing
bot.on('location', (ctx) => {
  const { latitude, longitude } = ctx.message.location;
  const current = userSessions.get(ctx.chat.id) || {};
  userSessions.set(ctx.chat.id, { 
    ...current,
    latitude: Number(latitude) || DEFAULT_LAT, 
    longitude: Number(longitude) || DEFAULT_LNG 
  });

  ctx.reply(
    `✅ Location received / இருப்பிடம் பெறப்பட்டது!\n\nWhat product do you want to find? / என்ன பொருள் வேண்டும்?`,
    Markup.removeKeyboard()
  );
});

// 5. STEP 1: Autonomous AI Analyzes Product with CoT Reasoning
bot.on('text', async (ctx) => {
  const queryText = ctx.message.text.trim();
  const chatId = ctx.chat.id;

  if (queryText.startsWith('/')) return;

  const session = userSessions.get(chatId) || { latitude: DEFAULT_LAT, longitude: DEFAULT_LNG };
  const statusMsg = await ctx.reply(`🧠 AI Agent is analyzing "${escapeHtml(queryText)}"...`, { parse_mode: 'HTML' });

  try {
    const aiDecision = await runAIAgent(queryText);

    session.pendingSearch = aiDecision;
    userSessions.set(chatId, session);

    const isTamil = aiDecision.language === 'ta' || aiDecision.language === 'tanglish';

    const confirmText = isTamil
      ? `🎯 <b>AI பொருள் வகை அடையாளம்:</b>\n\n` +
        `📦 <b>பொருள்:</b> ${escapeHtml(aiDecision.localizedName || aiDecision.productName)}\n` +
        `🏷️ <b>வகை:</b> ${escapeHtml(aiDecision.category)}\n` +
        `🏬 <b>தேடப்படும் கடை வகை:</b> ${escapeHtml(aiDecision.headingLabelTamil || aiDecision.headingLabel)}\n\n` +
        `இந்த கடைகளை உங்கள் இருப்பிடத்திற்கு அருகில் தேடவா?`
      : `🎯 <b>AI Category Identification:</b>\n\n` +
        `📦 <b>Product:</b> ${escapeHtml(aiDecision.productName)}\n` +
        `🏷️ <b>Category:</b> ${escapeHtml(aiDecision.category)}\n` +
        `🏬 <b>Target Stores:</b> ${escapeHtml(aiDecision.headingLabel)}\n\n` +
        `Shall I search for verified <b>${escapeHtml(aiDecision.headingLabel)}</b> near your location?`;

    const confirmBtnText = isTamil ? '✅ ஆம், அருகிலுள்ள கடைகளை தேடு' : '✅ Yes, Find Nearest Stores';
    const cancelBtnText = isTamil ? '❌ ரத்து செய்' : '❌ Cancel';

    await ctx.telegram.editMessageText(
      chatId,
      statusMsg.message_id,
      null,
      confirmText,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback(confirmBtnText, 'confirm_search')],
          [Markup.button.callback(cancelBtnText, 'cancel_search')]
        ])
      }
    );

  } catch (err) {
    console.error('AI Processing Error:', err);
    await ctx.telegram.editMessageText(
      chatId,
      statusMsg.message_id,
      null,
      `⚠️ AI Error: ${escapeHtml(err.message)}\nPlease try again in a moment.`
    );
  }
});

// 6. STEP 2: User Confirms -> Queries Google Places API v1 with Retail Filtering
bot.action('confirm_search', async (ctx) => {
  const chatId = ctx.chat.id;
  const session = userSessions.get(chatId);

  if (!session || !session.pendingSearch) {
    return ctx.reply('⚠️ Session expired. Please send your product query again.');
  }

  const aiDecision = session.pendingSearch;
  const isTamil = aiDecision.language === 'ta' || aiDecision.language === 'tanglish';

  await ctx.answerCbQuery();
  await ctx.editMessageText(`🔍 Finding verified <b>${escapeHtml(aiDecision.headingLabel)}</b> near you...`, { parse_mode: 'HTML' });

  try {
    const stores = await searchHyperlocalStores(
      aiDecision.placeTypes,
      aiDecision.cleanQuery,
      session.latitude,
      session.longitude
    );

    let responseText = isTamil ? `🛒 <b>எல்மார்ட் AI முடிவு (LMart)</b>\n` : `🛒 <b>LMart Stock Finder</b>\n`;
    responseText += isTamil 
      ? `<b>பொருள்:</b> ${escapeHtml(aiDecision.localizedName || aiDecision.productName)}\n` 
      : `<b>Item:</b> ${escapeHtml(aiDecision.productName)}\n`;
    responseText += isTamil 
      ? `<b>வகை:</b> ${escapeHtml(aiDecision.category)}\n\n` 
      : `<b>Category:</b> ${escapeHtml(aiDecision.category)}\n\n`;

    const inlineButtons = [];

    if (stores && stores.length > 0) {
      const headingText = isTamil
        ? `உங்களுக்கு மிக அருகிலுள்ள <b>${stores.length} ${escapeHtml(aiDecision.headingLabelTamil || 'கடைகள்')}</b>:\n\n`
        : `Nearest <b>${stores.length} Verified ${escapeHtml(aiDecision.headingLabel)}</b>:\n\n`;

      responseText += headingText;

      stores.slice(0, 4).forEach((store, index) => {
        const rating = store.rating ? `⭐ ${store.rating} (${store.user_ratings_total || 0})` : '⭐ Verified Retailer';
        const openStatus = store.open_now 
          ? (isTamil ? '🟢 இப்போது திறந்துள்ளது' : '🟢 Open Now')
          : (isTamil ? '⚪ நிலை அறியப்படவில்லை' : '⚪ Status Unverified');

        const distFormatted = store.distanceKm < 1 
          ? `${Math.round(store.distanceKm * 1000)} m` 
          : `${store.distanceKm.toFixed(1)} km`;

        const phoneFormatted = store.phone 
          ? `\n📞 <b>Phone:</b> <code>${escapeHtml(store.phone)}</code>` 
          : `\n📞 <b>Phone:</b> Not listed on Maps`;

        responseText += `<b>${index + 1}. ${escapeHtml(store.name)}</b> (📍 <b>${distFormatted}</b>)\n`;
        responseText += `📌 ${escapeHtml(store.formatted_address)}\n`;
        responseText += `${rating} | ${openStatus}${phoneFormatted}\n\n`;

        const navUrl = `https://www.google.com/maps/dir/?api=1&destination=${store.lat},${store.lng}&destination_place_id=${store.place_id || ''}`;
        const dirBtnText = isTamil 
          ? `🗺️ வழிப்பாதை (${distFormatted}): ${store.name.substring(0, 14)}` 
          : `🗺️ Directions (${distFormatted}): ${store.name.substring(0, 16)}`;
        
        inlineButtons.push([Markup.button.url(dirBtnText, navUrl)]);
      });
    } else {
      responseText += isTamil
        ? `📍 அருகிலுள்ள குறிப்பிட்ட கடைகள் கிடைக்கவில்லை. கூகிள் மேப்பில் பார்க்க கீழே தொடவும்:`
        : `📍 No verified physical retail stores found within 5 km. Tap below to explore Google Maps:`;
    }

    const directSearchUrl = `https://www.google.com/maps/search/${encodeURIComponent(aiDecision.cleanQuery + ' store')}/@${session.latitude},${session.longitude},15z`;
    const exploreText = isTamil 
      ? `📍 மேப்பில் அனைத்து "${escapeHtml(aiDecision.cleanQuery)}" பார்க்க` 
      : `📍 Explore all "${escapeHtml(aiDecision.cleanQuery)}" on Maps`;

    inlineButtons.push([Markup.button.url(exploreText, directSearchUrl)]);

    await ctx.editMessageText(responseText, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard(inlineButtons)
    });

  } catch (error) {
    console.error('Store Search Error:', error);
    ctx.reply('⚠️ Error locating stores. Please try again.');
  }
});

// Handle Cancel Action
bot.action('cancel_search', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('❌ Search cancelled. Send another product name anytime!');
});

// 7. Autonomous Agentic Reasoner Powered by Direct REST with CoT
async function runAIAgent(userInput) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not configured in environment.');
  }

  const activeModel = await getAvailableModel();

  const systemInstruction = `
You are an autonomous hyper-local retail reasoning agent specialized in the retail trade landscape of Tamil Nadu & South India.
Your goal is to perform multi-step cognitive reasoning to determine the exact physical store type that stocks the user's item.

### Agentic Cognitive Process:
1. Analyze Language & Entity:
   - Detect if the input is English, Tamil script, or Tanglish.
   - Extract canonical product and resolve brand names or colloquial terms (e.g., "Dolo" -> Paracetamol, "Fevikwik" -> Instant Adhesive, "1 inch CPVC" -> Plumbing Pipe).
2. Retail Context Reasoning (Indian Market Dynamics):
   - Focus on physical RETAIL SHOPS with walk-in counters, not individual contractors or factories:
     * Hardware / Electrical Stores: PVC/CPVC pipes, sanitaryware, wires, switchboards, tools, paints.
     * Pharmacies / Medical Shops: Prescription drugs, OTC meds, baby care, sanitizers.
     * Bakeries / Sweet Stalls: Birthday cakes, pastries, snacks, tea.
     * Stationery & Fancy Stores: Notebooks, pens, cosmetics, gifts.
     * Provision / Kirana Stores: Groceries, spices, cooking oils.
     * Automobile Spares / Tyre Shops: Bike/car spares, lubricants, helmets.
     * Mobile & Electronics: Cables, fast chargers, earphones, gadgets.
3. Search Query Formulation:
   - "cleanQuery" MUST contain explicit retail words like "hardware plumbing electrical store", "medical shop pharmacy", "bakery cake shop", "mobile accessories shop".

Return strictly valid JSON in this exact structure:
{
  "reasoning": {
    "intentAnalysis": "Step 1 reasoning string",
    "marketStockLocation": "Step 2 reasoning string",
    "targetStrategy": "Step 3 reasoning string"
  },
  "language": "en" | "ta" | "tanglish",
  "productName": "string",
  "localizedName": "string",
  "category": "string",
  "headingLabel": "string",
  "headingLabelTamil": "string",
  "placeTypes": ["string"],
  "cleanQuery": "string"
}
`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${activeModel}:generateContent?key=${GEMINI_API_KEY}`;
  
  const payload = {
    systemInstruction: {
      parts: [{ text: systemInstruction }]
    },
    contents: [
      {
        parts: [{ text: `Perform multi-step agent reasoning for this item search: "${userInput}"` }]
      }
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.1
    }
  };

  try {
    const res = await axios.post(url, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000
    });

    const rawText = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    const decision = safeParseJson(rawText);

    if (decision && decision.category && decision.placeTypes && decision.placeTypes.length > 0) {
      console.log(`✅ Reasoning success via ${activeModel}`);
      console.log('🤖 [Agentic CoT Analysis]:');
      console.log(` ↳ Intent: ${decision.reasoning?.intentAnalysis}`);
      console.log(` ↳ Market Logic: ${decision.reasoning?.marketStockLocation}`);
      console.log(` ↳ Search Strategy: ${decision.reasoning?.targetStrategy}`);
      return decision;
    }
    throw new Error('Invalid JSON structure returned by model');
  } catch (err) {
    discoveredActiveModel = null;
    const apiErrMsg = err.response?.data?.error?.message || err.message;
    throw new Error(apiErrMsg);
  }
}

// 8. Hyperlocal Google Places API Search with Retail & Non-Store Filtering
async function searchHyperlocalStores(placeTypes, cleanQuery, lat, lng) {
  if (!GOOGLE_MAPS_API_KEY) return [];

  const validLat = Number(lat) || DEFAULT_LAT;
  const validLng = Number(lng) || DEFAULT_LNG;
  const headers = {
    'Content-Type': 'application/json',
    'X-Goog-Api-Key': GOOGLE_MAPS_API_KEY,
    'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.currentOpeningHours,places.location,places.nationalPhoneNumber,places.internationalPhoneNumber,places.types,places.primaryType'
  };

  let rawPlaces = [];

  // Strategy A: Targeted text search with explicit retail shop context
  try {
    const textQuery = `${cleanQuery} store shop`.trim();
    const response = await axios.post(
      'https://places.googleapis.com/v1/places:searchText',
      {
        textQuery,
        locationBias: {
          circle: {
            center: { latitude: validLat, longitude: validLng },
            radius: 5000.0
          }
        },
        maxResultCount: 15
      },
      { headers, timeout: 6000 }
    );
    rawPlaces = response.data?.places || [];
  } catch (e) {
    console.warn("searchText notice:", e.message);
  }

  // Strategy B: searchNearby fallback if text search yielded insufficient results
  if (rawPlaces.length < 4 && placeTypes && placeTypes.length > 0) {
    try {
      const response = await axios.post(
        'https://places.googleapis.com/v1/places:searchNearby',
        {
          includedTypes: placeTypes,
          locationRestriction: {
            circle: {
              center: { latitude: validLat, longitude: validLng },
              radius: 5000.0
            }
          },
          rankPreference: "DISTANCE",
          maxResultCount: 15
        },
        { headers, timeout: 6000 }
      );
      const nearbyPlaces = response.data?.places || [];
      // Merge unique places
      const existingIds = new Set(rawPlaces.map(p => p.id));
      for (const np of nearbyPlaces) {
        if (!existingIds.has(np.id)) {
          rawPlaces.push(np);
        }
      }
    } catch (e) {
      console.warn("searchNearby notice:", e.message);
    }
  }

  // Strict Negative Keyword Filter (excludes individual persons, manufacturing plants, precast, creations)
  const blacklistPatterns = [
    /\b(works|work|fabrication|precast|cement works|hollow blocks|creations|contractor|technician|service center|service centre|repair shop|consultancy|enterprises pvt|factory|foundry|spinning mill|mills|textiles mill|godown|warehouse)\b/i,
    /^(mr\.|dr\.|er\.)/i,
    /(ஒர்க்ஸ்|ஒர்க்|ஃபேப்ரிகேஷன்|சிமெண்ட் ஒர்க்ஸ்|ப்ளாக்ஸ்|மில்)/i
  ];

  // Positive Retail Signals
  const retailPatterns = [
    /\b(hardware|hardwares|electrical|electricals|plumbing|sanitary|sanitaryware|pipe|pipes|traders|agency|agencies|store|stores|mart|shop|medical|medicals|pharmacy|bakery|bakes|cakes|sweets|automobiles|auto spares|fancy|stationery|supermarket|maligai)\b/i,
    /(ஹார்டுவேர்|எலக்ட்ரிக்கல்ஸ்|பிளம்பிங்|டிரேடர்ஸ்|ஏஜென்சி|ஸ்டோர்|ஸ்டோர்ஸ்|மார்ட்|கடை|மெடிக்கல்|பார்மசி|பேக்கரி|ஸ்வீட்ஸ்|ஆட்டோ|ஸ்பேர்ஸ்|மளிகை)/i
  ];

  const filteredPlaces = rawPlaces.filter((p) => {
    const name = p.displayName?.text || '';
    
    // Check if name hits any blacklist filter
    const isBlacklisted = blacklistPatterns.some((pattern) => pattern.test(name));
    if (isBlacklisted) return false;

    // Reject 2-word plain personal names without business suffixes (e.g., "Ganesan Vellingiri")
    const words = name.trim().split(/\s+/);
    if (words.length === 2 && !retailPatterns.some((pat) => pat.test(name))) {
      // If it contains only alphabetic personal name structure, drop it
      const isPlainName = /^[A-Za-z\s]+$/.test(name) && !/(trader|agency|mart|shop|store|paints|pipe|pvc|steel|hard)/i.test(name);
      if (isPlainName) return false;
    }

    return true;
  });

  // Calculate physical distance & sort closest first
  const storesWithDistance = filteredPlaces.map((p) => {
    const pLat = p.location?.latitude || validLat;
    const pLng = p.location?.longitude || validLng;
    const dist = calculateDistanceKm(validLat, validLng, pLat, pLng);

    return {
      name: p.displayName?.text || 'Local Store',
      formatted_address: p.formattedAddress || 'Nearby',
      rating: p.rating,
      user_ratings_total: p.userRatingCount,
      open_now: p.currentOpeningHours?.openNow,
      phone: p.nationalPhoneNumber || p.internationalPhoneNumber || '',
      lat: pLat,
      lng: pLng,
      distanceKm: dist,
      place_id: p.id || ''
    };
  });

  storesWithDistance.sort((a, b) => a.distanceKm - b.distanceKm);
  return storesWithDistance;
}

// 9. Launch Bot
bot.launch().then(() => {
  console.log('🚀 LMart Official Agentic AI Bot is active...');
});

// 10. Clean Graceful Shutdown
const shutdown = () => {
  bot.stop();
  server.close(() => process.exit(0));
};

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
