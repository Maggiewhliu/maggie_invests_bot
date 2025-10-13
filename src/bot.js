// bot.js - 主程式入口
require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const schedule = require('node-schedule');
const Database = require('./database');
const StockService = require('./services/stockService');
const IPOService = require('./services/ipoService');
const SentimentService = require('./services/sentimentService');

const bot = new Telegraf(process.env.BOT_TOKEN);
const db = new Database();
const stockService = new StockService();
const ipoService = new IPOService();
const sentimentService = new SentimentService();

// 會員等級定義
const TIERS = {
  PENDING: 0,      // 待審核
  LOBBY: 1,        // 大廳會員
  CERTIFIED: 2,    // 認證會員
  VIP: 3          // VIP會員
};

// 群組ID配置
const GROUP_IDS = {
  LOBBY: process.env.LOBBY_GROUP_ID,
  CERTIFIED: process.env.CERTIFIED_GROUP_ID,
  VIP: process.env.VIP_GROUP_ID
};

// ============================================
// 入群審核系統
// ============================================

// 監聽入群請求
bot.on('chat_join_request', async (ctx) => {
  const userId = ctx.chatJoinRequest.from.id;
  const username = ctx.chatJoinRequest.from.username || '無用戶名';
  const chatId = ctx.chatJoinRequest.chat.id;
  
  console.log(`收到入群請求: User ${userId} (@${username})`);
  
  // 檢查用戶是否已完成Bot驗證
  const user = await db.getUser(userId);
  
  if (!user || !user.verified) {
    // 未驗證，拒絕並提示
    await ctx.declineChatJoinRequest(userId);
    
    try {
      await ctx.telegram.sendMessage(userId, 
        `⚠️ *入群申請被拒絕*\n\n` +
        `您需要先完成入會驗證才能加入群組。\n\n` +
        `請點擊 /start 開始驗證流程：\n` +
        `1️⃣ 上傳持倉截圖/影片\n` +
        `2️⃣ 回答問卷\n` +
        `3️⃣ 同意群組規則\n\n` +
        `完成後即可重新申請入群。`,
        { parse_mode: 'Markdown' }
      );
    } catch (e) {
      console.log('無法發送私訊給用戶，用戶可能未先啟動Bot');
    }
    
    // 通知管理員
    await notifyAdmins(
      `❌ *自動拒絕入群請求*\n` +
      `用戶: @${username} (${userId})\n` +
      `原因: 未完成Bot驗證\n` +
      `群組: ${chatId}`
    );
    
    return;
  }
  
  // 已驗證，提交給管理員審核
  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ 核准', `approve_${userId}_${chatId}`),
      Markup.button.callback('❌ 拒絕', `decline_${userId}_${chatId}`)
    ],
    [Markup.button.callback('👤 查看資料', `view_user_${userId}`)]
  ]);
  
  await notifyAdmins(
    `🔔 *新的入群請求*\n\n` +
    `用戶: @${username}\n` +
    `ID: ${userId}\n` +
    `驗證狀態: ✅ 已完成\n` +
    `美股經驗: ${user.experience || '未填寫'}\n` +
    `提交時間: ${new Date(user.verified_at).toLocaleString('zh-TW')}`,
    keyboard
  );
});

// 處理管理員核准
bot.action(/approve_(\d+)_(-?\d+)/, async (ctx) => {
  const userId = parseInt(ctx.match[1]);
  const chatId = parseInt(ctx.match[2]);
  
  try {
    await ctx.telegram.approveChatJoinRequest(chatId, userId);
    
    // 更新用戶等級
    await db.updateUserTier(userId, TIERS.LOBBY);
    
    // 記錄審核日誌
    await db.logAction(ctx.from.id, 'APPROVE_JOIN', userId, {
      chatId,
      approvedBy: ctx.from.username
    });
    
    await ctx.editMessageText(
      ctx.callbackQuery.message.text + 
      `\n\n✅ 已核准 by @${ctx.from.username}`,
      { parse_mode: 'Markdown' }
    );
    
    // 發送歡迎訊息給新成員
    await ctx.telegram.sendMessage(userId,
      `🎉 *歡迎加入美股投資討論群！*\n\n` +
      `您已成功加入大廳會員群組。\n\n` +
      `📋 *群組規則*：\n` +
      `• 禁止私下騷擾其他群友\n` +
      `• 禁止發送廣告與外部連結\n` +
      `• 尊重他人，理性討論\n` +
      `• 違規將被警告或移除\n\n` +
      `💡 如需升級為認證會員，請使用 /apply 申請`,
      { parse_mode: 'Markdown' }
    );
    
  } catch (error) {
    console.error('核准失敗:', error);
    await ctx.answerCbQuery('核准失敗，請重試');
  }
});

