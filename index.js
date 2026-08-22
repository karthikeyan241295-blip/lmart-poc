require('dotenv').config();
const http = require('http');
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');

// 1. Health-Check Server (Satisfies Render Port Scan)
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('LMart Multilingual Telegram Bot is active and healthy!\n');
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

// Default coordinates fallback (Ichipatti / Tiruppur / Palladam: 11.0168, 77.2514)
const DEFAULT_LAT = 11.0168;
const DEFAULT_LNG = 77.2514;

// 3. /start command (Bilingual English + Tamil)
bot.start((ctx) => {
  const welcomeText = 
    `👋 *Welcome to LMart* — Your Hyperlocal AI Shopping Agent!\n` +
    `*எல்மார்ட்* — உங்கள் அருகிலுள்ள கடைகளில் பொருட்களை கண்டறியும் AI உதவியாளர்!\n\n` +
    `Type any item in *English, தமிழ், or Tanglish*:\n` +
    `• *"Type-C fast charger"*\n` +
    `• *"பாராசிட்டமால் மாத்திரை"*\n` +
    `• *"1 inch PVC pipe"*\n\n` +
    `📍 Please share your location below to search nearest shops.`;

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
  const statusMsg = await ctx.reply(`🔍 Analyzing item & finding nearest open stores...`);

  try {
    // Step A: Parse Intent with Multilingual Gemini Model
    const parsed = await parseProductIntent(queryText);

    // Step B: Query Google Places API (New)
    let stores = [];
    try {
      stores = await searchNearbyStores(
        parsed.searchKeyword,
        session.latitude,
        session.longitude
      );
    } catch (err) {
      console.warn('Google Places API notice:', err.message);
    }

    // Step C: Format Response in User's Language
    const isTamil = parsed.language === 'ta' || parsed.language === 'tanglish';
    
    let responseText = isTamil ? `🛒 *எல்மார்ட் கடை தேடல் (LMart)*\n` : `🛒 *LMart Stock Finder*\n`;
    responseText += isTamil ? `*பொருள்:* ${parsed.localizedName || parsed.productName}\n` : `*Item:* ${parsed.productName}\n`;
    responseText += isTamil ? `*வகை:* ${parsed.category}\n\n` : `*Category:* ${parsed.category}\n\n`;

    const inlineButtons = [];

    if (stores && stores.length > 0) {
      responseText += isTamil ? `அருகிலுள்ள *${stores.length} கடைகள்*:\n\n` : `Found *${stores.length} nearby stores*:\n\n`;

      stores.slice(0, 3).forEach((store, index) => {
        const rating = store.rating ? `⭐ ${store.rating} (${store.user_ratings_total || 0})` : '⭐ Verified';
        const openStatus = store.open_now 
          ? (isTamil ? '🟢 இப்போது திறந்துள்ளது' : '🟢 Open Now')
          : (isTamil ? '⚪ திறந்த நிலை அறியப்படவில்லை' : '⚪ Status Unverified');

        const phoneText = store.phone ? `\n📞 \`${store.phone}\`` : '';

        responseText += `*${index + 1}. ${store.name}*\n`;
        responseText += `📍 ${store.formatted_address}\n`;
        responseText += `${rating} | ${openStatus}${phoneText}\n\n`;

        const navUrl = `https://www.google.com/maps/dir/?api=1&destination=${store.lat},${store.lng}&destination_place_id=${store.place_id || ''}`;
        const dirBtnText = isTamil ? `🗺️ வழிப்பாதை: ${store.name.substring(0, 18)}` : `🗺️ Directions: ${store.name.substring(0, 20)}`;
        
        inlineButtons.push([Markup.button.url(dirBtnText, navUrl)]);
      });
    }

    // Direct Google Maps Explore button
    const directSearchUrl = `https://www.google.com/maps/search/${encodeURIComponent(parsed.searchKeyword)}/@${session.latitude},${session.longitude},14z`;
    const exploreText = isTamil 
      ? `📍 மேப்பில் அனைத்து "${parsed.searchKeyword}" கடைகளையும் பார்க்க` 
      : `📍 Explore all "${parsed.searchKeyword}" on Maps`;

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

// Helper 1: Multilingual & Accurate Category Taxonomy Classifier
async function parseProductIntent(userInput) {
  const prompt = `
  You are an expert Indian retail taxonomy classifier.
  Analyze the user search input: "${userInput}".
  
  Instructions:
  1. Detect the language: "en" (English), "ta" (Tamil script), or "tanglish" (Tamil in Latin script, e.g. "kaichal mathirai").
  2. Extract the canonical product name in English and the localized name in Tamil (if Tamil/Tanglish).
  3. Classify into one of these exact standardized categories:
     - 💊 Pharmacy & Healthcare (e.g. medicines, tablets, paracetamol, syrups, medicals)
     - 🔌 Electronics & Mobile Accessories (e.g. chargers, cables, headphones, power bank)
     - 🔧 Hardware, Electricals & Plumbing (e.g. PVC pipes, tools, switches, motor capacitors, paint)
     - 🛒 Supermarket, Provisions & Grocery (e.g. milk, rice, oil, snacks, vegetables)
     - 📚 Stationery & Xerox (e.g. notebooks, printing, pens, charts)
     - 🚗 Automobile Spares & Two-Wheeler (e.g. engine oil, bike battery, spares, tyres)
     - 🍽️ Restaurant & Bakery (e.g. tea, coffee, snacks, cakes)
  4. Generate the most effective searchKeyword for physical stores in Tamil Nadu on Google Maps (e.g. "Medicals Pharmacy", "Electrical and Hardware store", "Mobile Accessories store").
  
  Return strictly valid JSON:
  {
    "language": "en" | "ta" | "tanglish",
    "productName": "English Name",
    "localizedName": "Tamil/Localized Name",
    "category": "Standardized Category with Emoji",
    "searchKeyword": "Google Maps search query"
  }
  `;

  if (GEMINI_API_KEY) {
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
          { timeout: 5000 }
        );

        const rawText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
        const parsed = safeJsonParse(rawText);
        if (parsed && parsed.category && parsed.searchKeyword) {
          return parsed;
        }
      } catch (err) {
        continue;
      }
    }
  }

  // Fallback
  return {
    language: "en",
    productName: userInput,
    localizedName: userInput,
    category: "🛒 General Retail",
    searchKeyword: `${userInput} shop`
  };
}

