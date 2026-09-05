import 'dotenv/config';
import { installRedactedConsole } from './utils/logger.js';
installRedactedConsole();

import { Telegraf, Markup, session } from 'telegraf';
import { AiBrokerService, ChatMessage, AI_VIP_DAILY_MAX, AI_VIP_WEEKLY_MAX, AI_VIP_DB_LOOKUPS_MAX, AI_FREE_SEARCHES_MAX } from './services/ai.service.js';
import * as express from 'express';
import { StripeService } from './services/stripe.service.js';
import { startScraperCron } from './jobs/scraper.job.js';
import { startBackupCron } from './jobs/backup.job.js';
import { startInventoryStatsCron } from './jobs/inventory-stats.job.js';
import { startUrlVerifyCron } from './jobs/url-verify.job.js';
import { queueService } from './services/queue.service.js';
import { setupFiltersMenu, userDrafts, renderFiltersMenu, resetFiltersAfter } from './menus/filters.menu.js';
import { setupScheduleMenu, openScheduleForUser } from './menus/schedule.menu.js';
import { initRedis, disconnectRedis } from './db/redis.js';
import { prisma, backfillListingNorms } from './db/prisma.js';
import { rateLimit } from './middlewares/ratelimit.middleware.js';
import { isAdminUser, redactSecrets } from './utils/secrets.js';
import { getWorkerMode, runsAppRole, runsScraperRole } from './utils/workerMode.js';
import { escapeHtml, htmlBold, htmlItalic, htmlLink, aiReplyToTelegramHtml } from './utils/telegramFormat.js';
export { prisma };

import { Context } from 'telegraf';

const token = process.env.TELEGRAM_BOT_TOKEN;
// The scraper container intentionally ships without the bot token (blast radius).
// It never launches polling; Telegraf just needs a non-empty string to construct.
const scraperOnly = (process.env.WORKER_MODE || 'all').trim().toLowerCase() === 'scraper';
if (!token && !scraperOnly) throw new Error('TELEGRAM_BOT_TOKEN is missing from .env');
const telegrafToken = token || '0:scraper-role-has-no-token';

type MySession = {
  chatHistory: ChatMessage[];
};

type MyContext = Context & {
  session?: MySession;
};

export const bot = new Telegraf<MyContext>(telegrafToken);
bot.use(session());

const PRIVACY_URL =
  'https://drive.google.com/file/d/1VuUkZmsTVyG8FV7sM9Alh2oz79rckcnV/view?usp=sharing';

/** Same layout as Subastas welcome: sections + blockquotes. English / AutoBroker. No public channel. */
function welcomeBodyHtml(opts?: { vipActive?: boolean }): string {
  const header = opts?.vipActive
    ? `👑 <b>Welcome to AutoBroker AI</b> — VIP active`
    : `🚨 <b>Welcome to AutoBroker AI!</b>`;

  const intro = opts?.vipActive
    ? `Your subscription is active. We scan European second-hand markets for undervalued and imported cars and notify you without spam.`
    : `We scan European second-hand markets for undervalued and imported cars — then help you decide with an AI car advisor, all <b>in this chat</b>.`;

  return `${header}

${intro}

🆓 <b>Free plan</b>
<blockquote>Chat with the AI here in this bot. Up to <b>${AI_FREE_SEARCHES_MAX} interactions</b>. Each can show <b>1 listing</b> (details only) — <b>no link</b> to open the ad. No personal deal radar.</blockquote>

🤖 <b>AI advisor</b>
<blockquote>Write here anytime: compare cars, imports, red flags, fair prices, or what is in stock.

Example: "What BMW 320d deals look fair under €20,000?"

Free plan: <b>${AI_FREE_SEARCHES_MAX} interactions</b> · 1 listing each · no link.</blockquote>

💎 <b>VIP</b>
<blockquote>Configure your radar (<b>brand, model, specs, motor, power, country, price, year, km, fuel</b>) and receive digests with up to <b>3 listings</b>, each with a clickable <b>Listing found</b> link.

Use <b>/schedule</b> to choose <b>which days</b>, <b>which hours</b> (Europe/Madrid), and <b>how often</b> digests arrive, so alerts fit your day, not the other way around.
Plus more AI advisor usage.</blockquote>

⌨️ <b>Useful commands</b>
<blockquote>/start — this menu
/filters — VIP radar
/schedule — digest days, hours &amp; frequency
/advisor — how to use the AI
/status — your subscription
/delete_account — clear personal data (only after VIP has ended)</blockquote>

👇 <i>Choose an option, a command, or write to the advisor:</i>`;
}

function freeWelcomeHtml(): string {
  return welcomeBodyHtml({ vipActive: false });
}