// 處理管理員拒絕
bot.action(/decline_(\d+)_(-?\d+)/, async (ctx) => {
  const userId = parseInt(ctx.match[1]);
  const chatId = parseInt(ctx.match[2]);
  
  try {
    await ctx.telegram.declineChatJoinRequest(chatId, userId);
    
    await db.logAction(ctx.from.id, 'DECLINE_JOIN', userId, {
      chatId,
      declinedBy: ctx.from.username
    });
    
    await ctx.editMessageText(
      ctx.callbackQuery.message.text + 
      `\n\n❌ 已拒絕 by @${ctx.from.username}`,
      { parse_mode: 'Markdown' }
    );
    
  } catch (error) {
    console.error('拒絕失敗:', error);
    await ctx.answerCbQuery('拒絕失敗，請重試');
  }
});

// ============================================
// /start - 入會驗證流程
// ============================================

bot.command('start', async (ctx) => {
  const userId = ctx.from.id;
  const user = await db.getUser(userId);
  
  if (user && user.verified) {
    // 已驗證用戶
    return ctx.reply(
      `👋 歡迎回來！\n\n` +
      `您的會員等級: ${getTierName(user.tier)}\n\n` +
      `可用指令:\n` +
      `/help - 查看所有指令\n` +
      `/status - 查看會員狀態\n` +
      `/stock - 股票查詢 (VIP)\n` +
      `/ipo - IPO分析 (VIP)\n` +
      `/sentiment - 市場情緒 (VIP)`
    );
  }
  
  // 新用戶，開始驗證流程
  await db.createUser(userId, ctx.from.username);
  
  ctx.reply(
    `👋 *歡迎來到美股投資討論群！*\n\n` +
    `在加入群組之前，請完成以下驗證步驟：\n\n` +
    `1️⃣ 上傳持倉證明（截圖或影片）\n` +
    `2️⃣ 回答簡單問卷\n` +
    `3️⃣ 同意群組規則\n\n` +
    `請點擊下方按鈕開始驗證 👇`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🚀 開始驗證', 'start_verification')]
      ])
    }
  );
});

// 開始驗證流程
bot.action('start_verification', async (ctx) => {
  await ctx.answerCbQuery();
  
  ctx.editMessageText(
    `📸 *步驟 1/3: 上傳持倉證明*\n\n` +
    `請上傳您的美股持倉截圖或影片，證明您是美股投資者。\n\n` +
    `✅ 可接受的證明:\n` +
    `• 券商App持倉截圖\n` +
    `• 持倉影片（推薦）\n` +
    `• 交易紀錄截圖\n\n` +
    `⚠️ 注意:\n` +
    `• 可遮蔽敏感資訊（姓名、帳號）\n` +
    `• 需顯示股票代碼和數量\n` +
    `• 圖片需清晰可辨識\n\n` +
    `請直接上傳圖片或影片 👇`,
    { parse_mode: 'Markdown' }
  );
  
  // 設置用戶狀態為等待上傳
  await db.updateUserState(ctx.from.id, 'WAITING_PROOF');
});

// 接收持倉證明
bot.on(['photo', 'video', 'document'], async (ctx) => {
  const user = await db.getUser(ctx.from.id);
  
  if (user && user.state === 'WAITING_PROOF') {
    // 儲存文件ID
    let fileId;
    if (ctx.message.photo) {
      fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    } else if (ctx.message.video) {
      fileId = ctx.message.video.file_id;
    } else if (ctx.message.document) {
      fileId = ctx.message.document.file_id;
    }
    
    await db.saveUserProof(ctx.from.id, fileId, ctx.message.caption);
    
    // 進入問卷階段
    ctx.reply(
      `✅ 持倉證明已收到！\n\n` +
      `📝 *步驟 2/3: 回答問卷*\n\n` +
      `請回答以下問題：`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('開始問卷', 'start_questionnaire')]
        ])
      }
    );
  }
});

// 開始問卷
bot.action('start_questionnaire', async (ctx) => {
  await ctx.answerCbQuery();
  
  ctx.editMessageText(
    `❓ *問題 1/3*\n\n` +
    `您有多少年的美股操作經驗？`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('< 1年', 'exp_0'),
          Markup.button.callback('1-3年', 'exp_1')
        ],
        [
          Markup.button.callback('3-5年', 'exp_3'),
          Markup.button.callback('> 5年', 'exp_5')
        ]
      ])
    }
  );
});

