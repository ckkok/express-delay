import express from 'express';
import http from 'http';
import fs from 'fs';
import path from 'path';
import cors from 'cors';
import url from 'url';
import expressProxy from 'express-http-proxy';
import rateLimit from 'express-rate-limit';
import globalAgent from 'global-agent';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const config = JSON.parse(fs.readFileSync("config.json", "utf-8"));

if (config.useProxy) {
    globalAgent.bootstrap();
    globalThis.GLOBAL_AGENT.HTTP_PROXY = process.env.HTTP_PROXY;    
}

const SERVER_SHUTDOWN_TIMEOUT = 5000;
const SERVER_PORT = process.env.PORT ? parseInt(process.env.PORT) : (config.serverPort ? config.serverPort : 3000);
const SERVER_HOST = process.env.HOST ? process.env.HOST : (config.serverHost ? config.serverHost : '0.0.0.0');
const INIT_MSG = `Mock server listening at ${SERVER_HOST}:${SERVER_PORT}` + (config.useProxy ? `\n\nUsing proxy: ${globalThis.GLOBAL_AGENT.HTTP_PROXY}` : '');

globalThis.SERVER_STATE = {
    stateId: 0,
    delayFactor: 1,
    simulateFail: 0
}

function logServerState() {
    console.clear();
    console.log(INIT_MSG);
    console.log('\nServer state');
    console.table(globalThis.SERVER_STATE);
    logMetrics();
}

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

const app = express();
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
    const pathname = url.parse(req.url).pathname;
    if (__REQ_BUCKETS[pathname]) {
        ++__REQ_BUCKETS[pathname][method].buckets[__REQ_BUCKET_INDEX];
        ++__REQ_BUCKETS[pathname][method].count;
    }
    next();
}

app.use(rpsReportHandler);

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

