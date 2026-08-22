require('dotenv').config();
const http = require('http');
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');

// 1. Lightweight Health-Check Server for Render
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('LMart Telegram Bot is active and healthy!\n');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🌐 Health-check server listening on port ${PORT}`);
});

// 2. Clean Environment Variables
const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').replace(/['"]/g, '').trim();
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || '').replace(/['"]/g, '').trim();
const GOOGLE_MAPS_API_KEY = (process.env.GOOGLE_MAPS_API_KEY || '').replace(/['"]/g, '').trim();

if (!TELEGRAM_BOT_TOKEN) {
  console.error('❌ Error: TELEGRAM_BOT_TOKEN is missing.');
  process.exit(1);
}

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
const userSessions = new Map();

// Default coordinates fallback (Ichipatti / Tiruppur: 11.0168, 77.2514)
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
  userSessions.set(ctx.chat.id, { latitude, longitude });

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
    // Step A: Parse Intent with Gemini (with multi-model fallback)
    const parsedIntent = await parseProductIntent(queryText);

    // Step B: Query Google Places API (New)
    let stores = [];
    try {
      stores = await searchNearbyStores(
        parsedIntent.searchKeyword,
        session.latitude,
        session.longitude
      );
    } catch (err) {
      console.error('Google Places API Error:', err.message);
      return ctx.telegram.editMessageText(
        chatId,
        statusMsg.message_id,
        null,
        `⚠️ Google Maps Error: ${err.message}`
      );
    }

    if (!stores || stores.length === 0) {
      return ctx.telegram.editMessageText(
        chatId,
        statusMsg.message_id,
        null,
        `❌ No nearby stores found within 5 km for "*${parsedIntent.productName}*". Try searching for a broader term.`
      );
    }

    // Step C: Format Response Card with Google Maps Links
    let responseText = `🛒 *LMart Stock Finder*\n`;
    responseText += `*Item:* ${parsedIntent.productName}\n`;
    responseText += `*Category:* ${parsedIntent.category}\n\n`;
    responseText += `Found *${stores.length} nearby stores*:\n\n`;

    const inlineButtons = [];

    stores.slice(0, 3).forEach((store, index) => {
      const rating = store.rating ? `⭐ ${store.rating} (${store.user_ratings_total || 0})` : '⭐ New';
      const openStatus = store.open_now ? '🟢 Open Now' : '⚪ Status Unverified';

      responseText += `*${index + 1}. ${store.name}*\n`;
      responseText += `📍 ${store.formatted_address}\n`;
      responseText += `${rating} | ${openStatus}\n\n`;

      const navUrl = `https://www.google.com/maps/dir/?api=1&destination=${store.lat},${store.lng}&destination_place_id=${store.place_id}`;
      
      inlineButtons.push([
        Markup.button.url(`🗺️ Directions: ${store.name.substring(0, 22)}`, navUrl)
      ]);
    });

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
      `⚠️ Unable to complete search. Please try again.`
    );
  }
});

// Helper 1: Category & Intent Classification with Multi-Model Fallbacks
async function parseProductIntent(userInput) {
  const prompt = `
  You are an e-commerce taxonomy classifier. Analyze this shopping search: "${userInput}".
  Extract the product name, category, and the best search keyword for local retail stores on Google Maps.
  
  Return strictly valid JSON:
  {
    "productName": "string",
    "category": "string",
    "searchKeyword": "string (e.g. electronics store, hardware shop, medical pharmacy, stationery)"
  }
  `;

  const modelEndpoints = [
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${GEMINI_API_KEY}`,
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
    `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=${GEMINI_API_KEY}`
  ];

  for (const endpoint of modelEndpoints) {
    try {
      const response = await axios.post(endpoint, {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json' }
      }, { timeout: 6000 });

      const rawText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (rawText) {
        return JSON.parse(rawText.trim());
      }
    } catch (err) {
      continue;
    }
  }

  // Graceful fallback
  return {
    productName: userInput,
    category: "General Retail",
    searchKeyword: `${userInput} store`
  };
}

// Helper 2: Google Places API (New) Search
async function searchNearbyStores(keyword, lat, lng) {
  const url = `https://places.googleapis.com/v1/places:searchText`;

  const response = await axios.post(
    url,
    {
      textQuery: keyword,
      locationBias: {
        circle: {
          center: {
            latitude: lat,
            longitude: lng
          },
          radius: 5000.0 // 5 km search radius
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
      timeout: 8000
    }
  );

  const places = response.data?.places || [];
  return places.map((p) => ({
    name: p.displayName?.text || 'Local Store',
    formatted_address: p.formattedAddress || 'Address on map',
    rating: p.rating,
    user_ratings_total: p.userRatingCount,
    open_now: p.current