// 處理經驗選擇
bot.action(/exp_(\d+)/, async (ctx) => {
  const exp = ctx.match[1];
  await db.updateUserField(ctx.from.id, 'experience', exp);
  
  ctx.editMessageText(
    `❓ *問題 2/3*\n\n` +
    `您主要的投資策略是？`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('價值投資', 'strategy_value'),
          Markup.button.callback('成長投資', 'strategy_growth')
        ],
        [
          Markup.button.callback('波段交易', 'strategy_swing'),
          Markup.button.callback('當沖', 'strategy_day')
        ],
        [Markup.button.callback('混合策略', 'strategy_mixed')]
      ])
    }
  );
});

// 處理策略選擇
bot.action(/strategy_(.+)/, async (ctx) => {
  const strategy = ctx.match[1];
  await db.updateUserField(ctx.from.id, 'strategy', strategy);
  
  ctx.editMessageText(
    `📋 *步驟 3/3: 同意群組規則*\n\n` +
    `請仔細閱讀並同意以下規則：\n\n` +
    `✅ *必須遵守*\n` +
    `1. 禁止私下騷擾或私訊其他群友\n` +
    `2. 禁止在群內或私下發送任何廣告與連結\n` +
    `3. 禁止分享未經證實的投資建議\n` +
    `4. 尊重他人意見，理性討論\n` +
    `5. 保護群友隱私，禁止外傳聊天記錄\n\n` +
    `⚠️ *違規處理*\n` +
    `• 首次違規：警告\n` +
    `• 二次違規：禁言24小時\n` +
    `• 三次違規：永久移除\n` +
    `• 詐騙行為：立即踢出並報警\n\n` +
    `如有被騷擾或詐騙，請立即向管理員檢舉。`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('✅ 我已閱讀並同意', 'agree_rules'),
          Markup.button.callback('❌ 不同意', 'disagree_rules')
        ]
      ])
    }
  );
});

// 同意規則
bot.action('agree_rules', async (ctx) => {
  await ctx.answerCbQuery();
  
  // 標記為已驗證
  await db.verifyUser(ctx.from.id);
  
  ctx.editMessageText(
    `🎉 *驗證完成！*\n\n` +
    `感謝您完成入會驗證。\n\n` +
    `現在您可以使用邀請連結加入群組，\n` +
    `管理員會盡快審核您的入群申請。\n\n` +
    `⏰ 審核時間: 通常在24小時內\n` +
    `📩 審核結果將通過Bot通知您\n\n` +
    `如有任何問題，請聯繫管理員 @Maggie`,
    { parse_mode: 'Markdown' }
  );
  
  // 通知管理員有新的已驗證用戶
  await notifyAdmins(
    `✅ *新用戶完成驗證*\n\n` +
    `用戶: @${ctx.from.username || '無用戶名'}\n` +
    `ID: ${ctx.from.id}\n` +
    `經驗: ${await db.getUserField(ctx.from.id, 'experience')}\n` +
    `策略: ${await db.getUserField(ctx.from.id, 'strategy')}\n` +
    `時間: ${new Date().toLocaleString('zh-TW')}\n\n` +
    `用戶可以開始申請入群了。`
  );
});

// 不同意規則
bot.action('disagree_rules', async (ctx) => {
  await ctx.answerCbQuery();
  
  ctx.editMessageText(
    `❌ *驗證未完成*\n\n` +
    `很抱歉，您需要同意群組規則才能加入。\n\n` +
    `如果您改變主意，可以隨時使用 /start 重新開始驗證。`,
    { parse_mode: 'Markdown' }
  );
});

// ============================================
// 認證會員申請系統
// ============================================

bot.command('apply', async (ctx) => {
  const user = await db.getUser(ctx.from.id);
  
  if (!user || user.tier < TIERS.LOBBY) {
    return ctx.reply('❌ 您需要先加入大廳會員群組');
  }
  
  if (user.tier >= TIERS.CERTIFIED) {
    return ctx.reply('✅ 您已經是認證會員或以上等級');
  }
  
  // 檢查是否有待審核的申請
  const pendingApp = await db.getPendingApplication(ctx.from.id);
  if (pendingApp) {
    return ctx.reply('⏰ 您的申請正在審核中，請耐心等待');
  }
  
  ctx.reply(
    `🌟 *申請認證會員*\n\n` +
    `認證會員可享有：\n` +
    `• 每日4次七巨頭報告\n` +
    `• 真實市場數據\n` +
    `• 技術指標分析\n` +
    `• 專屬討論群組\n\n` +
    `申請要求：\n` +
    `1. 重新上傳更詳細的持倉證明\n` +
    `2. 填寫申請聲明\n\n` +
    `準備好了嗎？`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🚀 開始申請', 'start_cert_application')]
      ])
    }
  );
});

// ============================================
// 輔助函數
// ============================================

function getTierName(tier) {
  const names = {
    0: '待審核',
    1: '大廳會員',
    2: '認證會員',
    3: 'VIP會員'
  };
  return names[tier] || '未知';
}

