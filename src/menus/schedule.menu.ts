/**
 * VIP /schedule — per-user digest days, hours, interval.
 * Draft + Done (writes User prefs). Server TZ: Europe/Madrid.
 */
import { Telegraf, Markup } from 'telegraf';
import { prisma } from '../db/prisma.js';
import {
  ALL_WEEKDAYS,
  WEEKDAYS_ONLY,
  SCHEDULE_START_HOURS,
  SCHEDULE_END_HOURS,
  clampSchedulePrefs,
  formatDigestDays,
  formatHourRange,
  loadDigestPrefs,
  saveDigestPrefs,
  type DigestPrefs
} from '../services/digestSchedule.service.js';

interface ScheduleDraft extends DigestPrefs {
  view?: 'main' | 'days' | 'hours_start' | 'hours_end' | 'interval';
  /** Snapshot of last saved prefs — used to warn about unsaved edits. */
  savedFingerprint?: string;
}

const drafts = new Map<number, ScheduleDraft>();

function prefsFingerprint(p: DigestPrefs): string {
  return JSON.stringify({
    days: [...p.days].sort((a, b) => a - b),
    startHour: p.startHour,
    endHour: p.endHour,
    intervalH: p.intervalH
  });
}

function clonePrefs(p: DigestPrefs): ScheduleDraft {
  const base = {
    days: [...p.days],
    startHour: p.startHour,
    endHour: p.endHour,
    intervalH: p.intervalH,
    paused: false,
    view: 'main' as const
  };
  return {
    ...base,
    savedFingerprint: prefsFingerprint(base)
  };
}

function isDraftDirty(draft: ScheduleDraft): boolean {
  if (!draft.savedFingerprint) return false;
  return prefsFingerprint(draft) !== draft.savedFingerprint;
}

async function requireVip(telegramId: number): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(telegramId) },
    select: { subscriptionStatus: true }
  });
  return (
    !!user &&
    (user.subscriptionStatus === 'vip' || user.subscriptionStatus === 'cancelling')
  );
}

async function loadDraft(telegramId: number): Promise<ScheduleDraft> {
  let d = drafts.get(telegramId);
  if (!d) {
    d = clonePrefs(clampSchedulePrefs(await loadDigestPrefs(telegramId)));
    // Ensure defaults show as selected when user never customized hours
    if (!Number.isFinite(d.startHour)) d.startHour = 8;
    if (!Number.isFinite(d.endHour)) d.endHour = 21;
    drafts.set(telegramId, d);
  }
  return d;
}

/** Persist draft edits without wiping the last-saved fingerprint. */
function putDraft(
  telegramId: number,
  next: ScheduleDraft,
  prev?: ScheduleDraft
): ScheduleDraft {
  const merged: ScheduleDraft = {
    ...next,
    savedFingerprint: next.savedFingerprint ?? prev?.savedFingerprint
  };
  drafts.set(telegramId, merged);
  return merged;
}

function isTelegramNotModifiedError(err: unknown): boolean {
  const desc =
    (err as any)?.response?.description ||
    (err as any)?.message ||
    '';
  return typeof desc === 'string' && desc.includes('message is not modified');
}

async function safeEdit(ctx: any, text: string, extra?: object) {
  try {
    await ctx.editMessageText(text, extra);
  } catch (err) {
    if (!isTelegramNotModifiedError(err)) throw err;
  }
}

async function renderSchedulePanel(ctx: any, telegramId: number, edit: boolean) {
  const draft = await loadDraft(telegramId);

  if (draft.view === 'days') return renderDays(ctx, draft, edit);
  if (draft.view === 'hours_start') return renderHoursStart(ctx, draft, edit);
  if (draft.view === 'hours_end') return renderHoursEnd(ctx, draft, edit);
  if (draft.view === 'interval') return renderInterval(ctx, draft, edit);

  const dirty = isDraftDirty(draft);
  const text =
    `⏰ **Digest schedule** (Europe/Madrid)\n\n` +
    `📅 Days: ${formatDigestDays(draft.days)}\n` +
    `🕐 Hours: ${formatHourRange(draft.startHour, draft.endHour)}\n` +
    `🔁 Every: ${draft.intervalH}h\n\n` +
    (dirty
      ? `⚠️ **Unsaved changes** — tap **Done** to apply, or they stay as draft only.\n\n`
      : '') +
    `_Tap **Done** to save._`;

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('📅 Days', 'sched_view_days'),
      Markup.button.callback('🕐 Hours', 'sched_view_hours_start')
    ],
    [Markup.button.callback('🔁 Interval', 'sched_view_interval')],
    [Markup.button.callback('✅ Done', 'sched_save')]
  ]);

  if (edit && ctx.updateType === 'callback_query') {
    await safeEdit(ctx, text, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
  } else {
    await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
  }
}

