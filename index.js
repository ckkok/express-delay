import http from 'http';
import fs from 'fs';
import path from 'path';
import cors from 'cors';
import express, { text } from 'express';
import expressProxy from 'express-http-proxy';
import rateLimit from 'express-rate-limit';
import globalAgent from 'global-agent';
import { DateTime } from 'luxon';
import { v4 as uuidv4 } from 'uuid';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const config = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf-8"));

if (config.useProxy) {
    globalAgent.bootstrap();
    globalThis.GLOBAL_AGENT.HTTP_PROXY = process.env.HTTP_PROXY;    
}

const SERVER_SHUTDOWN_TIMEOUT = 5000;
const SERVER_PORT = process.env.PORT ? parseInt(process.env.PORT) : (config.serverPort ? config.serverPort : 3000);
const SERVER_HOST = process.env.HOST ? process.env.HOST : (config.serverHost ? config.serverHost : '0.0.0.0');
const CONSOLE_OUTPUT_ENABLED = config.consoleOutput;
const INIT_MSG = `Mock server listening at ${SERVER_HOST}:${SERVER_PORT}` + (config.useProxy ? `\n\nUsing proxy: ${globalThis.GLOBAL_AGENT.HTTP_PROXY}` : '');

function logServerState() {
    console.clear();
    console.log(INIT_MSG);
    console.log('\nServer state');
    if (globalThis.SERVER_STATE) {
        console.table(globalThis.SERVER_STATE);
    };
    logMetrics();
}

globalThis.SERVER_STATE = {
    stateId: 0,
    delayFactor: 1,
    simulateFail: 0
}

if (config.consoleAccess) {
    const keyResponses = {
        "\u0003": shutdown,
        "\u001B\u005B\u0041": () => {
            globalThis.SERVER_STATE.delayFactor = parseFloat((globalThis.SERVER_STATE.delayFactor + 0.1).toFixed(2));
            logServerState();
        },
        "\u001B\u005B\u0042": () => {
            globalThis.SERVER_STATE.delayFactor = parseFloat((globalThis.SERVER_STATE.delayFactor - 0.1).toFixed(2));
            if (globalThis.SERVER_STATE.delayFactor < 0) {
                globalThis.SERVER_STATE.delayFactor = 0;
            }
            logServerState();
        },
        "\u001B\u005B\u0043": () => {
            globalThis.SERVER_STATE.simulateFail = parseFloat((globalThis.SERVER_STATE.simulateFail + 0.1).toFixed(2));
            if (globalThis.SERVER_STATE.simulateFail > 1) {
                globalThis.SERVER_STATE.simulateFail = 1;
            }
            logServerState();
        },
        "\u001B\u005B\u0044": () => {
            globalThis.SERVER_STATE.simulateFail = parseFloat((globalThis.SERVER_STATE.simulateFail - 0.1).toFixed(2));
            if (globalThis.SERVER_STATE.simulateFail < 0) {
                globalThis.SERVER_STATE.simulateFail = 0;
            }
            logServerState();
        },
        "\u001B\u005B\u0035\u007e": () => {
            ++globalThis.SERVER_STATE.stateId;
            logServerState();
        },
        "\u001B\u005B\u0036\u007e": () => {
            --globalThis.SERVER_STATE.stateId;
            if (globalThis.SERVER_STATE.stateId < 0) {
                globalThis.SERVER_STATE.stateId = 0;
            }
            logServerState();
        },
    }
    
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.on('data', key => {
        if (keyResponses.hasOwnProperty(key)) {
            keyResponses[key]();
        }
    });
}

const app = express();
const router = express.Router();

app.enable('trust proxy');

const jsonMiddleware = express.json();
const urlEncodedMiddleware = express.urlencoded({ extended: true });
const rawMiddleware = express.raw();

const corsHandler = cors();

const __REQ_BUCKET_INTERVAL_MS = 100;
const __REQ_BUCKETS = {};
const __REQ_BUCKET_INDEX_MAX = 1000 / __REQ_BUCKET_INTERVAL_MS;
let __REQ_BUCKET_INDEX = 0;
const __REQ_BUCKET_INTERVAL = setInterval(() => {
    ++__REQ_BUCKET_INDEX;
    if (__REQ_BUCKET_INDEX >= __REQ_BUCKET_INDEX_MAX) {
        __REQ_BUCKET_INDEX = 0;
    }
    for (let data of Object.values(__REQ_BUCKETS)) {
        for (let metrics of Object.values(data)) {
            metrics.count -= metrics.buckets[__REQ_BUCKET_INDEX];
            metrics.buckets[__REQ_BUCKET_INDEX] = 0;
        }
    }  
}, __REQ_BUCKET_INTERVAL_MS);

