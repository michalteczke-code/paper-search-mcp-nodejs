/**
 * Unpaywall API Integration
 *
 * Unpaywall to darmowa, w pełni legalna baza open-access wersji artykułów naukowych,
 * prowadzona przez OurResearch (non-profit). Dla danego DOI zwraca link do LEGALNIE
 * udostępnionej kopii — repozytorium instytucjonalne, strona wydawcy (open access/hybrid/
 * bronze), self-archived preprint autora itp. Nie omija żadnych paywalli ani zabezpieczeń
 * technicznych — jeśli artykuł nie ma legalnej otwartej wersji, zwraca informację o tym
 * (is_oa: false), zamiast próbować obejść zabezpieczenia.
 *
 * Wymaga podania adresu e-mail (parametr `email`) — to jedyny "klucz API": bezpłatny,
 * bez rejestracji, limit 100 000 zapytań/dzień.
 *
 * Dokumentacja: https://unpaywall.org/products/api
 * Endpoint DOI:    GET https://api.unpaywall.org/v2/{doi}?email=...
 * Endpoint search: GET https://api.unpaywall.org/v2/search?query=...&email=...&is_oa=true
 */

import axios, { AxiosInstance } from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { Paper, PaperFactory } from '../models/Paper.js';
import { PaperSource, SearchOptions, DownloadOptions, PlatformCapabilities } from './PaperSource.js';
import { sanitizeDoi } from '../utils/SecurityUtils.js';
import { TIMEOUTS, USER_AGENT, DEFAULT_MAILTO } from '../config/constants.js';
import { logDebug } from '../utils/Logger.js';
import { RateLimiter } from '../utils/RateLimiter.js';
import { ErrorHandler } from '../utils/ErrorHandler.js';
import { RequestCache } from '../utils/RequestCache.js';

interface UnpaywallLocation {
  url?: string;
  url_for_pdf?: string;
  url_for_landing_page?: string;
  host_type?: string;
  license?: string;
  version?: string;
  evidence?: string;
  is_best?: boolean;
  repository_institution?: string;
}

interface UnpaywallRecord {
  doi: string;
  doi_url?: string;
  title?: string;
  genre?: string;
  is_paratext?: boolean;
  published_date?: string;
  year?: number;
  journal_name?: string;
  journal_issns?: string;
  journal_is_oa?: boolean;
  publisher?: string;
  is_oa?: boolean;
  oa_status?: string;
  has_repository_copy?: boolean;
  z_authors?: Array<{ given?: string; family?: string }>;
  best_oa_location?: UnpaywallLocation | null;
  first_oa_location?: UnpaywallLocation | null;
  oa_locations?: UnpaywallLocation[];
}

export class UnpaywallSearcher extends PaperSource {
  private client: AxiosInstance;
  private email: string;
  private readonly rateLimiter: RateLimiter;
  private readonly cache: RequestCache<Paper[]>;

