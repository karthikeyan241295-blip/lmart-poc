require('dotenv').config();
const http = require('http');
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');

// 1. Health-Check Server (Satisfies Render Port Scan)
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('LMart AI-First Hyperlocal Bot is active and healthy!\n');
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
    `👋 *Welcome to LMart* — Your Hyperlocal AI Shopping Agent!\n` +
    `*எல்மார்ட்* — அனைத்து பொருட்களையும் அருகிலுள்ள கடைகளில் கண்டறியும் AI உதவியாளர்!\n\n` +
    `Ask for *ANY* product in *English, தமிழ், or Tanglish*:\n` +
    `• *"Brownie cake"*\n` +
    `• *"Dolo 650 tablet"*\n` +
    `• *"Cat food whiskas"*\n` +
    `• *"1 inch PVC ball valve"*\n` +
    `• *"Cotton saree"*\n\n` +
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

// 5. Handle Product Search Query (AI-Driven)
bot.on('text', async (ctx) => {
  const queryText = ctx.message.text.trim();
  const chatId = ctx.chat.id;

  if (queryText.startsWith('/')) return;

  const session = userSessions.get(chatId) || { latitude: DEFAULT_LAT, longitude: DEFAULT_LNG };
  const statusMsg = await ctx.reply(`🧠 AI is analyzing product & locating nearest physical stores...`);

  try {
    // Step A: Full AI Semantic Classification (Gemini 1.5/2.0)
    const parsed = await parseProductWithAI(queryText);

    // Step B: Query Google Places using AI-determined place types
    let stores = [];
    try {
      stores = await searchHyperlocalStores(
        parsed.placeTypes,
        parsed.cleanQuery,
        session.latitude,
        session.longitude
      );
    } catch (err) {
      console.warn('Google Places API notice:', err.message);
    }

    // Step C: Dynamic Response Formatting
    const isTamil = parsed.language === 'ta' || parsed.language === 'tanglish';
    
    let responseText = isTamil ? `🛒 *எல்மார்ட் கடை தேடல் (LMart)*\n` : `🛒 *LMart Stock Finder*\n`;
    responseText += isTamil ? `*பொருள்:* ${parsed.localizedName || parsed.productName}\n` : `*Item:* ${parsed.productName}\n`;
    responseText += isTamil ? `*வகை:* ${parsed.category}\n\n` : `*Category:* ${parsed.category}\n\n`;

    const inlineButtons = [];

    if (stores && stores.length > 0) {
      const headingText = isTamil
        ? `உங்களுக்கு மிக அருகிலுள்ள *${stores.length} ${parsed.headingLabelTamil || 'கடைகள்'}* (தூரத்தின்படி):\n\n`
        : `Nearest *${stores.length} ${parsed.headingLabel || 'Stores'}* (Ranked by Distance):\n\n`;

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

    // Direct Google Maps Search button
    const directSearchUrl = `https://www.google.com/maps/search/${encodeURIComponent(parsed.cleanQuery)}/@${session.latitude},${session.longitude},15z`;
    const exploreText = isTamil 
      ? `📍 மேப்பில் அருகிலுள்ள அனைத்து "${parsed.cleanQuery}" பார்க்க` 
      : `📍 Explore all "${parsed.cleanQuery}" on Maps`;

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
      `⚠️ An error occurred while searching. Please try again.`
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

// Helper 1: AI-Powered Semantic Retail Taxonomy & Place Type Engine
async function parseProductWithAI(userInput) {
  const prompt = `
  You are an expert AI retail taxonomy engine for local physical shopping in India.
  Analyze the user search query: "${userInput}".
  
  Determine what exact type of local retail store in India sells this product.
  
  Instructions:
  1. Detect language: "en" (English), "ta" (Tamil script), or "tanglish" (Tamil in Latin script).
  2. Extract canonical "productName" and "localizedName" (Tamil translation if applicable).
  3. Formulate an exact "category" with an appropriate emoji (e.g., "🎂 Bakery & Cake Shop", "💊 Pharmacy & Healthcare", "🐾 Pet Supplies & Food", "💄 Cosmetics & Beauty", "🔧 Hardware & Tools", "🔌 Mobile & Electronics", "🌸 Florist & Flowers", "👗 Clothing & Textiles", "🥩 Meat & Poultry", "📚 Books & Stationery", "🚗 Auto Spares & Garage", "🛋️ Furniture & Home").
  4. Formulate "headingLabel" (Plural store type, e.g. "Bakeries & Cake Shops", "Medical Pharmacies", "Pet Shops", "Hardware Stores") and "headingLabelTamil".
  5. Select 1 or 2 official Google Place Types for "placeTypes" from this list:
     ["bakery", "pharmacy", "drugstore", "electronics_store", "cell_phone_store", "hardware_store", "electrical_supply_store", "home_improvement_store", "grocery_store", "supermarket", "convenience_store", "pet_store", "beauty_salon", "cosmetics_store", "florist", "book_store", "clothing_store", "shoe_store", "jewelry_store", "auto_parts_store", "car_repair", "motorcycle_repair", "sporting_goods_store", "furniture_store", "restaurant", "cafe"].
     (NEVER use generic "store" or "point_of_interest").
  6. Formulate "cleanQuery": A concise 2-3 word natural search phrase for Google Maps (e.g., "bakery cake shop", "medical shop", "pet shop", "hardware tools", "mobile accessories").
  
  Return strictly valid JSON in this exact schema:
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
    const modelEndpoints = [
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`,
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`,
      `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`
    ];

    for (const endpoint of modelEndpoints) {
      try {
        const response = await axios.post(
          endpoint,
          {
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: 'application/json' }
          },
          { timeout: 6000 }
        );

        const rawText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
        const parsed = safeJsonParse(rawText);
        if (parsed && parsed.category && parsed.placeTypes && parsed.placeTypes.length > 0) {
          return parsed;
        }
      } catch (err) {
        console.warn('Gemini endpoint attempt failed:', err.message);
      }
    }
  }

  // Graceful fallback only if AI API is completely down
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

// Helper 2: Google Places Search (Using AI-derived Place Types & Proximity Ranking)
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

  // Strategy A: searchNearby using AI's exact Google Place Types (Ranked by Distance)
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
  console.log('🚀 LMart AI-First Hyperlocal Bot is active...');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