function logMetrics() {
    const output = [];
    for (let [pathname, data] of Object.entries(__REQ_BUCKETS)) {
        for (let [method, metrics] of Object.entries(data)) {
            output.push({method, path: pathname, rps: metrics.count })
        }
    }
    console.table(output);
}

const registerMetrics = (endpoint, method) => {
    const _method = method.toUpperCase();
    if (!__REQ_BUCKETS[endpoint]) {
        __REQ_BUCKETS[endpoint] = {
            [_method]: {
                buckets: new Array(__REQ_BUCKET_INDEX_MAX).fill(0),
                count: 0
            }
        }
    } else if (!__REQ_BUCKETS[endpoint][_method]) {
        __REQ_BUCKETS[endpoint][_method] = {
            buckets: new Array(__REQ_BUCKET_INDEX_MAX).fill(0),
            count: 0
        }
    }
}

const rpsReportHandler = (req, res, next) => {
    const method = req.method;
    const pathname = req.route.path;
    if (__REQ_BUCKETS[pathname]) {
        ++__REQ_BUCKETS[pathname][method].buckets[__REQ_BUCKET_INDEX];
        ++__REQ_BUCKETS[pathname][method].count;
    }
    next();
}
if (config.dashboardPath) {
    app.use(config.dashboardPath, express.static('dashboard'));
    app.get(config.dashboardPath + '/data', (req, res) => res.json(config));
    app.get(config.dashboardPath + '/logs', (req, res) => res.json([]));
    app.post(config.dashboardPath + '/data', (req, res) => res.end());
    app.post(config.dashboardPath + '/restart', (req, res) => res.end());
}
app.use(express.text());
app.use(express.json());
app.use(express.urlencoded());
app.get(config.isAliveEndpoint, (req, res) => res.end());

const server = http.createServer(app);

const delayHandlerFactory = delay => {
    if (typeof delay === 'object' && delay.hasOwnProperty('min') && delay.hasOwnProperty('max')) {
        return (req, res, next) => {
            setTimeout(next, (delay.min + (Math.random() * (delay.max - delay.min))) * globalThis.SERVER_STATE.delayFactor);
        }
    } else if (typeof delay === 'number') {
        return (req, res, next) => {
            setTimeout(next, delay * globalThis.SERVER_STATE.delayFactor);
        }
    }
    throw new Error('Invalid delay specified. Expected either a number or { min: number, max: number}. Received: ' + delay);
}

const textReplacer = text => {
    let result = text;
    result = result.replaceAll('${currentUtcDateTime}', DateTime.utc().toISO().toString());
    result = result.replaceAll('${uuidRandom}', uuidv4())
    return result;
}

const jsonResponseFactory = jsonResponseFile => {
    return (req, res) => {
        const rawData = fs.readFileSync(path.resolve(__dirname, 'responses', jsonResponseFile), 'utf-8');
        const textReplacedData = textReplacer(rawData);
        const response = JSON.parse(textReplacedData);
        res.json(response);
    }
}

const textResponseFactory = textResponseFile => {
    const response = fs.readFileSync(path.resolve(__dirname, 'responses', textResponseFile));
    const isHtml = textResponseFile.endsWith('.html');
    return isHtml ? (req, res) => {
        res.append('Content-Type', 'text/html');
        res.send(response);
    } : (req, res) => {
        res.append('Content-Type', 'text/plain');
        res.send(response);
    }
}

const responseParamsSetterFactory = (status, headers, cookies) => {
    return (req, res, next) => {
        res.status(status);
        if (headers && typeof headers === 'object') {
            for (const header of Object.keys(headers)) {
                res.append(header, headers[header]);
            }
        }
        if (cookies && typeof cookies === 'object') {
            for (const cookie of Object.keys(cookies)) {
                res.cookie(cookie, cookies[cookie]);
            }
        }
        next();
    }
}