function vipWelcomeHtml(): string {
  return welcomeBodyHtml({ vipActive: true });
}

async function replyVipPanel(ctx: MyContext, edit = false) {
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📋 View my Status', 'status')],
    [Markup.button.url('📄 Privacy Policy and Terms', PRIVACY_URL)],
    [Markup.button.callback('⚙️ Configure VIP Filters', 'vip_filters')],
    [Markup.button.callback('⏰ Digest schedule', 'vip_schedule')],
    [
      Markup.button.url(
        '💳 Manage my Subscription',
        process.env.STRIPE_PORTAL_LINK || 'https://billing.stripe.com'
      )
    ]
  ]);
  const text = vipWelcomeHtml();
  if (edit && ctx.updateType === 'callback_query') {
    try {
      await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
    } catch {
      await ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
    }
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
  }
}

async function replyAdvisorHelp(ctx: MyContext) {
  const msg =
`🤖 <b>AI car advisor</b>

Write here anytime — compare cars, imports, red flags, fair prices, or what is in stock. Always focused on used-car deals in Europe.

🆓 <b>Free trial</b>
<blockquote><b>${AI_FREE_SEARCHES_MAX} interactions</b>
• <b>1 listing</b> per message (details only)
• <b>No link</b> to open the ad</blockquote>

💎 <b>VIP</b>
<blockquote>Chat: up to <b>${AI_VIP_DAILY_MAX}/day</b> and <b>${AI_VIP_WEEKLY_MAX}/week</b>
• <b>Radar digests:</b> up to <b>3 listings</b>, each with a clickable <b>Listing found</b> link
• <b>Ordinary AI questions / stock:</b> details in chat, <b>no link</b> — does not use the recovery quota
• <b>Recover an ad:</b> up to <b>${AI_VIP_DB_LOOKUPS_MAX}/day</b> with full details <b>+ Listing found</b> link
• After those recoveries, you can still chat for advice.</blockquote>

💬 <b>Examples</b>
<blockquote>What Audi A3 / S-Line options look fair under €18,000 with under 100,000 km?

Show me a BMW 320d in stock around €20,000, diesel, under 150,000 km

Is a 2018 Mercedes C 220d with 180,000 km a risky buy?

Compare Golf 7 GTI vs Leon Cupra — reliability and what to check

I want to import a Porsche Macan from Germany to Spain — what paperwork and costs should I expect?

Any Seat Leon FR petrol under €15,000 worth looking at?</blockquote>

🔁 <b>Recover a previous listing</b>
Lost an ad we already sent? Remind the AI of whatever you still remember — brand and model help a lot; price, year, km, fuel or country make the match safer. More clues = closer recovery, but a short prompt can still work.

If you are <b>VIP</b> and a <b>Listing found</b> link is dead, say so (e.g. “this link is broken”). After today’s recoveries are used, VIP gets <b>1 grace recovery from the DB per day</b> for a fresh alternative — then wait until tomorrow. Free trial: no Listing found links and no grace pull.

<blockquote>Recover that BMW M4 Competition around €70,000, year around 2021, around 45,000 km, petrol, Germany — full details and Listing found link again

Show me again the BMW 5 Series 525d, with full info and Listing found link again

Recover that Dacia Sandero 1.0 Expression — full details and Listing found link again</blockquote>

<i>Tip: extra details (price, year, km…) tighten the match; start with what you remember.</i>`;

  await ctx.reply(msg, { parse_mode: 'HTML' });
}

