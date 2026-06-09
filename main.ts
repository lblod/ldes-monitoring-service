import { CronJob } from 'cron';
import jsonld from 'jsonld';
import { readFile } from 'node:fs/promises';
import {
  Config,
  isFetchError,
  parseTurtle,
  fetchPage,
  isJSONLD,
  isParseError,
  isQuads,
  rewriteRelationUrls,
  EndpointStatus,
  AccessToken,
  JwtAuthConfig,
  JsonLD,
} from './utils';
import {
  sparqlEscapeUri,
  sparqlEscapeDateTime,
  sparqlEscapeString,
  sparqlEscapeBool,
  sparqlEscapeInt,
  uuid,
} from 'mu';
import { v4 as uuidv4 } from 'uuid';
import {
  endpointUpGauge,
  observationTotal,
  lastObservationTimestamp,
  pagesProcessed,
} from './metrics';
import { updateSudo } from '@lblod/mu-auth-sudo';
import { importJWK, SignJWT } from 'jose';
import { Quad } from 'n3';
const CONFIG_PATH = process.env.CONFIG_PATH || '/config.json';
const OBSERVATION_GRAPH =
  process.env.OBSERVATION_GRAPH || 'http://mu.semte.ch/graphs/observations';
const TREE_RELATION = 'https://w3id.org/tree#relation';
const TREE_NODE = 'https://w3id.org/tree#node';
const TREE_GTE_RELATION = 'https://w3id.org/tree#GreaterThanOrEqualToRelation';
const TREE_RELATION_TYPE = 'https://w3id.org/tree#Relation';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
// NOTE: mainly used to avoid running the same job twice
// we could use the semantic job model, but this good enough for now

type EntrypointKeyCache = string;

let jobQueue: EntrypointKeyCache[] = [];

let jwtCache: Map<EntrypointKeyCache, AccessToken | undefined> = new Map();

export async function run() {
  console.log('loading config file...');
  const configFile = await readFile(CONFIG_PATH, { encoding: 'utf-8' });
  const configs: Config[] = JSON.parse(configFile);
  console.log('config file loaded.');

  for (const config of configs) {
    console.log(
      `creating cron job for config with entrypoint "${config.entrypoint} and cron expression ${config.cronTime}`,
    );
    const job = CronJob.from({
      cronTime: config.cronTime,
      onTick: async function () {
        await monitor(config);
      },
      start: true,
      timeZone: 'Europe/Brussels',
    });
    console.log('job created');
  }
}

async function monitor(config: Config) {
  let { entrypoint, suffix } = config;
  let endpointStatus: EndpointStatus | undefined = undefined;
  if (jobQueue.some((e) => e === entrypoint)) {
    console.log(`skipping ${entrypoint} as it's already running`);
    return;
  }
  console.log(
    `scheduled monitoring of ${entrypoint} started at ${new Date().toLocaleString('nl-BE')}`,
  );

  jobQueue.push(entrypoint);

  let accessToken = undefined;
  if (config.jwtAuthConfig) {
    console.log(`jwt for ${entrypoint} is enabled.`);
    accessToken =
      jwtCache.get(entrypoint) || (await getAccessToken(config.jwtAuthConfig));
    if (Date.now() / 1000 > accessToken!.expires_in * 0.95) {
      accessToken = await getAccessToken(config.jwtAuthConfig);
    }
    if (accessToken) {
      config.headers.Authorization = `${accessToken.token_type} ${accessToken.access_token}`;
      console.log(config.headers.Authorization);
    }
    jwtCache.set(entrypoint, accessToken);
  }

  let currentPage: string | undefined = entrypoint + suffix;
  let previousPage: string | undefined = undefined;
  let nbPagesProcessed = 0;
  do {
    console.log('processing page', currentPage, 'with endpoint', entrypoint);
    endpointStatus = await processPage(config, currentPage, previousPage);
    if (endpointStatus.status !== 'up') {
      console.log(
        'error at page',
        endpointStatus.nextPage,
        ':',
        endpointStatus,
      );
      break;
    } else {
      nbPagesProcessed += 1;
      if (!endpointStatus.nextPage) {
        break;
      }
      previousPage = currentPage;
      currentPage = endpointStatus.nextPage;
    }
  } while (currentPage);

  if (endpointStatus) {
    pagesProcessed.set({ entrypoint }, nbPagesProcessed);
    await buildResult(endpointStatus, entrypoint);
  }
  jobQueue = jobQueue.filter((e) => e !== entrypoint);
}

async function processPage(
  config: Config,
  currentPage: string,
  previousPage: undefined | string,
): Promise<EndpointStatus> {
  let {
    entrypoint,
    suffix,
    headers,
    rewriteInvalidLanguageTags,
    rewriteRelationUrls: shouldRewriteRelationUrls,
  } = config;
  const result = await fetchPage(
    currentPage,
    headers,
    rewriteInvalidLanguageTags,
  );
  let quads = undefined;
  if (isFetchError(result)) {
    return {
      message: result.message,
      errorType: 'fetchError',
      status: 'error',
      statusCode: result.status,
      nextPage: currentPage,
    };
  } else if (isParseError(result)) {
    return {
      message: result.message,
      errorType: 'parseError',
      status: 'error',
      nextPage: currentPage,
    };
  } else if (isQuads(result)) {
    quads = result.value;
  } else if (isJSONLD(result)) {
    let ld = result.value;
    if (shouldRewriteRelationUrls) {
      rewriteRelationUrls(ld);
    }
    const rdf = await jsonld.toRDF(ld, {
      format: 'application/n-quads',
    } as jsonld.Options.ToRdf);
    if (typeof rdf !== 'string') {
      return {
        message: `could not parse jsonld to rdf. Parser library doesn't return string`,
        errorType: 'parseError',
        status: 'error',
        nextPage: currentPage,
      };
    }
    let turtleResult = await parseTurtle(rdf);
    if (isParseError(turtleResult)) {
      return {
        message: turtleResult.message,
        errorType: 'parseError',
        status: 'error',
        nextPage: currentPage,
      };
    } else {
      quads = turtleResult.value;
    }
  }
  let nextPage = undefined;
  if (quads) {
    nextPage = extractNextPage(quads, entrypoint + suffix);
    if (nextPage === previousPage) {
      return {
        message: `possible cycle detected. nextPage (${nextPage}) is equal to previous page (${previousPage})`,
        errorType: 'parseError',
        status: 'error',
        nextPage: currentPage,
      };
    }
  }
  return { status: 'up', nextPage };
}