  constructor(email?: string) {
    super('unpaywall', 'https://api.unpaywall.org/v2', undefined);
    this.email = email || process.env.UNPAYWALL_EMAIL || process.env.CROSSREF_MAILTO || DEFAULT_MAILTO;

    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: TIMEOUTS.DEFAULT,
      headers: {
        Accept: 'application/json',
        'User-Agent': USER_AGENT
      }
    });

    // Limit Unpaywall: 100 000 zapytań/dzień — bardzo hojny, ale trzymamy konserwatywny rate limiter
    this.rateLimiter = new RateLimiter({
      requestsPerSecond: 3,
      burstCapacity: 5
    });

    this.cache = new RequestCache<Paper[]>({
      maxSize: 100,
      ttlMs: 3600000 // 1 godzina
    });
  }

  getCapabilities(): PlatformCapabilities {
    return {
      search: true,
      download: true,
      fullText: false,
      citations: false,
      requiresApiKey: false,
      supportedOptions: ['maxResults', 'year', 'openAccess']
    };
  }

  private cleanAndValidateDoi(doi: string): string | null {
    const result = sanitizeDoi(doi);
    return result.valid ? result.sanitized : null;
  }

  /**
   * Wyszukiwanie tekstowe (endpoint /search) — dopasowanie po tytule/treści, wynik
   * posortowany wg trafności. Domyślnie TYLKO wyniki open access (is_oa=true), bo po to
   * jest ten searcher — żeby znaleźć legalnie dostępną kopię. Ustaw options.openAccess
   * = false, żeby zobaczyć też artykuły bez znanej otwartej wersji.
   */
  async search(query: string, options: SearchOptions = {}): Promise<Paper[]> {
    const customOptions = options as any;
    const forceRefresh = customOptions.forceRefresh === true;

    if (!forceRefresh) {
      const cacheKey = this.cache.generateKey('unpaywall', query, options);
      const cached = this.cache.get(cacheKey);
      if (cached) return cached;
    }

    const maxResults = Math.min(options.maxResults || 10, 50);
    const isOa = options.openAccess !== false;

    const params: Record<string, any> = {
      query,
      email: this.email,
      is_oa: isOa
    };

    try {
      await this.rateLimiter.waitForPermission();

      const response = await ErrorHandler.retryWithBackoff(
        () => this.client.get('/search', { params }),
        { context: 'Unpaywall search' }
      );

      let results: any[] = response.data?.results || [];

      // Endpoint /search nie wspiera filtrowania wg roku — filtrujemy po stronie klienta
      if (options.year) {
        const yearMatch = options.year.match(/^(\d{4})(?:-(\d{4})?)?$/);
        if (yearMatch) {
          const startYear = parseInt(yearMatch[1] as string, 10);
          const endYear = yearMatch[2] ? parseInt(yearMatch[2], 10) : startYear;
          results = results.filter(r => {
            const y = r.response?.year;
            return typeof y === 'number' && y >= startYear && y <= endYear;
          });
        }
      }

      const papers = results
        .slice(0, maxResults)
        .map(r => this.parsePaper(r.response, r.snippet, r.score))
        .filter((p): p is Paper => p !== null);

      const cacheKey = this.cache.generateKey('unpaywall', query, options);
      this.cache.set(cacheKey, papers);

      return papers;
    } catch (error: any) {
      this.handleHttpError(error, 'search');
    }
  }

  async getPaperByDoi(doi: string): Promise<Paper | null> {
    const cleanDoi = this.cleanAndValidateDoi(doi);
    if (!cleanDoi) return null;

    try {
      const record = await this.fetchRecord(cleanDoi);
      return record ? this.parsePaper(record) : null;
    } catch (error: any) {
      this.handleHttpError(error, 'getPaperByDoi');
      return null;
    }
  }

  /**
   * Pobiera PDF z NAJLEPSZEJ legalnie udostępnionej lokalizacji (best_oa_location).
   * Jeśli Unpaywall nie zna żadnej otwartej wersji (is_oa=false) albo zna tylko stronę
   * wydawcy/repozytorium bez bezpośredniego linku do PDF, rzuca czytelny błąd zamiast
   * próbować cokolwiek obchodzić.
   */
  async downloadPdf(doi: string, options: DownloadOptions = {}): Promise<string> {
    const cleanDoi = this.cleanAndValidateDoi(doi);
    if (!cleanDoi) {
      throw new Error(`Nieprawidłowy format DOI: ${doi}`);
    }

    const record = await this.fetchRecord(cleanDoi);
    if (!record) {
      throw new Error(`Unpaywall nie znalazł rekordu dla DOI: ${cleanDoi}`);
    }
    if (!record.is_oa || !record.best_oa_location) {
      throw new Error(
        `Brak legalnie dostępnej wersji open-access dla DOI ${cleanDoi} ` +
          `(oa_status: ${record.oa_status || 'closed'}). Artykuł jest prawdopodobnie tylko za paywallem wydawcy.`
      );
    }

    const loc = record.best_oa_location;
    const pdfUrl = loc.url_for_pdf || (record.oa_locations || []).find(l => l.url_for_pdf)?.url_for_pdf;

    if (!pdfUrl) {
      throw new Error(
        `Unpaywall zna open-access lokalizację, ale bez bezpośredniego linku do PDF. ` +
          `Otwórz ręcznie: ${loc.url_for_landing_page || loc.url}`
      );
    }

    const savePath = options.savePath || './downloads';
    if (!fs.existsSync(savePath)) {
      fs.mkdirSync(savePath, { recursive: true });
    }

    const fileName = `${cleanDoi.replace(/[/\\:*?"<>|]/g, '_')}.pdf`;
    const filePath = path.join(savePath, fileName);

    if (fs.existsSync(filePath) && !options.overwrite) {
      return filePath;
    }

    await this.rateLimiter.waitForPermission();

    const response = await ErrorHandler.retryWithBackoff(
      () =>
        axios.get(pdfUrl as string, {
          responseType: 'stream',
          timeout: TIMEOUTS.DOWNLOAD,
          headers: { 'User-Agent': USER_AGENT }
        }),
      { context: 'Unpaywall PDF download' }
    );

    const writer = fs.createWriteStream(filePath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', () => resolve(filePath));
      writer.on('error', reject);
    });
  }

  /**
   * Unpaywall nie parsuje pełnego tekstu — tylko linkuje do legalnej kopii.
   * Ekstrakcja treści odbywa się w slr-app (AI-ekstrakcja z PDF) po pobraniu pliku.
   */
  async readPaper(paperId: string, options: DownloadOptions = {}): Promise<string> {
    throw new Error(
      'Unpaywall nie udostępnia własnej ekstrakcji pełnego tekstu — pobierz PDF (downloadPdf), ' +
        'a następnie użyj funkcji AI-ekstrakcji z PDF w slr-app.'
    );
  }

  private async fetchRecord(cleanDoi: string): Promise<UnpaywallRecord | null> {
    try {
      const encodedDoi = encodeURIComponent(cleanDoi);
      await this.rateLimiter.waitForPermission();
      const response = await ErrorHandler.retryWithBackoff(
        () => this.client.get(`/${encodedDoi}`, { params: { email: this.email } }),
        { context: 'Unpaywall fetchRecord' }
      );
      return response.data || null;
    } catch (error: any) {
      if (error?.response?.status === 404) return null;
      throw error;
    }
  }

  private parsePaper(data: UnpaywallRecord | undefined, snippet?: string, score?: number): Paper | null {
    if (!data || !data.doi) return null;
    try {
      const authors = (data.z_authors || [])
        .map(a => `${a.given || ''} ${a.family || ''}`.trim())
        .filter(Boolean);

      const publishedDate = data.published_date ? this.parseDate(data.published_date) : null;
      const loc = data.best_oa_location;

      return PaperFactory.create({
        paperId: data.doi,
        title: data.title || 'No title',
        authors,
        abstract: snippet ? this.cleanText(snippet.replace(/<\/?b>/g, '')) : '',
        source: 'unpaywall',
        publishedDate,
        year: data.year,
        journal: data.journal_name,
        doi: data.doi,
        url: data.doi_url || `https://doi.org/${data.doi}`,
        pdfUrl: loc?.url_for_pdf || '',
        extra: {
          isOa: data.is_oa || false,
          oaStatus: data.oa_status || 'closed',
          publisher: data.publisher || '',
          bestOaLocation: loc || null,
          oaLocationsCount: (data.oa_locations || []).length,
          score: score,
          license: loc?.license || null,
          hostType: loc?.host_type || null
        }
      });
    } catch (error: any) {
      logDebug('Error parsing Unpaywall paper:', error.message);
      return null;
    }
  }
}
