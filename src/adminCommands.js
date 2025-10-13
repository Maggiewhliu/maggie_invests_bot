// adminCommands.js - 管理員指令
const { Markup } = require('telegraf');

class AdminCommands {
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
    // /admin - 管理面板
    // ============================================

    this.bot.command('admin', adminOnly, async (ctx) => {
      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback('📋 待審核申請', 'admin_pending_apps'),
          Markup.button.callback('🚨 違規檢舉', 'admin_reports')
        ],
        [
          Markup.button.callback('📊 系統統計', 'admin_stats'),
          Markup.button.callback('📜 操作日誌', 'admin_logs')
        ],
        [
          Markup.button.callback('👥 用戶管理', 'admin_users'),
          Markup.button.callback('⚙️ 系統設定', 'admin_settings')
        ]
      ]);

      ctx.reply(
        `🛠️ *管理員控制面板*\n\n` +
        `請選擇要執行的操作：`,
        {
          parse_mode: 'Markdown',
          ...keyboard
        }
      );
    });

    // ============================================
    // 待審核申請
    // ============================================

    this.bot.action('admin_pending_apps', adminOnly, async (ctx) => {
      await ctx.answerCbQuery();
      
      const apps = await this.db.getPendingApplications();
      
      if (apps.length === 0) {
        return ctx.editMessageText('✅ 目前沒有待審核的申請');
      }

      let message = `📋 *待審核申請列表* (${apps.length})\n\n`;
      
      apps.forEach((app, index) => {
        message += `${index + 1}. @${app.username || '無用戶名'}\n`;
        message += `   ID: ${app.user_id}\n`;
        message += `   提交時間: ${new Date(app.submitted_at).toLocaleString('zh-TW')}\n\n`;
      });

      const keyboard = Markup.inlineKeyboard(
        apps.slice(0, 5).map(app => [
          Markup.button.callback(
            `審核 @${app.username}`,
            `review_app_${app.id}`
          )
        ]).concat([[Markup.button.callback('🔙 返回', 'admin_back')]])
      );

      ctx.editMessageText(message, {
        parse_mode: 'Markdown',
        ...keyboard
      });
    });

    // 審核申請詳情
    this.bot.action(/review_app_(\d+)/, adminOnly, async (ctx) => {
      const appId = parseInt(ctx.match[1]);
      await ctx.answerCbQuery();
      
      const app = await this.db.db.get(
        `SELECT ca.*, u.username, u.experience, u.strategy 
         FROM cert_applications ca
         JOIN users u ON ca.user_id = u.user_id
         WHERE ca.id = ?`,
        [appId]
      );

      if (!app) {
        return ctx.editMessageText('❌ 申請不存在');
      }

      let message = `📄 *認證申請詳情*\n\n`;
      message += `👤 用戶: @${app.username || '無用戶名'}\n`;
      message += `🆔 ID: ${app.user_id}\n`;
      message += `📅 經驗: ${app.experience || '未填寫'}\n`;
      message += `📈 策略: ${app.strategy || '未填寫'}\n`;
      message += `📝 聲明: ${app.statement || '無'}\n`;
      message += `⏰ 提交時間: ${new Date(app.submitted_at).toLocaleString('zh-TW')}\n\n`;

      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback('✅ 通過', `approve_cert_${appId}_${app.user_id}`),
          Markup.button.callback('❌ 拒絕', `reject_cert_${appId}_${app.user_id}`)
        ],
        [
          Markup.button.callback('👁️ 查看證明', `view_proof_${app.user_id}`),
          Markup.button.callback('🔙 返回', 'admin_pending_apps')
        ]
      ]);

      ctx.editMessageText(message, {
        parse_mode: 'Markdown',
        ...keyboard
      });
    });

    // 通過認證申請
    this.bot.action(/approve_cert_(\d+)_(\d+)/, adminOnly, async (ctx) => {
      const appId = parseInt(ctx.match[1]);
      const userId = parseInt(ctx.match[2]);
      
      await ctx.answerCbQuery('正在處理...');
      
      try {
        // 更新申請狀態
        await this.db.updateApplicationStatus(appId, 'APPROVED', ctx.from.id, '通過認證');
        
        // 升級用戶等級
        await this.db.updateUserTier(userId, 2);
        
        // 記錄日誌
        await this.db.logAction(ctx.from.id, 'APPROVE_CERT', userId, {
          applicationId: appId
        });
        
        // 通知用戶
        await this.bot.telegram.sendMessage(
          userId,
          `🎉 *恭喜！認證申請已通過*\n\n` +
          `您現在是認證會員了！\n\n` +
          `✅ 您可以享有:\n` +
          `• 每日4次七巨頭報告\n` +
          `• 真實市場數據\n` +
          `• 專屬討論群組\n\n` +
          `使用 /help 查看所有可用指令`,
          { parse_mode: 'Markdown' }
        );
        
        ctx.editMessageText(
          ctx.callbackQuery.message.text + 
          `\n\n✅ 已通過 by @${ctx.from.username}`,
          { parse_mode: 'Markdown' }
        );
      } catch (error) {
        console.error('通過申請失敗:', error);
        ctx.answerCbQuery('❌ 操作失敗');
      }
    });

    // 拒絕認證申請
    this.bot.action(/reject_cert_(\d+)_(\d+)/, adminOnly, async (ctx) => {
      const appId = parseInt(ctx.match[1]);
      const userId = parseInt(ctx.match[2]);
      
      await ctx.answerCbQuery('正在處理...');
      
      try {
        await this.db.updateApplicationStatus(appId, 'REJECTED', ctx.from.id, '申請被拒絕');
        
        await this.db.logAction(ctx.from.id, 'REJECT_CERT', userId, {
          applicationId: appId
        });
        
        await this.bot.telegram.sendMessage(
          userId,
          `❌ *認證申請未通過*\n\n` +
          `很抱歉，您的認證申請未能通過審核。\n\n` +
          `如有疑問，請聯繫管理員。`,
          { parse_mode: 'Markdown' }
        );
        
        ctx.editMessageText(
          ctx.callbackQuery.message.text + 
          `\n\n❌ 已拒絕 by @${ctx.from.username}`,
          { parse_mode: 'Markdown' }
        );
      } catch (error) {
        console.error('拒絕申請失敗:', error);
        ctx.answerCbQuery('❌ 操作失敗');
      }
    });

    // ============================================
    // 違規檢舉處理
    // ============================================

    this.bot.action('admin_reports', adminOnly, async (ctx) => {
      await ctx.answerCbQuery();
      
      const reports = await this.db.getPendingReports();
      
      if (reports.length === 0) {
        return ctx.editMessageText('✅ 目前沒有待處理的檢舉');
      }

      let message = `🚨 *違規檢舉列表* (${reports.length})\n\n`;
      
      reports.forEach((report, index) => {
        message += `${index + 1}. 檢舉人: @${report.reporter_name}\n`;
        message += `   被檢舉: @${report.reported_name} (${report.reported_id})\n`;
        message += `   原因: ${report.reason}\n`;
        message += `   時間: ${new Date(report.created_at).toLocaleString('zh-TW')}\n\n`;
      });

      const keyboard = Markup.inlineKeyboard(
        reports.slice(0, 5).map(report => [
          Markup.button.callback(
            `處理 @${report.reported_name}`,
            `handle_report_${report.id}`
          )
        ]).concat([[Markup.button.callback('🔙 返回', 'admin_back')]])
      );

      ctx.editMessageText(message, {
        parse_mode: 'Markdown',
        ...keyboard
      });
    });

    // 處理檢舉詳情
    this.bot.action(/handle_report_(\d+)/, adminOnly, async (ctx) => {
      const reportId = parseInt(ctx.match[1]);
      await ctx.answerCbQuery();
      
      const report = await this.db.db.get(
        `SELECT r.*, 
         u1.username as reporter_name, u1.warnings as reporter_warnings,
         u2.username as reported_name, u2.warnings as reported_warnings
         FROM reports r
         LEFT JOIN users u1 ON r.reporter_id = u1.user_id
         LEFT JOIN users u2 ON r.reported_id = u2.user_id
         WHERE r.id = ?`,
        [reportId]
      );

      if (!report) {
        return ctx.editMessageText('❌ 檢舉不存在');
      }

      let message = `🚨 *檢舉詳情*\n\n`;
      message += `👤 檢舉人: @${report.reporter_name} (${report.reporter_id})\n`;
      message += `⚠️ 被檢舉: @${report.reported_name} (${report.reported_id})\n`;
      message += `   當前警告: ${report.reported_warnings || 0}次\n`;
      message += `📝 原因: ${report.reason}\n`;
      message += `📎 證據: ${report.evidence || '無'}\n`;
      message += `⏰ 時間: ${new Date(report.created_at).toLocaleString('zh-TW')}\n\n`;

      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback('⚠️ 警告', `warn_user_${reportId}_${report.reported_id}`),
          Markup.button.callback('🚫 封禁', `ban_user_${reportId}_${report.reported_id}`)
        ],
        [
          Markup.button.callback('❌ 駁回檢舉', `dismiss_report_${reportId}`),
          Markup.button.callback('🔙 返回', 'admin_reports')
        ]
      ]);

      ctx.editMessageText(message, {
        parse_mode: 'Markdown',
        ...keyboard
      });
    });

    // 警告用戶
    this.bot.action(/warn_user_(\d+)_(\d+)/, adminOnly, async (ctx) => {
      const reportId = parseInt(ctx.match[1]);
      const userId = parseInt(ctx.match[2]);
      
      await ctx.answerCbQuery('正在處理...');
      
      try {
        const result = await this.db.addWarning(userId);
        
        await this.db.handleReport(reportId, ctx.from.id, `警告用戶 (${result.warnings}次)`);
        
        if (result.banned) {
          // 自動封禁
          await this.bot.telegram.sendMessage(
            userId,
            `🚫 *您已被封禁*\n\n` +
            `由於累計3次警告，您的帳號已被封禁。\n\n` +
            `如有異議，請聯繫管理員。`,
            { parse_mode: 'Markdown' }
          );
          
          ctx.editMessageText(
            ctx.callbackQuery.message.text + 
            `\n\n🚫 用戶已被自動封禁 (3次警告) by @${ctx.from.username}`,
            { parse_mode: 'Markdown' }
          );
        } else {
          await this.bot.telegram.sendMessage(
            userId,
            `⚠️ *您收到一次警告*\n\n` +
            `目前警告次數: ${result.warnings}/3\n\n` +
            `請注意遵守群組規則，3次警告將被自動封禁。`,
            { parse_mode: 'Markdown' }
          );
          
          ctx.editMessageText(
            ctx.callbackQuery.message.text + 
            `\n\n⚠️ 已警告用戶 (${result.warnings}/3) by @${ctx.from.username}`,
            { parse_mode: 'Markdown' }
          );
        }
        
        await this.db.logAction(ctx.from.id, 'WARN_USER', userId, {
          reportId,
          warnings: result.warnings
        });
      } catch (error) {
        console.error('警告用戶失敗:', error);
        ctx.answerCbQuery('❌ 操作失敗');
      }
    });

    // 封禁用戶
    this.bot.action(/ban_user_(\d+)_(\d+)/, adminOnly, async (ctx) => {
      const reportId = parseInt(ctx.match[1]);
      const userId = parseInt(ctx.match[2]);
      
      await ctx.answerCbQuery('正在處理...');
      
      try {
        await this.db.banUser(userId);
        await this.db.handleReport(reportId, ctx.from.id, '封禁用戶');
        
        await this.bot.telegram.sendMessage(
          userId,
          `🚫 *您已被封禁*\n\n` +
          `由於嚴重違規，您的帳號已被封禁。\n\n` +
          `如有異議，請聯繫管理員。`,
          { parse_mode: 'Markdown' }
        );
        
        await this.db.logAction(ctx.from.id, 'BAN_USER', userId, { reportId });
        
        ctx.editMessageText(
          ctx.callbackQuery.message.text + 
          `\n\n🚫 已封禁用戶 by @${ctx.from.username}`,
          { parse_mode: 'Markdown' }
        );
      } catch (error) {
        console.error('封禁用戶失敗:', error);
        ctx.answerCbQuery('❌ 操作失敗');
      }
    });

    // 駁回檢舉
    this.bot.action(/dismiss_report_(\d+)/, adminOnly, async (ctx) => {
      const reportId = parseInt(ctx.match[1]);
      
      await ctx.answerCbQuery('正在處理...');
      
      try {
        await this.db.handleReport(reportId, ctx.from.id, '檢舉被駁回');
        
        ctx.editMessageText(
          ctx.callbackQuery.message.text + 
          `\n\n❌ 檢舉已駁回 by @${ctx.from.username}`,
          { parse_mode: 'Markdown' }
        );
      } catch (error) {
        console.error('駁回檢舉失敗:', error);
        ctx.answerCbQuery('❌ 操作失敗');
      }
    });

    // ============================================
    // 系統統計
    // ============================================

    this.bot.action('admin_stats', adminOnly, async (ctx) => {
      await ctx.answerCbQuery();
      
      try {
        const userStats = await this.db.getUserStats();
        const usageStats = await this.db.getUsageStats(7);
        
        let message = `📊 *系統統計報告*\n\n`;
        
        // 用戶統計
        message += `👥 *用戶統計*\n`;
        let totalUsers = 0;
        let totalVerified = 0;
        
        userStats.forEach(stat => {
          const tierName = ['待審核', '大廳會員', '認證會員', 'VIP會員'][stat.tier];
          message += `${tierName}: ${stat.count}人 (驗證: ${stat.verified_count})\n`;
          totalUsers += stat.count;
          totalVerified += stat.verified_count;
        });
        
        message += `總用戶: ${totalUsers}人\n`;
        message += `已驗證: ${totalVerified}人\n\n`;
        
        // 使用統計
        message += `📈 *7日使用統計*\n`;
        const commandCounts = {};
        usageStats.forEach(stat => {
          commandCounts[stat.command] = (commandCounts[stat.command] || 0) + stat.count;
        });
        
        Object.entries(commandCounts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .forEach(([cmd, count]) => {
            message += `${cmd}: ${count}次\n`;
          });
        
        const keyboard = Markup.inlineKeyboard([
          [Markup.button.callback('🔄 刷新', 'admin_stats')],
          [Markup.button.callback('🔙 返回', 'admin_back')]
        ]);
        
        ctx.editMessageText(message, {
          parse_mode: 'Markdown',
          ...keyboard
        });
      } catch (error) {
        console.error('獲取統計失敗:', error);
        ctx.editMessageText('❌ 獲取統計失敗');
      }
    });

    // ============================================
    // 操作日誌
    // ============================================

    this.bot.action('admin_logs', adminOnly, async (ctx) => {
      await ctx.answerCbQuery();
      
      try {
        const logs = await this.db.getActionLogs(20);
        
        let message = `📜 *最近操作日誌* (20條)\n\n`;
        
        logs.forEach((log, index) => {
          const time = new Date(log.created_at).toLocaleString('zh-TW', {
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
          });
          message += `${index + 1}. [${time}] ${log.action_type}\n`;
          message += `   管理員: @${log.admin_name || '未知'}\n`;
          if (log.target_user_id) {
            message += `   目標: ${log.target_user_id}\n`;
          }
          message += `\n`;
        });
        
        const keyboard = Markup.inlineKeyboard([
          [Markup.button.callback('🔄 刷新', 'admin_logs')],
          [Markup.button.callback('🔙 返回', 'admin_back')]
        ]);
        
        ctx.editMessageText(message, {
          parse_mode: 'Markdown',
          ...keyboard
        });
      } catch (error) {
        console.error('獲取日誌失敗:', error);
        ctx.editMessageText('❌ 獲取日誌失敗');
      }
    });

    // 返回主選單
    this.bot.action('admin_back', adminOnly, async (ctx) => {
      await ctx.answerCbQuery();
      
      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback('📋 待審核申請', 'admin_pending_apps'),
          Markup.button.callback('🚨 違規檢舉', 'admin_reports')
        ],
        [
          Markup.button.callback('📊 系統統計', 'admin_stats'),
          Markup.button.callback('📜 操作日誌', 'admin_logs')
        ]
      ]);

      ctx.editMessageText(
        `🛠️ *管理員控制面板*\n\n` +
        `請選擇要執行的操作：`,
        {
          parse_mode: 'Markdown',
          ...keyboard
        }
      );
    });

    // ============================================
    // 手動添加管理員
    // ============================================

    this.bot.command('add_admin', async (ctx) => {
      // 只有第一個管理員或已有管理員可以添加
      const admins = await this.db.getAdmins();
      
      if (admins.length > 0) {
        const isAdmin = await this.db.isAdmin(ctx.from.id);
        if (!isAdmin) {
          return ctx.reply('❌ 只有管理員可以添加新管理員');
        }
      }
      
      const args = ctx.message.text.split(' ');
      if (args.length < 2) {
        return ctx.reply('使用方法: /add_admin <user_id>');
      }
      
      const newAdminId = parseInt(args[1]);
      
      try {
        await this.db.addAdmin(newAdminId, '');
        ctx.reply(`✅ 已添加管理員: ${newAdminId}`);
        
        await this.bot.telegram.sendMessage(
          newAdminId,
          `🎉 您已被設為管理員！\n\n使用 /admin 打開管理面板`
        );
      } catch (error) {
        ctx.reply('❌ 添加管理員失敗');
      }
    });

    // ============================================
    // 手動發送報告
    // ============================================

    this.bot.command('send_report', adminOnly, async (ctx) => {
      ctx.reply('正在生成並發送報告...');
      
      try {
        const StockService = require('./services/stockService');
        const stockService = new StockService();
        const report = await stockService.generateMagnificentSevenReport();
        
        // 發送給認證會員
        const users = await this.db.db.all(
          `SELECT user_id FROM users WHERE tier >= 2 AND banned = 0`
        );

        let sent = 0;
        for (const user of users) {
          try {
            await this.bot.telegram.sendMessage(user.user_id, report, {
              parse_mode: 'Markdown'
            });
            sent++;
            await new Promise(resolve => setTimeout(resolve, 50));
          } catch (e) {
            console.error(`發送失敗: ${user.user_id}`);
          }
        }
        
        ctx.reply(`✅ 報告已發送給 ${sent} 位用戶`);
      } catch (error) {
        console.error('發送報告失敗:', error);
        ctx.reply('❌ 發送報告失敗');
      }
    });
  }
}

module.exports = AdminCommands;