async function replyStatusMessage(ctx: MyContext) {
  const fromId = ctx.from?.id;
  if (!fromId) return;
  const user = await prisma.user.findUnique({ where: { telegramId: BigInt(fromId) } });
  if (!user) {
    if (ctx.updateType === 'callback_query') await ctx.answerCbQuery('User not found');
    else await ctx.reply('Please use /start first.');
    return;
  }

  const registrationDate = user.createdAt.toLocaleDateString('en-US');

  if (user.subscriptionStatus === 'vip') {
    const dailyUsed = user.dailyAiRequests || 0;
    const lastAi = user.lastAiRequestDate ? new Date(user.lastAiRequestDate) : null;
    const usedToday = lastAi && lastAi.toDateString() === new Date().toDateString() ? dailyUsed : 0;
    const {
      formatDigestDays,
      formatHourRange,
      prefsFromUserRow
    } = await import('./services/digestSchedule.service.js');
    const prefs = prefsFromUserRow(user as any);
    const msg =
      `📋 **Your AutoBroker AI Status**\n\n` +
      `✅ **Subscription:** VIP Active\n` +
      `📅 **VIP Member since:** ${registrationDate}\n` +
      `🤖 **AI today:** ${usedToday}/${AI_VIP_DAILY_MAX} (weekly cap ${AI_VIP_WEEKLY_MAX})\n\n` +
      `⏰ **Digest schedule** (Europe/Madrid)\n` +
      `• Days: ${formatDigestDays(prefs.days)}\n` +
      `• Hours: ${formatHourRange(prefs.startHour, prefs.endHour)}\n` +
      `• Every: ${prefs.intervalH}h\n\n` +
      `🏎️ Your radar is active. Digests follow your /schedule.`;
    await ctx.reply(msg, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('⏰ Edit schedule', 'vip_schedule')],
        [Markup.button.callback('⚙️ VIP Filters', 'vip_filters')]
      ])
    });
  } else if (user.subscriptionStatus === 'cancelling') {
    let activeUntil = 'Unknown';
    if (user.stripeCustomerId) {
      try {
        const { stripe } = await import('./services/stripe.service.js');
        const subs = await stripe.subscriptions.list({ customer: user.stripeCustomerId, status: 'active' });
        const firstSub = subs.data[0];
        if (firstSub) {
          const cancelAt = firstSub.cancel_at || (firstSub as any).current_period_end;
          activeUntil = new Date(cancelAt * 1000).toLocaleDateString('en-US');
        }
      } catch (e) {
        console.error('Error fetching stripe subscription for status:', e);
      }
    }

    const dailyUsed = user.dailyAiRequests || 0;
    const lastAi = user.lastAiRequestDate ? new Date(user.lastAiRequestDate) : null;
    const usedToday = lastAi && lastAi.toDateString() === new Date().toDateString() ? dailyUsed : 0;
    const msg = `📋 **Your AutoBroker AI Status**\n\n⚠️ **Subscription:** Canceled (Active until ${activeUntil})\n📅 **VIP Member since:** ${registrationDate}\n🤖 **AI today:** ${usedToday}/${AI_VIP_DAILY_MAX} (weekly cap ${AI_VIP_WEEKLY_MAX})\n\n🏎️ Your radar stays active until the billing period ends.`;
    await ctx.reply(msg, { parse_mode: 'Markdown' });
  } else {
    const msg = `📋 **Your AutoBroker AI Status**\n\n❌ **Subscription:** Free\n📅 **Member since:** ${registrationDate}\n\n📊 **Usage:**\n🔍 AI searches: ${user.freeSearchesUsed}/${AI_FREE_SEARCHES_MAX}\n\n💎 *Subscribe to VIP for deal alerts with direct links and full AI access.*`;
    await ctx.reply(msg, { parse_mode: 'Markdown' });
  }
  if (ctx.updateType === 'callback_query') await ctx.answerCbQuery();
}

// Global error handling to prevent process crashes
bot.catch((err: any, ctx) => {
  const desc = err?.response?.description || err?.message || '';
  if (typeof desc === 'string' && desc.includes('message is not modified')) {
    return;
  }
  console.error(`❌ Error detected in Telegraf (Update ID: ${ctx.update?.update_id}):`, err);
});

// ==========================================
// 🧠 BOT CORE MIDDLEWARE / ROUTER
// ==========================================

// COMMAND: /start (User registration and Freemium Panel)
bot.start(async (ctx) => {
  const telegramId = ctx.from.id;
  try {
    const user = await prisma.user.upsert({
      where: { telegramId: BigInt(telegramId) },
      update: {},
      create: { telegramId: BigInt(telegramId) }
    });

    if (user.subscriptionStatus === 'vip' || user.subscriptionStatus === 'cancelling') {
      await replyVipPanel(ctx, false);
    } else {
      const paymentUrl = await getDynamicPaymentLink(telegramId);
      const msg = freeWelcomeHtml();

      if (!paymentUrl) {
        const keyboard = Markup.inlineKeyboard([
          [Markup.button.callback('📋 View my Status', 'status')],
          [Markup.button.url('📄 Privacy Policy and Terms', PRIVACY_URL)]
        ]);
        await ctx.reply(
          msg + `\n\n⚠️ <i>VIP checkout is temporarily unavailable. Please try again later.</i>`,
          { parse_mode: 'HTML', ...keyboard }
        );
      } else {
        const keyboard = Markup.inlineKeyboard([
          [Markup.button.url('💎 Subscribe to VIP', paymentUrl)],
          [Markup.button.callback('📋 View my Status', 'status')],
          [Markup.button.url('📄 Privacy Policy and Terms', PRIVACY_URL)]
        ]);
        await ctx.reply(msg, { parse_mode: 'HTML', ...keyboard });
      }
    }
  } catch (err) {
    console.error('Error in /start:', err);
    await ctx.reply('An error occurred while registering you.');
  }
});

