require('dotenv').config();
const http = require('http');
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');

// 1. Health-Check Server (Satisfies Render Port Scan)
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('LMart Hyperlocal Bot is active and healthy!\n');
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

// Default coordinates fallback (Ichipatti / Karugampalayam area: 11.0168, 77.2514)
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
    `*எல்மார்ட்* — மிக அருகிலுள்ள கடைகள் & தொலைபேசி எண்களை கண்டறியும் AI உதவியாளர்!\n\n` +
    `Type any item in *English, தமிழ், or Tanglish*:\n` +
    `• *"Paracetamol tablet"*\n` +
    `• *"மொபைல் சார்ஜர்"*\n` +
    `• *"1 inch PVC pipe"*\n\n` +
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

// 5. Handle Product Search Query
bot.on('text', async (ctx) => {
  const queryText = ctx.message.text.trim();
  const chatId = ctx.chat.id;

  if (queryText.startsWith('/')) return;

  const session = userSessions.get(chatId) || { latitude: DEFAULT_LAT, longitude: DEFAULT_LNG };
  const statusMsg = await ctx.reply(`🔍 Finding nearest verified shops in your neighborhood...`);

  try {
    // Step A: Parse Intent with Fast Rule-Engine + Gemini Fallback
    const parsed = await parseProductIntent(queryText);

    // Step B: Query Google Places using Strict Type Filtering
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

    // Step C: Format Response
    const isTamil = parsed.language === 'ta' || parsed.language === 'tanglish';
    
    let responseText = isTamil ? `🛒 *எல்மார்ட் கடை தேடல் (LMart)*\n` : `🛒 *LMart Stock Finder*\n`;
    responseText += isTamil ? `*பொருள்:* ${parsed.localizedName || parsed.productName}\n` : `*Item:* ${parsed.productName}\n`;
    responseText += isTamil ? `*வகை:* ${parsed.category}\n\n` : `*Category:* ${parsed.category}\n\n`;

    const inlineButtons = [];

    if (stores && stores.length > 0) {
      responseText += isTamil 
        ? `உங்களுக்கு மிக அருகிலுள்ள *${stores.length} மருந்தகங்கள்/கடைகள்* (தூரத்தின்படி):\n\n` 
        : `Nearest *${stores.length} Medicals / Pharmacies* (Ranked by Distance):\n\n`;

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
      responseText += `📍 No specific medical shops found within 5 km. Tap below to search Google Maps directly:`;
    }

    // Direct Google Maps Explore button
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

// Helper 1: Fast Rule-Engine + Gemini AI Taxonomy Classifier
async function parseProductIntent(userInput) {
  const text = userInput.toLowerCase();

  // 1. Instant Rule-Based Matching for Medicines & Healthcare
  if (/(paracetamol|tablet|medicine|syrup|ointment|dollo|dolo|crocin|medical|pharmacy|chemist|மாத்திரை|மருந்து|மருந்தகம்|kaichal|fever|bandaid|bandage|ointment|pain)/i.test(text)) {
    return {
      language: /[\u0B80-\u0BFF]/.test(userInput) ? "ta" : (/(kaichal|marunthu|mathirai)/i.test(text) ? "tanglish" : "en"),
      productName: userInput,
      localizedName: userInput,
      category: "💊 Pharmacy & Healthcare",
      placeTypes: ["pharmacy", "drugstore"],
      cleanQuery: "medical shop pharmacy"
    };
  }

  // 2. Instant Rule-Based Matching for Electronics & Mobile Accessories
  if (/(charger|cable|usb|type-c|adapter|earphone|headphone|mobile|phone|battery|powerbank|சார்ஜர்|ஹெட்போன்)/i.test(text)) {
    return {
      language: /[\u0B80-\u0BFF]/.test(userInput) ? "ta" : "en",
      productName: userInput,
      localizedName: userInput,
      category: "🔌 Electronics & Mobile Accessories",
      placeTypes: ["cell_phone_store", "electronics_store"],
      cleanQuery: "mobile accessories shop"
    };
  }

  // 3. Instant Rule-Based Matching for Hardware & Plumbing
  if (/(pipe|pvc|wire|switch|motor|capacitor|drill|screw|cement|paint|hardware|electrical|valve|drilling)/i.test(text)) {
    return {
      language: /[\u0B80-\u0BFF]/.test(userInput) ? "ta" : "en",
      productName: userInput,
      localizedName: userInput,
      category: "🔧 Hardware & Electricals",
      placeTypes: ["hardware_store", "electrical_supply_store"],
      cleanQuery: "electrical hardware store"
    };
  }

  // 4. Instant Rule-Based Matching for Supermarket & Grocery
  if (/(milk|rice|oil|biscuit|snack|grocery|supermarket|vegetable|fruit|மளிகை|பால்)/i.test(text)) {
    return {
      language: /[\u0B80-\u0BFF]/.test(userInput) ? "ta" : "en",
      productName: userInput,
      localizedName: userInput,
      category: "🛒 Supermarket & Grocery",
      placeTypes: ["supermarket", "grocery_store"],
      cleanQuery: "grocery supermarket"
    };
  }

  // Gemini AI Fallback for complex/unmatched inputs
  if (GEMINI_API_KEY && !GEMINI_API_KEY.startsWith('http')) {
    const prompt = `
    Analyze this shopping search for Tamil Nadu: "${userInput}".
    Classify into exact category: 💊 Pharmacy & Healthcare, 🔌 Electronics, 🔧 Hardware, or 🛒 Supermarket.
    Return JSON:
    {
      "language": "en" | "ta" | "tanglish",
      "productName": "Clean Name",
      "category": "Category with Emoji",
      "placeTypes": ["pharmacy"] or ["electronics_store"] or ["hardware_store"] or ["grocery_store"],
      "cleanQuery": "simple search term"
    }
    `;

    try {
      const response = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`,
        {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json' }
        },
        { timeout: 4000 }
      );

      const parsed = safeJsonParse(response.data?.candidates?.[0]?.content?.parts?.[0]?.text);
      if (parsed && parsed.category && parsed.placeTypes) {
        return parsed;
      }
    } catch (err) {
      console.warn('Gemini fallback failed:', err.message);
    }
  }

  // Safe Default
  return {
    language: "en",
    productName: userInput,
    localizedName: userInput,
    category: "🛒 General Retail",
    placeTypes: ["grocery_store"],
    cleanQuery: `${userInput} store`
  };
}

// Helper 2: Strict Hyperlocal Google Places Search
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

  // Strategy A: searchNearby with strict Google Place Type (e.g. pharmacy only)
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

  // Strategy B: Fallback to searchText with exact query (e.g. "medical shop")
  if (!places || places.length === 0) {
    try {
      const textUrl = `https://places.googleapis.com/v1/places:searchText`;
      const response = await axios.post(
        textUrl,
        {
          textQuery: String(cleanQuery || 'medical shop pharmacy').trim(),
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

  // Map and calculate distance
  const storesWithDistance = places.map((p) => {
    const pLat = p.location?.latitude || validLat;
    const pLng = p.location?.longitude || validLng;
    const dist = calculateDistanceKm(validLat, validLng, pLat, pLng);

    return {
      name: p.displayName?.text || 'Local Medicals',
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
  console.log('🚀 LMart Hyperlocal Bot is running...');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
