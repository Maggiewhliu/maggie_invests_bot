// dashboardAPI.js - 儀表板 API 服務
const express = require('express');
const cors = require('cors');
const path = require('path');

class DashboardAPI {
  constructor(db, stockService) {
    this.app = express();
    this.db = db;
    this.stockService = stockService;
    
    this.setupMiddleware();
    this.setupRoutes();
  }

  setupMiddleware() {
    this.app.use(cors());
    this.app.use(express.json());
    this.app.use(express.static('public'));
  }

  setupRoutes() {
    // ============================================
    // Mini App 主頁面
    // ============================================
    
    this.app.get('/dashboard', (req, res) => {
      res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
    });

    // ============================================
    // API 端點
    // ============================================

    // 獲取七巨頭概覽
    this.app.get('/api/stocks/summary', async (req, res) => {
      try {
        const stocks = await this.stockService.getMultipleStocks([
          'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA'
        ]);

        // 計算統計數據
        const avgChange = stocks.reduce((sum, s) => sum + s.changePercent, 0) / stocks.length;
        const bullCount = stocks.filter(s => s.changePercent > 0).length;
        const bearCount = stocks.length - bullCount;
        
        // 計算市值變化
        const marketCapChange = stocks.reduce((sum, s) => {
          const change = (s.price - (s.price / (1 + s.changePercent / 100))) * 
                        (s.marketCap || 1000000000000) / s.price;
          return sum + change;
        }, 0);

        // 計算總成交量
        const totalVolume = stocks.reduce((sum, s) => sum + (s.volume || 0), 0);

        res.json({
          success: true,
          data: {
            avgChange: avgChange.toFixed(2),
            bullBear: `${bullCount}:${bearCount}`,
            marketCapChange: this.formatMarketCap(marketCapChange),
            totalVolume: this.formatVolume(totalVolume),
            stocks: stocks.map(s => ({
              symbol: s.symbol,
              name: s.name,
              icon: this.getStockIcon(s.symbol),
              price: s.price,
              change: s.change,
              changePercent: s.changePercent,
              volume: s.volume,
              rsi: s.rsi
            })),
            updateTime: new Date().toISOString()
          }
        });
      } catch (error) {
        console.error('獲取概覽失敗:', error);
        res.status(500).json({
          success: false,
          error: '獲取數據失敗'
        });
      }
    });

    // 獲取單個股票詳情
    this.app.get('/api/stocks/:symbol', async (req, res) => {
      try {
        const { symbol } = req.params;
        const quote = await this.stockService.getStockQuote(symbol);
        const technical = await this.stockService.getTechnicalIndicators(symbol);

        if (!quote) {
          return res.status(404).json({
            success: false,
            error: '找不到股票'
          });
        }

        res.json({
          success: true,
          data: {
            ...quote,
            technical,
            icon: this.getStockIcon(symbol)
          }
        });
      } catch (error) {
        console.error('獲取股票詳情失敗:', error);
        res.status(500).json({
          success: false,
          error: '獲取數據失敗'
        });
      }
    });

    // 獲取歷史數據
    this.app.get('/api/stocks/:symbol/history', async (req, res) => {
      try {
        const { symbol } = req.params;
        const { period = '1D' } = req.query;

        // 這裡應該從API獲取真實歷史數據
        // 暫時返回模擬數據
        const data = this.generateHistoryData(period);

        res.json({
          success: true,
          data: {
            symbol,
            period,
            prices: data
          }
        });
      } catch (error) {
        console.error('獲取歷史數據失敗:', error);
        res.status(500).json({
          success: false,
          error: '獲取數據失敗'
        });
      }
    });

    //