function extractNextPage(quads: Quad[], baseUrl: string) {
  if (!quads?.length) return undefined;
  const relationSubjects = new Set();

  for (const quad of quads) {
    const isRelationPredicate = quad.predicate.value === TREE_RELATION;
    if (isRelationPredicate) {
      relationSubjects.add(quad.object.value);
    }
  }
  for (const quad of quads) {
    if (
      quad.predicate.value === RDF_TYPE &&
      (quad.object.value === TREE_GTE_RELATION ||
        quad.object.value === TREE_RELATION_TYPE)
    ) {
      relationSubjects.add(quad.subject.value);
    }
  }

  if (relationSubjects.size === 0) return undefined;

  for (const quad of quads) {
    if (
      quad.predicate.value === TREE_NODE &&
      relationSubjects.has(quad.subject.value)
    ) {
      const nodeValue = quad.object.value;

      try {
        return new URL(nodeValue, baseUrl).href;
      } catch {
        return nodeValue;
      }
    }
  }

  return undefined;
}

async function buildResult(es: EndpointStatus, entrypointUri: string) {
  let muId = uuid();
  let now = new Date();
  let observationUri = `http://data.lblod.info/observations/${muId}`;
  let isSimpleResult = es.status === 'up';
  endpointUpGauge.set({ entrypoint: entrypointUri }, isSimpleResult ? 1 : 0);
  observationTotal.inc({ entrypoint: entrypointUri, status: es.status });
  lastObservationTimestamp.set(
    { entrypoint: entrypointUri },
    Date.now() / 1000,
  );
  const triples = [
    `<${observationUri}> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/ns/sosa/Observation>`,
    `<${observationUri}> <http://mu.semte.ch/vocabularies/core/uuid> ${sparqlEscapeString(muId)}`,
    `<${observationUri}> <http://www.w3.org/ns/sosa/resultTime> ${sparqlEscapeDateTime(now)}`,
    `<${observationUri}> <http://www.w3.org/ns/sosa/hasSimpleResult> ${sparqlEscapeBool(isSimpleResult)}`,
    `<${observationUri}> <http://www.w3.org/ns/sosa/hasFeatureOfInterest> ${sparqlEscapeUri(entrypointUri)}`,
  ];
  if (!isSimpleResult) {
    let errorId = uuid();
    let errorUri = `http://data.lblod.info/errors/${errorId}`;
    let statusCode = es.statusCode || 500;

    triples.push(
      `<${errorUri}> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://open-services.net/ns/core#Error>`,
      `<${errorUri}> <http://mu.semte.ch/vocabularies/core/uuid> ${sparqlEscapeString(errorId)}`,
      `<${errorUri}> <http://purl.org/dc/terms/title> ${sparqlEscapeString(es.errorType!)}`,
      `<${errorUri}> <http://open-services.net/ns/core#statusCode> ${sparqlEscapeInt(statusCode)}`,
      `<${errorUri}> <http://open-services.net/ns/core#message> ${sparqlEscapeString(es.message!)}`,
      `<${observationUri}> <http://www.w3.org/ns/sosa/hasResult> <${errorUri}>`,
    );
  }

  let query = `INSERT DATA { GRAPH ${sparqlEscapeUri(OBSERVATION_GRAPH)} { ${triples.join('.')} }}`;
  await updateSudo(query, {}, {});
}

async function getAccessToken({
  clientId,
  key,
  keyAlgorithm,
  tokenUrl,
  tokenAudience,
  tokenExpiry,
  tokenScope,
  clientAssertionType,
}: JwtAuthConfig): Promise<AccessToken> {
  console.info('Refreshing access token');
  let tokenReq: Response;
  try {
    const secret = await importJWK(key);
    const jwt = await new SignJWT({
      iss: clientId,
      sub: clientId,
      aud: tokenAudience,
      jti: uuidv4(),
    })
      .setProtectedHeader({ alg: keyAlgorithm, typ: 'JWT' })
      .setIssuedAt()
      .setExpirationTime(tokenExpiry)
      .sign(secret);

    console.log('token url', tokenUrl);
    tokenReq = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_assertion: jwt,
        client_assertion_type: clientAssertionType,
        scope: tokenScope,
      }),
    });
  } catch (err) {
    console.log(`Error while attempting to refresh access token: ${err}`);
    throw err;
  }
  if (!tokenReq.ok) {
    console.log(
      `Unexpected response refreshing access token: ${tokenReq.statusText}`,
    );
    throw new Error(
      `Unexpected response refreshing access token: ${tokenReq.statusText}`,
    );
  }
  return tokenReq.json();
}