// Helper 2: Google Places API (New) with Phone Number Support
async function searchNearbyStores(keyword, lat, lng) {
  if (!GOOGLE_MAPS_API_KEY) {
    return [];
  }

  const validLat = Number(lat) || DEFAULT_LAT;
  const validLng = Number(lng) || DEFAULT_LNG;
  const url = `https://places.googleapis.com/v1/places:searchText`;

  const response = await axios({
    method: 'post',
    url: url,
    data: {
      textQuery: String(keyword || 'store').trim(),
      locationBias: {
        circle: {
          center: {
            latitude: validLat,
            longitude: validLng
          },
          radius: 5000.0 // 5 km search radius
        }
      },
      maxResultCount: 5
    },
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': GOOGLE_MAPS_API_KEY,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.currentOpeningHours,places.location,places.nationalPhoneNumber'
    },
    timeout: 7000
  });

  const places = response.data?.places || [];
  return places.map((p) => ({
    name: p.displayName?.text || 'Local Store',
    formatted_address: p.formattedAddress || 'Address on map',
    rating: p.rating,
    user_ratings_total: p.userRatingCount,
    open_now: p.currentOpeningHours?.openNow,
    phone: p.nationalPhoneNumber || '',
    lat: p.location?.latitude || validLat,
    lng: p.location?.longitude || validLng,
    place_id: p.id || ''
  }));
}

// Launch Bot
bot.launch().then(() => {
  console.log('🚀 LMart Multilingual Bot is running...');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
