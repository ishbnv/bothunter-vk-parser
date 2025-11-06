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
  /** Режим работы парсера: contacts (по умолчанию) | groups | lists */
  mode?: 'contacts' | 'groups' | 'lists';
  /** Фильтры для названий списков на /contacts/lists */
  listFilters?: string[];
  /** Задержка после переключения сообщества (мс) */
  waitAfterSwitchMs?: number;
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
      try {
        if (fs.existsSync(userDataDir)) {
          await context.storageState({ path: `${userDataDir}/state.json` });
        }
      } catch (e) {
        // контекст уже закрыт — игнорируем
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
    
    await this.page.goto(`${this.config.baseUrl}`, { 
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
      const nameElement = document.querySelector('a.dark-link');
      const name = nameElement?.textContent?.trim() || 'Unknown Community';

      const identifierMatch = document.body.textContent?.match(/ID:\s*(\d+)|Идентификатор:\s*(\d+)/);
      const identifier = identifierMatch?.[1] || identifierMatch?.[2] || '';

      let vkUrl = '';
      const vkLink = document.querySelector('a.dark-link[href*="vk.com"]');
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

      // В зависимости от режима выполняем нужный сценарий
      const mode = this.config.mode || 'contacts';
      console.log(`\n🚦 Режим работы: ${mode}`);

      if (mode === 'groups') {
        await this.parseGroupsMode();
      } else if (mode === 'lists') {
        await this.parseListsMode();
      } else {
        // Базовый сценарий: текущая группа -> /contacts -> все страницы
        await this.extractCommunityInfo();
        console.log('📋 Переход на страницу контактов...');
        await this.page!.goto(`${this.config.baseUrl}/contacts`, { waitUntil: 'networkidle' });
        const ids = await this.collectAllContactIds();
        // Сохраняем как раньше (JSON + txt), причём txt пойдёт в новый формат тоже
        await this.saveResults();
        const savedPath = await this.writeIdsFile(ids, `contacts_current_group`);
        console.log(`💾 Дополнительно сохранён txt со свежим именем: ${savedPath}`);
      }

      const duration = Math.round((Date.now() - startTime) / 1000);
      console.log(`\n✅ Готово за ${duration} секунд`);

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
   * Формирование метки времени формата ddMMyyyyHHmmss для имени файла
   */
  private formatTimestampForFilename(d: Date = new Date()): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    const dd = pad(d.getDate());
    const mm = pad(d.getMonth() + 1);
    const yyyy = d.getFullYear();
    const HH = pad(d.getHours());
    const MM = pad(d.getMinutes());
    const SS = pad(d.getSeconds());
    return `${dd}${mm}${yyyy}${HH}${MM}${SS}`;
  }

  /**
   * Простой случайный хеш для имени файла
   */
  private randomHash(len = 6): string {
    return Math.random().toString(36).slice(2, 2 + len);
  }

  /**
   * Слагификация подписи для файлов
   */
  private slugify(v: string, max = 40): string {
    return (v || 'item')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9А-Яа-я_\-\s]/g, '')
      .trim()
      .replace(/\s+/g, '_')
      .slice(0, max) || 'item';
  }

  /**
   * Сохранение только ID в отдельный файл с уникальным именем
   * Пример имени: bothunter_ids_06112025225301_group_PtichkaNalichka_ab12cd.txt
   */
  private async writeIdsFile(ids: string[], label: string): Promise<string> {
    const ts = this.formatTimestampForFilename();
    const hash = this.randomHash(6);
    const safeLabel = this.slugify(label);
    const fileName = `bothunter_ids_${ts}_${safeLabel}_${hash}.txt`;
    const baseOut = this.config.outputFile || 'bothunter_results.json';
    const outDir = path.dirname(baseOut);
    const outPath = path.join(outDir, fileName);
    fs.writeFileSync(outPath, Array.from(new Set(ids)).join('\n'), 'utf-8');
    return outPath;
  }

  /**
   * Сбор ID со всех страниц текущего списка контактов
   * Не меняет текущий URL (важно для списков на /contacts/lists)
   */
  private async collectAllContactIds(): Promise<string[]> {
    if (!this.page) throw new Error('Браузер не инициализирован');

    this.userIds.clear();

    let currentPage = 1;
    const maxPages = this.config.maxPages || 10000;

    while (currentPage <= maxPages) {
      console.log(`\n📄 Обработка страницы ${currentPage}...`);

      const pageIds = await this.extractUserIds();
      console.log(`   Найдено ID: ${pageIds.length}`);
      pageIds.forEach(id => this.userIds.add(id));

      const nextButton = await this.page.$(`#followers-list-pagination .btn.btn-primary.pagination-btn:not([disabled]):not(.me-1), #followers-pagination .btn.btn-primary.pagination-btn:not([disabled]):not(.me-1)`);

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

    return Array.from(this.userIds);
  }

  /**
   * Режим 1: выгрузка ID для КАЖДОГО сообщества со страницы /groups
   */
  private async parseGroupsMode(): Promise<void> {
    if (!this.page) throw new Error('Браузер не инициализирован');

    const waitMs = this.config.waitAfterSwitchMs ?? 3000;

    console.log('📂 Переход на список сообществ...');
    await this.page.goto(`${this.config.baseUrl}/groups`, { waitUntil: 'networkidle' });

    const groups = await this.page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll('a[onclick*="change_group_with_channel"]')) as HTMLAnchorElement[];
      const items: { id: string; name: string }[] = [];
      const seen = new Set<string>();

      anchors.forEach(a => {
        const onclick = a.getAttribute('onclick') || '';
        const m = onclick.match(/change_group_with_channel\('([^']+)'/);
        const id = m?.[1] || '';
        if (!id || seen.has(id)) return;
        seen.add(id);

        let name = '';
        const nameCandidate = a.querySelector('div div div div');
        if (nameCandidate && nameCandidate.textContent) {
          const lines = nameCandidate.textContent.split('\n').map(s => s.trim()).filter(Boolean);
          name = (lines.find(s => !/^#/.test(s)) || lines[0] || '').trim();
        }
        if (!name && a.textContent) {
          const lines = a.textContent.split('\n').map(s => s.trim()).filter(Boolean);
          name = (lines.find(s => !/^#/.test(s)) || lines[0] || '').trim();
        }

        items.push({ id, name });
      });

      return items;
    });

    console.log(`🔎 Найдено сообществ: ${groups.length}`);

    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      console.log(`\n➡️  [${i + 1}/${groups.length}] Переключаюсь на: ${g.name || g.id} (#${g.id})`);

      const switchCandidate = await this.page.$(`a.btn.btn-light[onclick*="${g.id}"]`)
        || await this.page.$(`a.width-adaptive[onclick*="${g.id}"]`)
        || await this.page.$(`a.d-flex[onclick*="${g.id}"]`);

      if (switchCandidate) {
        await switchCandidate.click();
      } else {
        await this.page.evaluate((id) => {
          const fn = (window as any).smm?.change_group_with_channel;
          if (typeof fn === 'function') fn(id, 'VK');
        }, g.id);
      }

      await this.delay(waitMs, waitMs + 500);

      console.log('📋 Открываем контакты выбранного сообщества...');
      await this.page.goto(`${this.config.baseUrl}/contacts`, { waitUntil: 'networkidle' });

      const ids = await this.collectAllContactIds();
      const savedPath = await this.writeIdsFile(ids, `group_${g.name || g.id}`);
      console.log(`💾 ID сохранены: ${savedPath} (всего: ${ids.length})`);

      await this.page.goto(`${this.config.baseUrl}/groups`, { waitUntil: 'networkidle' });
    }
  }

  /**
   * Режим 2: выгрузка ID по спискам на /contacts/lists для текущего выбранного сообщества
   */
  private async parseListsMode(): Promise<void> {
    if (!this.page) throw new Error('Браузер не инициализирован');

    const defaultKeywords = ['в работе', 'отказ', 'одобрен', 'клик по офферу', 'клик по оффер', 'клик'];
    const filters = this.config.listFilters && this.config.listFilters.length > 0
      ? this.config.listFilters.map(s => s.toLowerCase())
      : defaultKeywords;

    console.log('📂 Переход на страницы списков контактов...');
    await this.page.goto(`${this.config.baseUrl}/contacts/lists`, { waitUntil: 'networkidle' });
    await this.page.waitForTimeout(500);

    // Собираем списки по якорям вида:
    // <a class="link-dark-primary" onclick="nav('/contacts/lists/1/<id>')"><h5>В работе</h5> ...</a>
    const allLists = await this.page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll('a.link-dark-primary[onclick*="/contacts/lists/"]')) as HTMLAnchorElement[];
      const items: { name: string; href: string }[] = [];

      anchors.forEach(a => {
        const onclick = a.getAttribute('onclick') || '';
        const m = onclick.match(/nav\('([^']+)'\)/);
        const href = m?.[1] || '';

        let name = '';
        const h5 = a.querySelector('h5');
        if (h5 && h5.textContent) name = h5.textContent.trim();
        if (!name && a.textContent) {
          const lines = a.textContent.split('\n').map(s => s.trim()).filter(Boolean);
          name = lines[0] || '';
        }

        if (name && href) items.push({ name, href });
      });

      const seen: Record<string, boolean> = {};
      return items.filter(it => {
        const key = it.name.toLowerCase();
        if (seen[key]) return false;
        seen[key] = true;
        return true;
      });
    });

    let targetLists = allLists.filter(l => {
      const low = l.name.toLowerCase();
      return filters.some(f => low.includes(f));
    });

    if (targetLists.length === 0) {
      console.log('⚠️ По фильтрам ничего не нашлось — берём все доступные списки');
      targetLists = allLists;
    }

    console.log(`🔎 Найдено списков по фильтру: ${targetLists.length}`);

    for (let i = 0; i < targetLists.length; i++) {
      const name = targetLists[i].name;
      console.log(`\n➡️  [${i + 1}/${targetLists.length}] Открываю список: ${name}`);

      const target = allLists.find(l => l.name === name);
      if (!target) {
        console.log('⚠️ Ссылка для списка не найдена — пропуск');
        continue;
      }

      await this.page.evaluate((href) => {
        if (typeof (window as any).nav === 'function') {
          (window as any).nav(href);
        } else {
          window.location.href = href;
        }
      }, target.href);

      await this.page.waitForLoadState('networkidle');
      await this.page.waitForTimeout(800);

      try {
        await this.page.waitForSelector('#followers-list-pagination, #followers-pagination', { timeout: 5000 });
      } catch {}

      const ids = await this.collectAllContactIds();
      const savedPath = await this.writeIdsFile(ids, `list_${name}`);
      console.log(`💾 ID сохранены: ${savedPath} (всего: ${ids.length})`);

      await this.page.goto(`${this.config.baseUrl}/contacts/lists`, { waitUntil: 'networkidle' });
      await this.page.waitForTimeout(800);
    }
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
    mode: (process.env.MODE as 'contacts' | 'groups' | 'lists') || 'contacts',
    listFilters: process.env.LISTS_FILTER
      ? process.env.LISTS_FILTER.split(',').map(s => s.trim()).filter(Boolean)
      : undefined,
    waitAfterSwitchMs: process.env.WAIT_AFTER_SWITCH_MS
      ? parseInt(process.env.WAIT_AFTER_SWITCH_MS)
      : undefined,
  });

  console.log('BotHunter VK Parser');
  console.log('==========================================\n');
  console.log('Настройки:');
  console.log(`   Headless: ${process.env.HEADLESS === 'true' ? 'Да' : 'Нет'}`);
  console.log(`   Режим: ${process.env.MODE || 'contacts'}`);
  console.log(`   Макс. страниц: ${process.env.MAX_PAGES || 'Все'}`);
  console.log(`   Путь сессии: ${process.env.SESSION_PATH || './browser-session'}`);
  console.log(`   Фильтры списков (через запятую): ${process.env.LISTS_FILTER || '(по умолчанию: В работе, Отказ, Одобрен, Клик...)'}`);
  console.log(`   Задержка после переключения (мс): ${process.env.WAIT_AFTER_SWITCH_MS || '3000'}`);
  console.log();

  try {
    await parser.parse();
  } catch (error) {
    console.error('CRITICAL ERROR:', error);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { BotHunterVKParser };
