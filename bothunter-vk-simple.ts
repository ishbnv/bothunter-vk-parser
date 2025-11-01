import { chromium, type Browser, type Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { config as loadEnv } from 'dotenv';

loadEnv();

/**
 * Данные сообщества ВК
 */
interface CommunityData {
  name: string;
  url: string;
  identifier: string;
}

/**
 * Результат парсинга
 */
interface ParseResult {
  community: CommunityData;
  userIds: string[];
  totalUsers: number;
  timestamp: string;
}

/**
 * Конфигурация парсера
 */
interface ParserConfig {
  baseUrl: string;
  headless?: boolean;
  maxPages?: number;
  sessionPath?: string;
  outputFile?: string;
}

/**
 * Парсер BotHunter для ВК
 * Предназначен для автоматического сбора ID пользователей из сообществ ВКонтакте
 */
class BotHunterVKParser {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private config: ParserConfig;
  private userIds: Set<string> = new Set();
  private communityData: CommunityData | null = null;

  /**
   * Создает экземпляр парсера BotHunter
   * @param config - Конфигурация парсера
   */
  constructor(config: ParserConfig) {
    this.config = {
      headless: false,
      outputFile: 'bothunter_results.json',
      ...config,
      baseUrl: config.baseUrl || 'https://bot.targethunter.ru'
    };
  }

  /**
   * Инициализация браузера и создание контекста
   * @returns {Promise<void>}
   * @throws {Error} Если не удалось инициализировать браузер
   */
  async init(): Promise<void> {
    console.log('Запуск браузера...');

    const userDataDir = this.config.sessionPath || path.join(process.cwd(), 'browser-session');

    this.browser = await chromium.launch({
      headless: this.config.headless,
      slowMo: 50,
    });

    const context = await this.browser.newContext({
      viewport: { width: 1920, height: 1080 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      locale: 'ru-RU',
      storageState: fs.existsSync(`${userDataDir}/state.json`) 
        ? `${userDataDir}/state.json` 
        : undefined,
    });

    this.page = await context.newPage();

    this.browser.on('disconnected', async () => {
      if (fs.existsSync(userDataDir)) {
        await context.storageState({ path: `${userDataDir}/state.json` });
      }
    });

    console.log('✅ Браузер инициализирован');
  }

  /**
   * Проверка авторизации пользователя на сайте BotHunter
   * @returns {Promise<boolean>} true если пользователь авторизован, false в противном случае
   */
  async checkAuth(): Promise<boolean> {
    if (!this.page) return false;

    try {
      await this.page.goto(this.config.baseUrl, { 
        waitUntil: 'domcontentloaded',
        timeout: 30000 
      });

      const isLoggedIn = await this.page.evaluate(() => {
        const hasUserMenu = document.querySelector('[class*="user"]') !== null;
        const hasLogoutButton = document.querySelector('a[href*="logout"], button:has-text("Выход")') !== null;
        const isOnLoginPage = window.location.pathname.includes('login');
        
        return (hasUserMenu || hasLogoutButton) && !isOnLoginPage;
      });

      return isLoggedIn;
    } catch (error) {
      console.error('Ошибка проверки авторизации:', error);
      return false;
    }
  }

  /**
   * Авторизация через ВКонтакте (полуавтоматическая)
   * @returns {Promise<void>}
   * @throws {Error} Если браузер не инициализирован
   */
  async loginVK(): Promise<void> {
    if (!this.page) throw new Error('Браузер не инициализирован');

    console.log('🔐 Авторизация через ВК...');
    
    await this.page.goto(`${this.config.baseUrl}/login`, { 
      waitUntil: 'domcontentloaded' 
    });

    const vkLoginButton = await this.page.$('button:has-text("ВКонтакте"), a:has-text("ВКонтакте"), [href*="vk.com/authorize"]');
    
    if (vkLoginButton) {
      console.log('📱 Найдена кнопка входа через ВК, нажимаем...');
      await vkLoginButton.click();
      
      console.log('⏳ Ожидание авторизации через ВК...');
      console.log('👤 Пожалуйста, авторизуйтесь в открывшемся окне');
      
      await this.page.waitForURL(url => !url.href.includes('vk.com'), {
        timeout: 120000
      });
      
      console.log('✅ Авторизация завершена');
      
      await this.saveSession();
    } else {
      console.log('⚠️ Кнопка входа через ВК не найдена');
      console.log('👤 Пожалуйста, авторизуйтесь вручную');
      
      await this.page.waitForURL(url => !url.href.includes('login'), {
        timeout: 120000
      });
    }
  }

  /**
   * Сохранение текущей сессии браузера для повторного использования
   * @returns {Promise<void>}
   */
  async saveSession(): Promise<void> {
    if (!this.page) return;

    const userDataDir = this.config.sessionPath || path.join(process.cwd(), 'browser-session');
    
    if (!fs.existsSync(userDataDir)) {
      fs.mkdirSync(userDataDir, { recursive: true });
    }

    await this.page.context().storageState({ 
      path: path.join(userDataDir, 'state.json') 
    });
    
    console.log('💾 Сессия сохранена');
  }

  /**
   * Извлечение основной информации о сообществе ВКонтакте
   * @returns {Promise<void>}
   * @throws {Error} Если браузер не инициализирован
   */
  async extractCommunityInfo(): Promise<void> {
    if (!this.page) throw new Error('Браузер не инициализирован');

    console.log('📋 Извлечение информации о сообществе...');
    
    await this.page.goto(this.config.baseUrl, { 
      waitUntil: 'networkidle' 
    });

    this.communityData = await this.page.evaluate(() => {
      const nameElement = document.querySelector('h1, [class*="title"], [class*="community"]');
      const name = nameElement?.textContent?.trim() || 'Unknown Community';

      const identifierMatch = document.body.textContent?.match(/ID:\s*(\d+)|Идентификатор:\s*(\d+)/);
      const identifier = identifierMatch?.[1] || identifierMatch?.[2] || '';

      let vkUrl = '';
      const vkLink = document.querySelector('a[href*="vk.com"]');
      if (vkLink) {
        vkUrl = (vkLink as HTMLAnchorElement).href;
      }

      return {
        name: name,
        url: vkUrl,
        identifier: identifier
      };
    });

    console.log(`✅ Сообщество: ${this.communityData.name}`);
    if (this.communityData.url) {
      console.log(`   URL: ${this.communityData.url}`);
    }
  }

  /**
   * Извлечение ID пользователей с текущей страницы
   * @returns {Promise<string[]>} Массив найденных ID пользователей
   * @throws {Error} Если браузер не инициализирован
   */
  async extractUserIds(): Promise<string[]> {
    if (!this.page) throw new Error('Браузер не инициализирован');

    const ids = await this.page.evaluate(() => {
      const userIds: string[] = [];
      
      const idPatterns = [
        /ID\s*[:\s]*(\d+)/gi,
        /ID(\d+)/gi,
        /@id(\d+)/gi,
      ];

      const pageText = document.body.innerText;
      
      const userElements = document.querySelectorAll('[class*="user"], [class*="contact"], [class*="member"]');
      
      userElements.forEach(element => {
        const text = element.textContent || '';
        
        for (const pattern of idPatterns) {
          const matches = text.matchAll(pattern);
          for (const match of matches) {
            if (match[1]) {
              userIds.push(match[1]);
            }
          }
        }
      });

      for (const pattern of idPatterns) {
        const matches = pageText.matchAll(pattern);
        for (const match of matches) {
          if (match[1]) {
            userIds.push(match[1]);
          }
        }
      }

      return [...new Set(userIds)];
    });

    return ids;
  }

  /**
   * Основной процесс парсинга данных
   * Выполняет полный цикл: инициализация, авторизация, сбор данных, сохранение
   * @returns {Promise<void>}
   * @throws {Error} При критических ошибках выполнения
   */
  async parse(): Promise<void> {
    const startTime = Date.now();

    try {
      await this.init();

      const isAuthorized = await this.checkAuth();
      
      if (!isAuthorized) {
        console.log('❌ Не авторизован, требуется вход');
        await this.loginVK();
      } else {
        console.log('✅ Уже авторизован');
      }

      await this.extractCommunityInfo();

      console.log('📋 Переход на страницу контактов...');
      await this.page!.goto(`${this.config.baseUrl}/contacts`, { 
        waitUntil: 'networkidle' 
      });

      let currentPage = 1;
      const maxPages = this.config.maxPages || 1000;

      while (currentPage <= maxPages) {
        console.log(`\n📄 Обработка страницы ${currentPage}...`);

        const pageIds = await this.extractUserIds();
        console.log(`   Найдено ID: ${pageIds.length}`);

        pageIds.forEach(id => this.userIds.add(id));

        const nextButton = await this.page!.$(`
          button:has-text("Следующ"),
          button:has-text("Next"),
          a:has-text("Следующ"),
          .pagination button:not([disabled]):has-text("→"),
          [aria-label="Next page"]:not([disabled])
        `);

        if (nextButton) {
          const isDisabled = await nextButton.evaluate(btn => {
            return (btn as HTMLButtonElement).disabled || 
                   btn.classList.contains('disabled') ||
                   btn.hasAttribute('disabled');
          });

          if (isDisabled) {
            console.log('⚠️ Достигнута последняя страница');
            break;
          }

          await nextButton.click();
          await this.page!.waitForLoadState('networkidle');
          await this.delay(1000, 2000);
          
          currentPage++;
        } else {
          console.log('⚠️ Кнопка следующей страницы не найдена');
          break;
        }
      }

      await this.saveResults();

      const duration = Math.round((Date.now() - startTime) / 1000);
      console.log(`\n✅ Парсинг завершен за ${duration} секунд`);
      console.log(`📊 Статистика:`);
      console.log(`   Сообщество: ${this.communityData?.name}`);
      console.log(`   Всего ID пользователей: ${this.userIds.size}`);

    } catch (error) {
      console.error('❌ Ошибка:', error);
      throw error;
    } finally {
      await this.close();
    }
  }

  /**
   * Сохранение результатов парсинга в файлы
   * Создает JSON файл с полными данными и TXT файл только с ID
   * @returns {Promise<void>}
   */
  async saveResults(): Promise<void> {
    const result: ParseResult = {
      community: this.communityData || {
        name: 'Unknown',
        url: '',
        identifier: ''
      },
      userIds: Array.from(this.userIds),
      totalUsers: this.userIds.size,
      timestamp: new Date().toISOString()
    };

    const outputFile = this.config.outputFile || 'bothunter_results.json';
    fs.writeFileSync(outputFile, JSON.stringify(result, null, 2), 'utf-8');
    console.log(`\n💾 Результаты сохранены в: ${outputFile}`);

    const idsFile = outputFile.replace('.json', '_ids.txt');
    fs.writeFileSync(idsFile, Array.from(this.userIds).join('\n'), 'utf-8');
    console.log(`💾 ID пользователей сохранены в: ${idsFile}`);
  }

  /**
   * Случайная задержка между действиями для имитации человеческого поведения
   * @param min - Минимальное время задержки в миллисекундах
   * @param max - Максимальное время задержки в миллисекундах
   * @returns {Promise<void>}
   */
  private async delay(min: number, max: number): Promise<void> {
    const ms = Math.floor(Math.random() * (max - min + 1)) + min;
    await new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Корректное закрытие браузера с сохранением сессии
   * @returns {Promise<void>}
   */
  async close(): Promise<void> {
    if (this.page) {
      await this.saveSession();
    }
    if (this.browser) {
      await this.browser.close();
      console.log('👋 Браузер закрыт');
    }
  }
}

/**
 * Главная функция приложения
 * Инициализирует и запускает парсер с настройками из переменных окружения
 * @returns {Promise<void>}
 */
async function main() {
  const parser = new BotHunterVKParser({
    baseUrl: 'https://bot.targethunter.ru',
    headless: process.env.HEADLESS === 'true',
    maxPages: process.env.MAX_PAGES ? parseInt(process.env.MAX_PAGES) : undefined,
    sessionPath: process.env.SESSION_PATH || './browser-session',
    outputFile: process.env.OUTPUT_FILE || 'bothunter_results.json',
  });

  console.log('🎯 BotHunter VK Parser - Упрощенная версия');
  console.log('==========================================\n');
  console.log('📝 Настройки:');
  console.log(`   Headless: ${process.env.HEADLESS === 'true' ? 'Да' : 'Нет'}`);
  console.log(`   Макс. страниц: ${process.env.MAX_PAGES || 'Все'}`);
  console.log(`   Путь сессии: ${process.env.SESSION_PATH || './browser-session'}\n`);

  try {
    await parser.parse();
  } catch (error) {
    console.error('💥 Критическая ошибка:', error);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { BotHunterVKParser };