bot.action('vip_panel', async (ctx) => {
  const user = await prisma.user.findUnique({ where: { telegramId: BigInt(ctx.from!.id) } });
  if (!user || (user.subscriptionStatus !== 'vip' && user.subscriptionStatus !== 'cancelling')) {
    return ctx.answerCbQuery('VIP only', { show_alert: true });
  }
  await replyVipPanel(ctx, true);
  await ctx.answerCbQuery();
});

bot.action('show_advisor', async (ctx) => {
  await replyAdvisorHelp(ctx);
  await ctx.answerCbQuery();
});

// ACTION: Status Button
bot.action('status', async (ctx) => {
  await replyStatusMessage(ctx);
});

bot.command('status', async (ctx) => {
  await replyStatusMessage(ctx);
});

bot.command('advisor', async (ctx) => {
  await replyAdvisorHelp(ctx);
});

async function openFiltersForUser(ctx: MyContext) {
  const fromId = ctx.from?.id;
  if (!fromId) return;
  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(fromId) },
    include: { alerts: true }
  });
  if (!user || (user.subscriptionStatus !== 'vip' && user.subscriptionStatus !== 'cancelling')) {
    await ctx.reply('🔒 VIP radar filters are exclusive to VIP. Use /start to subscribe.');
    return;
  }
  let draft: import('./menus/filters.menu.js').FilterDraft = {
    versions: [],
    engines: [],
    fuelTypes: [],
    countries: []
  };
  if (user.alerts[0]) {
    const alert = user.alerts[0];
    draft = {
      brand: alert.brand,
      model: alert.model,
      versions: alert.versions || [],
      engines: (alert as any).engines || [],
      minPowerHp: (alert as any).minPowerHp ?? null,
      maxPrice: alert.maxPrice,
      minYear: alert.minYear,
      maxMileageKm: alert.maxMileageKm,
      fuelTypes: alert.fuelTypes ?? [],
      countries: alert.countries ?? []
    };
  }
  userDrafts.set(fromId, draft);
  await renderFiltersMenu(ctx, fromId, draft, false);
}

bot.command('filters', async (ctx) => {
  await openFiltersForUser(ctx);
});

bot.command('schedule', async (ctx) => {
  await openScheduleForUser(ctx);
});

async function getDynamicPaymentLink(telegramId: number): Promise<string> {
  // Same seat bands as the admin /vip_count box — one source of truth.
  const { getVipCount, tierForVipCount } = await import('./services/vipCounter.service.js');
  const tier = tierForVipCount(await getVipCount());

  const baseUrl = process.env[tier.envVar] ?? '';
  if (!baseUrl) return '';
  return `${baseUrl}?client_reference_id=${telegramId}`;
}

// ACTION: Subscribe to VIP Button
bot.action('vip_subscribe', async (ctx) => {
  try {
    const url = await getDynamicPaymentLink(ctx.from!.id);
    if (!url) {
      return ctx.answerCbQuery('The administrator has not configured the payment link.', { show_alert: true });
    }
    
    const msg = `👑 **VIP Subscription**\n\nBy subscribing, you get:\n• 24/7 personal radar with your filters\n• Direct links to matching ads\n• Deal alerts in digests a few times a day\n• AI car advisor with full inventory access\n\n👉 [Complete Secure Payment](${url})`;

    await ctx.reply(msg, { parse_mode: 'Markdown' });
    await ctx.answerCbQuery();
  } catch (err) {
    console.error('Error in vip_subscribe:', err);
    await ctx.answerCbQuery('Error generating payment link.', { show_alert: true });
  }
});

