// services/stockService.js - 股票數據服務
const axios = require('axios');

class StockService {
  constructor() {
    this.polygonKey = process.env.POLYGON_API_KEY;
    this.twelveDataKey = process.env.TWELVE_DATA_API_KEY;
    this.alphaVantageKey = process.env.ALPHA_VANTAGE_API_KEY;
    
    // 七巨頭股票代碼
    this.magnificentSeven = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA'];
    
    // 股票emoji映射
    this.stockEmojis = {
      'AAPL': '🍎',
      'MSFT': '💻',
      'GOOGL': '🔍',
      'AMZN': '📦',
      'NVDA': '🚀',
      'META': '👥',
      'TSLA': '🚗'
    };
  }

  // ============================================
  // 七巨頭報告生成
  // ============================================

  async generateMagnificentSevenReport() {
    try {
      const stocks = await this.getMultipleStocks(this.magnificentSeven);
      const sortedStocks = stocks.sort((a, b) => b.changePercent - a.changePercent);
      
      const now = new Date();
      const taiwanTime = new Intl.DateTimeFormat('zh-TW', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Asia/Taipei'
      }).format(now);

      // 計算時段
      const hour = now.getUTCHours() + 8; // 轉台北時間
      let timeLabel = '🌙 盤前追蹤';
      if (hour >= 6 && hour < 12) timeLabel = '🌞 午盤追蹤';
      else if (hour >= 12 && hour < 18) timeLabel = '🌆 收盤追蹤';
      else if (hour >= 18 && hour < 24) timeLabel = '🌙 盤後追蹤';

      // 構建報告
      let report = `🎯 *美股七巨頭追蹤* ${timeLabel}\n`;
      report += `📅 ${taiwanTime} 台北時間\n\n`;
      
      // 實時表現排行
      report += `📊 *實時表現排行*\n`;
      sortedStocks.forEach((stock, index) => {
        const emoji = this.stockEmojis[stock.symbol] || '📈';
        const trend = this.getTrendEmoji(stock.changePercent);
        const statusText = this.getStatusText(stock.changePercent);
        
        report += `${index + 1}️⃣ ${trend} ${emoji} ${stock.name} $${stock.price.toFixed(2)}\n`;
        report += `📊 ${stock.change >= 0 ? '+' : ''}${stock.change.toFixed(2)} (${stock.change >= 0 ? '+' : ''}${stock.changePercent.toFixed(2)}%) | ${statusText}`;
        
        // 添加特殊標記
        if (Math.abs(stock.changePercent) > 3) {
          report += ` | 🔥 ${stock.changePercent > 0 ? '爆量上漲' : '急跌'}`;
        }
        report += `\n`;
      });

      // 弱勢股票
      const weakStocks = sortedStocks.filter(s => s.changePercent < 0);
      if (weakStocks.length > 0) {
        report += `\n⚠️ *弱勢股票*\n`;
        weakStocks.forEach(stock => {
          const emoji = this.stockEmojis[stock.symbol];
          report += `📉 ${emoji} ${stock.name} $${stock.price.toFixed(2)} (${stock.changePercent.toFixed(2)}%)\n`;
        });
      }

      // 整體表現
      const avgChange = sortedStocks.reduce((sum, s) => sum + s.changePercent, 0) / sortedStocks.length;
      const strongest = sortedStocks[0];
      const weakest = sortedStocks[sortedStocks.length - 1];
      
      report += `\n🏛️ *七巨頭整體表現*\n`;
      report += `📈 平均漲跌: ${avgChange >= 0 ? '+' : ''}${avgChange.toFixed(2)}%\n`;
      report += `🔥 最強: ${this.stockEmojis[strongest.symbol]} ${strongest.name} (${strongest.changePercent >= 0 ? '+' : ''}${strongest.changePercent.toFixed(2)}%)\n`;
      report += `❄️ 最弱: ${this.stockEmojis[weakest.symbol]} ${weakest.name} (${weakest.changePercent >= 0 ? '+' : ''}${weakest.changePercent.toFixed(2)}%)\n`;

      // 交易策略提醒
      report += `\n💡 *交易策略提醒*\n`;
      if (strongest.changePercent > 2) {
        report += `🚀 強勢追蹤: 關注 ${strongest.symbol} 的延續性\n`;
      }
      if (weakest.changePercent < -2) {
        report += `🛒 逢低布局: 考慮 ${weakest.symbol} 的反彈機會\n`;
      }
      report += `⚖️ 平衡配置: 七巨頭分散風險，長期看漲\n`;

      // 市場總結
      const bullish = sortedStocks.filter(s => s.changePercent > 0).length;
      const bearish = sortedStocks.filter(s => s.changePercent < 0).length;
      const sentiment = avgChange > 1 ? '樂觀多頭 🚀' : avgChange < -1 ? '悲觀空頭 📉' : '謹慎中性 ⚖️';
      
      report += `\n🎯 *今日市場總結*\n`;
      report += `📈 多頭股票: ${bullish}支\n`;
      report += `📉 空頭股票: ${bearish}支\n`;
      report += `🔥 市場情緒: ${sentiment} (${avgChange >= 0 ? '+' : ''}${avgChange.toFixed(2)}%)\n`;

      // 技術面分析
      report += `\n📈 *技術面分析*\n`;
      const overBought = sortedStocks.filter(s => s.rsi && s.rsi > 70);
      const overSold = sortedStocks.filter(s => s.rsi && s.rsi < 30);
      
      report += `RSI超買: ${overBought.length > 0 ? overBought.map(s => `${this.stockEmojis[s.symbol]} ${s.symbol} (${s.rsi.toFixed(1)})`).join(', ') : '無'}\n`;
      report += `RSI超賣: ${overSold.length > 0 ? overSold.map(s => `${this.stockEmojis[s.symbol]} ${s.symbol} (${s.rsi.toFixed(1)})`).join(', ') : '無'}\n`;

      // AI建議
      report += `\n💡 *AI智能建議*\n`;
      const longHold = sortedStocks.filter(s => s.changePercent > -1 && s.changePercent < 2);
      const watchList = sortedStocks.filter(s => Math.abs(s.changePercent) > 3);
      const risk = sortedStocks.filter(s => s.changePercent < -3);
      
      if (longHold.length > 0) {
        report += `🟢 長線持有: ${longHold.map(s => `${this.stockEmojis[s.symbol]} ${s.symbol}`).join(', ')}\n`;
      }
      if (watchList.length > 0) {
        report += `🟡 短線觀望: ${watchList.map(s => `${this.stockEmojis[s.symbol]} ${s.symbol}`).join(', ')}\n`;
      }
      if (risk.length > 0) {
        report += `🔴 風險警示: ${risk.map(s => `${this.stockEmojis[s.symbol]} ${s.symbol} (${s.changePercent.toFixed(1)}%)`).join(', ')}\n`;
      }
      report += `📋 投資組合: 維持均衡配置，關注個股表現\n`;

      // 下次更新時間
      report += `\n🕐 *下次更新: 6小時後*\n`;
      report += `---\n`;
      report += `🔄 每6小時自動更新 (00:00/06:00/12:00/18:00)\n`;
      report += `💬 反饋請找管理員Maggie`;

      return report;
    } catch (error) {
      console.error('生成七巨頭報告失敗:', error);
      return '❌ 報告生成失敗，請稍後再試';
    }
  }

  // ============================================
  // 獲取單支股票數據
  // ============================================

  async getStockQuote(symbol) {
    try {
      // 使用Polygon API
      const url = `https://api.polygon.io/v2/aggs/ticker/${symbol}/prev?apiKey=${this.polygonKey}`;
      const response = await axios.get(url);
      
      if (response.data.results && response.data.results.length > 0) {
        const data = response.data.results[0];
        return {
          symbol: symbol,
          price: data.c,
          open: data.o,
          high: data.h,
          low: data.l,
          volume: data.v,
          change: data.c - data.o,
          changePercent: ((data.c - data.o) / data.o) * 100
        };
      }
      
      // 備用：使用Twelve Data API
      return await this.getStockQuoteTwelveData(symbol);
    } catch (error) {
      console.error(`獲取${symbol}數據失敗:`, error.message);
      return null;
    }
  }

  async getStockQuoteTwelveData(symbol) {
    try {
      const url = `https://api.twelvedata.com/quote?symbol=${symbol}&apikey=${this.twelveDataKey}`;
      const response = await axios.get(url);
      
      if (response.data) {
        const data = response.data;
        return {
          symbol: symbol,
          name: data.name,
          price: parseFloat(data.close),
          open: parseFloat(data.open),
          high: parseFloat(data.high),
          low: parseFloat(data.low),
          volume: parseInt(data.volume),
          change: parseFloat(data.change),
          changePercent: parseFloat(data.percent_change)
        };
      }
      return null;
    } catch (error) {
      console.error(`Twelve Data API失敗:`, error.message);
      return null;
    }
  }

  // ============================================
  // 獲取多支股票數據
  // ============================================

  async getMultipleStocks(symbols) {
    const promises = symbols.map(symbol => this.getStockQuote(symbol));
    const results = await Promise.all(promises);
    return results.filter(r => r !== null);
  }

  // ============================================
  // 技術指標計算
  // ============================================

  async getTechnicalIndicators(symbol) {
    try {
      // 獲取歷史數據
      const url = `https://api.twelvedata.com/time_series?symbol=${symbol}&interval=1day&outputsize=50&apikey=${this.twelveDataKey}`;
      const response = await axios.get(url);
      
      if (!response.data.values) return null;
      
      const prices = response.data.values.map(v => parseFloat(v.close));
      
      // 計算RSI
      const rsi = this.calculateRSI(prices, 14);
      
      // 計算MACD
      const macd = this.calculateMACD(prices);
      
      // 計算布林通道
      const bollinger = this.calculateBollingerBands(prices, 20);
      
      return {
        rsi: rsi[rsi.length - 1],
        macd: macd,
        bollinger: bollinger
      };
    } catch (error) {
      console.error(`獲取${symbol}技術指標失敗:`, error.message);
      return null;
    }
  }

  calculateRSI(prices, period = 14) {
    const gains = [];
    const losses = [];
    
    for (let i = 1; i < prices.length; i++) {
      const change = prices[i] - prices[i - 1];
      gains.push(change > 0 ? change : 0);
      losses.push(change < 0 ? Math.abs(change) : 0);
    }
    
    const rsi = [];
    let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
    let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;
    
    for (let i = period; i < prices.length; i++) {
      avgGain = (avgGain * (period - 1) + gains[i]) / period;
      avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
      
      const rs = avgGain / avgLoss;
      rsi.push(100 - (100 / (1 + rs)));
    }
    
    return rsi;
  }

  calculateMACD(prices) {
    const ema12 = this.calculateEMA(prices, 12);
    const ema26 = this.calculateEMA(prices, 26);
    const macdLine = ema12.map((val, i) => val - ema26[i]);
    const signalLine = this.calculateEMA(macdLine, 9);
    const histogram = macdLine.map((val, i) => val - signalLine[i]);
    
    return {
      macd: macdLine[macdLine.length - 1],
      signal: signalLine[signalLine.length - 1],
      histogram: histogram[histogram.length - 1]
    };
  }

  calculateEMA(prices, period) {
    const k = 2 / (period + 1);
    const ema = [prices[0]];
    
    for (let i = 1; i < prices.length; i++) {
      ema.push(prices[i] * k + ema[i - 1] * (1 - k));
    }
    
    return ema;
  }

  calculateBollingerBands(prices, period = 20) {
    const sma = prices.slice(-period).reduce((a, b) => a + b, 0) / period;
    const squaredDiffs = prices.slice(-period).map(p => Math.pow(p - sma, 2));
    const stdDev = Math.sqrt(squaredDiffs.reduce((a, b) => a + b, 0) / period);
    
    return {
      upper: sma + (stdDev * 2),
      middle: sma,
      lower: sma - (stdDev * 2)
    };
  }

  // ============================================
  // 輔助函數
  // ============================================

  getTrendEmoji(changePercent) {
    if (changePercent > 2) return '📈';
    if (changePercent > 0) return '📈';
    if (changePercent > -2) return '📊';
    return '📉';
  }

  getStatusText(changePercent) {
    if (changePercent > 3) return '📈 強勢上漲';
    if (changePercent > 1) return '📈 溫和上漲';
    if (changePercent > -1) return '📊 震盪整理';
    if (changePercent > -3) return '📉 溫和下跌';
    return '📉 大幅下跌';
  }

  // ============================================
  // 股票搜索與分析
  // ============================================

  async searchStock(query) {
    try {
      const url = `https://api.twelvedata.com/symbol_search?symbol=${query}&apikey=${this.twelveDataKey}`;
      const response = await axios.get(url);
      
      if (response.data.data) {
        return response.data.data.filter(s => s.country === 'United States').slice(0, 10);
      }
      return [];
    } catch (error) {
      console.error('搜索股票失敗:', error.message);
      return [];
    }
  }

  async getDetailedAnalysis(symbol) {
    try {
      const [quote, technical, company] = await Promise.all([
        this.getStockQuote(symbol),
        this.getTechnicalIndicators(symbol),
        this.getCompanyInfo(symbol)
      ]);

      if (!quote) return null;

      let analysis = `📊 *${symbol} 詳細分析*\n\n`;
      
      // 基本信息
      if (company) {
        analysis += `🏢 *公司信息*\n`;
        analysis += `名稱: ${company.name}\n`;
        analysis += `行業: ${company.industry || '未知'}\n`;
        analysis += `市值: ${company.marketCap ? this.formatMarketCap(company.marketCap) : '未知'}\n\n`;
      }

      // 價格信息
      analysis += `💰 *價格信息*\n`;
      analysis += `當前價格: ${quote.price.toFixed(2)}\n`;
      analysis += `開盤價: ${quote.open.toFixed(2)}\n`;
      analysis += `最高價: ${quote.high.toFixed(2)}\n`;
      analysis += `最低價: ${quote.low.toFixed(2)}\n`;
      analysis += `漲跌: ${quote.change >= 0 ? '+' : ''}${quote.change.toFixed(2)} (${quote.change >= 0 ? '+' : ''}${quote.changePercent.toFixed(2)}%)\n`;
      analysis += `成交量: ${this.formatVolume(quote.volume)}\n\n`;

      // 技術指標
      if (technical) {
        analysis += `📈 *技術指標*\n`;
        analysis += `RSI(14): ${technical.rsi.toFixed(2)} ${this.getRSIStatus(technical.rsi)}\n`;
        analysis += `MACD: ${technical.macd.macd.toFixed(2)}\n`;
        analysis += `Signal: ${technical.macd.signal.toFixed(2)}\n`;
        analysis += `Histogram: ${technical.macd.histogram.toFixed(2)} ${technical.macd.histogram > 0 ? '📈' : '📉'}\n`;
        analysis += `布林上軌: ${technical.bollinger.upper.toFixed(2)}\n`;
        analysis += `布林中軌: ${technical.bollinger.middle.toFixed(2)}\n`;
        analysis += `布林下軌: ${technical.bollinger.lower.toFixed(2)}\n\n`;

        // 交易建議
        analysis += `💡 *交易建議*\n`;
        analysis += this.generateTradingAdvice(quote, technical);
      }

      return analysis;
    } catch (error) {
      console.error(`分析${symbol}失敗:`, error.message);
      return null;
    }
  }

  async getCompanyInfo(symbol) {
    try {
      const url = `https://api.twelvedata.com/profile?symbol=${symbol}&apikey=${this.twelveDataKey}`;
      const response = await axios.get(url);
      return response.data;
    } catch (error) {
      console.error('獲取公司信息失敗:', error.message);
      return null;
    }
  }

  getRSIStatus(rsi) {
    if (rsi > 70) return '⚠️ 超買';
    if (rsi < 30) return '⚠️ 超賣';
    return '✅ 正常';
  }

  generateTradingAdvice(quote, technical) {
    let advice = '';
    
    // RSI建議
    if (technical.rsi > 70) {
      advice += '🔴 RSI超買，建議等待回調\n';
    } else if (technical.rsi < 30) {
      advice += '🟢 RSI超賣，可考慮逢低買入\n';
    } else if (technical.rsi > 50) {
      advice += '🟡 RSI中性偏多，可持續觀察\n';
    } else {
      advice += '🟡 RSI中性偏弱，謹慎觀望\n';
    }

    // MACD建議
    if (technical.macd.histogram > 0 && technical.macd.macd > technical.macd.signal) {
      advice += '🟢 MACD金叉，多頭信號\n';
    } else if (technical.macd.histogram < 0 && technical.macd.macd < technical.macd.signal) {
      advice += '🔴 MACD死叉，空頭信號\n';
    }

    // 布林通道建議
    if (quote.price > technical.bollinger.upper) {
      advice += '⚠️ 價格突破上軌，注意回調風險\n';
    } else if (quote.price < technical.bollinger.lower) {
      advice += '💡 價格跌破下軌，可能反彈機會\n';
    }

    // 整體建議
    advice += '\n📋 *綜合評估*\n';
    const signals = {
      buy: 0,
      sell: 0,
      hold: 0
    };

    if (technical.rsi < 40) signals.buy++;
    if (technical.rsi > 60) signals.sell++;
    if (technical.macd.histogram > 0) signals.buy++;
    if (technical.macd.histogram < 0) signals.sell++;
    if (quote.price < technical.bollinger.middle) signals.buy++;
    if (quote.price > technical.bollinger.middle) signals.sell++;

    if (signals.buy > signals.sell) {
      advice += '🟢 *建議: 買入/持有*\n';
      advice += '多項指標顯示買入信號';
    } else if (signals.sell > signals.buy) {
      advice += '🔴 *建議: 賣出/觀望*\n';
      advice += '多項指標顯示賣出信號';
    } else {
      advice += '🟡 *建議: 持有/觀望*\n';
      advice += '指標信號混合，建議觀望';
    }

    advice += '\n\n⚠️ *風險提示*: 以上分析僅供參考，不構成投資建議';

    return advice;
  }

  formatMarketCap(value) {
    if (value >= 1e12) return `${(value / 1e12).toFixed(2)}T`;
    if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
    if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
    return `${value.toFixed(2)}`;
  }

  formatVolume(volume) {
    if (volume >= 1e9) return `${(volume / 1e9).toFixed(2)}B`;
    if (volume >= 1e6) return `${(volume / 1e6).toFixed(2)}M`;
    if (volume >= 1e3) return `${(volume / 1e3).toFixed(2)}K`;
    return volume.toString();
  }

  // ============================================
  // 標普500股票列表
  // ============================================

  async getS500List() {
    // 標普500前50大公司
    const top50 = [
      'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA', 'BRK.B', 'V', 'UNH',
      'XOM', 'JNJ', 'WMT', 'JPM', 'MA', 'PG', 'HD', 'CVX', 'LLY', 'MRK',
      'ABBV', 'KO', 'AVGO', 'PEP', 'COST', 'TMO', 'MCD', 'CSCO', 'ACN', 'ABT',
      'DHR', 'NKE', 'VZ', 'ADBE', 'CRM', 'TXN', 'NEE', 'CMCSA', 'WFC', 'PM',
      'DIS', 'NFLX', 'UPS', 'INTC', 'AMD', 'QCOM', 'HON', 'UNP', 'BMY', 'RTX'
    ];
    return top50;
  }

  async searchS500(query) {
    const list = await this.getS500List();
    return list.filter(symbol => 
      symbol.toLowerCase().includes(query.toLowerCase())
    );
  }
}

module.exports = StockService;
