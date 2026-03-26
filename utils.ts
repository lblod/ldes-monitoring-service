import { Parser, Quad } from 'n3';

export type Headers = {
  'X-API-KEY'?: string;
  Authorization?: string;
  Accept: string;
};

export type JsonLD = {
  '@context'?:
    | string
    | Record<string, any>
    | Array<string | Record<string, any>>;
  '@id'?: string;
  '@type'?: string | string[];
  [key: string]: any;
};

export type JSONLD = { kind: 'jsonLD'; value: JsonLD };

export type Config = {
  entrypoint: string;
  suffix: string;
  title?: string;
  cronTime: string;
  headers: Headers;
  applyFeedbackSnapshotFix?: boolean;
  rewriteRelationUrls?: boolean;
  rewriteInvalidLanguageTags?: boolean;
};

export type FetchError = {
  kind: 'fetchError';
  message: string;
  status: number | undefined;
};

export type ParseError = { kind: 'parseError'; message: string };

export type Quads = { kind: 'quads'; value: Quad[] };

export type EndpointStatus = {status: "up"|"error", statusCode?:number,errorType?: "parseError"|"fetchError", message?: string, nextPage?:number};

export const isFetchError = (
  r: FetchError | ParseError | Quads | JSONLD,
): r is FetchError => r.kind === 'fetchError';
export const isParseError = (
  r: FetchError | ParseError | Quads | JSONLD,
): r is ParseError => r.kind === 'parseError';
export const isQuads = (
  r: FetchError | ParseError | Quads | JSONLD,
): r is Quads => r.kind === 'quads';
export const isJSONLD = (
  r: FetchError | ParseError | Quads | JSONLD,
): r is JSONLD => r.kind === 'jsonLD';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function rewriteRelationUrls(payload: JsonLD) {
  if (payload.view?.relation) {
    const relations = payload.view.relation;
    for (let relation of relations) {
      const url = new URL(relation.node);
      const pageNumber = parseInt(url.searchParams.get('pageNumber') as string);
      relation.node = `./${isNaN(pageNumber) ? 1 : pageNumber + 1}`;
    }
  }
}

export function rewriteInvalidLanguageTags(ntriples: string) {
  // Feed contains invalid language tags containing '/' (e.g. @nl/je)
  // Will be replaced with '-' (e.g. @nl-je)
  ntriples = ntriples.replaceAll('@nl/je', '@nl-je');
  ntriples = ntriples.replaceAll('@nl/u', '@nl-u');
  ntriples = ntriples.replaceAll('nl-be-x-generated-informal', '');
  return ntriples;
}


export function applyFeedbackSnapshotFix(payload: JsonLD) {
  payload['timestampPath'] = 'https://www.w3.org/ns/prov#generatedAtTime';

  const members = payload.member;
  // Fix member structure
  if (members && Array.isArray(members)) {
    for (const member of members) {
      if (!member['feedback']) {
        continue;
      }
      if (member['@type'] !== 'FeedbackSnapshot') {
        continue;
      }
      const feedbackObject = member['feedback'];
      delete feedbackObject['@id'];
      delete feedbackObject['@type'];

      delete member['id'];
      delete member['feedback'];
      Object.assign(member, feedbackObject);
    }
  }

  // Add needed structure details to `@context`
  const contexts = payload['@context'];
  if (contexts && Array.isArray(contexts)) {
    contexts.push({
      '@context': {
        FeedbackSnapshot: {
          '@id': 'https://schema.org/Conversation',
          '@context': {
            isVersionOf: {
              '@id': 'https://purl.org/dc/terms/isVersionOf',
              '@type': '@id',
            },
            generatedAtTime: {
              '@id': 'https://www.w3.org/ns/prov#generatedAtTime',
              '@type': 'https://www.w3.org/2001/XMLSchema#dateTime',
            },
            instantieId: {
              '@id': 'https://schema.org/about',
              '@type': '@id',
              '@context': {
                '@base': 'https://ipdc.tni-vlaanderen.be/id/instantie/',
              },
            },
            conceptId: {
              '@id': 'https://schema.org/about',
              '@type': '@id',
              '@context': {
                '@base': 'https://ipdc.tni-vlaanderen.be/id/concept/',
              },
            },
            productnummer: {
              '@id': 'https://schema.org/productID',
              '@type': 'https://www.w3.org/2001/XMLSchema#string',
            },
            status: {
              '@id': 'https://www.w3.org/ns/adms#status',
              '@type': '@vocab',
              '@context': {
                '@vocab': 'https://ipdc.vlaanderen.be/ns/FeedbackStatus#',
              },
            },
            createdAt: {
              '@id': 'https://schema.org/dateCreated',
              '@type': 'https://www.w3.org/2001/XMLSchema#dateTime',
            },
            vraag: {
              '@id': 'https://schema.org/question',
            },
            antwoord: {
              '@id': 'https://schema.org/suggestedAnswer',
            },
          },
        },
      },
    });
  }
}

export async function fetchPage(
  pageUrl: string,
  currentPage: number,
  headers: Headers,
  shouldRewriteLanguageTags?:boolean
): Promise<FetchError | ParseError | Quads | JSONLD> {
  try {
    const response = await fetch(pageUrl+currentPage, {
      headers,
    });
    if (!response.ok) {
      return {
        status: response.status,
        message: response.statusText,
        kind: 'fetchError',
      } as FetchError;
    }
    let responseText = await response.text();
    if(shouldRewriteLanguageTags) {
        responseText = rewriteInvalidLanguageTags(responseText);
    }


    switch ((response.headers.get('Content-Type')||'').split(';')[0]) {
      case 'text/turtle':
        return await parseTurtle(responseText);
      case 'application/ld+json':
        return { value: JSON.parse(responseText) as JsonLD, kind: 'jsonLD' };
      default:
        return {
          kind: 'parseError',
          message:
            'unsupported content type' + response.headers.get('Content-Type'),
        } as ParseError;
    }
  } catch (e) {
    return { message: `${e}`, kind: 'fetchError' } as FetchError;
  }
}
export async function parseTurtle(responseText: string): Promise<Quads | ParseError> {
  const parser = new Parser({ format: 'text/turtle' });
  try {
    const quads = parser.parse(responseText);
    return { value: quads, kind: 'quads' } as Quads;
  } catch (e) {
    return { message: `${e}`, kind: 'parseError' } as ParseError;
  }
}