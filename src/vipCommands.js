// vipCommands.js - VIP會員專屬功能
const { Markup } = require('telegraf');

class VIPCommands {
  constructor(bot, db, stockService, ipoService, sentimentService) {
    this.bot = bot;
    this.db = db;
    this.stockService = stockService;
    this.ipoService = ipoService;
    this.sentimentService = sentimentService;
    this.setupCommands();
  }

  setupCommands() {
    // VIP專屬中間件
    const vipOnly = async (ctx, next) => {
      const user = await this.db.getUser(ctx.from.id);
      if (!user || user.tier < 3) {
        return ctx.reply(
          '👑 此功能僅限VIP會員使用\n\n' +
          '💎 VIP會員享有：\n' +
          '• 標普500完整分析\n' +
          '• IPO深度分析\n' +
          '• 市場情緒指標\n' +
          '• 價格提醒\n' +
          '• 投資組合追蹤\n\n' +
          '使用 /vip 查看訂閱方案'
        );
      }
      return next();
    };

    // ============================================
    // /vip - VIP方案說明
    // ============================================

    this.bot.command('vip', async (ctx) => {
      const user = await this.db.getUser(ctx.from.id);
      
      if (user && user.tier === 3) {
        const sub = await this.db.getActiveVIPSubscription(ctx.from.id);
        if (sub) {
          return ctx.reply(
            `👑 *您的VIP會員狀態*\n\n` +
            `✅ 狀態：${sub.status === 'ACTIVE' ? '有效' : '已過期'}\n` +
            `📅 方案：${this.getPlanName(sub.plan)}\n` +
            `💰 金額：$${sub.amount} ${sub.currency}\n` +
            `⏰ 到期：${new Date(sub.expires_at).toLocaleString('zh-TW')}\n\n` +
            `💎 *VIP專屬功能*\n` +
            `• 每2小時更新七巨頭報告\n` +
            `• 標普500完整分析\n` +
            `• IPO深度分析\n` +
            `• 市場情緒指標\n` +
            `• 價格提醒功能\n` +
            `• 投資組合追蹤\n\n` +
            `使用 /help 查看所有VIP指令`,
            { parse_mode: 'Markdown' }
          );
        }
      }
      
      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('💳 月付方案 ($49)', 'vip_monthly')],
        [Markup.button.callback('💎 季付方案 ($129)', 'vip_quarterly')],
        [Markup.button.callback('👑 年付方案 ($468)', 'vip_yearly')],
        [Markup.button.url('💬 聯繫 Maggie', 't.me/Maggie')]
      ]);
      