async function renderDays(ctx: any, draft: ScheduleDraft, edit: boolean) {
  const labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const dayBtns = labels.map((label, i) => {
    const day = i + 1;
    const on = draft.days.includes(day);
    return Markup.button.callback(
      `${on ? '✅' : '⬜'} ${label}`,
      `sched_day_${day}`
    );
  });

  const rows = [
    dayBtns.slice(0, 4),
    dayBtns.slice(4),
    [
      Markup.button.callback('Weekdays', 'sched_days_weekdays'),
      Markup.button.callback('All week', 'sched_days_all')
    ],
    [
      Markup.button.callback('🔙 Back', 'sched_view_main'),
      Markup.button.callback('✅ Keep', 'sched_view_main')
    ]
  ];

  const text =
    `📅 **Select days**\n\n` +
    `Current: ${formatDigestDays(draft.days)}\n\n` +
    `_Multi-select. Empty → All week on save._`;

  const keyboard = Markup.inlineKeyboard(rows);
  if (edit) {
    await safeEdit(ctx, text, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
  } else {
    await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
  }
}

function hourChoiceButtons(
  selected: number,
  hours: number[],
  prefix: string
) {
  const btns = hours.map((h) => {
    const mark = h === selected ? '✅ ' : '';
    return Markup.button.callback(
      `${mark}${String(h).padStart(2, '0')}:00`,
      `${prefix}${h}`
    );
  });
  const rows: ReturnType<typeof Markup.button.callback>[][] = [];
  for (let i = 0; i < btns.length; i += 4) {
    rows.push(btns.slice(i, i + 4));
  }
  return rows;
}

async function renderHoursStart(ctx: any, draft: ScheduleDraft, edit: boolean) {
  // Start hour: morning only (07–12). Evening slots are for end hour.
  const morning = SCHEDULE_START_HOURS.filter((h) => h >= 7 && h <= 12);
  const rows = hourChoiceButtons(draft.startHour, [...morning], 'sched_start_');
  rows.push([
    Markup.button.callback('🔙 Back', 'sched_view_main'),
    Markup.button.callback('✅ Done', 'sched_hours_start_done')
  ]);

  const text =
    `🕐 **Start hour** (Europe/Madrid)\n\n` +
    `Current window: ${formatHourRange(draft.startHour, draft.endHour)}\n` +
    `_Default start: 08:00. Choose 07:00–12:00, then tap **Done**._`;

  const keyboard = Markup.inlineKeyboard(rows);
  if (edit) {
    await safeEdit(ctx, text, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
  } else {
    await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
  }
}

async function renderHoursEnd(ctx: any, draft: ScheduleDraft, edit: boolean) {
  // End hour: evening only — always 19:00–23:00 (never morning)
  const ends = [...SCHEDULE_END_HOURS];
  const rows = hourChoiceButtons(draft.endHour, ends, 'sched_end_');
  rows.push([
    Markup.button.callback('🔙 Back', 'sched_view_hours_start'),
    Markup.button.callback('✅ Done', 'sched_hours_end_done')
  ]);

  const text =
    `🕐 **End hour** (Europe/Madrid)\n\n` +
    `Current window: ${formatHourRange(draft.startHour, draft.endHour)}\n` +
    `_Default end: 21:00. Choose 19:00–23:00, then tap **Done**._`;

  const keyboard = Markup.inlineKeyboard(rows);
  if (edit) {
    await safeEdit(ctx, text, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
  } else {
    await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
  }
}

async function renderInterval(ctx: any, draft: ScheduleDraft, edit: boolean) {
  const opts = [1, 2, 3, 4];
  const row = opts.map((h) =>
    Markup.button.callback(
      `${draft.intervalH === h ? '✅ ' : ''}${h}h`,
      `sched_interval_${h}`
    )
  );

  const text =
    `🔁 **Digest interval**\n\n` +
    `Current: every **${draft.intervalH}h**\n` +
    `_Minimum 1h · Maximum 4h · Default 2h. Tap **Done** to confirm._`;

  const keyboard = Markup.inlineKeyboard([
    row,
    [
      Markup.button.callback('🔙 Back', 'sched_view_main'),
      Markup.button.callback('✅ Done', 'sched_interval_done')
    ]
  ]);

  if (edit) {
    await safeEdit(ctx, text, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
  } else {
    await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
  }
}

export async function openScheduleForUser(ctx: any) {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;
  if (!(await requireVip(telegramId))) {
    await ctx.reply('🔒 Digest schedule is exclusive to VIP. Use /start to subscribe.');
    return;
  }
  drafts.set(telegramId, clonePrefs(clampSchedulePrefs(await loadDigestPrefs(telegramId))));
  await renderSchedulePanel(ctx, telegramId, false);
}

export function setupScheduleMenu(bot: Telegraf) {
  bot.action('vip_schedule', async (ctx) => {
    const telegramId = ctx.from!.id;
    if (!(await requireVip(telegramId))) {
      return ctx.answerCbQuery('Available for VIP users only.', { show_alert: true });
    }
    drafts.set(telegramId, clonePrefs(clampSchedulePrefs(await loadDigestPrefs(telegramId))));
    await renderSchedulePanel(ctx, telegramId, true);
    await ctx.answerCbQuery();
  });

  bot.action('sched_view_main', async (ctx) => {
    const telegramId = ctx.from!.id;
    const d = await loadDraft(telegramId);
    const clamped = clampSchedulePrefs(d);
    putDraft(telegramId, { ...clamped, paused: false, view: 'main' }, d);
    await renderSchedulePanel(ctx, telegramId, true);
    await ctx.answerCbQuery();
  });

  bot.action('sched_view_days', async (ctx) => {
    const telegramId = ctx.from!.id;
    const d = await loadDraft(telegramId);
    d.view = 'days';
    drafts.set(telegramId, d);
    await renderSchedulePanel(ctx, telegramId, true);
    await ctx.answerCbQuery();
  });

  bot.action('sched_view_hours_start', async (ctx) => {
    const telegramId = ctx.from!.id;
    const d = await loadDraft(telegramId);
    d.view = 'hours_start';
    drafts.set(telegramId, d);
    await renderSchedulePanel(ctx, telegramId, true);
    await ctx.answerCbQuery();
  });

  bot.action('sched_view_hours_end', async (ctx) => {
    const telegramId = ctx.from!.id;
    const d = await loadDraft(telegramId);
    d.view = 'hours_end';
    drafts.set(telegramId, d);
    await renderSchedulePanel(ctx, telegramId, true);
    await ctx.answerCbQuery();
  });

  bot.action('sched_view_interval', async (ctx) => {
    const telegramId = ctx.from!.id;
    const d = await loadDraft(telegramId);
    d.view = 'interval';
    drafts.set(telegramId, d);
    await renderSchedulePanel(ctx, telegramId, true);
    await ctx.answerCbQuery();
  });

  bot.action(/^sched_day_(\d+)$/, async (ctx) => {
    const day = parseInt(ctx.match?.[1] || '0', 10);
    if (day < 1 || day > 7) return ctx.answerCbQuery();
    const telegramId = ctx.from!.id;
    const d = await loadDraft(telegramId);
    const idx = d.days.indexOf(day);
    if (idx >= 0) d.days.splice(idx, 1);
    else d.days.push(day);
    d.days.sort((a, b) => a - b);
    d.view = 'days';
    drafts.set(telegramId, d);
    await renderSchedulePanel(ctx, telegramId, true);
    await ctx.answerCbQuery();
  });

  bot.action('sched_days_weekdays', async (ctx) => {
    const telegramId = ctx.from!.id;
    const d = await loadDraft(telegramId);
    d.days = [...WEEKDAYS_ONLY];
    d.view = 'days';
    drafts.set(telegramId, d);
    await renderSchedulePanel(ctx, telegramId, true);
    await ctx.answerCbQuery('Weekdays');
  });

  bot.action('sched_days_all', async (ctx) => {
    const telegramId = ctx.from!.id;
    const d = await loadDraft(telegramId);
    d.days = [...ALL_WEEKDAYS];
    d.view = 'days';
    drafts.set(telegramId, d);
    await renderSchedulePanel(ctx, telegramId, true);
    await ctx.answerCbQuery('All week');
  });

  bot.action(/^sched_start_(\d+)$/, async (ctx) => {
    const h = parseInt(ctx.match?.[1] || '', 10);
    const telegramId = ctx.from!.id;
    const d = await loadDraft(telegramId);
    d.startHour = h;
    // Keep end valid if needed; stay on start screen until Done
    const clamped = clampSchedulePrefs(d);
    putDraft(telegramId, { ...clamped, paused: false, view: 'hours_start' }, d);
    await renderSchedulePanel(ctx, telegramId, true);
    await ctx.answerCbQuery(`Start ${String(h).padStart(2, '0')}:00`);
  });

  bot.action('sched_hours_start_done', async (ctx) => {
    const telegramId = ctx.from!.id;
    const d = await loadDraft(telegramId);
    const clamped = clampSchedulePrefs(d);
    putDraft(telegramId, { ...clamped, paused: false, view: 'hours_end' }, d);
    await renderSchedulePanel(ctx, telegramId, true);
    await ctx.answerCbQuery('Start hour set');
  });

  bot.action(/^sched_end_(\d+)$/, async (ctx) => {
    const h = parseInt(ctx.match?.[1] || '', 10);
    const telegramId = ctx.from!.id;
    const d = await loadDraft(telegramId);
    d.endHour = h;
    const clamped = clampSchedulePrefs(d);
    // Stay on end screen until Done
    putDraft(telegramId, { ...clamped, paused: false, view: 'hours_end' }, d);
    await renderSchedulePanel(ctx, telegramId, true);
    await ctx.answerCbQuery(`End ${String(h).padStart(2, '0')}:00`);
  });

  bot.action('sched_hours_end_done', async (ctx) => {
    const telegramId = ctx.from!.id;
    const d = await loadDraft(telegramId);
    const clamped = clampSchedulePrefs(d);
    putDraft(telegramId, { ...clamped, paused: false, view: 'main' }, d);
    await renderSchedulePanel(ctx, telegramId, true);
    await ctx.answerCbQuery('Hours updated');
  });

  bot.action(/^sched_interval_(\d+)$/, async (ctx) => {
    const h = parseInt(ctx.match?.[1] || '', 10);
    const telegramId = ctx.from!.id;
    const d = await loadDraft(telegramId);
    d.intervalH = h;
    const clamped = clampSchedulePrefs(d);
    // Stay on interval screen until Done
    putDraft(telegramId, { ...clamped, paused: false, view: 'interval' }, d);
    await renderSchedulePanel(ctx, telegramId, true);
    await ctx.answerCbQuery(`Every ${h}h`);
  });

  bot.action('sched_interval_done', async (ctx) => {
    const telegramId = ctx.from!.id;
    const d = await loadDraft(telegramId);
    const clamped = clampSchedulePrefs(d);
    putDraft(telegramId, { ...clamped, paused: false, view: 'main' }, d);
    await renderSchedulePanel(ctx, telegramId, true);
    await ctx.answerCbQuery('Interval set');
  });

  bot.action('sched_save', async (ctx) => {
    const telegramId = ctx.from!.id;
    if (!(await requireVip(telegramId))) {
      return ctx.answerCbQuery('VIP only.', { show_alert: true });
    }
    const d = await loadDraft(telegramId);
    const saved = await saveDigestPrefs(telegramId, { ...d, paused: false });
    drafts.set(telegramId, clonePrefs(saved));
    const text =
      `✅ **Schedule saved**\n\n` +
      `📅 ${formatDigestDays(saved.days)}\n` +
      `🕐 ${formatHourRange(saved.startHour, saved.endHour)} (Europe/Madrid)\n` +
      `🔁 Every ${saved.intervalH}h`;

    await safeEdit(ctx, text, {
      parse_mode: 'Markdown',
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('⏰ Edit schedule', 'vip_schedule')]
      ]).reply_markup
    });
    await ctx.answerCbQuery('Saved');
  });
}
