import { chromium, type Browser, type Page, type Locator } from 'playwright';
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
  /** Режим работы парсера: contacts (по умолчанию) | groups | lists | new-subs */
  mode?: 'contacts' | 'groups' | 'lists' | 'new-subs';
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
      } else if (mode === 'new-subs') {
        await this.parseNewSubsMode();
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
   * Возвращает локатор кнопки «следующая страница» для разных типов пагинации.
   * В new-subs «next» имеет класс `.rounded-circle`, в других местах — просто второй `.pagination-btn`.
   * Ждём, пока кнопка станет доступной (не disabled), в пределах timeoutMs.
   */
  private async waitForNextPageButton(timeoutMs = 2500): Promise<Locator | null> {
    if (!this.page) throw new Error('Браузер не инициализирован');

    // enabled-кандидаты (в порядке приоритета)
    const enabled = this.page.locator([
      // new-subs: круглая кнопка справа
      '#followers-pagination div.d-flex > button.pagination-btn.rounded-circle:not([disabled])',
      // запасной путь: последний .pagination-btn в правом блоке
      '#followers-pagination div.d-flex > button.pagination-btn:last-of-type:not([disabled])',
      // общий случай: «не .me-1» (левая обычно prev с .me-1)
      '#followers-pagination .pagination-btn:not(.me-1):not([disabled])',
      '#followers-list-pagination .pagination-btn:not(.me-1):not([disabled])',
    ].join(', '));

    // любые «next» (могут быть disabled) — чтобы понимать, что DOM уже дорисовался
    const any = this.page.locator([
      '#followers-pagination div.d-flex > button.pagination-btn.rounded-circle',
      '#followers-pagination div.d-flex > button.pagination-btn:last-of-type',
      '#followers-pagination .pagination-btn:not(.me-1)',
      '#followers-list-pagination .pagination-btn:not(.me-1)',
    ].join(', '));

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await enabled.count()) return enabled.first();
      // Если кнопка существует, но disabled — ждём, пока её активирует сервер
      if (await any.count()) {
        await this.page.waitForTimeout(500);
        continue;
      }
      // Кнопки ещё вовсе нет — даём UI смонтироваться
      await this.page.waitForTimeout(500);
    }
    return null;
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

    await this.page!.waitForLoadState('networkidle').catch(() => {});
    const firstReady = await this.waitForAnyUsers(20000);
    if (!firstReady) {
      console.log('⏳ Результаты ещё не прогрузились — добавляю небольшую паузу');
      await this.page!.waitForTimeout(1500);
    }

    while (currentPage <= maxPages) {
      console.log(`\n📄 Обработка страницы ${currentPage}...`);

      const pageIds = await this.extractUserIds();
      console.log(`   Найдено ID: ${pageIds.length}`);
      pageIds.forEach(id => this.userIds.add(id));

      // Ждём доступную кнопку «вперёд» (учитываем разную разметку пагинации)
      const nextEnableWait = parseInt(process.env.NEXT_ENABLE_WAIT_MS || '4000');
      const nextLocator = await this.waitForNextPageButton(nextEnableWait);
      if (!nextLocator) {
        console.log('⚠️ Кнопка следующей страницы не найдена или не активировалась');
        break;
      }

      await nextLocator.scrollIntoViewIfNeeded().catch(() => {});
      await nextLocator.click({ timeout: 10000 }).catch(() => {});
      await this.page!.waitForLoadState('networkidle').catch(() => {});
      await this.delay(6000, 8000);

      currentPage++;
    }

    return Array.from(this.userIds);
  }

  /**
   * Дожидается, что текущий URL содержит фрагмент (например, '/contacts')
   */
  private async waitUrlIncludes(fragment: string, timeoutMs = 60000): Promise<boolean> {
    if (!this.page) throw new Error('Браузер не инициализирован');
    try {
      await this.page.waitForFunction((frag) => location.pathname.includes(frag), fragment, { timeout: timeoutMs });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Надёжно открывает страницу контактов без зависания на networkidle
   */
  private async openContactsPage(timeoutMs = 60000): Promise<void> {
    if (!this.page) throw new Error('Браузер не инициализирован');

    const url = this.page.url();
    if (!url.includes('/contacts')) {
      await this.page.goto(`${this.config.baseUrl}/contacts`, { waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch(() => {});
    }

    await this.page.waitForSelector('#followers-pagination, #followers-list-pagination, button:has-text("Показать"), #filters-items', { timeout: timeoutMs }).catch(() => {});
    await this.page.waitForTimeout(800);
  }

  /**
   * Надёжно открывает страницу сообществ без зависания на networkidle
   */
  private async openGroupsPage(timeoutMs = 60000): Promise<void> {
    if (!this.page) throw new Error('Браузер не инициализирован');

    const url = this.page.url();
    if (!url.includes('/groups')) {
      await this.page.goto(`${this.config.baseUrl}/groups`, { waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch(() => {});
    }

    await this.page.waitForSelector('a[onclick*="change_group_with_channel"]', { timeout: timeoutMs }).catch(() => {});
    await this.page.waitForTimeout(500);
  }

  /**
   * Режим 1: выгрузка ID для КАЖДОГО сообщества со страницы /groups
   */
  private async parseGroupsMode(): Promise<void> {
    if (!this.page) throw new Error('Браузер не инициализирован');

    const waitMs = this.config.waitAfterSwitchMs ?? 3000;

    console.log('📂 Переход на список сообществ...');
    await this.openGroupsPage(6000);

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
          const smm = (window as any).smm;
          // Call with proper "this" binding; some implementations rely on `this.group_change`
          if (smm && typeof smm.change_group_with_channel === 'function') {
            smm.change_group_with_channel.call(smm, id, 'VK');
            return;
          }
          // Fallback: try global SMM singleton if present
          const SMM = (window as any).SMM;
          if (SMM && typeof SMM.change_group_with_channel === 'function') {
            SMM.change_group_with_channel.call(SMM, id, 'VK');
            return;
          }
          // Last resort: click the anchor that triggers the change
          const a = document.querySelector(
            `a[onclick*="change_group_with_channel('${id}'"]`
          ) as HTMLAnchorElement | null;
          if (a) a.click();
        }, g.id);
      }

      await this.delay(waitMs, waitMs + 500);

      console.log('📋 Открываем контакты выбранного сообщества...');
      await this.openContactsPage(3000);

      const ids = await this.collectAllContactIds();
      const savedPath = await this.writeIdsFile(ids, `group_${g.name || g.id}`);
      console.log(`💾 ID сохранены: ${savedPath} (всего: ${ids.length})`);

      await this.openGroupsPage(10000);
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

  /** Форматирование даты как dd.MM.yyyy */
  private formatDateDDMMYYYY(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
  }

  /**
   * Ожидаем готовность результатов после «Показать»:
   *  - либо стабилизировалось ненулевое число ID в DOM,
   *  - (опционально) разрешаем ранний выход по появлению пагинации.
   */
  private async waitForAnyUsers(
    maxWaitMs: number,
    opts?: { minStableMs?: number; allowPaginationShortcut?: boolean; requireMinCount?: number }
  ): Promise<boolean> {
    const minStableMs = opts?.minStableMs ?? 2000;
    const allowPaginationShortcut = opts?.allowPaginationShortcut ?? true;
    const requireMinCount = opts?.requireMinCount ?? 1;

    const start = Date.now();
    let lastCount = -1;
    let lastChangeTs = Date.now();

    while (Date.now() - start < maxWaitMs) {
      try {
        if (allowPaginationShortcut) {
          const hasPagination = await this.page!.$('#followers-list-pagination, #followers-pagination');
          if (hasPagination) {
            // В некоторых режимах пагинация появляется раньше данных — этот шорткат можно отключить через opts
            return true;
          }
        }

        const ids = await this.extractUserIds();
        const count = ids.length;
        if (count !== lastCount) {
          lastCount = count;
          lastChangeTs = Date.now();
        }
        if (count >= requireMinCount && Date.now() - lastChangeTs >= minStableMs) {
          return true;
        }
      } catch {}
      await this.page!.waitForTimeout(500);
    }
    return false;
  }

  /** Нажимает «Показать», ждёт по строгим правилам и делает ретраи */
  private async clickShowAndWaitWithRetries(
    retries = 5,
    waitMs = 30000,
    waitOpts?: { minStableMs?: number; allowPaginationShortcut?: boolean; requireMinCount?: number },
    postReadyDelayMs?: number
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= retries; attempt++) {
      const showBtn = this.page!.locator('button:has-text("Показать")').first();
      await showBtn.waitFor({ state: 'visible', timeout: 10000 });
      await showBtn.click();
      await this.page!.waitForTimeout(150);
      await this.page!.waitForLoadState('networkidle').catch(() => {});
      const ok = await this.waitForAnyUsers(waitMs, waitOpts);
      if (ok) {
        // пост-стабилизация, по умолчанию короткая; для new-subs можем передать 30–40с
        await this.page!.waitForTimeout(postReadyDelayMs ?? 500);
        return true;
      }
      console.log(`⏳ Пользователи не прогрузились, ретрай ${attempt}/${retries}...`);
    }
    return false;
  }

  /**
   * Гарантирует, что Select2 для выбора бота открыт и виден список результатов.
   * Если список закрылся (или ещё не открылся) — повторно кликает и «подталкивает» клавишей ArrowDown.
   */
  private async ensureSelect2Open(selection: Locator, maxAttempts = 5): Promise<void> {
    if (!this.page) throw new Error('Браузер не инициализирован');

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const isOpen = await this.page.evaluate(() => {
        const openContainer = document.querySelector('span.select2-container--open');
        const ul = document.querySelector(
          'ul[id^="select2-bot_id-"][id$="-results"][role="tree"]'
        ) as HTMLElement | null;
        const resultsVisible = !!ul && ul.getAttribute('aria-hidden') !== 'true' && ul.offsetParent !== null;
        return !!openContainer && resultsVisible;
      });

      if (isOpen) return; // уже открыт

      // Пробуем открыть: скролл к элементу, клик по нему и «стрелка вниз» на случай, если Select2 ждёт клавиатуру
      await selection.scrollIntoViewIfNeeded().catch(() => {});
      await selection.click({ timeout: 2000 }).catch(() => {});
      await this.page.waitForTimeout(80);
      await selection.press('ArrowDown').catch(() => {});
      await this.page.waitForTimeout(150);
    }

    // Финальная проверка
    const finallyOpen = await this.page.evaluate(() => !!document.querySelector('span.select2-container--open'));
    if (!finallyOpen) throw new Error('Не удалось открыть выпадающий список Select2 для выбора бота.');
  }

  /**
   * Режим new-subs:
   * - /groups -> по каждому сообществу
   * - /contacts -> «Добавить фильтр» -> «Завершили шаг в боте»
   * - ставим "вчера" в От/До
   * - перебираем всех ботов из группы «Активные»
   * - выбираем шаг, содержащий «(начало)»
   * - Показать -> ждём (с ретраями) -> собираем ID с пагинацией
   * - сохраняем один txt на сообщество
   */
  private async parseNewSubsMode(): Promise<void> {
    if (!this.page) throw new Error('Браузер не инициализирован');

    const waitMsAfterSwitch = this.config.waitAfterSwitchMs ?? 3000;

    console.log('📂 Переход на список сообществ...');
    await this.openGroupsPage(6000);

    // Сбор сообществ (как в parseGroupsMode)
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
      console.log(`\\n➡️  [${i + 1}/${groups.length}] Переключаюсь на: ${g.name || g.id} (#${g.id})`);

      const switchCandidate = this.page
        .locator(`a.btn.btn-light[onclick*="${g.id}"], a.width-adaptive[onclick*="${g.id}"], a.d-flex[onclick*="${g.id}"]`)
        .first();

      if (await switchCandidate.count()) {
        await switchCandidate.click();
      } else {
        await this.page.evaluate((id) => {
          const smm = (window as any).smm;
          if (smm && typeof smm.change_group_with_channel === 'function') {
            smm.change_group_with_channel.call(smm, id, 'VK');
            return;
          }
          const SMM = (window as any).SMM;
          if (SMM && typeof SMM.change_group_with_channel === 'function') {
            SMM.change_group_with_channel.call(SMM, id, 'VK');
            return;
          }
          const a = document.querySelector(
            `a[onclick*="change_group_with_channel('${id}'"]`
          ) as HTMLAnchorElement | null;
          if (a) a.click();
        }, g.id);
      }

      // Устойчивость после смены сообщества (SPA может перерисовать DOM)
      await this.page.waitForLoadState('domcontentloaded').catch(() => {});
      await this.delay(waitMsAfterSwitch, waitMsAfterSwitch + 500);

      console.log('📋 Открываем контакты выбранного сообщества...');
      await this.openContactsPage(6000);

      // 1) Ждём 5–6 секунд и жмём «Добавить фильтр»
      await this.page.waitForTimeout(5500);
      const addFilterBtn = this.page
        .locator('button.link_filter:has-text("Добавить фильтр"), button:has-text("Добавить фильтр")')
        .first();

      if (await addFilterBtn.count()) {
        await addFilterBtn.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
        await addFilterBtn.click();
        await this.page.waitForSelector('.filter-list, .dropdown-menu.filter-list, .filter-list-group-item', { timeout: 10000 });
        const filterOption = this.page
          .locator('#filter_elem_30, .filter-list-group-item:has-text("Завершили шаг в боте")')
          .first();
        if (!(await filterOption.count())) throw new Error('Пункт «Завершили шаг в боте» не найден');
        await filterOption.click();
      } else {
        console.log('⚠️ Кнопка «Добавить фильтр» не найдена — продолжаю без неё (попытка применить фильтр могла быть до этого)');
      }

      // 2) Ставим «вчера» в От и До
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const y = this.formatDateDDMMYYYY(yesterday);

      await this.page.waitForSelector('#filters-items, form#line_flex, form.line_flex', { timeout: 10000 }).catch(() => {});
      await this.page.evaluate(function(fromTo) {
        var selectors = ['input.bot_step_id_date_from', 'input.bot_step_id_date_to'];
        var set = 0;
        for (var i = 0; i < selectors.length; i++) {
          var el = document.querySelector(selectors[i]);
          if (el) {
            (el as HTMLInputElement).value = fromTo as string;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            set++;
          }
        }
        if (set < 2) {
          var form = (document.querySelector('#filters-items') || document);
          var inputs = Array.prototype.slice.call(form.querySelectorAll('input'));
          var candidates = inputs.filter(function(i) { return /date|datepicker/i.test(i.className); });
          if (candidates[0]) {
            (candidates[0] as HTMLInputElement).value = fromTo as string;
            (candidates[0] as HTMLInputElement).dispatchEvent(new Event('input', { bubbles: true }));
            (candidates[0] as HTMLInputElement).dispatchEvent(new Event('change', { bubbles: true }));
          }
          if (candidates[1]) {
            (candidates[1] as HTMLInputElement).value = fromTo as string;
            (candidates[1] as HTMLInputElement).dispatchEvent(new Event('input', { bubbles: true }));
            (candidates[1] as HTMLInputElement).dispatchEvent(new Event('change', { bubbles: true }));
          }
        }
      }, y);

      // 3) Собираем всех ботов в группе «Активные»
      // Таргетим конкретно Select2, который связан с <select name="bot_id">,
      // чтобы не перепутать с селектом шагов (multiple)
      const botSelect = this.page
        .locator('select[name="bot_id"] + span.select2 .select2-selection.select2-selection--single')
        .first();
      await this.ensureSelect2Open(botSelect);

      const activeBotNames = await this.page.evaluate(function() {
        // приоритет — явный UL с id select2-bot_id-*-results
        const explicit =
          (document.querySelector('ul[id^="select2-bot_id-"][id$="-results"][role="tree"][aria-hidden="false"]') as HTMLElement | null) ||
          (document.querySelector('ul[id^="select2-bot_id-"][id$="-results"][role="tree"]') as HTMLElement | null);

        const root =
          explicit ||
          (document.querySelector('span.select2-container--open ul.select2-results__options[role="tree"]') as HTMLElement | null);
        if (!root) return [] as string[];

        // Ищем группу «Активные»
        let group = root.querySelector('li.select2-results__option[role="group"][aria-label="Активные"]') as HTMLElement | null;
        if (!group) {
          const headers = Array.prototype.slice.call(
            root.querySelectorAll('li.select2-results__option[role="group"] .select2-results__group')
          ) as HTMLElement[];
          const header = headers.find(h => (h.textContent || '').trim() === 'Активные') || null;
          group = header ? (header.closest('li.select2-results__option[role="group"]') as HTMLElement) : null;
        }
        if (!group) return [] as string[];

        let nested = group.querySelector('ul.select2-results__options.select2-results__options--nested') as HTMLElement | null;
        if (!nested) {
          const header = group.querySelector('.select2-results__group') as HTMLElement | null;
          header?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          header?.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true }));
          header?.dispatchEvent(new MouseEvent('click',     { bubbles: true }));
          nested = group.querySelector('ul.select2-results__options.select2-results__options--nested') as HTMLElement | null;
        }

        const items = nested
          ? Array.prototype.slice.call(nested.querySelectorAll('li.select2-results__option[role="treeitem"]'))
          : [];
        return items.map(i => (i.textContent || '').trim()).filter(Boolean);
      });

      // Небольшая пауза — даём времени дорендерить вложенные группы
      await this.page.waitForTimeout(3000);

      if (!activeBotNames || activeBotNames.length === 0) {
        console.log('⚠️ В «Активные» ботов нет — пропускаю сообщество');
        await this.openGroupsPage(2334);
        continue;
      }

      console.log(`🧩 Активных ботов: ${activeBotNames.length}`);
      const groupIds = new Set<string>();

      for (let b = 0; b < activeBotNames.length; b++) {
        const botName = activeBotNames[b];
        console.log(`   → Бот [${b + 1}/${activeBotNames.length}]: ${botName}`);

        // Выбрать бота (открыть селект и кликнуть пункт внутри открытого контейнера)
        await this.ensureSelect2Open(botSelect);

        // Предпочтительно использовать конкретный UL с id select2-bot_id-*-results внизу body
        let rootLocator = this.page
          .locator('ul[id^="select2-bot_id-"][id$="-results"][role="tree"][aria-hidden="false"]')
          .first();
        if (!(await rootLocator.count())) {
          rootLocator = this.page
            .locator('ul[id^="select2-bot_id-"][id$="-results"][role="tree"]')
            .first();
        }
        if (!(await rootLocator.count())) {
          rootLocator = this.page
            .locator('span.select2-container--open ul.select2-results__options[role="tree"]')
            .first();
        }

        // Группа «Активные»: сначала по aria-label, затем по тексту заголовка
        let groupLocator = rootLocator
          .locator('> li.select2-results__option[role="group"][aria-label="Активные"]')
          .first();

        if (!(await groupLocator.count())) {
          groupLocator = rootLocator
            .locator('> li.select2-results__option[role="group"]')
            .filter({ has: this.page.locator('.select2-results__group', { hasText: 'Активные' }) })
            .first();
        }

        let nestedLocator = groupLocator.locator('ul.select2-results__options.select2-results__options--nested');
        if (!(await nestedLocator.count())) {
          // Если дропдаун внезапно закрылся — переоткроем его
          await this.ensureSelect2Open(botSelect);
          await groupLocator.scrollIntoViewIfNeeded().catch(() => {});
          for (let tries = 0; tries < 3; tries++) {
            if (await nestedLocator.count()) break;
            const header = groupLocator.locator('.select2-results__group').first();
            await header.scrollIntoViewIfNeeded().catch(() => {});
            await header.click({ timeout: 1000, force: true }).catch(() => {});
            await this.page.waitForTimeout(120);
            nestedLocator = groupLocator.locator('ul.select2-results__options.select2-results__options--nested');
          }
        }

        const botItem = nestedLocator
          .locator('li.select2-results__option[role="treeitem"]', { hasText: botName })
          .first();

        await botItem.waitFor({ state: 'visible', timeout: 2500 }).catch(() => {});
        await botItem.scrollIntoViewIfNeeded().catch(() => {});
        await this.page.waitForTimeout(60);
        await botItem.click({ timeout: 5000 }).catch(() => {});
        // даём селекту применить выбор
        await this.page.waitForTimeout(80);
        await this.page
          .locator('select[name="bot_id"] + span .select2-selection__rendered')
          .filter({ hasText: botName })
          .first()
          .waitFor({ state: 'visible', timeout: 1500 })
          .catch(() => {});
        await this.page.waitForTimeout(150);

        // Выбрать шаг со строкой «(начало)»
        const stepSelect = this.page.locator('.select_wrap.step-list .select2-selection').first();
        await stepSelect.scrollIntoViewIfNeeded().catch(() => {});
        await stepSelect.click({ timeout: 8000 }).catch(() => {});
        await this.page.waitForTimeout(80);
        await this.page
          .waitForSelector('ul#select2-done_bot_step-results, .select2-results__options', { timeout: 4000 })
          .catch(() => {});
        await this.page
          .waitForFunction(() => !!document.querySelector('li.select2-results__option'), { timeout: 2000 })
          .catch(() => {});
        const stepItem = this.page.locator('li.select2-results__option', { hasText: '(начало)' }).first();
        await stepItem.waitFor({ state: 'visible', timeout: 2500 }).catch(() => {});
        await stepItem.scrollIntoViewIfNeeded().catch(() => {});
        await this.page.waitForTimeout(60);
        await stepItem.click({ timeout: 5000 }).catch(() => {});
        // коротко убеждаемся, что шаг применился
        await this.page
          .locator('.select_wrap.step-list .select2-selection__rendered')
          .filter({ hasText: '(начало)' })
          .first()
          .waitFor({ state: 'visible', timeout: 1500 })
          .catch(() => {});
        await this.page.waitForTimeout(150);

        // Показать + ожидание с ретраями (строгий, медленный режим)
        const newSubsWaitMs = parseInt(process.env.NEW_SUBS_WAIT_MS || '45000');
        const newSubsPostDelayMs = parseInt(process.env.NEW_SUBS_POST_READY_DELAY_MS || '35000');
        const loaded = await this.clickShowAndWaitWithRetries(
          5,
          newSubsWaitMs,
          { allowPaginationShortcut: false, minStableMs: 3000, requireMinCount: 1 },
          newSubsPostDelayMs
        );
        if (!loaded) {
          console.log('   ⚠️ Не удалось загрузить пользователей — пропуск бота');
          continue;
        }

        // Пагинация и сбор ID
        const ids = await this.collectAllContactIds();
        ids.forEach(id => groupIds.add(id));
        console.log(`   ✅ Собрано ID: ${ids.length}`);
      }

      // Итог по сообществу: объединённый txt
      const savedPath = await this.writeIdsFile(Array.from(groupIds), `newsubs_group_${g.name || g.id}`);
      console.log(`💾 ID сохранены: ${savedPath} (уникальных: ${groupIds.size})`);

      // Назад к списку сообществ
      await this.openGroupsPage(6000);
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
    mode: (process.env.MODE as 'contacts' | 'groups' | 'lists' | 'new-subs') || 'contacts',
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
