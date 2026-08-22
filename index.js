require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');

// Validate Environment Variables
if (!process.env.TELEGRAM_BOT_TOKEN) {
  console.error('❌ Error: TELEGRAM_BOT_TOKEN is missing.');
  process.exit(1);
}

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// In-memory store for session coordinates
const userSessions = new Map();

// Default fallback coordinates (Ichipatti / Tiruppur: 11.0168, 77.2514)
const DEFAULT_LAT = 11.0168;
const DEFAULT_LNG = 77.2514;

// 1. /start command
bot.start((ctx) => {
  ctx.reply(
    `👋 *Welcome to LMart* — Your Hyperlocal AI Shopping Agent!\n\n` +
    `Tell me what item you are looking for (e.g., *"Type-C fast charger"*, *"Drill machine"*, *"Paracetamol"*).\n\n` +
    `📍 Share your live location below to search nearest shops.`,
    {
      parse_mode: 'Markdown',
      ...Markup.keyboard([
        [Markup.button.locationRequest('📍 Share Live Location')]
      ]).resize().oneTime()
    }
  );
});

// 2. Handle Location sharing
bot.on('location', (ctx) => {
  const { latitude, longitude } = ctx.message.location;
  userSessions.set(ctx.chat.id, { latitude, longitude });

  ctx.reply(
    `✅ Location received!\n\nWhat product do you want to find?`,
    Markup.removeKeyboard()
  );
});

// 3. Handle Product Search Query
bot.on('text', async (ctx) => {
  const queryText = ctx.message.text.trim();
  const chatId = ctx.chat.id;

  if (queryText.startsWith('/')) return;

  const session = userSessions.get(chatId) || { latitude: DEFAULT_LAT, longitude: DEFAULT_LNG };
  const statusMsg = await ctx.reply(`🔍 Analyzing item & finding nearest open stores...`);

  try {
    // Step A: Parse Intent using Gemini REST API
    const parsedIntent = await parseProductIntent(queryText);

    // Step B: Query Google Places API
    const stores = await searchNearbyStores(
      parsedIntent.searchKeyword,
      session.latitude,
      session.longitude
    );

    if (!stores || stores.length === 0) {
      return ctx.telegram.editMessageText(
        chatId,
        statusMsg.message_id,
        null,
        `❌ No nearby stores found within 5 km for "*${parsedIntent.productName}*".`
      );
    }

    // Step C: Format Response Card with Directions
    let responseText = `🛒 *LMart Stock Finder*\n`;
    responseText += `*Item:* ${parsedIntent.productName}\n`;
    responseText += `*Category:* ${parsedIntent.category}\n\n`;
    responseText += `Found *${stores.length} nearby stores*:\n\n`;

    const inlineButtons = [];

    stores.slice(0, 3).forEach((store, index) => {
      const rating = store.rating ? `⭐ ${store.rating} (${store.user_ratings_total})` : '⭐ New';
      const openStatus = store.opening_hours?.open_now ? '🟢 Open Now' : '⚪ Status Unverified';

      responseText += `*${index + 1}. ${store.name}*\n`;
      responseText += `📍 ${store.vicinity || store.formatted_address || 'View on map'}\n`;
      responseText += `${rating} | ${openStatus}\n\n`;

      const navUrl = `https://www.google.com/maps/dir/?api=1&destination=${store.geometry.location.lat},${store.geometry.location.lng}&destination_place_id=${store.place_id}`;
      
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
    console.error('Search error:', error);
    ctx.telegram.editMessageText(
      chatId,
      statusMsg.message_id,
      null,
      `⚠️ Unable to complete search. Please verify your API keys and try again.`
    );
  }
});

// Helper 1: Category & Intent Classification using Gemini API
async function parseProductIntent(userInput) {
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;

  const prompt = `
  You are an e-commerce taxonomy classifier. Analyze this shopping search: "${userInput}".
  Extract the product name, category, and the best search keyword for local stores on Google Maps.
  
  Return strictly JSON format:
  {
    "productName": "string",
    "category": "string",
    "searchKeyword": "string (e.g. electronics store, hardware shop, pharmacy, stationery)"
  }
  `;

  const response = await axios.post(geminiUrl, {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: 'application/json' }
  });

  const rawText = response.data.candidates[0].content.parts[0].text;
  return JSON.parse(rawText.trim());
}

// Helper 2: Google Places Search
async function searchNearbyStores(keyword, lat, lng) {
  const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json`;
  const response = await axios.get(url, {
    params: {
      location: `${lat},${lng}`,
      radius: 5000,
      keyword: keyword,
      key: process.env.GOOGLE_MAPS_API_KEY
    }
  });

  return response.data.results || [];
}

// Launch Bot
bot.launch().then(() => {
  console.log('🚀 LMart Telegram Bot is active and listening...');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
