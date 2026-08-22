require('dotenv').config();
const http = require('http');
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');

// 1. Health-Check Server (Satisfies Render Port Scan)
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('LMart Auto-Model Discovery AI Bot is active!\n');
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

// Default coordinates fallback (Ichipatti / Samalapuram area: 11.0168, 77.2514)
const DEFAULT_LAT = 11.0168;
const DEFAULT_LNG = 77.2514;

// Cache active Gemini model name
let activeGeminiModel = null;

// Helper: Calculate Exact Distance in Kilometers (Haversine formula)
function calculateDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// 3. /start command
bot.start((ctx) => {
  const welcomeText = 
    `👋 *Welcome to LMart* — Your Autonomous AI Shopping Agent!\n` +
    `*எல்மார்ட்* — அனைத்து பொருட்களையும் அருகிலுள்ள கடைகளில் கண்டறியும் AI உதவியாளர்!\n\n` +
    `Type any item in *English, தமிழ், or Tanglish*:\n` +
    `• *"1 inch PVC pipe"*\n` +
    `• *"Dolo 650"* or *"பாராசிட்டமால்"*\n` +
    `• *"Brownie cake"*\n` +
    `• *"Type-C fast charger"*\n\n` +
    `📍 Please share your live location below to find the nearest stores & phone numbers.`;

  ctx.reply(welcomeText, {
    parse_mode: 'Markdown',
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

// 5. STEP 1: AI Analyzes Product & Asks Acknowledgment
bot.on('text', async (ctx) => {
  const queryText = ctx.message.text.trim();
  const chatId = ctx.chat.id;

  if (queryText.startsWith('/')) return;

  const session = userSessions.get(chatId) || { latitude: DEFAULT_LAT, longitude: DEFAULT_LNG };
  const statusMsg = await ctx.reply(`🧠 AI Agent is analyzing "${queryText}"...`);

  try {
    // Run AI Semantic Reasoning with Dynamic Model Discovery
    const aiDecision = await runAIAgent(queryText);

    // Save decision in session
    session.pendingSearch = aiDecision;
    userSessions.set(chatId, session);

    const isTamil = aiDecision.language === 'ta' || aiDecision.language === 'tanglish';

    const confirmText = isTamil
      ? `🎯 *AI பொருள் வகை அடையாளம்:*\n\n` +
        `📦 *பொருள்:* ${aiDecision.localizedName || aiDecision.productName}\n` +
        `🏷️ *வகை:* ${aiDecision.category}\n` +
        `🏬 *தேடப்படும் கடை வகை:* ${aiDecision.headingLabelTamil || aiDecision.headingLabel}\n\n` +
        `இந்த கடைகளை உங்கள் இருப்பிடத்திற்கு அருகில் தேடவா?`
      : `🎯 *AI Category Identification:*\n\n` +
        `📦 *Product:* ${aiDecision.productName}\n` +
        `🏷️ *Category:* ${aiDecision.category}\n` +
        `🏬 *Target Stores:* ${aiDecision.headingLabel}\n\n` +
        `Shall I search for verified *${aiDecision.headingLabel}* near your location?`;

    const confirmBtnText = isTamil ? '✅ ஆம், அருகிலுள்ள கடைகளை தேடு' : '✅ Yes, Find Nearest Stores';
    const cancelBtnText = isTamil ? '❌ ரத்து செய்' : '❌ Cancel';

    await ctx.telegram.editMessageText(
      chatId,
      statusMsg.message_id,
      null,
      confirmText,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback(confirmBtnText, 'confirm_search')],
          [Markup.button.callback(cancelBtnText, 'cancel_search')]
        ])
      }
    );

  } catch (err) {
    console.error('AI Processing Error:', err);
    ctx.telegram.editMessageText(
      chatId,
      statusMsg.message_id,
      null,
      `⚠️ AI Error: ${err.message}\nMake sure Generative Language API is enabled for your GEMINI_API_KEY.`
    );
  }
});

