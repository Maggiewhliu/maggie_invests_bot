// vipAdminCommands.js - VIP管理員指令
const { Markup } = require('telegraf');

class VIPAdminCommands {
  constructor(bot, db) {
    this.bot = bot;
    this.db = db;
    this.setupCommands();
  }

  setupCommands() {
    // 管理員中間件
    const adminOnly = async (ctx, next) => {
      const isAdmin = await this.db.isAdmin(ctx.from.id);
      if (!isAdmin) {
        return ctx.reply('❌ 此指令僅限管理員使用');
      }
      return next();
    };

    // ============================================
    // /activate_vip - 手動開通VIP
    // ============================================

    this.bot.command('activate_vip', adminOnly, async (ctx) => {
      const args = ctx.message.text.split(' ').slice(1);
      
      if (args.length < 3) {
        return ctx.reply(
          '📝 *VIP手動開通*\n\n' +
          '使用方法：\n' +
          '`/activate_vip <用戶ID> <方案> <天數>`\n\n' +
          '方案選項：\n' +
          '• `monthly` - 月付 ($49)\n' +
          '• `quarterly` - 季付 ($129)\n' +
          '• `yearly` - 年付 ($468)\n\n' +
          '範例：\n' +
          '`/activate_vip 123456789 monthly 30`\n' +
          '`/activate_vip 123456789 quarterly 90`\n' +
          '`/activate_vip 123456789 yearly 365`',
          { parse_mode: 'Markdown' }
        );
      }

      const userId = parseInt(args[0]);
      const plan = args[1].toLowerCase();
      const days = parseInt(args[2]);

      if (isNaN(userId) || isNaN(days)) {
        return ctx.reply('❌ 用戶ID和天數必須是數字');
      }

      const validPlans = ['monthly', 'quarterly', 'yearly'];
      if (!validPlans.includes(plan)) {
        return ctx.reply('❌ 無效的方案類型\n請使用：monthly、quarterly 或 yearly');
      }

      // 金額對應
      const amounts = {
        monthly: 49,
        quarterly: 129,
        yearly: 468
      };

      try {
        // 檢查用戶是否存在
        const user = await this.db.getUser(userId);
        if (!user) {
          return ctx.reply('❌ 找不到此用戶\n請確認用戶ID是否正確');
        }

        // 創建VIP訂閱
        const subscriptionId = await this.db.createVIPSubscription(
          userId,
          plan,
          amounts[plan],
          days
        );

        // 記錄管理操作
        await this.db.logAction(
          ctx.from.id,
          'ACTIVATE_VIP',
          userId,
          { plan, days, subscriptionId }
        );

        // 生成VIP群組邀請連結
        let inviteLink = null;
        try {
          const link = await ctx.telegram.createChatInviteLink(
            process.env.VIP_GROUP_ID,
            {
              member_limit: 1,
              name: `VIP_${user.username || userId}`
            }
          );
          inviteLink = link.invite_link;
        } catch (e) {
          console.error('創建邀請連結失敗:', e);
        }

        // 通知管理員
        await ctx.reply(
          `✅ *VIP已成功開通*\n\n` +
          `👤 用戶：@${user.username || '無用戶名'} (${userId})\n` +
          `💎 方案：${this.getPlanName(plan)}\n` +
          `💰 金額：$${amounts[plan]} USD\n` +
          `⏰ 期限：${days}天\n` +
          `📅 到期時間：${this.calculateExpiryDate(days)}\n\n` +
          `✨ 用戶已自動收到通知`,
          { parse_mode: 'Markdown' }
        );

        // 通知用戶
        const userMessage = 
          `🎉 *VIP會員已開通！*\n\n` +
          `✨ 您現在是 👑 *VIP會員*\n\n` +
          `📋 訂閱詳情：\n` +
          `• 方案：${this.getPlanName(plan)}\n` +
          `• 期限：${days}天\n` +
          `• 到期時間：${this.calculateExpiryDate(days)}\n\n` +
          `💎 *VIP專屬功能已開通：*\n` +
          `✅ 每2小時更新七巨頭報告\n` +
          `✅ 標普500完整分析\n` +
          `✅ IPO深度分析\n` +
          `✅ 市場情緒指標\n` +
          `✅ 價格提醒功能\n` +
          `✅ 投資組合追蹤\n\n` +
          (inviteLink ? `🔗 *VIP群組邀請連結：*\n${inviteLink}\n\n` : '') +
          `📖 使用 /help 查看所有VIP指令\n\n` +
          `感謝您的支持！🙏`;

        await ctx.telegram.sendMessage(userId, userMessage, {
          parse_mode: 'Markdown'
        });

      } catch (error) {
        console.error('開通VIP失敗:', error);
        await ctx.reply('❌ 開通VIP失敗：' + error.message);
      }
    });

    // ============================================
    // /extend_vip - 延長VIP
    // ============================================

    this.bot.command('extend_vip', adminOnly, async (ctx) => {
      const args = ctx.message.text.split(' ').slice(1);
      
      if (args.length < 2) {
        return ctx.reply(
          '📝 *延長VIP期限*\n\n' +
          '使用方法：\n' +
          '`/extend_vip <用戶ID> <天數>`\n\n' +
          '範例：\n' +
          '`/extend_vip 123456789 30` - 延長30天',
          { parse_mode: 'Markdown' }
        );
      }

      const userId = parseInt(args[0]);
      const days = parseInt(args[1]);

      if (isNaN(userId) || isNaN(days)) {
        return ctx.reply('❌ 用戶ID和天數必須是數字');
      }

      try {
        const user = await this.db.getUser(userId);
        if (!user || user.tier < 3) {
          return ctx.reply('❌ 此用戶不是VIP會員');
        }

        // 延長到期時間
        const newExpiry = await this.db.extendVIPSubscription(userId, days);

        await this.db.logAction(
          ctx.from.id,
          'EXTEND_VIP',
          userId,
          { days, newExpiry }
        );

        await ctx.reply(
          `✅ *VIP期限已延長*\n\n` +
          `👤 用戶：@${user.username || '無用戶名'} (${userId})\n` +
          `⏰ 延長：${days}天\n` +
          `📅 新到期時間：${new Date(newExpiry).toLocaleString('zh-TW')}\n\n` +
          `✨ 用戶已自動收到通知`,
          { parse_mode: 'Markdown' }
        );

        // 通知用戶
        await ctx.telegram.sendMessage(
          userId,
          `✅ *VIP期限已延長*\n\n` +
          `⏰ 延長：${days}天\n` +
          `📅 新到期時間：${new Date(newExpiry).toLocaleString('zh-TW')}\n\n` +
          `感謝您的續訂！👑`,
          { parse_mode: 'Markdown' }
        );

      } catch (error) {
        console.error('延長VIP失敗:', error);
        await ctx.reply('❌ 延長VIP失敗：' + error.message);
      }
    });

    // ============================================
    // /cancel_vip - 取消VIP
    // ============================================

    this.bot.command('cancel_vip', adminOnly, async (ctx) => {
      const args = ctx.message.text.split(' ').slice(1);
      
      if (args.length === 0) {
        return ctx.reply(
          '📝 *取消VIP會員*\n\n' +
          '使用方法：\n' +
          '`/cancel_vip <用戶ID> [原因]`\n\n' +
          '範例：\n' +
          '`/cancel_vip 123456789 用戶要求退訂`',
          { parse_mode: 'Markdown' }
        );
      }

      const userId = parseInt(args[0]);
      const reason = args.slice(1).join(' ') || '管理員取消';

      if (isNaN(userId)) {
        return ctx.reply('❌ 用戶ID必須是數字');
      }

      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback('✅ 確認取消', `confirm_cancel_vip_${userId}`),
          Markup.button.callback('❌ 取消操作', 'cancel_action')
        ]
      ]);

