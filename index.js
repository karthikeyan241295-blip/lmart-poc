require('dotenv').config();
const http = require('http');
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');

// 1. Health-Check Server (Satisfies Render Port Scan)
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('LMart Pure AI Shopping Agent is active!\n');
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
    `Ask for *ANY* product in *English, தமிழ், or Tanglish*:\n` +
    `• *"Dolo 650"* or *"பாராசிட்டமால்"*\n` +
    `• *"Brownie cake"*\n` +
    `• *"Type-C fast charger"*\n` +
    `• *"1 inch PVC pipe"*\n` +
    `• *"Pedigree dog food"*\n\n` +
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
  userSessions.set(ctx.chat.id, { 
    latitude: Number(latitude) || DEFAULT_LAT, 
    longitude: Number(longitude) || DEFAULT_LNG 
  });

  ctx.reply(
    `✅ Location received / இருப்பிடம் பெறப்பட்டது!\n\nWhat product do you want to find? / என்ன பொருள் வேண்டும்?`,
    Markup.removeKeyboard()
  );
});

// 5. Handle Product Search Query (100% Agentic AI Driven)
bot.on('text', async (ctx) => {
  const queryText = ctx.message.text.trim();
  const chatId = ctx.chat.id;

  if (queryText.startsWith('/')) return;

  const session = userSessions.get(chatId) || { latitude: DEFAULT_LAT, longitude: DEFAULT_LNG };
  const statusMsg = await ctx.reply(`🧠 AI Agent is analyzing product & discovering nearest stores...`);

  try {
    // Step A: Full Autonomous AI Semantic Reasoning (No if/else conditions)
    const agentDecision = await runAIAgent(queryText);

    // Step B: Query Google Places using AI-decided parameters
    let stores = [];
    try {
      stores = await searchHyperlocalStores(
        agentDecision.placeTypes,
        agentDecision.cleanQuery,
        session.latitude,
        session.longitude
      );
    } catch (err) {
      console.warn('Google Places API notice:', err.message);
    }

    // Step C: Dynamic Response Formatting based on AI decisions
    const isTamil = agentDecision.language === 'ta' || agentDecision.language === 'tanglish';
    
    let responseText = isTamil ? `🛒 *எல்மார்ட் AI தேடல் (LMart)*\n` : `🛒 *LMart AI Stock Finder*\n`;
    responseText += isTamil ? `*பொருள்:* ${agentDecision.localizedName || agentDecision.productName}\n` : `*Item:* ${agentDecision.productName}\n`;
    responseText += isTamil ? `*வகை:* ${agentDecision.category}\n\n` : `*Category:* ${agentDecision.category}\n\n`;

    const inlineButtons = [];

    if (stores && stores.length > 0) {
      const headingText = isTamil
        ? `உங்களுக்கு மிக அருகிலுள்ள *${stores.length} ${agentDecision.headingLabelTamil || 'கடைகள்'}* (தூரத்தின்படி):\n\n`
        : `Nearest *${stores.length} ${agentDecision.headingLabel || 'Stores'}* (Ranked by Distance):\n\n`;

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
      responseText += `📍 No specific matching shops found within 5 km. Tap below to explore Google Maps:`;
    }

    // Direct Google Maps Explore button using AI's clean query
    const directSearchUrl = `https://www.google.com/maps/search/${encodeURIComponent(agentDecision.cleanQuery)}/@${session.latitude},${session.longitude},15z`;
    const exploreText = isTamil 
      ? `📍 மேப்பில் அருகிலுள்ள "${agentDecision.cleanQuery}" பார்க்க` 
      : `📍 Explore "${agentDecision.cleanQuery}" on Maps`;

    inlineButtons.push([Markup.button.url(exploreText, directSearchUrl)]);

    await ctx.telegram.editMessageText(
      chatId,
      statusMsg.message_id,
      null,
      responseText,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(inlineButtons)
      }
    );

  } catch (error) {
    console.error('General Error:', error);
    ctx.telegram.editMessageText(
      chatId,
      statusMsg.message_id,
      null,
      `⚠️ An error occurred while processing. Please try again.`
    );
  }
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

// 🧠 Autonomous AI Agent Reasoning Function (Zero Hardcoded If/Else)
async function runAIAgent(userInput) {
  const prompt = `
  You are an autonomous AI shopping agent for physical local retail in Tamil Nadu, India.
  User Search: "${userInput}".
  
  Your task is to understand what this product is and determine the exact physical store in India where it can be purchased.
  
  Instructions:
  1. Detect language: "en" (English), "ta" (Tamil script), or "tanglish" (Tamil in Latin script).
  2. Extract canonical "productName" and "localizedName" (Tamil translation if applicable).
  3. Formulate an exact "category" with an appropriate emoji:
     - Medicines/health items (e.g., Dolo, Paracetamol, Syrups) -> "💊 Pharmacy & Healthcare"
     - Bakery/cakes/sweets (e.g., Brownie, Cakes, Puffs, Snacks) -> "🎂 Bakery & Cake Shop"
     - Pet items (e.g., Pedigree, Cat food, Fish food) -> "🐾 Pet Care & Supplies"
     - Hardware/plumbing/tools (e.g., PVC pipe, drills, wires) -> "🔧 Hardware & Electricals"
     - Electronics/accessories (e.g., chargers, cables, earbuds) -> "🔌 Electronics & Gadgets"
     - Cosmetics/skincare (e.g., sunscreen, lipstick, shampoo) -> "💄 Cosmetics & Beauty"
     - Grocery/provisions (e.g., rice, oil, milk, biscuits) -> "🛒 Supermarket & Grocery"
     - Clothing/textiles (e.g., sarees, shirts, dresses) -> "👗 Clothing & Textiles"
     - Auto spares (e.g., bike engine oil, tyres, puncture) -> "🚗 Automobile & Two-Wheeler"
     - Books/stationery (e.g., notebooks, pens, xerox) -> "📚 Books & Stationery"
  4. Formulate "headingLabel" (Plural store type, e.g. "Medicals & Pharmacies", "Bakeries & Cake Shops", "Pet Stores", "Hardware Stores") and "headingLabelTamil".
  5. Select 1 or 2 official Google Place Types for "placeTypes" matching Google's taxonomy:
     ["pharmacy", "drugstore", "bakery", "cafe", "pet_store", "cell_phone_store", "electronics_store", "hardware_store", "electrical_supply_store", "home_improvement_store", "supermarket", "grocery_store", "convenience_store", "clothing_store", "shoe_store", "book_store", "auto_parts_store", "car_repair", "motorcycle_repair", "florist", "beauty_salon", "cosmetics_store"].
     (NEVER use generic "store" or "point_of_interest").
  6. Formulate "cleanQuery": A short 2-3 word natural search phrase for Google Maps (e.g., "medical shop pharmacy", "bakery cake shop", "pet shop", "hardware store", "mobile accessories").
  
  Return strictly valid JSON:
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

  if (GEMINI_API_KEY && !GEMINI_API_KEY.startsWith('http')) {
    const endpoints = [
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`,
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`,
      `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`
    ];

    for (const endpoint of endpoints) {
      try {
        const response = await axios.post(
          endpoint,
          {
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: 'application/json' }
          },
          { timeout: 7000 }
        );

        const rawText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
        const parsed = safeJsonParse(rawText);
        if (parsed && parsed.category && parsed.placeTypes && parsed.placeTypes.length > 0) {
          return parsed;
        }
      } catch (err) {
        console.warn('AI Agent endpoint attempt failed:', err.message);
      }
    }
  }

  // Pure fallback if API key is unconfigured
  return {
    language: "en",
    productName: userInput,
    localizedName: userInput,
    category: "🛒 General Retail",
    headingLabel: "Local Stores",
    headingLabelTamil: "அருகிலுள்ள கடைகள்",
    placeTypes: ["supermarket"],
    cleanQuery: `${userInput} shop`
  };
}

// Helper 2: Hyperlocal Google Places Search using AI-determined parameters
async function searchHyperlocalStores(placeTypes, cleanQuery, lat, lng) {
  if (!GOOGLE_MAPS_API_KEY || GOOGLE_MAPS_API_KEY.startsWith('http')) {
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

  // Strategy A: Google searchNearby using AI's exact Place Types (Strict Distance Ranking)
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

  // Strategy B: Fallback to searchText with AI's clean search query
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

  // Map and calculate exact physical distance
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

  // Strict sorting: Closest stores appear first
  storesWithDistance.sort((a, b) => a.distanceKm - b.distanceKm);

  return storesWithDistance;
}

// Launch Bot
bot.launch().then(() => {
  console.log('🚀 LMart Pure AI Agent Bot is active...');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
