// scheduler.js - 定時任務配置
const schedule = require('node-schedule');

class Scheduler {
  constructor(bot, db, stockService) {
    this.bot = bot;
    this.db = db;
    this.stockService = stockService;
  }

  // 啟動所有定時任務
  startAll() {
    this.scheduleMagnificentSevenReports();
    this.schedulePromotions();
    this.scheduleVIPCheck();
    this.schedulePriceAlerts();
    console.log('✅ 所有定時任務已啟動');
  }

  // ============================================
  // 七巨頭報告 - 每6小時 (00:00/06:00/12:00/18:00)
  // ============================================

  scheduleMagnificentSevenReports() {
    // 每6小時執行一次
    const rule = new schedule.RecurrenceRule();
    rule.hour = [0, 6, 12, 18];
    rule.minute = 0;

    schedule.scheduleJob(rule, async () => {
      console.log('⏰ 開始生成七巨頭報告...');
      try {
        const report = await this.stockService.generateMagnificentSevenReport();
        
        // 發送給所有認證會員
        await this.sendToCertifiedMembers(report);
        
        console.log('✅ 七巨頭報告發送完成');
      } catch (error) {
        console.error('❌ 七巨頭報告發送失敗:', error);
      }
    });

    console.log('📊 七巨頭報告定時任務已設定 (00:00/06:00/12:00/18:00)');
  }

  // ============================================
  // VIP會員報告 - 每2小時
  // ============================================

  scheduleVIPReports() {
    // 每2小時執行一次
    const rule = new schedule.RecurrenceRule();
    rule.minute = 0;
    rule.hour = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22];

    schedule.scheduleJob(rule, async () => {
      console.log('⏰ 開始生成VIP七巨頭報告...');
      try {
        const report = await this.stockService.generateMagnificentSevenReport();
        
        // 發送給所有VIP會員
        await this.sendToVIPMembers(report);
        
        console.log('✅ VIP報告發送完成');
      } catch (error) {
        console.error('❌ VIP報告發送失敗:', error);
      }
    });