// COMMAND: /alert (Create alerts)
bot.command('alert', async (ctx) => {
  const args = ctx.message.text.split(' ').slice(1);
  const brand = args[0];
  const maxPrice = Number(args[1]);

  if (!brand || !maxPrice || isNaN(maxPrice)) {
    return ctx.reply('❌ Incorrect format. You must use:\n`/alert [Brand] [MaxPrice]`\nExample: `/alert BMW 15000`', { parse_mode: 'Markdown' });
  }

  try {
    const user = await prisma.user.findUnique({ where: { telegramId: BigInt(ctx.from.id) } });

    if (!user || (user.subscriptionStatus !== 'vip' && user.subscriptionStatus !== 'cancelling')) {
      return ctx.reply('🔒 Setting up automatic alerts is an exclusive feature for VIP users. Press the start button to subscribe.');
    }

    const { normalizeBrand } = await import('./utils/normalizer.js');
    const brandNorm = normalizeBrand(brand) || null;

    const previousAlert = await prisma.userAlert.findFirst({ where: { userId: user.id } });
    const previous = previousAlert
      ? {
          brandNorm: previousAlert.brandNorm,
          modelNorm: previousAlert.modelNorm,
          versions: previousAlert.versions,
          maxPrice: previousAlert.maxPrice,
          minYear: previousAlert.minYear,
          maxMileageKm: previousAlert.maxMileageKm,
          fuelTypes: previousAlert.fuelTypes,
          countries: previousAlert.countries ?? []
        }
      : null;

    await prisma.userAlert.deleteMany({ where: { userId: user.id } });
    await prisma.userAlert.create({
      data: {
        userId: user.id,
        brand,
        brandNorm,
        maxPrice,
        versions: [],
        fuelTypes: [],
        countries: []
      }
    });

    const { MatchingService } = await import('./services/matching.service.js');
    await MatchingService.replaceFiltersAndResyncQueue({
      userId: user.id,
      telegramId: Number(ctx.from.id),
      previous,
      next: {
        brandNorm,
        modelNorm: null,
        versions: [],
        maxPrice,
        minYear: null,
        maxMileageKm: null,
        fuelTypes: [],
        countries: []
      }
    });

    await ctx.reply(`✅ **Radar Configured**\nI'll be watching 24/7. I'll notify you in batched alerts if any **${brand.toUpperCase()}** comes in for under **${maxPrice} €**.\n\n_Tip: use Configure VIP Filters for model, specs, fuel, year and mileage._`, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('Error in /alert:', err);
    await ctx.reply('Internal error saving the alert.');
  }
});

// COMMAND: /delete_account (Delete account — free users only)
bot.command('delete_account', async (ctx) => {
  try {
    const user = await prisma.user.findUnique({ where: { telegramId: BigInt(ctx.from.id) } });
    if (!user) {
      return ctx.reply('You are not registered in the system.');
    }

    if (user.subscriptionStatus === 'vip' || user.subscriptionStatus === 'cancelling') {
      const purgeHours = Math.max(1, parseInt(process.env.DATA_PURGE_HOURS || '48', 10) || 48);
      let untilLabel = 'the end of your billing period';

      if (user.stripeCustomerId) {
        try {
          const { stripe } = await import('./services/stripe.service.js');
          const subs = await stripe.subscriptions.list({
            customer: user.stripeCustomerId,
            status: 'active',
            limit: 1
          });
          const sub = subs.data[0];
          if (sub) {
            const ts = sub.cancel_at || (sub as { current_period_end?: number }).current_period_end;
            if (ts) {
              untilLabel = new Date(ts * 1000).toLocaleDateString('en-GB', {
                day: 'numeric',
                month: 'numeric',
                year: 'numeric'
              });
            }
          }
        } catch (e) {
          console.error('Error fetching stripe end date for /delete_account:', e);
        }
      }

      return ctx.reply(
        `⚠️ <b>Your VIP remains active until ${untilLabel}.</b>\n\n` +
          `When it ends you will switch to the free plan and can then use /delete_account, or the system will clear filters, messages with links, and personal data after <b>${purgeHours} h</b>.\n\n` +
          `Your Telegram ID is kept so the ${AI_FREE_SEARCHES_MAX} free AI trials do not reset.`,
        { parse_mode: 'HTML' }
      );
    }

    const { purgeUserPersonalData } = await import('./services/privacy.service.js');
    await purgeUserPersonalData(user.id, user.telegramId);

    const msg = `🗑️ **Account Data Cleared**\n\nYour name, active radars, and sent-listing history have been removed.\n\n*Note: Your Telegram ID is retained solely so the ${AI_FREE_SEARCHES_MAX} free AI trials cannot be reset. Type /start anytime to subscribe to VIP.*`;

    await ctx.reply(msg, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('Error in /delete_account:', err);
    await ctx.reply('An internal error occurred while deleting your account.');
  }
});

// Hidden admin helper — silence for everyone else (no hint)
bot.command('get_topic_id', async (ctx) => {
  if (!isAdminUser(ctx.from?.id)) return;
  const chat = ctx.chat;
  const msg = ctx.message as { message_thread_id?: number };
  const lines = [
    `chat.id: \`${chat.id}\``,
    `chat.type: ${chat.type}`,
    msg.message_thread_id != null ? `thread/topic: \`${msg.message_thread_id}\`` : 'thread/topic: (none)'
  ];
  await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
});

// Hidden admin helper — live VIP seat counter + current Stripe tier
bot.command('vip_count', async (ctx) => {
  if (!isAdminUser(ctx.from?.id)) return;
  try {
    const { refreshVipCounter } = await import('./services/vipCounter.service.js');
    await refreshVipCounter({ force: true });
  } catch (err) {
    console.error('❌ /vip_count failed:', redactSecrets(err));
    await ctx.reply('Could not refresh the VIP counter.');
  }
});

// FREE TEXT MANAGEMENT (Search or AI) with FREEMIUM LIMITS
bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim();
  const user = await prisma.user.findUnique({ where: { telegramId: BigInt(ctx.from.id) } });
  
  if (!user) return ctx.reply('Please use /start first to register.');
  const isVip = user.subscriptionStatus === 'vip' || user.subscriptionStatus === 'cancelling';

  const draft = userDrafts.get(Number(user.telegramId));
  if (draft && draft.awaitingInputFor) {
    let inputVal = text === 'Any' ? null : text;
    if (draft.awaitingInputFor === 'brand') {
      const prev = draft.brand || null;
      draft.brand = inputVal;
      if (prev !== (draft.brand || null)) {
        resetFiltersAfter(draft, 'brand');
      }
    } else if (draft.awaitingInputFor === 'model') {
      const prev = draft.model || null;
      draft.model = inputVal;
      if (prev !== (draft.model || null)) {
        resetFiltersAfter(draft, 'model');
      }
    }

    draft.awaitingInputFor = null;
    userDrafts.set(Number(user.telegramId), draft);
    await renderFiltersMenu(ctx, Number(user.telegramId), draft, false);
    return;
  }

  // ==========================================
  // UNIFIED ROUTE: AI AGENT (CHAT + SEARCH)
  // ==========================================

  if (!isVip) {
    if (user.freeSearchesUsed >= AI_FREE_SEARCHES_MAX) {
      return ctx.reply(`🔒 **Limit Reached**\nYou have used up your free interactions (${AI_FREE_SEARCHES_MAX}/${AI_FREE_SEARCHES_MAX}). Become a VIP for radar digests (up to 3 listings with links) and full AI chat access.`, { parse_mode: 'Markdown' });
    }
    await prisma.user.update({ where: { id: user.id }, data: { freeSearchesUsed: { increment: 1 } } });
  }

  await ctx.sendChatAction('typing');

  try {
    if (!ctx.session) {
      ctx.session = { chatHistory: [] };
    }
    
    const aiResponse = await AiBrokerService.handleUserChat(
      text,
      isVip,
      BigInt(ctx.from.id),
      userDrafts.get(Number(user.telegramId)),
      ctx.session.chatHistory
    );
    
    // CORRECTED: Save roles properly as ChatMessage
    ctx.session.chatHistory.push({ role: 'user', content: text });
    ctx.session.chatHistory.push({ role: 'assistant', content: aiResponse.replyText });
    
    // Keep only the latest interactions to not exceed token limit
    if (ctx.session.chatHistory.length > 6) {
      ctx.session.chatHistory = ctx.session.chatHistory.slice(-6);
    }
    
    if (!aiResponse.cars || aiResponse.cars.length === 0) {
      let html = aiReplyToTelegramHtml(aiResponse.replyText);
      if (isVip && aiResponse.dailyUsed && aiResponse.dailyLimit) {
        let footer = `AI: ${aiResponse.dailyUsed}/${aiResponse.dailyLimit} today`;
        if (aiResponse.dbLookupsLimit != null) {
          footer += ` · Recoveries: ${aiResponse.dbLookupsUsed ?? 0}/${aiResponse.dbLookupsLimit}`;
        }
        html += `\n\n${htmlItalic(footer)}`;
      }
      return ctx.reply(html, { parse_mode: 'HTML' });
    }

    let responseText = `${aiReplyToTelegramHtml(aiResponse.replyText)}\n\n`;
    const sentCarIds: string[] = [];
    const attachLink = Boolean(aiResponse.attachListingLink);

    for (const car of aiResponse.cars) {
      sentCarIds.push(car.id);
      responseText += `🔹 ${htmlBold(`${car.brand} ${car.model}`)} (${escapeHtml(String(car.year))})\n`;
      responseText += `💰 Price: ${escapeHtml(String(car.price))} €\n`;
      responseText += `🛣️ KM: ${escapeHtml(String(car.mileageKm))}\n`;

      if (attachLink && isVip && car.originalUrl) {
        responseText += `🔗 ${htmlLink('Listing found', car.originalUrl)}\n\n`;
      } else if (attachLink && !isVip) {
        responseText += `🔒 ${htmlItalic('Link hidden — VIP unlocks clickable ads and radar digests.')}\n\n`;
      } else {
        responseText += `\n`;
      }
    }

    if (isVip && aiResponse.dailyUsed && aiResponse.dailyLimit) {
      let footer = `AI: ${aiResponse.dailyUsed}/${aiResponse.dailyLimit} today`;
      if (aiResponse.dbLookupsLimit != null) {
        footer += ` · Recoveries: ${aiResponse.dbLookupsUsed ?? 0}/${aiResponse.dbLookupsLimit}`;
      }
      responseText += htmlItalic(footer);
    }

    await ctx.reply(responseText, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true }
    });

    const sentData = sentCarIds.map((id) => ({
      userId: user.id,
      carId: id
    }));
    await prisma.sentListing.createMany({ data: sentData, skipDuplicates: true });

  } catch (error) {
    console.error('❌ Error in the Unified AI Agent:', error);
    await ctx.reply('An error occurred while processing your message. Please try again later.');
  }
});