      await ctx.reply(
        `⚠️ *確認取消VIP？*\n\n` +
        `👤 用戶ID：${userId}\n` +
        `📝 原因：${reason}\n\n` +
        `此操作將：\n` +
        `• 立即取消VIP資格\n` +
        `• 降級為認證會員\n` +
        `• 無法使用VIP功能\n\n` +
        `請確認是否繼續？`,
        {
          parse_mode: 'Markdown',
          ...keyboard
        }
      );
    });

    // 確認取消VIP
    this.bot.action(/confirm_cancel_vip_(\d+)/, adminOnly, async (ctx) => {
      const userId = parseInt(ctx.match[1]);
      
      await ctx.answerCbQuery();

      try {
        const user = await this.db.getUser(userId);
        if (!user || user.tier < 3) {
          return ctx.editMessageText('❌ 此用戶不是VIP會員');
        }

        // 取消VIP訂閱
        await this.db.cancelVIPSubscription(userId);
        
        // 降級為認證會員
        await this.db.updateUserTier(userId, 2);

        await this.db.logAction(
          ctx.from.id,
          'CANCEL_VIP',
          userId,
          { reason: 'Admin cancelled' }
        );

        await ctx.editMessageText(
          `✅ *VIP已取消*\n\n` +
          `👤 用戶：@${user.username || '無用戶名'} (${userId})\n` +
          `📉 已降級為認證會員\n\n` +
          `✨ 用戶已自動收到通知`,
          { parse_mode: 'Markdown' }
        );

        // 通知用戶
        await ctx.telegram.sendMessage(
          userId,
          `⚠️ *VIP會員已取消*\n\n` +
          `您的VIP會員資格已被取消。\n` +
          `您已降級為認證會員。\n\n` +
          `如有任何問題，請聯繫管理員 @Maggie`,
          { parse_mode: 'Markdown' }
        );

      } catch (error) {
        console.error('取消VIP失敗:', error);
        await ctx.editMessageText('❌ 取消VIP失敗：' + error.message);
      }
    });

    // 取消操作
    this.bot.action('cancel_action', async (ctx) => {
      await ctx.answerCbQuery('已取消操作');
      await ctx.deleteMessage();
    });

    // ============================================
    // /vip_list - 查看VIP列表
    // ============================================

    this.bot.command('vip_list', adminOnly, async (ctx) => {
      try {
        const vipUsers = await this.db.getVIPUsers();

        if (vipUsers.length === 0) {
          return ctx.reply('📭 目前沒有VIP會員');
        }

        let message = `👑 *VIP會員列表* (${vipUsers.length})\n\n`;

        for (const user of vipUsers) {
          const sub = await this.db.getActiveVIPSubscription(user.user_id);
          const expiresAt = new Date(user.vip_expires_at);
          const daysLeft = Math.ceil((expiresAt - new Date()) / (1000 * 60 * 60 * 24));
          
          message += `👤 @${user.username || '無用戶名'} (${user.user_id})\n`;
          if (sub) {
            message += `   方案：${this.getPlanName(sub.plan)}\n`;
            message += `   金額：${sub.amount}\n`;
          }
          message += `   到期：${expiresAt.toLocaleDateString('zh-TW')} (${daysLeft}天)\n`;
          message += `   狀態：${daysLeft > 0 ? '✅ 有效' : '❌ 已過期'}\n\n`;
        }

        message += `\n💡 管理指令：\n`;
        message += `• 延長：\`/extend_vip <ID> <天數>\`\n`;
        message += `• 取消：\`/cancel_vip <ID>\``;

        await ctx.reply(message, { parse_mode: 'Markdown' });

      } catch (error) {
        console.error('獲取VIP列表失敗:', error);
        await ctx.reply('❌ 獲取VIP列表失敗');
      }
    });

    // ============================================
    // /vip_stats - VIP統計
    // ============================================

    this.bot.command('vip_stats', adminOnly, async (ctx) => {
      try {
        const stats = await this.db.getVIPStats();

        const message = 
          `📊 *VIP統計數據*\n\n` +
          `👥 *會員數據*\n` +
          `• 總VIP數：${stats.total_vip}\n` +
          `• 有效VIP：${stats.active_vip}\n` +
          `• 已過期：${stats.expired_vip}\n\n` +
          `💰 *訂閱方案分佈*\n` +
          `• 月付：${stats.monthly_count}人 (${stats.monthly_revenue})\n` +
          `• 季付：${stats.quarterly_count}人 (${stats.quarterly_revenue})\n` +
          `• 年付：${stats.yearly_count}人 (${stats.yearly_revenue})\n\n` +
          `📈 *收入統計*\n` +
          `• 本月新增：${stats.this_month_new}人\n` +
          `• 本月收入：${stats.this_month_revenue}\n` +
          `• 累計收入：${stats.total_revenue}\n\n` +
          `⏰ *即將到期* (7天內)\n` +
          `• ${stats.expiring_soon}人\n\n` +
          `📅 統計時間：${new Date().toLocaleString('zh-TW')}`;

        await ctx.reply(message, { parse_mode: 'Markdown' });

      } catch (error) {
        console.error('獲取VIP統計失敗:', error);
        await ctx.reply('❌ 獲取VIP統計失敗');
      }
    });

    // ============================================
    // /remind_expiring - 提醒即將到期用戶
    // ============================================

    this.bot.command('remind_expiring', adminOnly, async (ctx) => {
      try {
        const expiringUsers = await this.db.getExpiringVIPUsers(7); // 7天內

        if (expiringUsers.length === 0) {
          return ctx.reply('✅ 沒有即將到期的VIP會員');
        }

        let reminded = 0;

        for (const user of expiringUsers) {
          const expiresAt = new Date(user.vip_expires_at);
          const daysLeft = Math.ceil((expiresAt - new Date()) / (1000 * 60 * 60 * 24));

          try {
            await ctx.telegram.sendMessage(
              user.user_id,
              `⚠️ *VIP即將到期提醒*\n\n` +
              `您的VIP會員將在 *${daysLeft}天* 後到期\n` +
              `到期時間：${expiresAt.toLocaleString('zh-TW')}\n\n` +
              `💡 如需續訂，請聯繫 @Maggie\n\n` +
              `續訂方案：\n` +
              `• 月付：$49/月\n` +
              `• 季付：$129/季（省15%）\n` +
              `• 年付：$468/年（省21%）\n\n` +
              `感謝您的支持！👑`,
              { parse_mode: 'Markdown' }
            );
            reminded++;
          } catch (e) {
            console.error(`無法提醒用戶 ${user.user_id}:`, e);
          }
        }

        await ctx.reply(
          `✅ 已提醒 ${reminded}/${expiringUsers.length} 位即將到期的VIP會員`
        );

      } catch (error) {
        console.error('提醒失敗:', error);
        await ctx.reply('❌ 提醒失敗');
      }
    });
  }

  // ============================================
  // 輔助方法
  // ============================================

  getPlanName(plan) {
    const names = {
      'monthly': '月付方案',
      'quarterly': '季付方案',
      'yearly': '年付方案'
    };
    return names[plan] || plan;
  }

  calculateExpiryDate(days) {
    const expiry = new Date();
    expiry.setDate(expiry.getDate() + days);
    return expiry.toLocaleString('zh-TW');
  }
}

module.exports = VIPAdminCommands;
