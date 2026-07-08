/**
 * OpenAlex Searcher
 *
 * OpenAlex to w pełni otwarta (CC0), darmowa baza publikacji naukowych prowadzona
 * przez OurResearch — jawnie pozycjonowana jako otwarta alternatywa dla Scopusa/WoS.
 * W przeciwieństwie do Scopus/ScienceDirect (Elsevier) i Web of Science (Clarivate),
 * OpenAlex NIE ma żadnej koncepcji licencji instytucjonalnej ani "redistribution" —
 * dzielenie jednego klucza między wielu userów tej appki jest w pełni zgodne z ich
 * modelem (patrz https://openscholarlyinfrastructure.org/, cytowane w ich docs: "we
 * sell services, not data"). Dlatego, w odróżnieniu od Scopus/SD, ten searcher używa
 * WSPÓLNEGO klucza server-side (ustalenie z Michałem, 08.07.2026, task #33) — nie BYOK.
 *
 * WAŻNA ZMIANA (research 08.07.2026): od 13.02.2026 OpenAlex wymaga klucza API do
 * realnego użycia. Bez klucza: $0.10/dzień (tylko testy). Z darmowym kluczem (rejestracja
 * 30 sekund na openalex.org/settings/api): $1/dzień ≈ 1000 wyszukiwań full-text. To
 * prawdziwy, choć mały, koszt cykliczny — nie ryzyko prawne, ale realny budżet dzielony
 * między wszystkich userów appki.
 *
 * Dokumentacja: https://developers.openalex.org/
 * Search:      https://developers.openalex.org/guides/searching
 * Auth/pricing: https://developers.openalex.org/api-reference/authentication
 *
 * Endpoint: GET https://api.openalex.org/works?search=...&api_key=...
 *
 * Składnia zapytań (parametr `search`, NIE przestarzały `filter=title.search:`):
 * - Boolean: AND / OR / NOT, WIELKIMI literami (małe litery nie działają jako operatory).
 * - Frazy w cudzysłowie: "climate change".
 * - Słowa bez operatora między nimi = domyślnie AND.
 * - WILDCARDY ('*', '?') NIE działają w domyślnym (stemowanym) `search=` — zwraca 400.
 *   Wymagają `search.exact` (bez stemowania), którego tu nie używamy — więc, dokładnie
 *   jak przy ScienceDirect (task #25), zapytania dla OpenAlex NIE MOGĄ zawierać '*'.
 *   Stemowanie domyślnego `search=` i tak łapie liczbę mnogą/odmiany ("possums" → "possum"),
 *   więc w praktyce pełni podobną rolę co wildcard gdzie indziej.
 * - Limit URL ~4KB — bardzo długie zapytania z wieloma synonimami (OR) mogą go przekroczyć
 *   i dostać 400 "Request URL too long". Nie implementujemy tu automatycznego dzielenia
 *   zapytania (jak sugeruje ich dokumentacja) — jeśli to się okaże realnym problemem przy
 *   żywym użyciu, do zrobienia w kolejnej iteracji.
 */

import axios, { AxiosInstance } from 'axios';
import { withTimeout } from '../utils/SecurityUtils.js';
import { PaperSource, SearchOptions, DownloadOptions, PlatformCapabilities } from './PaperSource.js';
import { Paper, PaperFactory } from '../models/Paper.js';
import { RateLimiter } from '../utils/RateLimiter.js';
import { logDebug } from '../utils/Logger.js';
import { TIMEOUTS, USER_AGENT, DEFAULT_MAILTO } from '../config/constants.js';

interface OpenAlexAuthorship {
  author?: { display_name?: string };
  raw_author_name?: string;
}

interface OpenAlexLocation {
  source?: { display_name?: string };
  landing_page_url?: string;
  pdf_url?: string;
  is_oa?: boolean;
}

interface OpenAlexWork {
  id: string;
  doi?: string | null;
  title?: string | null;
  display_name?: string | null;
  publication_year?: number | null;
  publication_date?: string | null;
  authorships?: OpenAlexAuthorship[];
  primary_location?: OpenAlexLocation | null;
  best_oa_location?: OpenAlexLocation | null;
  open_access?: { is_oa?: boolean; oa_url?: string | null };
  cited_by_count?: number;
  abstract_inverted_index?: Record<string, number[]> | null;
  type?: string;
}

interface OpenAlexResponse {
  meta?: { count?: number; per_page?: number; page?: number };
  results?: OpenAlexWork[];
}

export class OpenAlexSearcher extends PaperSource {
  private client: AxiosInstance;
  private mailto: string;
  private readonly rateLimiter: RateLimiter;
  public lastTotalResults: number = 0;