const app = (express as any).default ? (express as any).default() : (express as any)();

app.disable('x-powered-by');
// Behind Nginx Proxy Manager (HTTPS termination)
app.set('trust proxy', 1);

app.get(
  '/health',
  rateLimit({ windowMs: 60_000, max: 60, keyPrefix: 'health' }),
  async (_req: express.Request, res: express.Response) => {
    // Docker / NPM probe: fail closed if DB or Redis is down so depends_on:healthy
    // does not start the scraper against a half-dead app. Body stays minimal —
    // never leak internal error strings publicly.
    let dbOk = false;
    let redisOk = false;
    try {
      await prisma.$queryRaw`SELECT 1`;
      dbOk = true;
    } catch {
      dbOk = false;
    }
    try {
      const { getRedis, isRedisReady } = await import('./db/redis.js');
      const r = getRedis();
      if (r && isRedisReady()) {
        const pong = await r.ping();
        redisOk = pong === 'PONG';
      }
    } catch {
      redisOk = false;
    }

    if (!dbOk || !redisOk) {
      return res.status(503).json({ status: 'unhealthy' });
    }
    return res.status(200).json({ status: 'ok' });
  }
);

app.post(
  '/webhook',
  rateLimit({ windowMs: 60_000, max: 120, keyPrefix: 'stripe' }),
  express.raw({ type: 'application/json', limit: '256kb' }),
  async (req: express.Request, res: express.Response) => {
    const signature = req.headers['stripe-signature'];
    if (!signature || typeof signature !== 'string') {
      return res.status(400).send('Bad request');
    }
    if (!process.env.STRIPE_WEBHOOK_SECRET) {
      console.error('❌ STRIPE_WEBHOOK_SECRET is not set');
      return res.status(500).send('Server misconfigured');
    }
    try {
      await StripeService.handleWebhook(signature, req.body);
      res.status(200).send('ok');
    } catch (err) {
      console.error('❌ Stripe webhook error:', redactSecrets(err));
      res.status(400).send('Webhook Error');
    }
  }
);

