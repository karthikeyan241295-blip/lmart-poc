require('dotenv').config();
const http = require('http');
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');

// 1. Health-Check Server (Satisfies Render Port Scan)
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('LMart Telegram Bot is active and healthy!\n');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🌐 Server listening on port ${PORT}`);
});

// 2. Intelligent Environment Cleaner (Strips accidental variable names, quotes, spaces)
function cleanSecret(val) {
  if (!val) return '';
  let str = val.toString().trim().replace(/[\r\n"']/g, '');
  if (str.includes('=')) {
    str = str.split('=').pop().trim();
  }
  return str;
}

const TELEGRAM_BOT_TOKEN = cleanSecret(process.env.TELEGRAM_BOT_TOKEN);
const GEMINI_API_KEY = cleanSecret(process.env.GEMINI_API_KEY);
const GOOGLE_MAPS_API_KEY = cleanSecret(process.env.GOOGLE_MAPS_API_KEY);

if (!TELEGRAM_BOT_TOKEN) {
  console.error('❌ Error: TELEGRAM_BOT_TOKEN is missing.');
  process.exit(1);
}

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
const userSessions = new Map();

// Default coordinates fallback (Ichipatti / Tiruppur / Palladam area: 11.0168, 77.2514)
const DEFAULT_LAT = 11.0168;
const DEFAULT_LNG = 77.2514;

// 3. /start command
bot.start((ctx) => {
  ctx.reply(
    `👋 *Welcome to LMart* — Your Hyperlocal AI Shopping Agent!\n\n` +
    `Tell me what item you need (e.g., *"Type-C 65W charger"*, *"Drill machine"*, *"Paracetamol"*).\n\n` +
    `📍 Share your live location below to search nearest shops.`,
    {
      parse_mode: 'Markdown',
      ...Markup.keyboard([
        [Markup.button.locationRequest('📍 Share Live Location')]
      ]).resize().oneTime()
    }
  );
});

// 4. Handle Location sharing
bot.on('location', (ctx) => {
  const { latitude, longitude } = ctx.message.location;
  userSessions.set(ctx.chat.id, { 
    latitude: Number(latitude) || DEFAULT_LAT, 
    longitude: Number(longitude) || DEFAULT_LNG 
  });

  ctx.reply(
    `✅ Location received!\n\nWhat product do you want to find?`,
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
    // Step A: Parse Intent with Gemini (with fallback)
    const parsedIntent = await parseProductIntent(queryText);

    // Step B: Query Google Places API (with auto-fallback on any error)
    let stores = [];
    try {
      stores = await searchNearbyStores(
        parsedIntent.searchKeyword,
        session.latitude,
        session.longitude
      );
    } catch (err) {
      console.warn('Google Places API notice:', err.message);
      stores = []; // Graceful fallback
    }

    // Step C: Build Interactive Response Card
    let responseText = `🛒 *LMart Stock Finder*\n`;
    responseText += `*Item:* ${parsedIntent.productName}\n`;
    responseText += `*Category:* ${parsedIntent.category}\n\n`;

    const inlineButtons = [];

    if (stores && stores.length > 0) {
      responseText += `Found *${stores.length} nearby stores*:\n\n`;

      stores.slice(0, 3).forEach((store, index) => {
        const rating = store.rating ? `⭐ ${store.rating} (${store.user_ratings_total || 0})` : '⭐ New';
        const openStatus = store.open_now ? '🟢 Open Now' : '⚪ Status Unverified';

        responseText += `*${index + 1}. ${store.name}*\n`;
        responseText += `📍 ${store.formatted_address}\n`;
        responseText += `${rating} | ${openStatus}\n\n`;

        const navUrl = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(store.lat)},${encodeURIComponent(store.lng)}`;
        inlineButtons.push([
          Markup.button.url(`🗺️ Directions: ${store.name.substring(0, 22)}`, navUrl)
        ]);
      });
    } else {
      // Direct Google Maps Search Fallback (Always Works)
      responseText += `📍 Tap below to explore verified shops nearby in your area:`;
      const directSearchUrl = `https://www.google.com/maps/search/${encodeURIComponent(parsedIntent.searchKeyword)}/@${session.latitude},${session.longitude},14z`;
      inlineButtons.push([
        Markup.button.url(`🗺️ Explore "${parsedIntent.searchKeyword}" on Maps`, directSearchUrl)
      ]);
    }

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
      `⚠️ An error occurred. Please try again.`
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

// Helper 1: Category & Intent Classification
async function parseProductIntent(userInput) {
  const prompt = `
  Analyze this shopping search: "${userInput}".
  Extract product name, category, and best search keyword for local stores on Google Maps.
  Return strictly valid JSON:
  {
    "productName": "string",
    "category": "string",
    "searchKeyword": "string"
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
          { timeout: 5000 }
        );

        const rawText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
        const parsed = safeJsonParse(rawText);
        if (parsed && parsed.searchKeyword) {
          return parsed;
        }
      } catch (err) {
        continue;
      }
    }
  }

  return {
    productName: userInput,
    category: "General Retail",
    searchKeyword: `${userInput} shop`
  };
}

// Helper 2: Google Places API Search
async function searchNearbyStores(keyword, lat, lng) {
  if (!GOOGLE_MAPS_API_KEY || GOOGLE_MAPS_API_KEY.startsWith('http')) {
    return [];
  }

  const validLat = Number(lat) || DEFAULT_LAT;
  const validLng = Number(lng) || DEFAULT_LNG;
  const url = `https://places.googleapis.com/v1/places:searchText`;

  const response = await axios.post(
    url,
    {
      textQuery: String(keyword || 'store').trim(),
      locationBias: {
        circle: {
          center: {
            latitude: validLat,
            longitude: validLng
          },
          radius: 5000.0
        }
      },
      maxResultCount: 5
    },
    {
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': GOOGLE_MAPS_API_KEY,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.currentOpeningHours,places.location'
      },
      timeout: 6000
    }
  );

  const places = response.data?.places || [];
  return places.map((p) => ({
    name: p.displayName?.text || 'Local Store',
    formatted_address: p.formattedAddress || 'Address on map',
    rating: p.rating,
    user_ratings_total: p.userRatingCount,
    open_now: p.currentOpeningHours?.openNow,
    lat: p.location?.latitude || validLat,
    lng: p.location?.longitude || validLng,
    place_id: p.id || ''
  }));
}

// Launch Bot
bot.launch().then(() => {
  console.log('🚀 LMart Telegram Bot is active and listening...');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