  constructor(apiKey?: string, mailto?: string) {
    super('openalex', 'https://api.openalex.org', apiKey);
    this.mailto = mailto || process.env.OPENALEX_MAILTO || DEFAULT_MAILTO;

    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: TIMEOUTS.DEFAULT,
      headers: {
        Accept: 'application/json',
        'User-Agent': USER_AGENT
      }
    });

    // OpenAlex pozwala na 100 req/s — trzymamy się bardzo konserwatywnie poniżej tego,
    // bo prawdziwym limitem, który nas interesuje, jest budżet $/dzień na kluczu, nie
    // tempo zapytań. Ten rate limiter chroni tylko przed przypadkowym burst-em.
    this.rateLimiter = new RateLimiter({
      requestsPerSecond: 3,
      burstCapacity: 5
    });
  }

  getCapabilities(): PlatformCapabilities {
    return {
      search: true,
      download: false, // OpenAlex nie hostuje PDF-ów bezpośrednio — Unpaywall/Crossref już to pokrywają w tej appce
      fullText: false,
      citations: false,
      requiresApiKey: true,
      supportedOptions: ['maxResults', 'year']
    };
  }

  async search(query: string, options: SearchOptions = {}): Promise<Paper[]> {
    if (!this.apiKey) {
      throw new Error(
        'OpenAlex API key is required (od 13.02.2026 — bez klucza budżet $0.10/dzień to za mało na realne użycie). ' +
          'Darmowa rejestracja: https://openalex.org/settings/api'
      );
    }

    const maxResults = Math.min(options.maxResults || 25, 100);
    const params: Record<string, any> = {
      search: query,
      api_key: this.apiKey,
      mailto: this.mailto,
      per_page: maxResults,
      page: 1
    };

    if (options.year) {
      // "2023" -> publication_year:2023 ; "2020-2023" -> publication_year:2020-2023
      // (OpenAlex wspiera zakresy w tej formie dla pól numerycznych we `filter`)
      params.filter = `publication_year:${options.year}`;
    }

    try {
      await this.rateLimiter.waitForPermission();

      const response = await withTimeout(
        this.client.get<OpenAlexResponse>('/works', { params }),
        TIMEOUTS.DEFAULT + TIMEOUTS.BUFFER,
        'OpenAlex search timed out'
      );

      this.lastTotalResults = response.data?.meta?.count || 0;
      const results = response.data?.results || [];

      return results
        .map(w => this.parseWork(w))
        .filter((p): p is Paper => p !== null);
    } catch (error: any) {
      if (error.response?.status === 400) {
        const msg = error.response?.data?.message || error.response?.data?.error || 'Bad request';
        throw new Error(`OpenAlex: zapytanie odrzucone (400) — ${msg}`);
      }
      this.handleHttpError(error, 'search');
    }
  }

  /**
   * OpenAlex nie zwraca abstraktu jako zwykłego stringa — z powodów licencyjnych
   * (umowy z wydawcami) udostępnia go jako "inverted index" (słowo -> pozycje).
   * Ta sama technika rekonstrukcji jest już używana w server.js (fetchAbstractByDoi,
   * gałąź OpenAlex) — świadomie zduplikowana tu, bo to inny proces/repo.
   */
  private reconstructAbstract(idx: Record<string, number[]> | null | undefined): string {
    if (!idx) return '';
    const words: string[] = [];
    for (const [word, positions] of Object.entries(idx)) {
      for (const pos of positions) words[pos] = word;
    }
    return words.filter(Boolean).join(' ').trim();
  }

  private parseWork(w: OpenAlexWork): Paper | null {
    try {
      const title = w.title || w.display_name || '';
      if (!title) return null;

      const doi = w.doi ? w.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//, '') : '';
      const authors = (w.authorships || [])
        .map(a => a.author?.display_name || a.raw_author_name || '')
        .filter(Boolean);

      const bestLoc = w.best_oa_location || w.primary_location || null;
      const isOa = w.open_access?.is_oa || bestLoc?.is_oa || false;
      const pdfUrl = (isOa && bestLoc?.pdf_url) || '';
      const url = bestLoc?.landing_page_url || (doi ? `https://doi.org/${doi}` : w.id);

      return PaperFactory.create({
        paperId: doi || w.id,
        title,
        authors,
        abstract: this.reconstructAbstract(w.abstract_inverted_index),
        doi,
        publishedDate: w.publication_date ? this.parseDate(w.publication_date) : null,
        year: w.publication_year || undefined,
        pdfUrl,
        url,
        source: 'openalex',
        journal: w.primary_location?.source?.display_name || undefined,
        citationCount: w.cited_by_count || 0,
        extra: {
          openalexId: w.id,
          isOpenAccess: isOa,
          type: w.type || null
        }
      });
    } catch (error: any) {
      logDebug('Error parsing OpenAlex work:', error?.message || error);
      return null;
    }
  }

  async downloadPdf(_paperId: string, _options: DownloadOptions = {}): Promise<string> {
    throw new Error(
      'OpenAlex nie hostuje PDF-ów bezpośrednio. Jeśli praca jest open access, użyj jej DOI z Unpaywall ' +
        '(download_paper, platform="unpaywall") żeby znaleźć legalną kopię.'
    );
  }

  async readPaper(paperId: string, _options: DownloadOptions = {}): Promise<string> {
    const papers = await this.search(paperId, { maxResults: 1 });
    if (!papers.length) throw new Error('Paper not found');
    return papers[0].abstract || 'Abstract not available';
  }
}