// Only health + Stripe webhook are public via NPM — reject everything else
app.use((_req: express.Request, res: express.Response) => {
  res.status(404).send('Not found');
});

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('❌ Express error:', redactSecrets(err));
  res.status(500).send('Internal error');
});

/**
 * Admin chat only: expose the ops commands there without leaking them to users.
 * Telegram scopes are per-chat, so the list must repeat the public commands too.
 */
async function registerAdminCommands(): Promise<void> {
  const adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID?.trim();
  if (!adminChatId) return;

  try {
    await bot.telegram.setMyCommands(
      [
        { command: 'vip_count', description: '💎 Live VIP counter + Stripe tier' },
        { command: 'get_topic_id', description: 'Show chat / topic id' },
        { command: 'status', description: 'Your subscription and AI usage' },
        { command: 'start', description: 'Open the main menu' }
      ],
      { scope: { type: 'chat', chat_id: adminChatId } }
    );
    console.log('🛠️ Admin commands registered for the ops chat.');
  } catch (err) {
    console.warn('⚠️ Could not register admin-scoped commands:', redactSecrets(err));
  }
}

async function bootstrap() {
  const mode = getWorkerMode();
  const asApp = runsAppRole(mode);
  const asScraper = runsScraperRole(mode);
  console.log(`🚀 Starting Auto Broker AI (WORKER_MODE=${mode})...`);

  try {
    await prisma.$connect();
    console.log('🗄️ Database connected.');

    await initRedis();

    // Heal empty versionTokens from version text (default on). Full norms if BACKFILL_NORMS=true.
    if (
      asApp &&
      (process.env.BACKFILL_NORMS === 'true' || process.env.BACKFILL_VERSION_TOKENS !== 'false')
    ) {
      console.log('🔧 Backfilling listing norms / empty versionTokens...');
      try {
        const n = await backfillListingNorms();
        console.log(`🔧 Backfill complete: ${n} listings updated.`);
        if (n > 0) {
          const { invalidateInventoryCache } = await import('./services/inventory.service.js');
          await invalidateInventoryCache();
          console.log('🔧 Inventory cache cleared after norms backfill.');
        }
      } catch (err) {
        console.error('⚠️ Backfill skipped (schema may still be migrating):', err);
      }
    }

    if (asApp) {
      setupFiltersMenu(bot);
      setupScheduleMenu(bot);

      await bot.telegram.setMyCommands([
        { command: 'start', description: 'Open the main menu' },
        { command: 'filters', description: 'Configure your VIP radar' },
        { command: 'schedule', description: 'Digest days, hours & frequency' },
        { command: 'advisor', description: 'How the AI advisor works' },
        { command: 'status', description: 'Your subscription and AI usage' },
        { command: 'delete_account', description: 'Clear personal data (after VIP ends)' }
      ]);

      await registerAdminCommands();

      bot.launch().then(() => console.log('🤖 Telegram bot initialized and listening.'));

      const PORT = parseInt(process.env.PORT || '3003', 10);
      // 0.0.0.0 inside the container; host publishes only 127.0.0.1:3003 (see docker-compose)
      app.listen(PORT, '0.0.0.0', () =>
        console.log(`💳 Webhooks on 0.0.0.0:${PORT} (host should bind 127.0.0.1:${PORT})`)
      );

      startBackupCron();
      queueService.start();
      startUrlVerifyCron();

      const { startCriticalRelayDrain } = await import('./utils/adminNotify.js');
      startCriticalRelayDrain();

      // Boot is noisy (migrations, backfills); let it settle before touching the box.
      setTimeout(() => {
        void import('./services/vipCounter.service.js').then(({ refreshVipCounter }) =>
          refreshVipCounter()
        );
      }, 12_000);
    }

    if (asScraper) {
      // Playwright / HTTP scrapers + cleanup / inventory — isolated container in compose
      startScraperCron();
      startInventoryStatsCron();
    }

    if (!asApp && !asScraper) {
      throw new Error(`WORKER_MODE=${mode} enables no roles`);
    }
  } catch (error) {
    console.error('❌ Critical error on startup:', error);
    try {
      const { notifyAdminCritical } = await import('./utils/adminNotify.js');
      await notifyAdminCritical(
        `🚨 **App startup FAILED** (${mode})\n\n${redactSecrets((error as Error).message || error)}`
      );
    } catch { /* ignore */ }
    process.exit(1);
  }
}

