/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';

import {
  type BigQueryCredentials,
  isBigQueryAuthClient,
} from './bigquery_credentials.js';
import type {BigQueryTableReference} from './client.js';
import {
  type BigQueryToolConfig,
  type BigQueryToolConfigOptions,
  DEFAULT_MAX_QUERY_RESULT_ROWS,
} from './config.js';
import {
  type BigQueryToolErrorResult,
  toBigQueryToolErrorResult,
} from './tool_error.js';

const GDA_CLIENT_ID = 'GOOGLE_ADK';
const GDA_DEFAULT_ENDPOINT = 'https://geminidataanalytics.googleapis.com';
const GDA_MTLS_ENDPOINT = 'https://geminidataanalytics.mtls.googleapis.com';
const GOOGLEAPIS_SUFFIX = '.googleapis.com';
const MTLS_GOOGLEAPIS_SUFFIX = '.mtls.googleapis.com';
const MULTI_REGION_SUFFIXES = [
  '.us.rep.googleapis.com',
  '.eu.rep.googleapis.com',
];
const PROJECT_ID_PATTERN = /^[a-zA-Z0-9._:-]+$/;

const ASK_DATA_INSIGHTS_INSTRUCTIONS = `**INSTRUCTIONS - FOLLOW THESE RULES:**
    1.  **CONTENT:** Your answer should present the supporting data and then provide a conclusion based on that data, including relevant details and observations where possible.
    2.  **ANALYSIS DEPTH:** Your analysis must go beyond surface-level observations. Crucially, you must prioritize metrics that measure impact or outcomes over metrics that simply measure volume or raw counts. For open-ended questions, explore the topic from multiple perspectives to provide a holistic view.
    3.  **OUTPUT FORMAT:** Your entire response MUST be in plain text format ONLY.
    4.  **NO CHARTS:** You are STRICTLY FORBIDDEN from generating any charts, graphs, images, or any other form of visualization.
    `;

/**
 * Model-facing description for the `ask_data_insights` tool.
 */
export const ASK_DATA_INSIGHTS_DESCRIPTION =
  'Answers questions about structured data in BigQuery tables using natural language. ' +
  "Sends the user's question (enriched with relevant conversation history) and " +
  'BigQuery table references to the Gemini Data Analytics conversational API, ' +
  "returning {status: 'SUCCESS', response} with a sequential log of generated " +
  "SQL, retrieved data, and the final plain-text answer, or {status: 'ERROR', error_details} on failure.";

/**
 * Zod parameter schema for {@link askDataInsights}.
 */
export const askDataInsightsParameters = z.object({
  project_id: z
    .string()
    .describe('The Google Cloud project id in which the inquiry is performed.'),
  user_query_with_context: z
    .string()
    .describe(
      "The user's question enriched with relevant context from conversation history.",
    ),
  table_references: z
    .array(
      z.object({
        projectId: z.string().optional(),
        datasetId: z.string(),
        tableId: z.string(),
      }),
    )
    .describe(
      'Array of BigQuery table references ({projectId, datasetId, tableId}) used as context for the question.',
    ),
});

/**
 * Arguments accepted by {@link askDataInsights}.
 */
export interface AskDataInsightsArgs {
  /**
   * Google Cloud project ID in which the inquiry is performed. Falls back to
   * `GOOGLE_CLOUD_PROJECT` when omitted or empty.
   */
  project_id?: string;

  /**
   * The user's request enriched with relevant context from conversation history.
   */
  user_query_with_context: string;

  /**
   * BigQuery table references used as context for the question.
   */
  table_references: Array<BigQueryTableReference | Record<string, string>>;

  /**
   * Credentials injected by {@link BigQueryTool}.
   */
  credentials?: BigQueryCredentials;

  /**
   * Tool configuration specifying settings such as `maxQueryResultRows`.
   */
  config?: BigQueryToolConfig | BigQueryToolConfigOptions;
}

/**
 * Successful result returned by {@link askDataInsights}.
 */
export interface AskDataInsightsSuccessResult {
  status: 'SUCCESS';
  response: Array<Record<string, unknown>>;
}

/**
 * Result returned by {@link askDataInsights}.
 */
export type AskDataInsightsResult =
  AskDataInsightsSuccessResult | BigQueryToolErrorResult;

function isMultiRegionHost(hostname: string): boolean {
  return MULTI_REGION_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
}

function shouldUseMtlsEndpoint(): boolean {
  const mtlsSetting = (
    process.env['GOOGLE_API_USE_MTLS_ENDPOINT'] ?? 'auto'
  ).toLowerCase();
  if (mtlsSetting === 'always') {
    return true;
  }
  if (mtlsSetting === 'never') {
    return false;
  }
  return (
    (
      process.env['GOOGLE_API_USE_CLIENT_CERTIFICATE'] ?? 'false'
    ).toLowerCase() === 'true'
  );
}

