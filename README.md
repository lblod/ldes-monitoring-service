# LDES Endpoint Monitor

A microservice that periodically monitors LDES endpoints and save observations in a triplestore.

## Overview

This service crawls paginated LDES endpoints on a configurable schedule. 
For each endpoint, it checks all pages are up and parse-able and persists the results. 
The result of each monitoring run is stored as a `sosa:Observation`, optionally with an `oslc:Error`  if the endpoint is down.

- Supports Turtle and JSON-LD response formats
- Detects pagination via `tree:GreaterThanOrEqualToRelation`
- Prevents duplicate runs with an in memory job queue
- Metrics endpoint for prometheus

## Configuration

Mount a `config.json` file (default:  `/config.json`) with an array of endpoint configs:
```json
[
  {
    "entrypoint": "https://my-ldes-stream.be/ldes/ldes",
    "suffix": "?limit=25&pageNumber=",
    "title": "My vendor ldes",
    "cronTime": "0 * * * *",
    "headers": { 
        "Accept": "application/ld+json",
        "X-API-KEY": "mysecretkey",
    },
    "rewriteInvalidLanguageTags": true,
    "rewriteRelationUrls": false
  },
   {
    "cronTime": "0 0 * * * *",
    "entrypoint": "https://ldes-mirror.be",
    "suffix": "/",
    "title": "IPDC - Proxy(QA)",
    "headers": {
      "Authorization": "Basic ABCDEFGH",
      "Accept": "text/turtle"
    }
  } 
]
```

| Field | Description |
|---|---|
| `entrypoint` | base url of the LDES endpoint |
| `suffix` | extra suffix to appended to each request |
| `cronTime` | cron  |
| `headers` | http headers (e.g. `Accept`, `Authorization`, `X-API-KEY` ) |
| `rewriteInvalidLanguageTags` | fix malformed language tags before parsing |
| `rewriteRelationUrls` | rewrite relation urls in jsonld payloads |

## API

### `/metrics`

Exposes prometheus metrics for every endpoints.

**Metrics exposed:**

| Metric | Type | Description |
|---|---|---|
| `ldes_endpoint_status` | gauge | `1` if the endpoint is up, `0` if down |
| `ldes_observations_total` | counter | total runs |
| `ldes_last_observation` | gauge | timestamp of the last check |
| `ldes_pages_processed_total` | gauge | number of pages successfully processed |

Example scrape config:

```yaml
scrape_configs:
  - job_name: ldes-monitor
    static_configs:
      - targets: ['ldes-monitor:80']
```


## Environment Variables


-  `CONFIG_PATH`:  `/config.json` path to the config file |
-  `OBSERVATION_GRAPH`: `http://mu.semte.ch/graphs/observations` graph to store observations 

## Data Model

Each monitoring run produces a `sosa:Observation`:
```turtle
<http://data.lblod.info/observations/...>
    a sosa:Observation ;
    mu:uuid "..." ;
    sosa:resultTime "..." ;
    sosa:hasSimpleResult true/false ;
    sosa:hasFeatureOfInterest <entrypoint-uri> .
```

If the endpoint is down, an `oslc:Error` is also created and linked:
```turtle
<http://data.lblod.info/errors/...>
    a oslc:Error ;
    mu:uuid "..." ;
    dct:title "fetchError" / "parseError" ;
    oslc:statusCode 500 ;
    oslc:message "..." .

<observation> sosa:hasResult <error> .
```
