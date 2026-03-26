import { Registry, Counter, Gauge, } from 'prom-client';

export const register = new Registry();


export const endpointUpGauge = new Gauge({
  name: 'ldes_endpoint_status',
  help: 'whether the endpoint is up or down',
  labelNames: ['entrypoint'],
  registers: [register],
});

export const observationTotal = new Counter({
  name: 'ldes_observations_total',
  help: 'number of monitoring performed for a given endpoint',
  labelNames: ['entrypoint', 'status'],
  registers: [register],
});

export const lastObservationTimestamp = new Gauge({
  name: 'ldes_last_observation',
  help: 'timestamp of the last observation for a given endpoint',
  labelNames: ['entrypoint'],
  registers: [register],
});

export const pagesProcessed = new Gauge({
  name: 'ldes_pages_processed_total',
  help: 'number of pages successfully processed in the last run',
  labelNames: ['entrypoint'],
  registers: [register],
});