function toEffectiveGoogleapisEndpoint(endpointUrl: string): string {
  const mtlsSetting = (
    process.env['GOOGLE_API_USE_MTLS_ENDPOINT'] ?? 'auto'
  ).toLowerCase();
  if (mtlsSetting === 'never') {
    return endpointUrl;
  }
  let parsed: URL;
  try {
    parsed = new URL(endpointUrl);
  } catch {
    return endpointUrl;
  }
  const host = parsed.hostname;
  if (
    !host.endsWith(GOOGLEAPIS_SUFFIX) ||
    host.includes(MTLS_GOOGLEAPIS_SUFFIX) ||
    isMultiRegionHost(host)
  ) {
    return endpointUrl;
  }
  if (!shouldUseMtlsEndpoint()) {
    return endpointUrl;
  }
  parsed.hostname =
    host.slice(0, -GOOGLEAPIS_SUFFIX.length) + MTLS_GOOGLEAPIS_SUFFIX;
  return parsed.toString().replace(/\/$/, '');
}

/**
 * Resolves the Gemini Data Analytics API base endpoint for the given location
 * or custom endpoint override.
 */
export function getGdaEndpoint(options?: {
  location?: string;
  apiEndpoint?: string;
}): string {
  const apiEndpoint = options?.apiEndpoint?.trim();
  if (apiEndpoint) {
    const withScheme = apiEndpoint.includes('://')
      ? apiEndpoint
      : `https://${apiEndpoint}`;
    return toEffectiveGoogleapisEndpoint(withScheme.replace(/\/$/, ''));
  }

  const loc = (options?.location ?? '').trim().toLowerCase();
  if (!loc || loc === 'global') {
    return shouldUseMtlsEndpoint() ? GDA_MTLS_ENDPOINT : GDA_DEFAULT_ENDPOINT;
  }
  if (loc === 'eu' || loc === 'us') {
    return `https://geminidataanalytics.${loc}.rep.googleapis.com`;
  }
  if (!PROJECT_ID_PATTERN.test(loc)) {
    throw new Error(`Invalid GDA location '${loc}'.`);
  }
  return shouldUseMtlsEndpoint()
    ? `https://geminidataanalytics-${loc}.mtls.googleapis.com`
    : `https://geminidataanalytics-${loc}.googleapis.com`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Extracts `systemMessage.data.result` when it contains a `data` array.
 */
export function extractDataResult(
  msg: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const systemMessage = msg['systemMessage'];
  if (!isPlainRecord(systemMessage)) {
    return undefined;
  }
  const data = systemMessage['data'];
  if (!isPlainRecord(data)) {
    return undefined;
  }
  const result = data['result'];
  if (!isPlainRecord(result)) {
    return undefined;
  }
  if (Array.isArray(result['data'])) {
    return result;
  }
  return undefined;
}

/**
 * Formats a raw GDA data result object into the structured `'Data Retrieved'`
 * table summary, capped at `maxRows` rows.
 */
export function formatDataRetrieved(
  result: Record<string, unknown>,
  maxRows: number,
): Record<string, unknown> {
  const rawData = Array.isArray(result['data']) ? result['data'] : [];
  const schema = result['schema'];
  const fields =
    isPlainRecord(schema) && Array.isArray(schema['fields'])
      ? schema['fields']
      : [];

  const headers: string[] = [];
  for (const field of fields) {
    if (isPlainRecord(field) && typeof field['name'] === 'string') {
      headers.push(field['name']);
    }
  }

  if (headers.length === 0 && rawData.length > 0) {
    const firstRow = rawData[0];
    if (isPlainRecord(firstRow)) {
      headers.push(...Object.keys(firstRow));
    }
  }

  const totalRows = rawData.length;
  const numToDisplay = Math.min(totalRows, maxRows);
  const rows: unknown[][] = [];

  for (const row of rawData.slice(0, numToDisplay)) {
    if (isPlainRecord(row)) {
      rows.push(headers.map((header) => row[header]));
    }
  }

  const summary =
    totalRows > maxRows
      ? `Showing the first ${numToDisplay} of ${totalRows} total rows.`
      : `Showing all ${totalRows} rows.`;

  return {
    'Data Retrieved': {
      headers,
      rows,
      summary,
    },
  };
}

async function readResponseLines(response: Response): Promise<string[]> {
  if (!response.body) {
    const text = await response.text();
    return text.split(/\r?\n/);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  const lines: string[] = [];
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, {stream: true});
      const parts = buffer.split(/\r?\n/);
      buffer = parts.pop() ?? '';
      lines.push(...parts);
    }
    buffer += decoder.decode();
    if (buffer.length > 0) {
      lines.push(...buffer.split(/\r?\n/));
    }
  } finally {
    reader.releaseLock();
  }
  return lines;
}

/**
 * Sends a streaming request to the Gemini Data Analytics `:chat` endpoint and
 * returns the parsed sequence of messages.
 */
