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
} from './utils';
import {
  sparqlEscapeUri,
  sparqlEscapeDateTime,
  sparqlEscapeString,
  sparqlEscapeBool,
  sparqlEscapeInt,
  uuid,
} from 'mu';
import {
  endpointUpGauge,
  observationTotal,
  lastObservationTimestamp,
  pagesProcessed,
} from './metrics';
import { updateSudo } from '@lblod/mu-auth-sudo';
const CONFIG_PATH = process.env.CONFIG_PATH || '/config.json';
const OBSERVATION_GRAPH =
  process.env.OBSERVATION_GRAPH || 'http://mu.semte.ch/graphs/observations';

// NOTE: mainly used to avoid running the same job twice
// we could use the semantic job model, but this good enough for now
let jobQueue: string[] = [];

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
  let { entrypoint } = config;
  let endpointStatus: EndpointStatus | undefined = undefined;
  if (jobQueue.some((e) => e === entrypoint)) {
    console.log(`skipping ${entrypoint} as it's already running`);
    return;
  }
  console.log(
    `scheduled monitoring of ${entrypoint} started at ${new Date().toLocaleString('nl-BE')}`,
  );

  jobQueue.push(entrypoint);

  let currentPageNumber: number | undefined = 1;
  while (currentPageNumber) {
    console.log(
      'processing page',
      currentPageNumber,
      'with endpoint',
      entrypoint,
    );
    endpointStatus = await processPage(config, currentPageNumber);
    if (endpointStatus.status !== 'up') {
      console.log(
        'error at page',
        endpointStatus.nextPage,
        ':',
        endpointStatus,
      );
      break;
    } else {
      if (!endpointStatus.nextPage) {
        break;
      }
      currentPageNumber = endpointStatus.nextPage;
    }
  }

  if (endpointStatus) {
    pagesProcessed.set(
      { entrypoint },
      !currentPageNumber || currentPageNumber === 1 ? 0 : currentPageNumber,
    );
    await buildResult(endpointStatus, entrypoint);
  }
  jobQueue = jobQueue.filter((e) => e !== entrypoint);
}

async function processPage(
  config: Config,
  currentPage: number,
): Promise<EndpointStatus> {
  let {
    entrypoint,
    suffix,
    headers,
    rewriteInvalidLanguageTags,
    rewriteRelationUrls: shouldRewriteRelationUrls,
  } = config;
  const result = await fetchPage(
    entrypoint + suffix,
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
    for (const { object } of quads) {
      if (
        object.value === 'https://w3id.org/tree#GreaterThanOrEqualToRelation'
      ) {
        nextPage = currentPage + 1;
        break;
      }
    }
  }
  return { status: 'up', nextPage };
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