process.on('uncaughtException', async (error) => {
  console.error('❌ uncaughtException:', error);
  try {
    const { notifyAdminCritical } = await import('./utils/adminNotify.js');
    await notifyAdminCritical(
      `🚨 **uncaughtException**\n\n${redactSecrets(error?.message || error)}`
    );
  } catch { /* ignore */ }
});

process.on('unhandledRejection', async (reason) => {
  console.error('❌ unhandledRejection:', reason);
  try {
    const { notifyAdminCritical } = await import('./utils/adminNotify.js');
    await notifyAdminCritical(
      `🚨 **unhandledRejection**\n\n${redactSecrets(reason)}`
    );
  } catch { /* ignore */ }
});

process.once('SIGINT', async () => {
  if (runsAppRole()) {
    try {
      bot.stop('SIGINT');
    } catch { /* scraper role never launched polling */ }
  }
  await disconnectRedis();
  await prisma.$disconnect();
  process.exit(0);
});
process.once('SIGTERM', async () => {
  if (runsAppRole()) {
    try {
      bot.stop('SIGTERM');
    } catch { /* scraper role never launched polling */ }
  }
  await disconnectRedis();
  await prisma.$disconnect();
  process.exit(0);
});

/**
 * Only boot when this process was started as the app entrypoint.
 * Importing `{ bot }` from queue/tests must NOT connect DB or page Telegram
 * (that caused false "startup FAILED … 127.0.0.1:5435" admin alerts).
 *
 * Note: under `tsx`, argv[1] is often the tsx CLI — look for `src/index.ts` anywhere in argv.
 */
function shouldBootstrap(): boolean {
  if (process.env.SKIP_APP_BOOTSTRAP === 'true') return false;
  const joined = process.argv.join(' ').replace(/\\/g, '/');
  return /(?:^|[\s/])src\/index\.(ts|js)(?:\s|$)/.test(joined) ||
    /(?:^|[\s/])dist\/index\.(js)(?:\s|$)/.test(joined);
}

if (shouldBootstrap()) {
  void bootstrap();
}