      ctx.reply(
        `👑 *VIP會員方案*\n\n` +
        `💎 *專屬功能*\n` +
        `✅ 每2小時更新七巨頭報告\n` +
        `✅ 完整S&P500股票分析\n` +
        `✅ IPO深度分析與日曆\n` +
        `✅ Fear & Greed Index\n` +
        `✅ Reddit/Twitter情緒分析\n` +
        `✅ 財報解析與預測\n` +
        `✅ 板塊輪動分析\n` +
        `✅ 價格提醒功能\n` +
        `✅ 投資組合追蹤\n\n` +
        `💰 *定價方案*\n` +
        `• 月付：$49/月（NT$1,470）\n` +
        `• 季付：$129/季（NT$3,870，省15%）\n` +
        `• 年付：$468/年（NT$14,040，省21%）\n\n` +
        `📧 *訂閱流程*\n` +
        `1. 選擇方案並點擊下方按鈕\n` +
        `2. 聯繫 @Maggie 完成付款\n` +
        `3. 上傳付款證明\n` +
        `4. 管理員審核後立即開通\n\n` +
        `💡 支援台幣或美金付款`,
        {
          parse_mode: 'Markdown',
          ...keyboard
        }
      );
    });

    // VIP方案選擇處理
    this.bot.action(/vip_(monthly|quarterly|yearly)/, async (ctx) => {
      const plan = ctx.match[1];
      const planDetails = {
        monthly: { name: '月付', amount: 49, duration: '1個月' },
        quarterly: { name: '季付', amount: 129, duration: '3個月' },
        yearly: { name: '年付', amount: 468, duration: '12個月' }
      };
      
      const details = planDetails[plan];
      
      await ctx.answerCbQuery();
      
      await ctx.editMessageText(
        `✅ *已選擇：${details.name}方案*\n\n` +
        `💰 金額：$${details.amount} USD\n` +
        `⏰ 期限：${details.duration}\n\n` +
        `📝 *下一步*\n` +
        `1. 請私訊 @Maggie 告知您選擇的方案\n` +
        `2. 完成轉帳（支援台幣/美金）\n` +
        `3. 將付款證明發送給 @Maggie\n` +
        `4. 等待審核（通常1小時內）\n\n` +
        `💡 *付款資訊*\n` +
        `台幣金額：NT$${details.amount * 30}\n` +
        `（匯率：1 USD = 30 TWD）\n\n` +
        `轉帳後請提供：\n` +
        `• 付款截圖\n` +
        `• 您的Telegram用戶名\n` +
        `• 選擇的方案\n\n` +
        `感謝您的支持！🙏`,
        { parse_mode: 'Markdown' }
      );
    });

    // ============================================
    // /stock - 股票分析
    // ============================================

    this.bot.command('stock', vipOnly, async (ctx) => {
      const args = ctx.message.text.split(' ').slice(1);
      
      if (args.length === 0) {
        return ctx.reply(
          '使用方法：`/stock <股票代碼>`\n\n' +
          '例如：\n' +
          '`/stock AAPL` - 分析蘋果\n' +
          '`/stock TSLA` - 分析特斯拉\n\n' +
          '💡 支援標普500所有股票',
          { parse_mode: 'Markdown' }
        );
      }
      
      const symbol = args[0].toUpperCase();
      
      await ctx.reply('📊 正在分析，請稍候...');
      
      try {
        const analysis = await this.stockService.getDetailedAnalysis(symbol);
        
        if (analysis) {
          await ctx.reply(analysis, { parse_mode: 'Markdown' });
          
          // 記錄使用統計
          await this.db.logUsage(ctx.from.id, '/stock', 'stock_analysis', { symbol });
        } else {
          await ctx.reply(`❌ 無法獲取 ${symbol} 的數據`);
        }
      } catch (error) {
        console.error('股票分析失敗:', error);
        await ctx.reply('❌ 分析失敗，請稍後再試');
      }
    });

    // ============================================
    // /search - 搜索股票
    // ============================================

    this.bot.command('search', vipOnly, async (ctx) => {
      const args = ctx.message.text.split(' ').slice(1);
      
      if (args.length === 0) {
        return ctx.reply(
          '使用方法：`/search <關鍵字>`\n\n' +
          '例如：\n' +
          '`/search Apple` - 搜索蘋果\n' +
          '`/search tech` - 搜索科技公司',
          { parse_mode: 'Markdown' }
        );
      }
      
      const query = args.join(' ');
      
      try {
        const results = await this.stockService.searchStock(query);
        
        if (results.length === 0) {
          return ctx.reply('❌ 沒有找到相關股票');
        }
        
        let message = `🔍 *搜索結果：${query}*\n\n`;
        
        results.slice(0, 10).forEach((stock, index) => {
          message += `${index + 1}. *${stock.symbol}* - ${stock.name}\n`;
          message += `   類型：${stock.type || 'Stock'}\n\n`;
        });
        
        message += `\n💡 使用 \`/stock <代碼>\` 查看詳細分析`;
        
        await ctx.reply(message, { parse_mode: 'Markdown' });
        
        await this.db.logUsage(ctx.from.id, '/search', 'stock_search', { query });
      } catch (error) {
        console.error('搜索失敗:', error);
        await ctx.reply('❌ 搜索失敗，請稍後再試');
      }
    });

    // ============================================
    // /ipo - IPO功能
    // ============================================

    this.bot.command('ipo', vipOnly, async (ctx) => {
      const args = ctx.message.text.split(' ').slice(1);
      
      if (args.length === 0) {
        // 顯示IPO日曆
        await ctx.reply('📅 正在獲取IPO日曆...');
        
        try {
          const calendar = await this.ipoService.generateIPOCalendarReport();
          await ctx.reply(calendar, { parse_mode: 'Markdown' });
          
          await this.db.logUsage(ctx.from.id, '/ipo', 'ipo_calendar');
        } catch (error) {
          console.error('IPO日曆獲取失敗:', error);
          await ctx.reply('❌ 獲取IPO日曆失敗');
        }
      } else {
        // IPO分析
        const symbol = args[0].toUpperCase();
        
        await ctx.reply(`📊 正在分析 ${symbol} IPO...`);
        
        try {
          const analysis = await this.ipoService.analyzeIPO(symbol);
          await ctx.reply(analysis, { parse_mode: 'Markdown' });
          
          await this.db.logUsage(ctx.from.id, '/ipo', 'ipo_analysis', { symbol });
        } catch (error) {
          console.error('IPO分析失敗:', error);
          await ctx.reply('❌ IPO分析失敗');
        }
      }
    });

    // ============================================
    // /sentiment - 市場情緒
    // ============================================

    this.bot.command('sentiment', vipOnly, async (ctx) => {
      const args = ctx.message.text.split(' ').slice(1);
      
      if (args.length === 0) {
        // Fear & Greed Index
        await ctx.reply('😨 正在獲取Fear & Greed指數...');
        
        try {
          const report = await this.sentimentService.generateFearGreedReport();
          await ctx.reply(report, { parse_mode: 'Markdown' });
          
          await this.db.logUsage(ctx.from.id, '/sentiment', 'fear_greed');
        } catch (error) {
          console.error('Fear & Greed獲取失敗:', error);
          await ctx.reply('❌ 獲取失敗');
        }
      } else {
        // 社群情緒分析
        const symbol = args[0].toUpperCase();
        
        await ctx.reply(`💬 正在分析 ${symbol} 社群情緒...`);
        
        try {
          const report = await this.sentimentService.generateSocialSentimentReport(symbol);
          await ctx.reply(report, { parse_mode: 'Markdown' });
          
          await this.db.logUsage(ctx.from.id, '/sentiment', 'social_sentiment', { symbol });
        } catch (error) {
          console.error('社群情緒分析失敗:', error);
          await ctx.reply('❌ 分析失敗');
        }
      }
    });

    // ============================================
    // /alert - 價格提醒
    // ============================================

    this.bot.command('alert', vipOnly, async (ctx) => {
      const args = ctx.message.text.split(' ').slice(1);
      
      if (args.length < 2) {
        return ctx.reply(
          '🔔 *價格提醒設置*\n\n' +
          '使用方法：\n' +
          '`/alert <代碼> <價格>`\n\n' +
          '例如：\n' +
          '`/alert AAPL 180` - AAPL達到180時提醒\n' +
          '`/alert TSLA 250` - TSLA達到250時提醒\n\n' +
          '💡 價格達到時會自動通知您\n' +
          '查看所有提醒：`/alerts`',
          { parse_mode: 'Markdown' }
        );
      }
      
      const symbol = args[0].toUpperCase();
      const targetPrice = parseFloat(args[1]);
      
      if (isNaN(targetPrice)) {
        return ctx.reply('❌ 價格必須是數字');
      }
      
      try {
        // 獲取當前價格
        const quote = await this.stockService.getStockQuote(symbol);
        
        if (!quote) {
          return ctx.reply(`❌ 找不到股票 ${symbol}`);
        }
        
        const condition = targetPrice > quote.price ? 'above' : 'below';
        const conditionText = condition === 'above' ? '上漲至' : '下跌至';
        
        // 創建提醒
        const alertId = await this.db.createPriceAlert(
          ctx.from.id,
          symbol,
          condition,
          targetPrice
        );
        
        await ctx.reply(
          `✅ *價格提醒已設置*\n\n` +
          `📊 股票：${symbol}\n` +
          `💰 當前價格：$${quote.price.toFixed(2)}\n` +
          `🎯 目標價格：$${targetPrice.toFixed(2)}\n` +
          `📈 條件：${conditionText} $${targetPrice}\n\n` +
          `當價格達到時，我會立即通知您！\n\n` +
          `查看所有提醒：/alerts`,
          { parse_mode: 'Markdown' }
        );
        
        await this.db.logUsage(ctx.from.id, '/alert', 'create_alert', { symbol, targetPrice });
      } catch (error) {
        console.error('創建提醒失敗:', error);
        await ctx.reply('❌ 創建提醒失敗');
      }
    });

    // ============================================
    // /alerts - 查看我的提醒
    // ============================================

    this.bot.command('alerts', vipOnly, async (ctx) => {
      try {
        const alerts = await this.db.getActiveAlerts(ctx.from.id);
        
        if (alerts.length === 0) {
          return ctx.reply(
            '📭 *您還沒有設置任何價格提醒*\n\n' +
            '使用 `/alert <代碼> <價格>` 來設置提醒',
            { parse_mode: 'Markdown' }
          );
        }
        
        let message = `🔔 *我的價格提醒* (${alerts.length})\n\n`;
        
        for (const alert of alerts) {
          const conditionText = alert.condition === 'above' ? '≥' : '≤';
          message += `📊 *${alert.symbol}*\n`;
          message += `   目標：${conditionText} $${alert.target_price}\n`;
          message += `   設置時間：${new Date(alert.created_at).toLocaleDateString('zh-TW')}\n\n`;
        }
        
        message += `💡 價格達到時會自動通知您`;
        
        await ctx.reply(message, { parse_mode: 'Markdown' });
        
        await this.db.logUsage(ctx.from.id, '/alerts', 'view_alerts');
      } catch (error) {
        console.error('獲取提醒失敗:', error);
        await ctx.reply('❌ 獲取提醒失敗');
      }
    });

    // ============================================
    // /portfolio - 投資組合
    // ============================================

    this.bot.command('portfolio', vipOnly, async (ctx) => {
      try {
        const portfolio = await this.db.getPortfolio(ctx.from.id);
        
        if (portfolio.length === 0) {
          return ctx.reply(
            '📂 *您的投資組合是空的*\n\n' +
            '使用 `/add <代碼> <數量> <成本>` 來添加持倉\n\n' +
            '例如：`/add AAPL 10 150`',
            { parse_mode: 'Markdown' }
          );
        }
        
        let message = `📊 *我的投資組合*\n\n`;
        let totalValue = 0;
        let totalCost = 0;
        
        for (const holding of portfolio) {
          try {
            const quote = await this.stockService.getStockQuote(holding.symbol);
            
            if (quote) {
              const currentValue = quote.price * holding.shares;
              const cost = holding.avg_cost * holding.shares;
              const profit = currentValue - cost;
              const profitPercent = (profit / cost) * 100;
              
              totalValue += currentValue;
              totalCost += cost;
              
              message += `📈 *${holding.symbol}*\n`;
              message += `   持倉：${holding.shares} 股\n`;
              message += `   成本：$${holding.avg_cost.toFixed(2)}\n`;
              message += `   現價：$${quote.price.toFixed(2)}\n`;
              message += `   市值：$${currentValue.toFixed(2)}\n`;
              message += `   損益：${profit >= 0 ? '+' : ''}$${profit.toFixed(2)} (${profit >= 0 ? '+' : ''}${profitPercent.toFixed(2)}%)\n\n`;
            }
          } catch (error) {
            console.error(`獲取${holding.symbol}失敗:`, error);
          }
        }
        
        const totalProfit = totalValue - totalCost;
        const totalProfitPercent = (totalProfit / totalCost) * 100;
        
        message += `━━━━━━━━━━━━━━━\n`;
        message += `💰 *總覽*\n`;
        message += `總成本：$${totalCost.toFixed(2)}\n`;
        message += `總市值：$${totalValue.toFixed(2)}\n`;
        message += `總損益：${totalProfit >= 0 ? '+' : ''}$${totalProfit.toFixed(2)} (${totalProfit >= 0 ? '+' : ''}${totalProfitPercent.toFixed(2)}%)\n\n`;
        message += `💡 使用 \`/add\` 添加持倉，\`/remove\` 移除持倉`;
        
        await ctx.reply(message, { parse_mode: 'Markdown' });
        
        await this.db.logUsage(ctx.from.id, '/portfolio', 'view_portfolio');
      } catch (error) {
        console.error('獲取投資組合失敗:', error);
        await ctx.reply('❌ 獲取投資組合失敗');
      }
    });

    // ============================================
    // /add - 添加持倉
    // ============================================

    this.bot.command('add', vipOnly, async (ctx) => {
      const args = ctx.message.text.split(' ').slice(1);
      
      if (args.length < 3) {
        return ctx.reply(
          '使用方法：`/add <代碼> <數量> <成本>`\n\n' +
          '例如：\n' +
          '`/add AAPL 10 150` - 添加10股AAPL，成本$150\n' +
          '`/add TSLA 5 220` - 添加5股TSLA，成本$220',
          { parse_mode: 'Markdown' }
        );
      }
      
      const symbol = args[0].toUpperCase();
      const shares = parseFloat(args[1]);
      const avgCost = parseFloat(args[2]);
      
      if (isNaN(shares) || isNaN(avgCost)) {
        return ctx.reply('❌ 數量和成本必須是數字');
      }
      
      try {
        await this.db.addToPortfolio(ctx.from.id, symbol, shares, avgCost);
        
        await ctx.reply(
          `✅ *持倉已添加*\n\n` +
          `📊 股票：${symbol}\n` +
          `📈 數量：${shares} 股\n` +
          `💰 成本：$${avgCost.toFixed(2)}\n\n` +
          `使用 /portfolio 查看完整組合`,
          { parse_mode: 'Markdown' }
        );
        
        await this.db.logUsage(ctx.from.id, '/add', 'add_to_portfolio', { symbol, shares, avgCost });
      } catch (error) {
        console.error('添加持倉失敗:', error);
        await ctx.reply('❌ 添加失敗');
      }
    });

    // ============================================
    // /remove - 移除持倉
    // ============================================

    this.bot.command('remove', vipOnly, async (ctx) => {
      const args = ctx.message.text.split(' ').slice(1);
      
      if (args.length === 0) {
        return ctx.reply(
          '使用方法：`/remove <代碼>`\n\n' +
          '例如：`/remove AAPL`',
          { parse_mode: 'Markdown' }
        );
      }
      
      const symbol = args[0].toUpperCase();
      
      try {
        await this.db.removeFromPortfolio(ctx.from.id, symbol);
        
        await ctx.reply(
          `✅ 已從投資組合中移除 *${symbol}*\n\n` +
          `使用 /portfolio 查看完整組合`,
          { parse_mode: 'Markdown' }
        );
        
        await this.db.logUsage(ctx.from.id, '/remove', 'remove_from_portfolio', { symbol });
      } catch (error) {
        console.error('移除持倉失敗:', error);
        await ctx.reply('❌ 移除失敗');
      }
    });
  }

  getPlanName(plan) {
    const names = {
      'monthly': '月付方案',
      'quarterly': '季付方案',
      'yearly': '年付方案'
    };
    return names[plan] || plan;
  }
}

module.exports = VIPCommands;