async function notifyAdmins(message, keyboard = null) {
  const admins = await db.getAdmins();
  for (const admin of admins) {
    try {
      await bot.telegram.sendMessage(admin.user_id, message, {
        parse_mode: 'Markdown',
        ...(keyboard && keyboard)
      });
    } catch (e) {
      console.error(`無法通知管理員 ${admin.user_id}:`, e.message);
    }
  }
}

// ============================================
// VIP會員指令
// ============================================

bot.command('vip', async (ctx) => {
  const user = await db.getUser(ctx.from.id);
  
  if (user && user.tier === 3) {
    const sub = await db.getActiveVIPSubscription(ctx.from.id);
    if (sub) {
      return ctx.reply(
        `👑 *您的VIP會員狀態*\n\n` +
        `方案: ${sub.plan}\n` +
        `到期時間: ${new Date(sub.expires_at).toLocaleString('zh-TW')}\n\n` +
        `使用 /renew 續訂`,
        { parse_mode: 'Markdown' }
      );
    }
  }
  
  ctx.reply(
    `👑 *VIP會員方案*\n\n` +
    `💎 *專屬功能*\n` +
    `• 每2小時更新七巨頭報告\n` +
    `• 完整S&P500股票分析\n` +
    `• IPO深度分析\n` +
    `• 市場情緒指標\n` +
    `• 財報解析\n` +
    `• 板塊輪動分析\n` +
    `• 價格提醒功能\n` +
    `• 投資組合追蹤\n\n` +
    `💰 *定價方案*\n` +
    `• 月付: $49/月 (NT$1,470)\n` +
    `• 季付: $129/季 (NT$3,870)\n` +
    `• 年付: $468/年 (NT$14,040)\n\n` +
    `📧 聯繫 @Maggie 訂閱VIP會員`,
    { parse_mode: 'Markdown' }
  );
});

// ============================================
// 用戶檢舉系統
// ============================================

bot.command('report', async (ctx) => {
  const user = await db.getUser(ctx.from.id);
  
  if (!user || user.tier < 1) {
    return ctx.reply('❌ 只有群組成員可以使用檢舉功能');
  }
  
  ctx.reply(
    `🚨 *檢舉違規用戶*\n\n` +
    `如發現以下違規行為，請立即檢舉：\n\n` +
    `• 騷擾或私訊其他群友\n` +
    `• 發送廣告或外部連結\n` +
    `• 詐騙行為\n` +
    `• 惡意攻擊或辱罵\n\n` +
    `請使用格式：\n` +
    `/report <用戶ID> <違規原因>\n\n` +
    `例如：\n` +
    `/report 123456789 私訊騷擾`,
    { parse_mode: 'Markdown' }
  );
});

// 處理檢舉提交（文字訊息）
bot.hears(/^\/report\s+(\d+)\s+(.+)/, async (ctx) => {
  const reportedId = parseInt(ctx.match[1]);
  const reason = ctx.match[2];
  
  try {
    const reportId = await db.createReport(
      ctx.from.id,
      reportedId,
      reason,
      null
    );
    
    ctx.reply('✅ 檢舉已提交，管理員會盡快處理');
    
    // 通知管理員
    await notifyAdmins(
      `🚨 *新違規檢舉*\n\n` +
      `檢舉人: @${ctx.from.username} (${ctx.from.id})\n` +
      `被檢舉: ${reportedId}\n` +
      `原因: ${reason}\n\n` +
      `使用 /admin 查看詳情`
    );
  } catch (error) {
    console.error('提交檢舉失敗:', error);
    ctx.reply('❌ 提交檢舉失敗');
  }
});

// ============================================
// 幫助指令
// ============================================

bot.command('help', async (ctx) => {
  const user = await db.getUser(ctx.from.id);
  const tier = user ? user.tier : 0;
  
  let message = `📖 *可用指令列表*\n\n`;
  
  // 所有用戶
  message += `🌐 *基本指令*\n`;
  message += `/start - 開始驗證\n`;
  message += `/status - 查看會員狀態\n`;
  message += `/help - 查看幫助\n\n`;
  
  // 大廳會員以上
  if (tier >= 1) {
    message += `👥 *會員指令*\n`;
    message += `/apply - 申請認證會員\n`;
    message += `/report - 檢舉違規\n`;
    message += `/vip - VIP方案\n\n`;
  }
  
  // 認證會員以上
  if (tier >= 2) {
    message += `⭐ *認證會員*\n`;
    message += `• 每日4次七巨頭報告\n`;
    message += `• 真實市場數據\n\n`;
  }
  
  // VIP會員
  if (tier >= 3) {
    message += `👑 *VIP專屬指令*\n`;
    message += `/stock <代碼> - 股票分析\n`;
    message += `/search <關鍵字> - 搜索股票\