// 6. STEP 2: User Acknowledges -> Queries Google Places
bot.action('confirm_search', async (ctx) => {
  const chatId = ctx.chat.id;
  const session = userSessions.get(chatId);

  if (!session || !session.pendingSearch) {
    return ctx.reply('⚠️ Session expired. Please send your product query again.');
  }

  const aiDecision = session.pendingSearch;
  const isTamil = aiDecision.language === 'ta' || aiDecision.language === 'tanglish';

  await ctx.answerCbQuery();
  await ctx.editMessageText(`🔍 Finding nearest *${aiDecision.headingLabel}* within 5 km...`, { parse_mode: 'Markdown' });

  try {
    const stores = await searchHyperlocalStores(
      aiDecision.placeTypes,
      aiDecision.cleanQuery,
      session.latitude,
      session.longitude
    );

    let responseText = isTamil ? `🛒 *எல்மார்ட் AI முடிவு (LMart)*\n` : `🛒 *LMart Stock Finder*\n`;
    responseText += isTamil ? `*பொருள்:* ${aiDecision.localizedName || aiDecision.productName}\n` : `*Item:* ${aiDecision.productName}\n`;
    responseText += isTamil ? `*வகை:* ${aiDecision.category}\n\n` : `*Category:* ${aiDecision.category}\n\n`;

    const inlineButtons = [];

    if (stores && stores.length > 0) {
      const headingText = isTamil
        ? `உங்களுக்கு மிக அருகிலுள்ள *${stores.length} ${aiDecision.headingLabelTamil || 'கடைகள்'}*:\n\n`
        : `Nearest *${stores.length} ${aiDecision.headingLabel}* (Ranked by Proximity):\n\n`;

      responseText += headingText;

      stores.slice(0, 4).forEach((store, index) => {
        const rating = store.rating ? `⭐ ${store.rating} (${store.user_ratings_total || 0})` : '⭐ Verified';
        const openStatus = store.open_now 
          ? (isTamil ? '🟢 இப்போது திறந்துள்ளது' : '🟢 Open Now')
          : (isTamil ? '⚪ திறந்த நிலை அறியப்படவில்லை' : '⚪ Status Unverified');

        const distFormatted = store.distanceKm < 1 
          ? `${Math.round(store.distanceKm * 1000)} m` 
          : `${store.distanceKm.toFixed(1)} km`;

        const phoneFormatted = store.phone 
          ? `\n📞 *Phone:* \`${store.phone}\`` 
          : `\n📞 *Phone:* Not listed on Maps`;

        responseText += `*${index + 1}. ${store.name}* (📍 *${distFormatted}*)\n`;
        responseText += `📌 ${store.formatted_address}\n`;
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
        : `📍 No matching ${aiDecision.headingLabel} found within 5 km. Tap below to explore Google Maps:`;
    }

    // Direct Google Maps Explore button
    const directSearchUrl = `https://www.google.com/maps/search/${encodeURIComponent(aiDecision.cleanQuery)}/@${session.latitude},${session.longitude},15z`;
    const exploreText = isTamil 
      ? `📍 மேப்பில் அனைத்து "${aiDecision.cleanQuery}" பார்க்க` 
      : `📍 Explore all "${aiDecision.cleanQuery}" on Maps`;

    inlineButtons.push([Markup.button.url(exploreText, directSearchUrl)]);

    await ctx.editMessageText(responseText, {
      parse_mode: 'Markdown',
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

// Helper: Safe JSON Parser
function safeJsonParse(text) {
  if (!text) return null;
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (err) {
        return null;
      }
    }
    return null;
  }
}

// 🔍 Helper: Automatically Discover the Working Gemini Model for Your Account
async function discoverWorkingGeminiModel() {
  if (activeGeminiModel) return activeGeminiModel;

  try {
    const listRes = await axios.get(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(GEMINI_API_KEY)}`,
      { timeout: 5000 }
    );
    const models = listRes.data?.models || [];
    const supported = models.find(m => 
      m.supportedGenerationMethods?.includes('generateContent') && 
      (m.name.includes('flash') || m.name.includes('gemini'))
    );
    if (supported) {
      activeGeminiModel = supported.name.replace('models/', '');
      console.log(`✅ Automatically Selected Active Gemini Model: ${activeGeminiModel}`);
      return activeGeminiModel;
    }
  } catch (e) {
    console.warn('Model list auto-discovery failed, using fallback list:', e.message);
  }

  return 'gemini-1.5-flash-latest';
}

// 🧠 Autonomous AI Agent with Dynamic Model Discovery
async function runAIAgent(userInput) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not configured in Render Environment Variables.');
  }

  const prompt = `
  You are an expert AI retail shopping agent for Tamil Nadu, India.
  User Search: "${userInput}".
  
  Determine the exact physical retail shop in India where this item is sold.
  
  Rules:
  1. Detect language: "en", "ta" (Tamil script), or "tanglish" (Tamil words in English script).
  2. "productName": Clean canonical item name.
  3. "localizedName": Tamil translation of the product name.
  4. "category": Descriptive category with emoji (e.g., "🔧 Hardware, Electricals & Plumbing", "💊 Pharmacy & Healthcare", "🎂 Bakery & Cake Shop", "🔌 Mobile & Electronics", "🐾 Pet Care & Food", "👗 Clothing & Textiles", "🚗 Auto Spares & Garage", "📚 Stationery & Books").
  5. "headingLabel": Plural target store name in English (e.g., "Hardware & Plumbing Stores", "Medicals & Pharmacies", "Bakeries & Cake Shops", "Mobile Accessories Stores", "Pet Shops").
  6. "headingLabelTamil": Plural target store name in Tamil (e.g., "ஹார்டுவேர் கடைகள்", "மருந்தகங்கள்", "பேக்கரி & கேக் கடைகள்", "மொபைல் கடைகள்").
  7. "placeTypes": 1 or 2 matching official Google Place Types:
     ["hardware_store", "electrical_supply_store", "home_improvement_store", "pharmacy", "drugstore", "bakery", "cafe", "cell_phone_store", "electronics_store", "pet_store", "clothing_store", "auto_parts_store", "car_repair", "motorcycle_repair", "book_store", "supermarket", "grocery_store", "beauty_salon", "cosmetics_store", "florist"].
     (NEVER use generic "store" or "supermarket" for hardware, medicines, cakes, or electronics).
  8. "cleanQuery": A short 2-3 word natural search query for Google Maps (e.g., "hardware electrical plumbing", "medical shop pharmacy", "bakery cake shop", "mobile accessories").
  
  Return strictly valid JSON in this exact structure:
  {
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

  // Auto-discover model or try supported list
  const discovered = await discoverWorkingGeminiModel();
  const modelsToTry = [discovered, 'gemini-1.5-flash-latest', 'gemini-1.5-flash-002', 'gemini-2.0-flash', 'gemini-1.5-pro'];

  let lastError = null;

  for (const model of modelsToTry) {
    try {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
      const response = await axios.post(
        endpoint,
        {
          contents: [{ parts: [{ text: prompt }] }]
        },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 8000
        }
      );

      const rawText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
      const parsed = safeJsonParse(rawText);
      if (parsed && parsed.category && parsed.placeTypes && parsed.placeTypes.length > 0) {
        activeGeminiModel = model; // Cache working model
        return parsed;
      }
    } catch (err) {
      lastError = err;
      console.warn(`Model ${model} attempt failed: ${err.message}`);
    }
  }

  throw new Error(`AI Classification failed: ${lastError?.response?.data?.error?.message || lastError?.message || 'Check Gemini API Key'}`);
}

// Helper: Hyperlocal Google Places Search
async function searchHyperlocalStores(placeTypes, cleanQuery, lat, lng) {
  if (!GOOGLE_MAPS_API_KEY) {
    return [];
  }

  const validLat = Number(lat) || DEFAULT_LAT;
  const validLng = Number(lng) || DEFAULT_LNG;
  const headers = {
    'Content-Type': 'application/json',
    'X-Goog-Api-Key': GOOGLE_MAPS_API_KEY,
    'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.currentOpeningHours,places.location,places.nationalPhoneNumber,places.internationalPhoneNumber'
  };

  let places = [];

  // Strategy A: searchNearby using AI's exact Place Types (Distance Ranked)
  if (placeTypes && placeTypes.length > 0) {
    try {
      const nearbyUrl = `https://places.googleapis.com/v1/places:searchNearby`;
      const response = await axios.post(
        nearbyUrl,
        {
          includedTypes: placeTypes,
          locationRestriction: {
            circle: {
              center: { latitude: validLat, longitude: validLng },
              radius: 5000.0 // 5 km radius
            }
          },
          rankPreference: "DISTANCE",
          maxResultCount: 8
        },
        { headers, timeout: 6000 }
      );
      places = response.data?.places || [];
    } catch (e) {
      console.warn("searchNearby by types error:", e.message);
    }
  }

  // Strategy B: Fallback to searchText with AI's clean query
  if (!places || places.length === 0) {
    try {
      const textUrl = `https://places.googleapis.com/v1/places:searchText`;
      const response = await axios.post(
        textUrl,
        {
          textQuery: String(cleanQuery || 'store').trim(),
          locationBias: {
            circle: {
              center: { latitude: validLat, longitude: validLng },
              radius: 5000.0
            }
          },
          maxResultCount: 8
        },
        { headers, timeout: 6000 }
      );
      places = response.data?.places || [];
    } catch (e) {
      console.warn("searchText fallback error:", e.message);
    }
  }

  // Calculate physical distance & sort
  const storesWithDistance = places.map((p) => {
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

// Launch Bot
bot.launch().then(() => {
  console.log('🚀 LMart Auto-Model Discovery Bot is running...');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