const jsonResponseFactory = jsonResponseFile => {
    const response = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'responses', jsonResponseFile)));
    return (req, res) => res.json(response);
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
                if (isCorsEnabled) {
                    app.get(endpoint.path, corsHandler);
                }
                if (rate) {
                    app.get(endpoint.path, rateLimit({windowMs: 1000, max: rate}));
                }
                if (delay || (typeof delay === 'number' && delay > 0) ) {
                    app.get(endpoint.path, delayHandlerFactory(delay));
                }
                app.get(endpoint.path, jsonMiddleware);
                app.get(endpoint.path, urlEncodedMiddleware);
                app.get(endpoint.path, rawMiddleware);
                app.get(endpoint.path, responseParamsSetterFactory(status, headers, cookies));
                app.get(endpoint.path, failSimulationHandler);
                app.get(endpoint.path, handler.get);
            }
            if (handler.post) {
                registerMetrics(endpoint.path, 'POST');
                if (isCorsEnabled) {
                    app.post(endpoint.path, corsHandler);
                }
                if (rate) {
                    app.post(endpoint.path, rateLimit({windowMs: 1000, max: rate}));
                }
                if (delay || (typeof delay === 'number' && delay > 0) ) {
                    app.post(endpoint.path, delayHandlerFactory(delay));
                }
                app.post(endpoint.path, jsonMiddleware);
                app.post(endpoint.path, urlEncodedMiddleware);
                app.post(endpoint.path, rawMiddleware);
                app.post(endpoint.path, responseParamsSetterFactory(status, headers, cookies));
                app.post(endpoint.path, failSimulationHandler);
                app.post(endpoint.path, handler.post);
            }
            if (handler.put) {
                registerMetrics(endpoint.path, 'PUT');
                if (isCorsEnabled) {
                    app.put(endpoint.path, corsHandler);
                }
                if (rate) {
                    app.put(endpoint.path, rateLimit({windowMs: 1000, max: rate}));
                }
                if (delay || (typeof delay === 'number' && delay > 0) ) {
                    app.put(endpoint.path, delayHandlerFactory(delay));
                }
                app.put(endpoint.path, jsonMiddleware);
                app.put(endpoint.path, urlEncodedMiddleware);
                app.put(endpoint.path, rawMiddleware);
                app.put(endpoint.path, responseParamsSetterFactory(status, headers, cookies));
                app.put(endpoint.path, failSimulationHandler);
                app.put(endpoint.path, handler.put);
            }
            if (handler.patch) {
                registerMetrics(endpoint.path, 'PATCH');
                if (isCorsEnabled) {
                    app.patch(endpoint.path, corsHandler);
                }
                if (rate) {
                    app.patch(endpoint.path, rateLimit({windowMs: 1000, max: rate}));
                }
                if (delay || (typeof delay === 'number' && delay > 0) ) {
                    app.patch(endpoint.path, delayHandlerFactory(delay));
                }
                app.patch(endpoint.path, jsonMiddleware);
                app.patch(endpoint.path, urlEncodedMiddleware);
                app.patch(endpoint.path, rawMiddleware);
                app.patch(endpoint.path, responseParamsSetterFactory(status, headers, cookies));
                app.patch(endpoint.path, failSimulationHandler);
                app.patch(endpoint.path, handler.patch);
            }
            if (handler.delete) {
                registerMetrics(endpoint.path, 'DELETE');
                if (isCorsEnabled) {
                    app.delete(endpoint.path, corsHandler);
                }
                if (rate) {
                    app.delete(endpoint.path, rateLimit({windowMs: 1000, max: rate}));
                }
                if (delay || (typeof delay === 'number' && delay > 0) ) {
                    app.delete(endpoint.path, delayHandlerFactory(delay));
                }
                app.delete(endpoint.path, jsonMiddleware);
                app.delete(endpoint.path, urlEncodedMiddleware);
                app.delete(endpoint.path, rawMiddleware);
                app.delete(endpoint.path, responseParamsSetterFactory(status, headers, cookies));
                app.delete(endpoint.path, failSimulationHandler);
                app.delete(endpoint.path, handler.delete);
            }
        } else {
            if (method === 'get') {
                registerMetrics(endpoint.path, 'GET');
                if (isCorsEnabled) {
                    app.get(endpoint.path, corsHandler);
                }
                if (rate) {
                    app.get(endpoint.path, rateLimit({windowMs: 1000, max: rate}));
                }
                if (delay || (typeof delay === 'number' && delay > 0) ) {
                    app.get(endpoint.path, delayHandlerFactory(delay));
                }
                if (!proxy) {
                    app.get(endpoint.path, jsonMiddleware);
                    app.get(endpoint.path, urlEncodedMiddleware);
                    app.get(endpoint.path, rawMiddleware);
                }
                app.get(endpoint.path, responseParamsSetterFactory(status, headers, cookies));
                app.get(endpoint.path, failSimulationHandler);
                if (proxy) {
                    app.get(endpoint.path, expressProxy(proxy));
                } else if (responseFile === null) {
                    app.get(endpoint.path, nullHandler);
                } else if (responseFile.endsWith('.json')) {
                    app.get(endpoint.path, jsonResponseFactory(responseFile));
                } else if (responseFile.endsWith('.txt') || responseFile.endsWith('.html')) {
                    app.get(endpoint.path, textResponseFactory(responseFile));
                }
            } else if (method === 'post') {
                registerMetrics(endpoint.path, 'POST');
                if (isCorsEnabled) {
                    app.post(endpoint.path, corsHandler);
                }
                if (rate) {
                    app.post(endpoint.path, rateLimit({windowMs: 1000, max: rate}));
                }
                if (delay || (typeof delay === 'number' && delay > 0) ) {
                    app.post(endpoint.path, delayHandlerFactory(delay));
                }
                if (!proxy) {
                    app.post(endpoint.path, jsonMiddleware);
                    app.post(endpoint.path, urlEncodedMiddleware);
                    app.post(endpoint.path, rawMiddleware);
                }
                app.post(endpoint.path, responseParamsSetterFactory(status, headers, cookies));
                app.post(endpoint.path, failSimulationHandler);
                if (proxy) {
                    app.post(endpoint.path, expressProxy(proxy));
                } else if (responseFile === null) {
                    app.post(endpoint.path, nullHandler);
                } else if (responseFile.endsWith('.json')) {
                    app.post(endpoint.path, jsonResponseFactory(responseFile));
                } else if (responseFile.endsWith('.txt') || responseFile.endsWith('.html')) {
                    app.post(endpoint.path, textResponseFactory(responseFile));
                }
            } else if (method === 'put') {
                registerMetrics(endpoint.path, 'PUT');
                if (isCorsEnabled) {
                    app.put(endpoint.path, corsHandler);
                }
                if (rate) {
                    app.put(endpoint.path, rateLimit({windowMs: 1000, max: rate}));
                }
                if (delay || (typeof delay === 'number' && delay > 0) ) {
                    app.put(endpoint.path, delayHandlerFactory(delay));
                }
                if (!proxy) {
                    app.put(endpoint.path, jsonMiddleware);
                    app.put(endpoint.path, urlEncodedMiddleware);
                    app.put(endpoint.path, rawMiddleware);
                }
                app.put(endpoint.path, responseParamsSetterFactory(status, headers, cookies));
                app.put(endpoint.path, failSimulationHandler);
                if (proxy) {
                    app.put(endpoint.path, expressProxy(proxy));
                } else if (responseFile === null) {
                    app.put(endpoint.path, nullHandler);
                } else if (responseFile.endsWith('.json')) {
                    app.put(endpoint.path, jsonResponseFactory(responseFile));
                } else if (responseFile.endsWith('.txt') || responseFile.endsWith('.html')) {
                    app.put(endpoint.path, textResponseFactory(responseFile));
                }
            } else if (method === 'patch') {
                registerMetrics(endpoint.path, 'PATCH');
                if (isCorsEnabled) {
                    app.patch(endpoint.path, corsHandler);
                }
                if (rate) {
                    app.patch(endpoint.path, rateLimit({windowMs: 1000, max: rate}));
                }
                if (delay || (typeof delay === 'number' && delay > 0) ) {
                    app.patch(endpoint.path, delayHandlerFactory(delay));
                }
                if (!proxy) {
                    app.patch(endpoint.path, jsonMiddleware);
                    app.patch(endpoint.path, urlEncodedMiddleware);
                    app.patch(endpoint.path, rawMiddleware);
                }
                app.patch(endpoint.path, responseParamsSetterFactory(status, headers, cookies));
                app.patch(endpoint.path, failSimulationHandler);
                if (proxy) {
                    app.patch(endpoint.path, expressProxy(proxy));
                } else if (responseFile === null) {
                    app.patch(endpoint.path, nullHandler);
                } else if (responseFile.endsWith('.json')) {
                    app.patch(endpoint.path, jsonResponseFactory(responseFile));
                } else if (responseFile.endsWith('.txt') || responseFile.endsWith('.html')) {
                    app.patch(endpoint.path, textResponseFactory(responseFile));
                }
            } else if (method === 'delete') {
                registerMetrics(endpoint.path, 'DELETE');
                if (isCorsEnabled) {
                    app.delete(endpoint.path, corsHandler);
                }
                if (rate) {
                    app.delete(endpoint.path, rateLimit({windowMs: 1000, max: rate}));
                }
                if (delay || (typeof delay === 'number' && delay > 0) ) {
                    app.delete(endpoint.path, delayHandlerFactory(delay));
                }
                if (!proxy) {
                    app.delete(endpoint.path, jsonMiddleware);
                    app.delete(endpoint.path, urlEncodedMiddleware);
                    app.delete(endpoint.path, rawMiddleware);
                }
                app.delete(endpoint.path, responseParamsSetterFactory(status, headers, cookies));
                app.delete(endpoint.path, failSimulationHandler);
                if (proxy) {
                    app.delete(endpoint.path, expressProxy(proxy));
                } else if (responseFile === null) {
                    app.delete(endpoint.path, nullHandler);
                } else if (responseFile.endsWith('.json')) {
                    app.delete(endpoint.path, jsonResponseFactory(responseFile));
                } else if (responseFile.endsWith('.txt') || responseFile.endsWith('.html')) {
                    app.delete(endpoint.path, textResponseFactory(responseFile));
                }
            }
        }
    }
}

async function main() {
    await registerEndpoints();
    server.listen(SERVER_PORT, SERVER_HOST, logServerState);
    setInterval(logServerState, 1000);
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