const failSimulationHandler = (req, res, next) => {
    if (globalThis.SERVER_STATE.simulateFail <= 0) {
        return next();
    } else if (globalThis.SERVER_STATE.simulateFail >= 1 || Math.random() <= globalThis.SERVER_STATE.simulateFail) {
        return res.status(503).end();
    } else {
        return next();
    }
}

const nullHandler = (req, res) => res.end();

const handlerResponseFactory = handlerModule => {
    return import(pathToFileURL(path.resolve(__dirname, 'handlers', handlerModule)));
}

const registerEndpoints = async () => {
    for (const endpoint of config.endpoints) {
        if (!endpoint.path) {
            console.warn('No path detected:', endpoint);
            continue;
        }
        const method = endpoint.method ? endpoint.method.toLowerCase() : 'get';
        const responseFile = endpoint.hasOwnProperty('response') ? endpoint.response : null;
        const delay = endpoint.delay !== undefined ? endpoint.delay : 0;
        const rate = endpoint.rate;
        const headers = endpoint.headers;
        const cookies = endpoint.cookies;
        const proxy = endpoint.proxy;
        const isCorsEnabled = endpoint.cors;
        const status = endpoint.status !== undefined ? endpoint.status : 200;
        if (responseFile && responseFile.endsWith('.js')) {
            const handler = await handlerResponseFactory(responseFile);
            if (handler.get) {
                registerMetrics(endpoint.path, 'GET');
                router.get(endpoint.path, rpsReportHandler);
                if (isCorsEnabled) {
                    router.get(endpoint.path, corsHandler);
                }
                if (rate) {
                    router.get(endpoint.path, rateLimit({windowMs: 1000, max: rate}));
                }
                if (delay || (typeof delay === 'number' && delay > 0) ) {
                    router.get(endpoint.path, delayHandlerFactory(delay));
                }
                router.get(endpoint.path, jsonMiddleware);
                router.get(endpoint.path, urlEncodedMiddleware);
                router.get(endpoint.path, rawMiddleware);
                router.get(endpoint.path, responseParamsSetterFactory(status, headers, cookies));
                router.get(endpoint.path, failSimulationHandler);
                router.get(endpoint.path, handler.get);
            }
            if (handler.post) {
                registerMetrics(endpoint.path, 'POST');
                router.post(endpoint.path, rpsReportHandler);
                if (isCorsEnabled) {
                    router.post(endpoint.path, corsHandler);
                }
                if (rate) {
                    router.post(endpoint.path, rateLimit({windowMs: 1000, max: rate}));
                }
                if (delay || (typeof delay === 'number' && delay > 0) ) {
                    router.post(endpoint.path, delayHandlerFactory(delay));
                }
                router.post(endpoint.path, jsonMiddleware);
                router.post(endpoint.path, urlEncodedMiddleware);
                router.post(endpoint.path, rawMiddleware);
                router.post(endpoint.path, responseParamsSetterFactory(status, headers, cookies));
                router.post(endpoint.path, failSimulationHandler);
                router.post(endpoint.path, handler.post);
            }
            if (handler.put) {
                registerMetrics(endpoint.path, 'PUT');
                router.put(endpoint.path, rpsReportHandler);
                if (isCorsEnabled) {
                    router.put(endpoint.path, corsHandler);
                }
                if (rate) {
                    router.put(endpoint.path, rateLimit({windowMs: 1000, max: rate}));
                }
                if (delay || (typeof delay === 'number' && delay > 0) ) {
                    router.put(endpoint.path, delayHandlerFactory(delay));
                }
                router.put(endpoint.path, jsonMiddleware);
                router.put(endpoint.path, urlEncodedMiddleware);
                router.put(endpoint.path, rawMiddleware);
                router.put(endpoint.path, responseParamsSetterFactory(status, headers, cookies));
                router.put(endpoint.path, failSimulationHandler);
                router.put(endpoint.path, handler.put);
            }
            if (handler.patch) {
                registerMetrics(endpoint.path, 'PATCH');
                router.patch(endpoint.path, rpsReportHandler);
                if (isCorsEnabled) {
                    router.patch(endpoint.path, corsHandler);
                }
                if (rate) {
                    router.patch(endpoint.path, rateLimit({windowMs: 1000, max: rate}));
                }
                if (delay || (typeof delay === 'number' && delay > 0) ) {
                    router.patch(endpoint.path, delayHandlerFactory(delay));
                }
                router.patch(endpoint.path, jsonMiddleware);
                router.patch(endpoint.path, urlEncodedMiddleware);
                router.patch(endpoint.path, rawMiddleware);
                router.patch(endpoint.path, responseParamsSetterFactory(status, headers, cookies));
                router.patch(endpoint.path, failSimulationHandler);
                router.patch(endpoint.path, handler.patch);
            }
            if (handler.delete) {
                registerMetrics(endpoint.path, 'DELETE');
                router.delete(endpoint.path, rpsReportHandler);
                if (isCorsEnabled) {
                    router.delete(endpoint.path, corsHandler);
                }
                if (rate) {
                    router.delete(endpoint.path, rateLimit({windowMs: 1000, max: rate}));
                }
                if (delay || (typeof delay === 'number' && delay > 0) ) {
                    router.delete(endpoint.path, delayHandlerFactory(delay));
                }
                router.delete(endpoint.path, jsonMiddleware);
                router.delete(endpoint.path, urlEncodedMiddleware);
                router.delete(endpoint.path, rawMiddleware);
                router.delete(endpoint.path, responseParamsSetterFactory(status, headers, cookies));
                router.delete(endpoint.path, failSimulationHandler);
                router.delete(endpoint.path, handler.delete);
            }
        } else {
            if (method === 'get') {
                registerMetrics(endpoint.path, 'GET');
                router.get(endpoint.path, rpsReportHandler);
                if (isCorsEnabled) {
                    router.get(endpoint.path, corsHandler);
                }
                if (rate) {
                    router.get(endpoint.path, rateLimit({windowMs: 1000, max: rate}));
                }
                if (delay || (typeof delay === 'number' && delay > 0) ) {
                    router.get(endpoint.path, delayHandlerFactory(delay));
                }
                if (!proxy) {
                    router.get(endpoint.path, jsonMiddleware);
                    router.get(endpoint.path, urlEncodedMiddleware);
                    router.get(endpoint.path, rawMiddleware);
                }
                router.get(endpoint.path, responseParamsSetterFactory(status, headers, cookies));
                router.get(endpoint.path, failSimulationHandler);
                if (proxy) {
                    router.get(endpoint.path, expressProxy(proxy));
                } else if (responseFile === null) {
                    router.get(endpoint.path, nullHandler);
                } else if (responseFile.endsWith('.json')) {
                    router.get(endpoint.path, jsonResponseFactory(responseFile));
                } else if (responseFile.endsWith('.txt') || responseFile.endsWith('.html')) {
                    router.get(endpoint.path, textResponseFactory(responseFile));
                }
            } else if (method === 'post') {
                registerMetrics(endpoint.path, 'POST');
                router.post(endpoint.path, rpsReportHandler);
                if (isCorsEnabled) {
                    router.post(endpoint.path, corsHandler);
                }
                if (rate) {
                    router.post(endpoint.path, rateLimit({windowMs: 1000, max: rate}));
                }
                if (delay || (typeof delay === 'number' && delay > 0) ) {
                    router.post(endpoint.path, delayHandlerFactory(delay));
                }
                if (!proxy) {
                    router.post(endpoint.path, jsonMiddleware);
                    router.post(endpoint.path, urlEncodedMiddleware);
                    router.post(endpoint.path, rawMiddleware);
                }
                router.post(endpoint.path, responseParamsSetterFactory(status, headers, cookies));
                router.post(endpoint.path, failSimulationHandler);
                if (proxy) {
                    router.post(endpoint.path, expressProxy(proxy));
                } else if (responseFile === null) {
                    router.post(endpoint.path, nullHandler);
                } else if (responseFile.endsWith('.json')) {
                    router.post(endpoint.path, jsonResponseFactory(responseFile));
                } else if (responseFile.endsWith('.txt') || responseFile.endsWith('.html')) {
                    router.post(endpoint.path, textResponseFactory(responseFile));
                }
            } else if (method === 'put') {
                registerMetrics(endpoint.path, 'PUT');
                router.put(endpoint.path, rpsReportHandler);
                if (isCorsEnabled) {
                    router.put(endpoint.path, corsHandler);
                }
                if (rate) {
                    router.put(endpoint.path, rateLimit({windowMs: 1000, max: rate}));
                }
                if (delay || (typeof delay === 'number' && delay > 0) ) {
                    router.put(endpoint.path, delayHandlerFactory(delay));
                }
                if (!proxy) {
                    router.put(endpoint.path, jsonMiddleware);
                    router.put(endpoint.path, urlEncodedMiddleware);
                    router.put(endpoint.path, rawMiddleware);
                }
                router.put(endpoint.path, responseParamsSetterFactory(status, headers, cookies));
                router.put(endpoint.path, failSimulationHandler);
                if (proxy) {
                    router.put(endpoint.path, expressProxy(proxy));
                } else if (responseFile === null) {
                    router.put(endpoint.path, nullHandler);
                } else if (responseFile.endsWith('.json')) {
                    router.put(endpoint.path, jsonResponseFactory(responseFile));
                } else if (responseFile.endsWith('.txt') || responseFile.endsWith('.html')) {
                    router.put(endpoint.path, textResponseFactory(responseFile));
                }
            } else if (method === 'patch') {
                registerMetrics(endpoint.path, 'PATCH');
                router.patch(endpoint.path, rpsReportHandler);
                if (isCorsEnabled) {
                    router.patch(endpoint.path, corsHandler);
                }
                if (rate) {
                    router.patch(endpoint.path, rateLimit({windowMs: 1000, max: rate}));
                }
                if (delay || (typeof delay === 'number' && delay > 0) ) {
                    router.patch(endpoint.path, delayHandlerFactory(delay));
                }
                if (!proxy) {
                    router.patch(endpoint.path, jsonMiddleware);
                    router.patch(endpoint.path, urlEncodedMiddleware);
                    router.patch(endpoint.path, rawMiddleware);
                }
                router.patch(endpoint.path, responseParamsSetterFactory(status, headers, cookies));
                router.patch(endpoint.path, failSimulationHandler);
                if (proxy) {
                    router.patch(endpoint.path, expressProxy(proxy));
                } else if (responseFile === null) {
                    router.patch(endpoint.path, nullHandler);
                } else if (responseFile.endsWith('.json')) {
                    router.patch(endpoint.path, jsonResponseFactory(responseFile));
                } else if (responseFile.endsWith('.txt') || responseFile.endsWith('.html')) {
                    router.patch(endpoint.path, textResponseFactory(responseFile));
                }
            } else if (method === 'delete') {
                registerMetrics(endpoint.path, 'DELETE');
                router.delete(endpoint.path, rpsReportHandler);
                if (isCorsEnabled) {
                    router.delete(endpoint.path, corsHandler);
                }
                if (rate) {
                    router.delete(endpoint.path, rateLimit({windowMs: 1000, max: rate}));
                }
                if (delay || (typeof delay === 'number' && delay > 0) ) {
                    router.delete(endpoint.path, delayHandlerFactory(delay));
                }
                if (!proxy) {
                    router.delete(endpoint.path, jsonMiddleware);
                    router.delete(endpoint.path, urlEncodedMiddleware);
                    router.delete(endpoint.path, rawMiddleware);
                }
                router.delete(endpoint.path, responseParamsSetterFactory(status, headers, cookies));
                router.delete(endpoint.path, failSimulationHandler);
                if (proxy) {
                    router.delete(endpoint.path, expressProxy(proxy));
                } else if (responseFile === null) {
                    router.delete(endpoint.path, nullHandler);
                } else if (responseFile.endsWith('.json')) {
                    router.delete(endpoint.path, jsonResponseFactory(responseFile));
                } else if (responseFile.endsWith('.txt') || responseFile.endsWith('.html')) {
                    router.delete(endpoint.path, textResponseFactory(responseFile));
                }
            }
        }
    }
    app.use(router);
}

async function main() {
    await registerEndpoints();
    server.listen(SERVER_PORT, SERVER_HOST, logServerState);
    if (CONSOLE_OUTPUT_ENABLED) {
        setInterval(logServerState, 1000);
    }
}

function shutdown() {
    console.log('===================');
    console.log('Closing down server');
    let __serverForceShutdownTimeout = setTimeout(() => {
        console.log('Unable to close connections in time. Force shutting down.');
        process.exit(1);
    }, SERVER_SHUTDOWN_TIMEOUT);
    server.close(() => {
        console.log('Server shutdown successfully');
        clearTimeout(__serverForceShutdownTimeout);
        process.exit(0);
    });
}

main();