    console.log('👑 VIP報告定時任務已設定 (每2小時)');
  }

  // ============================================
  // 推廣通知 - 每週一和週四晚上8點
  // ============================================

  schedulePromotions() {
    // 週一和週四 20:00 (台北時間)
    const rule = new schedule.RecurrenceRule();
    rule.dayOfWeek = [1, 4]; // 1=週一, 4=週四
    rule.hour = 20;
    rule.minute = 0;
    rule.tz = 'Asia/Taipei';

    schedule.scheduleJob(rule, async () => {
      console.log('⏰ 發送推廣通知...');
      try {
        const message = this.generatePromotionMessage();
        await this.sendToLobbyMembers(message);
        console.log('✅ 推廣通知發送完成');
      } catch (error) {
        console.error('❌ 推廣通知發送失敗:', error);
      }
    });

    console.log('📢 推廣通知定時任務已設定 (週一、週四 20:00)');
  }

  // ============================================
  // VIP到期檢查 - 每天凌晨1點
  // ============================================

  scheduleVIPCheck() {
    // 每天凌晨1點檢查
    const rule = new schedule.RecurrenceRule();
    rule.hour = 1;
    rule.minute = 0;

    schedule.scheduleJob(rule, async () => {
      console.log('⏰ 檢查VIP到期狀態...');
      try {
        const expiredUsers = await this.db.checkExpiredVIP();
        
        // 通知到期用戶
        for (const user of expiredUsers) {
          try {
            await this.bot.telegram.sendMessage(
              user.user_id,
              `⚠️ *VIP會員已到期*\n\n` +
              `您的VIP會員資格已於今日到期。\n\n` +
              `如需繼續享用VIP服務，請使用 /vip 查看續訂方案。\n\n` +
              `感謝您的支持！`,
              { parse_mode: 'Markdown' }
            );
          } catch (e) {
            console.error(`無法通知用戶 ${user.user_id}:`, e.message);
          }
        }
        
        console.log(`✅ VIP到期檢查完成，共${expiredUsers.length}位用戶到期`);
      } catch (error) {
        console.error('❌ VIP到期檢查失敗:', error);
      }
    });

    console.log('👑 VIP到期檢查定時任務已設定 (每天 01:00)');
  }

  // ============================================
  // 價格提醒檢查 - 每30分鐘
  // ============================================

  schedulePriceAlerts() {
    // 每30分鐘檢查一次
    const rule = new schedule.RecurrenceRule();
    rule.minute = [0, 30];

    schedule.scheduleJob(rule, async () => {
      console.log('⏰ 檢查價格提醒...');
      try {
        await this.checkPriceAlerts();
        console.log('✅ 價格提醒檢查完成');
      } catch (error) {
        console.error('❌ 價格提醒檢查失敗:', error);
      }
    });

    console.log('🔔 價格提醒檢查定時任務已設定 (每30分鐘)');
  }

  // ============================================
  // 輔助方法
  // ============================================

  async sendToCertifiedMembers(message) {
    try {
      const users = await this.db.db.all(
        `SELECT user_id FROM users WHERE tier >= 2 AND banned = 0`
      );

      let sent = 0;
      let failed = 0;

      for (const user of users) {
        try {
          await this.bot.telegram.sendMessage(user.user_id, message, {
            parse_mode: 'Markdown'
          });
          sent++;
          
          // 記錄使用統計
          await this.db.logUsage(user.user_id, 'auto_report', 'magnificent_seven');
          
          // 避免觸發限流，每次發送後暫停50ms
          await new Promise(resolve => setTimeout(resolve, 50));
        } catch (e) {
          failed++;
          console.error(`發送給用戶 ${user.user_id} 失敗:`, e.message);
        }
      }

      console.log(`📊 報告發送統計: 成功 ${sent} / 失敗 ${failed}`);
    } catch (error) {
      console.error('獲取認證會員列表失敗:', error);
    }
  }

  async sendToVIPMembers(message) {
    try {
      const users = await this.db.db.all(
        `SELECT user_id FROM users WHERE tier = 3 AND banned = 0`
      );

      let sent = 0;
      let failed = 0;

      for (const user of users) {
        try {
          await this.bot.telegram.sendMessage(user.user_id, message, {
            parse_mode: 'Markdown'
          });
          sent++;
          
          await this.db.logUsage(user.user_id, 'auto_report', 'vip_report');
          await new Promise(resolve => setTimeout(resolve, 50));
        } catch (e) {
          failed++;
          console.error(`發送給VIP ${user.user_id} 失敗:`, e.message);
        }
      }

      console.log(`👑 VIP報告發送統計: 成功 ${sent} / 失敗 ${failed}`);
    } catch (error) {
      console.error('獲取VIP會員列表失敗:', error);
    }
  }

  async sendToLobbyMembers(message) {
    try {
      const users = await this.db.db.all(
        `SELECT user_id FROM users WHERE tier >= 1 AND banned = 0`
      );

      let sent = 0;
      let failed = 0;

      for (const user of users) {
        try {
          await this.bot.telegram.sendMessage(user.user_id, message, {
            parse_mode: 'Markdown'
          });
          sent++;
          await new Promise(resolve => setTimeout(resolve, 50));
        } catch (e) {
          failed++;
        }
      }

      console.log(`📢 推廣通知發送統計: 成功 ${sent} / 失敗 ${failed}`);
    } catch (error) {
      console.error('發送推廣通知失敗:', error);
    }
  }

  generatePromotionMessage() {
    return `🌟 *升級成為認證會員！*\n\n` +
      `您知道嗎？認證會員可以享有：\n\n` +
      `✅ 每日4次七巨頭即時報告\n` +
      `✅ 專業技術指標分析\n` +
      `✅ 真實市場數據追蹤\n` +
      `✅ 專屬討論群組\n\n` +
      `📝 *如何申請？*\n` +
      `使用 /apply 指令即可開始申請流程\n\n` +
      `💎 *想要更多？*\n` +
      `VIP會員提供：\n` +
      `• 每2小時更新報告\n` +
      `• 完整S&P500股票分析\n` +
      `• IPO深度分析\n` +
      `• 市場情緒指標\n` +
      `• 財報解析\n` +
      `• 板塊輪動分析\n` +
      `• 價格提醒功能\n` +
      `• 投資組合追蹤\n\n` +
      `使用 /vip 查看詳情\n\n` +
      `---\n` +
      `💬 有問題？聯繫管理員 @Maggie`;
  }

  async checkPriceAlerts() {
    try {
      // 獲取所有活躍的價格提醒
      const alerts = await this.db.db.all(
        `SELECT pa.*, u.tier FROM price_alerts pa 
         JOIN users u ON pa.user_id = u.user_id 
         WHERE pa.triggered = 0 AND u.tier >= 3`
      );

      for (const alert of alerts) {
        try {
          // 獲取當前價格
          const quote = await this.stockService.getStockQuote(alert.symbol);
          
          if (!quote) continue;

          let triggered = false;
          let message = '';

          // 檢查條件
          if (alert.condition === 'above' && quote.price >= alert.target_price) {
            triggered = true;
            message = `🔔 *價格提醒觸發*\n\n` +
              `${alert.symbol} 已突破您設定的價格！\n\n` +
              `目標價格: $${alert.target_price}\n` +
              `當前價格: $${quote.price.toFixed(2)}\n` +
              `漲跌: ${quote.change >= 0 ? '+' : ''}${quote.changePercent.toFixed(2)}%`;
          } else if (alert.condition === 'below' && quote.price <= alert.target_price) {
            triggered = true;
            message = `🔔 *價格提醒觸發*\n\n` +
              `${alert.symbol} 已跌破您設定的價格！\n\n` +
              `目標價格: $${alert.target_price}\n` +
              `當前價格: $${quote.price.toFixed(2)}\n` +
              `漲跌: ${quote.change >= 0 ? '+' : ''}${quote.changePercent.toFixed(2)}%`;
          }

          if (triggered) {
            // 發送通知
            await this.bot.telegram.sendMessage(alert.user_id, message, {
              parse_mode: 'Markdown'
            });

            // 標記為已觸發
            await this.db.triggerAlert(alert.id);

            console.log(`✅ 價格提醒已觸發: ${alert.symbol} for user ${alert.user_id}`);
          }
        } catch (e) {
          console.error(`檢查提醒失敗:`, e.message);
        }
      }
    } catch (error) {
      console.error('價格提醒檢查失敗:', error);
    }
  }

  // 停止所有任務
  stopAll() {
    const jobs = schedule.scheduledJobs;
    for (const name in jobs) {
      jobs[name].cancel();
    }
    console.log('🛑 所有定時任務已停止');
  }
}

module.exports = Scheduler;