export async function getStream(options: {
  url: string;
  caPayload: Record<string, unknown>;
  headers: Record<string, string>;
  maxQueryResultRows: number;
}): Promise<Array<Record<string, unknown>>> {
  const response = await fetch(options.url, {
    method: 'POST',
    headers: options.headers,
    body: JSON.stringify(options.caPayload),
  });
  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(
      errorBody
        ? `GDA request failed with status ${response.status}: ${errorBody}`
        : `GDA request failed with status ${response.status}.`,
    );
  }

  const lines = await readResponseLines(response);
  let accumulator = '';
  const messages: Array<Record<string, unknown>> = [];
  let dataMsgIdx = -1;

  for (const rawLine of lines) {
    const decodedLine = rawLine.trim();
    if (!decodedLine) {
      continue;
    }

    if (decodedLine === '[{') {
      accumulator = '{';
    } else if (decodedLine === '}]') {
      accumulator += '}';
    } else if (decodedLine === ',') {
      continue;
    } else {
      accumulator += decodedLine;
    }

    let dataJson: unknown;
    try {
      dataJson = JSON.parse(accumulator);
    } catch {
      continue;
    }

    accumulator = '';

    if (!isPlainRecord(dataJson)) {
      messages.push(dataJson as Record<string, unknown>);
      continue;
    }

    let processedMsg: Record<string, unknown> | undefined;
    const dataResult = extractDataResult(dataJson);
    if (dataResult !== undefined) {
      processedMsg = formatDataRetrieved(
        dataResult,
        options.maxQueryResultRows,
      );
      if (dataMsgIdx >= 0) {
        messages[dataMsgIdx] = {
          'Data Retrieved': 'Intermediate result omitted',
        };
      }
      dataMsgIdx = messages.length;
    } else if (isPlainRecord(dataJson['systemMessage'])) {
      processedMsg = dataJson['systemMessage'];
    } else {
      processedMsg = dataJson;
    }

    if (processedMsg !== undefined) {
      messages.push(processedMsg);
    }
  }

  return messages;
}

function readAuthHeader(
  headers: Headers | Record<string, string>,
): string | undefined {
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    return headers.get('authorization') ?? undefined;
  }
  const record = headers as Record<string, string>;
  return record['Authorization'] ?? record['authorization'];
}

async function resolveAuthorizationHeader(
  credentials: BigQueryCredentials | undefined,
  url: string,
): Promise<string | undefined> {
  if (!credentials) {
    return undefined;
  }
  if (isBigQueryAuthClient(credentials)) {
    const requestHeaders = await credentials.getRequestHeaders(url);
    const authHeader = readAuthHeader(requestHeaders);
    if (typeof authHeader === 'string' && authHeader.trim().length > 0) {
      return authHeader;
    }
    if (typeof credentials.getAccessToken === 'function') {
      const tokenResult = await credentials.getAccessToken();
      const token =
        typeof tokenResult === 'string' ? tokenResult : tokenResult?.token;
      if (typeof token === 'string' && token.length > 0) {
        return `Bearer ${token}`;
      }
    }
    return undefined;
  }
  if (typeof credentials.token === 'string' && credentials.token.length > 0) {
    return `Bearer ${credentials.token}`;
  }
  return undefined;
}

/**
 * Answers natural-language questions about structured data in BigQuery tables
 * using the Gemini Data Analytics conversational API.
 */
export async function askDataInsights(
  args: AskDataInsightsArgs,
): Promise<AskDataInsightsResult> {
  try {
    const projectId = (
      args.project_id ||
      process.env['GOOGLE_CLOUD_PROJECT'] ||
      ''
    ).trim();
    if (!projectId || !PROJECT_ID_PATTERN.test(projectId)) {
      return {
        status: 'ERROR',
        error_details: 'A valid project_id is required for ask_data_insights.',
      };
    }

    const location = 'global';
    const endpoint = getGdaEndpoint({location});
    const caUrl = `${endpoint}/v1/projects/${projectId}/locations/${location}:chat`;

    const authorization = await resolveAuthorizationHeader(
      args.credentials,
      caUrl,
    );
    if (!authorization) {
      return {
        status: 'ERROR',
        error_details: 'ask_data_insights requires a valid access token.',
      };
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Goog-API-Client': GDA_CLIENT_ID,
      Authorization: authorization,
    };

    const caPayload: Record<string, unknown> = {
      messages: [{userMessage: {text: args.user_query_with_context}}],
      inlineContext: {
        datasourceReferences: {
          bq: {tableReferences: args.table_references},
        },
        systemInstruction: ASK_DATA_INSIGHTS_INSTRUCTIONS,
      },
      clientIdEnum: GDA_CLIENT_ID,
    };

    const maxQueryResultRows =
      args.config?.maxQueryResultRows ?? DEFAULT_MAX_QUERY_RESULT_ROWS;
    const response = await getStream({
      url: caUrl,
      caPayload,
      headers,
      maxQueryResultRows,
    });
    return {status: 'SUCCESS', response};
  } catch (error: unknown) {
    return toBigQueryToolErrorResult(error);
  }
}
