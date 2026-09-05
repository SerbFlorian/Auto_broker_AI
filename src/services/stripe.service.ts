import Stripe from 'stripe';
import { prisma } from '../db/prisma.js';

export const stripe: Stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
  apiVersion: '2026-06-24.dahlia', // Use the API version required by the types
});

/** Keeps the admin VIP box in sync after any subscription state change. */
async function refreshAdminVipCounter(): Promise<void> {
  try {
    const { scheduleVipCounterRefresh } = await import('./vipCounter.service.js');
    scheduleVipCounterRefresh();
  } catch {
    /* never let the admin box break a webhook */
  }
}

export class StripeService {
  // NOTE: We have switched to using fixed Payment Links (in .env) instead of dynamic sessions.

  /**
   * Validates and processes the Stripe Webhook
   */
  static async handleWebhook(signature: string, body: string | Buffer) {
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';
    if (!webhookSecret) {
      throw new Error('STRIPE_WEBHOOK_SECRET missing');
    }
    if (!signature) {
      throw new Error('Missing stripe-signature');
    }

    try {
      const event = stripe.webhooks.constructEvent(body, signature, webhookSecret);

      if (event.type === 'checkout.session.completed') {
        const session = event.data.object as Stripe.Checkout.Session;
        const telegramId = session.client_reference_id;
        const customerId = session.customer as string;

        if (telegramId) {
          const { bot } = await import('../index.js');
          await bot.telegram.sendMessage(
            Number(telegramId),
            `🎉 **VIP Subscription Activated!**\n\nWelcome to the VIP Deal Radar!\n\nTo get started, send the /start command to open your dashboard, where you can configure filters and manage your subscription.`,
            { parse_mode: 'Markdown' }
          );
          await prisma.user.update({
            where: { telegramId: BigInt(telegramId) },
            data: {
              subscriptionStatus: 'vip',
              stripeCustomerId: customerId,
              becameFreeAt: null,
            },
          });
          console.log(`✅ [Stripe] User ${telegramId} has been upgraded to VIP.`);
          await refreshAdminVipCounter();
        }
      } else if (event.type === 'customer.subscription.updated') {
        const subscription = event.data.object as Stripe.Subscription;
        const customerId = subscription.customer as string;

        const user = await prisma.user.findUnique({ where: { stripeCustomerId: customerId } });

        if (user) {
          const { bot } = await import('../index.js');
          
          if (subscription.cancel_at_period_end || subscription.cancel_at) {
            // User has canceled the subscription but still has days left
            const cancelTimestamp = subscription.cancel_at || (subscription as any).current_period_end;
            const endDate = new Date(cancelTimestamp * 1000).toLocaleDateString('en-US');
            
            // If the status was not already 'cancelling', we notify them and update the status (to avoid Stripe spam)
            if (user.subscriptionStatus !== 'cancelling') {
              await prisma.user.update({
                where: { stripeCustomerId: customerId },
                data: { subscriptionStatus: 'cancelling' }
              });

              await bot.telegram.sendMessage(
                Number(user.telegramId),
                `⚠️ **Subscription Canceled**\n\nYour VIP subscription has been canceled. You will continue to receive real-time alerts until ${endDate}.\n\nAfter that date, your access will be disabled. To manage or reactivate your subscription, use the /start command and select "Manage Subscription".`,
                { parse_mode: 'Markdown' }
              );
              await refreshAdminVipCounter();
            }
          } else {
            // If not canceling, it means the subscription is normally active or has been reactivated
            if (user.subscriptionStatus === 'cancelling') {
              await prisma.user.update({
                where: { stripeCustomerId: customerId },
                data: { subscriptionStatus: 'vip', becameFreeAt: null }
              });

              await bot.telegram.sendMessage(
                Number(user.telegramId),
                `✅ **Subscription Reactivated**\n\nWelcome back! Your subscription has been successfully reactivated.\n\nYou will continue to enjoy uninterrupted VIP access.`,
                { parse_mode: 'Markdown' }
              );
              await refreshAdminVipCounter();
            }
          }
        }
      } else if (event.type === 'customer.subscription.deleted') {
        const subscription = event.data.object as Stripe.Subscription;
        const customerId = subscription.customer as string;

        const user = await prisma.user.findUnique({ where: { stripeCustomerId: customerId } });
        if (user) {
          const { bot } = await import('../index.js');
          await bot.telegram.sendMessage(
            Number(user.telegramId),
            `❌ **VIP Subscription Expired**\n\nYour VIP subscription has ended, and you have been switched to the Free Plan.\n\nTo regain access to unlimited searches and real-time alerts, use the /start command to subscribe again.`,
            { parse_mode: 'Markdown' }
          );

          await prisma.user.update({
            where: { stripeCustomerId: customerId },
            data: {
              subscriptionStatus: 'free',
              becameFreeAt: new Date()
            },
          });

          try {
            const { queueService } = await import('./queue.service.js');
            await queueService.clearUserQueue(Number(user.telegramId));
          } catch {
            /* ignore */
          }

          await refreshAdminVipCounter();
          console.log(`❌ [Stripe] Subscription for customer ${customerId} has expired.`);
        }
      }

      return true;
    } catch (err: any) {
      console.error('❌ Error verifying Stripe webhook:', err.message);
      throw err;
    }
  }
}
